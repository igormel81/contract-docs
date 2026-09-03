import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/main.mjs';
import { rules } from '../server/rules.mjs';

const fake = fileURLToPath(new URL('./fake-codex.py',import.meta.url));
const auth = JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-test-only'}});
async function until(check) {
  for(let n=0;n<100;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.fail('Timed out waiting for test process');
}
async function fixture(t, codexAdmin='owner') {
  const dir=await mkdtemp(join(tmpdir(),'docs-shared-auth-'));
  const options={dir,origin:'http://127.0.0.1:3107',sandbox:false,autoTick:false,codexAdmin,codex:fake};
  let app,base;
  async function start(){app=await createApp(options);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}/docs/api`;}
  await start();
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});});
  async function request(path,data,session='') {
    const res=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:options.origin,'X-Docs-Request':'1','Content-Type':'application/json',Cookie:session},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  const owner=await request('/register',{login:'owner',password:'test-password-owner'});
  const member=await request('/register',{login:'member',password:'test-password-member'});
  assert.equal(owner.status,200);assert.equal(member.status,200);
  return {get app(){return app;},dir,request,owner,member,restart:async()=>{await new Promise(resolve=>app.server.close(resolve));await start();}};
}

test('one application login, owner-only device code, persistence and independent user logout',async t=>{
  const f=await fixture(t);const {request,owner,member}=f;
  assert.equal((await request('/codex')).status,401);
  assert.equal((await request('/codex/login',{})).status,401);
  assert.equal((await request('/codex/login',{},member.cookie)).status,403);
  const starts=await Promise.all([request('/codex/login',{},owner.cookie),request('/codex/login',{},owner.cookie)]);
  assert.ok(starts.some(r=>r.status===200));assert.ok(starts.every(r=>[200,409].includes(r.status)));
  await until(async()=>(await f.app.runner.status(true)).login?.code==='TEST-ONLY');
  assert.equal((await readFile(join(f.app.runner.home(),'login-starts.log'),'utf8')).trim(),'login');
  const personal=await request('/codex',undefined,member.cookie);
  assert.equal(personal.data.scope,'application');assert.equal(personal.data.state,'connecting');assert.equal(personal.data.login,null);
  assert.equal(JSON.stringify((await request('/bootstrap',undefined,member.cookie)).data).includes('TEST-ONLY'),false);
  assert.equal((await request('/codex/logout',{},owner.cookie)).status,400,'Global logout requires confirmation');
  await writeFile(join(f.app.runner.home(),'auth.json'),auth,{mode:0o600});
  await until(()=>f.app.runner.loginState?.state==='complete');
  assert.equal((await stat(f.app.runner.home())).mode&0o777,0o700);
  assert.equal((await request('/codex',undefined,member.cookie)).data.connected,true);
  assert.equal((await request('/codex',undefined,owner.cookie)).data.login,null);
  assert.equal((await request('/logout',{},owner.cookie)).status,200);
  assert.equal((await request('/codex',undefined,member.cookie)).data.connected,true,'Web logout must not affect the service credential');
  await f.restart();
  assert.equal((await request('/codex',undefined,member.cookie)).data.connected,true,'Shared connection survives restart');
  const ownerAgain=await request('/login',{login:'owner',password:'test-password-owner'});
  assert.equal((await request('/codex/logout',{confirm:'disconnect-application'},member.cookie)).status,403);
  assert.equal((await request('/codex/logout',{confirm:'disconnect-application'},ownerAgain.cookie)).status,200);
  assert.equal((await request('/codex',undefined,member.cookie)).data.connected,false);
  await assert.rejects(readFile(join(f.app.runner.home(),'auth.json')),{code:'ENOENT'});
  assert.equal((await request('/codex/login',{},ownerAgain.cookie)).status,200);
  await until(async()=>(await f.app.runner.status(true)).login?.code==='TEST-ONLY');
  assert.equal((await request('/codex/logout',{confirm:'disconnect-application'},ownerAgain.cookie)).status,200);
  assert.equal((await request('/codex',undefined,ownerAgain.cookie)).data.login,null,'Cancelled device flow cannot revive the connection');
});

test('shared disconnect cancels active and queued work for every user, preserving finished results',async t=>{
  const f=await fixture(t);const app=f.app;
  await mkdir(app.runner.home(),{recursive:true,mode:0o700});await writeFile(join(app.runner.home(),'auth.json'),auth);
  const stamp=new Date().toISOString();
  const snapshot={documents:[{id:'fixture',blocks:[{id:'b1',text:'SLOW_PRIMARY Только искусственные тестовые данные.'}]}],rules};
  for(const [index,user] of [f.owner,f.member].entries()){
    app.db.prepare('INSERT INTO contracts(id,user_id,title,contractor,kind,created) VALUES(?,?,?,?,?,?)').run('c'+index,user.data.id,'Тест','custis','template',stamp);
    app.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)').run('r'+index,'c'+index,1,null,'[]','Тест',stamp);
    app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,created,updated) VALUES(?,?,?,?,?,?,?,?)').run('a'+index,user.data.id,'c'+index,'r'+index,'queued',JSON.stringify(snapshot),stamp,stamp);
  }
  app.db.prepare('INSERT INTO analyses(id,user_id,contract_id,revision_id,status,snapshot,review_result,created,updated) VALUES(?,?,?,?,?,?,?,?,?)').run('finished',f.owner.data.id,'c0','r0','complete','{}','{"summary":"Сохранено"}',stamp,stamp);
  const running=app.runner.tick();
  await until(async()=>{try{await stat(join(app.runner.home(),'primary-started'));return true;}catch{return false;}});
  assert.equal((await f.request('/codex/logout',{confirm:'disconnect-application'},f.owner.cookie)).status,200);
  await running;
  assert.equal(app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a0').status,'cancelled');
  assert.equal(app.db.prepare('SELECT status FROM analyses WHERE id=?').get('a1').status,'cancelled');
  assert.equal(app.db.prepare('SELECT primary_result FROM analyses WHERE id=?').get('a0').primary_result,null);
  assert.equal(app.db.prepare('SELECT review_result FROM analyses WHERE id=?').get('finished').review_result,'{"summary":"Сохранено"}');
  await writeFile(join(app.runner.home(),'auth.json'),auth);await app.runner.tick();
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM analyses WHERE status=?').get('cancelled').n,2,'Reconnect does not resume cancelled jobs');
});

test('no configured owner never grants shared-credential management to a registering user',async t=>{
  const f=await fixture(t,'');
  assert.equal((await f.request('/codex',undefined,f.owner.cookie)).data.canManage,false);
  assert.equal((await f.request('/codex/login',{},f.owner.cookie)).status,403);
});
