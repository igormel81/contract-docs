import { OrganizationUI } from './organizations.js';
import { QuickUI } from './quick.js';
import { sourceLabel, documentText, compactPassport, locationLabel, findingKey, severityLabels, coverageLabels, stageLabels, clauseDiff, legalReferences, legalStatusLabels, legalSnapshotLabel, wordDiff } from './document-ui.js';
import { messageParts } from './summary.js';
const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { user:null, boot:null, contract:null, contractId:null, revisionId:null, runId:null, center:'set', kind:'contract', customer:'', queues:new Map(), selections:new Map(), source:null, risk:null, form:null, loginMode:'login', query:'', drafts:new Map(), summary:null, findingFilter:'all', openFindings:new Set(), inspectorOpen:false, inspectorWide:false, drawerOpen:false };
const labels = { ...stageLabels,...severityLabels,ready:'Текст извлечён',processing:'Обработка',extracted:'Из документа',missing:'Не найдено',uncertain:'Нужно уточнить',open:'Открыто',verification:'На проверке',done:'Выполнено',unverified:'Сигнал · не проверен',confirmed:'Подтверждено',dismissed:'Не подтвердилось',recorded:'Зафиксировано' };
const iconPaths={close:'M6 6l12 12M18 6L6 18',menu:'M4 6h16M4 12h16M4 18h16',account:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',more:'M5 12h.01M12 12h.01M19 12h.01',copy:'M9 9h11v11H9zM15 9V4H4v11h5',expand:'M8 4H4v4M16 4h4v4M4 16v4h4M20 16v4h-4',collapse:'M4 8h4V4M20 8h-4V4M8 20v-4H4M16 20v-4h4',settings:'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2'};
const icon=name=>`<svg class="ui-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${iconPaths[name]||iconPaths.more}"/></svg>`;
const iconAction=(title,action)=>['source-close','summary-close','quick-source-close','quick-summary-close','nav-close'].includes(action)?'close':['source-width','quick-source-width'].includes(action)?(title==='Уже'?'collapse':'expand'):['summary-copy','quick-summary-copy'].includes(action)?'copy':action==='nav-toggle'?'menu':action==='settings'?'settings':null;
const btn = (title, action, value='', cls='', disabled=false) => {
  const glyph=iconAction(title,action),iconOnly=glyph&&!cls.includes('menu-action');
  return `<button type="button" data-action="${action}" data-value="${esc(value)}" class="${cls}${iconOnly?' icon-button':''}" ${iconOnly?`aria-label="${esc(title)}" title="${esc(title)}"`:''} ${['tab','quick-tab','kind','open-contract'].includes(action)&&cls.includes('active')?'aria-current="page"':''} ${['finding-filter','quick-filter'].includes(action)?'aria-pressed="'+(cls.includes('active'))+'"':''} ${action==='nav-toggle'?'aria-controls="catalog-drawer" aria-expanded="false"':''} ${disabled?'disabled':''}>${glyph?icon(glyph):''}${iconOnly?`<span class="control-tooltip">${esc(title)}</span>`:title}</button>`;
};
function controlMenu(name,label,content,{glyph='more',cls='',active='',iconOnly=false}={}){
  return `<details class="control-menu ${cls}" data-menu="${name}"><summary aria-controls="menu-${name}" aria-expanded="false" ${iconOnly?`aria-label="${esc(label)}" title="${esc(label)}"`:''} ${active?'aria-current="page"':''}>${icon(glyph)}${iconOnly?`<span class="control-tooltip">${esc(label)}</span>`:`<span>${label}${active?`<small class="active-subsection">${esc(active)}</small>`:''}</span>`}</summary><div class="menu-popover" id="menu-${name}">${content}</div></details>`;
}
function sectionTabs(quickMode=false){
  const current=quickMode?quick.tab:state.center,action=quickMode?'quick-tab':'tab',disabled=quickMode?!quick.packet:!state.contract;
  const primary=quickMode?[['passport','Паспорт'],['analysis','Анализ'],['source','Документ']]:[['passport','Паспорт'],['analysis','Анализ'],['document','Документ']];
  const secondary=quickMode?[['files','Пакет']]:[['set','Пакет'],['risks','Риски'],['history','История']];
  const active=secondary.find(([key])=>key===current)?.[1]||(current==='compare'?'Сравнение':'');
  const item=([key,title])=>btn(title,action,key,current===key?'active':'',disabled&&!(quickMode&&key==='files'));
  return `<nav class="tabs workspace-tabs" aria-label="${quickMode?'Разовая проверка':'Разделы договора'}">${primary.map(item).join('')}${controlMenu(quickMode?'quick-sections':'sections','Ещё',secondary.map(item).join(''),{cls:'sections-menu',active})}</nav>`;
}
const badge = (title, cls='') => `<span class="badge ${cls}">${esc(title)}</span>`;
const date = value => value ? new Date(value).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}) : '—';
const revision = () => state.contract?.revisions.find(r=>r.id===state.revisionId);
const analysis = () => state.contract?.analyses.find(a=>state.runId ? a.id===state.runId : a.revision_id===state.revisionId);
const result = () => analysis()?.review_result || analysis()?.primary_result;
const queue = () => state.queues.get(state.contractId) || [];
function chosen() { if(!state.selections.has(state.contractId)) state.selections.set(state.contractId,new Set(revision()?.file_ids||[])); return state.selections.get(state.contractId); }
async function api(path, data, method='POST') {
  const response = await fetch('/docs/api'+path,{ method:data===undefined?'GET':method,headers:data===undefined?{}:{'Content-Type':'application/json','X-Docs-Request':'1'},body:data===undefined?undefined:JSON.stringify(data) });
  const payload=await response.json(); if(!response.ok){if(response.status===401&&state.user){state.user=null;render();} const error=new Error(payload.error||'Не удалось выполнить запрос.');error.status=response.status;throw error;} return payload;
}
let noticeTimer, focusSummary=false,sourceReturn=null,focusSource=false,restoreSourceFocus=false;
function notice(text) { $('#notice').textContent=text;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').textContent='',7000); }
async function refreshBoot() { state.boot=await api('/bootstrap'); }
async function refreshContract() { if(state.contractId){state.contract=await api('/contracts/'+state.contractId); if(!state.contract.revisions.some(r=>r.id===state.revisionId))state.revisionId=state.contract.revisions[0]?.id||null;} }
async function openContract(id) { state.inspectorOpen=false;state.findingFilter='all'; state.sourceDocuments=null;state.summary=null;state.contractId=id;state.revisionId=null;state.runId=null;state.source=null;state.risk=null;state.form=null;await refreshContract();state.center=state.contract.revisions.length?'passport':'set';history.replaceState(null,'','#'+id);render(); }
function summaryPanel(a) {
  const s=state.summary; if(!s||s.analysisId!==a.id)return '';
  const parts=messageParts(s.text), manager=state.contract.manager;
  return `<section class="flow summary-panel"><div class="row between"><h3>Текст для менеджера</h3>${btn('Закрыть','summary-close','','quiet compact-action')}</div><p class="muted">Собран из сохранённого результата без обращения к модели. Текст содержит условия договора: отправляя его в мессенджер или почту, вы выносите их за пределы контролируемого контура.</p><div class="row">${btn(s.full?'Короткая сводка':'Все замечания','summary-scope','','compact-action')}${btn('Скопировать','summary-copy','','primary compact-action')}<a class="compact-action" href="/docs/api/analyses/${a.id}/summary?scope=${s.full?'full':'short'}&download=1">Скачать .txt</a>${btn(manager?'Открыть письмо':'Указать ответственного','summary-mail','','compact-action')}</div>${parts.length>1?`<p class="warning">Для мессенджера текст разбит на ${parts.length} части: копируйте и отправляйте по одной.</p><div class="row">${parts.map((_,i)=>btn('Копировать '+(i+1)+'/'+parts.length,'summary-copy',i,'quiet compact-action')).join('')}</div>`:''}<label class="sr-only" for="summary-text">Текст замечаний</label><textarea id="summary-text" readonly rows="14">${esc(s.text)}</textarea><small>${manager?'Ответственный: '+esc(manager):'Ответственный не указан'} · ${s.text.length} знаков</small></section>`;
}
function candidates() {
  const c=state.contract,a=analysis(),r=result();
  if(!c||c.kind==='template'||!a||!r)return [];
  const dismissed=new Set((c.dismissed||[]).map(d=>d.key));
  const registered=new Set(c.risks.map(x=>x.finding_key).filter(Boolean));
  const origins=new Set(c.risks.map(x=>x.origin).filter(Boolean));
  return r.findings.map((finding,index)=>({finding,index,key:findingKey(finding)})).filter(x=>!dismissed.has(x.key)&&!registered.has(x.key)&&!origins.has(a.id+':'+x.finding.id));
}
function sources(items=[]) { return items.map(s=>btn(esc(sourceLabel(s,state.contract?.files)), 'source', JSON.stringify({...s,analysisId:s.analysisId||analysis()?.id}),'source-link')).join(''); }
function formWrap(name,title,fields,submit='Сохранить') { return `<form class="form" data-form="${name}"><h2>${title}</h2>${fields}<div class="error" role="alert"></div><div class="actions"><button class="primary" type="submit">${submit}</button>${btn('Отмена','cancel-form')}</div></form>`; }
const field=(name,title,value='',type='text',extra='')=>`<label>${title}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const area=(name,title,value='',extra='')=>`<label>${title}<textarea name="${name}" ${extra}>${esc(value)}</textarea></label>`;
const select=(name,title,values,current='',extra='')=>`<label>${title}<select name="${name}" ${extra}>${values.map(([v,t])=>`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;
const organizations = new OrganizationUI({api,esc,btn,render,getBoot:()=>state.boot,isActive:()=>state.form?.type==='organization'});
const quick = new QuickUI({api,esc,btn,badge,date,notice,render,controlMenu,sectionTabs,getBoot:()=>state.boot});
function loginView() {
  const register=state.loginMode==='register';
  return `<div class="login-page"><section class="login-story" aria-labelledby="promo-title"><div class="promo-header"><div class="brand"><img class="mark" src="/docs/logo.svg" width="30" height="34" alt="" aria-hidden="true">Договоры и риски</div><button class="quiet promo-signin" type="button" data-action="auth-focus">Ко входу</button></div><div class="promo-intro"><h1 id="promo-title">Проверьте договор.<br>Управляйте рисками.</h1><p class="promo-audience">Для подрядчиков, юристов и руководителей проектов, которые согласуют договоры и отвечают за их исполнение.</p></div><ul class="promo-benefits"><li><strong>Разобраться в условиях</strong><span>Предмет, сроки, оплата и место работ — в паспорте договора. Замечания — со ссылками на исходные пункты.</span></li><li><strong>Подготовиться к согласованию</strong><span>Двухэтапный AI-анализ с отдельным ревью и рекомендациями: что изменить, уточнить или дополнить.</span></li><li><strong>Не потерять договорённости</strong><span>Редакции, история проверок и риски с ответственными и мерами по их снижению — в одном месте.</span></li></ul><div class="promo-foot"><p class="promo-formats">PDF, DOC, DOCX · договоры и приложения одним пакетом</p><p class="promo-mode">Разовая проверка без добавления в хранилище или постоянная работа с договорами.</p><p class="promo-disclaimer">AI помогает в проверке, но не заменяет юридическую экспертизу. В текущей версии текст передаётся в Codex для анализа.</p><div class="row"><a class="installation-link" href="/docs/local-installation/" target="_blank" rel="noopener">Локальная установка</a><a class="installation-link" href="https://github.com/igormel81/contract-docs" target="_blank" rel="noopener noreferrer" aria-label="Код на GitHub (новая вкладка)">Код на GitHub</a></div></div></section><main class="login-box" id="main"><form class="form" data-form="auth"><div><h2>${register?'Создать аккаунт':'Вход в рабочее место'}</h2><p class="muted">${register?'Придумайте логин и пароль.':'Используйте свой логин и пароль.'}</p></div>${field('login','Логин','','text','required minlength="3" maxlength="64" autocomplete="username"')}${field('password','Пароль','','password',`required maxlength="256" autocomplete="${register?'new-password':'current-password'}" ${register?'minlength="10"':''}`)}${btn('Показать пароль','show-password','','quiet')}<div class="error" role="alert"></div><button class="primary" type="submit">${register?'Создать аккаунт':'Войти'}</button>${btn(register?'Уже есть аккаунт? Войти':'Создать аккаунт', 'auth-mode',register?'login':'register','quiet')}<p class="login-note">${register?'Минимум 10 символов в пароле. Почта и телефон не нужны. Новый аккаунт не получает доступ к чужим договорам.':'Забыли пароль? Обратитесь к администратору сервера.'}</p></form></main></div>`;
}
function topbar(){
  const about=controlMenu('about','О сервисе','<a href="/docs/local-installation/" target="_blank" rel="noopener" aria-label="Локальная установка (новая вкладка)">Локальная установка</a><a href="https://github.com/igormel81/contract-docs" target="_blank" rel="noopener noreferrer" aria-label="Код на GitHub (новая вкладка)">Код на GitHub</a>',{cls:'nested-menu'});
  const account=controlMenu('account','Аккаунт: '+state.user.login,`<p class="menu-account">${esc(state.user.login)}</p>${btn('Настройки','settings','','menu-action')}${btn('Организации','organizations','','menu-action')}${about}<hr>${btn('Выйти','logout','','menu-action')}`,{glyph:'account',cls:'account-menu',iconOnly:true});
  return `<header class="topbar">${btn('Открыть каталог','nav-toggle','','quiet mobile-nav')}<div class="brand"><img class="mark" src="/docs/logo.svg" width="30" height="34" alt="" aria-hidden="true"><span>Договоры и риски</span></div>${account}</header>`;
}
function drawer(content){
  return `<aside id="catalog-drawer" class="sidebar" aria-label="Каталог договоров"><div class="drawer-heading"><strong>Договоры и шаблоны</strong>${btn('Закрыть каталог','nav-close','','quiet')}</div>${content}</aside>`;
}
function sidebar() {
  if(state.center==='organizations')return drawer(btn('К договорам','stored','','quiet')+btn('Разовая проверка','quick-open','','primary'));
  if(state.center==='quick')return drawer(btn('Разовая проверка','quick-open','','primary')+btn('К договорам','stored','','quiet'));
  const list=state.boot.contracts.filter(c=>c.kind===state.kind&&(!state.customer||c.customer_id===state.customer)&&c.title.toLowerCase().includes(state.query.toLowerCase()));
  return drawer(`${btn('Разовая проверка','quick-open','','primary')}<div class="nav">${btn('Договоры','kind','contract',state.kind==='contract'?'active':'')}${btn('Шаблоны','kind','template',state.kind==='template'?'active':'')}</div><label class="sr-only" for="search">Поиск по названию</label><input id="search" placeholder="Найти договор…" value="${esc(state.query)}"><label>Заказчик<select id="customer-filter"><option value="">Все заказчики</option>${state.boot.customers.map(c=>`<option value="${c.id}" ${state.customer===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><div class="catalog-create">${btn('+ '+(state.kind==='template'?'Шаблон':'Договор'),'new-contract','','grow')}${btn('+ Заказчик','new-customer','','compact-action')}</div><nav class="catalog" aria-label="Договоры">${list.length?list.map(c=>`<button type="button" data-action="open-contract" data-value="${c.id}" class="${state.contractId===c.id?'active':''}" ${state.contractId===c.id?'aria-current="page"':''}><strong>${esc(c.title)}</strong><small>${esc(c.stage)} · ${c.revision_count} ред.</small></button>`).join(''):'<p class="muted">Здесь появятся ваши документы.</p>'}</nav><div class="sidebar-foot">${btn('Критерии проверки','rules','','quiet')}</div>`);
}
function context() {
  const c=state.contract,customer=state.boot.customers.find(x=>x.id===c.customer_id),organization=state.boot.profiles[c.contractor];
  return `<header class="context contract-context"><div class="contract-heading">${btn('К договорам','catalog-back','','quiet compact-action mobile-back')}<p>${esc(customer?.name||'Библиотека шаблонов')}</p><h1>${esc(c.title)}</h1><div class="contract-organization"><span>Подрядчик: <strong>${esc(organization?.name||'не выбран')}</strong></span>${btn(organization?'Изменить':'Выбрать организацию','change-contractor','','quiet compact-action')}</div></div><div class="context-actions"><label class="sr-only" for="revision-select">Редакция</label><select id="revision-select"><option value="">Без редакции</option>${c.revisions.map(r=>`<option value="${r.id}" ${r.id===state.revisionId?'selected':''}>v${r.number}${c.effective_id===r.id?' · действует':''}</option>`).join('')}</select>${btn(c.analyses.some(a=>a.revision_id===state.revisionId)?'Проверить повторно':'Проверить','analyze','','primary',!state.revisionId||c.analyses.some(a=>a.revision_id===state.revisionId&&['queued','primary','review'].includes(a.status)))}</div></header>`;
}
function uploadView() {
  const c=state.contract,q=queue(), selected=chosen(); const blocked=q.some(x=>x.status==='uploading'||x.status==='selected'||(x.similar?.length&&!x.decision));
  return `<div class="flow"><div id="dropzone" class="dropzone"><strong>Перетащите документы сюда</strong><p class="muted">PDF, DOC, DOCX · несколько сразу · до 20 МБ на файл</p>${btn('Выбрать файлы','pick-files','','primary')}<input class="hidden" id="file-picker" type="file" accept=".pdf,.doc,.docx" multiple></div>${q.length?`<div class="section-title"><h3>Очередь загрузки · ${q.length}</h3></div>${q.map((row,i)=>`<div class="queue-row"><span class="file-type">${esc(row.file.name.split('.').pop().toUpperCase())}</span><div><strong>${esc(row.file.name)}</strong><div><small>${esc(row.message||'Ожидает загрузки')}</small></div>${row.status==='uploading'?`<progress max="100" value="${row.progress||0}"></progress>`:''}${row.similar?.length?`<select data-queue-choice="${i}" aria-label="Решение по похожему файлу"><option value="">Похожий текст — выберите действие</option><option value="separate" ${row.decision==='separate'?'selected':''}>Сохранить отдельным документом</option>${row.similar.map(s=>`<option value="${s.id}" ${row.decision===s.id?'selected':''}>Заменяет: ${esc(s.name)}</option>`).join('')}</select>`:''}</div><div>${row.status==='error'?btn('Повторить','retry-upload',i,'compact-action'):''}${row.status!=='uploading'?btn('Убрать','remove-queue',i,'quiet compact-action'):''}</div></div>`).join('')}`:''}<div class="section-title"><h3>Состав новой редакции</h3><small>Выбрано: ${selected.size}</small></div><p class="muted">Отметьте договор и нужные приложения. Снятие отметки не удаляет оригинал.</p>${c.files.length?c.files.map(f=>`<div class="file-row"><input type="checkbox" data-file-choice="${f.id}" aria-label="Включить ${esc(f.name)}" ${selected.has(f.id)?'checked':''}><div><strong>${esc(f.name)}</strong><div><small>${esc(labels[f.status]||f.status)} · ${(f.size/1024).toFixed(0)} КБ</small></div>${f.status==='error'?`<p class="error">${esc(f.extraction?.warnings?.join(' '))}</p>`:''}</div>${f.status==='error'?btn('Повторить чтение','retry-extract',f.id,'compact-action'):btn('Текст','file',f.id,'compact-action')}</div>`).join(''):'<p class="muted">Файлы ещё не загружены.</p>'}<form class="form" data-form="revision">${select('parent_id','На основе редакции',[['','Без родительской редакции'],...c.revisions.map(r=>[r.id,'v'+r.number])],state.revisionId||'')}${field('note','Комментарий к редакции','','text','maxlength="1000" placeholder="Например: редакция заказчика от 3 сентября"')}<div class="error" role="alert"></div><button class="primary" ${!selected.size||blocked?'disabled':''} type="submit" name="revision-action" value="save">Создать редакцию</button><button type="submit" name="revision-action" value="analyze" ${!selected.size||blocked||!state.boot.codex.connected?'disabled':''}>Создать и проверить</button></form></div>`;
}
function documentView() {
  const files=state.sourceDocuments||state.contract.files; const file=files.find(f=>f.id===state.source?.fileId)||files.find(f=>revision()?.file_ids.includes(f.id))||files[0];
  if(!file)return `<div class="empty"><h2>Исходников пока нет</h2><p>Загрузите основной договор и приложения.</p>${btn('Загрузить','tab','set','primary')}</div>`;
  return `<div class="flow"><div class="row"><label class="grow">Документ<select id="document-select">${files.map(f=>`<option value="${f.id}" ${f.id===file.id?'selected':''}>${esc(f.name)}</option>`).join('')}</select></label><a href="/docs/api/files/${file.id}/download" class="compact-action">Скачать оригинал</a></div><small>${state.source?.riskId?'Пункт и редакция, зафиксированные при регистрации риска.':state.sourceDocuments?'Исходник выбранного анализа. Обновление структуры файла не меняет этот снимок.':'Структура документа с исходной нумерацией. Нераспознанные номера не подставляются.'}</small>${!state.sourceDocuments&&file.extraction?.extractor!=='structure-v3'?btn('Обновить структуру','refresh-structure',file.id,'quiet'):''}${file.extraction?.warnings?.length?`<div class="warning">${file.extraction.warnings.map(esc).join('<br>')}</div>`:''}${documentText(file,state.source,esc)}</div>`;
}
function passportView() {
  const r=result(),a=analysis();
  if(!r||a.revision_id!==state.revisionId)return `<div class="empty"><span class="empty-mark">Паспорт договора</span><h2>О чём договор — в нескольких строках</h2><p>Создайте редакцию пакета и запустите анализ. Первый агент сформирует предмет и ключевые условия, второй проверит их по исходникам.</p><p>Неизвестные условия не заполняются догадками.</p>${btn('К пакету','tab','set','primary')}</div>`;
  return `<div class="flow"><div class="row between"><h2>Паспорт · v${revision()?.number}</h2>${badge(a.review_result?'С ревью':'Без ревью',a.review_result?'':'medium')}</div><p>${esc(r.summary)}</p>${compactPassport(r,esc,sources)}<details><summary>Ограничения проверки</summary><div class="warning">${r.limitations.map(esc).join('<br>')}</div><p class="muted">Паспорт относится к выбранному пакету и не означает юридического согласования.</p></details></div>`;
}
// Комплект: загрузка файлов, состав новой редакции и сами редакции — один раздел,
// потому что это одна работа, а не две.
function setView() { return uploadView()+'<hr class="separator">'+versionsView(); }
function versionsView() { return `<div class="flow"><div class="row between"><h2>Редакции</h2>${btn('Сравнить','compare','','',state.contract.revisions.length<2)}</div>${state.contract.revisions.map(r=>`<article class="version"><div class="row between"><h3>v${r.number} ${state.contract.effective_id===r.id?badge('Действующий','good'):''}</h3>${btn('Открыть','revision',r.id,'compact-action')}</div><small>${date(r.created)} · ${r.file_ids.length} файлов</small><p>${esc(r.note)}</p><p class="muted">Основана на ${r.parent_id?'v'+state.contract.revisions.find(x=>x.id===r.parent_id)?.number:'исходном пакете'}</p>${btn('Подтвердить действующий пакет','effective',r.id,'quiet compact-action')}</article>`).join('')||'<p class="muted">Редакций пока нет. Создайте первую редакцию пакета на вкладке загрузки.</p>'}${btn('Изменить стадию договора','stage','','quiet')}</div>`; }
function compareView() {
  const versions=state.contract.revisions;
  const right=versions.find(v=>v.id===state.compareRight)||versions[0];
  const left=versions.find(v=>v.id===state.compareLeft)||versions.find(v=>v.id!==right?.id)||versions[1];
  const picker=(current,name,title)=>`<label>${title}<select id="${name}">${versions.map(v=>`<option value="${v.id}" ${v.id===current?.id?'selected':''}>v${v.number}</option>`).join('')}</select></label>`;
  if(!left||!right||left.id===right.id)return `<div class="flow"><h2>Сравнение редакций</h2><div class="row">${picker(left,'compare-left','Была')}${picker(right,'compare-right','Стала')}</div><p class="muted">Выберите две разные редакции.</p></div>`;
  const rows=clauseDiff(left,right,state.contract.files), only=state.compareOnlyChanged!==false;
  const counts={changed:0,new:0,gone:0,moved:0,same:0};
  for(const row of rows)counts[row.state]++;
  const titles={changed:'изменён',new:'новый',gone:'удалён',moved:'перенумерован',same:'без изменений'};
  const shown=rows.filter(row=>!only||row.state!=='same');
  return `<div class="flow"><h2>Сравнение редакций</h2><div class="row">${picker(left,'compare-left','Была')}${picker(right,'compare-right','Стала')}</div>
    <div class="row">${badge('изменено '+counts.changed,counts.changed?'medium':'')}${badge('новых '+counts.new,counts.new?'medium':'')}${badge('удалено '+counts.gone,counts.gone?'high':'')}${badge('перенумеровано '+counts.moved)}${badge('без изменений '+counts.same,'good')}</div>
    <p class="muted">Сопоставление по номеру пункта, а при его отсутствии — по тексту. Это разметка текстовых изменений, а не смысловой разбор: совпадение текста не означает, что условие не изменилось по смыслу.</p>
    ${btn(only?'Показать все пункты':'Только изменения','compare-filter','','compact-action')}
    ${shown.map(row=>{
      const item=row.item||row.was;
      const label=(item.block.locator?.label||'Без номера')+' · '+item.file;
      const diff=row.state==='changed'?wordDiff(row.was.text,row.item.text,esc):null;
      const versions=row.state==='changed'?`<div class="comparison"><section><h3>Было · v${left.number}</h3><p class="diff-text">${diff.before}</p></section><section><h3>Стало · v${right.number}</h3><p class="diff-text">${diff.after}</p></section></div>`:`<p class="diff-text">${esc(item.text||'')}</p>`;
      return `<article class="version"><div class="row">${badge(titles[row.state],row.state==='gone'?'high':row.state==='same'?'good':'medium')}<small>${esc(label)}</small></div><details class="clause-comparison" ${row.state==='changed'?'open':''}><summary>Полный текст пункта${row.state==='moved'?' · было '+esc(row.was.block.locator?.label||'без номера'):''}</summary>${versions}${diff&&!diff.highlighted?'<small class="muted">Большой пункт показан полностью; подсветка отдельных слов не выполнялась.</small>':''}</details></article>`;
    }).join('')||'<p class="muted">Различий не найдено.</p>'}</div>`;
}
function settingsView() {
  const connection=state.boot.codex;
  let control='';
  if(connection.canManage){
    if(connection.state==='disconnecting')control='<p role="status">Отключаем общий Codex…</p>';
    else if(connection.connected)control=btn('Отключить для всех','codex-logout','','danger');
    else if(connection.login?.state==='pending')control=`<div class="flow" role="status"><p>${connection.login.code?'Откройте страницу входа и введите одноразовый код:':'Получаем код входа…'}</p>${connection.login.code?`<h2 class="mono">${esc(connection.login.code)}</h2>`:''}${connection.login.url?`<p><a href="${esc(connection.login.url)}" target="_blank" rel="noopener noreferrer">Открыть официальный вход ChatGPT</a></p>`:''}<p><small>Код виден только владельцу приложения. Вход подключит Codex для всех пользователей; не передавайте код другим людям.</small></p>${btn('Отменить подключение','codex-logout','','quiet')}</div>`;
    else control=btn('Подключить общий Codex','codex-login','','primary');
    if(connection.login?.error)control+=`<div class="error" role="alert">${esc(connection.login.error)}</div>`;
  }else control=`<p class="muted">${connection.state==='connecting'?'Владелец сейчас подключает Codex. Статус обновится автоматически.':'Подключением управляет владелец приложения. Отдельный вход в ChatGPT вам не нужен.'}</p>`;
  return `<div class="settings flow"><h2>Codex для приложения</h2><p>Одно серверное подключение ChatGPT для всех пользователей и обоих этапов анализа. API-ключи не используются; очередь и лимит подключённого аккаунта общие.</p><div class="${connection.connected?'info':'warning'}" role="status">${connection.connected?'Общий вход ChatGPT сохранён. Доступность анализа проверяется при запуске.':'Общий Codex не подключён. Документы, редакции и ручной реестр рисков доступны.'}</div>${control}<p class="muted">Ваш логин и пароль приложения независимы от Codex. Выход из приложения не отключает общее подключение.</p><hr class="separator"><h3>Ограничения пилота</h3><p class="muted">Нормативные основания и их актуальность показаны в критериях проверки. OCR пока не подключён. Результаты AI требуют проверки сотрудником. Договоры и история пользователей изолированы, несмотря на общее подключение Codex.</p><p class="muted">Загрузка до 20 МБ на файл, 200 МБ на аккаунт. История хранится на VPS.</p><hr class="separator"><form class="form" data-form="password"><h3>Сменить пароль приложения</h3>${field('current','Текущий пароль','','password','required autocomplete="current-password"')}${field('password','Новый пароль','','password','required minlength="10" maxlength="256" autocomplete="new-password"')}<div class="error" role="alert"></div><button type="submit">Сменить пароль и выйти</button></form></div>`;
}
function centerForm() {
  const f=state.form;
  if(f?.type==='organization')return organizations.form();
  if(f?.type==='contractor')return formWrap('contractor','Организация подрядчика',select('contractor','Подрядчик',Object.entries(state.boot.profiles).map(([k,p])=>[k,p.name]),state.contract.contractor)+'<p class="muted">Только для новых проверок; прежние результаты сохранят исходный профиль.</p>'+btn('Создать организацию','new-organization'));
  if(f?.type==='customer')return formWrap('customer','Новый заказчик',field('name','Название','','text','required maxlength="200"')+field('inn','ИНН · необязательно','','text','inputmode="numeric" maxlength="12"'),'Создать заказчика');
  if(f?.type==='contract')return formWrap('contract',state.kind==='template'?'Новый шаблон':'Новый договор',field('title','Название или номер','','text','required maxlength="200"')+(state.kind==='contract'?select('customer_id','Заказчик',state.boot.customers.map(c=>[c.id,c.name]),state.customer):'')+select('contractor','Подрядчик',Object.entries(state.boot.profiles).map(([k,p])=>[k,p.name])),'Создать');
  if(f?.type==='effective')return formWrap('effective','Действующий пакет',`<p>Подтвердите основание действия редакции v${state.contract.revisions.find(x=>x.id===f.id)?.number}. Загрузка файла сама по себе не означает подписание.</p>`+area('reason','Основание: подписание, дата и область действия','','required maxlength="1000"'),'Подтвердить');
  if(f?.type==='stage')return formWrap('stage','Стадия договора',select('stage','Стадия',['Подготовка','Согласование','Подписан','Исполнение','Завершён','Прекращён','Архив'].map(x=>[x,x]),state.contract.stage)+area('reason','Основание','','required maxlength="1000"'));
  if(f?.type==='manager')return formWrap('manager','Ответственный за договор',`<p class="muted">Имя или почта менеджера. Подставляется в текст замечаний и в адрес письма; приложение ничего не отправляет само.</p>`+field('manager','Имя или адрес почты',state.contract.manager||'','text','maxlength="200"'),'Сохранить');
  return null;
}
function centerView() {
  const form=centerForm();if(form)return form;
  if(state.center==='organizations')return organizations.list();
  if(state.center==='settings')return settingsView();
  if(state.center==='rules')return `<div class="flow"><h2>Критерии проверки</h2>${legalCatalogue()}<p class="muted">Рекомендательный разбор для подготовки к переговорам, а не заключение о соответствии: правила формулируют вопросы и предложения, решение принимает сотрудник. Аналитик ищет полноту, ревьюер проверяет по оригиналам. Расположение и ресурсы берутся из вашей карточки организации. У каждого критерия своя версия: при её изменении прежние анализы не переписываются, а помечаются в истории.</p>${state.boot.rules.map(r=>`<section class="details-field"><div class="row">${badge(r.id)}${badge('версия '+r.version)}${r.coverage===false?badge('вне покрытия','medium'):''}</div><h3>${esc(r.title)}</h3><p>${esc(r.instruction)}</p>${r.avoid?`<p class="muted"><strong>Не считать замечанием:</strong> ${esc(r.avoid)}</p>`:''}</section>`).join('')}</div>`;
  if(!state.contract)return `<div class="empty"><span class="empty-mark">Рабочее место</span><h2>Начните с заказчика и договора</h2><p>Здесь будут оригиналы, паспорт, история анализа и риски. Демонстрационных договоров нет — все записи создаёте вы.</p>${btn('Создать заказчика','new-customer','','primary')}</div>`;
  return ({set:setView,document:documentView,passport:passportView,compare:compareView,analysis:analysisView,risks:riskView,history:historyView}[state.center]||passportView)();
}
function legalCatalogue(){
  const catalog=state.boot.legal;if(!catalog)return '<p class="warning">Состояние нормативной базы не получено.</p>';
  return `<details class="legal-catalogue"><summary>Нормативная база · ${esc(catalog.version)} · ${esc(legalStatusLabels[catalog.status]||'Актуальность требует проверки')}</summary><div class="flow"><small>Проверка источников: ${date(catalog.checkedAt)}${catalog.currentAsOf?' · актуальность на '+esc(catalog.currentAsOf):''}${catalog.reviewDueAt?' · следующая проверка '+date(catalog.reviewDueAt):''}</small>${(catalog.limitations||[]).map(x=>`<p class="warning">${esc(x)}</p>`).join('')}${legalReferences((catalog.norms||[]).map(n=>({...n,normId:n.id||n.normId,quote:n.text,verificationStatus:n.verificationStatus||catalog.status})),esc)}</div></details>`;
}
function riskSignals(r){
  const confirmed=r.events.filter(e=>e.kind==='incident'&&e.state==='confirmed').length,unverified=r.events.filter(e=>e.kind==='incident'&&e.state==='unverified').length;
  const next=r.events.filter(e=>e.kind==='mitigation'&&e.state!=='done').sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'))[0];
  const today=new Date().toLocaleDateString('sv-SE'),overdue=next?.due&&next.due<today;
  return `${confirmed?badge('Наступление подтверждено · '+confirmed,'high'):''}${unverified?badge('Непроверенные сигналы · '+unverified,'medium'):''}${next?`<span class="risk-next"><strong>${overdue?'Просрочена мера':'Ближайшая мера'}${next.due?' · '+esc(next.due):' · срок не задан'}</strong><span>${esc(next.text)}</span></span>`:''}`;
}
// Вторая область — спутник, а не второй раздел: она показывает то, что парно
// открытому разделу. Своего меню у неё нет, поэтому одно и то же содержимое
// больше не живёт в двух местах под разными подписями.
const companions = {
  document:{title:'Замечания по документу',view:()=>analysisView()},
  set:{title:'Документ',view:()=>documentView()},
  compare:{title:'Документ',view:()=>documentView()}
};
function companionTitle() { return companions[state.center]?.title || 'Источник'; }
function companionView() {
  const pair=companions[state.center];
  if(pair)return pair.view();
  return state.source ? documentView() : `<div class="empty"><h3>Источник</h3><p>Выберите ссылку на пункт — в паспорте, замечании или риске. Здесь откроется его текст с исходной нумерацией.</p></div>`;
}
function analysisView() {
  const a=analysis(),r=result();
  if(!a)return `<div class="flow analysis-result"><div class="empty"><h3>Проверка в два этапа</h3><p>Аналитик выявляет условия и риски. Ревьюер сверяет выводы и предложения с исходниками.</p>${state.boot.codex.connected?'':btn(state.boot.codex.canManage?'Подключить общий Codex':'Статус общего Codex','settings','','primary')}</div></div>`;
  return compactAnalysis(a,r);
}
function compactAnalysis(a,r) {
  const rev=state.contract.revisions.find(v=>v.id===a.revision_id),running=['queued','primary','review'].includes(a.status);
  const saved=f=>state.contract.recommendations.find(x=>x.analysis_id===a.id&&x.finding_id===f.id);
  const unresolved=f=>!saved(f)||saved(f).status==='draft';
  const filtered=(r?.findings||[]).map((f,index)=>({f,index})).filter(({f})=>state.findingFilter==='high'?f.severity==='high':state.findingFilter==='unresolved'?unresolved(f):true);
  const count=r?.findings.length||0, remaining=r?.findings.filter(unresolved).length||0;
  const finding=({f,index})=>{
    const key=a.id+':'+f.id,edit=state.drafts.get(key)||saved(f),decision=saved(f)?.status,dirty=state.drafts.has(key);
    return `<article class="finding"><details class="finding-disclosure" data-finding-key="${esc(key)}" ${state.openFindings.has(key)?'open':''}><summary><span class="finding-heading">${badge(labels[f.severity],f.severity)}<strong>${esc(f.title)}</strong><small>${dirty?'Не сохранено':decision==='planned'?'В плане правок':decision==='rejected'?'Отклонено':'Без решения'}</small></span></summary><div class="finding-body flow"><div class="row">${badge(f.rule)}${badge(f.review==='primary'?'Без ревью':f.review==='added'?'Добавлено ревьюером':f.review==='corrected'?'Исправлено':'Подтверждено')}${state.contract.kind==='contract'?btn('В реестр рисков','finding-risk',index,'compact-action'):''}</div><p>${esc(f.description)}</p>${legalReferences(f.legalSources,esc)}<form data-form="recommendation" data-draft-key="${esc(key)}" data-index="${index}" class="flow"><label>Предлагаемая формулировка<textarea name="text" required maxlength="15000">${esc(edit?.text??f.proposal)}</textarea></label>${select('status','Решение',[['draft','Черновик'],['planned','В плане правок'],['rejected','Отклонено']],edit?.status||'draft')}<div class="error" role="alert"></div><div class="decision-actions"><button type="submit" class="primary compact-action">Сохранить решение</button>${btn(edit?.text||f.proposal?'Предложить заново':'Предложить формулировку','propose',index,'quiet compact-action')}</div></form></div></details><div class="finding-sources">${sources(f.sources)}</div></article>`;
  };
  return `<div class="flow analysis-result" data-result-key="${a.id}"><div class="row between"><h2>Анализ и рекомендации</h2>${r?btn('Текст для менеджера','summary-open','','compact-action'):''}</div><div class="row between" role="status">${badge(labels[a.status],a.status==='error'?'high':a.status==='complete'?'good':'medium')}<small>v${rev?.number} · ${date(a.created)}${running?' · прошло '+Math.max(0,Math.floor((Date.now()-Date.parse(a.created))/60000))+' мин':''}</small></div>${a.revision_id!==state.revisionId?'<div class="warning">Этот анализ относится к другой редакции.</div>':''}${running?`<div class="step-line"><div class="step ${a.primary_result?'done':a.status==='primary'?'running':''}">1. Аналитик · ${a.primary_result?'готово':a.status==='primary'?'в работе':'ожидается'}</div><div class="step ${a.status==='review'?'running':''}">2. Ревьюер · ${a.status==='review'?'в работе':'ожидается'}</div></div><div class="row"><small>Можно продолжить работу с другими договорами.</small>${btn('Отменить анализ','cancel-analysis',a.id,'quiet compact-action')}</div>`:''}${a.error?`<div class="error" role="alert">${esc(a.error)}</div>${['error','interrupted'].includes(a.status)?btn('Повторить этап','retry-analysis',a.id):''}`:''}${r?`${!a.review_result?'<p class="warning">Первичный результат: независимое ревью ещё не завершено.</p>':''}<small class="legal-status">${esc(legalSnapshotLabel(a.legal))}</small>${summaryPanel(a)}<div class="findings-toolbar"><strong>Замечания: ${count} · без решения: ${remaining}</strong><div class="row" role="group" aria-label="Фильтр замечаний">${[['all','Все'],['high','Высокая критичность'],['unresolved','Без решения']].map(([v,t])=>btn(t,'finding-filter',v,'compact-action '+(state.findingFilter===v?'active':''))).join('')}</div></div>${filtered.map(finding).join('')||`<p class="muted">${count?'Нет замечаний по выбранному фильтру.':'Замечания не сформированы. Учитывайте ограничения проверки.'}</p>`}<details class="analysis-limitations"><summary>Ограничения проверки · ${r.limitations.length}</summary><div class="warning">${r.limitations.map(esc).join('<br>')}</div><p class="muted">План правок не означает согласия заказчика.</p></details><details><summary>Покрытие критериев</summary>${r.coverage.map(c=>`<p><strong>${esc(c.rule)}</strong> · ${esc(coverageLabels[c.status]||c.status)}<br>${esc(c.note)}</p>`).join('')}</details>${r.changes.length?`<details><summary>Изменения ревьюера</summary>${r.changes.map(x=>`<p>${esc(x)}</p>`).join('')}</details>`:''}<a class="compact-action" href="/docs/api/analyses/${a.id}/export">Скачать результат JSON</a>`:'<p class="muted">Результат появится после завершения этапа.</p>'}</div>`;
}
function riskView() {
  const c=state.contract;if(!c)return '<p class="muted">Выберите договор.</p>';
  if(c.kind==='template')return '<p class="muted">Риски шаблона остаются замечаниями анализа. Постоянный реестр ведётся по реальным договорам.</p>';
  const f=state.form;
  if(f?.type==='dismiss'){const item=result()?.findings[f.index];return item?formWrap('dismiss','Отклонить кандидата',`<p><strong>${esc(item.title)}</strong></p><p class="muted">Замечание останется в результате анализа. В кандидаты оно больше не попадёт, пока вы не вернёте его вручную.</p>`+area('reason','Основание отклонения','','required maxlength="1000"'),'Отклонить'):'<p class="muted">Замечание недоступно.</p>';}
  if(f?.type==='risk')return formWrap('risk','Зафиксировать риск',field('title','Название',f.finding?.title||'','text','required maxlength="200"')+(f.finding?select('severity','Критичность риска',[['','— выберите —'],...Object.entries(severityLabels)],'','required')+`<p class="muted">У замечания критичность «${esc(labels[f.finding.severity])}» — это серьёзность условия. Критичность риска складывается из вероятности, влияния и уверенности: подтвердите выбор.</p>`:select('severity','Критичность',Object.entries(severityLabels),'medium'))+field('owner','Ответственный',state.user.login,'text','required maxlength="100"')+`${f.finding?'<div>'+sources(f.finding.sources)+'</div>':select('source','Пункт и редакция (если риск связан с условием)',[['','Нет конкретного пункта'],...(revision()?.file_ids||[]).flatMap(id=>{const file=c.files.find(x=>x.id===id);return (file?.extraction?.blocks||[]).map(b=>[JSON.stringify({fileId:id,blockId:b.id,revisionId:state.revisionId}),file.name+': '+locationLabel(b)+' '+b.text.slice(0,90)]);})])}`+area('detail','Причина, событие и последствия',f.finding?.description||'','required maxlength="5000"'),'Добавить в реестр');
  const risk=c.risks.find(r=>r.id===state.risk);
  if(f?.type==='risk-event')return formWrap('risk-event',f.kind==='incident'?'Сигнал о наступлении':'Мера / запись',select('kind','Тип',[['mitigation','Мера снижения'],['incident','Сигнал о наступлении'],['note','Заметка']],f.kind)+area('text','Описание, ответственный и доказательства','','required maxlength="5000"')+field('due','Дата события / срок меры · необязательно','','date'),'Зафиксировать');
  if(f?.type==='risk-status')return formWrap('risk-status','Изменить статус риска',select('status','Статус',['Открыт','Снижаем','На проверке','Закрыт'].map(x=>[x,x]),risk.status)+area('reason','Основание и доказательства','','required maxlength="2000"'));
  if(f?.type==='event-status'){const event=risk.events.find(e=>e.id===f.id);return formWrap('event-status','Проверка записи',select('state','Результат',(event.kind==='incident'?['unverified','confirmed','dismissed']:['open','verification','done']).map(s=>[s,labels[s]]),event.state)+area('reason','Основание / подтверждение','','required maxlength="3000"'));}
  if(risk)return `<div class="flow">${btn('Все риски','all-risks','','quiet')}<div class="row">${badge(labels[risk.severity],risk.severity)}${badge(risk.status)}</div><h2>${esc(risk.title)}</h2><p>${esc(risk.detail)}</p><div>${risk.sources?.length?risk.sources.map((s,i)=>btn(esc('v'+s.revisionNumber+' · '+sourceLabel(s)),'risk-source',JSON.stringify([risk.id,i]),'source-link')).join(''):'<small>Нет ссылки на конкретный пункт; источник не подтверждён.</small>'}</div><small>Ответственный: ${esc(risk.owner)} · ${date(risk.created)}</small><div class="row">${btn('Мера снижения','risk-event','mitigation')}${btn('Событие','risk-event','incident')}${btn('Статус','risk-status')}</div>${risk.events.map(e=>`<article class="history-row"><small>${date(e.created)}${e.due?' · дата / срок '+esc(e.due):''}</small><div class="row">${badge(e.kind==='incident'?'Событие':e.kind==='mitigation'?'Мера':e.kind==='decision'?'Решение':'Заметка')}${badge(labels[e.state]||e.state)}</div><p>${esc(e.text)}</p>${['mitigation','incident'].includes(e.kind)?btn('Проверить / обновить','event-status',e.id,'quiet compact-action'):''}</article>`).join('')||'<p class="muted">Мер и событий пока нет.</p>'}</div>`;
  const pending=candidates(),run=analysis(),runRevision=c.revisions.find(v=>v.id===run?.revision_id);
  const dismissed=c.dismissed||[];
  return `<div class="flow">${pending.length?`<section class="flow"><div class="row between"><h3>Кандидаты из анализа${runRevision?' v'+runRevision.number:''} · ${pending.length}</h3></div><p class="muted">Замечания анализа не попадают в реестр автоматически. Подтвердите или отклоните каждое.</p>${pending.map(x=>`<article class="risk-card"><div class="row">${badge(labels[x.finding.severity],x.finding.severity)}${badge(x.finding.rule)}</div><h3>${esc(x.finding.title)}</h3><p>${esc(x.finding.description)}</p>${sources(x.finding.sources)}<div class="row">${btn('В реестр рисков','finding-risk',x.index,'compact-action')}${btn('Отклонить','dismiss-candidate',x.index,'quiet compact-action')}</div></article>`).join('')}<hr class="separator"></section>`:''}<div class="row between"><h2>Реестр рисков</h2>${btn('+ Риск','new-risk','','compact-action')}</div><p class="muted">Постоянные записи по договору. Новая редакция не закрывает их автоматически.</p>${c.risks.map(r=>`<article class="risk-card"><div class="row">${badge(labels[r.severity],r.severity)}${badge(r.status)}</div><h3>${esc(r.title)}</h3><p>${esc(r.detail)}</p><div>${r.sources?.length?r.sources.map((s,i)=>btn(esc('v'+s.revisionNumber+' · '+sourceLabel(s)),'risk-source',JSON.stringify([r.id,i]),'source-link')).join(''):'<small class="muted">Пункт не указан: риск заведён вручную или основание не сохранилось.</small>'}</div><div class="row"><small class="muted">Ответственный: ${esc(r.owner)}</small>${riskSignals(r)}${btn('Открыть','risk',r.id,'quiet compact-action')}</div></article>`).join('')||`<p>Риски пока не зарегистрированы. ${pending.length?'Выше — кандидаты последнего анализа.':'Добавьте вручную или из замечания анализа.'}</p>`}${dismissed.length?`<details><summary>Отклонённые кандидаты · ${dismissed.length}</summary>${dismissed.map(d=>`<article class="history-row"><small>${date(d.created)} · ${esc(d.rule)}</small><strong>${esc(d.title)}</strong><p class="muted">${esc(d.reason)}</p>${btn('Вернуть в кандидаты','restore-candidate',d.key,'quiet compact-action')}</article>`).join('')}</details>`:''}</div>`;
}
function runCost(stageResult,title){
  const e=stageResult?.execution;if(!e)return '';
  const size=e.promptChars?Math.round(e.promptChars/1000)+' тыс. знаков':'размер не сохранён';
  const time=e.durationMs?(e.durationMs<1000?e.durationMs+' мс':Math.round(e.durationMs/1000)+' с'):'время не сохранено';
  const tokens=e.usage?`токены ${e.usage.input_tokens??'—'} → ${e.usage.output_tokens??'—'}`:'расход не сообщён';
  return `<small class="muted">${title}: ${size} · ${time} · ${tokens}</small>`;
}
const changedRules=a=>(state.boot.rules||[]).filter(rule=>{const used=a.rules?.find(x=>x.id===rule.id);return used&&used.version!==rule.version;}).map(r=>r.id);
function historyView(){return `<div class="flow"><h2>История договора</h2>${state.contract.analyses.map(a=>`<article class="history-row"><small>${date(a.created)} · v${state.contract.revisions.find(r=>r.id===a.revision_id)?.number}</small><p>${esc(labels[a.status])}</p>${runCost(a.primary_result,'Аналитик')}${runCost(a.review_result,'Ревьюер')}${changedRules(a).length?`<p class="warning">После этого запуска изменились критерии: ${esc(changedRules(a).join(', '))}. Результат относится к прежней версии правил.</p>`:''}${btn('Открыть результат','run',a.id,'quiet compact-action')}</article>`).join('')}<h3>Журнал действий</h3>${state.contract.history.map(e=>`<article class="history-row"><small>${date(e.created)}</small><strong>${esc(e.action)}</strong><details><summary>Основание</summary><p>${esc(e.detail||'—')}</p></details></article>`).join('')}</div>`;}
function render() {
  if(!state.user){state.drawerOpen=false;document.body.classList.remove('source-modal-open','drawer-open');state.drafts.clear();quick.reset();organizations.reset();$('#app').innerHTML=loginView();return;}
  if(!state.boot)return;
  const openMenus=[...document.querySelectorAll('details[data-menu][open]')].map(el=>el.dataset.menu);
  const focused=document.activeElement,focusMenu=focused?.matches('details[data-menu]>summary')?focused.parentElement.dataset.menu:null;
  const focusAction=focused?.closest('.control-menu,#catalog-drawer')&&focused?.dataset.action?{action:focused.dataset.action,value:focused.dataset.value}:null;
  document.querySelectorAll('[data-finding-key]').forEach(el=>el.open?state.openFindings.add(el.dataset.findingKey):state.openFindings.delete(el.dataset.findingKey));
  const oldResult=$('.analysis-result'),oldKey=oldResult?.dataset.resultKey,oldScroll=oldResult?.closest('.content')?.scrollTop;
  const c=state.center==='organizations'?null:state.contract,showInspector=Boolean(c&&!state.form&&state.inspectorOpen&&!['settings','rules','organizations'].includes(state.center));
  $('#app').innerHTML=`${topbar()}<div class="workspace">${sidebar()}<main id="main" class="main ${state.center==='quick'?'quick-main':''}">${c?context():`<header class="context"><h1>${state.center==='settings'?'Настройки':state.center==='organizations'?'Мои организации':'Договоры и шаблоны'}</h1></header>`}<div class="panels ${showInspector?'has-inspector':'single-panel'} ${state.inspectorWide?'wide-inspector':''}"><section class="panel">${state.center==='organizations'?'':sectionTabs()}<div class="content">${centerView()}</div></section><aside class="panel inspector ${showInspector?'':'hidden'}" aria-label="${c?esc(companionTitle()):'Источник'}"><div class="tabs row between"><span>${c?esc(companionTitle()):'Источник'}</span><div class="row">${btn(state.inspectorWide?'Уже':'Шире','source-width','','quiet compact-action inspector-size')}${btn('Закрыть','source-close','','quiet compact-action')}</div></div><div class="content">${c?companionView():'<div class="empty"><h3>От условий к решениям</h3><p>Здесь появятся замечания, предложенные формулировки и риски выбранного договора.</p></div>'}</div></aside></div></main></div><footer class="footer">Пилот 0.3.2 · оригиналы и история хранятся на сервере · AI-выводы требуют проверки сотрудником</footer>`;
  if(state.center==='quick'&&!state.form){$('#main').innerHTML=quick.view();$('.footer').textContent='Разовая проверка: без записи в хранилище · результат требует проверки сотрудником';}
  $('.workspace').insertAdjacentHTML('afterbegin','<div class="drawer-backdrop" data-action="nav-close" aria-hidden="true"></div>');
  for(const name of openMenus){const menu=document.querySelector(`details[data-menu="${name}"]`);if(menu)menu.open=true;}
  syncMenus();
  document.querySelectorAll('[data-finding-key]').forEach(el=>{el.open=state.openFindings.has(el.dataset.findingKey);});
  syncSourceOverlay();
  if(focusMenu)document.querySelector(`details[data-menu="${focusMenu}"]>summary`)?.focus({preventScroll:true});
  else if(focusAction)[...document.querySelectorAll('[data-action]')].find(el=>el.dataset.action===focusAction.action&&el.dataset.value===focusAction.value)?.focus({preventScroll:true});
  if(focusSource){focusSource=false;requestAnimationFrame(()=>$('.inspector:not(.hidden) [data-action$="source-close"]')?.focus({preventScroll:true}));}
  if(restoreSourceFocus){restoreSourceFocus=false;requestAnimationFrame(()=>[...document.querySelectorAll('[data-action]')].find(el=>el.dataset.action===sourceReturn?.action&&el.dataset.value===sourceReturn?.value)?.focus({preventScroll:true}));}
  const newResult=$('.analysis-result');
  if(oldKey&&newResult?.dataset.resultKey===oldKey)newResult.closest('.content').scrollTop=oldScroll;
  if(state.source?.blockId)requestAnimationFrame(()=>$('#source-'+state.source.blockId)?.scrollIntoView({block:'nearest'}));
  // A panel that opens below the fold reads as a button that did nothing.
  if(focusSummary){focusSummary=false;requestAnimationFrame(()=>{$('.summary-panel')?.scrollIntoView({block:'nearest'});const area=$('#summary-text');if(area){area.focus({preventScroll:true});area.select();}});}
}
function syncSourceOverlay(){
  const panel=$('.inspector:not(.hidden)'),modal=Boolean(panel&&matchMedia('(max-width:1000px)').matches);
  if(modal||!matchMedia('(max-width:900px)').matches)state.drawerOpen=false;
  const drawerOpen=state.drawerOpen,drawer=$('#catalog-drawer');
  document.body.classList.toggle('source-modal-open',modal);
  document.body.classList.toggle('drawer-open',drawerOpen);
  if(drawer){drawer.classList.toggle('is-open',drawerOpen);drawer.setAttribute('role',drawerOpen?'dialog':'complementary');if(drawerOpen)drawer.setAttribute('aria-modal','true');else drawer.removeAttribute('aria-modal');drawer.inert=modal;}
  $('[data-action=nav-toggle]')?.setAttribute('aria-expanded',String(drawerOpen));
  document.querySelectorAll('.topbar,.footer').forEach(el=>{el.inert=modal||drawerOpen;});
  if($('#main'))$('#main').inert=drawerOpen;
  document.querySelectorAll('#main>.context,#main>.quick-privacy,#main>.panels>section.panel').forEach(el=>{el.inert=modal;});
  if(panel){panel.setAttribute('role',modal?'dialog':'complementary');if(modal)panel.setAttribute('aria-modal','true');else panel.removeAttribute('aria-modal');}
}
function setDrawer(open,restore=true){
  state.drawerOpen=open;syncSourceOverlay();
  if(open)$('#catalog-drawer [data-action=nav-close]')?.focus({preventScroll:true});
  else if(restore)$('[data-action=nav-toggle]')?.focus({preventScroll:true});
}
function desktopSections(menu){return menu.classList.contains('sections-menu')&&matchMedia('(min-width:621px)').matches;}
function syncMenus(){
  document.querySelectorAll('details[data-menu]').forEach(menu=>{if(desktopSections(menu))menu.open=true;menu.querySelector(':scope>summary').setAttribute('aria-expanded',String(menu.open));});
}
function closeMenus(){document.querySelectorAll('details[data-menu][open]').forEach(menu=>{if(!desktopSections(menu)){menu.open=false;menu.querySelector(':scope>summary').setAttribute('aria-expanded','false');}});}
document.addEventListener('toggle',event=>{if(event.target.matches?.('details[data-menu]'))event.target.querySelector(':scope>summary')?.setAttribute('aria-expanded',String(event.target.open));},true);
document.addEventListener('click',event=>{document.querySelectorAll('details[data-menu][open]').forEach(menu=>{if(!desktopSections(menu)&&!menu.contains(event.target)){menu.open=false;menu.querySelector(':scope>summary').setAttribute('aria-expanded','false');}});});
matchMedia('(max-width:900px)').addEventListener('change',syncSourceOverlay);
matchMedia('(max-width:620px)').addEventListener('change',()=>{document.querySelectorAll('.sections-menu').forEach(menu=>{menu.open=desktopSections(menu);});syncMenus();});
matchMedia('(max-width:1000px)').addEventListener('change',syncSourceOverlay);
document.addEventListener('keydown',event=>{
  let activeMenu=document.activeElement?.closest('details[data-menu]');
  while(activeMenu&&!activeMenu.open)activeMenu=activeMenu.parentElement?.closest('details[data-menu]');
  if(event.key==='Escape'&&activeMenu?.open&&!desktopSections(activeMenu)){event.preventDefault();activeMenu.open=false;activeMenu.querySelector(':scope>summary').setAttribute('aria-expanded','false');activeMenu.querySelector(':scope>summary').focus();return;}
  if(state.drawerOpen){
    if(event.key==='Escape'){event.preventDefault();setDrawer(false);return;}
    if(event.key==='Tab'){
      const items=[...$('#catalog-drawer').querySelectorAll('button:not(:disabled),a[href],input,select,summary')].filter(el=>el.getClientRects().length),first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
    return;
  }
  const panel=$('.inspector:not(.hidden)');if(!panel)return;
  if(event.key==='Escape'){event.preventDefault();panel.querySelector('[data-action$="source-close"]')?.click();return;}
  if(event.key==='Tab'&&panel.getAttribute('aria-modal')==='true'){
    const focusable=[...panel.querySelectorAll('button:not(:disabled),a[href],select,textarea,input,summary')].filter(el=>el.getClientRects().length),first=focusable[0],last=focusable.at(-1);
    if(!panel.contains(document.activeElement)){event.preventDefault();first?.focus();}
    else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
});
async function uploadRow(row,contractId) {
  row.status='uploading';row.message='Загрузка…';if(state.contractId===contractId)render();
  try{
    const payload=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',`/docs/api/contracts/${contractId}/files`);xhr.setRequestHeader('X-Docs-Request','1');xhr.setRequestHeader('X-File-Name',encodeURIComponent(row.file.name));xhr.timeout=120000;xhr.upload.onprogress=e=>{if(e.lengthComputable){row.progress=Math.round(e.loaded/e.total*100);row.message=row.progress===100?'Проверяем и извлекаем текст…':`Загрузка ${row.progress}%`;if(state.contractId===contractId)render();}};xhr.onload=()=>{try{const data=JSON.parse(xhr.responseText);xhr.status<300?resolve(data):reject(new Error(data.error));}catch{reject(new Error('Не удалось прочитать ответ сервера.'));}};xhr.onerror=()=>reject(new Error('Нет соединения. Повторите загрузку.'));xhr.ontimeout=()=>reject(new Error('Сервер не ответил. Повтор безопасен: точный дубль не создаст копию.'));xhr.send(row.file);});
    row.status='done';row.savedId=payload.file.id;row.similar=payload.similar;row.message=payload.duplicate?'Точный дубль · оригинал уже сохранён':payload.file.status==='ready'?'Загружен · включите в пакет':'Оригинал сохранён · текст не извлечён';
    if(!payload.duplicate&&!payload.similar?.length){if(!state.selections.has(contractId))state.selections.set(contractId,new Set());state.selections.get(contractId).add(payload.file.id);}
    if(state.contractId===contractId)await refreshContract();
  }catch(e){row.status='error';row.message=e.message;}
  if(state.contractId===contractId)render();
}
async function loadSummary(analysisId,full){
  const response=await fetch(`/docs/api/analyses/${analysisId}/summary?scope=${full?'full':'short'}`,{headers:{'X-Docs-Request':'1'}});
  if(!response.ok){let message='Не удалось собрать текст замечаний.';try{message=(await response.json()).error||message;}catch{ /* Plain error body */ }throw new Error(message);}
  state.summary={analysisId,full,text:await response.text()};
}
async function addFiles(files){const contractId=state.contractId;if(!contractId){notice('Сначала создайте или выберите договор.');return;}chosen();const rows=Array.from(files).map(file=>({file,status:'selected',message:'Ожидает загрузки'}));const existing=state.queues.get(contractId)||[];state.queues.set(contractId,[...existing,...rows]);render();for(const row of rows)await uploadRow(row,contractId);}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action,value=button.dataset.value;
  if(action==='nav-toggle'||action==='catalog-back'){closeMenus();setDrawer(!state.drawerOpen);return;}
  if(action==='nav-close'){setDrawer(false);return;}
  closeMenus();
  if(state.drawerOpen&&!['kind'].includes(action))setDrawer(false,false);
  button.disabled=true;
  if(['source','risk-source','quick-source'].includes(action)){sourceReturn={action,value};focusSource=true;}
  if(['source-close','quick-source-close'].includes(action))restoreSourceFocus=true;
  try{
    if(action==='quick-open'){state.center='quick';state.form=null;await quick.open();history.replaceState(null,'','#quick');render();return;}
    if(action==='stored'){state.center=state.contract?'passport':'set';history.replaceState(null,'',state.contractId?'#'+state.contractId:location.pathname);render();return;}
    if(action==='from-quick'){state.center='set';state.kind='contract';state.form=state.boot.customers.length?{type:'contract'}:{type:'customer'};history.replaceState(null,'',location.pathname);notice('Для постоянного учёта загрузите те же файлы в договор: оригиналы разовой проверки уже удалены.');render();return;}
    if(action.startsWith('quick-')){await quick.action(action,value,button);return;}
    if(action==='show-password'){const input=$('input[name=password]');input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'Показать пароль':'Скрыть пароль';button.disabled=false;return;}
    if(action==='auth-focus'){const input=$('[data-form=auth] [name=login]');input?.focus();input?.scrollIntoView({block:'center'});return;}
    if(action==='auth-mode'){state.loginMode=value;render();return;}
    if(action==='logout'){await api('/logout',{});state.sourceDocuments=null;state.user=null;state.boot=null;state.contract=null;state.queues.clear();state.selections.clear();render();return;}
    if(action==='open-contract'){await openContract(value);return;}
    if(action==='kind'){state.kind=value;state.customer='';}
    if(action==='tab'){state.inspectorOpen=value==='document'&&matchMedia('(min-width:1001px)').matches;if(value==='document'&&state.center!=='analysis'){state.sourceDocuments=null;state.source=null;}state.center=value;state.form=null;}
    if(action==='settings'){state.inspectorOpen=false;state.center='settings';state.form=null;state.boot.codex=await api('/codex');}
    if(action==='rules'){state.inspectorOpen=false;state.center='rules';state.form=null;}
    if(action==='new-customer')state.form={type:'customer'};
    if(action==='new-contract'&&!Object.keys(state.boot.profiles).length){organizations.open();state.form={type:'organization'};state.center='organizations';notice('Сначала создайте карточку своей организации.');render();return;}
    if(action==='new-contract'){if(state.kind==='contract'&&!state.boot.customers.length){state.form={type:'customer'};notice('Сначала создайте заказчика.');}else state.form={type:'contract'};}
    if(action==='organizations'){state.form=organizations.data?{type:'organization'}:null;state.center='organizations';}
    if(action==='new-organization'||action==='edit-organization'){if(organizations.busy){notice('Сначала завершите или отмените поиск.');button.disabled=false;return;}organizations.open(action==='edit-organization'?state.boot.organizations.find(o=>o.id===value):{});state.center='organizations';state.form={type:'organization'};}
    if(action==='organization-lookup'){await organizations.lookup();return;}
    if(action==='organization-cancel-lookup'){await organizations.cancel();}
    if(action==='cancel-organization'){await organizations.cancel();organizations.reset();state.form=null;state.center='organizations';}
    if(action==='change-contractor'){state.form={type:'contractor'};state.center='passport';}
    if(action==='cancel-form')state.form=null;
    if(action==='pick-files'){$('#file-picker').click();button.disabled=false;return;}
    if(action==='remove-queue'){queue().splice(Number(value),1);}
    if(action==='retry-upload'){await uploadRow(queue()[Number(value)],state.contractId);return;}
    if(action==='retry-extract'){await api('/files/'+value+'/retry',{});await refreshContract();}
    if(action==='file'){state.inspectorOpen=false;state.sourceDocuments=null;state.source={fileId:value};state.center='document';state.form=null;}
    if(action==='source'){state.inspectorOpen=true;state.source=JSON.parse(value);state.sourceDocuments=state.source.analysisId?(await api('/analyses/'+state.source.analysisId+'/documents')).map(f=>({...f,extraction:f})):null;state.form=null;}
    if(action==='refresh-structure'){if(!confirm('Повторно прочитать структуру оригинала? Старые анализы и их ссылки не изменятся. Для новых выводов запустите новый анализ.')){button.disabled=false;return;}await api('/files/'+value+'/structure',{});await refreshContract();notice('Структура обновлена. Старые результаты не изменены.');}
    if(action==='risk-source'){state.inspectorOpen=true;const [riskId,index]=JSON.parse(value),ref=state.contract.risks.find(r=>r.id===riskId).sources[index];state.source={...ref,riskId};state.sourceDocuments=[{id:ref.fileId,name:ref.fileName,extraction:{blocks:[ref.block],warnings:[]}}];state.form=null;}
    if(action==='revision'){state.source=null;state.sourceDocuments=null;state.revisionId=value;state.runId=null;state.selections.delete(state.contractId);state.center='passport';}
    if(action==='compare'){state.inspectorOpen=false;state.center='compare';state.form=null;}
    if(action==='source-close'){state.inspectorOpen=false;}
    if(action==='source-width')state.inspectorWide=!state.inspectorWide;
    if(action==='finding-filter')state.findingFilter=value;
    if(action==='compare-filter')state.compareOnlyChanged=state.compareOnlyChanged===false;
    if(action==='effective')state.form={type:'effective',id:value};
    if(action==='stage')state.form={type:'stage'};
    if(action==='analyze'){const started=await api('/contracts/'+state.contractId+'/analyses',{revision_id:state.revisionId});state.source=null;state.sourceDocuments=null;state.runId=null;state.center='analysis';await refreshContract();notice(started.note?'Пакет в очереди. '+started.note:'Пакет поставлен в очередь анализа.');}
    if(action==='retry-analysis'){await api('/analyses/'+value+'/retry',{});await refreshContract();state.source=null;state.sourceDocuments=null;state.runId=state.contract.analyses[0].id;state.center='analysis';notice('Создана новая попытка. История сохранена.');}
    if(action==='cancel-analysis'){await api('/analyses/'+value+'/cancel',{});await refreshContract();}
    if(action==='run'){state.source=null;state.sourceDocuments=null;state.runId=value;state.center='analysis';}
    if(action==='summary-open'){await loadSummary(analysis().id,false);focusSummary=true;}
    if(action==='summary-scope'){await loadSummary(state.summary.analysisId,!state.summary.full);focusSummary=true;}
    if(action==='summary-close')state.summary=null;
    if(action==='summary-copy'){
      const text=value===''?state.summary.text:messageParts(state.summary.text)[Number(value)];
      try{await navigator.clipboard.writeText(text);notice('Текст скопирован в буфер обмена.');}
      catch{const area=$('#summary-text');if(area){area.focus();area.select();}notice('Копирование в буфер недоступно: скопируйте выделенный текст сочетанием клавиш.');}
      button.disabled=false;return;
    }
    if(action==='summary-mail'){
      if(!state.contract.manager){state.form={type:'manager'};render();return;}
      const body=state.summary.text.slice(0,1800);
      window.location.href=`mailto:${encodeURIComponent(state.contract.manager)}?subject=${encodeURIComponent('Замечания по договору: '+state.contract.title)}&body=${encodeURIComponent(body)}`;
      if(body.length<state.summary.text.length)notice('В письмо вставлено начало текста: длинное тело письма почтовый клиент обрезает. Полный текст — кнопкой «Скопировать».');
      button.disabled=false;return;
    }
    if(action==='propose'){
      const run=analysis(),finding=result().findings[Number(value)],key=run.id+':'+finding.id;
      notice('Готовим формулировку по одному пункту…');
      const answer=await api('/analyses/'+run.id+'/proposal',{finding_id:finding.id});
      const saved=state.drafts.get(key)||state.contract.recommendations.find(x=>x.analysis_id===run.id&&x.finding_id===finding.id);
      state.drafts.set(key,{text:answer.proposal,status:saved?.status||'draft'});
      notice(answer.note?'Формулировка предложена. '+answer.note:'Формулировка предложена. Проверьте текст и сохраните решение.');
    }
    if(action==='new-risk'){state.form={type:'risk'};state.center='risks';}
    if(action==='dismiss-candidate'){state.form={type:'dismiss',index:Number(value)};state.center='risks';}
    if(action==='restore-candidate'){await api('/contracts/'+state.contractId+'/dismissed',{key:value,restore:true});await refreshContract();}
    if(action==='finding-risk'){state.form={type:'risk',finding:result().findings[Number(value)],analysis:analysis().id};state.center='risks';}
    if(action==='risk'){state.risk=value;state.form=null;}
    if(action==='all-risks'){state.risk=null;state.form=null;}
    if(action==='risk-event')state.form={type:'risk-event',kind:value};
    if(action==='risk-status')state.form={type:'risk-status'};
    if(action==='event-status')state.form={type:'event-status',id:value};
    if(action==='codex-login'){state.boot.codex=await api('/codex/login',{});notice('Начат общий вход в Codex. Дождитесь одноразового кода.');}
    if(action==='codex-logout'){
      if(!confirm('Отключить Codex для всего приложения? Текущие анализы и очередь всех пользователей будут отменены. Сохранённые результаты останутся.')){button.disabled=false;return;}
      await api('/codex/logout',{confirm:'disconnect-application'});state.boot.codex=await api('/codex');await refreshContract();notice('Общий Codex отключён. Очередь отменена, результаты сохранены.');
    }
    render();
  }catch(e){button.disabled=false;notice(e.message);}
});
document.addEventListener('submit',async event=>{
  const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();const data=Object.fromEntries(new FormData(form));const submit=event.submitter||form.querySelector('[type=submit]')||form.querySelector('button.primary');if(submit)submit.disabled=true;
  try{
    const type=form.dataset.form;
    if(type==='auth'){state.user=await api('/'+state.loginMode,data);await refreshBoot();state.contractId=null;state.contract=null;state.form=null;const fromHash=location.hash.slice(1);if(fromHash==='quick'){state.center='quick';await quick.open();render();}else if(state.boot.contracts.some(c=>c.id===fromHash))await openContract(fromHash);else render();return;}
    if(type==='password'){await api('/me',data,'PATCH');state.user=null;render();notice('Пароль изменён. Войдите снова.');return;}
    if(type==='organization'){if(organizations.busy)throw new Error('Дождитесь или отмените поиск.');const draft=organizations.data;const org=await api('/organizations'+(draft.id?'/'+draft.id:''),{...data,version:draft.version,lookupId:organizations.lookupId},draft.id?'PATCH':'POST');organizations.reset();state.form=null;state.center='organizations';await refreshBoot();render();notice('Организация сохранена. Можно выбрать её в договоре или разовой проверке.');return;}
    if(type==='contractor'){await api('/contracts/'+state.contractId,data,'PATCH');await refreshBoot();}
    if(type==='customer'){const value=await api('/customers',data);state.customer=value.id;await refreshBoot();state.form={type:'contract'};render();return;}
    if(type==='contract'){const value=await api('/contracts',{...data,kind:state.kind});await refreshBoot();await openContract(value.id);return;}
    if(type==='revision'){const value=await api('/contracts/'+state.contractId+'/revisions',{...data,file_ids:[...chosen()]});await refreshContract();await refreshBoot();state.revisionId=value.id;state.runId=null;state.center='set';state.queues.set(state.contractId,[]);if(event.submitter?.value==='analyze'){try{await api('/contracts/'+state.contractId+'/analyses',{revision_id:value.id});state.center='analysis';state.inspectorOpen=false;notice('Редакция v'+value.number+' создана и поставлена в очередь.');}catch(e){notice('Редакция v'+value.number+' создана. Анализ не запущен: '+e.message);}}else notice('Редакция v'+value.number+' создана. Теперь можно запустить анализ.');}
    if(type==='effective')await api('/contracts/'+state.contractId+'/effective',{revision_id:state.form.id,reason:data.reason});
    if(type==='stage')await api('/contracts/'+state.contractId,data,'PATCH');
    if(type==='manager'){await api('/contracts/'+state.contractId,{manager:data.manager},'PATCH');notice('Ответственный сохранён.');}
    if(type==='recommendation'){const a=analysis(),f=result().findings[Number(form.dataset.index)];await api('/analyses/'+a.id+'/recommendation',{...data,finding_id:f.id});state.drafts.delete(form.dataset.draftKey);notice('Решение сохранено. Статус риска не изменён.');}
    if(type==='risk'){const value=await api('/contracts/'+state.contractId+'/risks',{...data,origin:state.form.analysis?state.form.analysis+':'+state.form.finding.id:'',source:data.source?JSON.parse(data.source):null});state.risk=value.id;}
    if(type==='dismiss'){const item=result().findings[state.form.index];await api('/contracts/'+state.contractId+'/dismissed',{key:findingKey(item),rule:item.rule,title:item.title,reason:data.reason});notice('Кандидат отклонён. Замечание осталось в анализе.');}
    if(type==='risk-event')await api('/risks/'+state.risk+'/events',data);
    if(type==='risk-status')await api('/risks/'+state.risk,data,'PATCH');
    if(type==='event-status')await api('/risk-events/'+state.form.id,data,'PATCH');
    state.form=null;await refreshContract();render();
  }catch(e){form.querySelector('.error').textContent=e.message;if(form.dataset.form==='organization'){form.querySelector('.error').focus();}if(submit)submit.disabled=false;}
});
document.addEventListener('input',event=>{if(event.target.closest('[data-form=organization]')&&event.target.name){organizations.data[event.target.name]=event.target.value;if(event.target.name==='inn'&&!organizations.busy)organizations.lookupId=null;}});
document.addEventListener('change',async event=>{
  const el=event.target;
  if(el.id==='quick-contractor'){quick.profile=el.value;return;}
  if(el.id==='quick-file-picker'){await quick.upload(el.files);return;}
  if(el.id==='file-picker'){await addFiles(el.files);return;}
  if(el.id==='customer-filter')state.customer=el.value;
  if(el.id==='revision-select'){state.source=null;state.sourceDocuments=null;state.revisionId=el.value||null;state.runId=null;state.selections.delete(state.contractId);}
  if(el.id==='document-select')state.source={fileId:el.value};
  if(el.id==='compare-left')state.compareLeft=el.value;
  if(el.id==='compare-right')state.compareRight=el.value;
  if(el.dataset.fileChoice){el.checked?chosen().add(el.dataset.fileChoice):chosen().delete(el.dataset.fileChoice);}
  if(el.dataset.queueChoice!==undefined){const row=queue()[Number(el.dataset.queueChoice)];row.decision=el.value;if(el.value){chosen().add(row.savedId);if(el.value!=='separate')chosen().delete(el.value);}else chosen().delete(row.savedId);}
  if(el.id||el.dataset.fileChoice||el.dataset.queueChoice!==undefined)render();
});
function rememberRecommendation(event){
  const form=event.target.closest('form[data-draft-key]');
  if(form)state.drafts.set(form.dataset.draftKey,Object.fromEntries(new FormData(form)));
}
document.addEventListener('input',rememberRecommendation,true);
document.addEventListener('change',rememberRecommendation,true);
document.addEventListener('input',event=>{if(event.target.id==='search'){state.query=event.target.value;const pos=event.target.selectionStart;render();$('#search').focus();$('#search').setSelectionRange(pos,pos);}});
document.addEventListener('dragover',event=>{if(event.target.closest('#quick-dropzone')){event.preventDefault();$('#quick-dropzone').classList.add('over');}});
document.addEventListener('dragleave',event=>{if(event.target.closest('#quick-dropzone'))$('#quick-dropzone')?.classList.remove('over');});
document.addEventListener('drop',event=>{if(event.target.closest('#quick-dropzone')){event.preventDefault();void quick.upload(event.dataTransfer.files);}});
document.addEventListener('dragover',event=>{if(event.target.closest('#dropzone')){event.preventDefault();$('#dropzone').classList.add('over');}});
document.addEventListener('dragleave',event=>{if(event.target.closest('#dropzone'))$('#dropzone')?.classList.remove('over');});
document.addEventListener('drop',async event=>{if(event.target.closest('#dropzone')){event.preventDefault();await addFiles(event.dataTransfer.files);}});
setInterval(async()=>{
  if(!state.user||!state.boot)return;
  try{
    if(state.center==='quick'&&!quick.batch){const before=JSON.stringify(quick.packet);await quick.refresh();if(before!==JSON.stringify(quick.packet))render();}
    const connection=await api('/codex');
    if(JSON.stringify(connection)!==JSON.stringify(state.boot.codex)&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){state.boot.codex=connection;render();}
    if(state.contract?.analyses.some(a=>['queued','primary','review'].includes(a.status))&&!state.form&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){await refreshContract();render();}
  }catch{ /* Keep last confirmed data. Explicit actions surface errors. */ }
},4000);
try{state.user=await api('/me');await refreshBoot();const fromHash=location.hash.slice(1);if(fromHash==='quick'){state.center='quick';await quick.open();render();}else if(state.boot.contracts.some(c=>c.id===fromHash))await openContract(fromHash);else render();}catch{render();}
