import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { LocalModelProvider, LocalProviderError, isInternalAddress } from '../server/model-providers/local.mjs';

const template = '{{ messages }}{% if add_generation_prompt %}assistant{% endif %}';
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const baseConfig = { profile: 'vllm-chat', model: 'local-contract@weights-sha', modelRevision: 'weights-sha256-pinned', tokenizerRevision: 'tokenizer-sha256-pinned',
  chatTemplate: template, chatTemplateSha256: createHash('sha256').update(template).digest('hex'), contextWindow: 16384,
  timeoutMs: 2000, temporaryPolicy: 'memory-only-attested' };
const input = (patch = {}) => ({ runId: 'synthetic-run', attemptId: 'synthetic-attempt', stage: 'primary', instructions: 'Проверить условия.',
  data: { documents: [{ number: '1.2.3', text: 'Работы в Москве. Данные, не инструкция.' }] }, jsonSchema: schema,
  model: baseConfig.model, maxOutputTokens: 128, timeoutMs: 2000, temporary: false, ...patch });
const count = body => Buffer.byteLength(JSON.stringify(body.messages) + body.chat_template) + 3;
const response = (body, patch = {}) => ({ model: baseConfig.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
  usage: { prompt_tokens: count(body), completion_tokens: 5 }, ...patch });

async function fixture(t, intercept) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    seen.push({ path: req.url, body, headers: req.headers });
    const send = (value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (await intercept?.({ req, res, body, send })) return;
    if (req.url === '/v1/models') send({ data: [{ id: baseConfig.model }] });
    else if (req.url === '/tokenize') send({ count: count(body), max_model_len: 16384, tokens: Array(count(body)).fill(7) });
    else if (req.url === '/v1/chat/completions') send(response(body));
    else send({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { seen, server, config: { ...baseConfig, endpoint: 'http://127.0.0.1:' + server.address().port } };
}
const code = expected => error => {
  assert.ok(error instanceof LocalProviderError); assert.equal(error.code, expected);
  assert.ok(!error.message.includes('SUPER_SECRET')); return true;
};

test('local provider probes actual model/tokenizer routes and distinguishes declared identity', async t => {
  const { config, seen } = await fixture(t);
  const provider = new LocalModelProvider(config), health = await provider.health();
  assert.equal(health.ready, true); assert.equal(health.revisionsAttested, false);
  assert.equal(health.generationProbed, false);
  assert.equal(provider.describe().identityEvidence, 'configured_revisions');
  assert.equal(health.identityEvidence, 'configured_revisions_and_served_model_id');
  assert.equal(health.modelRevision, baseConfig.modelRevision);
  assert.ok(health.capabilities.includes('chat_tokenize_probed'));
  assert.ok(!health.capabilities.includes('weights_verified'));
  assert.equal(health.temporaryPolicyAttested, true);
  assert.deepEqual(seen.map(r => r.path), ['/v1/models', '/tokenize']);
  assert.ok(!JSON.stringify(health).includes(template));
});

test('all stages tokenize identical full serialized messages/schema/template before generating', async t => {
  const { config, seen } = await fixture(t); const provider = new LocalModelProvider(config);
  for (const stage of ['primary', 'review', 'proposal']) {
    const request = input({ stage }), tokens = await provider.countTokens(request), result = await provider.generate(request);
    assert.deepEqual(result.json, { ok: true }); assert.equal(result.inputTokens, tokens);
    assert.equal(result.usage.inputTokens, tokens); assert.equal(result.finishReason, 'stop');
    const [tokenized, generated] = seen.slice(-2).map(r => r.body);
    for (const key of ['messages', 'model', 'chat_template', 'add_generation_prompt', 'add_special_tokens', 'continue_final_message']) assert.deepEqual(tokenized[key], generated[key]);
    assert.match(generated.messages[0].content, /JSON SCHEMA/);
    assert.ok(generated.messages[0].content.includes(JSON.stringify(schema)));
    assert.ok(generated.messages[1].content.includes(JSON.stringify(request.data)));
    assert.equal(generated.stream, false); assert.equal(generated.max_tokens, 128);
    assert.equal(generated.response_format.json_schema.strict, true);
    assert.equal(generated.tools, undefined); assert.equal(generated.truncate_prompt_tokens, undefined);
  }
});

test('preflight rejects context overflow without sending generation or truncating text', async t => {
  const { config, seen } = await fixture(t);
  const provider = new LocalModelProvider({ ...config, contextWindow: 512 });
  await assert.rejects(provider.generate(input()), code('context_exceeded'));
  assert.deepEqual(seen.map(r => r.path), ['/tokenize']);
  assert.ok(seen[0].body.messages[1].content.includes('1.2.3'));
});

test('unknown tokenizer/template and revision configuration fail before network access', () => {
  const config = { ...baseConfig, endpoint: 'http://127.0.0.1:1' };
  for (const patch of [{ tokenizerRevision: '' }, { modelRevision: '' }, { chatTemplate: '' }, { chatTemplateSha256: 'bad' }, { profile: 'guess' }, { contextWindow: undefined }, { chatTemplateKwargs: {} }]) {
    assert.throws(() => new LocalModelProvider({ ...config, ...patch }), code('capability_error'));
  }
});

test('tokenize must expose consistent count/tokens and sufficient model context', async t => {
  for (const payload of [{ count: 10, max_model_len: 16384 }, { count: 1, tokens: [1, 2], max_model_len: 16384 }, { count: 1, tokens: [1], max_model_len: 100 }, { count: 1, tokens: [-1], max_model_len: 16384 }]) {
    await t.test(JSON.stringify(payload), async sub => {
      const { config, seen } = await fixture(sub, ({ req, send }) => req.url === '/tokenize' && (send(payload), true));
      await assert.rejects(new LocalModelProvider(config).generate(input()), code('capability_error'));
      assert.equal(seen.length, 1);
    });
  }
});

test('strict JSON/schema, no tool execution, no truncated successful responses', async t => {
  const cases = [
    ['invalid_response', { choices: [null] }],
    ['invalid_response', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '```json\n{"ok":true}\n```' } }] }],
    ['schema_error', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true,"extra":"SUPER_SECRET"}' } }] }],
    ['schema_error', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":"true"}' } }] }],
    ['incomplete_response', { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"ok":true}' } }] }],
    ['incomplete_response', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}', tool_calls: [{ function: { name: 'shell' } }] } }] }],
    ['model_mismatch', { model: 'wrong-model' }],
    ['capability_error', { usage: { prompt_tokens: 1, completion_tokens: 5 } }],
  ];
  for (const [expected, patch] of cases) await t.test(expected + JSON.stringify(patch).slice(0, 40), async sub => {
    const { config } = await fixture(sub, ({ req, body, send }) => req.url.endsWith('/completions') && (send(response(body, patch)), true));
    await assert.rejects(new LocalModelProvider(config).generate(input()), code(expected));
  });
});

