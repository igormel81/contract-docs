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
  const inputSession=await page.createCDPSession();
  async function controlsViewport(width){
    await page.setViewport({width,height:900});
    // Toggle touch without Puppeteer's automatic hasTouch reload: a reload would
    // invalidate the draft-preservation and in-place disclosure assertions.
    await inputSession.send('Emulation.setTouchEmulationEnabled',{enabled:width<=768});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }
  async function revealControl(selector){
    const visible=()=>page.$eval(selector,el=>el.checkVisibility());
    if(await visible())return;
    // Exercise disclosure controls as a user, never force hidden elements open.
    const menu=await page.$eval(selector,el=>{let parent=el.closest('details[data-menu]');if(parent?.querySelector(':scope>summary')===el)parent=parent.parentElement?.closest('details[data-menu]');return parent?.dataset.menu;});
    if(menu){await revealControl(`details[data-menu="${menu}"]>summary`);await page.click(`details[data-menu="${menu}"]>summary`);return;}
    if(await page.$('[data-action=nav-toggle]'))await page.click('[data-action=nav-toggle]');
    assert.ok(await visible(),`Control is reachable: ${selector}`);
  }
  async function clickControl(selector){await revealControl(selector);await page.click(selector);}
  async function assertControlsLayout(surface,{contract=false}={}){
    for(const width of [320,375,390,768,1440]){
      await controlsViewport(width);
      const measurement=await page.evaluate(()=>{
        const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        const context=document.querySelector('#main>.context');
        const heading=context?.querySelector('h1'),primary=context?.querySelector('[data-action=analyze],[data-action=quick-run]'),revision=context?.querySelector('#revision-select');
        const overlap=(a,b)=>a&&b&&Math.min(a.right,b.right)>Math.max(a.x,b.x)+1&&Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)+1;
        const mainButtons=[...document.querySelectorAll('#main button,#main select,#main summary,.topbar button,.topbar summary')].filter(el=>el.checkVisibility()&&!el.closest('.contract-text')&&!el.classList.contains('source-link'));
        return {overflow:document.documentElement.scrollWidth>innerWidth+1,topbar:rect(document.querySelector('.topbar')),heading:heading&&rect(heading),overlap:overlap(heading&&rect(heading),primary&&rect(primary))||overlap(heading&&rect(heading),revision&&rect(revision)),
          targets:mainButtons.map(el=>({action:el.dataset.action||el.tagName,label:el.textContent.trim().slice(0,80),...rect(el),font:parseFloat(getComputedStyle(el).fontSize)}))};
      });
      assert.equal(measurement.overflow,false,`${surface} ${width}: page overflow`);
      assert.equal(Boolean(measurement.overlap),false,`${surface} ${width}: header overlap`);
      if(width<=768){
        assert.ok(measurement.topbar.height<=64,`${surface} ${width}: compact header ${measurement.topbar.height}`);
        assert.ok(await page.$eval('#catalog-drawer',el=>!el.checkVisibility()),'Closed catalogue consumes no screen space');
        for(const target of measurement.targets){
          assert.ok(target.height>=43.9&&target.width>=43.9,`${surface} ${width}: small touch target ${JSON.stringify(target)}`);
          assert.ok(target.font>=14,`${surface} ${width}: small control label ${JSON.stringify(target)}`);
        }
      }
      if(contract&&width<=390){
        const tabs=await page.$$eval('nav.tabs [data-action=tab]',els=>els.filter(el=>el.checkVisibility()).map(el=>el.dataset.value));
        assert.deepEqual(tabs,['passport','analysis','document'],'Mobile keeps three principal sections visible');
        for(const value of ['set','risks','history']){
          await clickControl(`[data-action=tab][data-value=${value}]`);
          assert.equal(await page.$eval('details[data-menu=sections]>summary',el=>el.getAttribute('aria-current')),'page','More marks its active section');
          assert.equal(await page.$eval('details[data-menu=sections]',el=>el.open),false,'Choosing a section closes the menu');
        }
        await page.click('[data-action=tab][data-value=passport]');
      }
      await page.screenshot({path:join(screenshotDir,`controls-${surface}-${width}.png`),fullPage:true});
    }
    await controlsViewport(375);
    await page.click('[data-action=nav-toggle]');
    await page.waitForFunction(()=>document.querySelector('#catalog-drawer')?.getAttribute('aria-modal')==='true');
    assert.equal(await page.$eval('#catalog-drawer',el=>el.getAttribute('role')),'dialog');
    assert.ok(await page.$eval('#catalog-drawer',el=>el.contains(document.activeElement)),'Opening drawer moves focus inside');
    // A dialog keeps keyboard focus inside, including at the boundary.
    await page.$eval('#catalog-drawer',el=>[...el.querySelectorAll('button:not(:disabled),input,select,a[href],summary')].filter(x=>x.checkVisibility()).at(-1).focus());
    await page.keyboard.press('Tab');
    assert.ok(await page.$eval('#catalog-drawer',el=>el.contains(document.activeElement)),'Drawer traps forward Tab');
    await page.keyboard.press('Escape');
    assert.ok(await page.$eval('[data-action=nav-toggle]',el=>el===document.activeElement),'Escape restores menu trigger focus');
    for(const menu of ['account','about']){
      const selector=`details[data-menu=${menu}]>summary`;
      await revealControl(selector);await page.focus(selector);await page.keyboard.press('Enter');
      assert.equal(await page.$eval(`details[data-menu=${menu}]`,el=>el.open),true);
      await page.keyboard.press('Escape');
      assert.ok(await page.$eval(selector,el=>el===document.activeElement));
      assert.equal(await page.$eval(`details[data-menu=${menu}]`,el=>el.open),false);
      // About can live inside the catalogue on mobile.
      if(await page.$eval('#catalog-drawer',el=>el.checkVisibility()))await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
    await controlsViewport(1440);
  }
  async function assertNeutralInterface(){
    const copy=await page.evaluate(()=>{
      const clone=document.body.cloneNode(true);
      clone.querySelectorAll('select').forEach(el=>el.remove());
      return clone.textContent;
    });
    assert.doesNotMatch(copy,/Кастис|Модеус|ООО «ЗИС»/i);
  }
  await page.goto('http://127.0.0.1:3119/docs/',{waitUntil:'networkidle0'});
  async function assertRepositoryLink(surface){
    await page.waitForFunction(()=>{const image=document.querySelector('.brand img.mark');return image?.complete&&image.naturalWidth>0;});
    assert.equal(await page.$eval('.brand img.mark',el=>el.alt),'');
    assert.equal(await page.$eval('link[rel=icon]',el=>new URL(el.href).pathname),'/docs/logo.svg');
    for(const width of [1440,768,375]){
      await page.setViewport({width,height:900});
      const selector='a[href="https://github.com/igormel81/contract-docs"]';
      assert.equal(await page.$$eval(selector,els=>els.length),1);
      await revealControl(selector);
      await page.keyboard.press('Tab');
      await page.focus(selector);
      const link=await page.$eval(selector,el=>({target:el.target,rel:el.rel,label:el.getAttribute('aria-label'),height:el.getBoundingClientRect().height,focus:el.matches(':focus-visible'),outline:getComputedStyle(el).outlineStyle}));
      assert.equal(link.target,'_blank');assert.match(link.rel,/noopener/);assert.match(link.rel,/noreferrer/);assert.match(link.label,/новая вкладка/);assert.ok(link.height>=44);assert.ok(link.focus);assert.notEqual(link.outline,'none');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:join(screenshotDir,`repository-${surface}-${width}.png`),fullPage:true});
      await page.keyboard.press('Escape');await page.keyboard.press('Escape');
    }
    await page.setViewport({width:1440,height:900});
  }
  await assertRepositoryLink('login');
  for(const width of [1440,768,375]){
    await page.setViewport({width,height:900});
    assert.equal(await page.$$eval('#promo-title',els=>els.length),1);
    assert.match(await page.$eval('.promo-audience',el=>el.textContent),/подрядчиков, юристов и руководителей проектов/);
    assert.equal(await page.$$eval('.promo-benefits li',els=>els.length),3);
    assert.ok(await page.$eval('.promo-benefits',el=>el.getBoundingClientRect().height>0));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(width===1440)assert.ok(await page.$eval('[data-form=auth]',el=>el.getBoundingClientRect().bottom<=innerHeight));
    if(width===375){
      await page.click('[data-action=auth-focus]');
      assert.ok(await page.$eval('[name=login]',el=>el===document.activeElement&&el.getBoundingClientRect().top>=0&&el.getBoundingClientRect().bottom<=innerHeight));
    }
    await page.focus('[name=login]');
    assert.ok(await page.$eval('[name=login]',el=>el===document.activeElement));
  }
  await page.setViewport({width:1440,height:900});
  await assertNeutralInterface();
  assert.equal(await page.$eval('meta[name=description]',el=>el.content),'Внутреннее рабочее место для договоров, редакций и рисков.');
  await page.click('[data-action=auth-mode]');await page.type('[name=login]','owner');await page.type('[name=password]','synthetic-ui-password');await page.click('[data-form=auth] [type=submit]');
  await page.waitForSelector('[data-action=quick-open]');
  await assertRepositoryLink('workspace');
  await page.click('[data-action=quick-open]');await page.waitForSelector('[data-action=new-organization]');
  assert.equal(await page.$('#quick-file-picker'),null,'No upload before choosing organization');
  await page.click('[data-action=new-organization]');await page.type('[name=name]','Исполнитель А');
  await page.click('.organization-form details summary');await page.type('[name=base]','Казань');await page.click('[data-form=organization] [type=submit]');
  await page.waitForSelector('[data-action=edit-organization]');
  await page.click('[data-action=new-organization]');await page.type('[name=name]','Исполнитель Б');
  await page.type('[name=inn]','7707083893');await page.click('[data-action=organization-lookup]');
  await page.waitForFunction(()=>document.querySelector('.organization-form .info')?.textContent.includes('Найдено.'));
  assert.equal(await page.$eval('[name=name]',el=>el.value),'Исполнитель Б','LLM never overwrites typed name');
  assert.equal(await page.$eval('[name=address]',el=>el.value),'Тестовый адрес');
  for(const width of [1440,768,375]){await page.setViewport({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(screenshotDir,'organizations-'+width+'.png'),fullPage:true});}
  await page.click('[data-form=organization] [type=submit]');await page.waitForSelector('[data-action=edit-organization]');
  const orgs=await page.evaluate(async()=>await (await fetch('/docs/api/organizations')).json());
  const orgA=orgs.find(o=>o.name==='Исполнитель А').id,orgB=orgs.find(o=>o.name==='Исполнитель Б').id;
  await clickControl('[data-action=quick-open]');await page.waitForSelector('#quick-file-picker');
  await page.setViewport({width:375,height:900});
  assert.ok(await page.$eval('[data-action=quick-pick]',el=>el.getBoundingClientRect().bottom<innerHeight),'Mobile upload action fits the first screen');
  assert.equal(await page.$eval('aside.inspector',el=>getComputedStyle(el).display),'none','No empty inspector takes upload space');
  await page.setViewport({width:1440,height:900});
  await assertNeutralInterface();
  assert.match(await page.$eval('#quick-contractor',el=>el.textContent),/Исполнитель А/);
  assert.match(await page.$eval('#quick-contractor',el=>el.textContent),/Исполнитель Б/);
  await page.select('#quick-contractor',orgB);
  assert.equal(await page.$eval('#quick-contractor',el=>el.value),orgB);
  await (await page.$('#quick-file-picker')).uploadFile(join(root,'Договор.docx'),join(root,'Приложение.docx'));
  await page.waitForFunction(()=>document.querySelectorAll('[data-action=quick-file]').length===2&&!document.querySelector('[data-action=quick-run]').disabled);
  await (await page.$('#quick-file-picker')).uploadFile(join(root,'Договор.docx'));
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('дубль'));
  assert.equal(await page.$$eval('[data-action=quick-file]',els=>els.length),2);
  assert.equal([...app.quick.items.values()][0].contractor,orgB);
  await assertControlsLayout('quick-upload');
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
  const narrowWidth=await page.$eval('.inspector',el=>el.getBoundingClientRect().width);
  await page.click('[data-action=quick-source-width]');
  assert.ok(await page.$eval('.inspector',el=>el.getBoundingClientRect().width)>narrowWidth,'Source pane width can be changed');
  await page.setViewport({width:375,height:900});
  await page.waitForFunction(()=>document.querySelector('.inspector').getAttribute('aria-modal')==='true');
  assert.equal(await page.$eval('.inspector',el=>el.getAttribute('aria-modal')),'true');
  await page.focus('[data-action=quick-source-close]');await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.body.classList.contains('source-modal-open'));
  await page.waitForFunction(()=>document.activeElement?.dataset.action==='quick-source');
  await page.click('section.panel [data-action=quick-source]');
  assert.equal(await page.$eval('.inspector',el=>el.getAttribute('role')),'dialog');
  await page.setViewport({width:1440,height:900});
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
  await page.click('[data-action=quick-open]');await page.waitForSelector('[data-action=quick-discard]');
  page.once('dialog',d=>d.dismiss());await clickControl('[data-action=quick-discard]');
  assert.equal(app.quick.items.size,1,'Cancelling deletion preserves the temporary package');
  page.once('dialog',d=>d.accept());await clickControl('[data-action=quick-discard]');await page.waitForFunction(()=>!document.querySelector('[data-action=quick-discard]'));
  assert.equal(app.quick.items.size,0);assert.deepEqual(await readdir(app.quick.root),[]);assert.deepEqual(errors,[]);
  const encoded=(await readFile(join(root,'Договор.docx'))).toString('base64');
  const stored=await page.evaluate(async encoded=>{
    async function api(path,data){const r=await fetch('/docs/api'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Docs-Request':'1'},body:data===undefined?undefined:JSON.stringify(data)});if(!r.ok)throw Error(await r.text());return r.json();}
    const customer=await api('/customers',{name:'Тестовый заказчик'}),contract=await api('/contracts',{customer_id:customer.id,title:'Договор на внедрение',contractor:Object.keys((await api('/bootstrap')).profiles)[0]});
    const response=await fetch('/docs/api/contracts/'+contract.id+'/files',{method:'POST',headers:{'X-Docs-Request':'1','X-File-Name':'contract.docx'},body:Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))});const file=await response.json();
    const revision=await api('/contracts/'+contract.id+'/revisions',{file_ids:[file.file.id],note:'Исходная'});await api('/contracts/'+contract.id+'/analyses',{revision_id:revision.id});return contract.id;
  },encoded);
  await app.runner.tick();await page.goto('http://127.0.0.1:3119/docs/#'+stored);await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('.passport-compact');
  assert.equal(await page.$('.passport-strip'),null);assert.equal(await page.$$eval('.passport-row',els=>els.length),9);
  assert.match(await page.$eval('[data-action=source]',el=>el.textContent),/п. 6.2/);
  await assertNeutralInterface();
  await page.click('[data-action=new-contract]');
  await page.waitForSelector('[data-form=contract] [name=contractor]');
  assert.match(await page.$eval('[name=contractor]',el=>el.textContent),/Исполнитель А/);
  assert.match(await page.$eval('[name=contractor]',el=>el.textContent),/Исполнитель Б/);
  await assertNeutralInterface();
  await page.click('[data-action=cancel-form]');
  await assertControlsLayout('saved-passport',{contract:true});
  const originalCount=app.db.prepare('SELECT count(*) n FROM analyses').get().n;
  await page.click('[data-action=tab][data-value=analysis]');
  await page.waitForSelector('section.panel [data-form=recommendation]');
  assert.equal(await page.$eval('.finding-disclosure',el=>el.open),false,'Findings start as compact rows');
  assert.equal(await page.$('.step-line'),null,'Completed stages no longer take a separate card row');
  await page.click('.finding-disclosure>summary');
  await page.$eval('[data-form=recommendation] textarea',el=>{el.value='Уточнить оплату по п. 6.2';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.select('[data-form=recommendation] select','planned');
  await assertControlsLayout('expanded-analysis');
  await controlsViewport(375);
  await page.click('[data-action=nav-toggle]');await page.keyboard.press('Escape');
  await page.click('details[data-menu=sections]>summary');await page.keyboard.press('Escape');
  assert.equal(await page.$eval('[data-form=recommendation] textarea',el=>el.value),'Уточнить оплату по п. 6.2','Menus preserve the unsaved wording');
  assert.equal(await page.$eval('[data-form=recommendation] select',el=>el.value),'planned','Menus preserve the unsaved decision');
  await controlsViewport(1440);
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
  await page.click('[data-action=finding-filter][data-value=unresolved]');
  assert.equal(await page.$$eval('section.panel .finding',els=>els.length),0,'Saved planned decisions leave the unresolved filter');
  assert.equal(await page.$eval('[data-action=finding-filter][data-value=unresolved]',el=>el.getAttribute('aria-pressed')),'true');
  await page.click('[data-action=finding-filter][data-value=all]');
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
  assert.equal(await page.$eval('[data-action=tab][data-value=risks]',el=>el.textContent.trim()),'Риски','Candidate count does not stretch the section menu');
  assert.match(await page.$eval('section.panel .content',el=>el.textContent),/Кандидаты из анализа v1 · 1/,'Candidates are counted inside Risks, separately from the registry');
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
  // A change beyond the old 400-character cutoff remains visible and highlighted.
  const comparisonFiles=[10,30].map(days=>execFileSync('python3',['-c',`import io,zipfile,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+sys.argv[1]+'</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())`,'6.2. '+('Работы выполняются после согласования. '.repeat(18))+'Оплата в течение '+days+' дней.']).toString('base64'));
  await page.evaluate(async({stored,comparisonFiles})=>{
    let parent='';
    for(const encoded of comparisonFiles){
      const response=await fetch('/docs/api/contracts/'+stored+'/files',{method:'POST',headers:{'X-Docs-Request':'1','X-File-Name':'contract.docx'},body:Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))});if(!response.ok)throw Error(await response.text());const file=await response.json();
      const revision=await fetch('/docs/api/contracts/'+stored+'/revisions',{method:'POST',headers:{'Content-Type':'application/json','X-Docs-Request':'1'},body:JSON.stringify({file_ids:[file.file.id],parent_id:parent,note:'Сравнение длинного пункта'})});if(!revision.ok)throw Error(await revision.text());parent=(await revision.json()).id;
    }
  },{stored,comparisonFiles});
  await page.goto('http://127.0.0.1:3119/docs/#'+stored,{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});
  await page.click('[data-action=tab][data-value=set]');await page.click('[data-action=compare]');
  await page.waitForSelector('.clause-comparison .comparison');
  const texts=await page.$$eval('.clause-comparison .diff-text',els=>els.map(el=>el.textContent));
  assert.ok(texts.some(text=>text.endsWith('Оплата в течение 10 дней.')));assert.ok(texts.some(text=>text.endsWith('Оплата в течение 30 дней.')));
  assert.match(await page.$eval('.clause-comparison del',el=>el.textContent),/10/);assert.match(await page.$eval('.clause-comparison ins',el=>el.textContent),/30/);
  await page.screenshot({path:join(screenshotDir,'center-full-comparison-1440.png'),fullPage:true});
  await page.click('[data-action=tab][data-value=set]');
  const revisionsBefore=app.db.prepare('SELECT count(*) n FROM revisions').get().n,analysesBefore=app.db.prepare('SELECT count(*) n FROM analyses').get().n;
  await page.click('input[data-file-choice]:not(:checked)');
  await page.type('[data-form=revision] [name=note]','Создать и проверить одним действием');
  await page.click('[data-form=revision] button[value=analyze]');
  await page.waitForFunction(()=>document.querySelector('[data-action=tab][data-value=analysis]').getAttribute('aria-current')==='page'&&document.body.textContent.includes('В очереди'));
  assert.equal(app.db.prepare('SELECT count(*) n FROM revisions').get().n,revisionsBefore+1);assert.equal(app.db.prepare('SELECT count(*) n FROM analyses').get().n,analysesBefore+1);
  await page.click('details[data-menu=account]>summary');
  await page.focus('details[data-menu=account]>summary');
  await page.waitForResponse(response=>response.url().endsWith('/api/contracts/'+stored),{timeout:10000});
  await page.waitForNetworkIdle({idleTime:100,timeout:2000});
  assert.ok(await page.$eval('details[data-menu=account]>summary',el=>el===document.activeElement),'Polling keeps keyboard focus on the same control');
  assert.equal(await page.$eval('details[data-menu=account]',el=>el.open),true,'Polling preserves an open account menu and keyboard focus');
  await page.keyboard.press('Escape');
  await assertControlsLayout('queued-analysis');
  const longTitle='Договор на внедрение и сопровождение информационной системы распределённых подразделений заказчика с дополнительными требованиями к приёмке и передаче результатов — '+ 'А'.repeat(35);
  const longOrg='Исполнитель с длинным названием для проверки переноса и доступности карточки организации — '+ 'Б'.repeat(90);
  const longContract=await page.evaluate(async({encoded,longTitle,longOrg})=>{
    async function post(path,data){const response=await fetch('/docs/api'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Docs-Request':'1'},body:JSON.stringify(data)});if(!response.ok)throw Error(await response.text());return response.json();}
    const organization=await post('/organizations',{name:longOrg});
    const customer=await post('/customers',{name:'Заказчик с длинным названием и региональными подразделениями для проверки адаптивности интерфейса'});
    const contract=await post('/contracts',{title:longTitle,contractor:organization.id,customer_id:customer.id});
    const response=await fetch('/docs/api/contracts/'+contract.id+'/files',{method:'POST',headers:{'X-Docs-Request':'1','X-File-Name':'long-contract.docx'},body:Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))});
    if(!response.ok)throw Error(await response.text());const file=await response.json();
    await post('/contracts/'+contract.id+'/revisions',{file_ids:[file.file.id],note:'Проверка длинного заголовка'});return contract.id;
  },{encoded,longTitle,longOrg});
  await page.goto('http://127.0.0.1:3119/docs/#'+longContract,{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});
  await page.waitForSelector('#revision-select');
  assert.equal(await page.$eval('#main>.context h1',el=>el.textContent),longTitle);
  assert.ok((await page.$eval('.contract-organization',el=>el.textContent)).includes(longOrg));
  await assertControlsLayout('long-names',{contract:true});
  // Reflow equivalent to a 1440px desktop at 200% browser zoom: 720 CSS px.
  // This is not a pinch-zoom test or a claim about physical device rendering.
  await page.setViewport({width:720,height:450,deviceScaleFactor:2,isMobile:false,hasTouch:false});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'200% equivalent reflow has no horizontal page overflow');
  assert.ok(await page.$eval('#main>.context h1',el=>el.scrollWidth<=el.clientWidth+1),'Long title wraps without clipping at 200% equivalent reflow');
  await page.screenshot({path:join(screenshotDir,'controls-reflow-200.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS controls: 320/375/390/768/1440; touch targets; long names; 200% equivalent reflow; drawers, menus, focus, mobile tabs, cancellation and drafts.');
  console.log('PASS center and side layouts: saved/quick, source links, draft preservation, saving decisions, same run, keyboard focus, 1440/768/375.');
  console.log('PASS neutral login, header, catalogue and contract context; both contractor choices preserved.');
  console.log('PASS compact passport, original clause links, saved risk with frozen revision and source.');
  console.log('PASS quick UI: batch, dedup, contractor, two stages, source, export, refresh, delete, empty catalogue, responsive 1440/768/375.');
}catch(error){
  const page=(await browser?.pages())?.at(-1);
  if(page){await page.screenshot({path:join(screenshotDir,'controls-failure.png'),fullPage:true});console.error((await page.$eval('body',el=>el.innerText)).slice(0,5000));}
  throw error;
}finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
