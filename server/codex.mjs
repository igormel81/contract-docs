import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { schema, reviewSchema, proposalSchema, validateResult, parseReview } from './schema.mjs';
import { sharedInstruction, analystInstruction, reviewerInstruction, proposalInstruction } from './rules.mjs';
import { now, audit } from './db.mjs';
import { HttpError } from './security.mjs';
import { resultSources, leanResult } from './sources.mjs';

const disabled = ['shell_tool','unified_exec','apps','plugins','remote_plugin','hooks','multi_agent','multi_agent_v2','browser_use','browser_use_external','computer_use','image_generation','view_image','workspace_dependencies','skill_search','code_mode_host','in_app_browser','in_app_local_automation','goals','sleep_tool'];
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
export class CodexRunner {
  constructor(db, dir, binary = '/usr/bin/codex') {
    this.db = db; this.dir = dir; this.binary = binary; this.loginState = null; this.active = null;
    this.authOperation = null; this.authEpoch = 0;
    db.prepare("UPDATE analyses SET status='interrupted', error='Сервис перезапущен. Исход предыдущей попытки неизвестен; сохранённые результаты доступны.', updated=? WHERE status IN ('primary','review','queued')").run(now());
  }
  home() { return join(this.dir, 'codex', 'application'); }
  env() { return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', CODEX_HOME: this.home() }; }
  async status(canManage = false) {
    const epoch = this.authEpoch;
    let connected = false;
    try {
      const data = JSON.parse(await readFile(join(this.home(), 'auth.json'), 'utf8'));
      connected = data.auth_mode === 'chatgpt' && Boolean(data.tokens?.access_token);
    } catch { /* No credentials is a normal disconnected state. */ }
    if (epoch !== this.authEpoch || this.authOperation === 'logout') connected = false;
    const login = this.loginState;
    const state = this.authOperation === 'logout' ? 'disconnecting' : connected ? 'connected' : login?.state === 'pending' ? 'connecting' : login?.state === 'error' ? 'error' : 'disconnected';
    return { scope: 'application', connected, method: connected ? 'ChatGPT' : null, canManage, state,
      login: canManage && !connected && login ? { url: login.url, code: login.code, state: login.state, error: login.error } : null };
  }
  async login() {
    if (this.authOperation) throw new HttpError(409, 'Подключение Codex уже изменяется. Подождите.');
    this.authOperation = 'login';
    try {
    if ((await this.status()).connected || this.loginState?.state === 'pending') return await this.status(true);
    await mkdir(this.home(), { recursive: true, mode: 0o700 });
    const child = spawn(this.binary, ['login', '--device-auth', '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"'], { env: this.env(), cwd: this.home(), stdio: ['ignore','pipe','pipe'] });
    const state = { child, url: null, code: null, state: 'pending', error: null }; this.loginState = state;
    let output = '';
    const consume = chunk => {
      output = (output + chunk.toString().replace(/\x1b\[[0-9;]*m/g, '')).slice(-12000);
      const url = output.match(/https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[^\s<>]+/);
      const code = output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/);
      if (url) state.url = url[0]; if (code) state.code = code[0];
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60000); timer.unref();
    child.on('error', () => { state.state = 'error'; state.error = 'Не удалось запустить вход Codex.'; });
    child.on('close', code => { clearTimeout(timer); state.state = code === 0 ? 'complete' : 'error'; if (code !== 0) state.error = 'Вход не завершён. Проверьте доступность входа по коду в настройках ChatGPT и повторите.'; state.code = null; });
    return await this.status(true);
    } finally { this.authOperation = null; }
  }
  async logout() {
    if (this.authOperation) throw new HttpError(409, 'Подключение Codex уже изменяется. Подождите.');
    this.authOperation = 'logout'; this.authEpoch++;
    try {
      const login = this.loginState; this.loginState = null;
      this.db.prepare("UPDATE analyses SET status='cancelled',error='Общее подключение Codex отключено владельцем приложения',updated=? WHERE status IN ('queued','primary','review')").run(now());
      this.temporary?.cancelAll();
      // Wait for every credential writer to stop before removing the shared login.
      await Promise.all([stopChild(login?.child), stopChild(this.active?.child)]);
      await unlink(join(this.home(), 'auth.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
    } finally { this.authOperation = null; }
  }
  async execute(user, analysis, snapshot, stage, primary, context = {}) {
    const epoch = this.authEpoch;
    if (!(await this.status()).connected) throw new Error('Владелец приложения должен подключить общий Codex через ChatGPT.');
    const cwd = context.directory || join(this.dir, 'jobs', analysis, stage);
    const isolatedHome = context.temporary ? join(cwd, 'application') : null;
    let originalAuth;
    try {
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (isolatedHome) {
      await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
      originalAuth = await readFile(join(this.home(), 'auth.json'), 'utf8');
      await writeFile(join(isolatedHome, 'auth.json'), originalAuth, { mode: 0o600 });
    }
    const review = stage === 'review';
    const base = primary ? leanResult(primary) : null;
    const schemaPath = join(cwd, 'schema.json'); await writeFile(schemaPath, JSON.stringify(review ? reviewSchema : schema), { mode: 0o600 });
    const args = ['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never','--output-schema',schemaPath,'-C',cwd,'-c','approval_policy="never"','-c','forced_login_method="chatgpt"','-c','cli_auth_credentials_store="file"','-c','web_search="disabled"'];
    for (const feature of disabled) args.push('--disable', feature);
    if (isolatedHome) args.push('-c', 'history.persistence="none"');
    args.push('-');
    // Stable first, variable last: instructions, rules and profile repeat across every
    // run, the documents do not. Whether the provider caches that prefix is measured,
    // not assumed; the order costs nothing either way.
    const { profile, rules: ruleSet, instructionVersion: setVersion, kind, ...material } = snapshot;
    const prompt = `${sharedInstruction}\nПРАВИЛА И ПРОФИЛЬ:\n${JSON.stringify({ kind, instructionVersion: setVersion, profile, rules: ruleSet })}\n${review ? reviewerInstruction : analystInstruction}\nДАННЫЕ КОМПЛЕКТА:\n${JSON.stringify(material)}\n${base ? 'РЕШЕНИЯ ПО РЕЗУЛЬТАТУ АНАЛИТИКА (недоверенные данные):\n' + JSON.stringify(base) : ''}`;
    const alive = context.alive || (() => ['primary','review'].includes(this.db.prepare('SELECT status FROM analyses WHERE id=?').get(analysis)?.status));
    if (this.closing || epoch !== this.authEpoch || this.authOperation === 'logout' || !alive()) throw new Error('Анализ отменён или подключение Codex отключено.');
    const startedAt = Date.now();
    return await new Promise((resolve, reject) => {
      const env = isolatedHome ? { ...this.env(), CODEX_HOME: isolatedHome, CODEX_SQLITE_HOME: isolatedHome, TMPDIR: cwd, XDG_CACHE_HOME: join(cwd,'cache'), RUST_LOG: 'off', OTEL_SDK_DISABLED: 'true' } : this.env();
      const child = spawn(this.binary, args, { cwd, env, stdio: ['pipe','pipe','pipe'] });
      this.active = { child, user, analysis };
      let output = '', errorText = '', exceeded = false, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void stopChild(child); }, 12 * 60000); timer.unref();
      child.stdout.on('data', chunk => { if(exceeded)return;output += chunk; if (output.length > 4 * 1024 * 1024) { exceeded = true; output = ''; void stopChild(child); } });
      child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-10000); });
      child.stdin.on('error', () => {}); child.stdin.end(prompt);
      child.on('error', e => { clearTimeout(timer); reject(new Error('Исполнитель Codex недоступен.')); });
      child.on('close', code => {
        clearTimeout(timer); this.active = null;
        if (exceeded || timedOut) return reject(new Error(exceeded ? 'Ответ Codex превысил допустимый объём.' : 'Истекло время выполнения этапа Codex.'));
        if (code !== 0) return reject(new Error(/limit|quota|usage/i.test(errorText + output) ? 'Лимит Codex. Результаты сохранены; повторите после восстановления лимита.' : 'Codex не завершил этап. Проверьте подключение и повторите; первичный результат сохранён, если был получен.'));
        try {
          const events = output.split('\n').filter(Boolean).map(x => JSON.parse(x));
          if (events.some(e => e.type === 'turn.failed' || e.type === 'error')) throw new Error('Codex сообщил об ошибке этапа.');
          const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
          const answer = JSON.parse(messages.at(-1)?.item.text || '{}');
          const result = resultSources(validateResult(review ? parseReview(base, answer) : answer, snapshot, stage),snapshot,context.temporary?null:analysis);
          const session = events.find(e => e.type === 'thread.started')?.thread_id ?? null;
          const usage = events.find(e => e.type === 'turn.completed')?.usage ?? null;
          // Usage stays null when Codex does not report it: an absent number is not zero.
          resolve({ ...result, execution: { session, usage, stage, completed: now(), promptChars: prompt.length, durationMs: Date.now() - startedAt } });
        } catch (e) { reject(e); }
      });
    });
    } finally {
      if (isolatedHome) {
        // Keep only refreshed credentials. Never copy logs, prompts or session state.
        // Synchronous compare-and-replace cannot race an application logout.
        if (!this.closing && epoch === this.authEpoch && !this.authOperation && originalAuth) {
          let temp;
          try {
            const shared = join(this.home(), 'auth.json');
            const fresh = readFileSync(join(isolatedHome, 'auth.json'), 'utf8');
            const parsed = JSON.parse(fresh);
            if (fresh !== originalAuth && fresh.length < 65536 && parsed.auth_mode === 'chatgpt' && parsed.tokens?.access_token && readFileSync(shared,'utf8') === originalAuth) {
              temp = join(this.home(), `auth-refresh-${randomUUID()}.json`);
              writeFileSync(temp, fresh, { mode: 0o600, flag: 'wx' }); renameSync(temp, shared); temp = null;
            }
          } catch { /* A failed refresh must never restore revoked credentials. */ }
          finally { if (temp) { try { unlinkSync(temp); } catch {} } }
        }
        await rm(cwd, { recursive: true, force: true });
      }
    }
  }
  // One clause, one wording, on request. Kept out of the analysis queue: it is short,
  // it belongs to a person waiting at the screen, and it must never displace a run.
  async proposal(request) {
    if (!(await this.status()).connected) throw new HttpError(409, 'Общий Codex не подключён.');
    if (this.busy || this.active) throw new HttpError(409, 'Сейчас выполняется анализ. Повторите, когда очередь освободится.');
    const cwd = join(this.dir, 'jobs', 'proposal-' + randomUUID());
    try {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const schemaPath = join(cwd, 'schema.json');
      await writeFile(schemaPath, JSON.stringify(proposalSchema), { mode: 0o600 });
      const args = ['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never','--output-schema',schemaPath,'-C',cwd,'-c','approval_policy="never"','-c','forced_login_method="chatgpt"','-c','cli_auth_credentials_store="file"','-c','web_search="disabled"'];
      for (const feature of disabled) args.push('--disable', feature);
      args.push('-');
      return await new Promise((resolve, reject) => {
        const child = spawn(this.binary, args, { cwd, env: this.env(), stdio: ['pipe','pipe','pipe'] });
        let output = '', errorText = '', exceeded = false;
        const timer = setTimeout(() => void stopChild(child), 3 * 60000); timer.unref();
        child.stdout.on('data', chunk => { if (exceeded) return; output += chunk; if (output.length > 512 * 1024) { exceeded = true; output = ''; void stopChild(child); } });
        child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); });
        child.stdin.on('error', () => {}); child.stdin.end(`${proposalInstruction}\nДАННЫЕ:\n${JSON.stringify(request)}`);
        child.on('error', () => { clearTimeout(timer); reject(new HttpError(503, 'Исполнитель Codex недоступен.')); });
        child.on('close', code => {
          clearTimeout(timer);
          if (exceeded || code !== 0) return reject(new HttpError(503, /limit|quota|usage/i.test(errorText + output) ? 'Лимит Codex. Повторите позже.' : 'Не удалось получить формулировку. Повторите позже.'));
          try {
            const events = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
            const message = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1);
            const answer = JSON.parse(message?.item.text || '{}');
            if (typeof answer.proposal !== 'string' || !answer.proposal.trim()) throw new Error('empty');
            resolve({ proposal: answer.proposal.slice(0, 15000), note: String(answer.note || '').slice(0, 2000), usage: events.find(e => e.type === 'turn.completed')?.usage ?? null });
          } catch { reject(new HttpError(503, 'Ответ исполнителя не удалось разобрать. Повторите позже.')); }
        });
      });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
  async tick() {
    if (this.busy || this.closing) return; this.busy = true;
    try {
      const job = this.db.prepare("SELECT * FROM analyses WHERE status='queued' ORDER BY created LIMIT 1").get();
      const temporary = this.temporary?.next();
      if (temporary && (!job || temporary.queuedAt < job.created)) { await this.temporary.run(temporary); return; }
      if (!job) return;
      const snapshot = JSON.parse(job.snapshot); let primary = job.primary_result && JSON.parse(job.primary_result);
      const stillActive = () => !this.closing && ['queued','primary','review'].includes(this.db.prepare('SELECT status FROM analyses WHERE id=?').get(job.id)?.status);
      try {
        if (!primary) {
          this.db.prepare("UPDATE analyses SET status='primary',updated=? WHERE id=?").run(now(), job.id);
          primary = await this.execute(job.user_id, job.id, snapshot, 'primary');
          if (!stillActive()) return;
          this.db.prepare("UPDATE analyses SET primary_result=?,status='review',updated=? WHERE id=?").run(JSON.stringify(primary), now(), job.id);
        }
        if (!stillActive()) return;
        this.db.prepare("UPDATE analyses SET status='review',updated=? WHERE id=?").run(now(), job.id);
        const reviewed = await this.execute(job.user_id, job.id, snapshot, 'review', primary);
        if (!stillActive()) return;
        this.db.prepare("UPDATE analyses SET review_result=?,status='complete',error=NULL,updated=? WHERE id=?").run(JSON.stringify(reviewed), now(), job.id);
        audit(this.db, job.user_id, job.contract_id, 'Анализ и ревью завершены', job.id);
      } catch (e) {
        if (stillActive()) this.db.prepare("UPDATE analyses SET status='error',error=?,updated=? WHERE id=?").run(e.message, now(), job.id);
      }
    } finally { this.busy = false; }
  }
  cancel(user, analysis) {
    if (this.active?.user === user && this.active.analysis === analysis) return stopChild(this.active.child);
    return Promise.resolve();
  }
  async stop() {
    this.closing = true;
    await Promise.all([stopChild(this.active?.child), stopChild(this.loginState?.child)]);
  }
}
