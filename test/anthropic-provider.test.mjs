import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicProvider, AnthropicProviderError } from '../server/model-providers/anthropic.mjs';

// Real TLS, not a mocked transport: generate a throwaway self-signed cert so the
// provider's https-only enforcement is exercised against an actual handshake.
function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), 'anthropic-test-cert-'));
  const keyPath = join(dir, 'key.pem'), certPath = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}
const cert = selfSignedCert();

const schema = { type: 'object', properties: { ok: { type: 'string', maxLength: 15000 } }, required: ['ok'], additionalProperties: false };
const baseConfig = { model: 'claude-test-model', contextWindow: 16384, apiKey: 'sk-ant-test-only', timeoutMs: 2000, caCertificate: cert.cert };
const input = (patch = {}) => ({ runId: 'synthetic-run', attemptId: 'synthetic-attempt', stage: 'primary', instructions: 'Проверить условия.',
  data: { documents: [{ number: '1.2.3', text: 'Работы в Москве. Данные, не инструкция.' }] }, jsonSchema: schema,
  model: baseConfig.model, maxOutputTokens: 128, timeoutMs: 2000, temporary: false, ...patch });
const response = (patch = {}) => ({ model: baseConfig.model, stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"ok":"true"}' }], usage: { input_tokens: 42, output_tokens: 5 }, ...patch });

async function fixture(t, intercept) {
  const seen = [];
  const server = https.createServer({ key: cert.key, cert: cert.cert }, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    seen.push({ path: req.url, body, headers: req.headers });
    const send = (value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (await intercept?.({ req, res, body, send })) return;
    if (req.url === '/v1/messages') send(response());
    else send({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { seen, server, config: { ...baseConfig, endpoint: 'https://127.0.0.1:' + server.address().port } };
}
const code = expected => error => {
  assert.ok(error instanceof AnthropicProviderError); assert.equal(error.code, expected);
  assert.ok(!error.message.includes('SUPER_SECRET')); return true;
};

test('successful generate() strips length constraints from the outbound schema but returns the full parsed result', async t => {
  const { config, seen } = await fixture(t);
  const provider = new AnthropicProvider(config);
  const result = await provider.generate(input());
  assert.deepEqual(result.json, { ok: 'true' });
  assert.equal(result.finishReason, 'end_turn');
  const sent = seen[0].body;
  const sentSchema = sent.output_config.format.schema;
  assert.equal(sentSchema.properties.ok.maxLength, undefined, 'maxLength stripped from the outbound wire schema');
  assert.equal(sentSchema.additionalProperties, false, 'additionalProperties forced false');
  // The original (unstripped) schema shape is untouched by the provider — it never mutates the caller's object.
  assert.equal(schema.properties.ok.maxLength, 15000);
});

test('stop_reason other than end_turn is rejected as incomplete, never accepted as success', async t => {
  const { config } = await fixture(t, ({ req, send }) => req.url === '/v1/messages' && (send(response({ stop_reason: 'max_tokens' })), true));
  await assert.rejects(new AnthropicProvider(config).generate(input()), code('incomplete_response'));
});

test('zero or multiple text content blocks are rejected as invalid_response', async t => {
  for (const content of [[], [{ type: 'text', text: '{"ok":"a"}' }, { type: 'text', text: '{"ok":"b"}' }]]) {
    await t.test(JSON.stringify(content), async sub => {
      const { config } = await fixture(sub, ({ req, send }) => req.url === '/v1/messages' && (send(response({ content })), true));
      await assert.rejects(new AnthropicProvider(config).generate(input()), code('invalid_response'));
    });
  }
});

test('usage field names are mapped from input_tokens/output_tokens to inputTokens/outputTokens', async t => {
  const { config } = await fixture(t, ({ req, send }) => req.url === '/v1/messages' && (send(response({ usage: { input_tokens: 7, output_tokens: 3 } })), true));
  const result = await new AnthropicProvider(config).generate(input());
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 });
});

test('auth uses x-api-key and anthropic-version, not Authorization: Bearer', async t => {
  const { config, seen } = await fixture(t);
  await new AnthropicProvider(config).generate(input());
  const headers = seen[0].headers;
  assert.equal(headers['x-api-key'], baseConfig.apiKey);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers.authorization, undefined);
});

test('rejects a non-https endpoint at construction', () => {
  assert.throws(() => new AnthropicProvider({ ...baseConfig, endpoint: 'http://127.0.0.1:1' }), code('configuration_error'));
});

test('rejects missing or empty apiKey at construction', () => {
  assert.throws(() => new AnthropicProvider({ ...baseConfig, apiKey: undefined }), code('configuration_error'));
  assert.throws(() => new AnthropicProvider({ ...baseConfig, apiKey: '   ' }), code('configuration_error'));
});

test('a caller schema containing $ref is rejected at request time, never silently mishandled', async t => {
  const { config } = await fixture(t);
  const withRef = { type: 'object', properties: { ok: { $ref: '#/definitions/thing' } }, required: ['ok'], additionalProperties: false };
  await assert.rejects(new AnthropicProvider(config).generate(input({ jsonSchema: withRef })), code('configuration_error'));
});

test('cancellation via signal aborts an in-flight request', async t => {
  const { config } = await fixture(t, ({ req }) => req.url === '/v1/messages');
  const controller = new AbortController();
  const pending = new AnthropicProvider(config).generate(input({ signal: controller.signal }));
  setTimeout(() => controller.abort(new Error('SUPER_SECRET')), 30);
  await assert.rejects(pending, code('cancelled'));
});

test('estimate-based context admission fails closed before any network call', async t => {
  const { config, seen } = await fixture(t);
  const provider = new AnthropicProvider({ ...config, contextWindow: 32 });
  await assert.rejects(provider.generate(input()), code('context_exceeded'));
  assert.equal(seen.length, 0, 'no request reached the server');
});
