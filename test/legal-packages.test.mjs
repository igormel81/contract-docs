import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalLegalJson, legalCorpusDigest, legalPackageDigest, legalPackageSigningPayload,
  verifyLegalPackage, LegalPackageStore, MAX_LEGAL_PACKAGE_BYTES } from '../server/legal-packages.mjs';

// Keys are generated in RAM for this test run. No publisher credential or private
// key file is committed, written to disk, or claimed to have been legally reviewed.
const issuer = generateKeyPairSync('ed25519'), otherIssuer = generateKeyPairSync('ed25519');
const trustedKeys = new Map([['test-publisher', issuer.publicKey]]);
const reviewers = new Set(['legal-reviewer']);
const instant = () => new Date('2026-09-06T12:00:00Z');
// Entirely synthetic schema fixture: no production corpus or actual legal text.
// The allowed-host URL is a placeholder, never fetched or offered as evidence.
const rawCorpus = {
  version: 'synthetic-corpus-1', status: 'reference_only', checkedAt: '2026-09-05', currentAsOf: null,
  reviewDueAt: '2026-10-05', edition: 'Synthetic test edition, not legislation',
  limitations: ['Искусственные данные только для проверки механизма импорта.'],
  provenance: { publisher: 'Synthetic test publisher', sourceUrl: 'https://government.ru/synthetic-test-not-a-source',
    retrievalMethod: 'synthetic_fixture', retrievedAt: '2026-09-05', directFetchStatus: 'unavailable',
    currentEditionVerified: false, normalization: 'Synthetic fixture; no legal text retrieved.' },
  norms: [{ id: 'SYNTHETIC-1-1', title: 'Искусственный тестовый пункт', article: '1', paragraph: '1',
    act: 'Искусственный тестовый акт, не законодательство', text: 'Искусственный текст для теста целостности пакета; правовых утверждений не содержит.',
    topics: ['synthetic'], interpretation: 'Искусственная интерпретация только для тестирования схемы.' }],
};
function makePackage({ corpusPatch = {}, manifestPatch = {}, mutateCorpus, signingKey = issuer.privateKey, keyId = 'test-publisher' } = {}) {
  const corpus = { ...structuredClone(rawCorpus), ...corpusPatch };
  if (mutateCorpus) mutateCorpus(corpus);
  const envelope = { manifest: { schemaVersion: 1, packageId: 'test-package-1', edition: corpus.edition,
    createdAt: '2026-09-06T10:00:00Z', expiresAt: '2026-09-30T00:00:00Z', sha256: legalCorpusDigest(corpus), ...manifestPatch },
    corpus, signature: { algorithm: 'Ed25519', keyId, value: '' } };
  envelope.signature.value = sign(null, legalPackageSigningPayload(envelope), signingKey).toString('base64');
  return envelope;
}
const wire = value => JSON.stringify(value);
const check = value => verifyLegalPackage(wire(value), { trustedKeys, now: instant() });
const code = expected => error => error?.code === expected;
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'contract-legal-packages-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new LegalPackageStore({ directory, trustedKeys, reviewers, clock: instant, ...options });
}
function approve(store, receipt) {
  return store.approve(receipt.packageId, { reviewerId: 'legal-reviewer', digest: receipt.digest, decision: 'approved', reason: 'Искусственное согласование для теста механизма; не юридическая проверка.' });
}
function activate(store, receipt) { return store.activate(receipt.packageId, { reviewerId: 'legal-reviewer', digest: receipt.digest }); }

test('canonical payload is deterministic, binds the complete manifest and verifies an explicit Ed25519 key', () => {
  const envelope = makePackage(), checked = check(envelope);
  const reordered = { signature: envelope.signature, corpus: Object.fromEntries(Object.entries(envelope.corpus).reverse()), manifest: Object.fromEntries(Object.entries(envelope.manifest).reverse()) };
  assert.equal(canonicalLegalJson(reordered), canonicalLegalJson(envelope));
  assert.deepEqual(legalPackageSigningPayload(reordered), legalPackageSigningPayload(envelope));
  assert.equal(checked.digest, legalPackageDigest(envelope));
  assert.equal(checked.corpus.corpusSha256, envelope.manifest.sha256);
  assert.equal(checked.corpus.status, 'reference_only');
  assert.equal(checked.corpus.currentAsOf, null);
  assert.equal(checked.corpus.norms[0].textSha256.length, 64);
  assert.equal(verifyLegalPackage(JSON.stringify(envelope, null, 2), { trustedKeys, now: instant() }).digest, checked.digest);
  assert.throws(() => canonicalLegalJson({ bad: undefined }), code('INVALID_JSON'));
});

