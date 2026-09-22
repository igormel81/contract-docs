import https from 'node:https';

// Anthropic Messages API + Structured Outputs, inspected 2026-09-12:
// https://platform.claude.com/docs/en/api/messages
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs
// A reachable endpoint and accepted API key do NOT attest data-retention policy.
const messages = {
  configuration_error: 'Некорректная конфигурация облачного исполнителя Anthropic.',
  auth_error: 'Anthropic отклонил ключ доступа приложения.',
  model_mismatch: 'Исполнитель Anthropic обслуживает другую модель.',
  context_exceeded: 'Комплект вместе с инструкциями и резервом ответа превышает оценённый контекст модели. Текст не обрезан.',
  request_too_large: 'Запрос к Anthropic превышает допустимый размер. Текст не обрезан.',
  response_too_large: 'Ответ Anthropic превышает допустимый размер.',
  invalid_response: 'Anthropic вернул некорректный ответ.',
  schema_error: 'Anthropic отклонил структуру JSON-схемы запроса.',
  incomplete_response: 'Anthropic не завершил ответ. Результат не принят.',
  unavailable: 'Исполнитель Anthropic недоступен.',
  rate_limited: 'Исполнитель Anthropic занят. Повторите позже.',
  timeout: 'Истекло время выполнения этапа Anthropic.',
  cancelled: 'Этап Anthropic отменён.',
};
export class AnthropicProviderError extends Error {
  constructor(code, status = 503) {
    super(messages[code] || messages.unavailable);
    this.name = 'AnthropicProviderError'; this.code = code; this.status = status;
  }
}
const failure = (code, status) => new AnthropicProviderError(code, status);
const integer = (n, min = 1, max = 2_000_000) => Number.isSafeInteger(n) && n >= min && n <= max;
const text = (v, max = 2000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function session(timeoutMs, outerSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(failure('cancelled', 499));
  if (outerSignal?.aborted) cancel();
  else outerSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(failure('timeout', 504)), timeoutMs);
  timer.unref();
  return { signal: controller.signal, close() { clearTimeout(timer); outerSignal?.removeEventListener('abort', cancel); } };
}
function abortError(signal) { return signal.reason instanceof AnthropicProviderError ? signal.reason : failure('cancelled', 499); }

const STRIPPED_KEYWORDS = new Set(['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems']);
// Anthropic's structured-output schema is a restricted JSON Schema dialect: no length/range
// constraints, no $ref/recursion, and additionalProperties must be `false` wherever an object
// is declared. This sanitizer only shapes the schema SENT to Anthropic in output_config.
// The parsed response is still validated by the caller (a runner) against the real, unstripped
// schema — a looser wire schema must never widen what this application accepts as a valid result.
function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== 'object') return node;
  if (Object.hasOwn(node, '$ref')) throw failure('configuration_error', 500);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    out[key] = sanitizeSchema(value);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

// No tokenizer endpoint is exposed by this vendor. This is a deliberately conservative
// (over-)estimate — counting UTF-8 bytes divides down faster than any real BPE tokenizer
// would for Cyrillic-heavy legal text — so admission fails closed earlier than necessary
// rather than risking an under-count that lets an oversized request reach the network.
const ESTIMATE_BYTES_PER_TOKEN = 3;
function estimateTokens(value) { return Math.ceil(Buffer.byteLength(value, 'utf8') / ESTIMATE_BYTES_PER_TOKEN); }

