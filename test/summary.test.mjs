import test from 'node:test';
import assert from 'node:assert/strict';
import { canShareSummary, summaryMailto, summaryText } from '../public/summary.js';

const finding = index => ({
  id: `finding-${index}`,
  rule: 'PAY-01',
  title: `Замечание ${index}`,
  severity: index % 3 === 0 ? 'high' : index % 3 === 1 ? 'medium' : 'low',
  description: `Полное описание замечания ${index}: ${'существенное условие '.repeat(45)}конец ${index}.`,
  proposal: `Предлагаемая формулировка ${index}.`,
  sources: [{ location: `п. ${index}.1`, quote: `Полная цитата ${index}.` }],
  legalSources: []
});

const meta = {
  title: 'Договор внедрения',
  contractor: 'Исполнитель',
  created: '07.09.2026, 12:00',
  reviewed: true,
  files: []
};

test('manager text includes every finding with its complete description and proposal', () => {
  const findings = Array.from({ length: 12 }, (_, index) => finding(index + 1));
  const summary = `Итог анализа: ${'важный вывод '.repeat(80)}`;
  const text = summaryText({ meta, result: { summary, findings, limitations: [] } });

  assert.match(text, /Замечаний: 12/);
  assert.ok(text.includes(summary.trim()), 'summary was shortened');
  assert.doesNotMatch(text, /из 12|полный список — в приложении/i);
  for (const item of findings) {
    assert.ok(text.includes(item.title), `missing ${item.title}`);
    assert.ok(text.includes(item.description), `description was shortened for ${item.title}`);
    assert.ok(text.includes(`Предложение: ${item.proposal}`), `missing proposal for ${item.title}`);
  }
});

test('mailto keeps the complete manager text and only uses an actual email as recipient', () => {
  const text = `Начало\n${'длинный текст '.repeat(400)}\nКонец`;
  const link = summaryMailto({ manager: 'Мария, manager@example.test', title: 'Договор № 7', text });
  const url = new URL(link);

  assert.equal(url.pathname, 'manager@example.test');
  assert.equal(url.searchParams.get('subject'), 'Замечания по договору: Договор № 7');
  assert.equal(url.searchParams.get('body'), text);
  assert.doesNotMatch(link, /\+/);
  assert.equal(new URL(summaryMailto({ manager: 'Мария, менеджер', title: 'Договор', text })).pathname, '');
});

test('system sharing is offered only when Web Share API is callable', () => {
  assert.equal(canShareSummary({ share() {} }), true);
  assert.equal(canShareSummary({}), false);
  assert.equal(canShareSummary(null), false);
});
