// Сводка по запускам и решениям людей. Только чтение базы.
//   npm run stats            данные службы (DOCS_DATA или ./data)
// Показывает то, ради чего ведётся пилот: сколько стоит анализ, что ревьюер
// реально меняет и какая доля выводов доживает до решения сотрудника.
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rules } from '../server/rules.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = join(resolve(process.env.DOCS_DATA || join(root, 'data')), 'contracts.sqlite');
const db = new DatabaseSync(file, { readOnly: true });
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const rows = db.prepare('SELECT id,status,primary_result,review_result,created,updated FROM analyses').all();
const say = (label, value) => console.log(`  ${label.padEnd(42, '.')} ${value}`);

console.log(`\nБаза: ${file}\n`);
console.log('ЗАПУСКИ');
const byStatus = {};
for (const run of rows) byStatus[run.status] = (byStatus[run.status] || 0) + 1;
say('всего', rows.length);
for (const [status, count] of Object.entries(byStatus)) say(`  ${status}`, count);
const failedReview = rows.filter(r => r.primary_result && !r.review_result).length;
say('первичный есть, ревью не завершено', `${failedReview}${rows.length ? ` (${Math.round(failedReview / rows.length * 100)} %)` : ''}`);

console.log('\nСТОИМОСТЬ ЭТАПОВ');
const stages = { primary: [], review: [] };
for (const run of rows) for (const [stage, field] of [['primary','primary_result'],['review','review_result']]) {
  const execution = parse(run[field])?.execution;
  if (execution) stages[stage].push(execution);
}
for (const [stage, items] of Object.entries(stages)) {
  const label = stage === 'primary' ? 'аналитик' : 'ревьюер';
  if (!items.length) { say(label, 'запусков не было'); continue; }
  const avg = key => Math.round(items.reduce((sum, x) => sum + (x[key] || 0), 0) / items.length);
  const withUsage = items.filter(x => x.usage);
  say(`${label}: запусков`, items.length);
  say(`${label}: вход, знаков (среднее)`, avg('promptChars') || 'не сохранено');
  say(`${label}: длительность, с (среднее)`, Math.round(avg('durationMs') / 1000) || '<1');
  say(`${label}: расход сообщён`, withUsage.length ? `${withUsage.length} из ${items.length}, вход ${withUsage.reduce((s,x)=>s+(x.usage.input_tokens||0),0)}, выход ${withUsage.reduce((s,x)=>s+(x.usage.output_tokens||0),0)} токенов` : 'ни разу');
}

console.log('\nЧТО МЕНЯЕТ РЕВЬЮЕР');
let confirmed = 0, corrected = 0, added = 0, dropped = 0, changeNotes = 0;
for (const run of rows) {
  const primary = parse(run.primary_result), review = parse(run.review_result);
  if (!primary || !review) continue;
  for (const finding of review.findings) {
    if (finding.review === 'corrected') corrected++;
    else if (finding.review === 'added') added++;
    else confirmed++;
  }
  dropped += Math.max(0, primary.findings.length - review.findings.filter(f => f.review !== 'added').length);
  changeNotes += review.changes.length;
}
say('подтверждено без изменений', confirmed);
say('исправлено ревьюером', corrected);
say('добавлено ревьюером', added);
say('отклонено ревьюером', dropped);
say('записей в «изменениях»', changeNotes);
if (confirmed && !corrected && !added && !dropped) console.log('  ВНИМАНИЕ: ревьюер ничего не изменил ни разу — второй этап пока работает как штамп.');

console.log('\nРЕШЕНИЯ СОТРУДНИКОВ');
const decisions = db.prepare('SELECT status,COUNT(*) n FROM recommendations GROUP BY status').all();
for (const row of decisions) say(`план правок: ${row.status}`, row.n);
if (!decisions.length) say('план правок', 'решений не сохранено');
const risks = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN finding_key IS NOT NULL THEN 1 ELSE 0 END) fromFinding FROM risks').get();
say('рисков в реестре', `${risks.n} (из замечаний ${risks.fromFinding || 0}, вручную ${risks.n - (risks.fromFinding || 0)})`);
const dismissed = db.prepare('SELECT COUNT(*) n FROM dismissed_findings').get().n;
say('кандидатов отклонено', dismissed);
const findingsTotal = rows.reduce((sum, run) => sum + (parse(run.review_result || run.primary_result)?.findings.length || 0), 0);
say('замечаний всего', findingsTotal);
say('доля замечаний, ставших риском', findingsTotal ? `${Math.round((risks.fromFinding || 0) / findingsTotal * 100)} %` : '—');

console.log('\nПРАВИЛА НА ПРАКТИКЕ');
const planned = new Set(db.prepare("SELECT analysis_id||':'||finding_id k FROM recommendations WHERE status='planned'").all().map(r => r.k));
const riskRules = db.prepare('SELECT finding_key FROM risks WHERE finding_key IS NOT NULL').all().map(r => String(r.finding_key).split('|')[0]);
const perRule = new Map();
for (const run of rows) {
  const result = parse(run.review_result || run.primary_result);
  for (const finding of result?.findings || []) {
    const stat = perRule.get(finding.rule) || { total: 0, high: 0, planned: 0, risks: 0 };
    stat.total++; if (finding.severity === 'high') stat.high++;
    if (planned.has(`${run.id}:${finding.id}`)) stat.planned++;
    perRule.set(finding.rule, stat);
  }
}
for (const rule of riskRules) { const stat = perRule.get(rule); if (stat) stat.risks++; }
if (!perRule.size) say('замечаний по правилам', 'нет данных');
for (const [rule, stat] of [...perRule].sort((a, b) => b[1].total - a[1].total))
  say(rule, `${stat.total} замечаний (высоких ${stat.high}), в план правок ${stat.planned}, в риски ${stat.risks}`);
const silent = rules.filter(r => r.coverage !== false && !perRule.has(r.id)).map(r => r.id);
if (silent.length) say('ни разу не сработали', silent.join(', '));

console.log('\nОГРАНИЧЕНИЯ');
const limits = new Map();
for (const run of rows) for (const line of parse(run.review_result || run.primary_result)?.limitations || []) limits.set(line, (limits.get(line) || 0) + 1);
for (const [line, count] of [...limits].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${count}× ${line.slice(0, 90)}`);
console.log('\nЭто наблюдения пилота, а не измеренное качество: экспертной разметки нет.\n');
db.close();
