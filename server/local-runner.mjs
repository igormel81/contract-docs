import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { CodexRunner } from './codex.mjs';
import { LocalModelProvider, LocalProviderError } from './model-providers/local.mjs';
import { analysisRequest, proposalRequest } from './model-request.mjs';
import { validateResult, parseReview, proposalSchema } from './schema.mjs';
import { resultSources } from './sources.mjs';
import { HttpError } from './security.mjs';
import { now } from './db.mjs';

const identityKeys = ['provider', 'profile', 'model', 'modelRevision', 'tokenizerRevision', 'chatTemplateSha256', 'contextWindow'];
const activeStatus = status => ['queued', 'primary', 'review'].includes(status);
const proposalValid = new Ajv({ strict: true }).compile(proposalSchema);
const cancelled = () => new LocalProviderError('cancelled', 499);
const sanitized = error => error instanceof LocalProviderError || error instanceof HttpError ? error : new HttpError(503, 'Локальный ответ не получен или не прошёл проверку. Исходный результат сохранён, если был получен.');

// Only the existing tick() scheduler and restart marking are inherited. Every
// method that could touch credentials, spawn a process or search the web is
// overridden; this runner never enters Codex execution/authentication methods.
export class LocalRunner extends CodexRunner {
  #provider; #identity; #limits; #enabled = true;
  constructor(db, dir, config, options = {}) {
    // Validate configuration before the inherited startup state transition.
    const provider = options.provider || new LocalModelProvider(config);
    const description = provider.describe();
    if (description.provider !== 'local' || identityKeys.some(key => description[key] === undefined)) throw new HttpError(500, 'Не задана закреплённая конфигурация локального исполнителя.');
    const limits = {
      primary: config.maxOutputTokens?.primary ?? 8192,
      review: config.maxOutputTokens?.review ?? 8192,
      proposal: config.maxOutputTokens?.proposal ?? 4096,
      timeout: config.timeoutMs ?? 12 * 60_000,
    };
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)
      || limits.timeout > 30 * 60_000) throw new HttpError(500, 'Некорректные лимиты локального исполнителя.');
    super(db, dir, 'LOCAL_NO_PROCESS');
    this.#provider = provider; this.#identity = Object.freeze({ ...description }); this.#limits = Object.freeze(limits);
  }
  describe() { return { ...this.#identity }; }
  #assertPin(pin) {
    if (!pin || identityKeys.some(key => pin[key] !== this.#identity[key])) throw new HttpError(409, 'Провайдер или модель не совпадают с закреплённой конфигурацией анализа. Создайте новый анализ с выбранным исполнителем.');
  }
  home() { throw new HttpError(409, 'Локальный исполнитель не использует хранилище авторизации Codex.'); }
  env() { return {}; }
  async initLookup() { /* No lookup directories, processes or internet in local mode. */ }
  async login() { throw new HttpError(409, 'Локальную модель настраивает администратор установки; вход Codex здесь не используется.'); }
  async organizationLookup() { throw new HttpError(409, 'Интернет-поиск организации недоступен в локальном режиме. Заполните карточку вручную.'); }
  async status(canManage = false) {
    const base = { scope: 'application', provider: 'local', method: 'Local', canManage, login: null, model: this.#identity.model, inference: this.describe() };
    if (this.closing || !this.#enabled) return { ...base, connected: false, state: 'disconnected' };
    try {
      const health = await this.#provider.health();
      if (!health?.ready || this.closing || !this.#enabled) return { ...base, connected: false, state: 'disconnected' };
      if (health.modelRevision !== this.#identity.modelRevision) return { ...base, connected: false, state: 'error', error: 'Локальный сервер сообщает другую конфигурацию модели.' };
      return { ...base, connected: true, state: 'connected', revisionsAttested: false, generationProbed: health.generationProbed === true };
    } catch (error) { return { ...base, connected: false, state: 'error', error: sanitized(error).message }; }
  }
  async #operation(user, analysis, stage, alive, action) {
    if (this.active) throw new HttpError(409, 'Сейчас выполняется локальный запрос. Повторите позже.');
    if (this.closing || !this.#enabled || !alive()) throw cancelled();
    const controller = new AbortController(); let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const active = { user, analysis, stage, controller, done }; this.active = active;
    const timeoutMs = stage === 'proposal' ? Math.min(180_000, this.#limits.timeout) : this.#limits.timeout;
    const timer = setTimeout(() => controller.abort(new LocalProviderError('timeout', 504)), timeoutMs); timer.unref();
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
        if (!(await this.status()).connected) throw new HttpError(503, 'Локальная модель недоступна. Проверьте настройки внутреннего сервера.');
        assertActive();
        const result = await action(controller.signal, timeoutMs, assertActive);
        assertActive(); return result;
      }), abort]);
    } catch (error) { throw sanitized(error); }
    finally { clearTimeout(timer); if (this.active === active) this.active = null; finish(); }
  }
  async execute(user, analysis, snapshot, stage, primary = null, context = {}) {
    if (!['primary', 'review'].includes(stage)) throw new HttpError(409, 'Этот тип запроса не поддерживается локальным анализом.');
    this.#assertPin(snapshot?.inference);
    if (stage === 'review') this.#assertPin(primary?.execution?.inference);
    const descriptor = analysisRequest(snapshot, stage, primary);
    if (!descriptor.instructions || descriptor.data === undefined) throw new HttpError(500, 'Не сформирован полный запрос локального этапа.');
    const alive = context.alive || (() => activeStatus(this.db.prepare('SELECT status FROM analyses WHERE id=?').get(analysis)?.status));
    return this.#operation(user, analysis, stage, alive, async (signal, timeoutMs, assertActive) => {
      const attemptId = randomUUID(), startedAt = Date.now();
      const answer = await this.#provider.generate({ runId: analysis, attemptId, stage, instructions: descriptor.instructions, data: descriptor.data,
        jsonSchema: descriptor.schema, model: this.#identity.model, maxOutputTokens: this.#limits[stage], timeoutMs, signal, temporary: Boolean(context.temporary) });
      assertActive();
      if (answer.modelRevision !== this.#identity.modelRevision) throw new LocalProviderError('model_mismatch');
      const result = resultSources(validateResult(stage === 'review' ? parseReview(descriptor.base, answer.json) : answer.json, snapshot, stage), snapshot, context.temporary ? null : analysis);
      const usage = answer.usage ? { input_tokens: answer.usage.inputTokens, output_tokens: answer.usage.outputTokens } : null;
      return { ...result, execution: { session: attemptId, attemptId, provider: 'local', model: this.#identity.model,
        modelRevision: this.#identity.modelRevision, inference: this.describe(), stage, completed: now(), usage,
        inputTokens: answer.inputTokens ?? null, durationMs: Date.now() - startedAt,
        // This is an informational size, never used for context admission.
        promptChars: descriptor.instructions.length + JSON.stringify(descriptor.data).length + JSON.stringify(descriptor.schema).length,
        revisionsAttested: false } };
    });
  }
  async proposal(request) {
    if (this.busy || this.active || this.closing) throw new HttpError(409, 'Сейчас выполняется локальный запрос. Повторите, когда очередь освободится.');
    this.#assertPin(request?.inference);
    const descriptor = proposalRequest(request); this.busy = true;
    try {
      return await this.#operation(null, 'proposal', 'proposal', () => !this.closing && this.#enabled, async (signal, timeoutMs, assertActive) => {
        const attemptId = randomUUID();
        const answer = await this.#provider.generate({ runId: 'proposal', attemptId, stage: 'proposal', instructions: descriptor.instructions, data: descriptor.data,
          jsonSchema: descriptor.schema, model: this.#identity.model, maxOutputTokens: this.#limits.proposal, timeoutMs, signal, temporary: Boolean(request.temporary) });
        assertActive();
        if (answer.modelRevision !== this.#identity.modelRevision) throw new LocalProviderError('model_mismatch');
        if (!proposalValid(answer.json) || !answer.json.proposal.trim()) throw new LocalProviderError('schema_error');
        return { ...answer.json, usage: answer.usage ? { input_tokens: answer.usage.inputTokens, output_tokens: answer.usage.outputTokens } : null,
          execution: { provider: 'local', model: this.#identity.model, modelRevision: this.#identity.modelRevision, inference: this.describe(), session: attemptId, stage: 'proposal' } };
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
    this.db.prepare("UPDATE analyses SET status='cancelled',error='Локальный исполнитель отключён',updated=? WHERE status IN ('queued','primary','review')").run(now());
    const temporary = [...(this.temporary?.items?.values() || [])].filter(item => activeStatus(item.status));
    this.temporary?.cancelAll();
    for (const item of temporary) item.error = 'Локальный исполнитель отключён. Создайте новую проверку после подключения.';
    const active = this.active;
    if (active) { active.controller.abort(cancelled()); await active.done; }
  }
}