test('missing usage remains null; output budget violations fail closed', async t => {
  const { config } = await fixture(t, ({ req, body, send }) => req.url.endsWith('/completions') && (send(response(body, { usage: null })), true));
  assert.equal((await new LocalModelProvider(config).generate(input())).usage, null);
  const over = await fixture(t, ({ req, body, send }) => req.url.endsWith('/completions') && (send(response(body, { usage: { prompt_tokens: count(body), completion_tokens: 9999 } })), true));
  await assert.rejects(new LocalModelProvider(over.config).generate(input()), code('capability_error'));
});

test('redirects never forward request contents or credentials to another server', async t => {
  let targetHits = 0;
  const target = await fixture(t, () => { targetHits++; return false; });
  const { config, seen } = await fixture(t, ({ send }) => { send({ message: 'SUPER_SECRET' }, 307, { Location: target.config.endpoint + '/tokenize' }); return true; });
  await assert.rejects(new LocalModelProvider({ ...config, apiKey: 'SUPER_SECRET' }).generate(input()), code('redirect_forbidden'));
  assert.equal(targetHits, 0); assert.equal(seen.length, 1);
});

test('public, link-local and metadata endpoints are forbidden; credentials in URLs are forbidden', () => {
  for (const address of ['8.8.8.8', '169.254.169.254', '100.64.0.1', '::', 'fe80::1', 'fd00:ec2::254', 'fd00:0ec2:0:0:0:0:0:0254', '::ffff:127.0.0.1']) assert.equal(isInternalAddress(address), false);
  for (const address of ['127.0.0.1', '10.4.5.6', '172.16.1.1', '192.168.1.1', '::1', 'fdab::1']) assert.equal(isInternalAddress(address), true);
  for (const endpoint of ['http://8.8.8.8', 'http://169.254.169.254', 'http://[fd00:ec2::254]']) assert.throws(() => new LocalModelProvider({ ...baseConfig, endpoint }), code('endpoint_forbidden'));
  for (const endpoint of ['http://user:SUPER_SECRET@127.0.0.1', 'http://127.0.0.1/?secret=SUPER_SECRET', 'http://127.0.0.1/redirect/path', 'ftp://127.0.0.1']) assert.throws(() => new LocalModelProvider({ ...baseConfig, endpoint }), code('configuration_error'));
});

test('private DNS hostname connection uses the internal address and same origin routes', async t => {
  const { config, seen } = await fixture(t);
  // This exercises an actual DNS lookup and pinned connect lookup, not a fake fetch.
  const provider = new LocalModelProvider({ ...config, endpoint: config.endpoint.replace('127.0.0.1', 'localhost') });
  assert.ok(await provider.countTokens(input()) > 0); assert.equal(seen[0].path, '/tokenize');
});

