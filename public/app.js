import { QuickUI } from './quick.js';
import { sourceLabel, documentText, compactPassport, locationLabel, findingKey, severityLabels, coverageLabels, stageLabels } from './document-ui.js';
import { messageParts } from './summary.js';
const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { user:null, boot:null, contract:null, contractId:null, revisionId:null, runId:null, center:'upload', right:'analysis', kind:'contract', customer:'', queues:new Map(), selections:new Map(), source:null, risk:null, form:null, loginMode:'login', query:'', drafts:new Map(), analysisReturn:'passport', summary:null };
const labels = { ...stageLabels,...severityLabels,ready:'Текст извлечён',processing:'Обработка',extracted:'Из документа',missing:'Не найдено',uncertain:'Нужно уточнить',open:'Открыто',verification:'На проверке',done:'Выполнено',unverified:'Сигнал · не проверен',confirmed:'Подтверждено',dismissed:'Не подтвердилось',recorded:'Зафиксировано' };
const btn = (title, action, value='', cls='', disabled=false) => `<button type="button" data-action="${action}" data-value="${esc(value)}" class="${cls}" ${disabled?'disabled':''}>${title}</button>`;
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
let noticeTimer, focusSummary=false;
function notice(text) { $('#notice').textContent=text;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').textContent='',7000); }
async function refreshBoot() { state.boot=await api('/bootstrap'); }
async function refreshContract() { if(state.contractId){state.contract=await api('/contracts/'+state.contractId); if(!state.contract.revisions.some(r=>r.id===state.revisionId))state.revisionId=state.contract.revisions[0]?.id||null;} }
async function openContract(id) { state.sourceDocuments=null;state.analysisReturn='passport';state.summary=null;state.contractId=id;state.revisionId=null;state.runId=null;state.source=null;state.risk=null;state.form=null;await refreshContract();state.center=state.contract.revisions.length?'passport':'upload';history.replaceState(null,'','#'+id);render(); }
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
const quick = new QuickUI({api,esc,btn,badge,date,notice,render,getBoot:()=>state.boot});
function loginView() {
  const register=state.loginMode==='register';
  return `<div class="login-page"><section class="login-story"><div class="brand"><span class="mark" aria-hidden="true">Д</span>Договоры и риски</div><h1>Всё важное<br>в договоре.</h1><p>Условия, редакции и риски — в одном рабочем пространстве.</p><div class="steps"><div>01 &nbsp; Загрузите договор и приложения</div><div>02 &nbsp; Получите анализ и независимое ревью</div><div>03 &nbsp; Согласуйте правки и отслеживайте риски</div></div><small>Внутренний инструмент · первая рабочая версия</small></section><main class="login-box" id="main"><form class="form" data-form="auth"><div><h2>${register?'Создать аккаунт':'Вход в рабочее место'}</h2><p class="muted">${register?'Придумайте логин и пароль.':'Используйте свой логин и пароль.'}</p></div>${field('login','Логин','','text','required minlength="3" maxlength="64" autocomplete="username"')}${field('password','Пароль','','password',`required maxlength="256" autocomplete="${register?'new-password':'current-password'}" ${register?'minlength="10"':''}`)}${btn('Показать пароль','show-password','','quiet')}<div class="error" role="alert"></div><button class="primary" type="submit">${register?'Создать аккаунт':'Войти'}</button>${btn(register?'Уже есть аккаунт? Войти':'Создать аккаунт', 'auth-mode',register?'login':'register','quiet')}<p class="login-note">${register?'Минимум 10 символов в пароле. Почта и телефон не нужны. Новый аккаунт не получает доступ к чужим договорам.':'Забыли пароль? Обратитесь к администратору сервера.'}</p></form></main></div>`;
}
function sidebar() {
  if(state.center==='quick')return `<aside class="sidebar">${btn('Разовая проверка','quick-open','','primary')}${btn('К хранилищу договоров','stored','','quiet')}<p class="muted">Загрузите пакет и получите рекомендации. Заказчик, карточка и редакции не нужны.</p><div class="sidebar-foot">Один временный пакет на пользователя. Без истории и постоянного реестра рисков.</div></aside>`;
  const list=state.boot.contracts.filter(c=>c.kind===state.kind&&(!state.customer||c.customer_id===state.customer)&&c.title.toLowerCase().includes(state.query.toLowerCase()));
  return `<aside class="sidebar">${btn('Разовая проверка','quick-open','','primary')}<div class="nav">${btn('Договоры','kind','contract',state.kind==='contract'?'active':'')}${btn('Шаблоны','kind','template',state.kind==='template'?'active':'')}</div><label class="sr-only" for="search">Поиск по названию</label><input id="search" placeholder="Найти договор…" value="${esc(state.query)}"><label>Заказчик<select id="customer-filter"><option value="">Все заказчики</option>${state.boot.customers.map(c=>`<option value="${c.id}" ${state.customer===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><div class="row">${btn('+ '+(state.kind==='template'?'Шаблон':'Договор'),'new-contract','','grow')}${btn('+ Заказчик','new-customer','','compact-action')}</div><nav class="catalog" aria-label="Договоры">${list.length?list.map(c=>`<button type="button" data-action="open-contract" data-value="${c.id}" class="${state.contractId===c.id?'active':''}"><strong>${esc(c.title)}</strong><small>${esc(c.stage)} · ${c.revision_count} ред.</small></button>`).join(''):'<p class="muted">Здесь появятся ваши документы.</p>'}</nav><div class="sidebar-foot">Москва · два профиля подрядчиков<br>${btn('Критерии проверки','rules','','quiet')}</div></aside>`;
}
function context() {
  const c=state.contract,customer=state.boot.customers.find(x=>x.id===c.customer_id);
  return `<header class="context"><div class="grow"><p>${esc(customer?.name||'Библиотека шаблонов')}</p><h1>${esc(c.title)}</h1></div><div class="row"><label class="sr-only" for="revision-select">Редакция</label><select id="revision-select"><option value="">Без редакции</option>${c.revisions.map(r=>`<option value="${r.id}" ${r.id===state.revisionId?'selected':''}>v${r.number}${c.effective_id===r.id?' · действует':''}</option>`).join('')}</select>${btn('Анализировать','analyze','','primary',!state.revisionId||c.analyses.some(a=>a.revision_id===state.revisionId&&['queued','primary','review'].includes(a.status)))}</div></header>`;
}
function uploadView() {
  const c=state.contract,q=queue(), selected=chosen(); const blocked=q.some(x=>x.status==='uploading'||x.status==='selected'||(x.similar?.length&&!x.decision));
  return `<div class="flow"><div id="dropzone" class="dropzone"><strong>Перетащите документы сюда</strong><p class="muted">PDF, DOC, DOCX · несколько сразу · до 20 МБ на файл</p>${btn('Выбрать файлы','pick-files','','primary')}<input class="hidden" id="file-picker" type="file" accept=".pdf,.doc,.docx" multiple></div>${q.length?`<div class="section-title"><h3>Очередь загрузки · ${q.length}</h3></div>${q.map((row,i)=>`<div class="queue-row"><span class="file-type">${esc(row.file.name.split('.').pop().toUpperCase())}</span><div><strong>${esc(row.file.name)}</strong><div><small>${esc(row.message||'Ожидает загрузки')}</small></div>${row.status==='uploading'?`<progress max="100" value="${row.progress||0}"></progress>`:''}${row.similar?.length?`<select data-queue-choice="${i}" aria-label="Решение по похожему файлу"><option value="">Похожий текст — выберите действие</option><option value="separate" ${row.decision==='separate'?'selected':''}>Сохранить отдельным документом</option>${row.similar.map(s=>`<option value="${s.id}" ${row.decision===s.id?'selected':''}>Заменяет: ${esc(s.name)}</option>`).join('')}</select>`:''}</div><div>${row.status==='error'?btn('Повторить','retry-upload',i,'compact-action'):''}${row.status!=='uploading'?btn('Убрать','remove-queue',i,'quiet compact-action'):''}</div></div>`).join('')}`:''}<div class="section-title"><h3>Состав новой редакции</h3><small>Выбрано: ${selected.size}</small></div><p class="muted">Отметьте договор и нужные приложения. Снятие отметки не удаляет оригинал.</p>${c.files.length?c.files.map(f=>`<div class="file-row"><input type="checkbox" data-file-choice="${f.id}" aria-label="Включить ${esc(f.name)}" ${selected.has(f.id)?'checked':''}><div><strong>${esc(f.name)}</strong><div><small>${esc(labels[f.status]||f.status)} · ${(f.size/1024).toFixed(0)} КБ</small></div>${f.status==='error'?`<p class="error">${esc(f.extraction?.warnings?.join(' '))}</p>`:''}</div>${f.status==='error'?btn('Повторить чтение','retry-extract',f.id,'compact-action'):btn('Текст','file',f.id,'compact-action')}</div>`).join(''):'<p class="muted">Файлы ещё не загружены.</p>'}<form class="form" data-form="revision">${select('parent_id','На основе редакции',[['','Без родительской редакции'],...c.revisions.map(r=>[r.id,'v'+r.number])],state.revisionId||'')}${field('note','Комментарий к редакции','','text','maxlength="1000" placeholder="Например: редакция заказчика от 3 сентября"')}<div class="error" role="alert"></div><button class="primary" ${!selected.size||blocked?'disabled':''}>Зафиксировать комплект</button></form></div>`;
}
function documentView() {
  const files=state.sourceDocuments||state.contract.files; const file=files.find(f=>f.id===state.source?.fileId)||files.find(f=>revision()?.file_ids.includes(f.id))||files[0];
  if(!file)return `<div class="empty"><h2>Исходников пока нет</h2><p>Загрузите основной договор и приложения.</p>${btn('Загрузить','tab','upload','primary')}</div>`;
  return `<div class="flow"><div class="row"><label class="grow">Документ<select id="document-select">${files.map(f=>`<option value="${f.id}" ${f.id===file.id?'selected':''}>${esc(f.name)}</option>`).join('')}</select></label><a href="/docs/api/files/${file.id}/download" class="compact-action">Скачать оригинал</a></div>${state.source?.blockId&&state.center!=='analysis'?btn('Назад к паспорту','tab','passport','quiet'):''}<small>${state.source?.riskId?'Пункт и редакция, зафиксированные при регистрации риска.':state.sourceDocuments?'Исходник выбранного анализа. Обновление структуры файла не меняет этот снимок.':'Структура документа с исходной нумерацией. Нераспознанные номера не подставляются.'}</small>${!state.sourceDocuments&&file.extraction?.extractor!=='clauses-v2'?btn('Обновить структуру','refresh-structure',file.id,'quiet'):''}${file.extraction?.warnings?.length?`<div class="warning">${file.extraction.warnings.map(esc).join('<br>')}</div>`:''}${documentText(file,state.source,esc)}</div>`;
}
function passportView() {
  const r=result(),a=analysis();
  if(!r||a.revision_id!==state.revisionId)return `<div class="empty"><span class="empty-mark">Паспорт договора</span><h2>О чём договор — в нескольких строках</h2><p>Зафиксируйте комплект и запустите анализ. Первый агент сформирует предмет и ключевые условия, второй проверит их по исходникам.</p><p>Неизвестные условия не заполняются догадками.</p>${btn('К документам','tab','upload','primary')}</div>`;
  return `<div class="flow"><div class="row between"><h2>Паспорт · v${revision()?.number}</h2>${badge(a.review_result?'С ревью':'Без ревью',a.review_result?'':'medium')}</div><p>${esc(r.summary)}</p>${compactPassport(r,esc,sources)}<details><summary>Ограничения проверки</summary><div class="warning">${r.limitations.map(esc).join('<br>')}</div><p class="muted">Паспорт относится к выбранному комплекту и не означает юридического согласования.</p></details></div>`;
}
function versionsView() { return `<div class="flow"><div class="row between"><h2>Редакции</h2>${btn('Сравнить','compare','','',state.contract.revisions.length<2)}</div>${state.contract.revisions.map(r=>`<article class="version"><div class="row between"><h3>v${r.number} ${state.contract.effective_id===r.id?badge('Действующий','good'):''}</h3>${btn('Открыть','revision',r.id,'compact-action')}</div><small>${date(r.created)} · ${r.file_ids.length} файлов</small><p>${esc(r.note)}</p><p class="muted">Основана на ${r.parent_id?'v'+state.contract.revisions.find(x=>x.id===r.parent_id)?.number:'исходном комплекте'}</p>${btn('Подтвердить действующий комплект','effective',r.id,'quiet compact-action')}</article>`).join('')||'<p class="muted">Редакций пока нет. Зафиксируйте первый комплект на вкладке загрузки.</p>'}${btn('Изменить стадию договора','stage','','quiet')}</div>`; }
function compareView() {
  const versions=state.contract.revisions;
  const left=versions.find(v=>v.id===state.compareLeft)||versions[1],right=versions.find(v=>v.id===state.compareRight)||versions[0];
  function side(r,name){return `<div><label>Редакция<select id="${name}">${versions.map(v=>`<option value="${v.id}" ${v.id===r?.id?'selected':''}>v${v.number}</option>`).join('')}</select></label><pre>${esc(r?.file_ids.map(id=>{const f=state.contract.files.find(f=>f.id===id);return f.name+'\n'+(f.extraction?.blocks||[]).map(b=>b.text).join('\n');}).join('\n\n')||'')}</pre></div>`;}
  return `<div class="flow"><h2>Сравнение исходников</h2><p class="muted">Два комплекта рядом. Автоматический смысловой diff появится в следующей версии; это не заключение об отсутствии изменений.</p><div class="comparison">${side(left,'compare-left')}${side(right,'compare-right')}</div></div>`;
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
  return `<div class="settings flow"><h2>Codex для приложения</h2><p>Одно серверное подключение ChatGPT для всех пользователей и обоих этапов анализа. API-ключи не используются; очередь и лимит подключённого аккаунта общие.</p><div class="${connection.connected?'info':'warning'}" role="status">${connection.connected?'Общий вход ChatGPT сохранён. Доступность анализа проверяется при запуске.':'Общий Codex не подключён. Документы, редакции и ручной реестр рисков доступны.'}</div>${control}<p class="muted">Ваш логин и пароль приложения независимы от Codex. Выход из приложения не отключает общее подключение.</p><hr class="separator"><h3>Ограничения пилота</h3><p class="muted">Нормативная база и OCR пока не подключены. Результаты AI требуют проверки сотрудником. Договоры и история пользователей изолированы, несмотря на общее подключение Codex.</p><p class="muted">Загрузка до 20 МБ на файл, 200 МБ на аккаунт. История хранится на VPS.</p><hr class="separator"><form class="form" data-form="password"><h3>Сменить пароль приложения</h3>${field('current','Текущий пароль','','password','required autocomplete="current-password"')}${field('password','Новый пароль','','password','required minlength="10" maxlength="256" autocomplete="new-password"')}<div class="error" role="alert"></div><button type="submit">Сменить пароль и выйти</button></form></div>`;
}
function centerForm() {
  const f=state.form;
  if(f?.type==='customer')return formWrap('customer','Новый заказчик',field('name','Название','','text','required maxlength="200"')+field('inn','ИНН · необязательно','','text','inputmode="numeric" maxlength="12"'),'Создать заказчика');
  if(f?.type==='contract')return formWrap('contract',state.kind==='template'?'Новый шаблон':'Новый договор',field('title','Название или номер','','text','required maxlength="200"')+(state.kind==='contract'?select('customer_id','Заказчик',state.boot.customers.map(c=>[c.id,c.name]),state.customer):'')+select('contractor','Подрядчик',Object.entries(state.boot.profiles).map(([k,p])=>[k,p.name])),'Создать');
  if(f?.type==='effective')return formWrap('effective','Действующий комплект',`<p>Подтвердите основание действия редакции v${state.contract.revisions.find(x=>x.id===f.id)?.number}. Загрузка файла сама по себе не означает подписание.</p>`+area('reason','Основание: подписание, дата и область действия','','required maxlength="1000"'),'Подтвердить');
  if(f?.type==='stage')return formWrap('stage','Стадия договора',select('stage','Стадия',['Подготовка','Согласование','Подписан','Исполнение','Завершён','Прекращён','Архив'].map(x=>[x,x]),state.contract.stage)+area('reason','Основание','','required maxlength="1000"'));
  if(f?.type==='manager')return formWrap('manager','Ответственный за договор',`<p class="muted">Имя или почта менеджера. Подставляется в текст замечаний и в адрес письма; приложение ничего не отправляет само.</p>`+field('manager','Имя или адрес почты',state.contract.manager||'','text','maxlength="200"'),'Сохранить');
  return null;
}
function centerView() {
  const form=centerForm();if(form)return form;
  if(state.center==='settings')return settingsView();
  if(state.center==='rules')return `<div class="flow"><h2>Критерии проверки</h2><p class="muted">Аналитик ищет полноту, ревьюер проверяет по оригиналам. Обе компании находятся в Москве. У каждого критерия своя версия: при её изменении прежние анализы не переписываются, а помечаются в истории.</p>${state.boot.rules.map(r=>`<section class="details-field"><div class="row">${badge(r.id)}${badge('версия '+r.version)}${r.coverage===false?badge('вне покрытия','medium'):''}</div><h3>${esc(r.title)}</h3><p>${esc(r.instruction)}</p>${r.avoid?`<p class="muted"><strong>Не считать замечанием:</strong> ${esc(r.avoid)}</p>`:''}</section>`).join('')}</div>`;
  if(!state.contract)return `<div class="empty"><span class="empty-mark">Рабочее место</span><h2>Начните с заказчика и договора</h2><p>Здесь будут оригиналы, паспорт, история анализа и риски. Демонстрационных договоров нет — все записи создаёте вы.</p>${btn('Создать заказчика','new-customer','','primary')}</div>`;
  return ({upload:uploadView,document:documentView,passport:passportView,versions:versionsView,compare:compareView,analysis:analysisView}[state.center]||passportView)();
}
function analysisSourceView() {
  return state.source ? documentView() : '<div class="empty"><h3>Источник замечания</h3><p>Выберите ссылку на пункт в результатах анализа. Здесь откроется его текст с исходной нумерацией.</p></div>';
}
function analysisLayoutButton() {
  return btn(state.center==='analysis'?'В боковую панель':'В центр','analysis-layout','','compact-action');
}
function analysisView() {
  const a=analysis(),r=result();
  if(!a)return `<div class="flow analysis-result">${analysisLayoutButton()}<div class="empty"><h3>Проверка в два этапа</h3><p>Аналитик выявляет условия и риски. Ревьюер сверяет выводы и предложения с исходниками.</p>${state.boot.codex.connected?'':btn(state.boot.codex.canManage?'Подключить общий Codex':'Статус общего Codex','settings','','primary')}</div></div>`;
  const rev=state.contract.revisions.find(v=>v.id===a.revision_id);
  return `<div class="flow analysis-result" data-result-key="${a.id}"><div class="row between"><h2>Анализ и рекомендации</h2>${analysisLayoutButton()}</div><div class="row between">${badge(labels[a.status],a.status==='error'?'high':a.status==='complete'?'good':'medium')}<small>v${rev?.number} · ${date(a.created)}</small></div>${a.revision_id!==state.revisionId?'<div class="warning">Этот анализ относится к другой редакции.</div>':''}<div class="step-line"><div class="step ${a.primary_result?'done':a.status==='primary'?'running':''}">1. Аналитик<br>${a.primary_result?'Результат сохранён':'Ожидается'}</div><div class="step ${a.review_result?'done':a.status==='review'?'running':''}">2. Ревьюер<br>${a.review_result?'Проверка завершена':'Не завершено'}</div></div>${a.error?`<div class="error">${esc(a.error)}</div>${['error','interrupted'].includes(a.status)?btn('Повторить этап','retry-analysis',a.id):''}`:''}${['queued','primary','review'].includes(a.status)?btn('Отменить анализ','cancel-analysis',a.id,'quiet'):''}${r?`<div class="warning">${r.limitations.map(esc).join('<br>')}</div>${r.findings.length?'<p class="muted">Решение по каждому замечанию сохраняется в план правок. План правок не означает согласие заказчика.</p>'+r.findings.map((f,index)=>{const draftKey=a.id+':'+f.id,edit=state.drafts.get(draftKey)||state.contract.recommendations.find(x=>x.analysis_id===a.id&&x.finding_id===f.id);return `<article class="finding"><div class="row">${badge(labels[f.severity],f.severity)}${badge(f.rule)}${badge(f.review==='primary'?'Без ревью':f.review==='added'?'Добавлено ревьюером':f.review==='corrected'?'Исправлено':'Подтверждено')}${state.contract.kind==='contract'?btn('Зафиксировать риск','finding-risk',index,'compact-action'):''}</div><h3>${esc(f.title)}</h3><p>${esc(f.description)}</p>${sources(f.sources)}<form data-form="recommendation" data-draft-key="${esc(draftKey)}" data-index="${index}" class="flow"><label>Предлагаемая формулировка<textarea name="text" required maxlength="15000">${esc(edit?.text??f.proposal)}</textarea></label>${select('status','Решение',[['draft','Черновик'],['planned','В плане правок'],['rejected','Отклонено']],edit?.status||'draft')}<div class="error" role="alert"></div><button type="submit" class="compact-action">Сохранить решение</button></form></article>`;}).join(''):'<p>Замечания не сформированы. Учитывайте ограничения и покрытие правил ниже.</p>'}<details><summary>Покрытие критериев</summary>${r.coverage.map(c=>`<p><strong>${esc(c.rule)}</strong> · ${esc(coverageLabels[c.status]||c.status)}<br>${esc(c.note)}</p>`).join('')}</details>${r.changes.length?`<details><summary>Изменения ревьюера</summary>${r.changes.map(x=>`<p>${esc(x)}</p>`).join('')}</details>`:''}<div class="row">${btn('Текст для менеджера','summary-open','','compact-action')}<a class="compact-action" href="/docs/api/analyses/${a.id}/export">Скачать результат JSON</a></div>${summaryPanel(a)}`:'<p class="muted">Результат появится после завершения этапа. Можно работать с другими документами.</p>'}</div>`;
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
  return `<div class="flow">${pending.length?`<section class="flow"><div class="row between"><h3>Кандидаты из анализа${runRevision?' v'+runRevision.number:''} · ${pending.length}</h3></div><p class="muted">Замечания анализа не попадают в реестр автоматически. Подтвердите или отклоните каждое.</p>${pending.map(x=>`<article class="risk-card"><div class="row">${badge(labels[x.finding.severity],x.finding.severity)}${badge(x.finding.rule)}</div><h3>${esc(x.finding.title)}</h3><p class="muted">${esc(x.finding.description.slice(0,160))}</p><div class="row">${btn('В реестр','finding-risk',x.index,'compact-action')}${btn('Отклонить','dismiss-candidate',x.index,'quiet compact-action')}</div></article>`).join('')}<hr class="separator"></section>`:''}<div class="row between"><h2>Реестр рисков</h2>${btn('+ Риск','new-risk','','compact-action')}</div><p class="muted">Постоянные записи по договору. Новая редакция не закрывает их автоматически.</p>${c.risks.map(r=>`<article class="risk-card"><div class="row">${badge(labels[r.severity],r.severity)}${badge(r.status)}</div><h3>${esc(r.title)}</h3><p class="muted">${esc(r.owner)}</p>${r.events.some(e=>e.kind==='incident')?badge('Есть события','medium'):''}${btn('Открыть','risk',r.id,'quiet compact-action')}</article>`).join('')||`<p>Риски пока не зарегистрированы. ${pending.length?'Выше — кандидаты последнего анализа.':'Добавьте вручную или из замечания анализа.'}</p>`}${dismissed.length?`<details><summary>Отклонённые кандидаты · ${dismissed.length}</summary>${dismissed.map(d=>`<article class="history-row"><small>${date(d.created)} · ${esc(d.rule)}</small><strong>${esc(d.title)}</strong><p class="muted">${esc(d.reason)}</p>${btn('Вернуть в кандидаты','restore-candidate',d.key,'quiet compact-action')}</article>`).join('')}</details>`:''}</div>`;
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
  if(!state.user){state.drafts.clear();quick.reset();$('#app').innerHTML=loginView();return;}
  if(!state.boot)return;
  const oldResult=$('.analysis-result'),oldKey=oldResult?.dataset.resultKey,oldScroll=oldResult?.closest('.content')?.scrollTop;
  const c=state.contract;
  $('#app').innerHTML=`<header class="topbar"><div class="brand"><span class="mark" aria-hidden="true">Д</span>Договоры и риски</div><div class="row">${btn(state.boot.codex.connected?'Codex · общий вход':'Codex · не подключён','settings','','quiet')}<small>${esc(state.user.login)}</small>${btn('Выйти','logout','','quiet')}</div></header><div class="workspace">${sidebar()}<main id="main" class="main ${state.center==='quick'?'quick-main':''}">${c?context():`<header class="context"><h1>${state.center==='settings'?'Настройки':'Договоры и шаблоны'}</h1></header>`}<div class="panels"><section class="panel"><nav class="tabs" aria-label="Работа с договором">${[['passport','Паспорт'],['analysis','Анализ'],['document','Документ'],['upload','Загрузка'],['versions','Редакции']].map(([v,t])=>btn(t,'tab',v,state.center===v?'active':'',!c)).join('')}</nav><div class="content">${centerView()}</div></section><aside class="panel inspector"><nav class="tabs" aria-label="Результаты проверки">${[['analysis',state.center==='analysis'?'Источник':'Анализ'],['risks','Риски'+(c&&candidates().length?' · '+candidates().length:'')],['history','История']].map(([v,t])=>btn(t,'right',v,state.right===v?'active':'',!c)).join('')}</nav><div class="content">${c?({analysis:state.center==='analysis'?analysisSourceView:analysisView,risks:riskView,history:historyView}[state.right])():'<div class="empty"><h3>От условий к решениям</h3><p>Здесь появятся замечания, предложенные формулировки и риски выбранного договора.</p></div>'}</div></aside></div></main></div><footer class="footer">Пилот 0.1.5 · оригиналы и история хранятся на сервере · AI-выводы требуют проверки сотрудником</footer>`;
  if(state.center==='quick'){$('#main').innerHTML=quick.view();$('.footer').textContent='Разовая проверка: без записи в хранилище · результат требует проверки сотрудником';}
  const newResult=$('.analysis-result');
  if(oldKey&&newResult?.dataset.resultKey===oldKey)newResult.closest('.content').scrollTop=oldScroll;
  if(state.source?.blockId&&['document','analysis'].includes(state.center))requestAnimationFrame(()=>$('#source-'+state.source.blockId)?.scrollIntoView({block:'nearest'}));
  // A panel that opens below the fold reads as a button that did nothing.
  if(focusSummary){focusSummary=false;requestAnimationFrame(()=>{$('.summary-panel')?.scrollIntoView({block:'nearest'});const area=$('#summary-text');if(area){area.focus({preventScroll:true});area.select();}});}
}
async function uploadRow(row,contractId) {
  row.status='uploading';row.message='Загрузка…';if(state.contractId===contractId)render();
  try{
    const payload=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',`/docs/api/contracts/${contractId}/files`);xhr.setRequestHeader('X-Docs-Request','1');xhr.setRequestHeader('X-File-Name',encodeURIComponent(row.file.name));xhr.timeout=120000;xhr.upload.onprogress=e=>{if(e.lengthComputable){row.progress=Math.round(e.loaded/e.total*100);row.message=row.progress===100?'Проверяем и извлекаем текст…':`Загрузка ${row.progress}%`;if(state.contractId===contractId)render();}};xhr.onload=()=>{try{const data=JSON.parse(xhr.responseText);xhr.status<300?resolve(data):reject(new Error(data.error));}catch{reject(new Error('Не удалось прочитать ответ сервера.'));}};xhr.onerror=()=>reject(new Error('Нет соединения. Повторите загрузку.'));xhr.ontimeout=()=>reject(new Error('Сервер не ответил. Повтор безопасен: точный дубль не создаст копию.'));xhr.send(row.file);});
    row.status='done';row.savedId=payload.file.id;row.similar=payload.similar;row.message=payload.duplicate?'Точный дубль · оригинал уже сохранён':payload.file.status==='ready'?'Загружен · включите в комплект':'Оригинал сохранён · текст не извлечён';
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
  const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action,value=button.dataset.value;button.disabled=true;
  try{
    if(action==='quick-open'){state.center='quick';state.form=null;await quick.open();history.replaceState(null,'','#quick');render();return;}
    if(action==='stored'){state.center=state.contract?'passport':'upload';history.replaceState(null,'',state.contractId?'#'+state.contractId:location.pathname);render();return;}
    if(action==='from-quick'){state.center='upload';state.kind='contract';state.form=state.boot.customers.length?{type:'contract'}:{type:'customer'};history.replaceState(null,'',location.pathname);notice('Для постоянного учёта загрузите те же файлы в договор: оригиналы разовой проверки уже удалены.');render();return;}
    if(action.startsWith('quick-')){await quick.action(action,value,button);return;}
    if(action==='show-password'){const input=$('input[name=password]');input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'Показать пароль':'Скрыть пароль';button.disabled=false;return;}
    if(action==='auth-mode'){state.loginMode=value;render();return;}
    if(action==='logout'){await api('/logout',{});state.sourceDocuments=null;state.user=null;state.boot=null;state.contract=null;state.queues.clear();state.selections.clear();render();return;}
    if(action==='open-contract'){await openContract(value);return;}
    if(action==='kind'){state.kind=value;state.customer='';}
    if(action==='tab'){if(value==='analysis'&&state.center!=='analysis'){state.analysisReturn=state.center;state.right='analysis';}if(value==='document'){state.sourceDocuments=null;state.source=null;}state.center=value;state.form=null;}
    if(action==='analysis-layout'){
      const scrollTop=button.closest('.content')?.scrollTop||0;
      if(state.center==='analysis')state.center=state.analysisReturn||'passport';
      else {state.analysisReturn=state.center;state.center='analysis';}
      state.right='analysis';state.form=null;render();
      const control=$('[data-action="analysis-layout"]');control?.focus({preventScroll:true});
      if(control)control.closest('.content').scrollTop=scrollTop;
      return;
    }
    if(action==='right'){state.right=value;state.form=null;}
    if(action==='settings'){state.center='settings';state.form=null;state.boot.codex=await api('/codex');}
    if(action==='rules'){state.center='rules';state.form=null;}
    if(action==='new-customer')state.form={type:'customer'};
    if(action==='new-contract'){if(state.kind==='contract'&&!state.boot.customers.length){state.form={type:'customer'};notice('Сначала создайте заказчика.');}else state.form={type:'contract'};}
    if(action==='cancel-form')state.form=null;
    if(action==='pick-files'){$('#file-picker').click();button.disabled=false;return;}
    if(action==='remove-queue'){queue().splice(Number(value),1);}
    if(action==='retry-upload'){await uploadRow(queue()[Number(value)],state.contractId);return;}
    if(action==='retry-extract'){await api('/files/'+value+'/retry',{});await refreshContract();}
    if(action==='file'){state.sourceDocuments=null;state.source={fileId:value};state.center='document';state.form=null;}
    if(action==='source'){state.source=JSON.parse(value);state.sourceDocuments=state.source.analysisId?(await api('/analyses/'+state.source.analysisId+'/documents')).map(f=>({...f,extraction:f})):null;if(state.center==='analysis')state.right='analysis';else state.center='document';state.form=null;}
    if(action==='refresh-structure'){if(!confirm('Повторно прочитать структуру оригинала? Старые анализы и их ссылки не изменятся. Для новых выводов запустите новый анализ.')){button.disabled=false;return;}await api('/files/'+value+'/structure',{});await refreshContract();notice('Структура обновлена. Старые результаты не изменены.');}
    if(action==='risk-source'){const [riskId,index]=JSON.parse(value),ref=state.contract.risks.find(r=>r.id===riskId).sources[index];state.source={...ref,riskId};state.sourceDocuments=[{id:ref.fileId,name:ref.fileName,extraction:{blocks:[ref.block],warnings:[]}}];state.center='document';state.form=null;}
    if(action==='revision'){state.source=null;state.sourceDocuments=null;state.revisionId=value;state.runId=null;state.selections.delete(state.contractId);state.center='passport';}
    if(action==='compare'){state.center='compare';state.form=null;}
    if(action==='effective')state.form={type:'effective',id:value};
    if(action==='stage')state.form={type:'stage'};
    if(action==='analyze'){await api('/contracts/'+state.contractId+'/analyses',{revision_id:state.revisionId});state.source=null;state.sourceDocuments=null;state.runId=null;state.right='analysis';await refreshContract();notice('Комплект поставлен в очередь анализа.');}
    if(action==='retry-analysis'){await api('/analyses/'+value+'/retry',{});await refreshContract();state.source=null;state.sourceDocuments=null;state.runId=state.contract.analyses[0].id;notice('Создана новая попытка. История сохранена.');}
    if(action==='cancel-analysis'){await api('/analyses/'+value+'/cancel',{});await refreshContract();}
    if(action==='run'){state.source=null;state.sourceDocuments=null;state.runId=value;state.right='analysis';}
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
    if(action==='new-risk'){state.form={type:'risk'};state.right='risks';}
    if(action==='dismiss-candidate'){state.form={type:'dismiss',index:Number(value)};state.right='risks';}
    if(action==='restore-candidate'){await api('/contracts/'+state.contractId+'/dismissed',{key:value,restore:true});await refreshContract();}
    if(action==='finding-risk'){state.form={type:'risk',finding:result().findings[Number(value)],analysis:analysis().id};state.right='risks';}
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
  const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();const data=Object.fromEntries(new FormData(form));const submit=form.querySelector('[type=submit]')||form.querySelector('button.primary');if(submit)submit.disabled=true;
  try{
    const type=form.dataset.form;
    if(type==='auth'){state.user=await api('/'+state.loginMode,data);await refreshBoot();state.contractId=null;state.contract=null;state.form=null;const fromHash=location.hash.slice(1);if(fromHash==='quick'){state.center='quick';await quick.open();render();}else if(state.boot.contracts.some(c=>c.id===fromHash))await openContract(fromHash);else render();return;}
    if(type==='password'){await api('/me',data,'PATCH');state.user=null;render();notice('Пароль изменён. Войдите снова.');return;}
    if(type==='customer'){const value=await api('/customers',data);state.customer=value.id;await refreshBoot();state.form={type:'contract'};render();return;}
    if(type==='contract'){const value=await api('/contracts',{...data,kind:state.kind});await refreshBoot();await openContract(value.id);return;}
    if(type==='revision'){const value=await api('/contracts/'+state.contractId+'/revisions',{...data,file_ids:[...chosen()]});await refreshContract();await refreshBoot();state.revisionId=value.id;state.runId=null;state.center='versions';state.queues.set(state.contractId,[]);notice('Редакция v'+value.number+' сохранена. Анализ запускается отдельно.');}
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
  }catch(e){form.querySelector('.error').textContent=e.message;if(submit)submit.disabled=false;}
});
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
