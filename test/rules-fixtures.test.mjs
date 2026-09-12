import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rules } from '../server/rules.mjs';
// Structure only. Whether a rule actually fires is checked by npm run rules:eval
// against the real model; the suite itself stays deterministic and offline.
//
// Урок трёх прогонов: отрицательный пример обязан быть безупречен во всём, кроме
// проверяемого антипаттерна. Неназванный объект права, срок без стороны, ссылка на
// перечень за пределами фрагмента — модель поднимает их справедливо, и пример
// начинает проверять собственную неполноту вместо правила.
const dir = fileURLToPath(new URL('./rules/', import.meta.url));
const qualificationTypes = new Set(['works','services','software_creation','exclusive_right_assignment','license','mixed','equipment_supply','procurement_44fz','procurement_223fz']);
const legalTypes = new Set(['mandatory_violation','invalidity_or_unenforceability','dispositive_unfavorable','missing_required_term','facts_or_documents_required','not_applicable']);
test('every rule in coverage has fixtures with a case that must not raise a finding', async () => {
  const files = (await readdir(dir)).filter(name => name.endsWith('.json'));
  const expected = rules.filter(r => r.coverage !== false).map(r => r.id).sort();
  assert.deepEqual(files.map(name => name.replace('.json', '')).sort(), expected, 'One fixture file per rule that takes part in coverage');
  for (const name of files) {
    const data = JSON.parse(await readFile(join(dir, name), 'utf8'));
    assert.equal(data.rule, name.replace('.json', ''), `${name}: rule matches the file name`);
    assert.ok(Array.isArray(data.cases) && data.cases.length >= 5, `${name}: at least five cases`);
    assert.ok(data.cases.some(c => c.expect === 'no_finding'), `${name}: at least one case where a finding would be a false alarm`);
    assert.ok(data.cases.some(c => c.expect === 'finding'), `${name}: at least one case that must raise a finding`);
    for (const item of data.cases) {
      assert.ok(['finding', 'no_finding'].includes(item.expect), `${name}: expect is finding or no_finding`);
      assert.ok(typeof item.text === 'string' && item.text.trim().length >= 20, `${name}: every case needs a readable fragment`);
      // [параметр] — наша пометка для предлагаемых правок. В тексте договора это
      // читается как незаполненный срок, и любой отрицательный пример ломается.
      assert.ok(!item.text.includes('[параметр]'), `${name}: a contract fragment must not carry a proposal placeholder`);
      // Склеенный текст — «в течение в течение» — модель справедливо считает дефектом
      // условия, и отрицательный пример перестаёт проверять правило.
      assert.doesNotMatch(item.text, /\b(\p{L}+\s+\p{L}+)\s+\1\b/iu, `${name}: a fragment must not repeat a phrase`);
      assert.ok(typeof item.why === 'string' && item.why.trim().length >= 10, `${name}: every case explains itself`);
      // Соседнее правило вместо целевого — не промах, если это заранее допущено.
      for (const neighbour of item.also || []) assert.ok(rules.some(r => r.id === neighbour), `${name}: also points at an existing rule`);
    }
  }
});

test('legal-v2 rule fixtures classify applicability before legal effect', async () => {
  const changed = ['PD-01','IP-01','LIC-01','LOC-01'];
  const fixtures = await Promise.all(changed.map(async id => JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'))));
  for (const data of fixtures) {
    for (const item of data.cases) {
      assert.ok(Array.isArray(item.qualificationTypes), `${data.rule}: every case declares applicable obligation qualifications`);
      for (const type of item.qualificationTypes) assert.ok(qualificationTypes.has(type), `${data.rule}: known qualification ${type}`);
      if (item.expect === 'finding') assert.ok(legalTypes.has(item.legalType), `${data.rule}: a finding distinguishes its legal effect`);
    }
  }
  const commercial = fixtures.flatMap(data => data.cases.map(item => ({ rule: data.rule, ...item })))
    .filter(item => item.riskKind === 'commercial');
  assert.ok(commercial.length > 0, 'fixtures include a commercial risk that remains worth discussing');
  assert.ok(commercial.every(item => item.expect === 'finding' && item.legalType === 'not_applicable'), 'commercial risks are not labelled as legal violations');
});

test('only legal-v2 rules advance their snapshot versions and LAW-01 covers every qualification branch', () => {
  const expectedVersions = { 'LAW-01': 4, 'PD-01': 3, 'IP-01': 3, 'LIC-01': 3, 'LOC-01': 5 };
  for (const [id, version] of Object.entries(expectedVersions)) assert.equal(rules.find(rule => rule.id === id).version, version);
  assert.deepEqual(rules.filter(rule => !Object.hasOwn(expectedVersions, rule.id)).map(rule => [rule.id, rule.version]), [
    ['SCOPE-01',2], ['TIME-01',2], ['PAY-01',3], ['ACCEPT-01',2], ['LIAB-01',2], ['SLA-01',2], ['DATA-01',3]
  ]);
  const law = rules.find(rule => rule.id === 'LAW-01').instruction;
  for (const type of qualificationTypes) assert.ok(law.includes(type), `LAW-01 has an applicability branch for ${type}`);
  assert.match(law, /44-ФЗ.*procurement_44fz|procurement_44fz.*44-ФЗ/);
  assert.match(law, /223-ФЗ.*procurement_223fz|procurement_223fz.*223-ФЗ/);
});
