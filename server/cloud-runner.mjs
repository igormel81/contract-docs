import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { CodexRunner } from './codex.mjs';
import { analysisRequest, proposalRequest } from './model-request.mjs';
import { validateResult, validateQualifications, parseReview, proposalSchema } from './schema.mjs';
import { resultSources } from './sources.mjs';
import { HttpError } from './security.mjs';
import { now } from './db.mjs';

// Cloud vendors (OpenAI, DeepSeek, Kimi, Anthropic) manage their own weights,
// tokenizer and prompt template server-side: unlike the local/self-hosted
// runner there is nothing to pin beyond the advertised provider label and
// model id. A vendor-specific provider class (server/model-providers/*) does
// the actual HTTP call; this runner only owns the queue/pin/cancel contract
// shared by every non-Codex executor.
const identityKeys = ['provider', 'model'];
const activeStatus = status => ['queued', 'qualification', 'primary', 'contract_risks', 'legal_modules', 'review'].includes(status);
const proposalValid = new Ajv({ strict: true }).compile(proposalSchema);
const providerError = (code, status, message) => Object.assign(new Error(message), { code, status });
const cancelled = () => providerError('cancelled', 499, 'Облачный запрос отменён.');
// Any vendor provider file may define its own error class; we only require
// the shape (code/status/message), so CloudRunner never has to import or
// know about server/model-providers/openai-compatible.mjs or anthropic.mjs.
const wellFormed = error => Boolean(error) && typeof error.status === 'number' && typeof error.code === 'string' && typeof error.message === 'string';
const sanitized = error => wellFormed(error) || error instanceof HttpError ? error : new HttpError(503, 'Облачный ответ не получен или не прошёл проверку. Исходный результат сохранён, если был получен.');

