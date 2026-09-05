import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const exec=promisify(execFile),script=fileURLToPath(new URL('../server/extract.py',import.meta.url));
const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Tools are deterministic local fakes, never real documents or network services.
// Real Poppler/Tesseract quality and a Linux no-egress sandbox remain acceptance gates.
async function fixture(config,missing=[]){
  const root=await mkdtemp(join(tmpdir(),'docs-ocr-test-')),bin=join(root,'bin'),scratch=join(root,'scratch'),source=join(root,'input.pdf');
  await mkdir(bin);await mkdir(scratch);
  await writeFile(source,'%PDF-1.4\nsynthetic OCR input; original bytes stay unchanged\n');
  const configPath=join(root,'config.json'),log=join(root,'calls.jsonl');
  await writeFile(configPath,JSON.stringify(config));
  const program=`#!${python}
import json,os,pathlib,sys,time
config=json.loads(pathlib.Path(${JSON.stringify(configPath)}).read_text())
tool=pathlib.Path(sys.argv[0]).name
with open(${JSON.stringify(log)},'a') as out:out.write(json.dumps({'tool':tool,'args':sys.argv[1:],'pid':os.getpid()})+'\\n')
if tool=='pdftotext':
 sys.stdout.write('\\f'.join(config.get('pages',['']))+'\\f')
elif tool=='pdftoppm':
 raster=pathlib.Path(sys.argv[-1]+'.pgm')
 if config.get('oversized_raster'):
  with raster.open('wb') as out:out.truncate(17000000)
 else:raster.write_bytes(b'P5\\n1 1\\n255\\n\\xff')
elif tool=='tesseract' and '--list-langs' in sys.argv:
 print('List of available languages:');print('\\n'.join(config.get('languages',['rus','eng'])))
elif tool=='tesseract':
 page=pathlib.Path(sys.argv[1]).stem.split('-')[-1]
 time.sleep(config.get('delay',0))
 if config.get('failure'):sys.stderr.write('private synthetic tool diagnostic');sys.exit(1)
 print(config.get('ocr',{}).get(page,''))
elif tool=='antiword':
 print('6.2. Москва.\\n\\n6.3. Оплата по акту.')
`;
  for(const name of ['pdftotext','pdftoppm','tesseract','antiword'])if(!missing.includes(name))await writeFile(join(bin,name),program,{mode:0o700});
  const original=hash(await readFile(source));
  return {root,bin,source,scratch,log,
    async run(enabled=true,overrides={}){
      let args=[script,source,'pdf',...(enabled?['--ocr']:[])];
      if(Object.keys(overrides).length)args=['-c',`import json,runpy,sys
m=runpy.run_path(sys.argv[1]);m['main'].__globals__.update(json.loads(sys.argv[3]))
try:print(json.dumps(m['main'](sys.argv[2],'pdf',ocr=True),ensure_ascii=False))
except ValueError as e:print(json.dumps({'blocks':[],'warnings':[str(e)]},ensure_ascii=False));sys.exit(1)`,script,source,JSON.stringify(overrides)];
      let result;try{result=await exec(python,args,{env:{PATH:bin,TMPDIR:scratch,LANG:'C.UTF-8'},timeout:10000,maxBuffer:5*1024*1024});}
      catch(error){result=error;}
      assert.ok(result.stdout,'Extractor must return a structured result');
      assert.equal(hash(await readFile(source)),original,'The original PDF is never rewritten');
      assert.deepEqual(await readdir(scratch),[],'All OCR scratch files are removed');
      return {code:result.code||0,...JSON.parse(result.stdout)};
    },
    async calls(){try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{return []; }},
    async close(){await rm(root,{recursive:true,force:true});}
  };
}

