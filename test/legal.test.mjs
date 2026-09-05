import test from 'node:test';
import assert from 'node:assert/strict';
import { readLegalCorpus, legalCatalog, withLegalContext, legalStatus, validateLegalResult, enrichLegalSources } from '../server/legal.mjs';
import { schema, reviewSchema, validateResult, parseReview } from '../server/schema.mjs';
import { rules } from '../server/rules.mjs';

const now = new Date('2026-09-05T12:00:00Z');
const snapshot = () => withLegalContext({ rules, documents: [{ id: 'doc', blocks: [{ id: 'clause', text: '3.1. Работы выполняются до 1 декабря 2026 года.' }] }] }, now);
const result = () => ({ summary: 'Тест', passport: ['subject','result','term','price','payment','location','acceptance','dependencies','special'].map(key => ({ key, title: key, value: 'Нет данных', status: 'missing', sources: [] })), findings: [],
  coverage: snapshot().rules.filter(r => r.coverage !== false).map(r => ({ rule: r.id, status: 'needs_data', note: 'Требуются данные' })), limitations: [], changes: [] });
const finding = () => ({ id: 'law', rule: 'LAW-01', title: 'Проверить определимость начала работ', severity: 'medium',
  description: 'Требуется правовая проверка применимости и редакции нормы.', sources: [{ fileId: 'doc', blockId: 'clause', quote: 'Работы выполняются до 1 декабря 2026 года.' }],
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
  assert.equal(legalStatus(captured.legal, new Date('2026-10-06')), 'stale');
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

test('legacy findings normalize missing legalSources while strict output schemas require the property', () => {
  const oldSnapshot = { rules, documents: snapshot().documents };
  const oldResult = result(); oldResult.coverage = oldResult.coverage.filter(c => c.rule !== 'LAW-01');
  const item = { ...finding(), rule: 'TIME-01' }; delete item.legalSources; oldResult.findings = [item];
  assert.doesNotThrow(() => validateResult(oldResult, oldSnapshot, 'primary'));
  assert.deepEqual(oldResult.findings[0].legalSources, []);
  assert.ok(schema.properties.findings.items.required.includes('legalSources'));
  assert.ok(reviewSchema.properties.verdicts.items.required.includes('legalSources'));
});

test('review confirmation inherits legal references; correction explicitly replaces or removes them', () => {
  const primary = result(); primary.findings = [finding()];
  const delta = { summary: primary.summary, passport: primary.passport, coverage: primary.coverage, limitations: [], changes: [], added: [],
    verdicts: [{ id: 'law', verdict: 'confirmed', reason: 'Проверено', title: '', description: '', severity: '', proposal: '', sources: [], legalSources: [] }] };
  assert.deepEqual(parseReview(primary, structuredClone(delta)).findings[0].legalSources, primary.findings[0].legalSources);
  delta.verdicts[0].verdict = 'corrected';
  assert.deepEqual(parseReview(primary, structuredClone(delta)).findings[0].legalSources, []);
  delta.verdicts[0].legalSources = [{ normId: 'RU-GK2-708-2', quote: snapshot().legal.norms.find(n => n.id === 'RU-GK2-708-2').text }];
  assert.equal(parseReview(primary, delta).findings[0].legalSources[0].normId, 'RU-GK2-708-2');
});
