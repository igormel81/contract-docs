import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/main.mjs';
import { rules } from '../server/rules.mjs';

const fake = fileURLToPath(new URL('./fake-codex.py', import.meta.url));
const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake-test-only' } });

async function until(check) {
  for (let n = 0; n < 100; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for test process');
}

async function setupAuth(app) {
  await mkdir(app.runner.home(), { recursive: true, mode: 0o700 });
  await writeFile(join(app.runner.home(), 'auth.json'), auth);
  await until(() => app.runner.status().then(s => s.connected));
}

function seedAnalysis(app, id, userId, snapshot, status = 'queued') {
  const stamp = new Date().toISOString();
  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)').run('c-' + id, userId, 'Test', 'test-contractor', 'template', stamp);
  app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)').run('r-' + id, 'c-' + id, 1, null, '[]', 'Test', stamp);
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(id, userId, 'c-' + id, 'r-' + id, status, JSON.stringify(snapshot), stamp, stamp);
  return stamp;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'docs-execute-'));
  const options = { dir, origin: 'http://127.0.0.1:3107', sandbox: false, autoTick: false, codexAdmin: 'owner', codex: fake };
  const app = await createApp(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.runner.stop();
    await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const userId = app.db.prepare("INSERT INTO users VALUES(?,?,?,?) RETURNING id").get('u-owner', 'owner', 'dummy-hash', new Date().toISOString()).id;
  const snapshot = { documents: [{ id: 'fixture', blocks: [{ id: 'b1', text: 'Только искусственные тестовые данные.' }] }], rules };
  return { app, dir, userId, snapshot };
}

// --- execute() ---

test('execute() primary stage returns findings and passport', async t => {
  const { app, userId, snapshot } = await fixture(t);
  await setupAuth(app);
  seedAnalysis(app, 'a-primary', userId, snapshot);

  const result = await app.runner.execute(userId, 'a-primary', snapshot, 'primary');

  assert.ok(result.findings, 'result has findings');
  assert.ok(result.findings.length > 0, 'findings not empty');
  assert.equal(result.findings[0].id, 'test-finding');
  assert.equal(result.findings[0].rule, 'LOC-01');
  assert.equal(result.findings[0].review, 'primary');
  assert.ok(Array.isArray(result.passport), 'passport is array');
  assert.equal(result.passport.length, 9, 'passport has 9 fields');
  assert.ok(result.execution, 'has execution info');
  assert.equal(result.execution.stage, 'primary');
  assert.ok(result.execution.usage, 'has usage');
  assert.equal(result.execution.usage.input_tokens, 1);
  assert.equal(result.execution.usage.output_tokens, 1);
  assert.ok(result.execution.durationMs >= 0, 'has duration');
  assert.ok(result.execution.completed, 'has completed timestamp');
  assert.ok(result.execution.promptChars > 0, 'has prompt char count');
});

test('execute() review stage returns verified findings', async t => {
  const { app, userId, snapshot } = await fixture(t);
  await setupAuth(app);
  seedAnalysis(app, 'a-review', userId, snapshot);

  const primary = await app.runner.execute(userId, 'a-review', snapshot, 'primary');
  app.db.prepare("UPDATE analyses SET primary_result=?,status='review',updated=? WHERE id=?").run(
    JSON.stringify(primary), new Date().toISOString(), 'a-review');

  const review = await app.runner.execute(userId, 'a-review', snapshot, 'review', primary);

  assert.ok(review.findings, 'review has findings');
  assert.ok(review.findings.length > 0, 'review findings not empty');
  assert.equal(review.findings[0].review, 'confirmed', 'finding confirmed by reviewer');
  assert.equal(review.findings[0].id, 'test-finding');
  assert.ok(review.changes.length > 0, 'review has changes');
  assert.equal(review.execution.stage, 'review');
  assert.ok(review.execution.usage, 'review has usage');
});

test('execute() qualification stage returns only qualifications', async t => {
  const { app, userId, snapshot } = await fixture(t);
  await setupAuth(app);
  seedAnalysis(app, 'a-qual', userId, snapshot);

  const result = await app.runner.execute(userId, 'a-qual', snapshot, 'qualification');

  assert.ok(result.qualifications, 'has qualifications');
  assert.ok(result.qualifications.length > 0, 'qualifications not empty');
  assert.equal(result.qualifications[0].type, 'works');
  assert.equal(result.qualifications[0].confidence, 'high');
  assert.ok(result.qualifications[0].sources.length > 0, 'qualification has sources');
  assert.equal(result.findings, undefined, 'no findings in qualification result');
  assert.equal(result.passport, undefined, 'no passport in qualification result');
});

test('execute() with context.temporary passes ephemeral flag and cleans up', async t => {
  const { app, dir, userId } = await fixture(t);
  await setupAuth(app);
  const snapshot = {
    documents: [{ id: 'fixture', blocks: [{ id: 'b1', text: 'Только искусственные тестовые данные.' }] }],
    rules, temporary: true
  };
  seedAnalysis(app, 'a-temp', userId, snapshot);

  const result = await app.runner.execute(userId, 'a-temp', snapshot, 'primary', null, { temporary: true });

  assert.ok(result.findings, 'temp execute returns findings');
  assert.ok(result.execution, 'temp execute has execution info');
  // fake-codex validates --ephemeral flag, history.persistence="none", TMPDIR and RUST_LOG=off;
  // a successful result proves all assertions passed. Verify temp dir cleanup:
  const jobDir = join(dir, 'jobs', 'a-temp', 'primary');
  await assert.rejects(stat(jobDir), { code: 'ENOENT' }, 'temporary job directory removed after execute');
});

// --- tick() ---

