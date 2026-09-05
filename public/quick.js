import { sourceLabel, documentText, compactPassport, severityLabels, coverageLabels, legalReferences, legalSnapshotLabel } from './document-ui.js';
import { summaryText } from './summary.js';
export function textReport(packet, profileName) {
  const result=packet.review_result||packet.primary_result;
  if(!result)return '';
  const lines=['РАЗОВАЯ ПРОВЕРКА ДОГОВОРА',packet.review_result?'Ревью завершено':'ПЕРВИЧНЫЙ РЕЗУЛЬТАТ. РЕВЬЮ НЕ ЗАВЕРШЕНО.',`Подрядчик: ${profileName}`,`Дата: ${packet.created}`,'',...packet.files.map(f=>`Файл: ${f.name}`),'',result.summary,'','ПАСПОРТ'];
  const refs=sources=>sources.map(s=>`Источник: ${sourceLabel(s,packet.files)}\n«${s.quote}»`);
  for(const item of result.passport)lines.push(`${item.title}: ${item.value}`,...refs(item.sources),'');
  lines.push('ЗАМЕЧАНИЯ И РЕКОМЕНДАЦИИ');
  if(!result.findings.length)lines.push('Замечания не сформированы. Это не подтверждение отсутствия рисков.');
  for(const finding of result.findings)lines.push(`${finding.rule}: ${finding.title} (${finding.severity})`,finding.description,...(finding.proposal?[`Предлагаемая формулировка: ${finding.proposal}`]:[]),...refs(finding.sources),...(finding.legalSources||[]).flatMap(s=>['Нормативное основание: '+[s.title,s.article,s.paragraph].filter(Boolean).join(' · '),'Статус редакции: '+(s.verificationStatus==='verified'?'подтверждена':'требует проверки'),s.sourceUrl||'',s.quote?'«'+s.quote+'»':'']),'');
  lines.push('ПОКРЫТИЕ ПРАВИЛ',...result.coverage.map(c=>`${c.rule}: ${c.status}. ${c.note}`),'','ОГРАНИЧЕНИЯ',...result.limitations,'Результат требует проверки сотрудником. Актуальность нормативных оснований указана в ограничениях проверки. OCR не подключён.');
  for(const file of packet.files)for(const warning of file.extraction?.warnings||[])lines.push(`${file.name}: ${warning}`);
  if(packet.error)lines.push(`Ошибка: ${packet.error}`);
  return '\uFEFF'+lines.join('\n');
}

