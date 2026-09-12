import Ajv from 'ajv';
import { createHash, createPublicKey, KeyObject, randomUUID, verify } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { legalStatus, trustedLegalUrl } from './legal.mjs';

export const MAX_LEGAL_PACKAGE_BYTES = 2 * 1024 * 1024;
const idPattern = '^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,95}$';
const identifier = { type: 'string', pattern: idPattern };
const digestSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const text = (maxLength = 2000) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const date = { type: 'string', format: 'legal-date' };
const nullableDate = { anyOf: [date, { type: 'null' }] };
const timestamp = { type: 'string', format: 'legal-timestamp' };
const status = { enum: ['reference_only', 'verified'] };
const strings = (maxItems, maxLength = 2000) => ({ type: 'array', minItems: 1, maxItems, uniqueItems: true, items: text(maxLength) });
const moduleSchema = object({ id: identifier, title: text(500),
  qualificationTypes: { type: 'array', maxItems: 50, uniqueItems: true, items: identifier }, enabledByDefault: { type: 'boolean' } });
const provenance = object({ publisher: text(500), sourceUrl: { type: 'string', format: 'official-legal-url', maxLength: 2000 },
  retrievalMethod: text(100), retrievedAt: date, directFetchStatus: { enum: ['success', 'timeout', 'unavailable', 'offline_verified'] },
  indexAgeReported: text(100), currentEditionVerified: { type: 'boolean' }, normalization: text(2000), verifiedBy: text(500) },
  ['publisher', 'sourceUrl', 'retrievalMethod', 'retrievedAt', 'directFetchStatus', 'currentEditionVerified', 'normalization']);
const norm = object({ id: identifier, title: text(1000), article: { type: 'string', pattern: '^\\d+(?:\\.\\d+)*$', maxLength: 40 },
  paragraph: { type: 'string', pattern: '^\\d+(?:\\.\\d+)*$', maxLength: 40 }, act: text(1000), text: text(32000),
  topics: strings(20, 100), interpretation: text(8000), sourceUrl: provenance.properties.sourceUrl, sourceCheckedAt: date,
  edition: text(1000), effectiveFrom: nullableDate, effectiveTo: nullableDate, verificationStatus: status, provenance,
  textSha256: digestSchema, moduleId: identifier }, ['id', 'title', 'article', 'paragraph', 'act', 'text', 'topics', 'interpretation']);
const corpusSchema = object({ version: identifier, status, checkedAt: date, currentAsOf: nullableDate,
  reviewDueAt: date, edition: text(1000), limitations: strings(30, 4000), provenance,
  modules: { type: 'array', minItems: 1, maxItems: 50, items: moduleSchema },
  norms: { type: 'array', minItems: 1, maxItems: 200, items: norm } },
['version', 'status', 'checkedAt', 'currentAsOf', 'reviewDueAt', 'edition', 'limitations', 'provenance', 'norms']);
const manifestSchema = object({ schemaVersion: { const: 1 }, packageId: identifier, edition: text(1000),
  createdAt: timestamp, expiresAt: timestamp, sha256: digestSchema });
const signatureSchema = object({ algorithm: { const: 'Ed25519' }, keyId: identifier,
  value: { type: 'string', pattern: '^[A-Za-z0-9+/]{86}==$' } });
const packageSchema = object({ manifest: manifestSchema, corpus: corpusSchema, signature: signatureSchema });
const importSchema = object({ schemaVersion: { const: 1 }, packageId: identifier, digest: digestSchema,
  importerId: identifier, stagedAt: timestamp });
const approvalSchema = object({ schemaVersion: { const: 1 }, packageId: identifier, digest: digestSchema,
  importerId: identifier, importSha256: digestSchema, reviewerId: identifier,
  decision: { const: 'approved' }, reason: text(4000), approvedAt: timestamp });
const activeSchema = object({ schemaVersion: { const: 1 }, packageId: identifier, digest: digestSchema,
  approvalSha256: digestSchema, activatedBy: identifier, activatedAt: timestamp });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value;
