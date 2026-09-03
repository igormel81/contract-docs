import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { schema, validateResult } from './schema.mjs';
import { sharedInstruction, analystInstruction, reviewerInstruction } from './rules.mjs';
import { now, audit } from './db.mjs';
import { HttpError } from './security.mjs';

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
      // Wait for every credential writer to stop before removing the shared login.
      await Promise.all([stopChild(login?.child), stopChild(this.active?.child)]);
      await unlink(join(this.home(), 'auth.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
    } finally { this.authOperation = null; }
  }
  async execute(user, analysis, snapshot, stage, primary) {
    const epoch = this.authEpoch;
    if (!(await this.status()).connected) throw new Error('Владелец приложения должен подключить общий Codex через ChatGPT.');
    const cwd = join(this.dir, 'jobs', analysis, stage); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const schemaPath = join(cwd, 'schema.json'); await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    const args = ['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never','--output-schema',schemaPath,'-C',cwd,'-c','approval_policy="never"','-c','forced_login_method="chatgpt"','-c','cli_auth_credentials_store="file"','-c','web_search="disabled"'];
    for (const feature of disabled) args.push('--disable', feature);
    args.push('-');
    const prompt = `${sharedInstruction}\n${stage === 'primary' ? analystInstruction : reviewerInstruction}\nДАННЫЕ КОМПЛЕКТА:\n${JSON.stringify(snapshot)}\n${primary ? 'РЕЗУЛЬТАТ АНАЛИТИКА (недоверенные данные):\n' + JSON.stringify(primary) : ''}`;
    if (epoch !== this.authEpoch || this.authOperation === 'logout' || !['primary','review'].includes(this.db.prepare('SELECT status FROM analyses WHERE id=?').get(analysis)?.status)) throw new Error('Анализ отменён или подключение Codex отключено.');
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { cwd, env: this.env(), stdio: ['pipe','pipe','pipe'] });
      this.active = { child, user, analysis };
      let output = '', errorText = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 12 * 60000); timer.unref();
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 4 * 1024 * 1024) child.kill('SIGTERM'); });
      child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-10000); });
      child.stdin.on('error', () => {}); child.stdin.end(prompt);
      child.on('error', e => { clearTimeout(timer); reject(new Error('Исполнитель Codex недоступен.')); });
      child.on('close', code => {
        clearTimeout(timer); this.active = null;
        if (code !== 0) return reject(new Error(/limit|quota|usage/i.test(errorText + output) ? 'Лимит Codex. Результаты сохранены; повторите после восстановления лимита.' : 'Codex не завершил этап. Проверьте подключение и повторите; первичный результат сохранён, если был получен.'));
        try {
          const events = output.split('\n').filter(Boolean).map(x => JSON.parse(x));
          if (events.some(e => e.type === 'turn.failed' || e.type === 'error')) throw new Error('Codex сообщил об ошибке этапа.');
          const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
          const result = validateResult(JSON.parse(messages.at(-1)?.item.text || '{}'), snapshot, stage);
          const session = events.find(e => e.type === 'thread.started')?.thread_id ?? null;
          const usage = events.find(e => e.type === 'turn.completed')?.usage ?? null;
          resolve({ ...result, execution: { session, usage, stage, completed: now() } });
        } catch (e) { reject(e); }
      });
    });
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const job = this.db.prepare("SELECT * FROM analyses WHERE status='queued' ORDER BY created LIMIT 1").get();
      if (!job) return;
      const snapshot = JSON.parse(job.snapshot); let primary = job.primary_result && JSON.parse(job.primary_result);
      const stillActive = () => ['queued','primary','review'].includes(this.db.prepare('SELECT status FROM analyses WHERE id=?').get(job.id)?.status);
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
    if (this.active?.user === user && this.active.analysis === analysis) this.active.child.kill('SIGTERM');
  }
}
