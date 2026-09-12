import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/main.mjs';
import { rules } from '../server/rules.mjs';

const fake = fileURLToPath(new URL('./fake-codex.py', import.meta.url));
const auth = JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-test-only'}});
// Valid 10-digit INN (check digit verified): 7707083893.
const inn = '7707083893';

async function until(check) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for test condition');
}

async function fixture(t, codexAdmin = 'owner') {
  const dir = await mkdtemp(join(tmpdir(), 'docs-lookup-'));
  const options = { dir, origin: 'http://127.0.0.1:3107', sandbox: false, autoTick: false, codexAdmin, codex: fake };
  let app, base;
  async function start() {
    app = await createApp(options);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}/docs/api`;
  }
  await start();
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, data, session = '') {
    const res = await fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: options.origin, 'X-Docs-Request': '1', 'Content-Type': 'application/json', Cookie: session },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const owner = await request('/register', { login: 'owner', password: 'test-password-owner' });
  const member = await request('/register', { login: 'member', password: 'test-password-member' });
  assert.equal(owner.status, 200);
  assert.equal(member.status, 200);
  async function connectCodex() {
    await mkdir(app.runner.home(), { recursive: true, mode: 0o700 });
    await writeFile(join(app.runner.home(), 'auth.json'), auth, { mode: 0o600 });
  }
  return {
    get app() { return app; },
    dir, request, owner, member, connectCodex,
    restart: async () => { await new Promise(resolve => app.server.close(resolve)); await start(); }
  };
}

// ── Organization lookup ───────────────────────────────────────────────────────

test('successful organization lookup returns organization data with sources', async t => {
  const f = await fixture(t);
  await f.connectCodex();
  const { request, owner } = f;

  const start = await request('/organizations/lookup', { inn }, owner.cookie);
  assert.equal(start.status, 202);
  assert.equal(start.data.status, 'running');
  assert.ok(start.data.id, 'lookup job id returned');

  const jobId = start.data.id;
  await until(async () => {
    const poll = await request(`/organizations/lookup/${jobId}`, undefined, owner.cookie);
    return poll.data.status === 'complete';
  });

  const done = await request(`/organizations/lookup/${jobId}`, undefined, owner.cookie);
  assert.equal(done.status, 200);
  assert.equal(done.data.status, 'complete');

  const result = done.data.result;
  assert.equal(result.inn, inn);
  assert.equal(result.name, 'Организация из тестового поиска');
  assert.equal(result.address, 'Тестовый адрес');
  assert.ok(Array.isArray(result.sources), 'result includes sources array');
  assert.ok(result.sources.length >= 2, 'at least two sources returned');

  // Each source has field, url, title, quote, checkedAt, status.
  for (const s of result.sources) {
    assert.ok(s.field, 'source has field');
    assert.ok(s.url, 'source has url');
    assert.ok(s.title, 'source has title');
    assert.ok(s.quote, 'source has quote');
    assert.equal(s.status, 'unverified');
    assert.ok(s.checkedAt, 'source has checkedAt timestamp');
  }

  // The name source must reference the requested INN (privacy + correctness check
  // enforced by fake-codex.py: only `inn` is sent, never private data).
  const nameSource = result.sources.find(s => s.field === 'name');
  assert.ok(nameSource, 'name source present');
  assert.ok(nameSource.quote.includes(inn), 'name source quote includes the INN');

  // Fields without backing sources are cleared by lookupResult().
  assert.equal(result.legalName, '', 'legalName cleared without source');
  assert.equal(result.ogrn, '', 'ogrn cleared without source');
  assert.equal(result.kpp, '', 'kpp cleared without source');

  // note and searchedAt are populated.
  assert.ok(typeof result.note === 'string', 'note is a string');
  assert.ok(result.searchedAt, 'searchedAt timestamp present');
});

test('organization lookup without connection returns 409', async t => {
  const f = await fixture(t);
  // Do NOT write auth.json — runner stays disconnected.
  const res = await f.request('/organizations/lookup', { inn }, f.owner.cookie);
  assert.equal(res.status, 409);
  assert.ok(res.data.error, 'error message returned');
});

test('organization lookup with invalid INN returns 400', async t => {
  const f = await fixture(t);
  await f.connectCodex();

  // Too short.
  const short = await f.request('/organizations/lookup', { inn: '123' }, f.owner.cookie);
  assert.equal(short.status, 400);

  // Wrong check digit.
  const bad = await f.request('/organizations/lookup', { inn: '7707083890' }, f.owner.cookie);
  assert.equal(bad.status, 400);

  // All zeros.
  const zeros = await f.request('/organizations/lookup', { inn: '0000000000' }, f.owner.cookie);
  assert.equal(zeros.status, 400);
});

test('organization lookup while runner is busy returns 409', async t => {
  const f = await fixture(t);
  await f.connectCodex();
  // Simulate a busy runner without starting a real process.
  f.app.runner.busy = true;
  t.after(() => { f.app.runner.busy = false; });

  const res = await f.request('/organizations/lookup', { inn }, f.owner.cookie);
  assert.equal(res.status, 409);
});

test('organization lookup job is scoped to the requesting user', async t => {
  const f = await fixture(t);
  await f.connectCodex();

  const start = await f.request('/organizations/lookup', { inn }, f.owner.cookie);
  assert.equal(start.status, 202);
  const jobId = start.data.id;

  // A different user cannot see or cancel the owner's lookup job.
  const other = await f.request(`/organizations/lookup/${jobId}`, undefined, f.member.cookie);
  assert.equal(other.status, 404);

  const cancelOther = await f.request(`/organizations/lookup/${jobId}`, {}, f.member.cookie);
  assert.equal(cancelOther.status, 404);
});

test('organization lookup result can be used to create an organization', async t => {
  const f = await fixture(t);
  await f.connectCodex();
  const { request, owner } = f;

  const start = await request('/organizations/lookup', { inn }, owner.cookie);
  assert.equal(start.status, 202);
  const jobId = start.data.id;

  await until(async () => {
    const poll = await request(`/organizations/lookup/${jobId}`, undefined, owner.cookie);
    return poll.data.status === 'complete';
  });

  const done = await request(`/organizations/lookup/${jobId}`, undefined, owner.cookie);
  const result = done.data.result;

  const orgInput = {
    lookupId: jobId,
    inn,
    name: result.name,
    legalName: result.legalName,
    ogrn: result.ogrn,
    kpp: result.kpp,
    address: result.address,
    base: result.base,
    website: result.website,
    capabilities: result.capabilities,
    claimed: result.claimed,
    unverified: result.unverified
  };
  const created = await request('/organizations', orgInput, owner.cookie);
  assert.equal(created.status, 201);
  assert.equal(created.data.name, 'Организация из тестового поиска');
  assert.equal(created.data.inn, inn);
});

// ── Error recovery ────────────────────────────────────────────────────────────

test('CLI exit code non-zero during review sets analysis status to error', async t => {
  const f = await fixture(t);
  const app = f.app;
  await f.connectCodex();

  const stamp = new Date().toISOString();
  // FAIL_REVIEW in the document text causes fake-codex.py to exit(1) during review.
  const snapshot = {
    documents: [{ id: 'doc1', blocks: [{ id: 'b1', text: 'FAIL_REVIEW Только тестовые данные.' }] }],
    rules
  };
  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)')
    .run('c-err', f.owner.data.id, 'Тест ошибки', 'contractor-err', 'template', stamp);
  app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
    .run('r-err', 'c-err', 1, null, '[]', 'Тест', stamp);
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .run('a-err', f.owner.data.id, 'c-err', 'r-err', 'queued', JSON.stringify(snapshot), stamp, stamp);

  await app.runner.tick();

  const row = app.db.prepare('SELECT status, error FROM analyses WHERE id=?').get('a-err');
  assert.equal(row.status, 'error', 'analysis status is error after CLI failure');
  assert.ok(row.error, 'error field is populated');
  assert.ok(row.error.includes('Codex'), 'error message references Codex');
});

test('after error, tick picks next queued analysis and does not retry the failed one', async t => {
  const f = await fixture(t);
  const app = f.app;
  await f.connectCodex();

  const stamp = new Date().toISOString();
  const failSnapshot = {
    documents: [{ id: 'doc-fail', blocks: [{ id: 'b1', text: 'FAIL_REVIEW Тестовые данные для ошибки.' }] }],
    rules
  };
  const okSnapshot = {
    documents: [{ id: 'doc-ok', blocks: [{ id: 'b1', text: 'Обычные тестовые данные без маркеров.' }] }],
    rules
  };

  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)')
    .run('c-fail', f.owner.data.id, 'Тест ошибка', 'contractor-a', 'template', stamp);
  app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
    .run('r-fail', 'c-fail', 1, null, '[]', 'Тест', stamp);
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .run('a-fail', f.owner.data.id, 'c-fail', 'r-fail', 'queued', JSON.stringify(failSnapshot), stamp, stamp);

  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)')
    .run('c-ok', f.member.data.id, 'Тест успех', 'contractor-b', 'template', stamp);
  app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
    .run('r-ok', 'c-ok', 1, null, '[]', 'Тест', stamp);
  // Create the second analysis slightly later so ordering is deterministic.
  const laterStamp = new Date(Date.now() + 1000).toISOString();
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .run('a-ok', f.member.data.id, 'c-ok', 'r-ok', 'queued', JSON.stringify(okSnapshot), laterStamp, laterStamp);

  // First tick processes a-fail: primary succeeds, review exits 1 → error.
  await app.runner.tick();
  const failed = app.db.prepare('SELECT status, error FROM analyses WHERE id=?').get('a-fail');
  assert.equal(failed.status, 'error', 'first analysis errored');

  // a-ok must still be queued — tick does not process two jobs in one call.
  const pending = app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a-ok');
  assert.equal(pending.status, 'queued', 'second analysis still queued after first failed');

  // Second tick picks up a-ok and completes it successfully.
  await app.runner.tick();
  const completed = app.db.prepare('SELECT status, error, review_result FROM analyses WHERE id=?').get('a-ok');
  assert.equal(completed.status, 'complete', 'second analysis completed after retry tick');
  assert.equal(completed.error, null, 'no error on successful analysis');
  assert.ok(completed.review_result, 'review result is populated');

  // The failed analysis was not retried — it stays in error.
  const stillFailed = app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a-fail');
  assert.equal(stillFailed.status, 'error', 'failed analysis remains in error state');
});

// ── Cancel during execution ───────────────────────────────────────────────────

test('cancel stops active child process and sets status to cancelled', async t => {
  const f = await fixture(t);
  const app = f.app;
  await f.connectCodex();

  const stamp = new Date().toISOString();
  // SLOW_PRIMARY makes fake-codex.py sleep for 10 seconds, giving us time to cancel.
  const snapshot = {
    documents: [{ id: 'doc-slow', blocks: [{ id: 'b1', text: 'SLOW_PRIMARY Только тестовые данные для отмены.' }] }],
    rules
  };
  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)')
    .run('c-cancel', f.owner.data.id, 'Тест отмены', 'contractor-cancel', 'template', stamp);
  app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
    .run('r-cancel', 'c-cancel', 1, null, '[]', 'Тест', stamp);
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .run('a-cancel', f.owner.data.id, 'c-cancel', 'r-cancel', 'queued', JSON.stringify(snapshot), stamp, stamp);

  // Start tick in the background — it will pick up a-cancel and enter SLOW_PRIMARY.
  const running = app.runner.tick();

  // Wait for the child process to actually start (primary-started marker file).
  await until(async () => {
    try { await stat(join(app.runner.home(), 'primary-started')); return true; } catch { return false; }
  });

  // The runner should have an active child process now.
  assert.ok(app.runner.active, 'runner has an active child process');
  assert.equal(app.runner.active.analysis, 'a-cancel', 'active analysis matches');

  // Cancel via the API.
  const cancel = await f.request('/analyses/a-cancel/cancel', {}, f.owner.cookie);
  assert.equal(cancel.status, 200);

  // Wait for the tick to finish (child is killed, tick resolves).
  await running;

  const row = app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a-cancel');
  assert.equal(row.status, 'cancelled', 'analysis status is cancelled after cancel');
  assert.equal(app.runner.active, null, 'runner has no active child after cancel');
});

test('cancel by one user does not affect another users queued analysis', async t => {
  const f = await fixture(t);
  const app = f.app;
  await f.connectCodex();

  const stamp = new Date().toISOString();
  const slowSnapshot = {
    documents: [{ id: 'doc-slow', blocks: [{ id: 'b1', text: 'SLOW_PRIMARY Тестовые данные владельца.' }] }],
    rules
  };
  const normalSnapshot = {
    documents: [{ id: 'doc-normal', blocks: [{ id: 'b1', text: 'Обычные тестовые данные участника.' }] }],
    rules
  };

  // Owner gets a slow analysis.
  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)')
    .run('c-owner', f.owner.data.id, 'Тест владелец', 'contractor-owner', 'template', stamp);
  app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
    .run('r-owner', 'c-owner', 1, null, '[]', 'Тест', stamp);
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .run('a-owner', f.owner.data.id, 'c-owner', 'r-owner', 'queued', JSON.stringify(slowSnapshot), stamp, stamp);

  // Member gets a normal analysis, created slightly later.
  const laterStamp = new Date(Date.now() + 1000).toISOString();
  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)')
    .run('c-member', f.member.data.id, 'Тест участник', 'contractor-member', 'template', laterStamp);
  app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
    .run('r-member', 'c-member', 1, null, '[]', 'Тест', laterStamp);
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .run('a-member', f.member.data.id, 'c-member', 'r-member', 'queued', JSON.stringify(normalSnapshot), laterStamp, laterStamp);

  // Start processing the owner's slow analysis.
  const running = app.runner.tick();
  await until(async () => {
    try { await stat(join(app.runner.home(), 'primary-started')); return true; } catch { return false; }
  });

  // Cancel the owner's analysis.
  const cancel = await f.request('/analyses/a-owner/cancel', {}, f.owner.cookie);
  assert.equal(cancel.status, 200);
  await running;

  // Owner's analysis is cancelled.
  const ownerRow = app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a-owner');
  assert.equal(ownerRow.status, 'cancelled', 'owner analysis cancelled');

  // Member's analysis is still queued — unaffected by the owner's cancel.
  const memberRow = app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a-member');
  assert.equal(memberRow.status, 'queued', 'member analysis still queued after owner cancel');

  // Member cannot cancel the owner's analysis (ownership check).
  const crossCancel = await f.request('/analyses/a-owner/cancel', {}, f.member.cookie);
  assert.equal(crossCancel.status, 404, 'member cannot cancel owners analysis');

  // Next tick processes the member's analysis successfully.
  await app.runner.tick();
  const memberDone = app.db.prepare('SELECT status, error FROM analyses WHERE id=?').get('a-member');
  assert.equal(memberDone.status, 'complete', 'member analysis completes on next tick');
});

test('cancel returns no-op for non-matching user without killing the process', async t => {
  const f = await fixture(t);
  const app = f.app;
  await f.connectCodex();

  const stamp = new Date().toISOString();
  const snapshot = {
    documents: [{ id: 'doc-slow2', blocks: [{ id: 'b1', text: 'SLOW_PRIMARY Тестовые данные для проверки прав доступа.' }] }],
    rules
  };
  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)')
    .run('c-own', f.owner.data.id, 'Тест прав', 'contractor-x', 'template', stamp);
  app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
    .run('r-own', 'c-own', 1, null, '[]', 'Тест', stamp);
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .run('a-own', f.owner.data.id, 'c-own', 'r-own', 'queued', JSON.stringify(snapshot), stamp, stamp);

  const running = app.runner.tick();
  await until(async () => {
    try { await stat(join(app.runner.home(), 'primary-started')); return true; } catch { return false; }
  });

  // Direct runner.cancel with wrong user: returns immediately, child stays alive.
  await app.runner.cancel(f.member.data.id, 'a-own');
  assert.ok(app.runner.active, 'child process still running after wrong-user cancel');

  // Clean up: cancel with the correct user so the tick can finish.
  await app.runner.cancel(f.owner.data.id, 'a-own');
  await running;
  assert.equal(app.runner.active, null, 'child stopped after correct-user cancel');
});
