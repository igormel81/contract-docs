import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const escapeHtml=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pages=[
  ['architecture','specs/(sep-26)-on-premise-architecture.md','Архитектура'],
  ['deployment','references/local-deployment.md','Развёртывание'],
  ['normative','specs/(sep-26)-normative-base.md','Нормативная база']
];
function inline(text){
  const tokens=[];
  const stash=html=>`\u0000${tokens.push(html)-1}\u0000`;
  let value=text.replace(/`([^`]+)`/g,(_,code)=>stash(`<code>${escapeHtml(code)}</code>`));
  value=value.replace(/\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))\)/g,(_,label,angled,plain)=>{
    const url=angled||plain;
    if(/^https:\/\//.test(url))return stash(`<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(label)}</a>`);
    const page=pages.find(p=>url.endsWith(p[1].split('/').at(-1)));
    if(page)return stash(`<a href="${page[0]}.html">${escapeHtml(label)}</a>`);
    return stash(`${escapeHtml(label)} <span class="file-ref">(в архиве: ${escapeHtml(url.replace(/^\.\.\//,''))})</span>`);
  });
  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\u0000(\d+)\u0000/g,(_,n)=>tokens[Number(n)]);
}
export function renderMarkdown(markdown){
  const lines=markdown.split('\n'),out=[],toc=[];let n=0;
  while(n<lines.length){
    const line=lines[n];if(!line.trim()){n++;continue;}
    if(line.startsWith('```')){
      const lang=line.slice(3);const code=[];n++;while(n<lines.length&&!lines[n].startsWith('```'))code.push(lines[n++]);n++;
      if(lang==='mermaid'){
        const labels=new Map();for(const match of code.join('\n').matchAll(/(\w+)\[\(?([^\]]+)\]/g))labels.set(match[1],match[2].replace(/\)$/,''));
        const edges=code.filter(x=>x.includes('-->')).map(x=>{const [a,b]=x.split('-->');const left=a.trim().match(/^\w+/)?.[0],right=b.trim().match(/^\w+/)?.[0];return `<li><span>${escapeHtml(labels.get(left)||left)}</span><span aria-label="передаёт в"> → </span><span>${escapeHtml(labels.get(right)||right)}</span></li>`;});
        out.push(`<figure class="architecture-flow"><figcaption>Связи компонентов внутри контура</figcaption><ul>${edges.join('')}</ul></figure>`);
      }else out.push(`<pre tabindex="0" aria-label="Пример кода"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading=line.match(/^(#{1,6}) (.+)$/);
    if(heading){const level=heading[1].length,id=`section-${toc.length+1}`;toc.push({level,id,text:heading[2]});out.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);n++;continue;}
    if(line.startsWith('|')){
      const rows=[];while(n<lines.length&&lines[n].startsWith('|')){const row=lines[n++];if(/^\|[\s:|-]+\|$/.test(row))continue;rows.push(row.split('|').slice(1,-1).map(s=>s.trim()));}
      out.push(`<div class="table-scroll" tabindex="0" role="region" aria-label="Таблица"><table><thead><tr>${rows.shift().map(c=>`<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);continue;
    }
    if(line.startsWith('> ')){const rows=[];while(lines[n]?.startsWith('> '))rows.push(inline(lines[n++].slice(2)));out.push(`<blockquote>${rows.join('<br>')}</blockquote>`);continue;}
    if(/^(?:- |\d+\. )/.test(line)){const ordered=/^\d/.test(line),tag=ordered?'ol':'ul',items=[];while(n<lines.length&&(ordered?/^\d+\. /:/^- /).test(lines[n]))items.push(`<li>${inline(lines[n++].replace(/^(?:- |\d+\. )/,''))}</li>`);out.push(`<${tag}>${items.join('')}</${tag}>`);continue;}
    const paragraph=[];while(n<lines.length&&lines[n].trim()&&!/^(?:#|\||>|```|- |\d+\. )/.test(lines[n]))paragraph.push(lines[n++]);
    if(!paragraph.length)paragraph.push(lines[n++]);out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return {html:out.join('\n'),toc};
}
function shell(title,content,toc=[]){return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} — Договоры и риски</title><link rel="stylesheet" href="../app.css"><link rel="stylesheet" href="publication.css"></head><body class="publication"><a class="skip" href="#document">К документу</a><header class="publication-header"><a href="/docs/">Договоры и риски</a><nav aria-label="Документация"><a href="./">Локальная установка</a><a href="architecture.html">Архитектура</a><a href="deployment.html">Инструкция</a><a href="https://github.com/igormel81/contract-docs" target="_blank" rel="noopener noreferrer" aria-label="Код на GitHub (новая вкладка)">Код на GitHub</a></nav></header><div class="publication-layout">${toc.length?`<aside class="publication-toc"><details><summary>В этом документе</summary><nav aria-label="Оглавление">${toc.filter(h=>h.level===2).map(h=>`<a href="#${h.id}">${escapeHtml(h.text)}</a>`).join('')}</nav></details></aside>`:''}<main id="document" class="publication-content">${content}</main></div><footer class="publication-footer">Поставка 0.3.1 · 5 сентября 2026 · документ доступен без входа. Для PDF используйте печать браузера.</footer></body></html>`;}
export function buildDocuments(){
  const out=join(root,'public/local-installation');mkdirSync(out,{recursive:true});
  for(const [slug,path,label] of pages){const md=readFileSync(join(root,path),'utf8');const rendered=renderMarkdown(md);writeFileSync(join(out,`${slug}.md`),md);writeFileSync(join(out,`${slug}.html`),shell(label,`<div class="document-actions"><a href="${slug}.md" download>Скачать документ · Markdown</a></div>`+rendered.html,rendered.toc));}
  writeFileSync(join(out,'index.html'),shell('Локальная установка',`<p class="publication-meta">Архитектура и исходная поставка · 0.3.1</p><h1>Развернуть сервис<br>в организации</h1><p class="publication-lead">Устройство сервиса, инструкция для администратора и файлы проекта — в одном комплекте.</p><p class="publication-callout"><strong>Локальные модели пока не подключены.</strong> Архив содержит действующий вариант с общим Codex. Полностью закрытый контур описан как следующий этап разработки.</p><section class="publication-section"><h2>Документы</h2><a class="document-card" href="architecture.html"><span><strong>Архитектура локальной установки</strong><small>Компоненты, данные, два этапа анализа, модели, безопасность и оборудование</small></span><span aria-hidden="true">→</span></a><a class="document-card" href="deployment.html"><span><strong>Пошаговое развёртывание</strong><small>Требования, systemd, HTTPS, первый вход, проверки, резервные копии и откат</small></span><span aria-hidden="true">→</span></a><a class="document-card" href="normative.html"><span><strong>Нормативная база</strong><small>6 положений о подряде; актуальность редакции не подтверждена</small></span><span aria-hidden="true">→</span></a></section><section class="publication-section" id="downloads"><h2>Файлы проекта</h2><p>Исходники, тесты, документы и примеры конфигурации. Без договоров, базы данных, секретов и истории Git. Зависимости и веса моделей не включены.</p><div class="document-actions"><a class="download-primary" href="/docs/downloads/contract-docs-0.3.1.tar.gz" download>Скачать проект · TAR.GZ</a><a href="/docs/downloads/contract-docs-0.3.1.tar.gz.sha256" download>Контрольная сумма SHA-256</a></div><p><a href="/docs/downloads/manifest.json">Состав и версия поставки</a></p></section>`));
}
export const includedSource=path=>['package.json','package-lock.json','.gitignore'].includes(path)||/^(server\/|public\/|references\/|deploy\/onprem\/|scripts\/|test\/)/.test(path)&&!/^public\/downloads\//.test(path)&&path!=='test/vps-smoke.mjs'||pages.some(p=>p[1]===path);
export function assertPublishable(path,bytes){
  if(/(?:^|\/)(?:node_modules|data|runtime|uploads|backups|\.git|\.codex)(?:\/|$)|(?:^|\/)auth\.json$|\.(?:sqlite|pem|key|log)$/.test(path))throw new Error(`Forbidden archive entry: ${path}`);
  if(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{32,}|\bgh[pousr]_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}/.test(bytes.toString()))throw new Error(`Possible credential in ${path}; publication stopped`);
}
export function buildBundle(){
  const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).filter(includedSource).sort();
  for(const required of ['deploy/onprem/preflight.mjs','references/local-deployment.md','public/local-installation/index.html'])if(!files.includes(required))throw new Error(`Track publication files before packaging: ${required}`);
  const dirty=execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'});if(dirty.trim())throw new Error('Commit reviewed source files before packaging');
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const stage=mkdtempSync(join(tmpdir(),'docs-source-')),name='contract-docs-0.3.1',folder=join(stage,name),entries=[];
  try {
    mkdirSync(folder);
    const add=(path,bytes)=>{assertPublishable(path,bytes);mkdirSync(dirname(join(folder,path)),{recursive:true});writeFileSync(join(folder,path),bytes,{mode:0o644});entries.push({path,bytes:bytes.length,sha256:sha(bytes)});};
    for(const file of files){
      add(file,execFileSync('git',['show',`${commit}:${file}`],{cwd:root,maxBuffer:10*1024*1024}));
      const mode=execFileSync('git',['ls-files','-s','--',file],{cwd:root,encoding:'utf8'}).slice(0,6);
      if(mode==='100755')chmodSync(join(folder,file),0o755);
      else if(mode!=='100644')throw new Error(`Unsupported source file mode: ${file}`);
    }
    add('README.md',Buffer.from('# Договоры и риски — исходная поставка 0.3.1\n\nНачните с [инструкции](references/local-deployment.md).\n\nЛокальные модели пока не реализованы. Зависимости, веса, пользовательские данные и секреты не включены.\n'));
    add('SOURCE-REVISION.txt',Buffer.from(commit+'\n'));
    writeFileSync(join(folder,'MANIFEST.sha256'),entries.map(e=>`${e.sha256}  ${e.path}`).join('\n')+'\n');
    const out=join(root,'public/downloads');mkdirSync(out,{recursive:true});const filename=name+'.tar.gz';
    execFileSync('tar',['--format=ustar','--no-xattrs','--no-acls','-czf',join(out,filename),'-C',stage,name],{env:{...process.env,COPYFILE_DISABLE:'1'}});
    const archive=readFileSync(join(out,filename)),archiveHash=sha(archive);
    writeFileSync(join(out,filename+'.sha256'),`${archiveHash}  ${filename}\n`);
    writeFileSync(join(out,'manifest.json'),JSON.stringify({version:'0.3.1',sourceCommit:commit,archive:filename,bytes:archive.length,sha256:archiveHash,files:entries},null,2)+'\n');
    console.log(JSON.stringify({filename,bytes:archive.length,sha256:archiveHash,sourceCommit:commit,files:entries.length}));
  }finally{rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--bundle'))buildBundle();else buildDocuments();
}