const validTimestamp = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
const ajv = new Ajv({ allErrors: false, strict: true });
ajv.addFormat('legal-date', validDate);
ajv.addFormat('legal-timestamp', validTimestamp);
ajv.addFormat('official-legal-url', trustedLegalUrl);
const validatePackage = ajv.compile(packageSchema), validateImport = ajv.compile(importSchema),
  validateApproval = ajv.compile(approvalSchema), validateActive = ajv.compile(activeSchema);
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function checkId(value) { if (typeof value !== 'string' || !new RegExp(idPattern).test(value)) fail('INVALID_ID', 'Недопустимый идентификатор пакета или ответственного.'); return value; }
function clockDate(value) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_DATE', 'Неверная дата проверки.'); return value; }

// JSON object keys are sorted by UTF-16 code units, arrays keep their order.
// Only JSON primitives/plain objects are supported; this is the v1 wire format,
// not a claim of compatibility with every external canonical-JSON standard.
export function canonicalLegalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + Array.from(value, canonicalLegalJson).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalLegalJson(value[key])).join(',') + '}';
  fail('INVALID_JSON', 'Поддерживаются только значения JSON.');
}

// Reject duplicate keys (including escaped aliases) before JSON.parse can hide
// them. The scanner also bounds depth and rejects prototype-special keys.
function parseJson(bytes, maxBytes = MAX_LEGAL_PACKAGE_BYTES) {
  if (!(typeof bytes === 'string' || Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) fail('INVALID_JSON', 'Ожидаются байты JSON-пакета.');
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
  if (!size || size > maxBytes) fail('PACKAGE_SIZE', 'Пакет пуст или превышает допустимый размер.');
  const data = Buffer.from(bytes);
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { fail('INVALID_JSON', 'Пакет должен содержать UTF-8.'); }
  let at = 0;
  const whitespace = () => { while (/\s/.test(source[at] || '') && at < source.length) at++; };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === '\\') at++;
      else if (char === '"') return JSON.parse(source.slice(start, at));
    }
    throw new Error('unterminated');
  };
  function value(depth) {
    if (depth > 32) fail('JSON_DEPTH', 'Слишком глубокая структура пакета.');
    whitespace();
    const char = source[at++];
    if (char === '{' || char === '[') {
      const end = char === '{' ? '}' : ']', keys = new Set(); whitespace();
      if (source[at] === end) { at++; return; }
      while (at < source.length) {
        whitespace();
        if (char === '{') {
          if (source[at] !== '"') throw new Error('key');
          const key = string();
          if (keys.has(key)) fail('DUPLICATE_KEY', 'Повторяющийся ключ JSON.');
          if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('INVALID_JSON', 'Недопустимый ключ JSON.');
          keys.add(key); whitespace(); if (source[at++] !== ':') throw new Error('colon');
        }
        value(depth + 1); whitespace();
        const separator = source[at++]; if (separator === end) return;
        if (separator !== ',') throw new Error('separator');
      }
      throw new Error('unterminated');
    }
    if (char === '"') { at--; string(); return; }
    while (at < source.length && !/[\s,\]}]/.test(source[at])) at++;
  }
  try { value(0); whitespace(); if (at !== source.length) throw new Error('trailing'); return JSON.parse(source); }
  catch (error) { if (error.code) throw error; fail('INVALID_JSON', 'Некорректный JSON-пакет.'); }
}

export function legalCorpusDigest(corpus) { return sha256(canonicalLegalJson(corpus)); }
export function legalPackageSigningPayload({ manifest, corpus, signature }) {
  return Buffer.from('contract-docs/legal-package/v1\n' + canonicalLegalJson({ manifest, corpus,
    signature: { algorithm: signature.algorithm, keyId: signature.keyId } }), 'utf8');
}
export function legalPackageDigest(envelope) { return sha256(legalPackageSigningPayload(envelope)); }

