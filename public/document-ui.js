export function locationLabel(block) {
  const location=block?.locator;
  const label=location?.status==='uncertain'?'Номер требует проверки':location?.label||'По цитате (номер не восстановлен)';
  const section=location?.section&&location.section!==label?location.section+', ':'';
  const page=block?.page?`, стр. ${block.page}${block.pageEnd&&block.pageEnd!==block.page?'-'+block.pageEnd:''}`:'';
  return section+label+page;
}
export function sourceLabel(source,files=[]) {
  const file=files.find(f=>f.id===source.fileId),block=(file?.extraction?.blocks||file?.blocks)?.find(b=>b.id===source.blockId);
  return `${source.fileName||file?.name||'Документ'}: ${source.location||locationLabel(block)}`;
}
export function documentText(file,selected,esc,prefix='source-') {
  return `<div class="document contract-text">${(file.extraction?.blocks||file.blocks||[]).map(block=>{
    const active=selected?.blockId===block.id;
    let text=esc(block.text);
    if(active&&selected.quote&&block.text.includes(selected.quote))text=text.replace(esc(selected.quote),'<mark>'+esc(selected.quote)+'</mark>');
    return `<section class="source-block ${active?'highlight':''} ${block.locator?.kind==='section'?'clause-heading':''}" id="${prefix+esc(block.id)}">${active?`<small>${esc(locationLabel(block))}</small>`:''}${text}</section>`;
  }).join('')}</div>`;
}
export function compactPassport(result,esc,sources) {
  const statuses={extracted:'Из документа',missing:'Не найдено',uncertain:'Уточнить'};
  const titles={subject:'Предмет',result:'Результат',term:'Сроки',price:'Цена',payment:'Оплата',location:'Места работ',acceptance:'Приёмка',dependencies:'Зависимости',special:'Особые условия'};
  return `<dl class="passport-compact">${result.passport.map(field=>`<div class="passport-row"><dt>${esc(titles[field.key]||field.title)}</dt><dd><p>${esc(field.value)}</p>${field.value.trim()===statuses[field.status]&&!field.sources.length?'':`<div class="passport-evidence"><small>${esc(statuses[field.status])}</small>${sources(field.sources)}</div>`}</dd></div>`).join('')}</dl>`;
}