test('OCR is opt-in; native text and original clause numbering remain unchanged',async()=>{
  const f=await fixture({pages:['6.2. Москва.\n\n6.3. Оплата по акту.']},['tesseract','pdftoppm']);
  try{
    const ordinary=await f.run(false),enabled=await f.run(true);
    assert.equal(ordinary.code,0);assert.equal(enabled.code,0);assert.deepEqual(enabled.blocks,ordinary.blocks);
    assert.deepEqual(enabled.ocr.pages,[]);assert.equal(enabled.ocr.reviewRequired,false);
    assert.deepEqual((await f.calls()).map(x=>x.tool),['pdftotext','pdftotext']);
    assert.deepEqual(enabled.blocks.map(x=>x.locator.number),['6.2','6.3']);
  }finally{await f.close();}
});

test('mixed PDF uses OCR only for missing pages, preserves order and literal numbers, marks review',async()=>{
  const f=await fixture({pages:['1. Первый пункт.','','3. Последний пункт.'],ocr:{2:'2.1. Оплата 15 000 рублей до 03.09.2026.\n\n2.2. Таблица: этап и срок.'}});
  try{
    const result=await f.run();assert.equal(result.code,0);
    assert.deepEqual(result.blocks.map(x=>x.locator.number),['1','2.1','2.2','3']);
    assert.deepEqual(result.blocks.map(x=>x.page),[1,2,2,3]);assert.deepEqual(result.ocr.pages,[2]);
    assert.equal(result.blocks[1].locator.status,'uncertain');assert.equal(result.blocks[1].locator.reviewRequired,true);
    assert.deepEqual(result.blocks[1].ocrPages,[2]);assert.equal(result.blocks[0].ocrPages,undefined);
    assert.match(result.warnings.join(' '),/номера пунктов, суммы, даты/);assert.match(result.warnings.join(' '),/таблиц.*не гарантируются/);
    const calls=await f.calls(),render=calls.filter(x=>x.tool==='pdftoppm');assert.equal(render.length,1);
    assert.equal(render[0].args[1],'2');assert.equal(render[0].args[3],'2');assert.ok(render[0].args.includes('3200'));
    assert.ok(calls.find(x=>x.tool==='tesseract'&&x.args.includes('rus+eng')));
  }finally{await f.close();}
});

test('missing local tools or Russian language report an actionable error without downloading',async()=>{
  for(const [config,missing,pattern] of [[{pages:[''],ocr:{1:'1. Текст.'}},['tesseract'],/tesseract.*не установлен/],
    [{pages:[''],ocr:{1:'1. Текст.'}},['pdftoppm'],/pdftoppm.*не установлен/],
    [{pages:[''],languages:['eng']},[],/языки Tesseract rus\+eng недоступны/],
    [{pages:['']},['pdftotext'],/pdftotext.*не установлен/]]){
    const f=await fixture(config,missing);try{const result=await f.run();assert.equal(result.code,1);assert.deepEqual(result.blocks,[]);assert.match(result.warnings.join(' '),pattern);assert.match(result.warnings.join(' '),/автоматическая загрузка отключена/);}finally{await f.close();}
  }
});

test('OCR rejects excessive scan pages, empty recognition and command failures without partial text',async()=>{
  for(const [config,pattern] of [[{pages:Array(11).fill('')},/лимит пилота.*10 страниц/],
    [{pages:Array(201).fill('1. Текст.')},/лимит пилота.*201/],
    [{pages:['1. Есть текст.',''],ocr:{2:''}},/Страница 2: OCR не обнаружил текст/],
    [{pages:[''],failure:true},/не завершил обработку/],
    [{pages:[''],oversized_raster:true},/не завершил обработку|безопасный размер/]]){
    const f=await fixture(config);try{const result=await f.run();assert.equal(result.code,1);assert.deepEqual(result.blocks,[]);assert.match(result.warnings.join(' '),pattern);assert.doesNotMatch(result.warnings.join(' '),/private synthetic/);}finally{await f.close();}
  }
});

