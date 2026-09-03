// Manual check that the criteria actually fire. Runs one fixture fragment per Codex
// call through the shared application login, so it is never part of npm test.
//   npm run rules:eval            all rules
//   npm run rules:eval PAY-01     one rule
// The analyses table is not touched: this script talks to the CLI directly.
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from '../server/schema.mjs';
import { rules, profiles, sharedInstruction, analystInstruction, instructionVersion } from '../server/rules.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = resolve(process.env.DOCS_DATA || join(root, 'data'));
const binary = process.env.DOCS_CODEX || '/usr/bin/codex';
const home = join(data, 'codex', 'application');
const only = process.argv.slice(2).map(x => x.toUpperCase());
const disabled = ['shell_tool','unified_exec','apps','plugins','remote_plugin','hooks','multi_agent','multi_agent_v2','browser_use','browser_use_external','computer_use','image_generation','view_image','workspace_dependencies','skill_search','code_mode_host','in_app_browser','in_app_local_automation','goals','sleep_tool'];

async function ask(fragment, profile) {
  const cwd = await mkdtemp(join(tmpdir(), 'rules-eval-'));
  try {
    const schemaPath = join(cwd, 'schema.json');
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    const snapshot = { version: 1, kind: 'contract', profile, rules, instructionVersion,
      documents: [{ id: 'fixture', name: 'Фрагмент.docx', hash: 'fixture', blocks: [{ id: 'f1', text: fragment, locator: { label: 'фрагмент', status: 'uncertain' } }], warnings: [] }] };
    const args = ['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never','--output-schema',schemaPath,'-C',cwd,'-c','approval_policy="never"','-c','forced_login_method="chatgpt"','-c','cli_auth_credentials_store="file"','-c','web_search="disabled"'];
    for (const feature of disabled) args.push('--disable', feature);
    args.push('-');
    return await new Promise((done, fail) => {
      const child = spawn(binary, args, { cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', CODEX_HOME: home }, stdio: ['pipe','pipe','pipe'] });
      let output = '', errorText = '';
      const started = Date.now();
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); });
      // Фрагмент — не договор целиком. Без этой оговорки модель справедливо
      // жалуется на отсутствие всех прочих условий, и любой отрицательный пример
      // превращается в замечание: измерялась бы неполнота примера, а не правило.
      const excerpt = 'ПРОВЕРКА ОТДЕЛЬНОГО УСЛОВИЯ. Тебе передан ФРАГМЕНТ договора, а не полный комплект. Отсутствие любых условий за пределами фрагмента не является замечанием и не отражается в findings: считай, что они согласованы в другой части договора. Оценивай только то, что прямо написано во фрагменте. Правила, к которым фрагмент не относится, помечай not_applicable.';
      child.stdin.end(`${sharedInstruction}\n${excerpt}\n${analystInstruction}\nДАННЫЕ КОМПЛЕКТА:\n${JSON.stringify(snapshot)}`);
      child.on('error', () => fail(new Error('Codex CLI недоступен: ' + binary)));
      child.on('close', code => {
        if (code !== 0) return fail(new Error(errorText.trim().split('\n').at(-1) || 'Codex завершился с ошибкой.'));
        try {
          const events = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
          const message = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1);
          done({ result: JSON.parse(message.item.text), usage: events.find(e => e.type === 'turn.completed')?.usage ?? null, ms: Date.now() - started });
        } catch (e) { fail(e); }
      });
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

const dir = join(root, 'test', 'rules');
const files = (await readdir(dir)).filter(name => name.endsWith('.json') && (!only.length || only.includes(name.replace('.json',''))));
if (!files.length) { console.error('Фикстуры не найдены. Укажите существующее правило.'); process.exit(1); }
const lines = ['| Правило | Фрагмент | Ожидание | Результат | Расхождение |', '|---|---|---|---|---|'];
let mismatches = 0, spent = { input: 0, output: 0, ms: 0 };
for (const name of files) {
  const fixture = JSON.parse(await readFile(join(dir, name), 'utf8'));
  for (const [index, item] of fixture.cases.entries()) {
    let verdict, note = '';
    try {
      const { result, usage, ms } = await ask(item.text, profiles.custis);
      const fired = result.findings.some(f => f.rule === fixture.rule);
      const others = [...new Set(result.findings.filter(f => f.rule !== fixture.rule).map(f => f.rule))];
      verdict = fired ? 'finding' : others.length ? `другое правило: ${others.join(', ')}` : 'no_finding';
      spent.input += usage?.input_tokens ?? 0; spent.output += usage?.output_tokens ?? 0; spent.ms += ms;
      const allowed = [fixture.rule, ...(item.also || [])];
      const matched = item.expect === 'finding' ? result.findings.some(f => allowed.includes(f.rule)) : !result.findings.length;
      if (!matched) { mismatches++; note = fired ? result.findings.find(f => f.rule === fixture.rule).title : (result.findings[0]?.title || item.why); }
    } catch (e) { verdict = 'ошибка'; note = e.message; mismatches++; }
    lines.push(`| ${fixture.rule} | ${index + 1}. ${item.text.slice(0, 60).replace(/\|/g,'/')}… | ${item.expect} | ${verdict} | ${note ? note.slice(0, 90) : '—'} |`);
    process.stdout.write(`${fixture.rule} ${index + 1}/${fixture.cases.length}: ожидание ${item.expect}, результат ${verdict}\n`);
  }
}
const report = [`# Прогон критериев · ${new Date().toISOString()}`, '', `Версия набора: ${instructionVersion}. Расхождений: ${mismatches}.`,
  `Суммарно: ${spent.input} входных и ${spent.output} выходных токенов, ${Math.round(spent.ms / 1000)} с.`, '',
  'Расхождение — повод изменить формулировку правила или сам пример, а не подгонять ожидание.', '', ...lines].join('\n');
const out = join(process.env.DOCS_UI_SCREENSHOTS || tmpdir(), `rules-eval-${Date.now()}.md`);
await writeFile(out, report);
console.log(`\nРасхождений: ${mismatches}. Отчёт: ${out}`);
