import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/main.mjs';
import { format, similarity } from '../server/documents.mjs';
import { validateResult } from '../server/schema.mjs';
import { rules } from '../server/rules.mjs';
import { findingKey } from '../public/document-ui.js';
import { fileURLToPath } from 'node:url';

export function docx(text='Договор. Предмет: внедрение системы. Срок: 30 дней после аванса.') {
  return execFileSync('python3',['-c',`import io,zipfile,sys,html
b=io.BytesIO()
with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types/>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+html.escape(sys.argv[1])+'</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())`,text]);
}
test('formats and similarity never use name as content identity',()=>{
  assert.equal(format('Contract.DOCX',docx()),'docx');
  assert.throws(()=>format('fake.pdf',Buffer.from('not a pdf')));
  assert.throws(()=>format('macro.docm',docx()));
  assert.equal(similarity('Москва срок оплата','Москва срок оплата'),1);
});
test('grounded schema rejects fabricated citations',()=>{
  const snapshot={documents:[{id:'file',blocks:[{id:'b1',text:'Предмет: внедрение системы.'}]}],rules};
  const r={summary:'Внедрение системы',passport:['subject','result','term','price','payment','location','acceptance','dependencies','special'].map(key=>({key,title:key,value:'Не найдено',status:'missing',sources:[]})),findings:[],coverage:rules.filter(x=>x.coverage!==false).map(r=>({rule:r.id,status:'needs_data',note:'Проверить'})),limitations:['Нет нормативной базы'],changes:[]};
  assert.equal(validateResult(r,snapshot,'primary'),r);
  r.passport[0]={key:'subject',title:'Предмет',value:'Внедрение',status:'extracted',sources:[{fileId:'file',blockId:'b1',quote:'Предмет: внедрение системы.'}]};
  validateResult(r,snapshot,'primary');r.passport[0].sources[0].quote='Предмет: продажа лицензии.';
  assert.throws(()=>validateResult(r,snapshot,'primary'),/Цитата/);
});
test('account isolation, uploads, immutable revisions, risks, CSRF and session revocation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'contract-docs-test-'));
  const origin='http://127.0.0.1:3107';const app=await createApp({dir,origin,sandbox:false,autoTick:false,codexAdmin:'tester_a',codex:fileURLToPath(new URL('./fake-codex.py',import.meta.url))});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}/docs/api`;
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});});
  async function request(path,data,session='',method='POST',headers={}) {
    const response=await fetch(base+path,{method:data===undefined?'GET':method,headers:{Origin:origin,'X-Docs-Request':'1','Content-Type':'application/json',Cookie:session,...headers},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const a=await request('/register',{login:'tester_a',password:'valid-passphrase-1'});assert.equal(a.status,200);assert.match(a.cookie,/docs_session=/);
  const b=await request('/register',{login:'tester_b',password:'valid-passphrase-2'});assert.equal(b.status,200);
  assert.equal((await request('/login',{login:'tester_a',password:'wrong'})).status,401);
  assert.equal((await request('/customers',{name:'Fail'},a.cookie,'POST',{'X-Docs-Request':'0'})).status,403);
  const customer=await request('/customers',{name:'Заказчик А',inn:'7707462073'},a.cookie);assert.equal(customer.status,201);
  const contract=await request('/contracts',{customer_id:customer.data.id,title:'Тестовый договор',contractor:'modeus'},a.cookie);assert.equal(contract.status,201);const c=contract.data.id;
  assert.equal((await request('/contracts/'+c,undefined,b.cookie)).status,404);
  assert.equal((await request('/contracts/'+c,{stage:'Подписан'},a.cookie,'PATCH')).status,400);
  assert.equal((await request('/contracts/'+c,undefined,a.cookie)).data.stage,'Подготовка');
  async function upload(bytes,name='contract.DOCX',session=a.cookie){const response=await fetch(base+'/contracts/'+c+'/files',{method:'POST',headers:{Origin:origin,'X-Docs-Request':'1','X-File-Name':encodeURIComponent(name),Cookie:session},body:bytes});return {status:response.status,data:await response.json()};}
  assert.equal((await upload(Buffer.from('fake'),'bad.pdf')).status,415);
  const initialDoc=docx('6.2. Место выполнения работ: Москва.');const first=await upload(initialDoc);assert.equal(first.status,201);assert.equal(first.data.file.status,'ready');const file=first.data.file.id;
  const duplicate=await upload(initialDoc,'другое имя.docx');assert.equal(duplicate.data.duplicate,true);assert.equal(duplicate.data.file.id,file);
  const otherDoc=docx('Другое содержание: сопровождение.');const concurrent=await Promise.all([upload(otherDoc,'one.docx'),upload(otherDoc,'two.docx')]);assert.equal(concurrent.filter(x=>x.data.duplicate).length,1);
  const rev=await request('/contracts/'+c+'/revisions',{file_ids:[file],note:'Исходная'},a.cookie);assert.equal(rev.status,201);
  assert.equal((await request('/contracts/'+c+'/revisions',{file_ids:[file]},a.cookie)).status,409);
  assert.equal((await request('/contracts/'+c+'/analyses',{revision_id:rev.data.id},a.cookie)).status,409);
  const legacy=join(dir,'codex',a.data.id);await mkdir(legacy,{recursive:true});await writeFile(join(legacy,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-legacy-only'}}));
  assert.equal((await request('/codex',undefined,a.cookie)).data.connected,false,'Legacy personal login must not become shared');
  const authdir=app.runner.home();await mkdir(authdir,{recursive:true});await writeFile(join(authdir,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-test-only'}}));
  assert.equal((await request('/codex',undefined,a.cookie)).data.canManage,true);
  assert.equal((await request('/codex',undefined,b.cookie)).data.connected,true);
  assert.equal((await request('/codex',undefined,b.cookie)).data.canManage,false);
  assert.equal((await request('/codex/login',{},b.cookie)).status,403);
  assert.equal((await request('/codex/logout',{confirm:'disconnect-application'},b.cookie)).status,403);
  const job=await request('/contracts/'+c+'/analyses',{revision_id:rev.data.id},a.cookie);assert.equal(job.status,202);
  await app.runner.tick();let checked=await request('/contracts/'+c,undefined,a.cookie);const run=checked.data.analyses[0];
  assert.equal(run.status,'complete');assert.ok(run.primary_result&&run.review_result);assert.notEqual(run.primary_result.execution.session,run.review_result.execution.session);
  const linkedRisk=await request('/contracts/'+c+'/risks',{title:'Риск с источником',severity:'medium',owner:'Игорь',detail:'Проверка неизменяемой ссылки.',origin:run.id+':test-finding'},a.cookie);assert.equal(linkedRisk.status,201);
  let linked=(await request('/contracts/'+c,undefined,a.cookie)).data.risks.find(r=>r.id===linkedRisk.data.id);
  assert.equal(linked.sources[0].revisionId,rev.data.id);assert.equal(linked.sources[0].fileId,file);assert.ok(linked.sources[0].block.text);
  assert.equal(linked.sources[0].location,'п. 6.2');
  const frozen=JSON.stringify(linked.sources);
  assert.equal((await request('/files/'+file+'/structure',{},b.cookie)).status,404);
  assert.equal((await request('/files/'+file+'/structure',{},a.cookie)).status,200);
  assert.equal(JSON.stringify((await request('/contracts/'+c,undefined,a.cookie)).data.risks.find(r=>r.id===linkedRisk.data.id).sources),frozen);
  assert.equal((await request('/analyses/'+run.id+'/documents',undefined,b.cookie)).status,404);
  assert.equal((await request('/analyses/'+run.id+'/documents',undefined,a.cookie)).data[0].id,file);
  const manualRisk=await request('/contracts/'+c+'/risks',{title:'Ручная ссылка',severity:'medium',owner:'Игорь',detail:'Пункт выбран вручную.',source:{fileId:file,blockId:linked.sources[0].blockId,revisionId:rev.data.id}},a.cookie);assert.equal(manualRisk.status,201);
  assert.equal((await request('/contracts/'+c+'/risks',{title:'Подмена',severity:'medium',owner:'Игорь',detail:'Проверка',source:{fileId:file,blockId:'invented',revisionId:rev.data.id}},a.cookie)).status,400);
  assert.ok(linked.finding_key,'A risk created from a finding remembers the stable candidate key');
  const candidate=findingKey(run.review_result.findings[0]);
  assert.equal(linked.finding_key,candidate,'Server and interface derive the same key from the stored finding');
  assert.equal((await request('/contracts/'+c+'/dismissed',{key:candidate,rule:'LOC-01',title:'Тестовый риск места работ'},a.cookie)).status,400,'Dismissal requires a reason');
  assert.equal((await request('/contracts/'+c+'/dismissed',{key:candidate,rule:'LOC-01',title:'Тестовый риск места работ',reason:'Условие согласовано отдельно.'},b.cookie)).status,404,'Candidates follow contract access');
  assert.equal((await request('/contracts/'+c+'/dismissed',{key:candidate,rule:'LOC-01',title:'Тестовый риск места работ',reason:'Условие согласовано отдельно.'},a.cookie)).status,201);
  assert.equal((await request('/contracts/'+c,undefined,a.cookie)).data.dismissed[0].key,candidate);
  assert.equal((await request('/contracts/'+c+'/dismissed',{key:candidate,restore:true},a.cookie)).status,200);
  assert.equal((await request('/contracts/'+c,undefined,a.cookie)).data.dismissed.length,0,'Dismissal is reversible');
  async function summary(analysisId,session,query=''){const response=await fetch(`${base}/analyses/${analysisId}/summary${query}`,{headers:{Origin:origin,Cookie:session}});return {status:response.status,text:await response.text()};}
  assert.equal((await summary(run.id,b.cookie)).status,404,'A summary follows contract access');
  assert.equal((await request('/contracts/'+c,{manager:'Мария, менеджер'},a.cookie,'PATCH')).status,200);
  const letter=await summary(run.id,a.cookie);
  assert.equal(letter.status,200);
  assert.match(letter.text,/^Для: Мария, менеджер/);
  assert.match(letter.text,/Статус: ревью завершено/);
  assert.match(letter.text,/Замечаний: 1 · высокой критичности 0, средней 1, низкой 0\./);
  assert.match(letter.text,/п\. 6\.2/,'References use the original clause number');
  assert.ok(!/blockId|b1/.test(letter.text),'Internal identifiers never reach a message');
  assert.match(letter.text,/Правовая экспертиза не выполнялась/);
  assert.match((await summary(run.id,a.cookie,'?scope=full')).text,/Тестовый риск места работ/,'The full list keeps findings below high severity');
  assert.ok((await request('/contracts/'+c,undefined,a.cookie)).data.history.some(e=>e.action==='Сформирован текст замечаний для отправки'),'Export of contract text is journalled');
  const contractB=await request('/contracts',{title:'Шаблон второго пользователя',contractor:'custis',kind:'template'},b.cookie);assert.equal(contractB.status,201);
  const wrongContract=await request('/contracts',{title:'Другой договор',contractor:'custis',customer_id:customer.data.id},a.cookie);
  assert.equal((await request('/contracts/'+wrongContract.data.id+'/risks',{title:'Чужой пункт',severity:'medium',owner:'Игорь',detail:'Проверка',origin:run.id+':test-finding'},a.cookie)).status,400);
  const uploadB=await fetch(base+'/contracts/'+contractB.data.id+'/files',{method:'POST',headers:{Origin:origin,'X-Docs-Request':'1','X-File-Name':'second.docx',Cookie:b.cookie},body:docx('Второй пользователь: сопровождение системы.')});assert.equal(uploadB.status,201);
  const fileB=await uploadB.json();const revB=await request('/contracts/'+contractB.data.id+'/revisions',{file_ids:[fileB.file.id]},b.cookie);
  assert.equal((await request('/contracts/'+contractB.data.id+'/analyses',{revision_id:revB.data.id},b.cookie)).status,202);
  await app.runner.tick();
  assert.equal((await request('/contracts/'+contractB.data.id,undefined,b.cookie)).data.analyses[0].status,'complete','Second user runs both stages with application credentials');
  assert.equal((await request('/contracts/'+contractB.data.id,undefined,a.cookie)).status,404);
  assert.equal((await request('/analyses/'+run.id+'/export',undefined,b.cookie)).status,404);
  const failedFile=await upload(docx('FAIL_REVIEW Договор на тестовые услуги.'),'failure.docx');
  const failedRevision=await request('/contracts/'+c+'/revisions',{file_ids:[failedFile.data.file.id],parent_id:rev.data.id},a.cookie);
  await request('/contracts/'+c+'/analyses',{revision_id:failedRevision.data.id},a.cookie);await app.runner.tick();checked=await request('/contracts/'+c,undefined,a.cookie);
  assert.equal(checked.data.analyses[0].status,'error');assert.ok(checked.data.analyses[0].primary_result);assert.equal(checked.data.analyses[0].review_result,null);
  const risk=await request('/contracts/'+c+'/risks',{title:'Риск выездов',severity:'high',owner:'Игорь',detail:'Не ограничены площадки.'},a.cookie);assert.equal(risk.status,201);
  assert.equal((await request('/risks/'+risk.data.id+'/events',{kind:'incident',text:'Сигнал о выезде',due:'2026-09-03'},a.cookie)).status,201);
  assert.equal((await request('/risks/'+risk.data.id,{status:'Закрыт',reason:'Проверены доказательства'},b.cookie,'PATCH')).status,404);
  const updated=await request('/contracts/'+c,undefined,a.cookie);assert.equal(updated.data.risks[0].status,'Открыт');assert.equal(updated.data.risks[0].events[0].state,'unverified');
  assert.equal((await request('/me',{current:'valid-passphrase-1',password:'valid-passphrase-new'},a.cookie,'PATCH')).status,200);
  assert.equal((await request('/me',undefined,a.cookie)).status,401);
  assert.equal((await request('/codex',undefined,b.cookie)).data.connected,true,'Password change does not disconnect the application');
});
