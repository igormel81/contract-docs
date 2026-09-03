import Ajv from 'ajv';
const string = { type: 'string', maxLength: 15000 };
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items, maxItems = 100) => ({ type: 'array', items, maxItems });
const source = obj({ fileId: string, blockId: string, quote: string });
export const schema = obj({
  summary: string,
  passport: arr(obj({ key: { type: 'string', enum: ['subject','result','term','price','payment','location','acceptance','dependencies','special'] }, title: string, value: string, status: { type: 'string', enum: ['extracted','missing','uncertain'] }, sources: arr(source, 20) }), 9),
  findings: arr(obj({ id: string, rule: string, title: string, severity: { type: 'string', enum: ['high','medium','low'] }, description: string, sources: arr(source, 20), proposal: string, review: { type: 'string', enum: ['primary','confirmed','corrected','added'] } }), 60),
  coverage: arr(obj({ rule: string, status: { type: 'string', enum: ['checked','not_applicable','needs_data'] }, note: string }), 10),
  limitations: arr(string, 30), changes: arr(string, 100)
});
export const legalLimitation = 'Правовая экспертиза не выполнялась: проверенная нормативная база не подключена, правовые выводы требуют юриста.';
const validate = new Ajv({ allErrors: true }).compile(schema);
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