test('tick() processes queued analysis through full cycle', async t => {
  const { app, userId, snapshot } = await fixture(t);
  await setupAuth(app);
  seedAnalysis(app, 'a-tick', userId, snapshot);

  const tickPromise = app.runner.tick();

  // Wait for primary stage to start (status set synchronously before execute)
  await until(() => {
    const row = app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a-tick');
    return row && row.status === 'primary';
  });

  await tickPromise;

  const row = app.db.prepare('SELECT status, primary_result, review_result, error FROM analyses WHERE id=?').get('a-tick');
  assert.equal(row.status, 'complete');
  assert.ok(row.primary_result, 'primary_result stored');
  assert.ok(row.review_result, 'review_result stored');
  assert.equal(row.error, null, 'no error after success');

  const primary = JSON.parse(row.primary_result);
  assert.ok(primary.findings, 'stored primary has findings');
  const review = JSON.parse(row.review_result);
  assert.ok(review.findings, 'stored review has findings');
  assert.equal(review.findings[0].review, 'confirmed');
});

test('tick() sets error status when review fails', async t => {
  const { app, userId } = await fixture(t);
  await setupAuth(app);
  const snapshot = {
    documents: [{ id: 'fixture', blocks: [{ id: 'b1', text: 'FAIL_REVIEW Только искусственные тестовые данные.' }] }],
    rules
  };
  seedAnalysis(app, 'a-fail', userId, snapshot);

  await app.runner.tick();

  const row = app.db.prepare('SELECT status, error, primary_result FROM analyses WHERE id=?').get('a-fail');
  assert.equal(row.status, 'error');
  assert.ok(row.error, 'error field populated');
  assert.ok(row.error.includes('Codex'), 'error message mentions Codex');
  assert.ok(row.primary_result, 'primary_result preserved despite review failure');
});

test('tick() after error picks next queued analysis', async t => {
  const { app, userId } = await fixture(t);
  await setupAuth(app);
  const failSnapshot = {
    documents: [{ id: 'fixture', blocks: [{ id: 'b1', text: 'FAIL_REVIEW Только искусственные тестовые данные.' }] }],
    rules
  };
  const goodSnapshot = {
    documents: [{ id: 'fixture', blocks: [{ id: 'b1', text: 'Только искусственные тестовые данные.' }] }],
    rules
  };
  seedAnalysis(app, 'a-err', userId, failSnapshot);
  await app.runner.tick();
  assert.equal(app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a-err').status, 'error');

  // Add a new queued analysis after the failure
  const stamp = new Date().toISOString();
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(
    'a-next', userId, 'c-a-err', 'r-a-err', 'queued', JSON.stringify(goodSnapshot), stamp, stamp);

  await app.runner.tick();

  assert.equal(app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a-err').status, 'error', 'failed analysis unchanged');
  assert.equal(app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a-next').status, 'complete', 'next analysis completed');
  assert.ok(app.db.prepare('SELECT review_result FROM analyses WHERE id=?').get('a-next').review_result, 'next analysis has review');
});

// --- proposal() ---

test('proposal() returns proposal text, note, and usage', async t => {
  const { app } = await fixture(t);
  await setupAuth(app);

  const result = await app.runner.proposal({
    profile: { name: 'Test' },
    rule: { id: 'LOC-01', title: 'Места работ' },
    finding: { rule: 'LOC-01', title: 'Test', description: 'Test', severity: 'medium', legalSources: [] },
    legal: null,
    clauses: [{ document: 'test.pdf', clause: '1.1', text: 'Место выполнения работ.' }]
  });

  assert.ok(typeof result.proposal === 'string', 'proposal is a string');
  assert.ok(result.proposal.length > 0, 'proposal not empty');
  assert.ok(result.proposal.length <= 15000, 'proposal within char limit');
  assert.ok(typeof result.note === 'string', 'note is a string');
  assert.ok(result.note.length <= 2000, 'note within char limit');
  assert.ok(result.note.includes('LOC-01'), 'note references the rule');
  assert.ok(result.usage, 'has usage info');
  assert.equal(result.usage.input_tokens, 1);
  assert.equal(result.usage.output_tokens, 1);
});

test('proposal() without connection throws 409', async t => {
  const { app } = await fixture(t);
  // No auth.json written — runner is disconnected

  await assert.rejects(
    app.runner.proposal({
      profile: { name: 'Test' },
      rule: { id: 'LOC-01' },
      finding: { rule: 'LOC-01', title: 'Test', description: 'Test', severity: 'medium', legalSources: [] },
      legal: null,
      clauses: []
    }),
    err => err.status === 409
  );
});

test('proposal() while execute is busy throws 409', async t => {
  const { app, userId } = await fixture(t);
  await setupAuth(app);
  const snapshot = {
    documents: [{ id: 'fixture', blocks: [{ id: 'b1', text: 'SLOW_PRIMARY Только искусственные тестовые данные.' }] }],
    rules
  };
  seedAnalysis(app, 'a-slow', userId, snapshot);

  // Start tick — it sets busy=true for the entire cycle
  const running = app.runner.tick();

  // Wait for the primary stage to start (fake-codex creates primary-started file and sleeps 10s)
  await until(async () => {
    try { await stat(join(app.runner.home(), 'primary-started')); return true; } catch { return false; }
  });

  // Runner is busy — proposal must reject with 409
  await assert.rejects(
    app.runner.proposal({
      profile: { name: 'Test' },
      rule: { id: 'LOC-01' },
      finding: { rule: 'LOC-01', title: 'Test', description: 'Test', severity: 'medium', legalSources: [] },
      legal: null,
      clauses: []
    }),
    err => err.status === 409
  );
});
