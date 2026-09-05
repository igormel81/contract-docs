const fields=[['name','Название',200],['inn','ИНН · необязательно для ручного ввода',12],['legalName','Полное наименование',500],['ogrn','ОГРН / ОГРНИП',15],['kpp','КПП',9],['address','Юридический адрес',1000],['base','Город / расположение команды',300],['website','Официальный сайт · HTTPS',2000]];
export class OrganizationUI {
  constructor({api,esc,btn,render,getBoot,isActive}){Object.assign(this,{api,esc,btn,render,getBoot,isActive});this.reset();}
  reset(){this.generation=(this.generation||0)+1;this.data=null;this.lookupId=null;this.busy=false;this.error='';this.note='';}
  open(org={}){this.reset();this.data={...org};}
  list(){const {esc,btn}=this,orgs=this.getBoot().organizations||[];return `<div class="flow settings"><div class="row between"><h2>Мои организации</h2>${btn('Создать организацию','new-organization','','primary')}</div><p class="muted">Карточки подрядчиков доступны только вам. Их расположение, возможности и ограничения учитываются при новых проверках договоров и разовых пакетов.</p>${orgs.length?orgs.map(o=>`<article class="version"><h3>${esc(o.name)}</h3><p>ИНН ${esc(o.inn||'не указан')} · ${esc(o.base||'Расположение команды не указано')}</p><small>${o.searchedAt?'Есть сведения из поиска LLM — требуют проверки':'Заполнено пользователем'}</small><div>${btn('Открыть карточку','edit-organization',o.id)}</div></article>`).join(''):'<div class="empty"><h3>Добавьте свою организацию</h3><p>Заполните название вручную или найдите сведения по ИНН. Готовых карточек в сервисе нет.</p></div>'}</div>`;}
  form(){const {esc,btn}=this,d=this.data||{};
    const input=([key,title,max])=>`<label>${title}<input name="${key}" value="${esc(d[key]||'')}" maxlength="${max}" ${key==='name'?'required':''} ${['inn','ogrn','kpp'].includes(key)?'inputmode="numeric"':''}></label>`;
    return `<form class="form organization-form" data-form="organization"><h2>${d.id?'Карточка организации':'Новая организация'}</h2><p class="muted">Минимум — название. Остальное можно заполнить позже.</p>${input(fields[0])}${input(fields[1])}<div class="row">${btn(this.busy?'Ищем сведения…':'Заполнить по ИНН через LLM','organization-lookup','','',this.busy)}${this.busy?btn('Отменить поиск','organization-cancel-lookup'):''}</div><small>В интернет передаётся только ИНН через общий Codex. Договоры не передаются. Поиск занимает до 3 минут; заполненные вами поля не заменяются.</small><p class="info" role="status">${esc(this.busy?'Поиск выполняется. Можно продолжать заполнять карточку.':this.note||'Результат поиска — черновик, а не подтверждение реестром. Проверьте его перед сохранением.')}</p><details><summary>Реквизиты, адрес, команда и сайт</summary><div class="flow">${fields.slice(2).map(input).join('')}</div></details><details><summary>Возможности и ограничения для анализа</summary><div class="flow">${[['capabilities','Деятельность и услуги'],['claimed','Заявленные лицензии и ресурсы · требуют подтверждения'],['unverified','Неизвестное и ограничения: команды, выезды, субподряд']].map(([k,t])=>`<label>${t}<textarea name="${k}" maxlength="3000" rows="3">${esc(d[k]||'')}</textarea></label>`).join('')}</div></details>${d.sources?.length?`<details><summary>Источники поиска · ${d.sources.length} · не проверены автоматически</summary><p class="warning">Поля можно редактировать; цитаты показывают исходный результат LLM и могут уже не соответствовать вашей правке.</p>${d.sources.map(s=>`<div class="version"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a><p>${esc(s.quote)}</p><small>Поле: ${esc(s.field)} · найдено ${esc(s.checkedAt?.slice(0,10))}</small></div>`).join('')}${d.note?`<p>${esc(d.note)}</p>`:''}</details>`:''}<div class="error" role="alert" tabindex="-1">${esc(this.error)}</div><div class="actions"><button class="primary" type="submit" ${this.busy?'disabled':''}>${this.lookupId?'Проверено мной · сохранить':'Сохранить организацию'}</button>${btn('Отмена','cancel-organization')}</div><small>Сохранение не подтверждает лицензии. Изменения карточки не переписывают прежние анализы.</small></form>`;
  }
  async lookup(){
    if(this.busy)return;this.error='';this.busy=true;const generation=++this.generation,inn=(this.data.inn||'').trim();this.render();
    try{
      const job=await this.api('/organizations/lookup',{inn});
      if(generation!==this.generation){await this.api('/organizations/lookup/'+job.id,{});return;}
      this.lookupId=job.id;
      for(let i=0;i<105;i++){
        await new Promise(r=>setTimeout(r,2000));if(generation!==this.generation)return;
        const status=await this.api('/organizations/lookup/'+job.id);if(generation!==this.generation)return;
        if(status.status==='error'||status.status==='cancelled')throw new Error(status.error||'Поиск отменён. Можно заполнить вручную.');
        if(status.status!=='complete')continue;
        if((this.data.inn||'').trim()!==inn)throw new Error('ИНН изменён. Результат не применён — повторите поиск для нового ИНН.');
        let filled=0;for(const [key,value] of Object.entries(status.result))if(!this.data[key]&&value){this.data[key]=value;if(fields.some(f=>f[0]===key))filled++;}
        this.data.sources=status.result.sources;this.data.note=status.result.note;this.data.searchedAt=status.result.searchedAt;
        this.note=`Найдено. Заполнено полей: ${filled}. Проверьте реквизиты и источники, затем сохраните карточку.`;this.busy=false;if(this.isActive())this.render();return;
      }
      await this.api('/organizations/lookup/'+job.id,{});throw new Error('Время ожидания истекло. Попробуйте снова или заполните вручную.');
    }catch(e){if(generation!==this.generation)return;this.error=e.message;this.lookupId=null;this.busy=false;if(this.isActive()){this.render();document.querySelector('.organization-form .error')?.focus();}}
  }
  async cancel(){const job=this.lookupId;this.generation++;this.busy=false;this.lookupId=null;this.note='Поиск отменён. Можно заполнить вручную.';if(job)await this.api('/organizations/lookup/'+job,{});}
}
