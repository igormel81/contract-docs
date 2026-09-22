import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/main.mjs';
import { selfSignedPair, acceptFixtureCertificates } from './tls-fixture.mjs';

// This file exercises server/main.mjs's modelProviderConfiguration() end to
// end for the four cloud vendors (openai/deepseek/kimi/anthropic): does
// DOCS_MODEL_PROVIDER + the DOCS_CLOUD_* options actually build the right
// provider class, with the right field names, pointed at the right endpoint?
// The two provider classes themselves (server/model-providers/openai-compatible.mjs,
// anthropic.mjs) are unit-tested against a live fake server in their own
// files; this file only proves main.mjs wires them up correctly — it is the
// integration seam where a field-name mismatch (main.mjs passing `baseUrl`
// where a provider expects `endpoint`, for instance) would silently fall
// back to the vendor's real public endpoint instead of the configured one,
// which a plain "does construction throw" check would never catch.

// Fixture certificate/key for 127.0.0.1, identical to the one embedded in
// test/openai-compatible-provider.test.mjs. Test-only: never used outside
// this file's fake servers, carries no real secret.

acceptFixtureCertificates();

async function fakeServer(t, handler) {
  const seen = [];
  const server = https.createServer({ cert: selfSignedPair().cert, key: selfSignedPair().key }, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    seen.push({ path: req.url, body, headers: req.headers });
    handler({ req, res, body });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { seen, baseUrl: `https://127.0.0.1:${server.address().port}` };
}
const sendJson = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'docs-cloud-wiring-'));
  const app = await createApp({ dir, origin: 'http://127.0.0.1:3107', sandbox: false, autoTick: false, codexAdmin: 'owner', ...options });
  t.after(async () => { await app.runner.stop(); await rm(dir, { recursive: true, force: true }); });
  return app;
}

test('DOCS_MODEL_PROVIDER rejects an unknown vendor', async t => {
  await assert.rejects(fixture(t, { modelProvider: 'not-a-real-vendor' }), /должен быть/);
});

for (const vendor of ['openai', 'kimi']) {
  test(`${vendor}: main.mjs wires OpenAICompatibleProvider to the configured baseUrl with strict JSON schema`, async t => {
    const { seen, baseUrl } = await fakeServer(t, ({ body, res }) => sendJson(res, {
      model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    const app = await fixture(t, { modelProvider: vendor, cloud: { apiKey: 'sk-test', model: 'test-model', contextWindow: 32000, baseUrl } });
    assert.deepEqual(app.runner.describe(), { provider: vendor, model: 'test-model' });
    const status = await app.runner.status();
    assert.equal(status.connected, true, 'health() reached the configured fake server, not the real vendor endpoint');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/v1/chat/completions');
    assert.equal(seen[0].body.response_format.type, 'json_schema');
    assert.equal(seen[0].headers.authorization, 'Bearer sk-test');
    // A cloud executor has no Codex login and no internet search of its own.
    const caps = app.runner.capabilities();
    assert.equal(caps.provider, vendor);
    assert.equal(caps.organizationLookup, false);
    assert.equal(caps.external, true, 'document text leaves the perimeter with a cloud vendor');
    assert.doesNotMatch(caps.offline, /Codex/);
  });
}

test('deepseek: main.mjs wires OpenAICompatibleProvider to the deepseek-specific path with loose json_object mode', async t => {
  const { seen, baseUrl } = await fakeServer(t, ({ body, res }) => sendJson(res, {
    model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
    usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  const app = await fixture(t, { modelProvider: 'deepseek', cloud: { apiKey: 'sk-test', model: 'deepseek-flash', contextWindow: 32000, baseUrl } });
  const status = await app.runner.status();
  assert.equal(status.connected, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/chat/completions', 'DeepSeek has no /v1 segment, unlike openai/kimi');
  assert.equal(seen[0].body.response_format.type, 'json_object');
});

test('anthropic: main.mjs maps its baseUrl option onto AnthropicProvider\'s endpoint field', async t => {
  const { seen, baseUrl } = await fakeServer(t, ({ body, res }) => sendJson(res, {
    model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }],
    usage: { input_tokens: 4, output_tokens: 1 } }));
  const app = await fixture(t, { modelProvider: 'anthropic', cloud: { apiKey: 'sk-ant-test', model: 'claude-test', contextWindow: 100000, baseUrl } });
  assert.deepEqual(app.runner.describe(), { provider: 'anthropic', model: 'claude-test' });
  const status = await app.runner.status();
  // Before this main.mjs field was corrected to pass `endpoint` (not `baseUrl`)
  // into AnthropicProvider's constructor, this request silently went to the
  // real api.anthropic.com instead of the fixture server below, and this
  // assertion is what would have caught it: `seen` would stay empty.
  assert.equal(status.connected, true, 'health() reached the configured fake server via the endpoint field');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0].headers.authorization, undefined, 'Anthropic uses x-api-key, never Authorization: Bearer');
});

test('cloud vendor without DOCS_CLOUD_API_KEY fails fast with a clear configuration error', async t => {
  await assert.rejects(
    fixture(t, { modelProvider: 'openai', cloud: { model: 'test-model', contextWindow: 32000, baseUrl: 'https://127.0.0.1:1' } }),
    /DOCS_CLOUD_API_KEY/);
});

test('a queued analysis is pinned to the configured cloud provider/model and rejects a stale pin', async t => {
  const provider = {
    describe() { return { provider: 'openai', model: 'test-model' }; },
    async health() { return { ready: true, provider: 'openai', model: 'test-model', generationProbed: true }; },
    async generate() { throw new Error('not exercised in this test'); },
  };
  const app = await fixture(t, { modelProvider: 'openai', cloud: { provider } });
  const stamp = new Date().toISOString();
  app.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u-owner', 'owner', 'dummy-hash', stamp);
  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)').run('c-1', 'u-owner', 'Test', 'test', 'template', stamp);
  await assert.rejects(
    app.runner.execute('u-owner', 'a-1', { documents: [], rules: [], inference: { provider: 'openai', model: 'a-different-model' } }, 'qualification'),
    err => err.status === 409);
});
