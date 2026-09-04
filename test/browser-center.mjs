// Optional browser gate: provide Puppeteer in the QA environment and CHROME_BIN.
// DOCS_UI_SCREENSHOTS selects an existing output directory; all app data is synthetic.
import {createRequire} from 'node:module';
import {mkdtemp,rm,writeFile,mkdir,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createApp} from '../server/main.mjs';
const require=createRequire(import.meta.url),puppeteer=require('puppeteer');
const screenshotDir=process.env.DOCS_UI_SCREENSHOTS||tmpdir();
const root=await mkdtemp(join(tmpdir(),'docs-quick-ui-'));
const app=await createApp({dir:join(root,'data'),runtime:join(root,'runtime'),origin:'http://127.0.0.1:3119',sandbox:false,autoTick:false,codexAdmin:'owner',codex:new URL('./fake-codex.py',import.meta.url).pathname});
await new Promise(resolve=>app.server.listen(3119,'127.0.0.1',resolve));
let browser;
try{
  await mkdir(app.runner.home(),{recursive:true});await writeFile(join(app.runner.home(),'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fake-test-only'}}));
  for(const [name,text] of [['Договор.docx','6.2. Предмет: настройка системы. Место работ: Москва.'],['Приложение.docx','2.1. Срок работ 30 дней после аванса.']]){
    const bytes=execFileSync('python3',['-c',`import io,zipfile,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 table='<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Этап</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Срок</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
 nested='<w:p><w:r><w:t>6.2.1. Работы на площадке заказчика согласуются заранее.</w:t></w:r></w:p>'
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+sys.argv[1]+'</w:t></w:r></w:p>'+nested+table+'</w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())`,text]);await writeFile(join(root,name),bytes);
  }
  browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN,headless:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1440,height:900});
  async function assertNeutralInterface(){
    const copy=await page.evaluate(()=>{
      const clone=document.body.cloneNode(true);
      clone.querySelectorAll('select').forEach(el=>el.remove());
      return clone.textContent;
    });
    assert.doesNotMatch(copy,/Кастис|Модеус|ООО «ЗИС»/i);
  }
  await page.goto('http://127.0.0.1:3119/docs/',{waitUntil:'networkidle0'});
  await assertNeutralInterface();
  assert.equal(await page.$eval('meta[name=description]',el=>el.content),'Внутреннее рабочее место для договоров, редакций и рисков.');
  await page.click('[data-action=auth-mode]');await page.type('[name=login]','owner');await page.type('[name=password]','synthetic-ui-password');await page.click('[data-form=auth] [type=submit]');
  await page.waitForSelector('[data-action=quick-open]');await page.click('[data-action=quick-open]');await page.waitForSelector('#quick-file-picker');
  await assertNeutralInterface();
  assert.match(await page.$eval('#quick-contractor',el=>el.textContent),/Кастис/);
  assert.match(await page.$eval('#quick-contractor',el=>el.textContent),/Модеус/);
  await page.select('#quick-contractor','modeus');
  assert.equal(await page.$eval('#quick-contractor',el=>el.value),'modeus');
  await (await page.$('#quick-file-picker')).uploadFile(join(root,'Договор.docx'),join(root,'Приложение.docx'));
  await page.waitForFunction(()=>document.querySelectorAll('[data-action=quick-file]').length===2&&!document.querySelector('[data-action=quick-run]').disabled);
  await (await page.$('#quick-file-picker')).uploadFile(join(root,'Договор.docx'));
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('дубль'));
  assert.equal(await page.$$eval('[data-action=quick-file]',els=>els.length),2);
  assert.equal([...app.quick.items.values()][0].contractor,'modeus');
  for(const width of [1440,768,375]){
    await page.setViewport({width,height:900});const s=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth,h:innerHeight,sh:document.documentElement.scrollHeight}));
    assert.ok(s.sw<=s.w+1,JSON.stringify(s));if(width===1440)assert.ok(s.sh<=s.h+1,JSON.stringify(s));
    await page.screenshot({path:join(screenshotDir,`center-upload-${width}.png`),fullPage:true});
  }
  await page.setViewport({width:1440,height:900});await page.click('[data-action=quick-run]');await page.waitForFunction(()=>document.body.textContent.includes('В общей очереди'));
  await app.runner.tick();await page.waitForSelector('[data-action=quick-export]');await page.waitForFunction(()=>document.querySelector('[role=status]').textContent==='Ревью завершено');
  await page.click('[data-action=quick-tab][data-value=passport]');await page.waitForSelector('[data-action=quick-source]');await page.click('[data-action=quick-source]');await page.waitForSelector('.source-block.highlight');
  assert.match(await page.$eval('.source-block.highlight',el=>el.textContent),/Москва/);
  await page.click('[data-action=quick-tab][data-value=analysis]');
  await page.waitForSelector('section.panel .analysis-result');
  assert.equal(await page.$$eval('.analysis-result',els=>els.length),1,'The analysis lives in one place, not two');
  await page.click('section.panel [data-action=quick-source]');
  await page.waitForSelector('aside .source-block.highlight');
  assert.ok(await page.$('section.panel .analysis-result'));
  for(const width of [1440,768,375]){
    await page.setViewport({width,height:900});
    const size=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth,h:innerHeight,sh:document.documentElement.scrollHeight}));
    assert.ok(size.sw<=size.w+1,JSON.stringify(size));
    if(width===1440)assert.ok(size.sh<=size.h+1,JSON.stringify(size));
    await page.screenshot({path:join(screenshotDir,`center-quick-${width}.png`),fullPage:true});
  }
  await page.setViewport({width:1440,height:900});
  await page.click('[data-action=quick-tab][data-value=source]');
  await page.waitForSelector('aside .analysis-result');
  assert.ok(await page.$('section.panel .source-block.highlight'),'The clause moves to the main area, the analysis stays beside it');
  await page.click('[data-action=quick-tab][data-value=analysis]');
  await page.waitForSelector('section.panel .analysis-result');
  await page.click('[data-action=quick-export]');
  await page.screenshot({path:join(screenshotDir,'center-quick-1440.png'),fullPage:true});
  await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('[data-action=quick-export]');
  await page.click('[data-action=stored]');assert.equal(app.db.prepare('SELECT count(*) n FROM contracts').get().n,0);
  await page.click('[data-action=quick-open]');await page.waitForSelector('[data-action=quick-discard]');page.once('dialog',d=>d.accept());await page.click('[data-action=quick-discard]');await page.waitForFunction(()=>!document.querySelector('[data-action=quick-discard]'));
  assert.equal(app.quick.items.size,0);assert.deepEqual(await readdir(app.quick.root),[]);assert.deepEqual(errors,[]);
  const encoded=(await readFile(join(root,'Договор.docx'))).toString('base64');
  const stored=await page.evaluate(async encoded=>{
    async function api(path,data){const r=await fetch('/docs/api'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Docs-Request':'1'},body:data===undefined?undefined:JSON.stringify(data)});if(!r.ok)throw Error(await r.text());return r.json();}
    const customer=await api('/customers',{name:'Тестовый заказчик'}),contract=await api('/contracts',{customer_id:customer.id,title:'Договор на внедрение',contractor:'custis'});
    const response=await fetch('/docs/api/contracts/'+contract.id+'/files',{method:'POST',headers:{'X-Docs-Request':'1','X-File-Name':'contract.docx'},body:Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))});const file=await response.json();
    const revision=await api('/contracts/'+contract.id+'/revisions',{file_ids:[file.file.id],note:'Исходная'});await api('/contracts/'+contract.id+'/analyses',{revision_id:revision.id});return contract.id;
  },encoded);
  await app.runner.tick();await page.goto('http://127.0.0.1:3119/docs/#'+stored);await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('.passport-compact');
  assert.equal(await page.$('.passport-strip'),null);assert.equal(await page.$$eval('.passport-row',els=>els.length),9);
  assert.match(await page.$eval('[data-action=source]',el=>el.textContent),/п. 6.2/);
  await assertNeutralInterface();
  await page.click('[data-action=new-contract]');
  await page.waitForSelector('[data-form=contract] [name=contractor]');
  assert.match(await page.$eval('[name=contractor]',el=>el.textContent),/Кастис/);
  assert.match(await page.$eval('[name=contractor]',el=>el.textContent),/Модеус/);
  await assertNeutralInterface();
  await page.click('[data-action=cancel-form]');
  const originalCount=app.db.prepare('SELECT count(*) n FROM analyses').get().n;
  await page.click('[data-action=tab][data-value=analysis]');
  await page.waitForSelector('section.panel [data-form=recommendation]');
  await page.$eval('[data-form=recommendation] textarea',el=>{el.value='Уточнить оплату по п. 6.2';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.select('[data-form=recommendation] select','planned');
  // Черновик рекомендации переживает переключение разделов в одном меню.
  await page.click('[data-action=tab][data-value=passport]');
  await page.waitForSelector('.passport-compact');
  await page.click('[data-action=tab][data-value=analysis]');
  await page.waitForSelector('section.panel .analysis-result');
  const originalKey=await page.$eval('.analysis-result',el=>el.dataset.resultKey);
  assert.equal(await page.$$eval('[data-form=recommendation]',els=>els.length),1);
  assert.equal(await page.$eval('[data-form=recommendation] textarea',el=>el.value),'Уточнить оплату по п. 6.2');
  assert.equal(await page.$eval('[data-form=recommendation] select',el=>el.value),'planned');
  // Ссылка на пункт открывает его в спутнике и не уводит из раздела.
  await page.click('section.panel .finding [data-action=source]');
  await page.waitForSelector('aside .source-block.highlight');
  assert.ok(await page.$('section.panel .analysis-result'),'Section stays put when a clause opens beside it');
  assert.match(await page.$eval('aside .source-block.highlight',el=>el.textContent),/6.2/);
  // Документ показывается со своей структурой: отступы, заголовки, таблицы.
  await page.click('[data-action=tab][data-value=document]');
  await page.waitForSelector('section.panel .contract-text');
  assert.ok(await page.$('section.panel .clause-table'),'A table is shown as a table, not as cells joined by pipes');
  assert.ok(await page.$$eval('section.panel .source-block',els=>els.some(el=>(el.getAttribute('style')||'').match(/--indent:[1-9]/))),'Nested clauses carry their level');
  await page.screenshot({path:join(screenshotDir,'center-structure-1440.png'),fullPage:true});
  // В разделе «Документ» спутник показывает замечания по этому документу.
  await page.click('[data-action=tab][data-value=document]');
  await page.waitForSelector('aside .analysis-result');
  assert.ok(await page.$('section.panel .document'));
  assert.equal(await page.$$eval('[data-action=tab]',els=>els.filter(el=>el.textContent.startsWith('Анализ')).length),1,'A section appears in the menu once');
  await page.click('[data-action=tab][data-value=analysis]');
  await page.waitForSelector('section.panel .analysis-result');
  assert.equal(await page.$eval('[data-form=recommendation] textarea',el=>el.value),'Уточнить оплату по п. 6.2');
  await page.click('[data-form=recommendation] [type=submit]');
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Решение сохранено'));
  assert.equal(app.db.prepare('SELECT text FROM recommendations').get().text,'Уточнить оплату по п. 6.2');
  assert.equal(app.db.prepare('SELECT count(*) n FROM analyses').get().n,originalCount);
  assert.equal(await page.$eval('.analysis-result',el=>el.dataset.resultKey),originalKey);
  await page.click('[data-action=tab][data-value=history]');
  await page.click('[data-action=run]');
  await page.waitForSelector('section.panel .analysis-result');
  assert.equal(await page.$eval('.analysis-result',el=>el.dataset.resultKey),originalKey);
  await page.click('section.panel .finding [data-action=source]');
  await page.waitForSelector('aside .source-block.highlight');
  for(const width of [1440,768,375]){await page.setViewport({width,height:900});const size=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth,h:innerHeight,sh:document.documentElement.scrollHeight}));if(size.sw>size.w+1){console.log(size);await page.screenshot({path:join(screenshotDir,'center-overflow.png'),fullPage:true});}assert.ok(size.sw<=size.w+1,JSON.stringify(size));if(width===1440)assert.ok(size.sh<=size.h+1);await page.screenshot({path:join(screenshotDir,`center-saved-${width}.png`),fullPage:true});}
  await page.setViewport({width:1440,height:900});
  // Комплект: загрузка и редакции — один раздел.
  await page.click('[data-action=tab][data-value=set]');
  await page.waitForSelector('#dropzone');
  assert.ok(await page.$('.version'),'Revisions live in the same section as the upload');
  assert.equal(await page.$$eval('[data-action=tab]',els=>els.length),6,'Six sections, upload and revisions merged');
  await page.screenshot({path:join(screenshotDir,'center-set-1440.png'),fullPage:true});
  await page.click('[data-action=tab][data-value=risks]');await page.waitForFunction(()=>document.body.textContent.includes('Кандидаты из анализа'));
  assert.match(await page.$eval('[data-action=tab][data-value=risks]',el=>el.textContent),/Риски · 1/,'The menu counts candidates waiting for a decision');
  for(const width of [1440,375]){await page.setViewport({width,height:900});await page.screenshot({path:join(screenshotDir,`center-candidates-${width}.png`),fullPage:true});}
  await page.setViewport({width:1440,height:900});
  await page.click('section.panel [data-action=finding-risk]');await page.waitForSelector('[data-form=risk]');
  await page.click('[data-form=risk] [type=submit]');assert.ok(await page.$('[data-form=risk]'),'Risk severity is confirmed explicitly, never copied from the finding');
  await page.select('[data-form=risk] select[name=severity]','high');
  await page.click('[data-form=risk] [type=submit]');await page.waitForSelector('[data-action=risk-source]');
  await page.waitForFunction(()=>!document.querySelector('[data-action=tab][data-value=risks]').textContent.includes('·'));
  assert.match(await page.$eval('[data-action=risk-source]',el=>el.textContent),/v1.*п. 6.2/);
  await page.click('[data-action=risk-source]');await page.waitForSelector('.source-block.highlight');assert.match(await page.$eval('.source-block.highlight',el=>el.textContent),/6.2/);
  assert.doesNotMatch(await page.$eval('.source-block.highlight small',el=>el.textContent),/\bb\d+\b/);
  await page.screenshot({path:join(screenshotDir,'center-risk-1440.png'),fullPage:true});
  // В самом реестре видно основание и пункт, не открывая риск.
  await page.click('[data-action=all-risks]');await page.waitForSelector('.risk-card');
  assert.match(await page.$eval('.risk-card',el=>el.textContent),/Искусственное замечание для проверки привязки к исходнику\./,'The registry shows the whole detail, not a cut prefix');
  assert.match(await page.$eval('.risk-card [data-action=risk-source]',el=>el.textContent),/v1.*п\. 6\.2/,'The registry names the clause the risk came from');
  await page.screenshot({path:join(screenshotDir,'center-registry-1440.png'),fullPage:true});
  await page.click('[data-action=tab][data-value=analysis]');await page.waitForSelector('[data-action=summary-open]');
  await page.click('[data-action=summary-open]');await page.waitForSelector('#summary-text');
  const letter=await page.$eval('#summary-text',el=>el.value);
  assert.match(letter,/Статус: ревью завершено/);assert.match(letter,/п\. 6\.2/);assert.ok(!letter.split('\n').filter(line=>line.startsWith('Пункт:')).some(line=>/\bb\d+\b/.test(line)),'Internal block identifiers never reach a reference');
  for(const width of [1440,768,375]){await page.setViewport({width,height:900});await page.$eval('.summary-panel',el=>el.scrollIntoView({block:'start'}));const s=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth}));assert.ok(s.sw<=s.w+1,'summary '+JSON.stringify(s));await page.screenshot({path:join(screenshotDir,`center-summary-${width}.png`)});}
  await page.setViewport({width:1440,height:900});await page.click('[data-action=summary-close]');
  await page.click('[data-action=rules]');await page.waitForFunction(()=>document.body.textContent.includes('Не считать замечанием'));
  for(const width of [1440,375]){await page.setViewport({width,height:900});const s=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth}));assert.ok(s.sw<=s.w+1,'rules '+JSON.stringify(s));await page.screenshot({path:join(screenshotDir,`center-rules-${width}.png`)});}
  await page.setViewport({width:1440,height:900});await page.click('[data-action=tab][data-value=history]');await page.waitForFunction(()=>document.body.textContent.includes('Аналитик:'));
  await page.screenshot({path:join(screenshotDir,'center-history-1440.png')});
  await page.setViewport({width:1440,height:900});
  assert.deepEqual(errors,[]);
  console.log('PASS center and side layouts: saved/quick, source links, draft preservation, saving decisions, same run, keyboard focus, 1440/768/375.');
  console.log('PASS neutral login, header, catalogue and contract context; both contractor choices preserved.');
  console.log('PASS compact passport, original clause links, saved risk with frozen revision and source.');
  console.log('PASS quick UI: batch, dedup, contractor, two stages, source, export, refresh, delete, empty catalogue, responsive 1440/768/375.');
}finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