test('modified text, signed metadata, wrong key and embedded trust material cannot pass verification', () => {
  const altered = makePackage(); altered.corpus.norms[0].text += ' Подмена текста.';
  assert.throws(() => check(altered), code('DIGEST_MISMATCH'));
  const metadata = makePackage(); metadata.manifest.expiresAt = '2026-10-01T00:00:00Z';
  assert.throws(() => check(metadata), code('BAD_SIGNATURE'));
  assert.throws(() => check(makePackage({ signingKey: otherIssuer.privateKey })), code('BAD_SIGNATURE'));
  assert.throws(() => check(makePackage({ keyId: 'unknown-publisher' })), code('UNTRUSTED_KEY'));
  const embeddedKey = makePackage(); embeddedKey.signature.publicKey = issuer.publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => check(embeddedKey), code('PACKAGE_SCHEMA'));
  assert.throws(() => verifyLegalPackage(wire(makePackage()), { trustedKeys: new Map([['test-publisher', issuer.privateKey]]), now: instant() }), code('UNTRUSTED_KEY'));
});

test('strict JSON rejects unknown schema, unknown fields, escaped duplicate keys, deep input and excessive size', () => {
  assert.throws(() => check(makePackage({ manifestPatch: { schemaVersion: 2 } })), code('UNKNOWN_VERSION'));
  assert.throws(() => check(makePackage({ corpusPatch: { localPath: '/etc/passwd' } })), code('PACKAGE_SCHEMA'));
  const duplicate = wire(makePackage()).replace('"packageId":', '"packageId":"other","\\u0070ackageId":');
  assert.throws(() => verifyLegalPackage(duplicate, { trustedKeys, now: instant() }), code('DUPLICATE_KEY'));
  assert.throws(() => verifyLegalPackage('{"__proto__":{}}', { trustedKeys }), code('INVALID_JSON'));
  assert.throws(() => verifyLegalPackage('['.repeat(40) + '0' + ']'.repeat(40), { trustedKeys }), code('JSON_DEPTH'));
  assert.throws(() => verifyLegalPackage(Buffer.alloc(MAX_LEGAL_PACKAGE_BYTES + 1), { trustedKeys }), code('PACKAGE_SIZE'));
  assert.throws(() => verifyLegalPackage('я'.repeat(MAX_LEGAL_PACKAGE_BYTES / 2 + 1), { trustedKeys }), code('PACKAGE_SIZE'));
  assert.throws(() => check(makePackage({ mutateCorpus: c => { c.norms[0].text = '  \n'; } })), code('PACKAGE_SCHEMA'));
  assert.throws(() => check(makePackage({ mutateCorpus: c => { c.provenance.privateKey = 'forbidden-field'; } })), code('PACKAGE_SCHEMA'));
  assert.throws(() => verifyLegalPackage(Buffer.from([0xff, 0xfe]), { trustedKeys }), code('INVALID_JSON'));
});

test('package expiration, corpus review date and norm effective dates are independently checked', () => {
  assert.throws(() => check(makePackage({ manifestPatch: { createdAt: '2026-09-05T10:00:00Z', expiresAt: '2026-09-06T12:00:00Z' } })), code('PACKAGE_EXPIRED'));
  assert.throws(() => check(makePackage({ corpusPatch: { reviewDueAt: '2026-09-05' } })), code('CORPUS_EXPIRED'));
  assert.throws(() => check(makePackage({ mutateCorpus: c => { c.norms[0].effectiveFrom = '2026-01-01'; c.norms[0].effectiveTo = '2026-09-05'; } })), code('NORM_OUT_OF_DATE'));
  assert.throws(() => check(makePackage({ mutateCorpus: c => { c.norms[0].effectiveFrom = '2026-10-01'; } })), code('NORM_OUT_OF_DATE'));
  assert.throws(() => check(makePackage({ corpusPatch: { checkedAt: '2026-02-30' } })), code('PACKAGE_SCHEMA'));
  assert.throws(() => check(makePackage({ corpusPatch: { checkedAt: '2026-09-07' } })), code('CORPUS_DATES'));
  assert.throws(() => check(makePackage({ manifestPatch: { createdAt: '2026-09-04T10:00:00Z' } })), code('CORPUS_DATES'));
  assert.throws(() => check(makePackage({ mutateCorpus: c => { c.norms[0].sourceCheckedAt = '2026-09-01'; } })), code('NORM_INTEGRITY'));
});

