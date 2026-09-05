import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/main.mjs';
import {validInn,publicUrl,lookupResult,organizationFields,Organizations} from '../server/organizations.mjs';
import {rules} from '../server/rules.mjs';

test('INN checksums and public evidence boundaries',()=>{
  for(const inn of ['7707083893','500100732259'])assert.ok(validInn(inn),inn);
  for(const inn of ['0000000000','7707083894','123','500100732258','7707083893; ls'])assert.equal(validInn(inn),false,inn);
  for(const url of ['javascript:alert(1)','http://nalog.ru','https://localhost/','https://127.0.0.1/','https://a.internal/','https://user:pass@nalog.ru'])assert.equal(publicUrl(url),'');
  const answer={...Object.fromEntries(Object.keys(organizationFields).map(k=>[k,''])),name:'Пример',inn:'7707083893',base:'Город без источника',sources:[{field:'name',url:'https://egrul.nalog.ru/',title:'Пример',quote:'7707083893 Пример'}],note:''},events=[{type:'item.completed',item:{type:'web_search'}}];
  assert.throws(()=>lookupResult(answer,answer.inn,[]),/Поиск/);
  assert.throws(()=>lookupResult({...answer,inn:'7707083894'},answer.inn,events),/другой ИНН/);
  assert.throws(()=>lookupResult({...answer,sources:[]},answer.inn,events),/источник/);
  const result=lookupResult(answer,answer.inn,events);assert.equal(result.base,'');assert.equal(result.sources[0].status,'unverified');
  assert.doesNotMatch(rules.find(r=>r.id==='LOC-01').instruction,/Москв|Обе компании/);
});

test('organizations: empty onboarding, ownership, dedup, edits, frozen profiles, legacy rebinding and LLM draft',async t=>{
  const root=await mkdtemp(join(tmpdir(),'docs-organizations-')),origin='http://127.0.0.1:3107';
  const app=await createApp({dir:join(root,'data'),runtime:join(root,'runtime'),origin,sandbox:false,autoTick:false,codex:new URL('./fake-codex.py',import.meta.url).pathname});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}/docs/api`;
  async function api(path,data,cookie='',method='POST') {const res=await fetch(base+path,{method:data===undefined?'GET':method,headers:{Origin:origin,'X-Docs-Request':'1','Content-Type':'application/json',Cookie:cookie},body:data===undefined?undefined:JSON.stringify(data)});return{status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};}
  const a=await api('/register',{login:'org_owner',password:'synthetic-org-password'}),b=await api('/register',{login:'org_other',password:'synthetic-org-password'});
  assert.equal((await api('/organizations')).status,401);
  assert.deepEqual((await api('/bootstrap',undefined,a.cookie)).data.profiles,{});
  assert.equal((await api('/contracts',{title:'Старый ключ',kind:'template',contractor:'custis'},a.cookie)).status,404);
  assert.equal((await api('/organizations',{name:'Ошибочный ИНН',inn:'7707083894'},a.cookie)).status,400);
  const first=await api('/organizations',{name:'Своя организация',base:'Казань',inn:'7707083893',confirmed:'Попытка повысить доверие'},a.cookie);assert.equal(first.status,201);const org=first.data;
  assert.equal(org.confirmed,undefined);
  assert.equal((await api('/organizations',{name:'Дубль',inn:org.inn},a.cookie)).status,409);
  assert.equal((await api('/organizations',{name:'Отдельная карточка',inn:org.inn},b.cookie)).status,201);
  assert.equal((await api('/organizations/'+org.id,undefined,b.cookie)).status,404);
  assert.equal((await api('/organizations/'+org.id,{name:'Чужая правка',version:1},b.cookie,'PATCH')).status,404);
  assert.equal((await api('/quick-checks',{contractor:org.id},b.cookie)).status,404);
  const packet=await api('/quick-checks',{contractor:org.id},a.cookie);assert.equal(packet.status,201);
  const snapshot=new Organizations(app.db).snapshot(a.data.id,org.id);
  const updated=await api('/organizations/'+org.id,{...org,name:'Новое название',base:'Пермь'},a.cookie,'PATCH');assert.equal(updated.status,200);assert.equal(updated.data.version,2);
  assert.equal(snapshot.base,'Казань');assert.equal(app.quick.items.get(packet.data.id).profile.base,'Казань');
  assert.equal((await api('/organizations/'+org.id,{...org,name:'Устаревшая правка'},a.cookie,'PATCH')).status,409);
  app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)').run('legacy',a.data.id,'Существующий договор','modeus','template',new Date().toISOString());
  assert.equal((await api('/contracts/legacy',undefined,a.cookie)).status,200);
  assert.equal((await api('/contracts/legacy',{contractor:org.id},a.cookie,'PATCH')).status,200);
  assert.equal((await api('/contracts/legacy',undefined,a.cookie)).data.contractor,org.id);
  assert.equal((await api('/organizations/lookup',{inn:org.inn},a.cookie)).status,409);
  await mkdir(app.runner.home(),{recursive:true});await writeFile(join(app.runner.home(),'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-test-only'}}));
  const job=await api('/organizations/lookup',{inn:'500100732259',documents:'PRIVATE_DO_NOT_SEND'},a.cookie);assert.equal(job.status,202);
  assert.equal((await api('/organizations/lookup/'+job.data.id,undefined,b.cookie)).status,404);
  let done;for(let i=0;i<100;i++){done=await api('/organizations/lookup/'+job.data.id,undefined,a.cookie);if(done.data.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(done.data.status,'complete',JSON.stringify(done.data));
  assert.equal((await api('/organizations',undefined,a.cookie)).data.length,1,'Search does not save');
  const saved=await api('/organizations',{...done.data.result,lookupId:job.data.id},a.cookie);assert.equal(saved.status,201);assert.ok(saved.data.sources.every(s=>s.status==='unverified'));
  assert.equal((await api('/organizations',{...done.data.result,lookupId:job.data.id},b.cookie)).status,400);
  assert.equal((await api('/organizations',{name:'Подмена',inn:org.inn,lookupId:job.data.id},a.cookie)).status,400);
  assert.deepEqual(await readdir(app.runner.lookupRoot),[],'Temporary lookup runtime removed');
  const cancel=await api('/organizations/lookup',{inn:org.inn},a.cookie);assert.equal(cancel.status,202);
  assert.equal((await api('/organizations/lookup/'+cancel.data.id,{},b.cookie)).status,404);
  assert.equal((await api('/organizations/lookup/'+cancel.data.id,{},a.cookie)).data.status,'cancelled');
  for(let i=0;i<100&&app.runner.busy;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(app.runner.busy,false);assert.deepEqual(await readdir(app.runner.lookupRoot),[]);
});