export class QuickUI {
  constructor(deps){Object.assign(this,deps);this.reset();}
  reset(){this.generation=(this.generation||0)+1;this.xhr?.abort();this.packet=null;this.rows=[];this.tab='files';this.returnTab='files';this.source=null;this.profile='';this.error='';this.batch=false;this.summary='';this.filter='all';this.inspectorOpen=false;this.inspectorWide=false;}
  async open(){this.error='';if(!this.getBoot().profiles[this.profile])this.profile=Object.keys(this.getBoot().profiles)[0]||'';const generation=this.generation,list=await this.api('/quick-checks');if(generation!==this.generation)return;this.packet=list[0]||null;if(this.packet){this.profile=this.packet.contractor;if(this.packet.status!=='draft')this.tab='analysis';}}
  async refresh(){
    if(!this.packet)return;
    const key=this.packet.id,generation=this.generation;
    try{const packet=await this.api('/quick-checks/'+key);if(generation===this.generation&&this.packet?.id===key)this.packet=packet;}
    catch(e){if(generation!==this.generation||this.packet?.id!==key)return;if([404,410].includes(e.status)){this.reset();this.error='Временный пакет удалён или срок проверки истёк. Загрузите документы заново.';}else throw e;}
  }
  refs(items=[]){return items.map(s=>this.btn(this.esc(sourceLabel(s,this.packet?.files)),'quick-source',JSON.stringify(s),'source-link')).join('');}
  filesView(){
    const {esc,btn}=this,p=this.packet,editable=!p||p.status==='draft';
    if(!p&&!Object.keys(this.getBoot().profiles).length)return `<div class="empty"><h2>Сначала добавьте организацию</h2><p>Создайте карточку подрядчика вручную или по ИНН. Документы разовой проверки не попадут в хранилище.</p>${btn('Создать организацию','new-organization','','primary')}</div>`;
    return `<div class="flow"><h2>Договор и приложения</h2><label>Подрядчик<select id="quick-contractor" ${p?'disabled':''}>${Object.entries(this.getBoot().profiles).map(([key,value])=>`<option value="${key}" ${key===this.profile?'selected':''}>${esc(value.name)}</option>`).join('')}</select></label>${editable?`<div class="dropzone" id="quick-dropzone"><strong>Перетащите пакет документов</strong><p>PDF, DOC, DOCX · можно несколько сразу</p>${btn('Выбрать файлы','quick-pick','','primary',this.batch)}<small>До 20 МБ на файл, 20 файлов и 100 МБ на пакет. Точные дубли исключаются.</small><input class="hidden" type="file" id="quick-file-picker" accept=".pdf,.doc,.docx" multiple></div>`:'<p class="muted">Состав зафиксирован для этой проверки. Для другого пакета начните новую разовую проверку.</p>'}${this.rows.filter(r=>r.status!=='done').map((row)=>`<div class="file-row"><span></span><div><strong>${esc(row.name)}</strong><p class="${row.status==='error'?'error':'muted'}">${esc(row.message)}</p>${row.status==='uploading'?`<progress aria-label="Загрузка ${esc(row.name)}" value="${row.progress||0}" max="100"></progress>`:''}</div>${row.status==='error'?btn('Убрать ошибку','quick-dismiss',row.id,'quiet'):''}</div>`).join('')}${p?.files.map(f=>`<div class="file-row"><span class="file-type">${esc(f.ext.toUpperCase())}</span><div><strong>${esc(f.name)}</strong><p><small>${f.status==='ready'?'Текст извлечён; оригинал удалён':'Не удалось прочитать'}</small></p>${f.extraction.warnings.map(w=>`<p class="${f.status==='error'?'error':'warning'}">${esc(w)}</p>`).join('')}${btn('Показать текст','quick-file',f.id,'quiet',f.status!=='ready')}</div>${editable?btn('Убрать','quick-remove',f.id,'quiet',this.batch):''}</div>`).join('')||''}${!this.getBoot().codex.connected?'<p class="warning">Общий Codex не подключён. Владелец приложения должен выполнить вход в настройках.</p>':''}</div>`;
  }
  leftView(tab=this.tab){
    const p=this.packet,result=p?.review_result||p?.primary_result,{esc}=this;
    if(tab==='passport')return result?`<div class="flow"><h2>Паспорт договора</h2>${compactPassport(result,esc,sources=>this.refs(sources))}</div>`:'<div class="empty"><h2>Паспорт появится после анализа</h2><p>Предмет, сроки, оплата, места выполнения работ и другие условия.</p></div>';
    if(tab==='source'){
      const file=p?.files.find(f=>f.id===this.source?.fileId);
      return file?`<div class="document"><h2>${esc(file.name)}</h2><p class="muted">Извлечённый текст. Оригинал удалён с сервера.</p>${documentText(file,this.source,esc,'quick-block-')}</div>`:'<div class="empty"><p>Откройте текст файла или источник замечания.</p></div>';
    }
    return this.filesView();
  }
  rightView(){
    const {esc,btn}=this,p=this.packet,result=p?.review_result||p?.primary_result;
    const statuses={draft:'Готов к загрузке',queued:'В общей очереди',primary:'Первичный анализ',review:'Независимое ревью',complete:'Ревью завершено',error:'Ошибка этапа',cancelled:'Проверка отменена'};
    if(!p||p.status==='draft')return '<div class="empty analysis-result"><h2>Загрузите документы для проверки</h2><p>После запуска здесь появятся паспорт, замечания и независимое ревью.</p></div>';
    const running=['queued','primary','review'].includes(p.status),findings=(result?.findings||[]).filter(f=>this.filter!=='high'||f.severity==='high');
    return `<div class="flow analysis-result" data-result-key="${esc(p.id)}"><div class="row between"><h2>Анализ и рекомендации</h2>${result?btn('Текст для менеджера','quick-summary','','compact-action'):''}</div><p role="status">${esc(statuses[p.status])}</p>${running?`<small>Прошло ${Math.max(0,Math.floor((Date.now()-Date.parse(p.queuedAt||p.created))/60000))} мин · результат обновится автоматически.</small><div class="step-line"><div class="step ${p.primary_result?'done':p.status==='primary'?'running':''}">Аналитик · ${p.primary_result?'готово':p.status==='primary'?'в работе':'ожидается'}</div><div class="step ${p.status==='review'?'running':''}">Ревьюер · ${p.status==='review'?'в работе':'ожидается'}</div></div>`:''}${p.error?`<p class="error" role="alert">${esc(p.error)}</p>`:''}${p.status==='error'?btn(p.primary_result?'Повторить ревью':'Повторить анализ','quick-run','','primary',!this.getBoot().codex.connected):''}${result?`${!p.review_result?'<p class="warning">Первичный результат: ревью ещё не завершено.</p>':''}<small class="legal-status">${esc(legalSnapshotLabel(p.legal))}</small>${this.summary?`<section class="flow summary-panel"><div class="row between"><h3>Текст для менеджера</h3>${btn('Закрыть','quick-summary-close','','quiet compact-action')}</div><p class="muted">Условия договора будут перенесены за пределы приложения при отправке текста.</p>${btn('Скопировать','quick-summary-copy','','primary compact-action')}<label class="sr-only" for="summary-text">Текст замечаний</label><textarea id="summary-text" readonly rows="12">${esc(this.summary)}</textarea></section>`:''}<div class="findings-toolbar"><strong>Замечания · ${result.findings.length}</strong><div class="row" role="group" aria-label="Фильтр замечаний">${[['all','Все'],['high','Высокая критичность']].map(([v,t])=>btn(t,'quick-filter',v,'compact-action '+(this.filter===v?'active':''))).join('')}</div></div>${findings.map(f=>`<article class="finding"><details class="finding-disclosure" data-finding-key="quick:${esc(p.id)}:${esc(f.id)}"><summary><span class="finding-heading">${this.badge(severityLabels[f.severity],f.severity)}<strong>${esc(f.title)}</strong></span></summary><div class="finding-body flow"><small>${esc(f.rule)}</small><p>${esc(f.description)}</p>${legalReferences(f.legalSources,esc)}${f.proposal?`<h3>Предлагаемая формулировка</h3><p class="source-block">${esc(f.proposal)}</p>`:''}</div></details><div class="finding-sources">${this.refs(f.sources)}</div></article>`).join('')||'<p class="muted">Замечаний по выбранному фильтру нет. Учитывайте ограничения проверки.</p>'}<details><summary>Ограничения проверки · ${result.limitations.length}</summary>${result.limitations.map(l=>`<p class="warning">${esc(l)}</p>`).join('')}</details><details><summary>Покрытие правил</summary>${result.coverage.map(c=>`<p>${esc(c.rule)}: ${esc(coverageLabels[c.status]||c.status)}. ${esc(c.note)}</p>`).join('')}</details><div class="row">${btn(p.review_result?'Скачать отчёт (.txt)':'Скачать первичный отчёт','quick-export','','compact-action')}${btn('Вести договор постоянно','from-quick','','quiet compact-action')}</div><small>Риски и решения сохраняются только в хранилище договоров.</small>`:'<p class="muted">Можно продолжить работу и вернуться к проверке до истечения срока хранения пакета.</p>'}</div>`;
  }
  view(){
    const {btn,esc}=this,p=this.packet,showInspector=this.inspectorOpen&&Boolean(this.source||p?.primary_result),hasResult=Boolean(p?.primary_result);
    return `<header class="context"><div><h1>Разовая проверка</h1></div><div class="row">${!p||p.status==='draft'?btn('Проверить пакет','quick-run','','primary',this.batch||!p?.files.length||p.files.some(f=>f.status!=='ready')||this.rows.some(r=>r.status==='error')||!this.getBoot().codex.connected):''}${p?btn('Удалить пакет','quick-discard','','danger compact-action'):''}</div></header><div class="quick-privacy"><p>Текст передаётся в Codex. Пакет и результат удаляются ${p?'до '+esc(this.date(p.expires)):'не позднее чем через час'}.</p><details><summary>Обработка и срок хранения</summary><p>Оригиналы удаляются после чтения. Перезапуск сервера завершает временную сессию. Режим не меняет условия обработки данных OpenAI. Скачайте отчёт до удаления.</p></details>${this.error?`<p class="error" role="alert">${esc(this.error)}</p>`:''}</div><div class="panels ${showInspector?'has-inspector':'single-panel'} ${this.inspectorWide?'wide-inspector':''}"><section class="panel"><nav class="tabs" aria-label="Разовая проверка">${[['files','Пакет'],['passport','Паспорт'],['analysis','Анализ'],['source','Документ']].map(([key,title])=>btn(title,'quick-tab',key,this.tab===key?'active':'',!p&&key!=='files')).join('')}</nav><div class="content">${this.tab==='analysis'?this.rightView():this.leftView()}</div></section><aside class="panel inspector ${showInspector?'':'hidden'}" aria-label="${this.tab==='analysis'?'Источник замечания':'Анализ и рекомендации'}"><div class="tabs row between"><span>${this.tab==='analysis'?'Источник замечания':'Анализ и рекомендации'}</span><div class="row">${btn(this.inspectorWide?'Уже':'Шире','quick-source-width','','quiet compact-action inspector-size')}${btn('Закрыть','quick-source-close','','quiet compact-action')}</div></div><div class="content">${this.tab==='analysis'?this.leftView('source'):hasResult?this.rightView():''}</div></aside></div>`;
  }
  async upload(files){
    if(this.batch){this.notice('Дождитесь завершения текущей загрузки.');return;}
    const rows=Array.from(files).map((file,index)=>({id:String(Date.now())+'-'+index,name:file.name,file,status:'selected',message:'Ожидает загрузки'}));
    if(!rows.length)return;
    this.batch=true;this.error='';const generation=this.generation;
    try{
      if(!this.packet){const packet=await this.api('/quick-checks',{contractor:this.profile});if(generation!==this.generation)return;this.packet=packet;}
      const key=this.packet.id;this.rows.push(...rows);this.render();
      for(const row of rows){
        if(generation!==this.generation)break;
        row.status='uploading';this.render();
        try{
          const data=await new Promise((resolve,reject)=>{
            const xhr=new XMLHttpRequest();this.xhr=xhr;xhr.open('POST',`/docs/api/quick-checks/${key}/files`);xhr.timeout=60000;
            xhr.setRequestHeader('X-Docs-Request','1');xhr.setRequestHeader('X-File-Name',encodeURIComponent(row.name));
            xhr.upload.onprogress=e=>{if(e.lengthComputable){row.progress=Math.round(e.loaded/e.total*100);row.message=row.progress===100?'Извлекаем текст…':`Загрузка ${row.progress}%`;this.render();}};
            xhr.onload=()=>{try{const data=JSON.parse(xhr.responseText);xhr.status<300?resolve(data):reject(new Error(data.error));}catch{reject(new Error('Не удалось прочитать ответ сервера.'));}};
            xhr.onerror=xhr.ontimeout=()=>reject(new Error('Не удалось загрузить файл. Уберите ошибку и выберите файл ещё раз.'));
            xhr.onabort=()=>reject(new Error('Загрузка отменена.'));xhr.send(row.file);
          });
          if(generation!==this.generation)break;
          row.status='done';if(data.duplicate)this.notice('Точный дубль исключён: '+row.name);
          await this.refresh();
        }catch(e){if(generation===this.generation){row.status='error';row.message=e.message;}}
        finally{row.file=null;this.xhr=null;}
        this.render();
      }
    }catch(e){if(generation===this.generation)this.error=e.message;}
    finally{if(generation===this.generation){this.batch=false;this.render();}}
  }
  async action(action,value,button){
    this.error='';const generation=this.generation;
    if(action==='quick-pick'){document.querySelector('#quick-file-picker')?.click();button.disabled=false;return;}
    if(action==='quick-filter')this.filter=value;
    if(action==='quick-source-close')this.inspectorOpen=false;
    if(action==='quick-source-width')this.inspectorWide=!this.inspectorWide;
    if(action==='quick-tab'){this.inspectorOpen=value==='source'&&matchMedia('(min-width:1001px)').matches;if(value==='analysis'&&this.tab!=='analysis')this.returnTab=this.tab;this.tab=value;}
    if(action==='quick-dismiss')this.rows=this.rows.filter(r=>r.id!==value);
    if(action==='quick-file'){this.source={fileId:value};this.tab='source';}
    if(action==='quick-source'){this.inspectorOpen=this.tab==='analysis';this.source=JSON.parse(value);if(this.tab!=='analysis')this.tab='source';}
    if(action==='quick-remove'){const packet=await this.api(`/quick-checks/${this.packet.id}/files/${value}/remove`,{});if(generation!==this.generation)return;this.packet=packet;}
    if(action==='quick-run'){const packet=await this.api(`/quick-checks/${this.packet.id}/analyze`,{});if(generation!==this.generation)return;this.packet=packet;this.tab='analysis';this.inspectorOpen=false;this.notice('Пакет поставлен в общую очередь. В хранилище он не добавляется.');}
    if(action==='quick-discard'){
      if(!confirm('Удалить временный пакет и результаты? Текущий анализ будет остановлен. Восстановить пакет нельзя.')){button.disabled=false;return;}
      const key=this.packet.id,discardGeneration=++this.generation;this.xhr?.abort();this.rows=[];this.batch=false;
      await this.api(`/quick-checks/${key}/discard`,{});if(discardGeneration!==this.generation)return;this.reset();this.notice('Временный пакет удалён. Скачанные вами отчёты не затронуты.');
    }
    if(action==='quick-summary'){
      const p=this.packet,result=p.review_result||p.primary_result;
      this.summary=summaryText({result,meta:{title:'Разовая проверка договора',contractor:p.profile?.name||'Организация',created:this.date(p.created),reviewed:Boolean(p.review_result),temporary:true,files:p.files}});
    }
    if(action==='quick-summary-close')this.summary='';
    if(action==='quick-summary-copy'){
      try{await navigator.clipboard.writeText(this.summary);this.notice('Текст скопирован в буфер обмена.');}
      catch{const area=document.querySelector('#summary-text');if(area){area.focus();area.select();}this.notice('Копирование в буфер недоступно: скопируйте выделенный текст сочетанием клавиш.');}
      button.disabled=false;return;
    }
    if(action==='quick-export'){
      const text=textReport(this.packet,this.packet.profile?.name||'Организация');
      const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');
      link.href=url;link.download='Проверка договора.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    this.render();
    if(action==='quick-summary')requestAnimationFrame(()=>{document.querySelector('.summary-panel')?.scrollIntoView({block:'nearest'});const area=document.querySelector('#summary-text');if(area){area.focus({preventScroll:true});area.select();}});
    if(this.source?.blockId&&['source','analysis'].includes(this.tab))document.getElementById('quick-block-'+this.source.blockId)?.scrollIntoView({block:'nearest'});
  }
}
