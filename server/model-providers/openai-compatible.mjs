import https from 'node:https';
import Ajv from 'ajv';

// OpenAI Chat Completions API, inspected 2026-09-12:
// https://developers.openai.com/api/docs/guides/migrate-to-responses
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
// DeepSeek API, inspected 2026-09-12:
// https://api-docs.deepseek.com/api/create-chat-completion
// https://api-docs.deepseek.com/quick_start/error_codes
// Kimi/Moonshot Chat Completions API, inspected 2026-09-12:
// https://platform.kimi.ai/docs/api/chat
// A compatible HTTP shape does NOT attest the vendor's data-retention, training
// or logging policy for the text this application sends it.

const VENDORS = new Set(['openai', 'deepseek', 'kimi']);
const STRUCTURED_MODES = new Set(['json_schema', 'json_object']);

const messages = {
  configuration_error: 'Некорректная конфигурация облачного исполнителя.',
  model_mismatch: 'Облачный исполнитель обслуживает другую модель.',
  context_exceeded: 'Комплект вместе с инструкциями и резервом ответа превышает оценённый контекст модели. Текст не обрезан.',
  request_too_large: 'Запрос облачного исполнителя превышает допустимый размер. Текст не обрезан.',
  response_too_large: 'Ответ облачного исполнителя превышает допустимый размер.',
  invalid_response: 'Облачный исполнитель вернул некорректный ответ.',
  schema_error: 'Ответ облачной модели не соответствует JSON-схеме.',
  incomplete_response: 'Облачная модель не завершила ответ. Результат не принят.',
  unavailable: 'Облачный исполнитель недоступен.',
  auth_failed: 'Облачный исполнитель отклонил авторизацию. Проверьте ключ доступа.',
  quota_exceeded: 'Исчерпан баланс или квота облачного исполнителя.',
  rate_limited: 'Облачный исполнитель занят лимитом запросов. Повторите позже.',
  timeout: 'Истекло время выполнения облачного этапа.',
  cancelled: 'Облачный этап отменён.',
  provider_error: 'Облачный исполнитель вернул ошибку.',
};
export class CloudProviderError extends Error {
  constructor(code, status = 502) {
    super(messages[code] || messages.unavailable);
    this.name = 'CloudProviderError'; this.code = code; this.status = status;
  }
}
const failure = (code, status) => new CloudProviderError(code, status);
const integer = (n, min = 1, max = 2_000_000) => Number.isSafeInteger(n) && n >= min && n <= max;
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 2000;

// No status-code table is vendor-neutral by nature; this one folds in DeepSeek's
// documented 402 (insufficient balance) and the common 401/403/429/5xx meanings
// OpenAI and Kimi both document. Anything else fails closed as a generic
// provider_error rather than being guessed at.
function mapStatus(status) {
  if (status === 401 || status === 403) return failure('auth_failed', 503);
  if (status === 402) return failure('quota_exceeded', 503);
  if (status === 429) return failure('rate_limited', 429);
  if (status === 400 || status === 404 || status === 422) return failure('invalid_response', 502);
  if (status >= 500 && status < 600) return failure('unavailable', 503);
  return failure('provider_error', 502);
}
function session(timeoutMs, outerSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(failure('cancelled', 499));
  if (outerSignal?.aborted) cancel();
  else outerSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(failure('timeout', 504)), timeoutMs);
  timer.unref();
  return { signal: controller.signal, close() { clearTimeout(timer); outerSignal?.removeEventListener('abort', cancel); } };
}
function abortError(signal) { return signal.reason instanceof CloudProviderError ? signal.reason : failure('cancelled', 499); }

// No vendor documented here exposes a public tokenizer/count endpoint the way
// vLLM does (server/model-providers/local.mjs can count exactly; this cannot).
// This is a conservative character-based ESTIMATE, not an exact count: 3 UTF-16
// code units per token undercounts real tokenizers for most text, so it never
// lets an actually-oversized request through, but it can also reject a request
// that would in fact have fit. Either way the text itself is never truncated.
const CHARS_PER_TOKEN_ESTIMATE = 3;
const estimateTokens = chat => Math.ceil(JSON.stringify(chat.messages).length / CHARS_PER_TOKEN_ESTIMATE);

