import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/main.mjs';
import { rules } from '../server/rules.mjs';
import { createProgressiveAnalysis } from '../server/progressive-analysis.mjs';

// In-memory double for a cloud provider (OpenAICompatibleProvider/AnthropicProvider
// shape): exercises the CloudRunner queue/stage glue (server/cloud-runner.mjs)
// without any network call. Each concrete provider's own HTTP behaviour is
// covered in test/openai-compatible-provider.test.mjs, test/anthropic-provider.test.mjs
// and the main.mjs wiring seam in test/cloud-provider-wiring.test.mjs.
const identity = { provider: 'openai', model: 'test-model' };

function fakeProvider(capture) {
  return {
    describe() { return { ...identity }; },
    async health() { return { ready: true, ...this.describe(), generationProbed: true }; },
    async generate({ stage, data }) {
      capture?.push({ stage, data });
      if (stage === 'proposal') {
        return { json: { proposal: 'Стороны согласовывают перечень площадок и оплату выездов.', note: 'Тестовая формулировка.' },
          finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, model: identity.model, revisionsAttested: false, inputTokens: 1 };
      }
      const fields = ['subject','result','term','price','payment','location','acceptance','dependencies','special'];
      const document = data.documents[0], block = document.blocks[0];
      const passport = fields.map(key => ({ key, title: key, value: 'Не найдено', status: 'missing', sources: [] }));
      passport[0] = { ...passport[0], value: block.text, status: 'extracted', sources: [{ fileId: document.id, blockId: block.id, quote: block.text }] };
      const coverage = data.rules.filter(r => r.coverage !== false).map(r => ({ rule: r.id, status: 'needs_data', note: 'Тест' }));
      const limitations = ['Тестовая модель, не настоящий анализ'];
      const qualifications = [{ type: 'works', sources: passport[0].sources, confidence: 'high', note: 'Тестовая квалификация по предмету договора.', legalModules: [] }];
      let json;
      if (stage === 'qualification') {
        json = { qualifications };
      } else if (stage === 'review') {
        const findings = data.primaryResult.findings;
        json = { summary: 'Только тестовая сводка', passport, coverage, limitations, changes: ['Проверен тестовый результат'], qualifications,
          verdicts: findings.map(f => ({ id: f.id, verdict: 'confirmed', reason: 'Цитата и пункт совпали с исходником.', title: '', description: '', severity: '', legalType: '', proposal: '', sources: [], legalSources: [] })),
          added: [] };
      } else {
        json = { summary: 'Только тестовая сводка', qualifications, passport, coverage, limitations, changes: [],
          findings: [{ id: 'test-finding', rule: 'LOC-01', title: 'Тестовый риск места работ', severity: 'medium',
            description: 'Искусственное замечание для проверки привязки к исходнику.', sources: passport[0].sources,
            legalSources: [], legalType: 'not_applicable', proposal: 'Уточнить порядок согласования места выполнения работ.', review: 'primary' }] };
      }
      return { json, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        model: identity.model, revisionsAttested: false, inputTokens: 1 };
    }
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'docs-cloud-runner-'));
  const capture = [];
  const options = { dir, origin: 'http://127.0.0.1:3107', sandbox: false, autoTick: false, codexAdmin: 'owner',
    modelProvider: 'openai', cloud: { provider: fakeProvider(capture) } };
  const app = await createApp(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.runner.stop();
    await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const userId = app.db.prepare("INSERT INTO users VALUES(?,?,?,?) RETURNING id").get('u-owner', 'owner', 'dummy-hash', new Date().toISOString()).id;
  const snapshot = { documents: [{ id: 'fixture', blocks: [{ id: 'b1', text: 'Только искусственные тестовые данные.' }] }],
    rules, analysisContractVersion: 'legal-v2', inference: app.runner.describe() };
  return { app, dir, userId, snapshot, capture };
}

function seedAnalysis(app, id, userId, snapshot, status = 'queued') {
  const stamp = new Date().toISOString();
  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)').run('c-' + id, userId, 'Test', 'test-contractor', 'template', stamp);
  app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)').run('r-' + id, 'c-' + id, 1, null, '[]', 'Test', stamp);
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,progress,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, userId, 'c-' + id, 'r-' + id, status, JSON.stringify(snapshot), JSON.stringify(createProgressiveAnalysis({ analysisId: id, at: stamp })), stamp, stamp);
  return stamp;
}

