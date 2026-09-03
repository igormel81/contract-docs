import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
let activeHashes = 0;
export const hash = data => createHash('sha256').update(data).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function required(value, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, 'Проверьте обязательные поля и длину текста.');
  return value.trim();
}
export function choice(value, allowed) {
  if (!allowed.includes(value)) throw new HttpError(400, 'Недопустимое значение.');
  return value;
}
export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  if (activeHashes >= 3) throw new HttpError(429,'Вход временно занят. Повторите через несколько секунд.');
  activeHashes++;
  try {
    const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `${salt}:${key.toString('hex')}`;
  } finally { activeHashes--; }
}
export async function passwordMatches(password, stored) {
  const [salt, key] = stored.split(':');
  const actual = (await passwordHash(password, salt)).split(':')[1];
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(key, 'hex'));
}
export function limit(db, key, max, ms) {
  const time = Date.now();
  db.prepare('DELETE FROM throttle WHERE until < ?').run(time);
  let value = db.prepare('SELECT * FROM throttle WHERE key=?').get(key);
  if (!value) { db.prepare('INSERT INTO throttle VALUES(?,?,?)').run(key, 1, time + ms); return; }
  if (value.count >= max) throw new HttpError(429, 'Слишком много попыток. Подождите и повторите.');
  db.prepare('UPDATE throttle SET count=count+1 WHERE key=?').run(key);
}
export async function body(req, max = 1024 * 1024) {
  if (Number(req.headers['content-length']) > max) throw new HttpError(413, 'Файл или запрос слишком большой. Максимум 20 МБ на файл.');
  const parts = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > max) throw new HttpError(413, 'Превышен лимит размера запроса.'); parts.push(part); }
  return Buffer.concat(parts);
}
export async function jsonBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Ожидается JSON.');
  try { return JSON.parse((await body(req)).toString()); } catch (e) { if (e.status) throw e; throw new HttpError(400, 'Некорректный JSON.'); }
}
