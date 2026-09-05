import { sourceLabel, severityLabels } from './document-ui.js';
// Built from the stored result by code, never by the model: no tokens, no delay
// and no second retelling that could soften a limitation on its way to a person.
const severityWord = key => severityLabels[key].toLowerCase();
const trim = (value, length) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return stop > length * 0.6 ? cut.slice(0, stop + 1) : cut + '…';
};
export function summaryText({ meta, result, full = false }) {
  if (!result) return '';
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of result.findings) counts[finding.severity]++;
  const lines = [];
  if (meta.manager) lines.push(`Для: ${meta.manager}`);
  lines.push(`Договор: ${meta.title}`);
  if (meta.customer) lines.push(`Заказчик: ${meta.customer}`);
  lines.push(`Подрядчик: ${meta.contractor}`);
  lines.push(meta.revision ? `Редакция: v${meta.revision} · анализ от ${meta.created}` : `Анализ от ${meta.created}`);
  lines.push(meta.reviewed ? 'Статус: ревью завершено' : 'Статус: ПЕРВИЧНЫЙ РЕЗУЛЬТАТ, РЕВЬЮ НЕ ЗАВЕРШЕНО');
  if (meta.temporary) lines.push('Разовая проверка: результат не сохранён в хранилище, постоянной ссылки на договор нет.');
  lines.push('', trim(result.summary, 400), '');
  const rank = { high: 0, medium: 1, low: 2 };
  const shown = full ? result.findings : [...result.findings].sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 5);
  lines.push(`Замечаний: ${result.findings.length} · высокой критичности ${counts.high}, средней ${counts.medium}, низкой ${counts.low}.`);
  if (!full && shown.length < result.findings.length) lines.push(`Ниже ${shown.length} из ${result.findings.length} в порядке критичности; полный список — в приложении.`);
  lines.push('');
  shown.forEach((finding, index) => {
    lines.push(`${index + 1}. [${finding.rule} · ${severityWord(finding.severity)}] ${finding.title}`);
    lines.push(trim(finding.description, full ? 700 : 300));
    const reference = finding.sources[0];
    if (reference) {
      lines.push(`Пункт: ${sourceLabel(reference, meta.files || [])}`);
      if (reference.quote) lines.push(`«${trim(reference.quote, 220)}»`);
    } else lines.push('Пункт: условие в проверенном комплекте не найдено.');
    for (const reference of finding.legalSources || []) {
      lines.push(`Норма: ${reference.title || reference.normId}${reference.sourceUrl ? ' — ' + reference.sourceUrl : ''}`);
      if (reference.quote) lines.push(`«${reference.quote}»`);
      if (reference.verificationStatus !== 'verified') lines.push('Актуальность нормы требует правовой проверки.');
    }
    lines.push('');
  });
  if (!shown.length) lines.push('Замечания в этой сводке не приводятся. Отсутствие замечаний не подтверждает отсутствие рисков.', '');
  lines.push('ОГРАНИЧЕНИЯ ПРОВЕРКИ', ...result.limitations.map(x => `— ${x}`));
  if (meta.link) lines.push('', `Открыть в приложении: ${meta.link}`);
  lines.push('', 'Это рекомендательный разбор для переговоров, а не заключение о соответствии: выводы требуют проверки сотрудником. Объём нормативного покрытия и актуальность норм указаны в ограничениях проверки.');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Messengers cut long messages; splitting on paragraph boundaries keeps a finding whole.
export function messageParts(text, size = 3500) {
  if (text.length <= size) return [text];
  const parts = [];
  let current = '';
  for (const block of text.split('\n\n')) {
    if (current && (current + '\n\n' + block).length > size) { parts.push(current); current = block; }
    else current = current ? current + '\n\n' + block : block;
  }
  if (current) parts.push(current);
  return parts.map((part, index) => `[${index + 1}/${parts.length}]\n${part}`);
}
