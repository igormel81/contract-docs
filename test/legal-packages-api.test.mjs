import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/main.mjs';
import { legalCorpusDigest, legalPackageSigningPayload } from '../server/legal-packages.mjs';

const fakeCodex = fileURLToPath(new URL('./fake-codex.py', import.meta.url));
const issuer = generateKeyPairSync('ed25519');
const source = {
  publisher: 'Synthetic test publisher', sourceUrl: 'https://government.ru/synthetic-api-test',
  retrievalMethod: 'synthetic_fixture', retrievedAt: '2026-09-06', directFetchStatus: 'unavailable',
  currentEditionVerified: false, normalization: 'Synthetic fixture.'
};
function packageBytes(id, version, textSuffix = '') {
  const corpus = {
    version, status: 'reference_only', checkedAt: '2026-09-06', currentAsOf: null, reviewDueAt: '2026-10-06',
    edition: `Synthetic ${version}`, limitations: ['Synthetic test data only.'], provenance: source,
    norms: [{ id: 'SYNTHETIC-1', title: 'Synthetic norm', article: '1', paragraph: '1', act: 'Synthetic act',
      text: `Synthetic text ${textSuffix}`, topics: ['test'], interpretation: 'Synthetic.' }]
  };
  const envelope = { manifest: { schemaVersion: 1, packageId: id, edition: corpus.edition,
    createdAt: '2026-09-06T10:00:00Z', expiresAt: '2026-10-01T00:00:00Z', sha256: legalCorpusDigest(corpus) },
    corpus, signature: { algorithm: 'Ed25519', keyId: 'test-publisher', value: '' } };
  envelope.signature.value = sign(null, legalPackageSigningPayload(envelope), issuer.privateKey).toString('base64');
  return Buffer.from(JSON.stringify(envelope));
}

test('legal package API enforces manager access, four-eyes approval, digest binding, current snapshot and user-isolated recheck', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-legal-packages-api-'));
  const origin = 'http://127.0.0.1:3207';
  const keyFile = join(root, 'trusted-keys.json');
  const packageDir = join(root, 'legal-packages');
  await writeFile(keyFile, JSON.stringify({ 'test-publisher': issuer.publicKey.export({ type: 'spki', format: 'pem' }) }));
  const app = await createApp({ dir: join(root, 'data'), runtime: join(root, 'runtime'), origin, sandbox: false,
    autoTick: false, codex: fakeCodex,
    legalPackages: { trustedKeysFile: keyFile, directory: packageDir, reviewers: ['manager_a', 'manager_b'] } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/docs/api`;
  async function request(path, data, cookie = '', method = data === undefined ? 'GET' : 'POST', raw = false) {
    const response = await fetch(base + path, { method,
      headers: { Origin: origin, 'X-Docs-Request': '1', ...(raw ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }), Cookie: cookie },
      body: data === undefined ? undefined : raw ? data : JSON.stringify(data) });
    const text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, data: value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const a = await request('/register', { login: 'manager_a', password: 'valid-manager-a-password' });
    const b = await request('/register', { login: 'manager_b', password: 'valid-manager-b-password' });
    const ordinary = await request('/register', { login: 'ordinary_user', password: 'valid-ordinary-password' });
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(ordinary.status, 200);

    const first = await request('/legal-packages', packageBytes('synthetic-p1', 'synthetic-v1'), a.cookie, 'POST', true);
    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal((await request('/legal-packages', undefined, ordinary.cookie)).status, 403);
    assert.equal((await request('/legal-packages/synthetic-p1/approve', { digest: first.data.digest, decision: 'approved', reason: 'Self approval is forbidden.' }, a.cookie)).status, 409);
    assert.equal((await request('/legal-packages/synthetic-p1/approve', { digest: '0'.repeat(64), decision: 'approved', reason: 'Wrong digest.' }, b.cookie)).status, 400);
    const approved = await request('/legal-packages/synthetic-p1/approve', { digest: first.data.digest, decision: 'approved', reason: 'Synthetic review.' }, b.cookie);
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    const activated = await request('/legal-packages/synthetic-p1/activate', { digest: first.data.digest }, a.cookie);
    assert.equal(activated.status, 200, JSON.stringify(activated.data));
    assert.deepEqual(activated.data.recheck.candidates, []);
    const current = await request('/legal-base', undefined, a.cookie);
    assert.equal(current.status, 200); assert.equal(current.data.packageId, 'synthetic-p1');

    // The recheck report must not expose another user's analysis to the actor.
    const oldLegal = app.legalStore.activeCorpus();
    const stamp = new Date().toISOString();
    for (const [id, user] of [['manager-analysis', b.data.id], ['ordinary-analysis', ordinary.data.id]]) {
      app.db.prepare('INSERT INTO analyses(id,user_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?)')
        .run(id, user, 'complete', JSON.stringify({ legal: { ...oldLegal, packageDigest: first.data.digest } }), stamp, stamp);
    }

    const second = await request('/legal-packages', packageBytes('synthetic-p2', 'synthetic-v2', 'changed'), b.cookie, 'POST', true);
    assert.equal(second.status, 201, JSON.stringify(second.data));
    const secondApproval = await request('/legal-packages/synthetic-p2/approve', { digest: second.data.digest, decision: 'approved', reason: 'Synthetic review.' }, a.cookie);
    assert.equal(secondApproval.status, 200, JSON.stringify(secondApproval.data));
    const secondActivation = await request('/legal-packages/synthetic-p2/activate', { digest: second.data.digest }, b.cookie);
    assert.equal(secondActivation.status, 200, JSON.stringify(secondActivation.data));
    assert.deepEqual(secondActivation.data.recheck.candidates.map(item => item.analysisId), ['manager-analysis']);
    assert.equal((await request('/legal-base', undefined, ordinary.cookie)).data.packageId, 'synthetic-p2');
  } finally {
    await app.close(); await rm(root, { recursive: true, force: true });
  }
});