test('a trusted signature does not promote reference_only or excuse an unsupported verified claim', () => {
  const reference = makePackage({ mutateCorpus: c => { c.provenance.currentEditionVerified = true; c.provenance.directFetchStatus = 'success'; } });
  assert.equal(check(reference).corpus.status, 'reference_only');
  assert.throws(() => check(makePackage({ corpusPatch: { status: 'verified' } })), code('EDITION_UNCONFIRMED'));
  const declaredVerified = makePackage({ mutateCorpus: c => {
    c.status = 'verified'; c.currentAsOf = '2026-09-05'; c.provenance.currentEditionVerified = true;
    c.provenance.directFetchStatus = 'offline_verified'; c.provenance.verifiedBy = 'Synthetic publisher statement, not real legal review';
    for (const n of c.norms) n.effectiveFrom = '2026-01-01';
  } });
  assert.equal(check(declaredVerified).corpus.status, 'verified', 'Schema consistency is checked; real-world legal accuracy is a separate reviewer responsibility');
});

test('duplicate norm identifiers, equivalent act locations, incorrect norm hashes and unsafe links are rejected', () => {
  assert.throws(() => check(makePackage({ mutateCorpus: c => c.norms.push(structuredClone(c.norms[0])) })), code('DUPLICATE_NORM'));
  assert.throws(() => check(makePackage({ mutateCorpus: c => {
    const duplicate = { ...c.norms[0], id: 'different-id', act: '  ' + c.norms[0].act.toUpperCase() + '  ' }; c.norms.push(duplicate);
  } })), code('DUPLICATE_NORM'));
  assert.throws(() => check(makePackage({ mutateCorpus: c => { c.norms[0].textSha256 = '0'.repeat(64); } })), code('NORM_INTEGRITY'));
  assert.throws(() => check(makePackage({ mutateCorpus: c => { c.norms[0].sourceUrl = 'https://evil.example/path'; } })), code('PACKAGE_SCHEMA'));
  assert.throws(() => check(makePackage({ mutateCorpus: c => { c.norms[0].sourceUrl = 'https://attacker@government.ru/path'; } })), code('PACKAGE_SCHEMA'));
});

test('staging is immutable and duplicates cannot overwrite or alias an existing version', t => {
  const store = fixture(t), envelope = makePackage();
  const receipt = store.stage(wire(envelope));
  assert.equal(receipt.state, 'staged'); assert.equal(store.activeCorpus(), null);
  assert.throws(() => store.stage(wire(envelope)), code('DUPLICATE_PACKAGE'));
  assert.throws(() => store.stage(wire(makePackage({ manifestPatch: { packageId: 'different-package' } }))), code('DUPLICATE_PACKAGE'));
  assert.throws(() => store.stage(wire(makePackage({ manifestPatch: { packageId: 'different-package' }, mutateCorpus: c => { c.norms[0].interpretation += ' Изменено.'; } }))), code('DUPLICATE_PACKAGE'));
  assert.equal(readFileSync(store.packagePath(receipt.packageId), 'utf8'), canonicalLegalJson(envelope));
});

