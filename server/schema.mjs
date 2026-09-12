import Ajv from 'ajv';
import { validateLegalResult } from './legal.mjs';
const string = { type: 'string', maxLength: 15000 };
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items, maxItems = 100) => ({ type: 'array', items, maxItems });
const source = obj({ fileId: string, blockId: string, quote: string });
const legalSources = arr(obj({ normId: string, quote: string }), 10);
const severity = { type: 'string', enum: ['high','medium','low'] };
const qualificationType = { type: 'string', enum: ['works','services','software_creation','exclusive_right_assignment','license','mixed','equipment_supply','procurement_44fz','procurement_223fz'] };
const confidence = { type: 'string', enum: ['high','medium','low'] };
const legalTypeValues = ['mandatory_violation','invalidity_or_unenforceability','dispositive_unfavorable','missing_required_term','facts_or_documents_required','not_applicable'];
const legalType = { type: 'string', enum: legalTypeValues };
const qualifications = arr(obj({ type: qualificationType, sources: { ...arr(source, 20), minItems: 1 }, confidence, note: string,
  legalModules: arr({ type: 'string', minLength: 1, maxLength: 200 }, 20) }), 20);
export const qualificationSchema = obj({ qualifications });
const passport = arr(obj({ key: { type: 'string', enum: ['subject','result','term','price','payment','location','acceptance','dependencies','special'] }, title: string, value: string, status: { type: 'string', enum: ['extracted','missing','uncertain'] }, sources: arr(source, 20) }), 9);
const finding = obj({ id: string, rule: string, title: string, severity, description: string, sources: arr(source, 20), legalSources, legalType, proposal: string, review: { type: 'string', enum: ['primary','confirmed','corrected','added'] } });
const coverage = arr(obj({ rule: string, status: { type: 'string', enum: ['checked','not_applicable','needs_data'] }, note: string }), 20);
export const schema = obj({
  summary: string, qualifications, passport, findings: arr(finding, 60), coverage,
  limitations: arr(string, 30), changes: arr(string, 100)
});
// The reviewer answers about the analyst's findings instead of retyping them: one
// verdict per finding. Re-emitting a confirmed finding word for word costs the most
// expensive tokens there are and proves nothing.
export const reviewSchema = obj({
  summary: string, qualifications, passport,
  verdicts: arr(obj({ id: string, verdict: { type: 'string', enum: ['confirmed','corrected','rejected'] }, reason: string,
    title: string, description: string, severity: { type: 'string', enum: ['','high','medium','low'] }, legalType: { type: 'string', enum: ['', ...legalTypeValues] }, proposal: string, sources: arr(source, 20), legalSources }), 60),
  added: arr(finding, 20), coverage,
  limitations: arr(string, 30), changes: arr(string, 100)
});
export function assembleReview(primary, delta) {
  const byId = new Map(primary.findings.map(f => [f.id, f]));
  const ids = new Set(delta.verdicts.map(v => v.id));
  if (ids.size !== delta.verdicts.length || ids.size !== byId.size || delta.verdicts.some(v => !byId.has(v.id)))
    throw new Error('Ревьюер должен вынести ровно одно решение по каждому замечанию аналитика.');
  const findings = [], changes = [...delta.changes];
  for (const item of delta.verdicts) {
    const base = byId.get(item.id);
    if (item.verdict === 'rejected') { changes.push(`Отклонено ревьюером: ${base.title}. ${item.reason}`); continue; }
    if (item.verdict === 'confirmed') { findings.push({ ...base, review: 'confirmed' }); continue; }
    findings.push({ ...base, title: item.title || base.title, description: item.description || base.description,
      severity: item.severity || base.severity, legalType: item.legalType || base.legalType, proposal: item.proposal || base.proposal,
      sources: item.sources.length ? item.sources : base.sources, legalSources: item.legalSources ?? base.legalSources ?? [], review: 'corrected' });
    changes.push(`Исправлено ревьюером: ${item.title || base.title}. ${item.reason}`);
  }
  for (const item of delta.added) findings.push({ ...item, review: 'added' });
  return { summary: delta.summary, qualifications: delta.qualifications, passport: delta.passport, findings, coverage: delta.coverage, limitations: delta.limitations, changes };
}
// A single clause in, a single wording out: generating fifteen drafts nobody opens
// is the cheapest waste to remove.
export const proposalSchema = obj({ proposal: string, note: string });
export const legalLimitation = 'Правовая экспертиза не выполнялась: проверенная нормативная база не подключена, правовые выводы требуют юриста.';
const ajv = new Ajv({ allErrors: true });
const validateQualificationOutput = ajv.compile(qualificationSchema);
const validate = ajv.compile(schema);
const validateDelta = ajv.compile(reviewSchema);
export function parseReview(primary, delta) {
  // A primary result without qualifications predates legal-v2. Modern primary
  // results make the review schema strict; missing fields are not repaired.
  if (primary.qualifications === undefined) {
    primary.qualifications = [];
    for (const item of primary.findings || []) {
      if (item.legalSources === undefined) item.legalSources = [];
      if (item.legalType === undefined) item.legalType = 'facts_or_documents_required';
    }
    if (delta.qualifications === undefined) delta.qualifications = [];
    for (const item of delta.verdicts || []) {
      if (item.legalSources === undefined) item.legalSources = [];
      if (item.legalType === undefined) item.legalType = '';
    }
    for (const item of delta.added || []) {
      if (item.legalSources === undefined) item.legalSources = [];
      if (item.legalType === undefined) item.legalType = 'facts_or_documents_required';
    }
  }
  if (!validateDelta(delta)) throw new Error('Ответ ревьюера не соответствует структуре решений.');
  return assembleReview(primary, delta);
}
const normalized = value => value.replace(/\s+/g, ' ').trim();
const documentBlocks = snapshot => new Map(snapshot.documents.flatMap(file => file.blocks.map(block => [`${file.id}:${block.id}`, block.text])));
const pinnedModules = snapshot => {
  if (!Array.isArray(snapshot.legal?.modules)) {
    const legacy = snapshot.legal?.norms?.length ? new Map([['core', { id: 'core', qualificationTypes: [] }]]) : new Map();
    return { all: legacy, active: legacy };
  }
  const all = new Map(snapshot.legal.modules.map(module => [module.id, module]));
  const activeIds = Array.isArray(snapshot.legal.activeModuleIds)
    ? new Set(snapshot.legal.activeModuleIds) : new Set(snapshot.legal.modules.filter(module => module.enabledByDefault).map(module => module.id));
  return { all, active: new Map([...all].filter(([id]) => activeIds.has(id))) };
};
function checkQualifications(items, snapshot) {
  if (new Set(items.map(item => item.type)).size !== items.length) throw new Error('Квалификация обязательств содержит повторяющиеся типы.');
  const blocks = documentBlocks(snapshot), modules = pinnedModules(snapshot);
  for (const item of items) {
    for (const ref of item.sources) {
      const original = blocks.get(`${ref.fileId}:${ref.blockId}`);
      if (!original || normalized(ref.quote).length < 5 || !normalized(original).includes(normalized(ref.quote))) throw new Error('Цитата квалификации не найдена в исходнике.');
    }
    for (const id of item.legalModules) {
      const module = modules.all.get(id);
      if (!module) throw new Error(`Квалификация ссылается на неизвестный нормативный модуль: ${id}.`);
      if (!modules.active.has(id)) throw new Error(`Квалификация ссылается на неактивный нормативный модуль: ${id}.`);
      if (module.qualificationTypes?.length && !module.qualificationTypes.includes(item.type)) throw new Error(`Нормативный модуль ${id} не применим к квалификации ${item.type}.`);
    }
  }
  return modules;
}
export function validateQualifications(result, snapshot) {
  if (!validateQualificationOutput(result)) throw new Error('Ответ агента не соответствует структуре квалификации.');
  checkQualifications(result.qualifications, snapshot);
  return result;
}
export function validateResult(result, snapshot, stage) {
  if (snapshot.analysisContractVersion !== 'legal-v2') {
    if (result.qualifications === undefined) result.qualifications = [];
    for (const item of result.findings || []) {
      if (item.legalSources === undefined) item.legalSources = [];
      if (item.legalType === undefined) item.legalType = 'facts_or_documents_required';
    }
  }
  if (!validate(result)) throw new Error('Ответ агента не соответствует структуре результата.');
  if (result.passport.length !== 9 || new Set(result.passport.map(x => x.key)).size !== 9) throw new Error('Паспорт неполон.');
  checkQualifications(result.qualifications, snapshot);
  const covered = snapshot.rules.filter(r => r.coverage !== false);
  if (result.coverage.length !== covered.length || new Set(result.coverage.map(x => x.rule)).size !== covered.length || result.coverage.some(x => !covered.some(r => r.id === x.rule))) throw new Error('Покрытие правил неполно.');
  if (new Set(result.findings.map(x => x.id)).size !== result.findings.length) throw new Error('Повторяющиеся ID замечаний.');
  const blocks = documentBlocks(snapshot);
  const legalConclusions = new Set(['mandatory_violation','invalidity_or_unenforceability','dispositive_unfavorable','missing_required_term']);
  const hasLegalConclusion = result.findings.some(item => legalConclusions.has(item.legalType));
  if (!result.qualifications.length && hasLegalConclusion) throw new Error('Юридический вывод невозможен без квалификации обязательства.');
  if (hasLegalConclusion && !result.qualifications.some(item => item.legalModules.length)) throw new Error('Юридический вывод невозможен без применимого нормативного модуля.');
  if (snapshot.analysisContractVersion === 'legal-v2') {
    const selectedModules = new Set(result.qualifications.flatMap(item => item.legalModules));
    const norms = new Map((snapshot.legal?.norms || []).map(norm => [norm.id, norm]));
    for (const finding of result.findings) for (const ref of finding.legalSources) {
      const norm = norms.get(ref.normId);
      if (norm && !selectedModules.has(norm.moduleId || 'core')) throw new Error(`Нормативный модуль ${norm.moduleId || 'core'} не выбран квалификацией.`);
    }
  }
  for (const item of [...result.passport, ...result.findings]) {
    if (item.status === 'extracted' && !item.sources.length) throw new Error('У фактического условия нет источника.');
    for (const ref of item.sources) {
      const original = blocks.get(`${ref.fileId}:${ref.blockId}`);
      if (!original || normalized(ref.quote).length < 5 || !normalized(original).includes(normalized(ref.quote))) throw new Error('Цитата агента не найдена в исходнике. Результат требует повторной проверки.');
    }
    if (item.rule && !snapshot.rules.some(r => r.id === item.rule)) throw new Error('Неизвестное правило.');
    if (item.review && (stage === 'primary' ? item.review !== 'primary' : item.review === 'primary')) throw new Error('Неверный статус ревью.');
  }
  // Preserve the historical caveat only for runs without a corpus snapshot.
  if (!snapshot.legal && !result.limitations.some(x => x.includes(legalLimitation.slice(0, 40)))) result.limitations.push(legalLimitation);
  return validateLegalResult(result, snapshot);
}
