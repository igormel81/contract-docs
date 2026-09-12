import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/main.mjs';
import { rules } from '../server/rules.mjs';
import { createProgressiveAnalysis } from '../server/progressive-analysis.mjs';

// In-memory double for LocalModelProvider: exercises the LocalRunner queue/stage
// glue (server/local-runner.mjs) without a real vLLM server. The HTTP transport
// itself is covered separately in test/local-provider.test.mjs.
const identity = { provider: 'local', profile: 'vllm-chat', model: 'test-model', modelRevision: 'rev-1',
  tokenizerRevision: 'tok-1', chatTemplateSha256: 'a'.repeat(64), contextWindow: 32000 };

function fakeProvider(capture) {
  return {
    describe() { return { ...identity }; },
    async health() { return { ready: true, ...this.describe(), generationProbed: true }; },
    async generate({ stage, data }) {
      capture?.push({ stage, data });
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
        modelRevision: identity.modelRevision, tokenizerRevision: identity.tokenizerRevision,
        chatTemplateSha256: identity.chatTemplateSha256, inputTokens: 1, revisionsAttested: false };
    }
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'docs-local-runner-'));
  const capture = [];
  const options = { dir, origin: 'http://127.0.0.1:3107', sandbox: false, autoTick: false, codexAdmin: 'owner',
    modelProvider: 'local', local: { provider: fakeProvider(capture) } };
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

test('createApp wires LocalRunner when modelProvider is "local"', async t => {
  const { app } = await fixture(t);
  assert.equal(app.runner.constructor.name, 'LocalRunner');
  assert.deepEqual(app.runner.describe(), identity);
  assert.equal((await app.runner.status()).connected, true);
});

test('execute() qualification stage returns only qualifications, with no execution wrapper', async t => {
  const { app, userId, snapshot } = await fixture(t);
  seedAnalysis(app, 'a-qual', userId, snapshot);
  const result = await app.runner.execute(userId, 'a-qual', snapshot, 'qualification');
  assert.ok(Array.isArray(result.qualifications), 'result has qualifications');
  assert.ok(result.qualifications.length > 0, 'qualifications not empty');
  assert.equal(result.qualifications[0].type, 'works');
  assert.equal(result.execution, undefined, 'qualification stage carries no execution metadata (matches CodexRunner behaviour)');
  assert.equal(result.findings, undefined, 'qualification stage has no findings');
});

test('execute() primary stage forwards preliminaryQualifications from context into the prompt data', async t => {
  const { app, userId, snapshot, capture } = await fixture(t);
  seedAnalysis(app, 'a-primary', userId, snapshot);
  const preliminary = [{ type: 'works', sources: [], confidence: 'high', note: 'Предварительная квалификация.', legalModules: [] }];
  const result = await app.runner.execute(userId, 'a-primary', snapshot, 'primary', null, { preliminaryQualifications: preliminary });
  assert.ok(result.findings.length > 0, 'primary stage returns findings');
  assert.ok(result.execution, 'primary stage has execution metadata');
  assert.equal(result.execution.inference.model, identity.model);
  const primaryCall = capture.find(c => c.stage === 'primary');
  assert.ok(primaryCall, 'provider.generate was called for the primary stage');
  assert.deepEqual(primaryCall.data.preliminaryQualifications, preliminary, 'preliminary qualifications reached the request data (previously silently dropped)');
});

test('tick() drives a queued legal-v2 analysis through qualification, contract_risks, legal_modules and review to completion', async t => {
  const { app, userId, snapshot } = await fixture(t);
  seedAnalysis(app, 'a-tick', userId, snapshot);

  await app.runner.tick();

  const row = app.db.prepare('SELECT status, primary_result, review_result, error, progress FROM analyses WHERE id=?').get('a-tick');
  assert.equal(row.error, null, 'no error after a full progressive cycle');
  assert.equal(row.status, 'complete');
  const primary = JSON.parse(row.primary_result);
  assert.ok(primary.findings.length > 0, 'primary_result has findings');
  assert.ok(primary.qualifications.length > 0, 'primary_result has qualifications');
  const review = JSON.parse(row.review_result);
  assert.ok(review.findings.length > 0, 'review_result has findings');
  assert.equal(review.findings[0].review, 'confirmed');
  const progress = JSON.parse(row.progress);
  assert.equal(progress.status, 'complete');
  for (const phase of ['qualification', 'contract_risks', 'legal_modules', 'review']) {
    assert.equal(progress.phases[phase].status, 'completed', `${phase} phase recorded as completed`);
  }
});

test('logout() cancels an analysis sitting in the qualification phase', async t => {
  const { app, userId, snapshot } = await fixture(t);
  seedAnalysis(app, 'a-stuck', userId, snapshot, 'qualification');

  await app.runner.logout();

  const row = app.db.prepare('SELECT status, error FROM analyses WHERE id=?').get('a-stuck');
  assert.equal(row.status, 'cancelled', 'analysis in the qualification phase is cancelled on logout (previously missed by the status filter)');
  assert.ok(row.error, 'error message populated');
});
