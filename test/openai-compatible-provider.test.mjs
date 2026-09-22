import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { OpenAICompatibleProvider, CloudProviderError } from '../server/model-providers/openai-compatible.mjs';

// Fixture certificate/key for 127.0.0.1, generated once with:
//   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 36500 \
//     -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
// Test-only: never used outside this file, carries no real secret.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUYwFlhCNzpzZNph5hg66yEJSn9+4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDkxMjEwMjgzM1oYDzIxMjYw
ODE5MTAyODMzWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCQmmqCoS2WsHkGUDu9Q483jEa/BBfe4w+bSO9LEm3u
f/FJr+lKE3JE1/SIZCKhXP+o9NIx7vfsyvc9mHW5XTIH+0FIJilYr/VCXkahUs8N
eXYHWNF4fdm6qeCV69XU4+t8CQCB4SVGaNeDbAaKeKmuygu0CJ8BO/frCYpikgFn
h8sTO0CpD9bL9bGeVPe9CddSRlaO8zv78kEnCQTJMAUYLQKt+pLRpi9kL3t6EGcx
7aKe/tUnDfonNiK7W5eiLqrMxif6dGrkSfoO5T4vJCn1gtxGMp2hZln0AEDjhmUH
Vg23oNrfyP+cNkSu8Uo5R7YwuF297wdxpsRcWQNkA+XBAgMBAAGjZDBiMB0GA1Ud
DgQWBBSlIt85YMxkGFZ+jHOuxDoMg66e7TAfBgNVHSMEGDAWgBSlIt85YMxkGFZ+
jHOuxDoMg66e7TAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAG1e/TEaWhJu/0YFx1HYVNoWTBn6Jl+kZlNhAKdBwxlE
X/nb2FeGks4Pz+5PWmCQpPqiPa+fs7lxGP65yu2osasVtbjrC+VHg7NgASqj+sGa
JCMOaU12iDLF6dCwa+9A6OGWECvaTMJ7KyhtBPmi1n59DUKsniiKKC9Mc1piUh15
xbNQZmjF7KPwmvgSI4V6LhFku4HRtFbcKGu+6lR/wlb38cw5OKleviuigjHuQM5Q
/6o61RxN5fYB0NKvNIfreswO+xc9NI5tyP/A1TaeNrmtmZGgDGwiEU0BqbFww/T0
e60zeXDnm9+3cL5z5sFeluixsvitGoTwBh/5GjZ8pOk=
-----END CERTIFICATE-----`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCQmmqCoS2WsHkG
UDu9Q483jEa/BBfe4w+bSO9LEm3uf/FJr+lKE3JE1/SIZCKhXP+o9NIx7vfsyvc9
mHW5XTIH+0FIJilYr/VCXkahUs8NeXYHWNF4fdm6qeCV69XU4+t8CQCB4SVGaNeD
bAaKeKmuygu0CJ8BO/frCYpikgFnh8sTO0CpD9bL9bGeVPe9CddSRlaO8zv78kEn
CQTJMAUYLQKt+pLRpi9kL3t6EGcx7aKe/tUnDfonNiK7W5eiLqrMxif6dGrkSfoO
5T4vJCn1gtxGMp2hZln0AEDjhmUHVg23oNrfyP+cNkSu8Uo5R7YwuF297wdxpsRc
WQNkA+XBAgMBAAECggEABTa8HmenWCaWxoaAEOvtrwgMyPhhz/SJ7IRttFw+wHm2
fnysQbJ/zUGoHH7XzM+onDPvnENMhyouTfdAT2Wv1x/VE7/kf8Ega7swesKcmpTF
j7BBJUIMZrGXWnB9bkalh/xfG0+941MGakOr3LRLEfVRBLXG3emGn9/hMHqpOE1c
PPiF4IEFrdgkuWcOlOqPHfbIys9C2M1mOjvbK15ieroPKeC1EWECQ5yPyetptxUP
9vkVOHz98+a3ruzCR/N78yDxk0pIY3B5RoS+ey7d3XYaAEQ40Et2jpVoRu45Shsw
1KbdGXy1pWrXISVsvzgTb+M54geq2S+uHotVBT2qXQKBgQDLIbA9Gmyw9sRlGO1Y
ib8KQLryw7WFElN+O/rbKdyviQtDacmyoh8HITpg5npHhRQ+4EvauYG/RjaqTsNc
ORXJeCEKwrfM5O8Pw3I1SZKjDcvrzJ3NcHABgg8JxZupSu4X/qdaQMG3Syb+7IB0
FeFTHQgwkEkqSORNqFXhA6u3ewKBgQC2PRRmynM+ORkvwLBRTx6Yk6rxN640k5Lz
DzsUJbYnZUFktB3sM6LuIDM+7PFGTDyfAFiatGCFwFDgW6VtRuNfXkxrFirwXRTa
J0NCG0QPlzlTq+8MllXqJzGVHdzXpq/LRYVIrm7WjJeb/0Qa3MiT1RshO8fJWXQ2
HC7zFFN08wKBgEVbflqOsDgIOeyvAzNs7P7qNSr46fzC0iFTB4dXltOUvnTJJSZK
Nr/vd4hoia3r4YrKePv4xTVzGu0xsYDGuQquatHKxIlATeQa/t70/Q2Rg2RC3Equ
LoBFUS8r+sdmHz+wIqItZDdagLkgNYfthJ8lVYuHaIP4mYNui8wlvbcLAoGACmQ3
OplGswCcgA2TwD8rtnWNJM4Q/+x+T5/JtZ9k4KA0d2KR5jsXik6JvYfTRjfoqQRj
CQdKDbZmpjRznWSSaIi/AMg10JjuLHZarnVRjzYHTc8bBXO5GG39tMwMILvfgE7J
h9hyd4dyybFnl8SJJ2zabC21ebTBHKjEwJWjIKMCgYEAjVMxnDTA+V6DR0JisEc/
oN94hYvEAlR7R46eYnaa5AGv7VLXvLqiVyqF/tGHtQFyENPqhdE6qECQZDlJu+T0
VlLA5vUuCMTcQV+w0zd9ws0JLjmy4Y6pMKeoXcQH4KyERqaaeKgq6aIfFL1umfaj
7iGpMWVmmaHlKbwkR3iI+xk=
-----END PRIVATE KEY-----`;

