import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/main.mjs';

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

// The fixture cert is self-signed and not in any real trust store; every
// server in this file is our own loopback fixture, never a real vendor.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function fakeServer(t, handler) {
  const seen = [];
  const server = https.createServer({ cert: TEST_CERT, key: TEST_KEY }, async (req, res) => {
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
