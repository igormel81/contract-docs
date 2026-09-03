import Ajv from 'ajv';
const string = { type: 'string', maxLength: 15000 };
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items, maxItems = 100) => ({ type: 'array', items, maxItems });
const source = obj({ fileId: string, blockId: string, quote: string });
const severity = { type: 'string', enum: ['high','medium','low'] };
const passport = arr(obj({ key: { type: 'string', enum: ['subject','result','term','price','payment','location','acceptance','dependencies','special'] }, title: string, value: string, status: { type: 'string', enum: ['extracted','missing','uncertain'] }, sources: arr(source, 20) }), 9);
const finding = obj({ id: string, rule: string, title: string, severity, description: string, sources: arr(source, 20), proposal: string, review: { type: 'string', enum: ['primary','confirmed','corrected','added'] } });
const coverage = arr(obj({ rule: string, status: { type: 'string', enum: ['checked','not_applicable','needs_data'] }, note: string }), 20);
export const schema = obj({
  summary: string, passport, findings: arr(finding, 60), coverage,
  limitations: arr(string, 30), changes: arr(string, 100)
});
// The reviewer answers about the analyst's findings instead of retyping them: one
// verdict per finding. Re-emitting a confirmed finding word for word costs the most
// expensive tokens there are and proves nothing.
export const reviewSchema = obj({
  summary: string, passport,
  verdicts: arr(obj({ id: string, verdict: { type: 'string', enum: ['confirmed','corrected','rejected'] }, reason: string,
    title: string, description: string, severity: { type: 'string', enum: ['','high','medium','low'] }, proposal: string, sources: arr(source, 20) }), 60),
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
      severity: item.severity || base.severity, proposal: item.proposal || base.proposal,
      sources: item.sources.length ? item.sources : base.sources, review: 'corrected' });
    changes.push(`Исправлено ревьюером: ${item.title || base.title}. ${item.reason}`);
  }
  for (const item of delta.added) findings.push({ ...item, review: 'added' });
  return { summary: delta.summary, passport: delta.passport, findings, coverage: delta.coverage, limitations: delta.limitations, changes };
}
// A single clause in, a single wording out: generating fifteen drafts nobody opens
// is the cheapest waste to remove.
export const proposalSchema = obj({ proposal: string, note: string });
export const legalLimitation = 'Правовая экспертиза не выполнялась: проверенная нормативная база не подключена, правовые выводы требуют юриста.';
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
const validateDelta = ajv.compile(reviewSchema);
export function parseReview(primary, delta) {
  if (!validateDelta(delta)) throw new Error('Ответ ревьюера не соответствует структуре решений.');
  return assembleReview(primary, delta);
}
const normalized = value => value.replace(/\s+/g, ' ').trim();
export function validateResult(result, snapshot, stage) {
  if (!validate(result)) throw new Error('Ответ агента не соответствует структуре результата.');
  if (result.passport.length !== 9 || new Set(result.passport.map(x => x.key)).size !== 9) throw new Error('Паспорт неполон.');
  const covered = snapshot.rules.filter(r => r.coverage !== false);
  if (result.coverage.length !== covered.length || new Set(result.coverage.map(x => x.rule)).size !== covered.length || result.coverage.some(x => !covered.some(r => r.id === x.rule))) throw new Error('Покрытие правил неполно.');
  if (new Set(result.findings.map(x => x.id)).size !== result.findings.length) throw new Error('Повторяющиеся ID замечаний.');
  const blocks = new Map(snapshot.documents.flatMap(f => f.blocks.map(b => [`${f.id}:${b.id}`, b.text])));
  for (const item of [...result.passport, ...result.findings]) {
    if (item.status === 'extracted' && !item.sources.length) throw new Error('У фактического условия нет источника.');
    for (const ref of item.sources) {
      const original = blocks.get(`${ref.fileId}:${ref.blockId}`);
      if (!original || normalized(ref.quote).length < 5 || !normalized(original).includes(normalized(ref.quote))) throw new Error('Цитата агента не найдена в исходнике. Результат требует повторной проверки.');
    }
    if (item.rule && !snapshot.rules.some(r => r.id === item.rule)) throw new Error('Неизвестное правило.');
    if (item.review && (stage === 'primary' ? item.review !== 'primary' : item.review === 'primary')) throw new Error('Неверный статус ревью.');
  }
  // A criterion that can never fire is not a check: the legal caveat is stated once, by the server.
  if (!result.limitations.some(x => x.includes(legalLimitation.slice(0, 40)))) result.limitations.push(legalLimitation);
  return result;
}