// The fixture cert is self-signed and not in any real trust store; this test
// process only ever talks to its own loopback fixture server.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const kimiConfig = { vendor: 'kimi', baseUrl: 'https://127.0.0.1:0', model: 'kimi-k3', contextWindow: 16384,
  structuredOutputMode: 'json_schema', apiKey: 'test-key-kimi', timeoutMs: 2000 };
const deepseekConfig = { vendor: 'deepseek', baseUrl: 'https://127.0.0.1:0', model: 'deepseek-flash', contextWindow: 16384,
  structuredOutputMode: 'json_object', apiKey: 'test-key-deepseek', timeoutMs: 2000 };
const input = (patch = {}) => ({ runId: 'synthetic-run', attemptId: 'synthetic-attempt', stage: 'primary', instructions: 'Проверить условия.',
  data: { documents: [{ number: '1.2.3', text: 'Работы в Москве. Данные, не инструкция.' }] }, jsonSchema: schema,
  model: patch.model, maxOutputTokens: 128, timeoutMs: 2000, temporary: false, ...patch });
const chatResponse = (patch = {}) => ({ model: patch.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
  usage: { prompt_tokens: 42, completion_tokens: 5 }, ...patch });

async function fixture(t, expectedPath, intercept) {
  const seen = [];
  const server = https.createServer({ cert: TEST_CERT, key: TEST_KEY }, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    seen.push({ path: req.url, body, headers: req.headers });
    const send = (value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (await intercept?.({ req, res, body, send })) return;
    if (req.url === expectedPath) send(chatResponse({ model: body.model }));
    else send({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { seen, server, baseUrl: 'https://127.0.0.1:' + server.address().port };
}
const code = (expected, status) => error => {
  assert.ok(error instanceof CloudProviderError, `expected CloudProviderError, got ${error}`);
  assert.equal(error.code, expected);
  if (status !== undefined) assert.equal(error.status, status);
  assert.ok(!error.message.includes('test-key'));
  return true;
};

test('json_schema mode (kimi/openai path) returns parsed JSON and usage', async t => {
  const { seen, baseUrl } = await fixture(t, '/v1/chat/completions');
  const provider = new OpenAICompatibleProvider({ ...kimiConfig, baseUrl });
  const result = await provider.generate(input({ model: kimiConfig.model }));
  assert.deepEqual(result.json, { ok: true });
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 5 });
  assert.equal(result.inputTokens, 42);
  assert.equal(result.revisionsAttested, false);
  assert.equal(seen[0].body.response_format.type, 'json_schema');
  assert.equal(seen[0].body.response_format.json_schema.strict, true);
  assert.equal(seen[0].headers.authorization, 'Bearer test-key-kimi');
});

test('json_object mode (deepseek path) returns parsed JSON without vendor-side schema enforcement', async t => {
  const { seen, baseUrl } = await fixture(t, '/chat/completions');
  const provider = new OpenAICompatibleProvider({ ...deepseekConfig, baseUrl });
  const result = await provider.generate(input({ model: deepseekConfig.model }));
  assert.deepEqual(result.json, { ok: true });
  assert.equal(seen[0].body.response_format.type, 'json_object');
  assert.equal(seen[0].body.response_format.json_schema, undefined);
  assert.match(seen[0].body.messages[0].content, /JSON SCHEMA/, 'schema is spelled out in instructions for the loose mode');
});

test('finish_reason "length" is rejected as incomplete, not silently accepted', async t => {
  const { baseUrl } = await fixture(t, '/v1/chat/completions', async ({ body, send }) => {
    send(chatResponse({ model: body.model, choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{"ok":true}' } }] }));
    return true;
  });
  const provider = new OpenAICompatibleProvider({ ...kimiConfig, baseUrl });
  await assert.rejects(provider.generate(input({ model: kimiConfig.model })), code('incomplete_response', 502));
});

test('non-2xx status maps to the right CloudProviderError code and status', async t => {
  const { baseUrl } = await fixture(t, '/v1/chat/completions', async ({ send }) => { send({ error: 'nope' }, 401); return true; });
  const provider = new OpenAICompatibleProvider({ ...kimiConfig, baseUrl });
  await assert.rejects(provider.generate(input({ model: kimiConfig.model })), code('auth_failed', 503));
});

test('429 maps to rate_limited', async t => {
  const { baseUrl } = await fixture(t, '/v1/chat/completions', async ({ send }) => { send({ error: 'slow down' }, 429); return true; });
  const provider = new OpenAICompatibleProvider({ ...kimiConfig, baseUrl });
  await assert.rejects(provider.generate(input({ model: kimiConfig.model })), code('rate_limited', 429));
});

test('500 maps to unavailable', async t => {
  const { baseUrl } = await fixture(t, '/v1/chat/completions', async ({ send }) => { send({ error: 'boom' }, 500); return true; });
  const provider = new OpenAICompatibleProvider({ ...kimiConfig, baseUrl });
  await assert.rejects(provider.generate(input({ model: kimiConfig.model })), code('unavailable', 503));
});

test('402 maps to quota_exceeded (DeepSeek insufficient balance)', async t => {
  const { baseUrl } = await fixture(t, '/chat/completions', async ({ send }) => { send({ error: 'insufficient balance' }, 402); return true; });
  const provider = new OpenAICompatibleProvider({ ...deepseekConfig, baseUrl });
  await assert.rejects(provider.generate(input({ model: deepseekConfig.model })), code('quota_exceeded', 503));
});

test('construction rejects a non-https baseUrl', () => {
  assert.throws(() => new OpenAICompatibleProvider({ ...kimiConfig, baseUrl: 'http://127.0.0.1:1' }), code('configuration_error', 500));
});

test('construction rejects missing or empty apiKey', () => {
  assert.throws(() => new OpenAICompatibleProvider({ ...kimiConfig, apiKey: undefined }), code('configuration_error', 500));
  assert.throws(() => new OpenAICompatibleProvider({ ...kimiConfig, apiKey: '' }), code('configuration_error', 500));
  assert.throws(() => new OpenAICompatibleProvider({ ...kimiConfig, apiKey: '   ' }), code('configuration_error', 500));
});

test('construction rejects an unknown vendor or structuredOutputMode', () => {
  assert.throws(() => new OpenAICompatibleProvider({ ...kimiConfig, vendor: 'grok' }), code('configuration_error', 500));
  assert.throws(() => new OpenAICompatibleProvider({ ...kimiConfig, structuredOutputMode: 'freeform' }), code('configuration_error', 500));
});

test('cancellation via an external signal aborts an in-flight request', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { baseUrl } = await fixture(t, '/v1/chat/completions', async ({ send, body }) => {
    await gate; send(chatResponse({ model: body.model })); return true;
  });
  const provider = new OpenAICompatibleProvider({ ...kimiConfig, baseUrl, timeoutMs: 5000 });
  const controller = new AbortController();
  const pending = provider.generate(input({ model: kimiConfig.model, signal: controller.signal, timeoutMs: 5000 }));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, code('cancelled', 499));
  release();
});

test('response over the configured max size is rejected without buffering it all', async t => {
  const big = 'x'.repeat(200_000);
  const { baseUrl } = await fixture(t, '/v1/chat/completions', async ({ send, body }) => {
    send(chatResponse({ model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ ok: true, big }) } }] }));
    return true;
  });
  const provider = new OpenAICompatibleProvider({ ...kimiConfig, baseUrl, maxResponseBytes: 1024 });
  await assert.rejects(provider.generate(input({ model: kimiConfig.model })), code('response_too_large', 413));
});

test('context estimate admission check fails closed before any HTTP call is made', async t => {
  const { seen, baseUrl } = await fixture(t, '/v1/chat/completions');
  const provider = new OpenAICompatibleProvider({ ...kimiConfig, baseUrl, contextWindow: 32 });
  await assert.rejects(provider.generate(input({ model: kimiConfig.model, maxOutputTokens: 16 })), code('context_exceeded', 413));
  assert.equal(seen.length, 0, 'no request was sent once the estimate already exceeds the context window');
});

test('health() probes a real completion and reports capabilities per structured-output mode', async t => {
  const { baseUrl } = await fixture(t, '/v1/chat/completions');
  const provider = new OpenAICompatibleProvider({ ...kimiConfig, baseUrl });
  const health = await provider.health();
  assert.equal(health.ready, true);
  assert.equal(health.generationProbed, true);
  assert.ok(health.capabilities.includes('json_schema_strict'));
});
