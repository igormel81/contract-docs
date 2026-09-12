import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { readLegalCorpus, legalCatalog, withLegalContext, legalStatus, validateLegalResult, enrichLegalSources } from '../server/legal.mjs';
import { schema, reviewSchema, qualificationSchema, validateResult, validateQualifications, parseReview } from '../server/schema.mjs';
import { rules } from '../server/rules.mjs';

const now = new Date('2026-09-05T12:00:00Z');
const snapshot = () => withLegalContext({ rules, documents: [{ id: 'doc', blocks: [{ id: 'clause', text: '3.1. Работы выполняются до 1 декабря 2026 года.' }] }] }, now);
const source = () => ({ fileId: 'doc', blockId: 'clause', quote: 'Работы выполняются до 1 декабря 2026 года.' });
const result = () => ({ summary: 'Тест', qualifications: [{ type: 'works', sources: [source()], confidence: 'high', note: 'В документе прямо названы работы.', legalModules: ['civil-works'] }], passport: ['subject','result','term','price','payment','location','acceptance','dependencies','special'].map(key => ({ key, title: key, value: 'Нет данных', status: 'missing', sources: [] })), findings: [],
  coverage: snapshot().rules.filter(r => r.coverage !== false).map(r => ({ rule: r.id, status: 'needs_data', note: 'Требуются данные' })), limitations: [], changes: [] });
const finding = () => ({ id: 'law', rule: 'LAW-01', title: 'Проверить определимость начала работ', severity: 'medium',
  description: 'Требуется правовая проверка применимости и редакции нормы.', sources: [source()], legalType: 'facts_or_documents_required',
  legalSources: [{ normId: 'RU-GK2-708-1', quote: 'В договоре подряда указываются начальный и конечный сроки выполнения работы.' }], proposal: '', review: 'primary' });

