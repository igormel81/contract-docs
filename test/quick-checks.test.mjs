import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/main.mjs';
import { textReport } from '../public/quick.js';

const fake=fileURLToPath(new URL('./fake-codex.py',import.meta.url));
function document(text){return execFileSync('python3',['-c',`import io,zipfile,sys,html
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+html.escape(sys.argv[1])+'</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())`,text]);}
async function until(check){for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Test process did not reach expected state');}
async function files(root){const all=[];for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())all.push(...await files(path));else all.push(path);}return all;}
async function fixture(t,quickOptions={}){
  const root=await mkdtemp(join(tmpdir(),'docs-quick-test-')),dir=join(root,'data'),runtime=join(root,'runtime');let clock=Date.now();
  const options={dir,runtime,origin:'http://127.0.0.1:3107',sandbox:false,autoTick:false,codexAdmin:'owner',codex:fake,quick:{clock:()=>clock,...quickOptions}};
  let app,base;
  async function start(){app=await createApp(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}/docs/api`;}
  await start();
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  async function request(path,data,cookie='',headers={}){
    const res=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:options.origin,'X-Docs-Request':'1','Content-Type':'application/json',Cookie:cookie,...headers},body:data===undefined?undefined:JSON.stringify(data)});
    return{status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  const a=await request('/register',{login:'owner',password:'synthetic-owner-password'}),b=await request('/register',{login:'member',password:'synthetic-member-password'});
  assert.equal(a.status,200);assert.equal(b.status,200);
  async function upload(key,bytes,name='fixture.docx',cookie=a.cookie){const res=await fetch(base+`/quick-checks/${key}/files`,{method:'POST',headers:{Origin:options.origin,'X-Docs-Request':'1','X-File-Name':encodeURIComponent(name),Cookie:cookie},body:bytes});return{status:res.status,data:await res.json()};}
  async function connect(){await mkdir(app.runner.home(),{recursive:true});await writeFile(join(app.runner.home(),'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-test-only'}}));}
  return{get app(){return app;},dir,runtime,request,upload,a,b,connect,advance:ms=>{clock+=ms;},restart:async()=>{await app.close();await start();}};
}
function emptyCatalogue(app){for(const table of ['customers','contracts','files','revisions','analyses','recommendations','risks','risk_events'])assert.equal(app.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table+' must remain empty');}

test('one-off package: batch dedup, two stages, citations and export without durable document records',async t=>{
  const f=await fixture(t);const {request,a,b}=f;
  assert.equal((await request('/quick-checks')).status,401);
  assert.equal((await request('/quick-checks',{contractor:'modeus'},a.cookie,{'X-Docs-Request':'0'})).status,403);
  const created=await request('/quick-checks',{contractor:'modeus'},a.cookie);assert.equal(created.status,201);const key=created.data.id;
  assert.equal((await request('/quick-checks',{contractor:'custis'},a.cookie)).status,409);
  assert.equal((await request('/quick-checks/'+key,undefined,b.cookie)).status,404);
  assert.equal((await request('/quick-checks',undefined,b.cookie)).data.length,0);
  assert.equal((await f.upload(key,Buffer.from('not pdf'),'fake.pdf')).status,415);
  const marker='PRIVATE_ONCE_MARKER REFRESH_AUTH Предмет: настройка системы. Место: Москва.';
  const bytes=document(marker),first=await f.upload(key,bytes);assert.equal(first.status,201);
  assert.equal((await f.upload(key,bytes,'copy.docx')).data.duplicate,true);
  assert.equal((await f.upload(key,document('Приложение: срок работ 30 дней после аванса.'),'appendix.docx')).status,201);
  assert.deepEqual(await readdir(f.app.quick.root),[],'Original bytes removed immediately after extraction');
  assert.equal((await request('/quick-checks/'+key+'/analyze',{},a.cookie)).status,409);
  await f.connect();assert.equal((await request('/quick-checks/'+key+'/analyze',{},a.cookie)).status,202);
  assert.equal((await request('/quick-checks/'+key+'/analyze',{},a.cookie)).status,409);
  assert.equal((await f.upload(key,document('Late file'))).status,409);
  await f.app.runner.tick();
  const packet=(await request('/quick-checks/'+key,undefined,a.cookie)).data;
  assert.equal(packet.status,'complete');assert.equal(packet.files.length,2);assert.equal(packet.contractor,'modeus');
  assert.notEqual(packet.primary_result.execution.session,packet.review_result.execution.session);
  assert.equal(packet.review_result.passport[0].sources[0].fileId,first.data.file.id);
  assert.equal((await request('/quick-checks/'+key+'/export',undefined,b.cookie)).status,404);
  const exported=await request('/quick-checks/'+key+'/export',undefined,a.cookie);assert.equal(exported.status,200);
  const report=textReport(exported.data,'Модеус');assert.match(report,/Ревью завершено/);assert.ok(report.includes(marker));assert.match(report,/Источник: fixture.docx/);
  assert.deepEqual(await readdir(f.app.quick.root),[],'Runtime Codex sessions removed after both stages');
  assert.equal(JSON.parse(await readFile(join(f.app.runner.home(),'auth.json'),'utf8')).last_refresh,'test-refresh-marker','Refreshed application auth is retained without the temporary session');
  emptyCatalogue(f.app);assert.equal(f.app.db.prepare('SELECT count(*) n FROM audit').get().n,0);
  for(const path of await files(f.dir))assert.equal((await readFile(path)).includes(Buffer.from('PRIVATE_ONCE_MARKER')),false,'No document text in durable data: '+path);
  assert.equal((await request('/quick-checks/'+key+'/discard',{},b.cookie)).status,404);
  assert.equal((await request('/quick-checks/'+key+'/discard',{},a.cookie)).status,200);
  assert.equal((await request('/quick-checks/'+key,undefined,a.cookie)).status,404);assert.equal(f.app.quick.items.size,0);
});

test('review failure retains temporary primary result, retry and TTL destroy all packet state',async t=>{
  const f=await fixture(t);await f.connect();const create=await f.request('/quick-checks',{contractor:'custis'},f.a.cookie),key=create.data.id;
  await f.upload(key,document('FAIL_REVIEW Временный договор на разработку.'));
  await f.request('/quick-checks/'+key+'/analyze',{},f.a.cookie);await f.app.runner.tick();
  const first=(await f.request('/quick-checks/'+key,undefined,f.a.cookie)).data;assert.equal(first.status,'error');assert.ok(first.primary_result);assert.equal(first.review_result,null);
  assert.match(textReport(first,'Кастис'),/РЕВЬЮ НЕ ЗАВЕРШЕНО/);
  assert.equal((await f.request('/quick-checks/'+key+'/analyze',{},f.a.cookie)).status,202);await f.app.runner.tick();
  assert.equal((await f.request('/quick-checks/'+key,undefined,f.a.cookie)).data.primary_result.execution.session,first.primary_result.execution.session);
  f.advance(60*60*1000+1);await f.app.quick.sweep();
  assert.equal(f.app.quick.items.size,0);assert.deepEqual(await readdir(f.app.quick.root),[]);emptyCatalogue(f.app);
});

test('discard and shared disconnect stop active temporary execution without restoring credentials',async t=>{
  const f=await fixture(t);await f.connect();
  async function slow(){const made=await f.request('/quick-checks',{contractor:'custis'},f.a.cookie),key=made.data.id;await f.upload(key,document('SLOW_PRIMARY REFRESH_AUTH Временный тест.'));await f.request('/quick-checks/'+key+'/analyze',{},f.a.cookie);const running=f.app.runner.tick();await until(async()=>(await files(f.app.quick.root)).some(p=>p.endsWith('primary-started')));return{key,running};}
  let run=await slow();assert.equal((await f.request('/quick-checks/'+run.key+'/discard',{},f.a.cookie)).status,200);await run.running;
  assert.equal(f.app.quick.items.size,0);assert.deepEqual(await readdir(f.app.quick.root),[]);assert.equal((await f.app.runner.status()).connected,true);
  run=await slow();assert.equal((await f.request('/codex/logout',{confirm:'disconnect-application'},f.a.cookie)).status,200);await run.running;
  assert.equal((await f.request('/quick-checks/'+run.key,undefined,f.a.cookie)).data.status,'cancelled');
  await assert.rejects(readFile(join(f.app.runner.home(),'auth.json')),{code:'ENOENT'});assert.deepEqual(await readdir(f.app.quick.root),[]);emptyCatalogue(f.app);
});

test('failed extraction, file removal and service restart do not retain temporary data',async t=>{
  const f=await fixture(t);const key=(await f.request('/quick-checks',{contractor:'modeus'},f.a.cookie)).data.id;
  const corrupt=await f.upload(key,Buffer.from('PK\x03\x04not-a-zip'),'broken.docx');assert.equal(corrupt.status,201);assert.equal(corrupt.data.file.status,'error');
  assert.deepEqual(await readdir(f.app.quick.root),[]);
  assert.equal((await f.request(`/quick-checks/${key}/files/${corrupt.data.file.id}/remove`,{},f.a.cookie)).status,200);
  await f.upload(key,document('PRIVATE_RESTART_MARKER Текст для временной проверки.'));
  await f.restart();assert.equal((await f.request('/quick-checks',undefined,f.a.cookie)).data.length,0);
  assert.equal((await f.request('/quick-checks/'+key,undefined,f.a.cookie)).status,404);assert.deepEqual(await readdir(f.app.quick.root),[]);emptyCatalogue(f.app);
});

test('temporary extraction exception and oversized text are cleaned up',async t=>{
  let failure=true;const f=await fixture(t,{extract:async()=>{if(failure)throw new Error('Synthetic extraction failure');return{status:'ready',extraction:{blocks:[{id:'b1',text:'X'.repeat(360001)}],warnings:[]}};}});
  const key=(await f.request('/quick-checks',{contractor:'custis'},f.a.cookie)).data.id;
  assert.equal((await f.upload(key,document('Synthetic input'))).status,500);assert.deepEqual(await readdir(f.app.quick.root),[]);
  failure=false;assert.equal((await f.upload(key,document('Synthetic input'))).status,413);assert.deepEqual(await readdir(f.app.quick.root),[]);
  assert.equal((await f.request('/quick-checks/'+key,undefined,f.a.cookie)).data.files.length,0);emptyCatalogue(f.app);
});

test('discard during extraction waits for cleanup and prevents a late file from being retained',async t=>{
  let release,entered=false;const gate=new Promise(r=>{release=r;});
  const f=await fixture(t,{extract:async()=>{entered=true;await gate;return{status:'ready',extraction:{blocks:[{id:'b1',text:'PRIVATE_LATE_FILE'}],warnings:[]}};}});
  const key=(await f.request('/quick-checks',{contractor:'custis'},f.a.cookie)).data.id;
  const upload=f.upload(key,document('Synthetic input'));await until(()=>entered);
  const discard=f.request('/quick-checks/'+key+'/discard',{},f.a.cookie);await until(()=>f.app.quick.items.get(key)?.deleted);
  release();assert.equal((await upload).status,404);assert.equal((await discard).status,200);
  assert.equal(f.app.quick.items.size,0);assert.deepEqual(await readdir(f.app.quick.root),[]);emptyCatalogue(f.app);
});

test('expiry interrupts active Codex and startup removes only owned orphan runtime directories',async t=>{
  const f=await fixture(t);await f.connect();const key=(await f.request('/quick-checks',{contractor:'custis'},f.a.cookie)).data.id;
  await f.upload(key,document('SLOW_PRIMARY Temporary expiry fixture'));await f.request('/quick-checks/'+key+'/analyze',{},f.a.cookie);
  const running=f.app.runner.tick();await until(async()=>(await files(f.app.quick.root)).some(p=>p.endsWith('primary-started')));
  f.advance(60*60*1000+1);await f.app.quick.sweep();await running;
  assert.equal(f.app.quick.items.size,0);assert.deepEqual(await readdir(f.app.quick.root),[]);
  await mkdir(join(f.app.quick.root,'upload-Ab123Z'));await writeFile(join(f.app.quick.root,'upload-Ab123Z','original'),'PRIVATE_ORPHAN');
  await writeFile(join(f.app.quick.root,'unrelated-test-note'),'preserve');await f.restart();
  assert.deepEqual(await readdir(f.app.quick.root),['unrelated-test-note']);emptyCatalogue(f.app);
});