test('OCR timeout kills the child and cleans its raster; total deadline is enforced',async()=>{
  const f=await fixture({pages:[''],ocr:{1:'1. Текст.'},delay:5});
  try{
    const result=await f.run(true,{OCR_COMMAND_SECONDS:2});assert.equal(result.code,1);assert.match(result.warnings.join(' '),/превышено время/);
    const child=(await f.calls()).find(x=>x.tool==='tesseract'&&x.args.includes('stdout'));
    assert.ok(child);assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
    const exhausted=await f.run(true,{OCR_TOTAL_SECONDS:0});assert.equal(exhausted.code,1);assert.match(exhausted.warnings.join(' '),/общий лимит времени/);
  }finally{await f.close();}
});

test('SIGTERM cancels OCR, kills its command and removes temporary images',async()=>{
  const f=await fixture({pages:[''],ocr:{1:'1. Текст.'},delay:30});
  const child=spawn(python,[script,f.source,'pdf','--ocr'],{env:{PATH:f.bin,TMPDIR:f.scratch,LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  const finished=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
  let command;
  try{
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      command=(await f.calls()).find(x=>x.tool==='tesseract'&&x.args.includes('stdout'));
      if(command)break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(command,'Wait for OCR to start before testing cancellation');
    child.kill('SIGTERM');
    const result=await finished;assert.equal(result.code,1);assert.equal(stderr,'');
    assert.match(JSON.parse(stdout).warnings.join(' '),/OCR отменён/);
    assert.deepEqual(JSON.parse(stdout).blocks,[]);assert.deepEqual(await readdir(f.scratch),[]);
    assert.throws(()=>process.kill(command.pid,0),{code:'ESRCH'});
  }finally{child.kill('SIGKILL');await finished;await f.close();}
});

test('OCR flag leaves DOC and DOCX text extraction unchanged and never invokes OCR tools',async()=>{
  const f=await fixture({});
  try{
    const docx=join(f.root,'synthetic.docx');
    // Generated minimal OOXML package, not a user document or downloaded fixture.
    await exec(python,['-c',`import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>6.2. Москва.</w:t></w:r></w:p><w:p><w:r><w:t>6.3. Оплата по акту.</w:t></w:r></w:p></w:body></w:document>')`,docx]);
    for(const [ext,path] of [['doc',f.source],['docx',docx]]){
      const before=hash(await readFile(path)),results=[];
      for(const enabled of [false,true]){
        const out=await exec(python,[script,path,ext,...(enabled?['--ocr']:[])],{env:{PATH:f.bin,TMPDIR:f.scratch,LANG:'C.UTF-8'}});
        results.push(JSON.parse(out.stdout));
      }
      assert.deepEqual(results[0],results[1]);assert.equal(results[1].ocr,undefined);
      assert.deepEqual(results[1].blocks.map(x=>x.locator.number),['6.2','6.3']);
      assert.equal(hash(await readFile(path)),before);
    }
    assert.deepEqual((await f.calls()).map(x=>x.tool),['antiword','antiword']);
    assert.deepEqual(await readdir(f.scratch),[]);
  }finally{await f.close();}
});

test('OCR continuation keeps the source clause and page range without inventing a number',async()=>{
  const f=await fixture({pages:['6.2. Начало пункта.','','7. Следующий пункт.'],ocr:{2:'Продолжение на скане без нового номера.'}});
  try{
    const result=await f.run();assert.equal(result.code,0);
    assert.deepEqual(result.blocks.map(x=>x.locator.number),['6.2','7']);
    assert.equal(result.blocks[0].page,1);assert.equal(result.blocks[0].pageEnd,2);
    assert.equal(result.blocks[0].locator.status,'preserved');
    assert.equal(result.blocks[0].locator.reviewRequired,true);assert.deepEqual(result.blocks[0].ocrPages,[2]);
    assert.match(result.blocks[0].text,/Продолжение на скане/);
  }finally{await f.close();}
});