function trustedPublicKey(trustedKeys, keyId) {
  if (!(trustedKeys instanceof Map) || !trustedKeys.has(keyId)) fail('UNTRUSTED_KEY', 'Издатель пакета отсутствует в доверенном списке.');
  const supplied = trustedKeys.get(keyId);
  try {
    let key;
    if (supplied instanceof KeyObject) {
      if (supplied.type !== 'public') throw new Error('private'); key = supplied;
    } else {
      if (typeof supplied !== 'string' || supplied.length > 8192 || !supplied.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('public');
      key = createPublicKey(supplied);
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('algorithm');
    return key;
  } catch { fail('UNTRUSTED_KEY', 'Нужен явно доверенный открытый ключ Ed25519.'); }
}

function verifyEnvelope(bytes, { trustedKeys, now = new Date() }, requireCurrent) {
  clockDate(now);
  const envelope = parseJson(bytes);
  if (envelope?.manifest?.schemaVersion !== 1) fail('UNKNOWN_VERSION', 'Версия схемы нормативного пакета не поддерживается.');
  if (!validatePackage(envelope)) fail('PACKAGE_SCHEMA', 'Пакет не соответствует строгой схеме: ' + validatePackage.errors[0].instancePath);
  const { manifest, corpus, signature } = envelope, day = now.toISOString().slice(0, 10);
  if (manifest.edition !== corpus.edition) fail('EDITION_MISMATCH', 'Редакция манифеста не совпадает с корпусом.');
  if (manifest.sha256 !== legalCorpusDigest(corpus)) fail('DIGEST_MISMATCH', 'Контрольная сумма корпуса не совпала.');
  const signedBytes = Buffer.from(signature.value, 'base64');
  if (signedBytes.length !== 64 || signedBytes.toString('base64') !== signature.value
    || !verify(null, legalPackageSigningPayload(envelope), trustedPublicKey(trustedKeys, signature.keyId), signedBytes)) fail('BAD_SIGNATURE', 'Подпись нормативного пакета не подтверждена.');
  if (Date.parse(manifest.createdAt) >= Date.parse(manifest.expiresAt) || Date.parse(manifest.createdAt) > now.getTime()) fail('PACKAGE_DATES', 'Неверный период поставки нормативного пакета.');
  if (requireCurrent && Date.parse(manifest.expiresAt) <= now.getTime()) fail('PACKAGE_EXPIRED', 'Срок действия подписанного пакета истёк.');
  if (corpus.checkedAt > day || corpus.checkedAt > manifest.createdAt.slice(0, 10)
    || corpus.provenance.retrievedAt > corpus.checkedAt || corpus.reviewDueAt < corpus.checkedAt
    || (corpus.currentAsOf && corpus.currentAsOf > corpus.checkedAt)) fail('CORPUS_DATES', 'Даты проверки корпуса противоречат друг другу.');
  const modules = corpus.modules || [{ id: 'core', title: 'Базовый нормативный модуль', qualificationTypes: [], enabledByDefault: true }];
  const moduleIds = new Set();
  for (const module of modules) {
    if (moduleIds.has(module.id)) fail('DUPLICATE_MODULE', 'Идентификатор нормативного модуля повторяется.');
    moduleIds.add(module.id);
  }
  const seenIds = new Set(), seenLocations = new Set();
  const norms = corpus.norms.map(item => {
    const location = canonicalLegalJson([item.act.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase(), item.article, item.paragraph]);
    if (seenIds.has(item.id) || seenLocations.has(location)) fail('DUPLICATE_NORM', 'Повторная норма или номер пункта одного акта.');
    seenIds.add(item.id); seenLocations.add(location);
    const n = { ...item, moduleId: item.moduleId || 'core', sourceUrl: item.sourceUrl || corpus.provenance.sourceUrl,
      sourceCheckedAt: item.sourceCheckedAt || corpus.checkedAt, edition: item.edition || corpus.edition,
      effectiveFrom: item.effectiveFrom || null, effectiveTo: item.effectiveTo || null,
      verificationStatus: item.verificationStatus || corpus.status, provenance: item.provenance || corpus.provenance,
      textSha256: sha256(item.text) };
    if (!moduleIds.has(n.moduleId)) fail('UNKNOWN_MODULE', 'Норма ссылается на отсутствующий нормативный модуль.');
    if ((item.textSha256 && item.textSha256 !== n.textSha256) || n.sourceCheckedAt > corpus.checkedAt
      || n.provenance.retrievedAt > n.sourceCheckedAt || (n.effectiveTo && (!n.effectiveFrom || n.effectiveTo < n.effectiveFrom))) fail('NORM_INTEGRITY', 'Текст или даты отдельной нормы не подтверждены.');
    if (requireCurrent && ((n.effectiveFrom && n.effectiveFrom > day) || (n.effectiveTo && n.effectiveTo < day))) fail('NORM_OUT_OF_DATE', 'Период действия нормы не включает дату проверки пакета.');
    if (n.verificationStatus === 'verified' && (!n.effectiveFrom || !n.provenance.currentEditionVerified
      || !['success', 'offline_verified'].includes(n.provenance.directFetchStatus))) fail('EDITION_UNCONFIRMED', 'У подтверждённой нормы отсутствуют сведения о проверке редакции.');
    return n;
  });
  const normalized = { ...corpus, modules, norms, corpusSha256: manifest.sha256 };
  const evaluatedStatus = legalStatus(normalized, now);
  if (corpus.status === 'verified' && (!corpus.currentAsOf || !corpus.provenance.currentEditionVerified
    || !['success', 'offline_verified'].includes(corpus.provenance.directFetchStatus))) fail('EDITION_UNCONFIRMED', 'Подпись издателя не подтверждает правовую актуальность.');
  if (requireCurrent && evaluatedStatus === 'stale') fail('CORPUS_EXPIRED', 'Срок повторной проверки нормативного корпуса истёк.');
  if (requireCurrent && corpus.status === 'verified' && evaluatedStatus !== 'verified') fail('EDITION_UNCONFIRMED', 'Подтверждённая редакция не применима на дату активации.');
  return { envelope, digest: legalPackageDigest(envelope), corpus: { ...normalized, status: evaluatedStatus } };
}

export function verifyLegalPackage(bytes, options = {}) {
  const { envelope, digest, corpus } = verifyEnvelope(bytes, options, true);
  return { manifest: envelope.manifest, signature: envelope.signature, digest, corpus };
}

function privateDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail('UNSAFE_STORE', 'Хранилище пакетов должно принадлежать службе и иметь права 0700.');
}
function boundedRead(path, limit = MAX_LEGAL_PACKAGE_BYTES) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) fail('UNSAFE_STORE', 'Недопустимый файл в хранилище пакетов.');
    // The bound still holds if an administrator changes the file after fstat.
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break; length += count;
    }
    if (length > limit) fail('PACKAGE_SIZE', 'Файл хранилища превышает допустимый размер.');
    return buffer.subarray(0, length);
  }
  finally { closeSync(fd); }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function immutableWrite(path, value) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
  try { writeFileSync(fd, canonicalLegalJson(value)); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

// The caller authenticates a person and passes their server-resolved id. The
// configured allowlist, never data in a package/request, grants approval rights.
// Store files are immutable to this API; OS administrators still control disk.
function packageExpired(verified, now) {
  const day = now.toISOString().slice(0, 10);
  return Date.parse(verified.envelope.manifest.expiresAt) <= now.getTime() || verified.corpus.status === 'stale'
    || verified.corpus.norms.some(n => (n.effectiveFrom && n.effectiveFrom > day) || (n.effectiveTo && n.effectiveTo < day));
}

function moduleFingerprints(legal) {
  if (!legal || typeof legal !== 'object' || !Array.isArray(legal.norms)) fail('RECHECK_INPUT', 'Нужен нормативный снимок анализа.');
  const modules = Array.isArray(legal.modules) && legal.modules.length ? legal.modules
    : [{ id: 'core', title: 'Базовый нормативный модуль', qualificationTypes: [], enabledByDefault: true }];
  const result = new Map();
  for (const module of modules) {
    if (!module || typeof module.id !== 'string' || result.has(module.id)) fail('RECHECK_INPUT', 'Неверный список нормативных модулей.');
    const norms = legal.norms.filter(norm => (norm.moduleId || 'core') === module.id)
      .map(norm => structuredClone(norm)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    result.set(module.id, sha256(canonicalLegalJson({ module: structuredClone(module), norms })));
  }
  for (const norm of legal.norms) if (!result.has(norm.moduleId || 'core')) fail('RECHECK_INPUT', 'Норма анализа ссылается на неизвестный модуль.');
  return result;
}

// Computes advice only. Stored analyses and their pinned legal snapshots are
// never rewritten. Callers decide whether and when to enqueue a fresh analysis.
export function computeLegalRecheckCandidates(analyses, nextLegal) {
  if (!Array.isArray(analyses) || analyses.length > 10000 || !nextLegal || typeof nextLegal.version !== 'string')
    fail('RECHECK_INPUT', 'Нужны анализы и следующая версия нормативного снимка.');
  const nextModules = moduleFingerprints(nextLegal), changedModuleIds = new Set(), candidates = [];
  for (const analysis of analyses) {
    const old = analysis?.snapshot?.legal || analysis?.legal;
    if (!old) continue;
    const sameDigest = typeof old.packageDigest === 'string' && typeof nextLegal.packageDigest === 'string'
      && old.packageDigest === nextLegal.packageDigest;
    const sameCorpus = old.version === nextLegal.version && old.corpusSha256 && old.corpusSha256 === nextLegal.corpusSha256;
    if (sameDigest || sameCorpus) continue;
    const oldModules = moduleFingerprints(old);
    const selected = Array.isArray(old.activeModuleIds) && old.activeModuleIds.length
      ? [...new Set(old.activeModuleIds)] : [...oldModules.keys()];
    const changed = selected.filter(id => oldModules.get(id) !== nextModules.get(id)).sort();
    if (!changed.length) continue;
    for (const id of changed) changedModuleIds.add(id);
    candidates.push({ analysisId: analysis.id, fromVersion: old.version || null, toVersion: nextLegal.version,
      moduleIds: changed, reason: 'legal_modules_changed' });
  }
  return { nextVersion: nextLegal.version, nextDigest: nextLegal.packageDigest || nextLegal.corpusSha256 || null,
    changedModuleIds: [...changedModuleIds].sort(), candidates };
}

export class LegalPackageStore {
  constructor({ directory, trustedKeys, reviewers, clock = () => new Date() }) {
    if (!isAbsolute(directory || '')) fail('UNSAFE_STORE', 'Нужен абсолютный путь отдельного хранилища.');
    if (!(trustedKeys instanceof Map) || !(reviewers instanceof Set)) fail('TRUST_CONFIG', 'Нужны явные списки доверенных ключей и ответственных.');
    this.directory = resolve(directory); this.trustedKeys = new Map(trustedKeys); this.reviewers = new Set([...reviewers].map(checkId)); this.clock = clock;
    privateDirectory(this.directory);
    for (const child of ['packages', 'imports', 'approvals', 'activations']) privateDirectory(join(this.directory, child));
    syncDirectory(this.directory);
  }
  at() { return clockDate(this.clock()); }
  requireReviewer(id) { checkId(id); if (!this.reviewers.has(id)) fail('REVIEWER_FORBIDDEN', 'Сотрудник не назначен ответственным за нормативную базу.'); }
  packagePath(id) { return join(this.directory, 'packages', checkId(id) + '.json'); }
  importPath(id) { return join(this.directory, 'imports', checkId(id) + '.json'); }
  approvalPath(id) { return join(this.directory, 'approvals', checkId(id) + '.json'); }
  exclusive(action) {
    const lock = join(this.directory, '.lock');
    try { mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('STORE_BUSY', 'Другая операция изменяет нормативное хранилище.'); throw error; }
    try { return action(); } finally { rmdirSync(lock); }
  }
  readPackage(id, requireCurrent = true) {
    const result = verifyEnvelope(boundedRead(this.packagePath(id)), { trustedKeys: this.trustedKeys, now: this.at() }, requireCurrent);
    if (result.envelope.manifest.packageId !== id) fail('PACKAGE_ID_MISMATCH', 'Имя сохранённого пакета не соответствует подписанному манифесту.');
    return result;
  }
  stage(bytes, { importerId } = {}) {
    if (typeof importerId !== 'string') fail('IMPORTER_REQUIRED', 'Нужен идентификатор сотрудника, импортирующего пакет.');
    checkId(importerId);
    return this.exclusive(() => {
      const verified = verifyEnvelope(bytes, { trustedKeys: this.trustedKeys, now: this.at() }, true);
      const { manifest } = verified.envelope;
      const files = readdirSync(join(this.directory, 'packages'));
      if (files.length >= 1000) fail('STORE_FULL', 'Достигнут предел 1000 нормативных пакетов.');
      for (const name of files) {
        if (!name.endsWith('.json')) fail('UNSAFE_STORE', 'Неизвестный файл в хранилище пакетов.');
        const existing = this.readPackage(name.slice(0, -5), false);
        if (existing.envelope.manifest.packageId === manifest.packageId || existing.corpus.corpusSha256 === verified.corpus.corpusSha256
          || existing.corpus.version === verified.corpus.version) fail('DUPLICATE_PACKAGE', 'Пакет, версия корпуса или содержимое уже импортированы.');
      }
      const packageFile = this.packagePath(manifest.packageId);
      immutableWrite(packageFile, verified.envelope);
      const imported = { schemaVersion: 1, packageId: manifest.packageId, digest: verified.digest,
        importerId, stagedAt: this.at().toISOString() };
      try { immutableWrite(this.importPath(manifest.packageId), imported); }
      catch (error) {
        // Do not leave a package that can never pass the four-eyes workflow
        // when its required attribution record could not be committed.
        try { unlinkSync(packageFile); syncDirectory(dirname(packageFile)); }
        catch (rollbackError) { error.rollbackError = rollbackError; }
        throw error;
      }
      return { packageId: manifest.packageId, digest: verified.digest, edition: manifest.edition, state: 'staged',
        legalStatus: verified.corpus.status, signatureKeyId: verified.envelope.signature.keyId, importerId, stagedAt: imported.stagedAt };
    });
  }
  readImport(packageId, digest, { required = true } = {}) {
    let imported;
    try { imported = parseJson(boundedRead(this.importPath(packageId), 16000), 16000); }
    catch (error) {
      if (error.code === 'ENOENT' && !required) return null;
      if (error.code === 'ENOENT') fail('IMPORT_REQUIRED', 'Для пакета отсутствует запись импорта.');
      throw error;
    }
    if (!validateImport(imported) || imported.packageId !== packageId || imported.digest !== digest
      || Date.parse(imported.stagedAt) > this.at().getTime()) fail('IMPORT_INVALID', 'Запись импорта не соответствует пакету.');
    return imported;
  }
  approve(packageId, { reviewerId, digest, decision, reason }) {
    this.requireReviewer(reviewerId);
    if (decision !== 'approved' || typeof reason !== 'string' || !reason.trim() || reason.length > 4000) fail('APPROVAL_REQUIRED', 'Нужно явное решение ответственного и основание проверки.');
    return this.exclusive(() => {
      const verified = this.readPackage(packageId);
      if (digest !== verified.digest) fail('DIGEST_MISMATCH', 'Согласование относится к другому содержимому пакета.');
      const imported = this.readImport(packageId, digest);
      if (imported.importerId === reviewerId) fail('FOUR_EYES_REQUIRED', 'Импортёр не может согласовать собственный нормативный пакет.');
      const approval = { schemaVersion: 1, packageId, digest, importerId: imported.importerId,
        importSha256: sha256(canonicalLegalJson(imported)), reviewerId, decision, reason: reason.trim(), approvedAt: this.at().toISOString() };
      try { immutableWrite(this.approvalPath(packageId), approval); }
      catch (error) { if (error.code === 'EEXIST') fail('DUPLICATE_APPROVAL', 'Решение по этому пакету уже зафиксировано.'); throw error; }
      return approval;
    });
  }
  readApproval(packageId, digest) {
    let approval;
    try { approval = parseJson(boundedRead(this.approvalPath(packageId), 16000), 16000); }
    catch (error) { if (error.code === 'ENOENT') fail('APPROVAL_REQUIRED', 'Пакет ещё не согласован ответственным.'); throw error; }
    const imported = this.readImport(packageId, digest);
    if (approval?.importerId !== imported.importerId || approval?.importSha256 !== sha256(canonicalLegalJson(imported)))
      fail('IMPORT_INVALID', 'Запись импорта изменилась после согласования.');
    if (!validateApproval(approval) || approval.packageId !== packageId || approval.digest !== digest
      || approval.reviewerId === imported.importerId
      || Date.parse(approval.approvedAt) > this.at().getTime()) fail('APPROVAL_INVALID', 'Согласование не соответствует пакету.');
    this.requireReviewer(approval.reviewerId);
    return approval;
  }
  activate(packageId, { actorId, reviewerId, digest }) {
    const activatedBy = actorId ?? reviewerId;
    this.requireReviewer(activatedBy);
    return this.exclusive(() => {
      const verified = this.readPackage(packageId);
      if (digest !== verified.digest) fail('DIGEST_MISMATCH', 'Активация относится к другому содержимому пакета.');
      const approval = this.readApproval(packageId, digest);
      const active = { schemaVersion: 1, packageId, digest, approvalSha256: sha256(canonicalLegalJson(approval)),
        activatedBy, activatedAt: this.at().toISOString() };
      if (readdirSync(join(this.directory, 'activations')).length >= 10000) fail('STORE_FULL', 'Достигнут предел истории активаций.');
      immutableWrite(join(this.directory, 'activations', randomUUID() + '.json'), active);
      const temporary = join(this.directory, '.active-' + randomUUID() + '.json');
      try { immutableWrite(temporary, active); renameSync(temporary, join(this.directory, 'active.json')); syncDirectory(this.directory); }
      finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      return { ...active, legalStatus: verified.corpus.status };
    });
  }
  activationRecords() {
    const directory = join(this.directory, 'activations'), files = readdirSync(directory);
    if (files.length > 10000) fail('STORE_FULL', 'История активаций превышает допустимый размер.');
    return files.map(name => {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) fail('UNSAFE_STORE', 'Неизвестный файл в истории активаций.');
      const active = parseJson(boundedRead(join(directory, name), 16000), 16000);
      if (!validateActive(active) || Date.parse(active.activatedAt) > this.at().getTime()) fail('ACTIVATION_INVALID', 'Запись активации повреждена.');
      this.requireReviewer(active.activatedBy);
      return active;
    });
  }
  readActive() {
    let active;
    try { active = parseJson(boundedRead(join(this.directory, 'active.json'), 16000), 16000); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!validateActive(active) || Date.parse(active.activatedAt) > this.at().getTime()) fail('ACTIVATION_INVALID', 'Запись активации повреждена.');
    this.requireReviewer(active.activatedBy);
    const encoded = canonicalLegalJson(active);
    if (!this.activationRecords().some(record => canonicalLegalJson(record) === encoded)) fail('ACTIVATION_INVALID', 'Активная запись отсутствует в неизменяемой истории.');
    return active;
  }
  status(packageId) {
    const verified = this.readPackage(packageId, false), imported = this.readImport(packageId, verified.digest, { required: false });
    let approval = null;
    if (imported) {
      try { approval = this.readApproval(packageId, verified.digest); }
      catch (error) { if (error.code !== 'APPROVAL_REQUIRED') throw error; }
    }
    const active = this.readActive();
    if (active?.packageId === packageId) {
      if (!approval || active.digest !== verified.digest || active.approvalSha256 !== sha256(canonicalLegalJson(approval))
        || Date.parse(approval.approvedAt) > Date.parse(active.activatedAt)) fail('ACTIVATION_INVALID', 'Активный пакет не соответствует согласованию.');
    }
    const expired = packageExpired(verified, this.at());
    const state = expired ? 'expired' : active?.packageId === packageId ? 'active' : approval ? 'approved' : 'staged';
    return { packageId, digest: verified.digest, version: verified.corpus.version, edition: verified.envelope.manifest.edition,
      state, legalStatus: verified.corpus.status, signatureKeyId: verified.envelope.signature.keyId,
      expiresAt: verified.envelope.manifest.expiresAt, reviewDueAt: verified.corpus.reviewDueAt,
      modules: structuredClone(verified.corpus.modules), importerId: imported?.importerId || null, stagedAt: imported?.stagedAt || null,
      reviewerId: approval?.reviewerId || null, approvedAt: approval?.approvedAt || null,
      activatedBy: active?.packageId === packageId ? active.activatedBy : null,
      activatedAt: active?.packageId === packageId ? active.activatedAt : null };
  }
  list() {
    const files = readdirSync(join(this.directory, 'packages'));
    if (files.length > 1000) fail('STORE_FULL', 'Хранилище пакетов превышает допустимый размер.');
    return files.map(name => {
      if (!name.endsWith('.json')) fail('UNSAFE_STORE', 'Неизвестный файл в хранилище пакетов.');
      return this.status(name.slice(0, -5));
    }).sort((a, b) => a.packageId.localeCompare(b.packageId));
  }
  history(packageId) {
    if (packageId !== undefined) checkId(packageId);
    const ids = packageId === undefined ? this.list().map(item => item.packageId) : [packageId];
    const activations = this.activationRecords(), events = [];
    for (const id of ids) {
      const verified = this.readPackage(id, false), imported = this.readImport(id, verified.digest, { required: false });
      if (imported) events.push({ type: 'staged', packageId: id, digest: verified.digest, actorId: imported.importerId,
        occurredAt: imported.stagedAt, recordSha256: sha256(canonicalLegalJson(imported)) });
      else events.push({ type: 'staged', packageId: id, digest: verified.digest, actorId: null,
        occurredAt: verified.envelope.manifest.createdAt, recordSha256: null });
      let approval = null;
      try { approval = this.readApproval(id, verified.digest); }
      catch (error) { if (error.code !== 'APPROVAL_REQUIRED') throw error; }
      if (approval) events.push({ type: 'approved', packageId: id, digest: verified.digest, actorId: approval.reviewerId,
        occurredAt: approval.approvedAt, recordSha256: sha256(canonicalLegalJson(approval)), reason: approval.reason });
      for (const active of activations.filter(item => item.packageId === id)) {
        if (active.digest !== verified.digest || !approval || active.approvalSha256 !== sha256(canonicalLegalJson(approval)))
          fail('ACTIVATION_INVALID', 'История активации не соответствует согласованию.');
        events.push({ type: 'activated', packageId: id, digest: verified.digest, actorId: active.activatedBy,
          occurredAt: active.activatedAt, recordSha256: sha256(canonicalLegalJson(active)) });
      }
    }
    const rank = { staged: 0, approved: 1, activated: 2 };
    return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || rank[a.type] - rank[b.type]
      || a.packageId.localeCompare(b.packageId));
  }
  activeCorpus() {
    const active = this.readActive();
    if (!active) return null;
    const verified = this.readPackage(active.packageId), approval = this.readApproval(active.packageId, active.digest);
    if (active.digest !== verified.digest || active.approvalSha256 !== sha256(canonicalLegalJson(approval))
      || Date.parse(approval.approvedAt) > Date.parse(active.activatedAt)) fail('ACTIVATION_INVALID', 'Активный пакет не соответствует согласованию.');
    return { ...verified.corpus, packageId: active.packageId, packageDigest: active.digest,
      packageExpiresAt: verified.envelope.manifest.expiresAt, signatureKeyId: verified.envelope.signature.keyId,
      importedBy: approval.importerId, approvedBy: approval.reviewerId, approvedAt: approval.approvedAt,
      activatedBy: active.activatedBy, activatedAt: active.activatedAt };
  }
}
