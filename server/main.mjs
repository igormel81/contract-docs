import http from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, statfs, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { database, id, now, tx, audit } from './db.mjs';
import { HttpError, required, choice, hash, token, passwordHash, passwordMatches, limit, body, jsonBody } from './security.mjs';
import { format, extract, similarity } from './documents.mjs';
import { profiles, rules, instructionVersion } from './rules.mjs';
import { CodexRunner } from './codex.mjs';
import { QuickChecks } from './quick-checks.mjs';
import { sourceRecord, resultSources } from './sources.mjs';
import { findingKey } from '../public/document-ui.js';
import { summaryText } from '../public/summary.js';
import { legalCatalog, withLegalContext } from './legal.mjs';
import { servePublication } from './publication.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const parse = value => value ? JSON.parse(value) : null;
export async function createApp(options = {}) {
  const dir = resolve(options.dir || process.env.DOCS_DATA || join(root, 'data'));
  const origin = options.origin || process.env.DOCS_ORIGIN || 'http://127.0.0.1:3107';
  const secure = new URL(origin).protocol === 'https:';
  const sandbox = options.sandbox ?? (process.env.DOCS_EXTRACT_SANDBOX !== 'off');
  if (!sandbox && secure) throw new Error('Нельзя отключать изоляцию извлечения в production.');
  const db = database(dir); await mkdir(join(dir, 'files'), { recursive: true, mode: 0o700 });
  const codexAdmin = String(options.codexAdmin ?? process.env.DOCS_CODEX_ADMIN ?? '').normalize('NFKC').trim().toLowerCase();
  const canManageCodex = user => Boolean(codexAdmin) && user.login === codexAdmin;
  function requireCodexAdmin(user) {
    if (!canManageCodex(user)) throw new HttpError(403, 'Общим подключением Codex управляет владелец приложения.');
  }
  const runner = new CodexRunner(db, dir, options.codex || process.env.DOCS_CODEX || '/usr/bin/codex');
  const runtime = options.runtime || process.env.DOCS_RUNTIME || await mkdtemp(join(tmpdir(),'contract-docs-runtime-'));
  const quick = new QuickChecks(runner,runtime,sandbox,options.quick); await quick.init();
  const dummyHash = await passwordHash(token());
  const timer = options.autoTick === false ? null : setInterval(() => runner.tick().catch(() => {}), 2000); timer?.unref();
  const cleanupTimer=setInterval(()=>quick.sweep().catch(()=>console.error('temporary cleanup failed')),30000);cleanupTimer.unref();
  let uploading = 0;
  quick.persistedUploads=()=>uploading;
  function send(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  function cookie(res, value, maxAge = 43200) { res.setHeader('Set-Cookie', `docs_session=${value}; Path=/docs; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`); }
  function owned(table, rowId, user) {
    const allowed = ['customers','contracts','files','analyses'];
    if (!allowed.includes(table)) throw new Error('Invalid ownership table');
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(rowId, user);
    if (!row) throw new HttpError(404, 'Запись не найдена или нет доступа.'); return row;
  }
  function revision(rowId, contract) {
    const row = db.prepare('SELECT * FROM revisions WHERE id=? AND contract_id=?').get(rowId, contract);
    if (!row) throw new HttpError(404, 'Редакция не найдена.'); return row;
  }
  const fileView = f => ({ ...f, extraction: parse(f.extraction) });
  const analysisView = a => ({ ...a, snapshot: undefined, legal: parse(a.snapshot)?.legal || null, rules: (parse(a.snapshot)?.rules || []).map(r => ({ id: r.id, version: r.version ?? null })), primary_result: resultSources(parse(a.primary_result),parse(a.snapshot),a.id), review_result: resultSources(parse(a.review_result),parse(a.snapshot),a.id) });
  function originFinding(origin,contract,user){
    const split=origin.indexOf(':');if(split<1)throw new HttpError(400,'Некорректная ссылка на замечание.');
    const run=owned('analyses',origin.slice(0,split),user);if(run.contract_id!==contract)throw new HttpError(400,'Замечание относится к другому договору.');
    const finding=parse(run.review_result||run.primary_result)?.findings.find(f=>f.id===origin.slice(split+1));
    if(!finding)throw new HttpError(400,'Исходное замечание не найдено.');
    return {run,finding};
  }
  function originSources(origin,contract,user){
    const {run,finding}=originFinding(origin,contract,user);
    const snapshot=parse(run.snapshot);
    return finding.sources.map(s=>{
      const ref=sourceRecord(s,snapshot.documents,{analysisId:run.id,revisionId:run.revision_id,revisionNumber:snapshot.version});
      if(!ref)throw new HttpError(400,'Цитата не подтверждена исходником.');
      return {...ref,block:snapshot.documents.find(f=>f.id===s.fileId).blocks.find(b=>b.id===s.blockId)};
    });
  }
  function riskSources(risk,user){
    const saved=db.prepare('SELECT reference FROM risk_sources WHERE risk_id=? ORDER BY position').all(risk.id).map(r=>parse(r.reference));
    if(saved.length||!risk.origin)return saved;
    try{return originSources(risk.origin,risk.contract_id,user);}catch{return [];}
  }
  function session(req) {
    const value = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('docs_session='))?.slice(13);
    if (!value) return null;
    return db.prepare('SELECT u.id,u.login,s.token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(hash(value), Date.now());
  }
  async function route(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(req.url, origin), path = url.pathname;
    if (req.method === 'GET' && path === '/docs') { res.writeHead(308, { Location: '/docs/' }); return res.end(); }
    if (req.method === 'GET' && path === '/docs/health') return send(res, 200, { status: 'ok', version: '0.2.1' });
    if (await servePublication(req,res,path,root)) return;
    const publicFiles = { '/docs/': ['index.html','text/html'], '/docs/app.js': ['app.js','text/javascript'], '/docs/quick.js': ['quick.js','text/javascript'], '/docs/document-ui.js': ['document-ui.js','text/javascript'], '/docs/summary.js': ['summary.js','text/javascript'], '/docs/app.css': ['app.css','text/css'] };
    if (req.method === 'GET' && publicFiles[path]) {
      const [name, type] = publicFiles[path]; const content = await readFile(join(root, 'public', name));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
    }
    if (!path.startsWith('/docs/api/')) throw new HttpError(404, 'Не найдено.');
    if (!['GET','POST','PATCH'].includes(req.method)) throw new HttpError(405, 'Метод не поддерживается.');
    if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['x-docs-request'] !== '1')) throw new HttpError(403, 'Запрос не подтверждён. Обновите страницу приложения.');
    const ip = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
    if (req.method === 'POST' && ['/docs/api/login','/docs/api/register'].includes(path)) {
      limit(db, `auth:${ip}`, 30, 15 * 60000);
      const input = await jsonBody(req); const login = required(input.login, 64).normalize('NFKC').toLowerCase();
      if (!/^[\p{L}\p{N}_.-]{3,64}$/u.test(login)) throw new HttpError(400, 'Логин: 3–64 буквы, цифры, точка, дефис или подчёркивание.');
      required(input.password, 256); const password = input.password;
      let user = db.prepare('SELECT * FROM users WHERE login=?').get(login);
      if (path.endsWith('/register')) {
        limit(db, `register:${ip}`, 5, 3600000);
        if (password.length < 10) throw new HttpError(400, 'Пароль должен содержать минимум 10 символов.');
        if (user) throw new HttpError(409, 'Этот логин уже занят.');
        const stored = await passwordHash(password); user = { id: id(), login };
        try { db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(user.id, login, stored, now()); } catch { throw new HttpError(409, 'Этот логин уже занят.'); }
      } else {
        const matches = await passwordMatches(password, user?.password || dummyHash);
        if (!user || !matches) throw new HttpError(401, 'Неверный логин или пароль.');
      }
      const value = token(); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(value), user.id, Date.now() + 12 * 3600000);
      cookie(res, value); return send(res, 200, { id: user.id, login: user.login });
    }
    const user = session(req); if (!user) throw new HttpError(401, 'Войдите в приложение.');
    limit(db, `requests:${user.id}`, 600, 60000);
    if (path === '/docs/api/me') {
      if (req.method === 'GET') return send(res, 200, { id: user.id, login: user.login });
      const input = await jsonBody(req); const stored = db.prepare('SELECT password FROM users WHERE id=?').get(user.id);
      required(input.current,256); if (!await passwordMatches(input.current, stored.password)) throw new HttpError(400, 'Текущий пароль неверен.');
      required(input.password,256); const password = input.password; if (password.length < 10) throw new HttpError(400, 'Минимум 10 символов.');
      const encoded = await passwordHash(password);
      tx(db, () => { db.prepare('UPDATE users SET password=? WHERE id=?').run(encoded,user.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); });
      cookie(res,'',0); return send(res,200,{ ok:true });
    }
    if (path === '/docs/api/logout' && req.method === 'POST') { db.prepare('DELETE FROM sessions WHERE token=?').run(user.token); cookie(res,'',0); return send(res,200,{ok:true}); }
    if (path === '/docs/api/bootstrap' && req.method === 'GET') return send(res,200,{
      customers: db.prepare('SELECT * FROM customers WHERE user_id=? ORDER BY name').all(user.id),
      contracts: db.prepare('SELECT c.*, (SELECT COUNT(*) FROM revisions r WHERE r.contract_id=c.id) revision_count FROM contracts c WHERE user_id=? ORDER BY created DESC').all(user.id),
      profiles, rules: withLegalContext({rules}).rules, legal: legalCatalog(), codex: await runner.status(canManageCodex(user))
    });
    if (path === '/docs/api/legal-base' && req.method === 'GET') return send(res,200,legalCatalog());
    if (path === '/docs/api/codex' && req.method === 'GET') return send(res,200,await runner.status(canManageCodex(user)));
    if (path === '/docs/api/codex/login' && req.method === 'POST') {
      requireCodexAdmin(user); limit(db,'codex-login:application',5,3600000);
      const connection = await runner.login(); audit(db,user.id,null,'Начат общий вход Codex'); return send(res,200,connection);
    }
    if (path === '/docs/api/codex/logout' && req.method === 'POST') {
      requireCodexAdmin(user); const input=await jsonBody(req);
      if (input.confirm !== 'disconnect-application') throw new HttpError(400,'Подтвердите отключение Codex для всего приложения.');
      await runner.logout(); audit(db,user.id,null,'Общее подключение Codex отключено'); return send(res,200,{ok:true});
    }
    if (path === '/docs/api/quick-checks') {
      if (req.method === 'GET') return send(res,200,quick.list(user.id));
      if (req.method === 'POST') {
        limit(db,`quick-create:${user.id}`,20,3600000);
        const input=await jsonBody(req);return send(res,201,quick.create(user.id,input.contractor));
      }
    }
    const quickMatch=path.match(/^\/docs\/api\/quick-checks\/([\w-]+)(?:\/(files|analyze|discard|export))?(?:\/([\w-]+)\/(remove))?$/);
    if (quickMatch) {
      const packet=quick.own(quickMatch[1],user.id),action=quickMatch[2];
      if (!action&&req.method==='GET')return send(res,200,quick.view(packet));
      if(action==='files'&&req.method==='POST'){
        if(quickMatch[4]){quick.removeFile(packet,quickMatch[3]);return send(res,200,quick.view(packet));}
        const uploaded=await quick.upload(packet,req);return send(res,uploaded.duplicate?200:201,uploaded);
      }
      if(action==='analyze'&&req.method==='POST'){
        limit(db,`analyses:${user.id}`,10,3600000);return send(res,202,await quick.start(packet));
      }
      if(action==='discard'&&req.method==='POST'){await quick.discard(packet);return send(res,200,{ok:true});}
      if(action==='export'&&req.method==='GET'){
        if(!packet.primary&&!packet.review)throw new HttpError(409,'Результат ещё не получен.');
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="one-time-contract-review.json"'});
        return res.end(JSON.stringify(quick.view(packet),null,2));
      }
      throw new HttpError(405,'Действие не поддерживается.');
    }
    if (path === '/docs/api/customers' && req.method === 'POST') {
      const input = await jsonBody(req); const name = required(input.name,200); const inn = String(input.inn || '').trim();
      if (inn && !/^\d{10}(\d{2})?$/.test(inn)) throw new HttpError(400,'ИНН должен содержать 10 или 12 цифр.');
      const key = id(); db.prepare('INSERT INTO customers VALUES(?,?,?,?,?)').run(key,user.id,name,inn,now()); return send(res,201,{id:key});
    }
    if (path === '/docs/api/contracts' && req.method === 'POST') {
      const input = await jsonBody(req); const kind = choice(input.kind || 'contract',['contract','template']);
      const customer = kind === 'contract' ? owned('customers',required(input.customer_id),user.id).id : null;
      const key = id(); db.prepare('INSERT INTO contracts(id,user_id,customer_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?,?)').run(key,user.id,customer,required(input.title,200),choice(input.contractor,Object.keys(profiles)),kind,now());
      audit(db,user.id,key,kind === 'template' ? 'Создан шаблон' : 'Создан договор'); return send(res,201,{id:key});
    }
    let match = path.match(/^\/docs\/api\/contracts\/([\w-]+)(?:\/(files|revisions|analyses|risks|effective|compare|dismissed))?$/);
    if (match) {
      const contract = owned('contracts',match[1],user.id), action = match[2];
      if (!action && req.method === 'GET') return send(res,200,{
        ...contract,
        files: db.prepare('SELECT * FROM files WHERE contract_id=? ORDER BY created').all(contract.id).map(fileView),
        revisions: db.prepare('SELECT * FROM revisions WHERE contract_id=? ORDER BY number DESC').all(contract.id).map(r=>({...r,file_ids:parse(r.file_ids)})),
        analyses: db.prepare('SELECT * FROM analyses WHERE contract_id=? ORDER BY created DESC').all(contract.id).map(analysisView),
        recommendations: db.prepare('SELECT r.* FROM recommendations r JOIN analyses a ON a.id=r.analysis_id WHERE a.contract_id=?').all(contract.id),
        risks: db.prepare('SELECT * FROM risks WHERE contract_id=? ORDER BY created DESC').all(contract.id).map(r=>({...r,sources:riskSources(r,user.id),events:db.prepare('SELECT * FROM risk_events WHERE risk_id=? ORDER BY created DESC').all(r.id)})),
        dismissed: db.prepare('SELECT key,rule,title,reason,created FROM dismissed_findings WHERE contract_id=? ORDER BY created DESC').all(contract.id),
        history: db.prepare('SELECT action,detail,created FROM audit WHERE contract_id=? ORDER BY created DESC LIMIT 200').all(contract.id)
      });
      if (!action && req.method === 'PATCH') {
        const input = await jsonBody(req);
        if (input.manager !== undefined) {
          const manager=String(input.manager||'').trim().slice(0,200);
          tx(db,()=>{db.prepare('UPDATE contracts SET manager=? WHERE id=?').run(manager||null,contract.id);audit(db,user.id,contract.id,'Указан ответственный за договор',manager||'не указан');});
          return send(res,200,{ok:true});
        }
        const reason=required(input.reason,1000), stage=choice(input.stage,['Подготовка','Согласование','Подписан','Исполнение','Завершён','Прекращён','Архив']);
        tx(db,()=>{db.prepare('UPDATE contracts SET stage=? WHERE id=?').run(stage,contract.id);audit(db,user.id,contract.id,'Изменена стадия',`${stage}: ${reason}`);}); return send(res,200,{ok:true});
      }
      if (action === 'files' && req.method === 'POST') {
        if (uploading+quick.uploads >= 2) throw new HttpError(429,'Обрабатываются другие файлы. Повторите загрузку через минуту.');
        uploading++;
        try {
          let name; try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { throw new HttpError(400,'Некорректное имя файла.'); }
          name = required(basename(name.replaceAll('\\','/')),240); if (/[\x00-\x1f]/.test(name)) throw new HttpError(400,'Некорректное имя файла.');
          const bytes = await body(req,20*1024*1024); const ext = format(name,bytes); const digest = hash(bytes);
          const duplicate = db.prepare('SELECT * FROM files WHERE contract_id=? AND hash=?').get(contract.id,digest);
          if (duplicate) return send(res,200,{duplicate:true,file:fileView(duplicate)});
          if(db.prepare('SELECT COUNT(*) n FROM files WHERE user_id=?').get(user.id).n>=500) throw new HttpError(413,'Лимит пилота: 500 файлов на аккаунт.');
          const total = db.prepare('SELECT COALESCE(SUM(size),0) size FROM files').get().size;
          const personal = db.prepare('SELECT COALESCE(SUM(size),0) size FROM files WHERE user_id=?').get(user.id).size;
          const disk = await statfs(dir);
          if (total + bytes.length > 2*1024**3 || personal + bytes.length > 200*1024**2 || disk.bavail*disk.bsize < bytes.length+512*1024**2) throw new HttpError(413,'Лимит хранилища пилота. Обратитесь к администратору.');
          const key = id(); await writeFile(join(dir,'files',key),bytes,{flag:'wx',mode:0o600});
          const concurrent=db.prepare('SELECT * FROM files WHERE contract_id=? AND hash=?').get(contract.id,digest);
          if(concurrent){await unlink(join(dir,'files',key));return send(res,200,{duplicate:true,file:fileView(concurrent)});}
          db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,user.id,contract.id,name,ext,digest,bytes.length,null,'processing',now());
          const extracted = await extract(join(dir,'files',key),ext,sandbox);
          db.prepare('UPDATE files SET status=?,extraction=? WHERE id=?').run(extracted.status,JSON.stringify(extracted.extraction),key);
          const text = extracted.extraction.blocks.map(b=>b.text).join('\n');
          const similar = db.prepare('SELECT * FROM files WHERE contract_id=? AND id<>? AND status=?').all(contract.id,key,'ready').map(f=>({id:f.id,name:f.name,score:similarity(text,parse(f.extraction).blocks.map(b=>b.text).join('\n'))})).filter(x=>x.score>=0.7).sort((a,b)=>b.score-a.score).slice(0,3);
          audit(db,user.id,contract.id,'Загружен оригинал',name);
          return send(res,201,{duplicate:false,file:fileView(owned('files',key,user.id)),similar});
        } finally { uploading--; }
      }
      if (action === 'revisions' && req.method === 'POST') {
        const input = await jsonBody(req); const ids = input.file_ids;
        if (!Array.isArray(ids) || !ids.length || ids.length>50 || new Set(ids).size!==ids.length) throw new HttpError(400,'Выберите от 1 до 50 разных файлов.');
        for (const key of ids) if (owned('files',key,user.id).contract_id!==contract.id) throw new HttpError(400,'Файл относится к другому договору.');
        if (input.parent_id) revision(input.parent_id,contract.id);
        const key = id();
        const result = tx(db,()=>{
          const number = db.prepare('SELECT COALESCE(MAX(number),0)+1 n FROM revisions WHERE contract_id=?').get(contract.id).n;
          const previous = db.prepare('SELECT * FROM revisions WHERE contract_id=? ORDER BY number DESC LIMIT 1').get(contract.id);
          if (previous && [...parse(previous.file_ids)].sort().join() === [...ids].sort().join()) throw new HttpError(409,'Этот комплект уже сохранён. Новая редакция не нужна.');
          db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)').run(key,contract.id,number,input.parent_id||null,JSON.stringify(ids),required(input.note||'Новый комплект',1000),now());
          audit(db,user.id,contract.id,'Зафиксирована редакция',`v${number}`); return {id:key,number};
        }); return send(res,201,result);
      }
      if (action === 'effective' && req.method === 'POST') {
        const input=await jsonBody(req); revision(input.revision_id,contract.id); const reason=required(input.reason,1000);
        tx(db,()=>{db.prepare('UPDATE contracts SET effective_id=? WHERE id=?').run(input.revision_id,contract.id); audit(db,user.id,contract.id,'Подтверждён действующий комплект',`${input.revision_id}: ${reason}`);}); return send(res,200,{ok:true});
      }
      if (action === 'analyses' && req.method === 'POST') {
        const input=await jsonBody(req); const rev=revision(required(input.revision_id),contract.id);
        if (!(await runner.status()).connected) throw new HttpError(409,'Общий Codex не подключён. Владелец приложения должен выполнить вход в настройках.');
        if (db.prepare("SELECT id FROM analyses WHERE revision_id=? AND status IN ('queued','primary','review')").get(rev.id)) throw new HttpError(409,'Этот комплект уже в очереди или анализируется.');
        limit(db,`analyses:${user.id}`,10,3600000);
        const files = parse(rev.file_ids).map(key=>owned('files',key,user.id));
        if (files.some(f=>f.status!=='ready')) throw new HttpError(409,'В комплекте есть непрочитанные файлы. Исправьте их или явно исключите из новой редакции.');
        const documents=files.map(f=>({id:f.id,name:f.name,hash:f.hash,...parse(f.extraction)}));
        if (JSON.stringify(documents).length>360000) throw new HttpError(413,'Комплект слишком велик для пилота (360 000 символов). Анализ не запущен.');
        // Подрядчика выбирают руками, и ошибка в списке разворачивает весь анализ не в ту
        // сторону. Проверяем по ИНН: это подсказка человеку и модели, а не запрет.
        const plain=documents.flatMap(f=>f.blocks.map(b=>b.text)).join(' ').replace(/[^0-9]+/g,' ');
        const mine=profiles[contract.contractor].inn, other=Object.values(profiles).map(p=>p.inn).filter(inn=>inn!==mine);
        const sideNote=plain.includes(mine)?null:other.find(inn=>plain.includes(inn))
          ?'ИНН выбранного подрядчика в тексте не найден, зато найден ИНН другого профиля. Проверьте, та ли сторона выбрана; вывод об интересах стороны сделай с этой оговоркой.'
          :'ИНН выбранного подрядчика в тексте не найден. Возможно, реквизиты не извлеклись или выбрана не та сторона: отрази это в ограничениях.';
        const snapshot=withLegalContext({revisionId:rev.id,version:rev.number,kind:contract.kind,profile:profiles[contract.contractor],contractorNote:sideNote,rules,instructionVersion,documents,created:now()});
        const key=id(); db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(key,user.id,contract.id,rev.id,'queued',JSON.stringify(snapshot),now(),now());
        audit(db,user.id,contract.id,'Запущен анализ',`v${rev.number}${sideNote?'; '+sideNote:''}`); return send(res,202,{id:key,note:sideNote});
      }
      if (action === 'dismissed' && req.method === 'POST') {
        if (contract.kind==='template') throw new HttpError(400,'Кандидаты в риски есть только у реальных договоров.');
        const input=await jsonBody(req); const key=required(String(input.key||''),400);
        if (input.restore) {
          const removed=db.prepare('DELETE FROM dismissed_findings WHERE contract_id=? AND key=?').run(contract.id,key);
          if(removed.changes) audit(db,user.id,contract.id,'Кандидат в риски возвращён',key);
          return send(res,200,{ok:true});
        }
        const rule=required(String(input.rule||''),40), title=required(String(input.title||''),200), reason=required(input.reason,1000);
        db.prepare('INSERT INTO dismissed_findings VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(contract_id,key) DO UPDATE SET reason=excluded.reason,created=excluded.created').run(id(),contract.id,user.id,key,rule,title,reason,now());
        audit(db,user.id,contract.id,'Замечание отклонено как кандидат в риски',`${title}: ${reason}`);
        return send(res,201,{ok:true});
      }
      if (action === 'risks' && req.method === 'POST') {
        if (contract.kind==='template') throw new HttpError(400,'Реестр рисков ведётся по реальному договору, не по шаблону.');
        const input=await jsonBody(req); const key=id();
        const origin=String(input.origin||'').slice(0,300);
        const candidate=origin?findingKey(originFinding(origin,contract.id,user.id).finding):null;
        let references=origin?originSources(origin,contract.id,user.id):[];
        if(!origin&&input.source){
          const {fileId,blockId,revisionId}=input.source,rev=revision(required(revisionId),contract.id);
          if(!parse(rev.file_ids).includes(fileId))throw new HttpError(400,'Пункт не входит в выбранную редакцию.');
          const file=owned('files',fileId,user.id),extraction=parse(file.extraction),block=extraction?.blocks.find(b=>b.id===blockId);
          if(file.contract_id!==contract.id||!block)throw new HttpError(400,'Пункт не найден в договоре.');
          const ref=sourceRecord({fileId,blockId,quote:block.text.slice(0,15000)},[{id:file.id,name:file.name,hash:file.hash,...extraction}],{analysisId:null,revisionId:rev.id,revisionNumber:rev.number});
          if(!ref)throw new HttpError(400,'Для ссылки нужен читаемый пункт.');
          references=[{...ref,block}];
        }
        tx(db,()=>{
          db.prepare('INSERT INTO risks(id,contract_id,title,severity,status,owner,detail,origin,finding_key,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(key,contract.id,required(input.title,200),choice(input.severity,['high','medium','low']),'Открыт',required(input.owner,100),required(input.detail,5000),origin,candidate,now(),now());
          references.forEach((reference,position)=>db.prepare('INSERT INTO risk_sources VALUES(?,?,?)').run(key,position,JSON.stringify(reference)));
        });
        audit(db,user.id,contract.id,'Зарегистрирован риск',input.title); return send(res,201,{id:key});
      }
    }
    match=path.match(/^\/docs\/api\/files\/([\w-]+)\/(download|retry|structure)$/);
    if(match){
      const f=owned('files',match[1],user.id);
      if(match[2]==='download'&&req.method==='GET'){
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="document.${f.ext}"; filename*=UTF-8''${encodeURIComponent(f.name)}`}); return res.end(await readFile(join(dir,'files',f.id)));
      }
      if(['retry','structure'].includes(match[2])&&req.method==='POST'){
        if(f.status==='ready'&&match[2]==='retry') throw new HttpError(409,'Файл уже прочитан.');
        if(uploading+quick.uploads>=2) throw new HttpError(429,'Обработка занята. Повторите позже.'); uploading++;
        try{const result=await extract(join(dir,'files',f.id),f.ext,sandbox);if(match[2]==='structure'&&result.status!=='ready')throw new HttpError(422,'Не удалось обновить структуру. Прежний текст и анализы сохранены.');db.prepare('UPDATE files SET status=?,extraction=? WHERE id=?').run(result.status,JSON.stringify(result.extraction),f.id); return send(res,200,result);} finally{uploading--;}
      }
    }
    match=path.match(/^\/docs\/api\/analyses\/([\w-]+)\/(retry|cancel|recommendation|export|documents|summary|proposal)$/);
    if(match){
      const analysis=owned('analyses',match[1],user.id); const action=match[2];
      if(action==='documents'&&req.method==='GET')return send(res,200,parse(analysis.snapshot).documents);
      if(action==='export'&&req.method==='GET'){
        const edited=db.prepare('SELECT * FROM recommendations WHERE analysis_id=?').all(analysis.id);
        audit(db,user.id,analysis.contract_id,'Выгружен результат анализа (JSON)',analysis.id);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="contract-analysis.json"'}); return res.end(JSON.stringify({...analysisView(analysis),recommendations:edited},null,2));
      }
      if(action==='summary'&&req.method==='GET'){
        const stored=parse(analysis.review_result||analysis.primary_result);
        if(!stored) throw new HttpError(409,'Результат ещё не получен.');
        const card=owned('contracts',analysis.contract_id,user.id);
        const snapshot=parse(analysis.snapshot), full=url.searchParams.get('scope')==='full';
        const text=summaryText({full,result:resultSources(stored,snapshot,analysis.id),meta:{
          title:card.title, customer:card.customer_id?db.prepare('SELECT name FROM customers WHERE id=?').get(card.customer_id)?.name:null,
          contractor:profiles[card.contractor].name, manager:card.manager||null,
          revision:db.prepare('SELECT number FROM revisions WHERE id=?').get(analysis.revision_id)?.number,
          created:new Date(analysis.created).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}),
          reviewed:Boolean(analysis.review_result), link:`${origin}/docs/#${card.id}`, files:snapshot.documents}});
        audit(db,user.id,card.id,'Сформирован текст замечаний для отправки',`${full?'полный список':'короткая сводка'}, ${text.length} знаков`);
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8',...(url.searchParams.get('download')?{'Content-Disposition':'attachment; filename="contract-findings.txt"'}:{})}); return res.end(text);
      }
      if(req.method==='POST'&&action==='retry'){
        if(!['error','interrupted'].includes(analysis.status)) throw new HttpError(409,'Эта попытка не требует повторения.');
        if(!(await runner.status()).connected) throw new HttpError(409,'Общий Codex не подключён. Обратитесь к владельцу приложения.');
        const key=id(); db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,primary_result,created,updated) VALUES(?,?,?,?,?,?,?,?,?)').run(key,user.id,analysis.contract_id,analysis.revision_id,'queued',analysis.snapshot,analysis.primary_result,now(),now());
        audit(db,user.id,analysis.contract_id,'Повтор анализа с сохранением прежней попытки',analysis.id); return send(res,202,{id:key});
      }
      if(req.method==='POST'&&action==='cancel'){
        db.prepare("UPDATE analyses SET status='cancelled',updated=? WHERE id=? AND status IN ('queued','primary','review')").run(now(),analysis.id); runner.cancel(user.id,analysis.id); return send(res,200,{ok:true});
      }
      if(req.method==='POST'&&action==='proposal'){
        const input=await jsonBody(req); const stored=parse(analysis.review_result||analysis.primary_result);
        const finding=stored?.findings.find(f=>f.id===input.finding_id);
        if(!finding) throw new HttpError(404,'Замечание не найдено.');
        limit(db,`proposal:${user.id}`,30,3600000);
        const snapshot=parse(analysis.snapshot);
        const clauses=finding.sources.map(s=>{
          const document=snapshot.documents.find(d=>d.id===s.fileId), block=document?.blocks.find(b=>b.id===s.blockId);
          return block?{document:document.name,clause:block.locator?.label||'без номера',text:block.text.slice(0,6000)}:null;
        }).filter(Boolean);
        const rule=snapshot.rules.find(r=>r.id===finding.rule);
        const answer=await runner.proposal({profile:snapshot.profile,rule:rule&&{id:rule.id,title:rule.title,instruction:rule.instruction,avoid:rule.avoid},
          finding:{rule:finding.rule,title:finding.title,description:finding.description,severity:finding.severity,legalSources:finding.legalSources||[]},
          legal:snapshot.legal?{...snapshot.legal,norms:snapshot.legal.norms.filter(n=>(finding.legalSources||[]).some(s=>s.normId===n.id))}:null,clauses});
        audit(db,user.id,analysis.contract_id,'Запрошена формулировка правки',`${finding.rule}: ${finding.title}`);
        return send(res,200,{proposal:answer.proposal,note:answer.note});
      }
      if(req.method==='POST'&&action==='recommendation'){
        const input=await jsonBody(req); const result=parse(analysis.review_result||analysis.primary_result);
        if(!result?.findings.some(f=>f.id===input.finding_id)) throw new HttpError(404,'Замечание не найдено.');
        const text=required(input.text,15000), status=choice(input.status,['draft','planned','rejected']);
        tx(db,()=>{db.prepare('INSERT INTO recommendations VALUES(?,?,?,?,?,?) ON CONFLICT(analysis_id,finding_id) DO UPDATE SET text=excluded.text,status=excluded.status,updated=excluded.updated').run(id(),analysis.id,input.finding_id,text,status,now()); audit(db,user.id,analysis.contract_id,'Обновлён план правок',JSON.stringify({analysis:analysis.id,finding:input.finding_id,text,status}));}); return send(res,200,{ok:true});
      }
    }
    match=path.match(/^\/docs\/api\/risks\/([\w-]+)(?:\/(events))?$/);
    if(match){
      const risk=db.prepare('SELECT * FROM risks WHERE id=?').get(match[1]); if(!risk) throw new HttpError(404,'Риск не найден.'); owned('contracts',risk.contract_id,user.id);
      if(req.method==='PATCH'){
        const input=await jsonBody(req); const status=choice(input.status,['Открыт','Снижаем','На проверке','Закрыт']); const reason=required(input.reason,2000);
        tx(db,()=>{db.prepare('UPDATE risks SET status=?,updated=? WHERE id=?').run(status,now(),risk.id);db.prepare('INSERT INTO risk_events VALUES(?,?,?,?,?,?,?)').run(id(),risk.id,'decision',`${status}: ${reason}`,null,'recorded',now());audit(db,user.id,risk.contract_id,'Изменён статус риска',`${risk.title}: ${status}; ${reason}`);}); return send(res,200,{ok:true});
      }
      if(req.method==='POST'&&match[2]==='events'){
        const input=await jsonBody(req); const kind=choice(input.kind,['mitigation','incident','note']); const text=required(input.text,5000);
        const due=input.due||null; if(due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new HttpError(400,'Неверная дата.');
        const key=id();db.prepare('INSERT INTO risk_events VALUES(?,?,?,?,?,?,?)').run(key,risk.id,kind,text,due,kind==='incident'?'unverified':kind==='mitigation'?'open':'recorded',now());
        audit(db,user.id,risk.contract_id,kind==='incident'?'Зарегистрирован сигнал о наступлении риска':'Добавлена запись риска',text); return send(res,201,{id:key});
      }
    }
    match=path.match(/^\/docs\/api\/risk-events\/([\w-]+)$/);
    if(match&&req.method==='PATCH'){
      const event=db.prepare('SELECT e.*,r.contract_id FROM risk_events e JOIN risks r ON r.id=e.risk_id WHERE e.id=?').get(match[1]); if(!event)throw new HttpError(404,'Запись не найдена.');owned('contracts',event.contract_id,user.id);
      const input=await jsonBody(req); const state=choice(input.state,event.kind==='incident'?['unverified','confirmed','dismissed']:['open','verification','done']); const reason=required(input.reason,3000);
      tx(db,()=>{db.prepare('UPDATE risk_events SET state=? WHERE id=?').run(state,event.id);db.prepare('INSERT INTO risk_events VALUES(?,?,?,?,?,?,?)').run(id(),event.risk_id,'decision',`${event.id}: ${state}; ${reason}`,null,'recorded',now());audit(db,user.id,event.contract_id,'Обновлено мероприятие/событие риска',reason);}); return send(res,200,{ok:true});
    }
    throw new HttpError(404,'Действие не найдено.');
  }
  const server=http.createServer((req,res)=>route(req,res).catch(e=>{if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'Не удалось выполнить действие. Повторите позже.'});else res.end();if(!e.status)console.error('request failed',e.code||e.name);}));
  server.requestTimeout=45000; server.headersTimeout=15000;
  let disposal;
  function dispose(){return disposal??=(async()=>{clearInterval(timer);clearInterval(cleanupTimer);runner.closing=true;await Promise.all([quick.close(),runner.stop()]);db.close();})();}
  server.on('close',()=>{void dispose().catch(()=>console.error('shutdown cleanup failed'));});
  async function close(){await new Promise(resolve=>server.close(resolve));await dispose();}
  return {server,db,runner,dir,quick,close};
}
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp(); const port=Number(process.env.DOCS_PORT||3107);
  app.server.listen(port,'127.0.0.1',()=>console.log(`Contract workspace ready at http://127.0.0.1:${port}/docs/`));
  process.on('SIGTERM',()=>{void app.close().then(()=>process.exit(0));});
}