test('createApp wires CloudRunner when modelProvider is a cloud vendor', async t => {
  const { app } = await fixture(t);
  assert.equal(app.runner.constructor.name, 'CloudRunner');
  assert.deepEqual(app.runner.describe(), identity);
  assert.equal((await app.runner.status()).connected, true);
  assert.equal((await app.runner.status()).provider, 'openai');
});

test('execute() qualification stage returns only qualifications, with no execution wrapper', async t => {
  const { app, userId, snapshot } = await fixture(t);
  seedAnalysis(app, 'a-qual', userId, snapshot);
  const result = await app.runner.execute(userId, 'a-qual', snapshot, 'qualification');
  assert.ok(Array.isArray(result.qualifications));
  assert.ok(result.qualifications.length > 0);
  assert.equal(result.execution, undefined);
  assert.equal(result.findings, undefined);
});

test('execute() rejects a pin mismatch (different model than the running instance)', async t => {
  const { app, userId, snapshot } = await fixture(t);
  const staleSnapshot = { ...snapshot, inference: { provider: 'openai', model: 'a-different-model' } };
  seedAnalysis(app, 'a-stale', userId, staleSnapshot);
  await assert.rejects(
    app.runner.execute(userId, 'a-stale', staleSnapshot, 'qualification'),
    err => err.status === 409);
});

test('execute() rejects an unsupported stage (organization lookup is not available in cloud mode)', async t => {
  const { app, userId, snapshot } = await fixture(t);
  seedAnalysis(app, 'a-org', userId, snapshot);
  await assert.rejects(app.runner.organizationLookup(userId, 'a-org', '7707083893', () => true), err => err.status === 409);
});

test('tick() drives a queued legal-v2 analysis through the full progressive cycle to completion', async t => {
  const { app, userId, snapshot } = await fixture(t);
  seedAnalysis(app, 'a-tick', userId, snapshot);

  await app.runner.tick();

  const row = app.db.prepare('SELECT status, primary_result, review_result, error, progress FROM analyses WHERE id=?').get('a-tick');
  assert.equal(row.error, null);
  assert.equal(row.status, 'complete');
  const primary = JSON.parse(row.primary_result);
  assert.ok(primary.findings.length > 0);
  assert.ok(primary.qualifications.length > 0);
  const review = JSON.parse(row.review_result);
  assert.ok(review.findings.length > 0);
  assert.equal(review.findings[0].review, 'confirmed');
  const progress = JSON.parse(row.progress);
  assert.equal(progress.status, 'complete');
  for (const phase of ['qualification', 'contract_risks', 'legal_modules', 'review']) {
    assert.equal(progress.phases[phase].status, 'completed', `${phase} phase recorded as completed`);
  }
});

test('proposal() returns text and usage, and is refused while busy', async t => {
  const { app } = await fixture(t);
  const result = await app.runner.proposal({
    inference: app.runner.describe(),
    profile: { name: 'Test' }, rule: { id: 'LOC-01', title: 'Места работ' },
    finding: { rule: 'LOC-01', title: 'Test', description: 'Test', severity: 'medium', legalSources: [] },
    legal: null, clauses: [{ document: 'test.pdf', clause: '1.1', text: 'Место выполнения работ.' }],
  });
  assert.ok(typeof result.proposal === 'string' && result.proposal.length > 0, 'proposal text returned');
  assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 1 });
  assert.equal(result.execution.provider, 'openai');
});

test('login() is refused; cloud mode does not use Codex device-auth', async t => {
  const { app } = await fixture(t);
  await assert.rejects(app.runner.login(), err => err.status === 409);
  assert.throws(() => app.runner.home(), err => err.status === 409);
});

test('logout() cancels an analysis sitting in the qualification phase', async t => {
  const { app, userId, snapshot } = await fixture(t);
  seedAnalysis(app, 'a-stuck', userId, snapshot, 'qualification');

  await app.runner.logout();

  const row = app.db.prepare('SELECT status, error FROM analyses WHERE id=?').get('a-stuck');
  assert.equal(row.status, 'cancelled');
  assert.ok(row.error);
});
