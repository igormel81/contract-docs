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
const completeText = value => String(value ?? '').trim();

export function summaryText({ meta, result }) {
  if (!result) return '';
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const limitations = Array.isArray(result.limitations) ? result.limitations : [];
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) if (finding.severity in counts) counts[finding.severity]++;
  const lines = [];
  if (meta.manager) lines.push(`Для: ${meta.manager}`);
  lines.push(`Договор: ${meta.title}`);
  if (meta.customer) lines.push(`Заказчик: ${meta.customer}`);
  lines.push(`Подрядчик: ${meta.contractor}`);
  lines.push(meta.revision ? `Редакция: v${meta.revision} · анализ от ${meta.created}` : `Анализ от ${meta.created}`);
  lines.push(meta.reviewed ? 'Статус: ревью завершено' : 'Статус: ПЕРВИЧНЫЙ РЕЗУЛЬТАТ, РЕВЬЮ НЕ ЗАВЕРШЕНО');
  if (meta.temporary) lines.push('Разовая проверка: результат не сохранён в хранилище, постоянной ссылки на договор нет.');
  lines.push('', completeText(result.summary), '');
  lines.push(`Замечаний: ${findings.length} · высокой критичности ${counts.high}, средней ${counts.medium}, низкой ${counts.low}.`);
  lines.push('');
  findings.forEach((finding, index) => {
    lines.push(`${index + 1}. [${finding.rule} · ${severityWord(finding.severity)}] ${finding.title}`);
    lines.push(completeText(finding.description));
    if (finding.proposal) lines.push(`Предложение: ${completeText(finding.proposal)}`);
    const references = finding.sources || [];
    if (references.length) for (const reference of references) {
      lines.push(`Пункт: ${sourceLabel(reference, meta.files || [])}`);
      if (reference.quote) lines.push(`«${completeText(reference.quote)}»`);
    } else lines.push('Пункт: условие в проверенном комплекте не найдено.');
    for (const reference of finding.legalSources || []) {
      lines.push(`Норма: ${reference.title || reference.normId}${reference.sourceUrl ? ' — ' + reference.sourceUrl : ''}`);
      if (reference.quote) lines.push(`«${reference.quote}»`);
      if (reference.verificationStatus !== 'verified') lines.push('Актуальность нормы требует правовой проверки.');
    }
    lines.push('');
  });
  if (!findings.length) lines.push('Замечания не сформированы. Их отсутствие не подтверждает отсутствие рисков.', '');
  lines.push('ОГРАНИЧЕНИЯ ПРОВЕРКИ', ...limitations.map(x => `— ${x}`));
  if (meta.link) lines.push('', `Открыть в приложении: ${meta.link}`);
  lines.push('', 'Это рекомендательный разбор для переговоров, а не заключение о соответствии: выводы требуют проверки сотрудником. Объём нормативного покрытия и актуальность норм указаны в ограничениях проверки.');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const emailFrom = value => completeText(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';

export function summaryMailto({ manager, title, text }) {
  const recipient = emailFrom(manager);
  const subject = `Замечания по договору: ${completeText(title)}`;
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(String(text ?? ''))}`;
}

export const canShareSummary = navigatorLike => typeof navigatorLike?.share === 'function';
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