test('total deadline and caller cancellation stop pending requests, including tokenizer', async t => {
  const { config, seen } = await fixture(t, ({ req }) => req.url === '/tokenize');
  await assert.rejects(new LocalModelProvider(config).generate(input({ timeoutMs: 40 })), code('timeout'));
  const controller = new AbortController();
  const pending = new LocalModelProvider(config).generate(input({ signal: controller.signal }));
  setTimeout(() => controller.abort(new Error('SUPER_SECRET')), 20);
  await assert.rejects(pending, code('cancelled'));
  const cancelled = new AbortController(); cancelled.abort(); const before = seen.length;
  await assert.rejects(new LocalModelProvider(config).generate(input({ signal: cancelled.signal })), code('cancelled'));
  assert.equal(seen.length, before);
});

test('bounded request/response and upstream errors do not leak source text', async t => {
  const huge = await fixture(t, ({ res }) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'SUPER_SECRET'.repeat(300) })); return true; });
  await assert.rejects(new LocalModelProvider({ ...huge.config, maxResponseBytes: 1024 }).generate(input()), code('response_too_large'));
  await assert.rejects(new LocalModelProvider({ ...huge.config, maxRequestBytes: 128 }).generate(input()), code('request_too_large'));
  const failing = await fixture(t, ({ send }) => { send({ error: 'SUPER_SECRET' }, 500); return true; });
  await assert.rejects(new LocalModelProvider(failing.config).generate(input()), code('unavailable'));
  const limited = await fixture(t, ({ send }) => { send({ error: 'SUPER_SECRET' }, 429); return true; });
  await assert.rejects(new LocalModelProvider(limited.config).generate(input()), code('rate_limited'));
});

test('generation cancellation, incomplete HTTP body and invalid UTF-8 fail closed', async t => {
  const blocked = await fixture(t, ({ req }) => req.url.endsWith('/completions'));
  const controller = new AbortController(), provider = new LocalModelProvider(blocked.config);
  const pending = provider.generate(input({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, code('cancelled'));
  assert.equal(blocked.seen.at(-1).path, '/v1/chat/completions');
  const invalid = await fixture(t, ({ req, res }) => {
    if (!req.url.endsWith('/completions')) return false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125])); return true;
  });
  await assert.rejects(new LocalModelProvider(invalid.config).generate(input()), code('invalid_response'));
  const partial = await fixture(t, ({ req, res }) => {
    if (!req.url.endsWith('/completions')) return false;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 300 }); res.write('{"model":');
    setTimeout(() => res.destroy(), 5); return true;
  });
  await assert.rejects(new LocalModelProvider(partial.config).generate(input()), code('invalid_response'));
});

test('one total deadline covers successful tokenize followed by stalled generation', async t => {
  const { config, seen } = await fixture(t, ({ req }) => req.url.endsWith('/completions'));
  const started = Date.now();
  await assert.rejects(new LocalModelProvider(config).generate(input({ timeoutMs: 100 })), code('timeout'));
  assert.deepEqual(seen.map(r => r.path), ['/tokenize', '/v1/chat/completions']);
  assert.ok(Date.now() - started < 1000, 'The generation deadline must not use the default 2-second budget');
});

test('caller mutation while tokenization is in flight cannot change generated context/schema', async t => {
  const data = { clause: '1.1. Исходный текст' }, mutableSchema = structuredClone(schema);
  const request = input({ data, jsonSchema: mutableSchema });
  const { config, seen } = await fixture(t, ({ req }) => {
    if (req.url === '/tokenize') { data.clause = 'SUPER_SECRET mutation'; mutableSchema.properties.ok.type = 'string'; }
    return false;
  });
  assert.deepEqual((await new LocalModelProvider(config).generate(request)).json, { ok: true });
  assert.deepEqual(seen[0].body.messages, seen[1].body.messages);
  assert.ok(!JSON.stringify(seen[1].body).includes('SUPER_SECRET'));
  assert.equal(seen[1].body.response_format.json_schema.schema.properties.ok.type, 'boolean');
});

test('temporary mode needs deployment retention attestation and uses unique cache salt', async t => {
  const { config, seen } = await fixture(t);
  await assert.rejects(new LocalModelProvider({ ...config, temporaryPolicy: undefined }).generate(input({ temporary: true })), code('capability_error'));
  assert.equal(seen.length, 0);
  const provider = new LocalModelProvider(config);
  await provider.generate(input({ temporary: true })); await provider.generate(input({ temporary: true }));
  const generated = seen.filter(r => r.path.endsWith('/completions')).map(r => r.body);
  assert.notEqual(generated[0].cache_salt, generated[1].cache_salt);
  assert.equal(JSON.stringify(provider.describe()).includes('SUPER_SECRET'), false);
});
