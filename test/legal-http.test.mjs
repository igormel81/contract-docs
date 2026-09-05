import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createApp} from '../server/main.mjs';

test('legal catalogue requires login and both workflows freeze its version in the analysis snapshot',async()=>{
  const root=await mkdtemp(join(tmpdir(),'docs-legal-http-'));
  const origin='http://127.0.0.1:3197';
  const app=await createApp({dir:join(root,'data'),runtime:join(root,'runtime'),origin,sandbox:false,autoTick:false,codexAdmin:'legal_test'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}/docs/api`;
  let cookie='';
  async function api(path,data){
    const res=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,'X-Docs-Request':'1','Content-Type':'application/json',Cookie:cookie},body:data===undefined?undefined:JSON.stringify(data)});
    if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];
    const value=await res.json();assert.ok(res.ok,JSON.stringify(value));return value;
  }
  try{
    assert.equal((await fetch(base+'/legal-base')).status,401);
    await api('/register',{login:'legal_test',password:'synthetic-legal-http-password'});
    const catalog=await api('/legal-base'),boot=await api('/bootstrap');
    assert.ok(catalog.norms.length>0);assert.equal(boot.legal.version,catalog.version);
    assert.ok(catalog.norms.every(norm=>norm.id&&norm.text&&norm.sourceUrl));
    await mkdir(app.runner.home(),{recursive:true});
    await writeFile(join(app.runner.home(),'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-test-only'}}));
    const customer=await api('/customers',{name:'Синтетический заказчик'});
    const contract=await api('/contracts',{customer_id:customer.id,title:'Правовая проверка теста',contractor:'modeus'});
    const bytes=execFileSync('python3',['-c',`import io,zipfile,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>1.1. Исполнитель выполняет настройку системы за 30 дней.</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())`]);
    async function upload(path){const res=await fetch(base+path,{method:'POST',headers:{Origin:origin,'X-Docs-Request':'1','X-File-Name':'test.docx',Cookie:cookie},body:bytes});const value=await res.json();assert.ok(res.ok,JSON.stringify(value));return value;}
    const file=await upload('/contracts/'+contract.id+'/files');
    const revision=await api('/contracts/'+contract.id+'/revisions',{file_ids:[file.file.id]});
    const analysis=await api('/contracts/'+contract.id+'/analyses',{revision_id:revision.id});
    const snapshot=JSON.parse(app.db.prepare('SELECT snapshot FROM analyses WHERE id=?').get(analysis.id).snapshot);
    assert.equal(snapshot.legal.version,catalog.version);
    assert.equal(snapshot.legal.norms[0].text,catalog.norms[0].text);
    const saved=await api('/contracts/'+contract.id);
    assert.equal(saved.analyses[0].legal.version,catalog.version);
    const packet=await api('/quick-checks',{contractor:'modeus'});
    await upload('/quick-checks/'+packet.id+'/files');
    await api('/quick-checks/'+packet.id+'/analyze',{});
    assert.equal(app.quick.items.get(packet.id).snapshot.legal.version,catalog.version);
    const temporary=app.quick.items.get(packet.id),frozen=temporary.snapshot;
    temporary.status='error';
    await api('/quick-checks/'+packet.id+'/analyze',{});
    assert.equal(temporary.snapshot,frozen,'Retry keeps the corpus and rules used by the first stage');
    assert.equal(app.db.prepare('SELECT count(*) n FROM contracts').get().n,1);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
