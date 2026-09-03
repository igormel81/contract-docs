import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function database(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'contracts.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), name TEXT NOT NULL, inn TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contracts(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), customer_id TEXT REFERENCES customers(id), title TEXT NOT NULL, contractor TEXT NOT NULL, kind TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'Подготовка', effective_id TEXT, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), contract_id TEXT REFERENCES contracts(id), name TEXT NOT NULL, ext TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, extraction TEXT, status TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(contract_id,hash));
    CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, contract_id TEXT REFERENCES contracts(id), number INTEGER NOT NULL, parent_id TEXT, file_ids TEXT NOT NULL, note TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(contract_id,number));
    CREATE TABLE IF NOT EXISTS analyses(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), contract_id TEXT REFERENCES contracts(id), revision_id TEXT REFERENCES revisions(id), status TEXT NOT NULL, snapshot TEXT NOT NULL, primary_result TEXT, review_result TEXT, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recommendations(id TEXT PRIMARY KEY, analysis_id TEXT REFERENCES analyses(id), finding_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(analysis_id,finding_id));
    CREATE TABLE IF NOT EXISTS risks(id TEXT PRIMARY KEY, contract_id TEXT REFERENCES contracts(id), title TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL, detail TEXT NOT NULL, origin TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS risk_sources(risk_id TEXT NOT NULL REFERENCES risks(id), position INTEGER NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(risk_id,position));
    CREATE TABLE IF NOT EXISTS risk_events(id TEXT PRIMARY KEY, risk_id TEXT REFERENCES risks(id), kind TEXT NOT NULL, text TEXT NOT NULL, due TEXT, state TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dismissed_findings(id TEXT PRIMARY KEY, contract_id TEXT REFERENCES contracts(id), user_id TEXT REFERENCES users(id), key TEXT NOT NULL, rule TEXT NOT NULL, title TEXT NOT NULL, reason TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(contract_id,key));
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), contract_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS throttle(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
  `);
  for (const [table, name, decl] of [['risks','finding_key','TEXT'],['contracts','manager','TEXT']]) addColumn(db, table, name, decl);
  return db;
}
// Additive migration: existing rows keep NULL, old data is never rewritten.
function addColumn(db, table, name, decl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
}
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function audit(db, user, contract, action, detail = '') {
  db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?)').run(id(), user, contract, action, detail, now());
}