test('activation requires an explicit allowlisted reviewer decision bound to the exact signed package', t => {
  const store = fixture(t), receipt = store.stage(wire(makePackage()));
  assert.throws(() => activate(store, receipt), code('APPROVAL_REQUIRED'));
  assert.throws(() => store.approve(receipt.packageId, { reviewerId: 'ordinary-user', digest: receipt.digest, decision: 'approved', reason: 'Я согласен' }), code('REVIEWER_FORBIDDEN'));
  assert.throws(() => store.approve(receipt.packageId, { reviewerId: 'legal-reviewer', digest: receipt.digest, decision: 'pending', reason: 'Я согласен' }), code('APPROVAL_REQUIRED'));
  assert.throws(() => store.approve(receipt.packageId, { reviewerId: 'legal-reviewer', digest: '0'.repeat(64), decision: 'approved', reason: 'Я согласен' }), code('DIGEST_MISMATCH'));
  approve(store, receipt);
  assert.throws(() => approve(store, receipt), code('DUPLICATE_APPROVAL'));
  assert.throws(() => store.activate(receipt.packageId, { reviewerId: 'ordinary-user', digest: receipt.digest }), code('REVIEWER_FORBIDDEN'));
  assert.throws(() => activate(store, { ...receipt, digest: '0'.repeat(64) }), code('DIGEST_MISMATCH'));
  activate(store, receipt);
  assert.equal(store.activeCorpus().status, 'reference_only');
  assert.equal(store.activeCorpus().approvedBy, 'legal-reviewer');
});

test('a legitimately signed replacement after approval is rejected even if corpus bytes stay identical', t => {
  const store = fixture(t), receipt = store.stage(wire(makePackage())); approve(store, receipt);
  const path = store.packagePath(receipt.packageId); chmodSync(path, 0o600);
  writeFileSync(path, wire(makePackage({ manifestPatch: { expiresAt: '2026-10-01T00:00:00Z' } })));
  assert.throws(() => activate(store, receipt), code('DIGEST_MISMATCH'));
  writeFileSync(path, wire(makePackage({ manifestPatch: { packageId: 'different-package' } })));
  assert.throws(() => activate(store, receipt), code('PACKAGE_ID_MISMATCH'));
});

test('filesystem lock excludes concurrent mutations and input ids never select filesystem paths', t => {
  const store = fixture(t), receipt = store.stage(wire(makePackage()));
  for (const id of ['../outside', '/tmp/outside', 'a/b', 'a\\b', '..', 'x%2fy']) {
    assert.throws(() => store.readPackage(id), code('INVALID_ID'));
    assert.throws(() => check(makePackage({ manifestPatch: { packageId: id } })), code('PACKAGE_SCHEMA'));
  }
  mkdirSync(join(store.directory, '.lock'), { mode: 0o700 });
  const peer = new LegalPackageStore({ directory: store.directory, trustedKeys, reviewers, clock: instant });
  assert.throws(() => peer.stage(wire(makePackage())), code('STORE_BUSY'));
  assert.throws(() => approve(peer, receipt), code('STORE_BUSY'));
  assert.throws(() => activate(peer, receipt), code('STORE_BUSY'));
});

test('symlink substitutions cannot provide package bytes or reviewer approvals', t => {
  const store = fixture(t), receipt = store.stage(wire(makePackage()));
  const outside = join(store.directory, 'outside.json'); writeFileSync(outside, '{}');
  symlinkSync(outside, store.approvalPath(receipt.packageId));
  assert.throws(() => activate(store, receipt), error => ['ELOOP', 'EMLINK'].includes(error.code));
  const alias = join(store.directory, 'store-alias'); symlinkSync(store.directory, alias);
  assert.throws(() => new LegalPackageStore({ directory: alias, trustedKeys, reviewers }), code('UNSAFE_STORE'));
});

test('an active package fails closed after expiry or trust revocation', t => {
  let now = instant(); const store = fixture(t, { clock: () => now });
  const receipt = store.stage(wire(makePackage())); approve(store, receipt); activate(store, receipt);
  now = new Date('2026-09-30T00:00:00Z');
  assert.throws(() => store.activeCorpus(), code('PACKAGE_EXPIRED'));
  const revokedKey = new LegalPackageStore({ directory: store.directory, trustedKeys: new Map(), reviewers, clock: instant });
  assert.throws(() => revokedKey.activeCorpus(), code('UNTRUSTED_KEY'));
  const revokedReviewer = new LegalPackageStore({ directory: store.directory, trustedKeys, reviewers: new Set(), clock: instant });
  assert.throws(() => revokedReviewer.activeCorpus(), code('REVIEWER_FORBIDDEN'));
});

