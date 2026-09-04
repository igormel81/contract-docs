// Один словарь на все экраны. Раньше критичность называлась «Высокий» на бейдже,
// «Высокая» в форме, «Высокий риск» в разовой проверке и «высокая» в тексте письма.
export const severityLabels = { high:'Высокая', medium:'Средняя', low:'Низкая' };
export const coverageLabels = { checked:'Проверено', needs_data:'Нужны данные', not_applicable:'Не применимо' };
export const stageLabels = { queued:'В очереди', primary:'Первичный анализ', review:'Независимое ревью', complete:'Ревью завершено', error:'Ошибка этапа', interrupted:'Прервано', cancelled:'Отменено' };
export function locationLabel(block) {
  const location=block?.locator;
  const label=location?.status==='uncertain'?'Номер требует проверки':location?.label||'По цитате (номер не восстановлен)';
  const section=location?.section&&location.section!==label?location.section+', ':'';
  const page=block?.page?`, стр. ${block.page}${block.pageEnd&&block.pageEnd!==block.page?'-'+block.pageEnd:''}`:'';
  return section+label+page;
}
// Stable across analysis runs and revisions: finding.id is unique to one run only.
// Used to hide candidates already registered as risks or explicitly dismissed.
export function findingKey(finding) {
  const norm=value=>String(value??'').replace(/\s+/g,' ').trim().toLowerCase();
  return [finding.rule,norm(finding.title).slice(0,120),norm(finding.sources?.find(s=>s.quote)?.quote||'').slice(0,160)].join('|');
}
export function sourceLabel(source,files=[]) {
  const file=files.find(f=>f.id===source.fileId),block=(file?.extraction?.blocks||file?.blocks)?.find(b=>b.id===source.blockId);
  return `${source.fileName||file?.name||'Документ'}: ${source.location||locationLabel(block)}`;
}
export function documentText(file,selected,esc,prefix='source-') {
  return `<div class="document contract-text">${(file.extraction?.blocks||file.blocks||[]).map(block=>{
    const active=selected?.blockId===block.id;
    // Структура документа: вложенность списков, заголовки, таблицы и сплошное
    // выделение абзаца. Текст пункта при этом остаётся тем же, по которому
    // сверяются цитаты, — иначе подсветка перестанет совпадать с источником.
    let body;
    if(block.cells?.length){
      body=`<table class="clause-table"><tbody>${block.cells.map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }else{
      let text=esc(block.text);
      if(active&&selected.quote&&block.text.includes(selected.quote))text=text.replace(esc(selected.quote),'<mark>'+esc(selected.quote)+'</mark>');
      body=block.bold?`<strong>${text}</strong>`:text;
    }
    const kind=block.locator?.kind;
    return `<section class="source-block ${active?'highlight':''} ${kind==='section'?'clause-heading':''} ${kind==='table'?'clause-table-block':''}" style="--indent:${Number(block.level)||0}" id="${prefix+esc(block.id)}">${active?`<small>${esc(locationLabel(block))}</small>`:''}${body}</section>`;
  }).join('')}</div>`;
}
export function compactPassport(result,esc,sources) {
  const statuses={extracted:'Из документа',missing:'Не найдено',uncertain:'Уточнить'};
  const titles={subject:'Предмет',result:'Результат',term:'Сроки',price:'Цена',payment:'Оплата',location:'Места работ',acceptance:'Приёмка',dependencies:'Зависимости',special:'Особые условия'};
  return `<dl class="passport-compact">${result.passport.map(field=>`<div class="passport-row"><dt>${esc(titles[field.key]||field.title)}</dt><dd><p>${esc(field.value)}</p>${field.value.trim()===statuses[field.status]&&!field.sources.length?'':`<div class="passport-evidence"><small>${esc(statuses[field.status])}</small>${sources(field.sources)}</div>`}</dd></div>`).join('')}</dl>`;
}
// Кто с кем сравнивается, решает номер пункта, а при его отсутствии — сам текст.
// Это детерминированная разметка изменений, а не смысловой diff и не вывод об их отсутствии.
export function revisionClauses(revision, files) {
  // Номер входит в текст пункта, поэтому при сравнении текстов его отбрасываем:
  // иначе перенумерованный пункт выглядит как удалённый и заново добавленный.
  const norm=text=>String(text||'').replace(/^\s*(?:[0-9]{1,3}[.)]\s*|[0-9]{1,3}(?:\.[0-9]{1,3})+[.)]?\s+|[IVXLCDM]+[.)]\s*|[а-яa-z][)]\s*)+/i,'').replace(/\s+/g,' ').trim().toLowerCase();
  return (revision?.file_ids||[]).flatMap(id=>{
    const file=files.find(f=>f.id===id);
    return (file?.extraction?.blocks||[]).map(block=>({file:file.name,fileId:id,block,
      number:block.locator?.number||null,text:block.text,key:norm(block.text)}));
  });
}
export function clauseDiff(older, newer, files) {
  const before=revisionClauses(older,files), after=revisionClauses(newer,files);
  const byNumber=new Map();
  for(const item of before) if(item.number){const list=byNumber.get(item.file+'|'+item.number)||[];list.push(item);byNumber.set(item.file+'|'+item.number,list);}
  const byText=new Map();
  for(const item of before){const list=byText.get(item.key)||[];list.push(item);byText.set(item.key,list);}
  const used=new Set(), rows=[];
  for(const item of after){
    const sameNumber=(byNumber.get(item.file+'|'+item.number)||[]).find(x=>!used.has(x));
    if(sameNumber){used.add(sameNumber);rows.push({state:sameNumber.key===item.key?'same':'changed',item,was:sameNumber});continue;}
    const sameText=(byText.get(item.key)||[]).find(x=>!used.has(x));
    if(sameText){used.add(sameText);rows.push({state:sameText.number===item.number?'same':'moved',item,was:sameText});continue;}
    rows.push({state:'new',item,was:null});
  }
  for(const item of before) if(!used.has(item)) rows.push({state:'gone',item:null,was:item});
  return rows;
}
