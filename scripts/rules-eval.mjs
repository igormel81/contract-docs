// Manual check that the criteria actually fire. Runs one fixture fragment per
// model call, so it is never part of npm test.
//   npm run rules:eval            all rules
//   npm run rules:eval PAY-01     one rule
// The executor follows DOCS_MODEL_PROVIDER exactly as the service does: codex
// (shared application login), local (internal inference server) or a cloud
// vendor. An on-premise installation has to be able to measure its own rules
// on its own model; before this the script could only talk to the Codex CLI.
// The analyses table is not touched: this script talks to the executor directly.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from '../server/schema.mjs';
import { rules, sharedInstruction, analystInstruction, instructionVersion } from '../server/rules.mjs';
import { modelProviderConfiguration } from '../server/main.mjs';
import { LocalModelProvider } from '../server/model-providers/local.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = resolve(process.env.DOCS_DATA || join(root, 'data'));
const binary = process.env.DOCS_CODEX || '/usr/bin/codex';
const home = join(data, 'codex', 'application');
const only = process.argv.slice(2).map(x => x.toUpperCase());
// Фрагмент — не договор целиком. Без этой оговорки модель справедливо
// жалуется на отсутствие всех прочих условий, и любой отрицательный пример
// превращается в замечание: измерялась бы неполнота примера, а не правило.
const excerpt = 'ПРОВЕРКА ОТДЕЛЬНОГО УСЛОВИЯ. Тебе передан ФРАГМЕНТ договора, а не полный комплект. Отсутствие любых условий за пределами фрагмента не является замечанием и не отражается в findings: считай, что они согласованы в другой части договора. Оценивай только то, что прямо написано во фрагменте. Правила, к которым фрагмент не относится, помечай not_applicable.';
const fragmentSnapshot = (fragment, profile) => ({ version: 1, kind: 'contract', profile, rules, instructionVersion,
  documents: [{ id: 'fixture', name: 'Фрагмент.docx', hash: 'fixture', blocks: [{ id: 'f1', text: fragment, locator: { label: 'фрагмент', status: 'uncertain' } }], warnings: [] }] });
const disabled = ['shell_tool','unified_exec','apps','plugins','remote_plugin','hooks','multi_agent','multi_agent_v2','browser_use','browser_use_external','computer_use','image_generation','view_image','workspace_dependencies','skill_search','code_mode_host','in_app_browser','in_app_local_automation','goals','sleep_tool'];

async function askCodex(fragment, profile) {
  const cwd = await mkdtemp(join(tmpdir(), 'rules-eval-'));
  try {
    const schemaPath = join(cwd, 'schema.json');
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    const snapshot = fragmentSnapshot(fragment, profile);
    const args = ['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never','--output-schema',schemaPath,'-C',cwd,'-c','approval_policy="never"','-c','forced_login_method="chatgpt"','-c','cli_auth_credentials_store="file"','-c','web_search="disabled"'];
    for (const feature of disabled) args.push('--disable', feature);
    args.push('-');
    return await new Promise((done, fail) => {
      const child = spawn(binary, args, { cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', CODEX_HOME: home }, stdio: ['pipe','pipe','pipe'] });
      let output = '', errorText = '';
      const started = Date.now();
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); });
      child.stdin.end(`${sharedInstruction}\n${excerpt}\n${analystInstruction}\nДАННЫЕ КОМПЛЕКТА:\n${JSON.stringify(snapshot)}`);
      child.on('error', () => fail(new Error('Codex CLI недоступен: ' + binary)));
      child.on('close', code => {
        if (code !== 0) return fail(new Error(errorText.trim().split('\n').at(-1) || 'Codex завершился с ошибкой.'));
        try {
          const events = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
          const message = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1);
          const usage = events.find(e => e.type === 'turn.completed')?.usage ?? null;
          done({ result: JSON.parse(message.item.text), usage: usage ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } : null, ms: Date.now() - started });
        } catch (e) { fail(e); }
      });
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

// Local and cloud executors share one call contract (server/model-providers/*):
// a complete stage input with its response schema, validated by the provider.
async function askProvider(provider, fragment, profile) {
  const started = Date.now();
  const answer = await provider.generate({ runId: 'rules-eval', attemptId: randomUUID(), stage: 'primary',
    instructions: `${sharedInstruction}\n${excerpt}\n${analystInstruction}`, data: fragmentSnapshot(fragment, profile),
    jsonSchema: schema, model: provider.describe().model, maxOutputTokens: 8192, timeoutMs: 12 * 60_000, temporary: false });
  return { result: answer.json, usage: answer.usage ? { input: answer.usage.inputTokens, output: answer.usage.outputTokens } : null,
    ms: answer.durationMs ?? Date.now() - started };
}
const executor = modelProviderConfiguration({});
const provider = executor.kind === 'local' ? new LocalModelProvider(executor.config) : executor.kind === 'codex' ? null : executor.provider;
const ask = provider ? (fragment, profile) => askProvider(provider, fragment, profile) : askCodex;
console.log(`Исполнитель: ${executor.kind}${provider ? ' · ' + provider.describe().model : ' · ' + binary}`);

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
      const { result, usage, ms } = await ask(item.text, {name:'Синтетический исполнитель проверки правил',base:'Москва',unverified:'Лицензии и ресурсы требуют подтверждения.'});
      const fired = result.findings.some(f => f.rule === fixture.rule);
      const others = [...new Set(result.findings.filter(f => f.rule !== fixture.rule).map(f => f.rule))];
      verdict = fired ? 'finding' : others.length ? `другое правило: ${others.join(', ')}` : 'no_finding';
      spent.input += usage?.input ?? 0; spent.output += usage?.output ?? 0; spent.ms += ms;
      const allowed = [fixture.rule, ...(item.also || [])];
      // Пример принадлежит своему правилу и проверяет его поведение. Замечание
      // соседнего правила — сведение, а не провал: иначе каждый отрицательный
      // пример становится заложником всех остальных десяти правил.
      const matched = item.expect === 'finding' ? result.findings.some(f => allowed.includes(f.rule)) : !fired;
      if (!matched) { mismatches++; note = fired ? result.findings.find(f => f.rule === fixture.rule).title : (result.findings[0]?.title || item.why); }
    } catch (e) { verdict = 'ошибка'; note = e.message; mismatches++; }
    lines.push(`| ${fixture.rule} | ${index + 1}. ${item.text.slice(0, 60).replace(/\|/g,'/')}… | ${item.expect} | ${verdict} | ${note ? note.slice(0, 90) : '—'} |`);
    process.stdout.write(`${fixture.rule} ${index + 1}/${fixture.cases.length}: ожидание ${item.expect}, результат ${verdict}\n`);
  }
}
const report = [`# Прогон критериев · ${new Date().toISOString()}`, '', `Исполнитель: ${executor.kind}${provider ? ' · ' + provider.describe().model : ''}.`,
  `Версия набора: ${instructionVersion}. Расхождений: ${mismatches}.`,
  `Суммарно: ${spent.input} входных и ${spent.output} выходных токенов, ${Math.round(spent.ms / 1000)} с.`, '',
  'Расхождение — повод изменить формулировку правила или сам пример, а не подгонять ожидание.', '', ...lines].join('\n');
const out = join(process.env.DOCS_UI_SCREENSHOTS || tmpdir(), `rules-eval-${Date.now()}.md`);
await writeFile(out, report);
console.log(`\nРасхождений: ${mismatches}. Отчёт: ${out}`);