test('release-pinned corpus is reference-only with six identified paragraphs and honest provenance', () => {
  const legal = legalCatalog(now);
  assert.equal(legal.status, 'reference_only'); assert.equal(legal.currentAsOf, null);
  assert.equal(legal.norms.length, 6);
  for (const norm of legal.norms) {
    assert.match(norm.id, /^RU-GK2-\d+-\d$/); assert.equal(norm.textSha256.length, 64);
    assert.equal(norm.provenance.currentEditionVerified, false);
    assert.equal(norm.effectiveFrom, null); assert.equal(norm.verificationStatus, 'reference_only');
    assert.match(norm.sourceUrl, /^https:\/\/government\.ru\//);
  }
  assert.equal(readLegalCorpus(undefined, 'wrong-hash').status, 'unavailable');
  assert.equal(readLegalCorpus('/not/a/corpus').status, 'unavailable');
});

test('snapshot pins the corpus and does not replace it on retry or claim legal completeness', () => {
  const captured = snapshot();
  assert.equal(captured.rules.find(r => r.id === 'LAW-01').coverage, true);
  assert.equal(rules.find(r => r.id === 'LAW-01').coverage, false);
  assert.equal(withLegalContext(captured, new Date('2027-01-01')), captured);
  const afterReviewDue = new Date(`${captured.legal.reviewDueAt}T00:00:00Z`); afterReviewDue.setUTCDate(afterReviewDue.getUTCDate() + 1);
  assert.equal(legalStatus(captured.legal, afterReviewDue), 'stale');
  const output = result(); output.findings = [finding()];
  assert.doesNotThrow(() => validateLegalResult(output, captured, now));
  assert.ok(output.limitations.some(s => s.includes('шестью пунктами')));
  output.coverage.find(c => c.rule === 'LAW-01').status = 'checked';
  assert.throws(() => validateLegalResult(output, captured, now), /нужны данные/);
});

test('legal references must match exact immutable paragraph and contract citations remain separate', () => {
  const captured = snapshot(), output = result(); output.findings = [finding()];
  const enriched = enrichLegalSources(output, captured).findings[0];
  assert.equal(enriched.legalSources[0].article, '708');
  assert.equal(enriched.legalSources[0].paragraph, '1');
  assert.equal(enriched.legalSources[0].sourceUrl, captured.legal.norms[0].sourceUrl);
  assert.deepEqual(enriched.sources, output.findings[0].sources);
  output.findings[0].legalSources[0].quote = 'Подрядчик всегда обязан работать бесплатно.';
  assert.throws(() => validateLegalResult(output, captured, now), /цитата/);
  assert.deepEqual(enrichLegalSources(output, captured).findings[0].legalSources, []);
  output.findings = [finding()]; output.findings[0].legalSources[0].normId = 'RU-GK2-9999-1';
  assert.throws(() => validateLegalResult(output, captured, now), /цитата/);
});

test('unknown edition, expired corpus, missing legal source and mutated text fail closed', () => {
  const captured = snapshot(), output = result(); output.findings = [finding()];
  output.findings[0].severity = 'high';
  assert.throws(() => validateLegalResult(output, captured, now), /критичность/);
  output.findings[0].severity = 'medium';
  assert.throws(() => validateLegalResult(output, captured, new Date('2026-11-01')), /просрочены/);
  output.findings[0].legalSources = [];
  assert.throws(() => validateLegalResult(output, captured, now), /нужна/);
  output.findings = [finding()]; captured.legal.norms.find(n => n.article === '708').text += ' Подмена.';
  assert.throws(() => validateLegalResult(output, captured, now), /цитата/);
});

test('stale or unavailable normative evidence is rejected for PAY-01 as well as LAW-01', () => {
  const captured = snapshot(), output = result();
  const norm = captured.legal.norms.find(n => n.id === 'RU-GK2-709-2');
  output.findings = [{ ...finding(), rule: 'PAY-01', legalSources: [{ normId: norm.id, quote: norm.text }] }];
  assert.doesNotThrow(() => validateLegalResult(output, captured, now));
  assert.throws(() => validateLegalResult(output, captured, new Date('2026-11-01')), /просрочены/);
  captured.legal.status = 'unavailable';
  assert.throws(() => validateLegalResult(output, captured, now), /недоступны/);
  output.findings[0].legalSources = [];
  assert.doesNotThrow(() => validateLegalResult(output, captured, now), 'Operational risk analysis remains available without normative claims');
});

test('verified status requires issuer verification and real effective dates for every norm', () => {
  const legal = snapshot().legal;
  legal.status = 'verified'; legal.currentAsOf = '2026-09-05';
  for (const norm of legal.norms) { norm.verificationStatus = 'verified'; norm.effectiveFrom = '2026-01-01'; }
  assert.equal(legalStatus(legal, now), 'reference_only', 'A status label alone cannot confirm the edition');
  legal.provenance.currentEditionVerified = true;
  for (const norm of legal.norms) norm.provenance.currentEditionVerified = true;
  assert.equal(legalStatus(legal, now), 'verified');
  legal.norms[0].effectiveFrom = null;
  assert.equal(legalStatus(legal, now), 'reference_only');
  legal.norms[0].effectiveFrom = '2026-10-01';
  assert.equal(legalStatus(legal, now), 'reference_only');
  legal.norms[0].effectiveFrom = '2026-02-30';
  assert.equal(legalStatus(legal, now), 'reference_only');
  legal.norms[0].effectiveFrom = '2026-01-01'; legal.norms[0].effectiveTo = '2026-09-04';
  assert.equal(legalStatus(legal, now), 'reference_only');
});

test('legal-v2 schemas require qualifications and legal types from new model responses', () => {
  const qualificationTypes = ['works','services','software_creation','exclusive_right_assignment','license','mixed','equipment_supply','procurement_44fz','procurement_223fz'];
  const legalTypes = ['mandatory_violation','invalidity_or_unenforceability','dispositive_unfavorable','missing_required_term','facts_or_documents_required','not_applicable'];
  assert.deepEqual(schema.properties.qualifications.items.properties.type.enum, qualificationTypes);
  assert.deepEqual(schema.properties.findings.items.properties.legalType.enum, legalTypes);
  assert.ok(schema.required.includes('qualifications'));
  assert.deepEqual(schema.properties.qualifications.items.required.sort(), ['confidence','legalModules','note','sources','type']);
  assert.ok(schema.properties.findings.items.required.includes('legalType'));
  assert.ok(reviewSchema.required.includes('qualifications'));
  assert.ok(reviewSchema.properties.verdicts.items.required.includes('legalType'));

  const validatePrimary = new Ajv({ allErrors: true }).compile(schema);
  const primary = result(); primary.findings = [finding()];
  assert.equal(validatePrimary(primary), true);
  delete primary.qualifications;
  delete primary.findings[0].legalType;
  assert.equal(validatePrimary(primary), false, 'legacy omissions are not accepted as a new model response');
});

test('qualification stage has a strict schema and validates grounded snapshot modules', () => {
  const output = { qualifications: result().qualifications };
  assert.deepEqual(qualificationSchema.required, ['qualifications']);
  assert.equal(validateQualifications(output, snapshot()), output);
  assert.throws(() => validateQualifications({}, snapshot()), /структуре квалификации/);
  output.qualifications[0].legalModules = ['invented-module'];
  assert.throws(() => validateQualifications(output, snapshot()), /неизвестный нормативный модуль/);
  const modular = snapshot(); modular.legal.modules = [{ id: 'services-only', title: 'Только услуги', qualificationTypes: ['services'], enabledByDefault: true }]; modular.legal.activeModuleIds = ['services-only'];
  output.qualifications[0].legalModules = ['services-only'];
  assert.throws(() => validateQualifications(output, modular), /не применим/);
  const inactive = snapshot(); inactive.legal.activeModuleIds = [];
  output.qualifications[0].legalModules = ['civil-works'];
  assert.throws(() => validateQualifications(output, inactive), /неактивный/);
});

test('historical legal snapshots without module metadata expose only the legacy core module', () => {
  const captured = snapshot(); delete captured.legal.modules; delete captured.legal.activeModuleIds;
  for (const norm of captured.legal.norms) delete norm.moduleId;
  const output = { qualifications: result().qualifications }; output.qualifications[0].legalModules = ['core'];
  assert.equal(validateQualifications(output, captured), output);
});

test('legal-v2 runtime rejects omissions that only historical snapshots may normalize', () => {
  const modernSnapshot = { rules, documents: snapshot().documents, analysisContractVersion: 'legal-v2' };
  const malformed = result(); malformed.coverage = malformed.coverage.filter(c => c.rule !== 'LAW-01');
  delete malformed.qualifications;
  const item = { ...finding(), rule: 'TIME-01' }; delete item.legalType; malformed.findings = [item];
  assert.throws(() => validateResult(malformed, modernSnapshot, 'primary'), /структуре результата/);
});

test('legacy results normalize legal-v2 omissions while keeping the output schemas strict', () => {
  const oldSnapshot = { rules, documents: snapshot().documents };
  const oldResult = result(); oldResult.coverage = oldResult.coverage.filter(c => c.rule !== 'LAW-01');
  const item = { ...finding(), rule: 'TIME-01' };
  delete oldResult.qualifications; delete item.legalSources; delete item.legalType; oldResult.findings = [item];
  assert.doesNotThrow(() => validateResult(oldResult, oldSnapshot, 'primary'));
  assert.deepEqual(oldResult.qualifications, []);
  assert.deepEqual(oldResult.findings[0].legalSources, []);
  assert.equal(oldResult.findings[0].legalType, 'facts_or_documents_required');
  assert.ok(schema.properties.findings.items.required.includes('legalSources'));
  assert.ok(reviewSchema.properties.verdicts.items.required.includes('legalSources'));
});

test('a legal conclusion is rejected without an obligation qualification, unlike a commercial risk', () => {
  const oldSnapshot = { rules, documents: snapshot().documents };
  const output = result(); output.qualifications = []; output.coverage = output.coverage.filter(c => c.rule !== 'LAW-01');
  output.findings = [{ ...finding(), rule: 'LOC-01', legalSources: [], legalType: 'mandatory_violation' }];
  assert.throws(() => validateResult(output, oldSnapshot, 'primary'), /квалификац/);
  output.findings[0].legalType = 'not_applicable';
  assert.doesNotThrow(() => validateResult(output, oldSnapshot, 'primary'), 'a commercial location risk is not represented as a violation');
});

test('a qualification is grounded in the contract', () => {
  const validatePrimary = new Ajv({ allErrors: true }).compile(schema);
  const ungrounded = result(); ungrounded.qualifications[0].sources = [];
  assert.equal(validatePrimary(ungrounded), false, 'a model cannot emit an ungrounded obligation qualification');
});

test('a qualification names an applicable legal module before a legal conclusion', () => {
  const oldSnapshot = { rules, documents: snapshot().documents };
  const output = result(); output.coverage = output.coverage.filter(c => c.rule !== 'LAW-01');
  output.qualifications[0].legalModules = [];
  output.findings = [{ ...finding(), rule: 'LOC-01', legalSources: [], legalType: 'mandatory_violation' }];
  assert.throws(() => validateResult(output, oldSnapshot, 'primary'), /модул/);
});

test('a declared legal module must exist in the pinned snapshot', () => {
  const output = result(); output.qualifications[0].legalModules = ['totally-invented-module'];
  assert.throws(() => validateResult(output, snapshot(), 'primary'), /неизвестный нормативный модуль/);
});

test('normative references come from a module selected by a qualification', () => {
  const captured = snapshot(); captured.analysisContractVersion = 'legal-v2';
  captured.legal.modules.push({ id: 'other-works', title: 'Другой модуль', qualificationTypes: ['works'], enabledByDefault: true });
  captured.legal.activeModuleIds.push('other-works');
  const output = result(); output.qualifications[0].legalModules = ['other-works']; output.findings = [finding()];
  assert.throws(() => validateResult(output, captured, 'primary'), /не выбран квалификацией/);
});

test('review confirmation inherits legal references; correction explicitly replaces or removes them', () => {
  const primary = result(); primary.findings = [finding()];
  const delta = { summary: primary.summary, qualifications: primary.qualifications, passport: primary.passport, coverage: primary.coverage, limitations: [], changes: [], added: [],
    verdicts: [{ id: 'law', verdict: 'confirmed', reason: 'Проверено', title: '', description: '', severity: '', legalType: '', proposal: '', sources: [], legalSources: [] }] };
  const confirmed = parseReview(primary, structuredClone(delta));
  assert.deepEqual(confirmed.qualifications, primary.qualifications);
  assert.deepEqual(confirmed.findings[0].legalSources, primary.findings[0].legalSources);
  assert.equal(confirmed.findings[0].legalType, 'facts_or_documents_required');
  delta.verdicts[0].verdict = 'corrected';
  delta.verdicts[0].legalType = 'dispositive_unfavorable';
  const corrected = parseReview(primary, structuredClone(delta));
  assert.deepEqual(corrected.findings[0].legalSources, []);
  assert.equal(corrected.findings[0].legalType, 'dispositive_unfavorable');
  delta.verdicts[0].legalSources = [{ normId: 'RU-GK2-708-2', quote: snapshot().legal.norms.find(n => n.id === 'RU-GK2-708-2').text }];
  assert.equal(parseReview(primary, delta).findings[0].legalSources[0].normId, 'RU-GK2-708-2');
});

test('legacy review deltas inherit normalized qualifications and legal types', () => {
  const primary = result(); primary.findings = [finding()]; delete primary.qualifications; delete primary.findings[0].legalType;
  const delta = { summary: primary.summary, passport: primary.passport, coverage: primary.coverage, limitations: [], changes: [], added: [],
    verdicts: [{ id: 'law', verdict: 'confirmed', reason: 'Проверено', title: '', description: '', severity: '', proposal: '', sources: [], legalSources: [] }] };
  const assembled = parseReview(primary, delta);
  assert.deepEqual(assembled.qualifications, []);
  assert.equal(assembled.findings[0].legalType, 'facts_or_documents_required');
});

test('a legal-v2 review cannot use legacy normalization to omit required fields', () => {
  const primary = result(); primary.findings = [finding()];
  const delta = { summary: primary.summary, passport: primary.passport, coverage: primary.coverage, limitations: [], changes: [], added: [],
    verdicts: [{ id: 'law', verdict: 'confirmed', reason: 'Проверено', title: '', description: '', severity: '', proposal: '', sources: [], legalSources: [] }] };
  assert.throws(() => parseReview(primary, delta), /структуре решений/);
});
