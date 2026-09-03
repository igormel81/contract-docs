import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HttpError } from './security.mjs';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('./extract.py', import.meta.url));
export function format(name, data) {
  const ext = name.split('.').pop().toLowerCase();
  const hex = data.subarray(0, 8).toString('hex');
  if (!['pdf', 'doc', 'docx'].includes(ext)) throw new HttpError(415, 'Поддерживаются только PDF, DOC и DOCX.');
  if ((ext === 'pdf' && !data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) || (ext === 'doc' && hex !== 'd0cf11e0a1b11ae1') || (ext === 'docx' && !hex.startsWith('504b0304'))) throw new HttpError(415, 'Расширение не соответствует содержимому файла.');
  return ext;
}
export async function extract(path, ext, sandbox = true) {
  let cmd = 'python3', args = [script, path, ext];
  if (sandbox) {
    cmd = '/usr/bin/bwrap';
    args = ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', script, '/extract.py', '--ro-bind', path, '/document', '--chdir', '/tmp', '/usr/bin/python3', '/extract.py', '/document', ext];
  }
  try {
    const result = await exec(cmd, args, { timeout: 35000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    return { status: 'ready', extraction: JSON.parse(result.stdout) };
  } catch (e) {
    let extraction;
    try { extraction = JSON.parse(e.stdout); } catch { extraction = { blocks: [], warnings: ['Извлечение недоступно или превышено время. Повторите позже; оригинал сохранён.'], extractor: 'text-v1' }; }
    return { status: 'error', extraction };
  }
}
export function similarity(a, b) {
  const words = text => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 2));
  const left = words(a), right = words(b);
  const intersection = [...left].filter(x => right.has(x)).length;
  return intersection / Math.max(1, left.size + right.size - intersection);
}