// Only the existing tick() scheduler and restart marking are inherited. Every
// method that could touch credentials, spawn a process or search the web is
// overridden; this runner never enters Codex execution/authentication methods.
export class CloudRunner extends CodexRunner {
  #provider; #identity; #limits; #enabled = true;
  constructor(db, dir, provider, config = {}) {
    // Validate configuration before the inherited startup state transition.
    const description = provider?.describe?.();
    if (!description || typeof description.provider !== 'string' || description.provider === 'local' || identityKeys.some(key => description[key] === undefined)) {
      throw new HttpError(500, 'Не задана закреплённая конфигурация облачного исполнителя.');
    }
    const limits = {
      qualification: config.maxOutputTokens?.qualification ?? 8192,
      primary: config.maxOutputTokens?.primary ?? 8192,
      review: config.maxOutputTokens?.review ?? 8192,
      proposal: config.maxOutputTokens?.proposal ?? 4096,
      timeout: config.timeoutMs ?? 12 * 60_000,
    };
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)
      || limits.timeout > 30 * 60_000) throw new HttpError(500, 'Некорректные лимиты облачного исполнителя.');
    super(db, dir, 'CLOUD_NO_PROCESS');
    this.#provider = provider; this.#identity = Object.freeze({ ...description }); this.#limits = Object.freeze(limits);
  }
  describe() { return { ...this.#identity }; }
  #assertPin(pin) {
    if (!pin || identityKeys.some(key => pin[key] !== this.#identity[key])) throw new HttpError(409, 'Провайдер или модель не совпадают с закреплённой конфигурацией анализа. Создайте новый анализ с выбранным исполнителем.');
  }
  capabilities() {
    return { provider: this.#identity.provider, label: `Облачный провайдер (${this.#identity.provider})`, organizationLookup: false, external: true,
      offline: 'Облачный провайдер недоступен.', recovery: 'Проверьте настройки провайдера или обратитесь к администратору установки.' };
  }
  home() { throw new HttpError(409, 'Облачный исполнитель не использует хранилище авторизации Codex.'); }
  env() { return {}; }
  async initLookup() { /* No lookup directories, processes or internet-search tool in cloud mode. */ }
  async login() { throw new HttpError(409, 'Облачного провайдера настраивает администратор установки; вход Codex здесь не используется.'); }
  async organizationLookup() { throw new HttpError(409, 'Интернет-поиск организации недоступен в облачном режиме. Заполните карточку вручную.'); }
  async status(canManage = false) {
    const base = { scope: 'application', provider: this.#identity.provider, method: 'Cloud', canManage, login: null, model: this.#identity.model, inference: this.describe() };
    if (this.closing || !this.#enabled) return { ...base, connected: false, state: 'disconnected' };
    try {
      const health = await this.#provider.health();
      if (!health?.ready || this.closing || !this.#enabled) return { ...base, connected: false, state: 'disconnected' };
      return { ...base, connected: true, state: 'connected', revisionsAttested: false, generationProbed: health.generationProbed === true };
    } catch (error) { return { ...base, connected: false, state: 'error', error: sanitized(error).message }; }
  }
  async #operation(user, analysis, stage, alive, action) {
    if (this.active) throw new HttpError(409, 'Сейчас выполняется облачный запрос. Повторите позже.');
    if (this.closing || !this.#enabled || !alive()) throw cancelled();
    const controller = new AbortController(); let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const active = { user, analysis, stage, controller, done }; this.active = active;
    const timeoutMs = stage === 'proposal' ? Math.min(180_000, this.#limits.timeout) : this.#limits.timeout;
    const timer = setTimeout(() => controller.abort(providerError('timeout', 504, 'Истекло время выполнения облачного этапа.')), timeoutMs); timer.unref();
    const assertActive = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.closing || !this.#enabled || !alive()) throw cancelled();
    };
    try {
      // Independently race the provider: an injected/failed implementation cannot
      // make cancellation await a result forever or publish a late response.
      const abort = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
      return await Promise.race([Promise.resolve().then(async () => {
        assertActive();
        if (!(await this.status()).connected) throw new HttpError(503, 'Облачный провайдер недоступен. Проверьте ключ и настройки подключения.');
        assertActive();
        const result = await action(controller.signal, timeoutMs, assertActive);
        assertActive(); return result;
      }), abort]);
    } catch (error) { throw sanitized(error); }
    finally { clearTimeout(timer); if (this.active === active) this.active = null; finish(); }
  }
  async execute(user, analysis, snapshot, stage, primary = null, context = {}) {
    if (!['qualification', 'primary', 'review'].includes(stage)) throw new HttpError(409, 'Этот тип запроса не поддерживается облачным анализом.');
    this.#assertPin(snapshot?.inference);
    if (stage === 'review') this.#assertPin(primary?.execution?.inference);
    const descriptor = analysisRequest(snapshot, stage, primary, context.preliminaryQualifications);
    if (!descriptor.instructions || descriptor.data === undefined) throw new HttpError(500, 'Не сформирован полный запрос облачного этапа.');
    const alive = context.alive || (() => activeStatus(this.db.prepare('SELECT status FROM analyses WHERE id=?').get(analysis)?.status));
    return this.#operation(user, analysis, stage, alive, async (signal, timeoutMs, assertActive) => {
      const attemptId = randomUUID(), startedAt = Date.now();
      const answer = await this.#provider.generate({ runId: analysis, attemptId, stage, instructions: descriptor.instructions, data: descriptor.data,
        jsonSchema: descriptor.schema, model: this.#identity.model, maxOutputTokens: this.#limits[stage], timeoutMs, signal, temporary: Boolean(context.temporary) });
      assertActive();
      if (answer.model && answer.model !== this.#identity.model) throw providerError('model_mismatch', 409, 'Провайдер вернул ответ от другой модели.');
      if (stage === 'qualification') return validateQualifications(answer.json, snapshot);
      const result = resultSources(validateResult(stage === 'review' ? parseReview(descriptor.base, answer.json) : answer.json, snapshot, stage), snapshot, context.temporary ? null : analysis);
      const usage = answer.usage ? { input_tokens: answer.usage.inputTokens, output_tokens: answer.usage.outputTokens } : null;
      return { ...result, execution: { session: attemptId, attemptId, provider: this.#identity.provider, model: this.#identity.model,
        inference: this.describe(), stage, completed: now(), usage, inputTokens: answer.inputTokens ?? null, durationMs: Date.now() - startedAt,
        // This is an informational size, never used for context admission.
        promptChars: descriptor.instructions.length + JSON.stringify(descriptor.data).length + JSON.stringify(descriptor.schema).length,
        revisionsAttested: false } };
    });
  }
  async proposal(request) {
    if (this.busy || this.active || this.closing) throw new HttpError(409, 'Сейчас выполняется облачный запрос. Повторите, когда очередь освободится.');
    this.#assertPin(request?.inference);
    const descriptor = proposalRequest(request); this.busy = true;
    try {
      return await this.#operation(null, 'proposal', 'proposal', () => !this.closing && this.#enabled, async (signal, timeoutMs, assertActive) => {
        const attemptId = randomUUID();
        const answer = await this.#provider.generate({ runId: 'proposal', attemptId, stage: 'proposal', instructions: descriptor.instructions, data: descriptor.data,
          jsonSchema: descriptor.schema, model: this.#identity.model, maxOutputTokens: this.#limits.proposal, timeoutMs, signal, temporary: Boolean(request.temporary) });
        assertActive();
        if (answer.model && answer.model !== this.#identity.model) throw providerError('model_mismatch', 409, 'Провайдер вернул ответ от другой модели.');
        if (!proposalValid(answer.json) || !answer.json.proposal.trim()) throw providerError('schema_error', 502, 'Ответ облачного провайдера не соответствует ожидаемой структуре.');
        return { ...answer.json, usage: answer.usage ? { input_tokens: answer.usage.inputTokens, output_tokens: answer.usage.outputTokens } : null,
          execution: { provider: this.#identity.provider, model: this.#identity.model, inference: this.describe(), session: attemptId, stage: 'proposal' } };
      });
    } finally { this.busy = false; }
  }
  async cancel(user, analysis) {
    const active = this.active;
    if (active?.user !== user || active?.analysis !== analysis) return;
    active.controller.abort(cancelled()); await active.done;
  }
  async stop() {
    this.closing = true;
    const active = this.active;
    if (active) { active.controller.abort(cancelled()); await active.done; }
  }
  async logout() {
    this.#enabled = false; this.authEpoch++;
    this.db.prepare("UPDATE analyses SET status='cancelled',error='Облачный исполнитель отключён',updated=? WHERE status IN ('queued','qualification','primary','contract_risks','legal_modules','review')").run(now());
    const temporary = [...(this.temporary?.items?.values() || [])].filter(item => activeStatus(item.status));
    this.temporary?.cancelAll();
    for (const item of temporary) item.error = 'Облачный исполнитель отключён. Создайте новую проверку после подключения.';
    const active = this.active;
    if (active) { active.controller.abort(cancelled()); await active.done; }
  }
}