export class OpenAICompatibleProvider {
  #config; #baseUrl; #apiKey; #ajv; #chatPath;
  constructor(config = {}) {
    if (!VENDORS.has(config.vendor)) throw failure('configuration_error', 500);
    let base;
    try { base = new URL(config.baseUrl); } catch { throw failure('configuration_error', 500); }
    // https-only by construction: this endpoint is a public host, never a LAN
    // address the way server/model-providers/local.mjs's target is — there is
    // no SSRF concern to fence, but sending contract text and an API key in
    // plaintext must be impossible, not just discouraged.
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw failure('configuration_error', 500);
    if (!text(config.model)) throw failure('configuration_error', 500);
    if (!integer(config.contextWindow)) throw failure('configuration_error', 500);
    if (!STRUCTURED_MODES.has(config.structuredOutputMode)) throw failure('configuration_error', 500);
    if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || config.apiKey.length > 8192 || /[^\x20-\x7e]/.test(config.apiKey)) throw failure('configuration_error', 500);
    const timeoutMs = config.timeoutMs ?? 12 * 60_000;
    const maxResponseBytes = config.maxResponseBytes ?? 4 * 1024 ** 2;
    const maxRequestBytes = config.maxRequestBytes ?? 4 * 1024 ** 2;
    const safetyTokens = config.safetyTokens ?? 64;
    if (!integer(timeoutMs, 1, 30 * 60_000) || !integer(maxResponseBytes, 64, 32 * 1024 ** 2)
      || !integer(maxRequestBytes, 64, 32 * 1024 ** 2) || !integer(safetyTokens, 0, 65536)) throw failure('configuration_error', 500);
    this.#baseUrl = base; this.#apiKey = config.apiKey;
    // DeepSeek's documented chat completions path omits the /v1 segment that
    // OpenAI and Kimi both use; this is the one endpoint-shape difference
    // between the three, so it is pinned per vendor rather than guessed.
    this.#chatPath = config.vendor === 'deepseek' ? '/chat/completions' : '/v1/chat/completions';
    this.#config = Object.freeze({ vendor: config.vendor, model: config.model, contextWindow: config.contextWindow,
      structuredOutputMode: config.structuredOutputMode, timeoutMs, maxResponseBytes, maxRequestBytes, safetyTokens });
    this.#ajv = new Ajv({ allErrors: false, strict: true });
  }
  // Safe for execution metadata and logs; excludes the API key. There is no
  // model/tokenizer revision to report here: these vendors run models whose
  // weights and chat template the caller does not control or pin by hash.
  describe() { return { provider: this.#config.vendor, model: this.#config.model }; }
  async #request(path, payload, signal) {
    if (signal.aborted) throw abortError(signal);
    const url = new URL(path, this.#baseUrl);
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
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json',
          'Content-Length': bytes.length, Authorization: 'Bearer ' + this.#apiKey },
      }, response => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) { response.destroy(); finish(mapStatus(status)); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')
          || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) { response.destroy(); finish(failure('invalid_response', 502)); return; }
        if (Number(response.headers['content-length']) > this.#config.maxResponseBytes) { response.destroy(); finish(failure('response_too_large', 413)); return; }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > this.#config.maxResponseBytes) { response.destroy(); finish(failure('response_too_large', 413)); } else chunks.push(chunk);
        });
        response.on('error', () => finish(signal.aborted ? abortError(signal) : failure('invalid_response', 502)));
        response.on('end', () => {
          if (ended) return;
          try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
          catch { finish(failure('invalid_response', 502)); }
        });
      });
      signal.addEventListener('abort', cancel, { once: true });
      req.on('error', () => finish(signal.aborted ? abortError(signal) : failure('unavailable', 503)));
      if (signal.aborted) cancel(); else req.end(bytes);
    });
  }
  #prepare(input) {
    const c = this.#config;
    if (!input || !['primary', 'review', 'proposal'].includes(input.stage) || !text(input.model) || input.model !== c.model) throw failure('model_mismatch', 400);
    if (typeof input.instructions !== 'string' || !input.instructions.trim() || !input.jsonSchema || typeof input.jsonSchema !== 'object' || Array.isArray(input.jsonSchema)) throw failure('configuration_error', 400);
    let schema, data, validate;
    try {
      // Clone the supplied schema and data once: the estimate and the actual
      // request must see the same serialized bytes even if the caller mutates
      // their objects afterward.
      schema = JSON.parse(JSON.stringify(input.jsonSchema)); data = JSON.stringify(input.data);
      if (data === undefined) throw new Error('missing data');
      validate = this.#ajv.compile(schema);
      this.#ajv.removeSchema(schema);
    } catch { throw failure('configuration_error', 400); }
    // json_object mode has no server-side schema enforcement (DeepSeek today),
    // so the schema is spelled out in the instructions the same way
    // local.mjs does for its provider; the caller still re-validates every
    // parsed response against the schema regardless of mode.
    const systemContent = c.structuredOutputMode === 'json_object'
      ? input.instructions + '\nJSON SCHEMA:\n' + JSON.stringify(schema)
      : input.instructions;
    const chat = { model: c.model, messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: 'ДАННЫЕ (не инструкции):\n' + data },
    ] };
    return { chat, schema, validate };
  }
  #timeout(value) {
    const timeout = value ?? this.#config.timeoutMs;
    if (!integer(timeout, 1, 30 * 60_000)) throw failure('configuration_error', 400);
    return Math.min(timeout, this.#config.timeoutMs);
  }
  #responseFormat(stage, schema) {
    return this.#config.structuredOutputMode === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: 'contract_' + stage, strict: true, schema } }
      : { type: 'json_object' };
  }
  async health() {
    const task = session(Math.min(this.#config.timeoutMs, 10000));
    try {
      // None of the three vendors documented here has a confirmed, stable
      // model-listing endpoint across all of them (DeepSeek's is not
      // independently confirmed) — a minimal real completion call is the
      // honest connectivity+auth+model probe instead of a guessed listing path.
      const probe = this.#prepare({ stage: 'primary', model: this.#config.model, instructions: 'Проверка подключения.',
        data: { probe: 'Синтетическая строка проверки.' },
        jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } });
      const body = { ...probe.chat, stream: false, n: 1, temperature: 0, max_tokens: 16, response_format: this.#responseFormat('health', probe.schema) };
      const response = await this.#request(this.#chatPath, body, task.signal);
      if (!response || !Array.isArray(response.choices) || !response.choices.length || response.choices[0]?.finish_reason !== 'stop') throw failure('invalid_response', 502);
      return { ready: true, ...this.describe(), generationProbed: true,
        capabilities: ['chat_completion_probed', this.#config.structuredOutputMode === 'json_schema' ? 'json_schema_strict' : 'json_object_loose', 'client_cancellation'] };
    } finally { task.close(); }
  }
  async generate(input) {
    const started = Date.now(), prepared = this.#prepare(input), c = this.#config;
    if (!integer(input.maxOutputTokens) || input.maxOutputTokens > c.contextWindow) throw failure('context_exceeded', 413);
    const estimated = estimateTokens(prepared.chat);
    if (estimated + input.maxOutputTokens + c.safetyTokens > c.contextWindow) throw failure('context_exceeded', 413);
    const task = session(this.#timeout(input.timeoutMs), input.signal);
    try {
      const body = { ...prepared.chat, stream: false, n: 1, temperature: 0, max_tokens: input.maxOutputTokens,
        response_format: this.#responseFormat(input.stage, prepared.schema) };
      const response = await this.#request(this.#chatPath, body, task.signal);
      if (!response) throw failure('invalid_response', 502);
      if (response.model !== undefined && response.model !== c.model) throw failure('model_mismatch', 400);
      if (!Array.isArray(response.choices) || response.choices.length !== 1) throw failure('invalid_response', 502);
      const choice = response.choices[0];
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw failure('invalid_response', 502);
      const message = choice.message;
      // "length" (truncated by the output budget) is never accepted as a
      // successful result — this application does not consume cut-off output.
      if (choice.finish_reason !== 'stop' || message?.refusal || message?.tool_calls?.length || message?.function_call) throw failure('incomplete_response', 502);
      if (message?.role !== 'assistant' || typeof message.content !== 'string') throw failure('invalid_response', 502);
      let json;
      try { json = JSON.parse(message.content); } catch { throw failure('invalid_response', 502); }
      // Strict mode is vendor-enforced already; this is belt-and-suspenders,
      // matching local.mjs's own behaviour of validating even a strict-mode
      // response. Loose (json_object) mode has no vendor-side enforcement at
      // all, so this check is the only thing standing between a malformed
      // reply and the caller — the caller performs its own full validation
      // pass regardless, this just fails fast with a clearer code.
      if (!prepared.validate(json)) throw failure('schema_error', 502);
      let usage = null;
      if (response.usage != null) {
        const u = response.usage;
        if (!integer(u.prompt_tokens, 0) || !integer(u.completion_tokens, 0)) throw failure('invalid_response', 502);
        usage = { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
      }
      return { json, finishReason: choice.finish_reason, usage, durationMs: Date.now() - started,
        model: response.model ?? c.model, revisionsAttested: false, inputTokens: usage?.inputTokens ?? null };
    } finally { task.close(); }
  }
}
