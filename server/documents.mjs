import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HttpError } from './security.mjs';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('./extract.py', import.meta.url));
const extractionEnvironment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
const outputLimit = 4 * 1024 * 1024;

// OCR has its own 110s deadline and kills each tool's process group. The outer
// deadline allows cleanup before terminating bubblewrap. Only a Linux PID
// namespace can contain tools which start their own sessions. Deployments still
// need cgroup CPU/RAM/PIDs limits and a real kill/namespace cleanup acceptance test.
function runOcr(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: extractionEnvironment });
    let chunks = [], bytes = 0, failure, grace;
    const signalGroup = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') { try { child.kill(signal); } catch {} } }
    };
    const stop = message => {
      if (failure) return;
      failure = message;
      chunks = [];
      signalGroup('SIGTERM');
      grace = setTimeout(() => signalGroup('SIGKILL'), 5000);
    };
    const deadline = setTimeout(() => stop('OCR: превышен общий срок извлечения. Анализ не выполнен; оригинал сохранён.'), 120000);
    const cleanup = () => { clearTimeout(deadline); clearTimeout(grace); };
    child.stdout.on('data', chunk => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > outputLimit) stop('OCR: превышен безопасный размер результата. Текст не обрезан; анализ не выполнен.');
      else chunks.push(chunk);
    });
    child.once('error', () => {
      cleanup();
      reject(new Error('OCR: изолированный запуск недоступен. Требуются Linux, bubblewrap и заранее установленные Poppler, Tesseract rus+eng.'));
    });
    child.once('close', code => {
      cleanup();
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (failure) reject(new Error(failure));
      else if (code !== 0) reject(Object.assign(new Error('OCR: извлечение не выполнено. Проверьте установку и исходный документ.'), { stdout }));
      else resolve({ stdout });
    });
  });
}
export function format(name, data) {
  const ext = name.split('.').pop().toLowerCase();
  const hex = data.subarray(0, 8).toString('hex');
  if (!['pdf', 'doc', 'docx'].includes(ext)) throw new HttpError(415, 'Поддерживаются только PDF, DOC и DOCX.');
  if ((ext === 'pdf' && !data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) || (ext === 'doc' && hex !== 'd0cf11e0a1b11ae1') || (ext === 'docx' && !hex.startsWith('504b0304'))) throw new HttpError(415, 'Расширение не соответствует содержимому файла.');
  return ext;
}
export async function extract(path, ext, sandbox = true, options = {}) {
  const ocr = options?.ocr === true && ext === 'pdf';
  if (ocr && (!sandbox || process.platform !== 'linux')) {
    return { status: 'error', extraction: { blocks: [], warnings: ['OCR доступен только в изолированном Linux-контуре bubblewrap. Запуск без sandbox запрещён; оригинал сохранён.'], extractor: 'structure-v3' } };
  }
  let cmd = 'python3', args = [script, path, ext];
  if (sandbox) {
    cmd = '/usr/bin/bwrap';
    args = ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', script, '/extract.py', '--ro-bind', path, '/document', '--chdir', '/tmp', '/usr/bin/python3', '/extract.py', '/document', ext];
  }
  // Packaged tessdata under /usr/share (or /usr/local/share) is already read-only
  // inside the sandbox. No external tessdata mount, environment override, network,
  // language download or non-sandbox fallback is permitted.
  if (ocr) args.push('--ocr');
  try {
    const result = ocr ? await runOcr(cmd, args) : await exec(cmd, args, { timeout: 35000, maxBuffer: outputLimit, env: extractionEnvironment });
    return { status: 'ready', extraction: JSON.parse(result.stdout) };
  } catch (e) {
    let extraction;
    try { extraction = JSON.parse(e.stdout); } catch { extraction = { blocks: [], warnings: [ocr && e.message?.startsWith('OCR:') ? e.message : 'Извлечение недоступно или превышено время. Повторите позже; оригинал сохранён.'], extractor: ocr ? 'structure-v3' : 'text-v1' }; }
    return { status: 'error', extraction };
  }
}
export function similarity(a, b) {
  const words = text => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 2));
  const left = words(a), right = words(b);
  const intersection = [...left].filter(x => right.has(x)).length;
  return intersection / Math.max(1, left.size + right.size - intersection);
}