test('approval and activation recheck expiry without changing an existing active package', t => {
  let now = instant(); const store = fixture(t, { clock: () => now });
  const first = store.stage(wire(makePackage())); approve(store, first); activate(store, first);
  const second = store.stage(wire(makePackage({ manifestPatch: { packageId: 'short-lived', expiresAt: '2026-09-07T00:00:00Z' },
    corpusPatch: { version: 'synthetic-short-lived' } })));
  const third = store.stage(wire(makePackage({ manifestPatch: { packageId: 'never-approved', expiresAt: '2026-09-07T00:00:00Z' },
    corpusPatch: { version: 'synthetic-never-approved' } })));
  approve(store, second);
  now = new Date('2026-09-07T00:00:00Z');
  assert.throws(() => approve(store, third), code('PACKAGE_EXPIRED'));
  assert.throws(() => activate(store, second), code('PACKAGE_EXPIRED'));
  assert.equal(store.activeCorpus().packageId, first.packageId);
  // Expired staged entries remain immutable but do not prevent a fresh edition.
  const replacement = store.stage(wire(makePackage({ manifestPatch: { packageId: 'replacement' },
    corpusPatch: { version: 'synthetic-replacement' } })));
  approve(store, replacement); activate(store, replacement);
  assert.equal(store.activeCorpus().packageId, 'replacement');
});

test('active corpus and norm deadlines are rechecked independently of package expiry', t => {
  let now = instant();
  const corpusStore = fixture(t, { clock: () => now });
  const corpus = corpusStore.stage(wire(makePackage({ corpusPatch: { reviewDueAt: '2026-09-06' } })));
  approve(corpusStore, corpus); activate(corpusStore, corpus);
  const normStore = fixture(t, { clock: () => now });
  const norm = normStore.stage(wire(makePackage({ mutateCorpus: c => {
    c.norms[0].effectiveFrom = '2026-01-01'; c.norms[0].effectiveTo = '2026-09-06';
  } })));
  approve(normStore, norm); activate(normStore, norm);
  now = new Date('2026-09-07T00:00:00Z');
  assert.throws(() => corpusStore.activeCorpus(), code('CORPUS_EXPIRED'));
  assert.throws(() => normStore.activeCorpus(), code('NORM_OUT_OF_DATE'));
});

test('corrupted import, stored approval and activation cannot silently replace trusted state', t => {
  const store = fixture(t), envelope = makePackage();
  const broken = structuredClone(envelope); broken.corpus.norms[0].text += ' altered';
  assert.throws(() => store.stage(wire(broken)), code('DIGEST_MISMATCH'));
  assert.equal(store.activeCorpus(), null);
  const receipt = store.stage(wire(envelope)); approve(store, receipt); activate(store, receipt);
  const approvalPath = store.approvalPath(receipt.packageId);
  const originalApproval = readFileSync(approvalPath, 'utf8');
  const changedApproval = JSON.parse(originalApproval); changedApproval.reason = 'Changed after activation';
  chmodSync(approvalPath, 0o600); writeFileSync(approvalPath, wire(changedApproval));
  assert.throws(() => store.activeCorpus(), code('ACTIVATION_INVALID'));
  writeFileSync(approvalPath, originalApproval);
  const activePath = join(store.directory, 'active.json');
  const changedActive = JSON.parse(readFileSync(activePath, 'utf8')); changedActive.unexpected = true;
  chmodSync(activePath, 0o600); writeFileSync(activePath, wire(changedActive));
  assert.throws(() => store.activeCorpus(), code('ACTIVATION_INVALID'));
});

test('activating a new package neither mutates historical snapshots nor exposes mutable store references', t => {
  const store = fixture(t), first = store.stage(wire(makePackage())); approve(store, first); activate(store, first);
  const oldSnapshot = { documents: [], legal: store.activeCorpus() }, original = JSON.stringify(oldSnapshot);
  const second = store.stage(wire(makePackage({ manifestPatch: { packageId: 'test-package-2' }, corpusPatch: { version: 'test-corpus-2' } })));
  approve(store, second); activate(store, second);
  assert.equal(store.activeCorpus().version, 'test-corpus-2'); assert.equal(JSON.stringify(oldSnapshot), original);
  const current = store.activeCorpus(); current.norms[0].text = 'Изменено вызывающим кодом';
  assert.notEqual(store.activeCorpus().norms[0].text, current.norms[0].text);
});