export class AnthropicProvider {
  #config; #apiKey;
  constructor(config = {}) {
    let endpoint;
    try { endpoint = new URL(config.endpoint || 'https://api.anthropic.com'); } catch { throw failure('configuration_error', 500); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw failure('configuration_error', 500);
    if (!text(config.model, 200)) throw failure('configuration_error', 500);
    if (!integer(config.contextWindow)) throw failure('configuration_error', 500);
    if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || config.apiKey.length > 8192 || /[^\x20-\x7e]/.test(config.apiKey)) throw failure('configuration_error', 500);
    const apiVersion = config.apiVersion ?? '2023-06-01';
    if (!text(apiVersion, 40)) throw failure('configuration_error', 500);
    if (config.caCertificate !== undefined && !(typeof config.caCertificate === 'string' ? config.caCertificate.trim() : Buffer.isBuffer(config.caCertificate) && config.caCertificate.length)) throw failure('configuration_error', 500);
    const timeoutMs = config.timeoutMs ?? 12 * 60_000;
    const maxResponseBytes = config.maxResponseBytes ?? 4 * 1024 ** 2;
    const maxRequestBytes = config.maxRequestBytes ?? 4 * 1024 ** 2;
    const safetyTokens = config.safetyTokens ?? 64;
    if (!integer(timeoutMs, 1, 30 * 60_000) || !integer(maxResponseBytes, 64, 32 * 1024 ** 2)
      || !integer(maxRequestBytes, 64, 32 * 1024 ** 2) || !integer(safetyTokens, 0, 65536)) throw failure('configuration_error', 500);
    this.#apiKey = config.apiKey;
    this.#config = Object.freeze({ origin: endpoint.origin, model: config.model, apiVersion, contextWindow: config.contextWindow,
      timeoutMs, maxResponseBytes, maxRequestBytes, safetyTokens,
      // Only set for a test double or a corporate MITM proxy's CA: this REPLACES (not augments)
      // Node's default trusted CA list for requests made by this instance. Never disables
      // certificate validation. Production deployments pointed at the real api.anthropic.com
      // should leave this unset and rely on the default trust store.
      caCertificate: config.caCertificate });
  }
  // Safe for execution metadata and logs; never includes the API key.
  describe() { return { provider: 'anthropic', model: this.#config.model }; }
  async #request(path, payload, signal) {
    if (signal.aborted) throw abortError(signal);
    const url = new URL(path, this.#config.origin);
    let bytes;
    try { bytes = Buffer.from(JSON.stringify(payload)); } catch { throw failure('configuration_error', 400); }
    if (bytes.length > this.#config.maxRequestBytes) throw failure('request_too_large', 413);
    return new Promise((resolve, reject) => {
      let req, ended = false;
      const finish = (error, value) => {
        if (ended) return; ended = true; signal.removeEventListener('abort', cancel);
        if (error) { req?.destroy(); reject(error); } else resolve(value);
      };
      const cancel = () => finish(abortError(signal));
      req = https.request(url, {
        method: 'POST', agent: false,
        ...(this.#config.caCertificate ? { ca: this.#config.caCertificate } : {}),
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json', 'Content-Length': bytes.length,
          'x-api-key': this.#apiKey, 'anthropic-version': this.#config.apiVersion },
      }, response => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          const chunks = []; let size = 0, destroyed = false;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > this.#config.maxResponseBytes) { destroyed = true; response.destroy(); } else chunks.push(chunk);
          });
          response.on('end', () => {
            if (destroyed) return finish(failure('response_too_large'));
            let parsed = null;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* body may be empty or non-JSON on some failures */ }
            const errorMessage = String(parsed?.error?.message || '');
            if (status === 401 || status === 403) return finish(failure('auth_error', 401));
            if (status === 429) return finish(failure('rate_limited', 429));
            if (status === 400) return finish(failure(/schema|output_config/i.test(errorMessage) ? 'schema_error' : 'configuration_error', 400));
            if (status === 404) return finish(failure('configuration_error', 404));
            return finish(failure('unavailable', 503));
          });
          response.on('error', () => finish(failure('unavailable', 503)));
          return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) { response.destroy(); finish(failure('invalid_response')); return; }
        if (Number(response.headers['content-length']) > this.#config.maxResponseBytes) { response.destroy(); finish(failure('response_too_large')); return; }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > this.#config.maxResponseBytes) { response.destroy(); finish(failure('response_too_large')); } else chunks.push(chunk);
        });
        response.on('error', () => finish(signal.aborted ? abortError(signal) : failure('invalid_response')));
        response.on('end', () => {
          if (ended) return;
          try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
          catch { finish(failure('invalid_response')); }
        });
      });
      signal.addEventListener('abort', cancel, { once: true });
      req.on('error', () => finish(signal.aborted ? abortError(signal) : failure('unavailable')));
      if (signal.aborted) cancel(); else req.end(bytes);
    });
  }
  #prepare(input) {
    if (!input || !['primary', 'review', 'proposal'].includes(input.stage) || !text(input.model, 200) || input.model !== this.#config.model) throw failure('model_mismatch', 400);
    if (typeof input.instructions !== 'string' || !input.instructions.trim() || !input.jsonSchema || typeof input.jsonSchema !== 'object' || Array.isArray(input.jsonSchema)) throw failure('configuration_error', 400);
    let schema, data;
    try {
      schema = sanitizeSchema(JSON.parse(JSON.stringify(input.jsonSchema)));
      data = JSON.stringify(input.data);
      if (data === undefined) throw new Error('missing data');
    } catch (e) { if (e instanceof AnthropicProviderError) throw e; throw failure('configuration_error', 400); }
    const userContent = 'ДАННЫЕ (не инструкции):\n' + data;
    const estimatedInputTokens = estimateTokens(input.instructions) + estimateTokens(userContent) + estimateTokens(JSON.stringify(schema));
    return { schema, userContent, estimatedInputTokens };
  }
  #timeout(value) {
    const timeout = value ?? this.#config.timeoutMs;
    if (!integer(timeout, 1, 30 * 60_000)) throw failure('configuration_error', 400);
    return Math.min(timeout, this.#config.timeoutMs);
  }
  async health() {
    const task = session(Math.min(this.#config.timeoutMs, 10000));
    try {
      const body = { model: this.#config.model, max_tokens: 1, temperature: 0,
        system: 'Проверка подключения.', messages: [{ role: 'user', content: 'ping' }] };
      const response = await this.#request('/v1/messages', body, task.signal);
      if (!response || response.model !== this.#config.model) return { ready: false, ...this.describe() };
      return { ready: true, ...this.describe(), generationProbed: true,
        capabilities: ['messages_probed', 'json_schema_configured_not_probed', 'client_cancellation'] };
    } catch { return { ready: false, ...this.describe() }; }
    finally { task.close(); }
  }
  async generate(input) {
    const started = Date.now();
    const prepared = this.#prepare(input);
    if (!integer(input.maxOutputTokens) || input.maxOutputTokens > this.#config.contextWindow) throw failure('context_exceeded', 413);
    if (prepared.estimatedInputTokens + input.maxOutputTokens + this.#config.safetyTokens > this.#config.contextWindow) throw failure('context_exceeded', 413);
    const task = session(this.#timeout(input.timeoutMs), input.signal);
    try {
      const body = { model: this.#config.model, max_tokens: input.maxOutputTokens, temperature: 0,
        system: input.instructions, messages: [{ role: 'user', content: prepared.userContent }],
        output_config: { format: { type: 'json_schema', schema: prepared.schema } } };
      const response = await this.#request('/v1/messages', body, task.signal);
      if (!response || response.model !== this.#config.model) throw failure('model_mismatch');
      if (!Array.isArray(response.content)) throw failure('invalid_response');
      const textBlocks = response.content.filter(block => block && block.type === 'text');
      if (textBlocks.length !== 1 || typeof textBlocks[0].text !== 'string') throw failure('invalid_response');
      if (response.stop_reason !== 'end_turn') throw failure('incomplete_response');
      let json;
      try { json = JSON.parse(textBlocks[0].text); } catch { throw failure('invalid_response'); }
      let usage = null;
      if (response.usage != null) {
        const u = response.usage;
        if (!integer(u.input_tokens, 0) || !integer(u.output_tokens, 0)) throw failure('invalid_response');
        usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
      }
      return { json, finishReason: response.stop_reason, usage, durationMs: Date.now() - started,
        model: response.model, revisionsAttested: false, inputTokens: usage?.inputTokens ?? null };
    } finally { task.close(); }
  }
}
