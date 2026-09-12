import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { id, now } from './db.mjs';
import { HttpError, choice, hash, required, body } from './security.mjs';
import { format, extract } from './documents.mjs';
import { rules, instructionVersion } from './rules.mjs';
import { withLegalContext } from './legal.mjs';
import { applyProgressEvent, createProgressiveAnalysis, toPublicProgress } from './progressive-analysis.mjs';

const active = p => ['queued','qualification','primary','contract_risks','legal_modules','review'].includes(p.status);
const hour = 60 * 60 * 1000;

// Deliberately no database dependency: document contents, snapshots and results
// are held in process memory, never in the contract catalogue or its backups.
export class QuickChecks {
  constructor(runner, runtime, sandbox, options = {}) {
    this.runner = runner; this.root = join(runtime, 'quick-checks'); this.sandbox = sandbox;
    this.items = new Map(); this.operations = new Set(); this.uploads = 0;
    this.clock = options.clock || Date.now; this.ttl = options.ttl || hour;
    this.extract = options.extract || extract; this.organizations = options.organizations;
    this.legalCorpus = options.legalCorpus || (() => null);
    runner.temporary = this;
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Only this feature's generated directories, never the runtime root itself.
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (/^(?:upload-[A-Za-z0-9]{6}|job-[a-f0-9-]{36}-[a-f0-9-]{36}-(?:primary|review))$/.test(entry.name)) {
        await rm(join(this.root, entry.name), { recursive: true, force: true });
      }
    }
  }
  own(key, user) {
    const p = this.items.get(key);
    if (!p || p.user !== user || p.deleted) throw new HttpError(404, 'Временный пакет не найден или уже удалён.');
    if (p.expires <= this.clock()) { void this.discard(p).catch(() => {}); throw new HttpError(410,'Срок разовой проверки истёк. Загрузите пакет заново.'); }
    return p;
  }
  view(p) {
    return { id: p.id, contractor: p.contractor, profile: p.profile, status: p.status, created: p.created,
      expires: new Date(p.expires).toISOString(), files: p.files, primary_result: p.primary,
      review_result: p.review, error: p.error, uploading: p.uploading, temporary: true,
      queuedAt: p.queuedAt || null, stageStartedAt: p.stageStartedAt || null, legal: p.legal || null,
      progress: p.progress ? toPublicProgress(p.progress) : null };
  }
  create(user, contractor) {
    if (this.closing) throw new HttpError(503,'Сервис перезапускается. Повторите позже.');
    const profile = this.organizations.snapshot(user,contractor);
    const existing = [...this.items.values()].find(p => p.user === user && !p.deleted && p.expires > this.clock());
    if (existing) throw new HttpError(409,'У вас уже есть временный пакет. Продолжите его или удалите перед новой проверкой.');
    if (this.items.size >= 12) throw new HttpError(429,'Все временные рабочие места заняты. Повторите позже.');
    const p = { id:id(), user, contractor, profile, created:now(), expires:this.clock()+this.ttl, status:'draft', files:[], primary:null, review:null, progress:null, error:null, uploading:false, operations:new Set() };
    this.items.set(p.id,p); return this.view(p);
  }
  list(user) {
    return [...this.items.values()].filter(p=>p.user===user&&!p.deleted&&p.expires>this.clock()).map(p=>this.view(p));
  }
  track(p, operation) {
    p.operations.add(operation); this.operations.add(operation);
    operation.finally(()=>{p.operations.delete(operation);this.operations.delete(operation);}).catch(()=>{});
    return operation;
  }
  upload(p, req) {
    if (p.status !== 'draft' || p.uploading) throw new HttpError(409,'Дождитесь текущей загрузки. После запуска состав пакета изменить нельзя.');
    if (this.uploads+(this.persistedUploads?.()||0) >= 2) throw new HttpError(429,'Сейчас извлекаются другие документы. Повторите загрузку через минуту.');
    p.uploading = true; this.uploads++;
    const operation = (async()=>{
      let folder, bytes;
      try {
        let name; try { name=decodeURIComponent(String(req.headers['x-file-name']||'')); } catch { throw new HttpError(400,'Некорректное имя файла.'); }
        name=required(basename(name.replaceAll('\\','/')),240);
        if (/[\x00-\x1f]/.test(name)) throw new HttpError(400,'Некорректное имя файла.');
        bytes=await body(req,20*1024**2); this.own(p.id,p.user);
        const ext=format(name,bytes), digest=hash(bytes);
        const duplicate=p.files.find(f=>f.hash===digest);
        if (duplicate) return {duplicate:true,file:duplicate};
        if (p.files.length>=20 || p.files.reduce((n,f)=>n+f.size,0)+bytes.length>100*1024**2) throw new HttpError(413,'Разовая проверка: не более 20 файлов и 100 МБ на пакет.');
        folder=await mkdtemp(join(this.root,'upload-'));
        const path=join(folder,'document'); await writeFile(path,bytes,{mode:0o600,flag:'wx'});
        const extracted=await this.extract(path,ext,this.sandbox);
        this.own(p.id,p.user);
        if (!Array.isArray(extracted.extraction?.blocks)) throw new Error('Invalid extraction');
        if (JSON.stringify([...p.files.map(f=>f.extraction),extracted.extraction]).length>360000) throw new HttpError(413,'Пакет превышает 360 000 символов. Текст не обрезан; файл не добавлен.');
        const file={id:id(),name,ext,hash:digest,size:bytes.length,status:extracted.status,extraction:extracted.extraction};
        if (file.status==='error') file.extraction.warnings=['Не удалось прочитать файл. Удалите его из пакета и загрузите исправленную версию. Оригинал не сохраняется.'];
        p.files.push(file); return {duplicate:false,file};
      } finally {
        bytes?.fill(0);
        try { if(folder)await rm(folder,{recursive:true,force:true}); }
        finally { p.uploading=false;this.uploads--; }
      }
    })();
    return this.track(p,operation);
  }
  removeFile(p, file) {
    if (p.status!=='draft'||p.uploading) throw new HttpError(409,'Состав пакета уже зафиксирован или идёт загрузка.');
    if (!p.files.some(f=>f.id===file)) throw new HttpError(404,'Файл не найден.');
    p.files=p.files.filter(f=>f.id!==file);
  }
  async start(p) {
    if (!['draft','error'].includes(p.status)||p.uploading||p.starting) throw new HttpError(409,'Пакет уже проверяется, завершён или ещё загружается.');
    p.starting=true;
    try {
      if (!(await this.runner.status()).connected) throw new HttpError(409,'Общий Codex не подключён. Обратитесь к владельцу приложения.');
      this.own(p.id,p.user);
      if (!p.files.length||p.files.some(f=>f.status!=='ready')) throw new HttpError(400,'Загрузите читаемые документы; удалите файлы с ошибками перед запуском.');
      const documents=p.files.map(f=>({id:f.id,name:f.name,hash:f.hash,...f.extraction}));
      if (JSON.stringify(documents).length>360000) throw new HttpError(413,'Пакет слишком велик: максимум 360 000 символов.');
      p.snapshot=p.snapshot||withLegalContext({analysisContractVersion:'legal-v2',version:1,kind:'contract',profile:p.profile,rules,instructionVersion,documents,created:now(),temporary:true,inference:this.runner.describe?this.runner.describe():null},new Date(),this.legalCorpus());
      p.legal=p.snapshot.legal;
      p.progress=p.progress||createProgressiveAnalysis({analysisId:p.id,at:p.snapshot.created});
      p.status='queued';p.queuedAt=now();p.error=null;
      return this.view(p);
    } finally { p.starting=false; }
  }
  next() {
    return [...this.items.values()].filter(p=>p.status==='queued'&&!p.deleted&&p.expires>this.clock()).sort((a,b)=>a.queuedAt.localeCompare(b.queuedAt))[0];
  }
  run(p) {
    const operation=(async()=>{
      const attempt=id();
      const alive=()=>!this.closing&&!p.deleted&&active(p)&&p.expires>this.clock();
      const context=stage=>({temporary:true,directory:join(this.root,`job-${p.id}-${attempt}-${stage}`),alive});
      try {
        if (!alive()) return;
        const progressive = p.snapshot.analysisContractVersion === 'legal-v2' && p.progress;
        const event = (payload, status) => { p.progress=applyProgressEvent(p.progress,payload); if(status)p.status=status; };
        const start = phase => event({id:`${p.id}:${phase}:start:${id()}`,type:'phase_started',phase,at:now()}, phase==='qualification'?'qualification':phase==='contract_risks'?'contract_risks':phase==='legal_modules'?'legal_modules':'review');
        const done = (phase, output, status) => event({id:`${p.id}:${phase}:result:${id()}`,type:'phase_result',phase,output,at:now()}, status);
        if (progressive) {
          const phaseStatus = phase => p.progress.phases[phase].status;
          let qualification = p.progress.results.qualifications;
          if (phaseStatus('qualification') !== 'completed') {
            start('qualification');
            qualification=await this.runner.execute(p.user,p.id,p.snapshot,'qualification',null,context('qualification'));
            if(!alive())return; qualification=qualification.qualifications; done('qualification',{qualifications:qualification},'running');
          }
          if (phaseStatus('contract_risks') !== 'completed') {
            start('contract_risks');
            if (!p.primary) p.primary=await this.runner.execute(p.user,p.id,p.snapshot,'primary',null,{...context('primary'),preliminaryQualifications:qualification});
            if(!alive())return; done('contract_risks',{qualifications:p.primary.qualifications,findings:p.primary.findings},'running');
          }
          if (phaseStatus('legal_modules') !== 'completed') {
            start('legal_modules');
            const selected=new Set(p.primary.qualifications.flatMap(item=>item.legalModules));
            const modules=(p.snapshot.legal?.modules||[]).filter(module=>selected.has(module.id));
            done('legal_modules',{qualifications:p.primary.qualifications,findings:p.primary.findings,legalModules:modules},'review');
          }
          if (phaseStatus('review') !== 'completed') {
            start('review');
            p.review=await this.runner.execute(p.user,p.id,p.snapshot,'review',p.primary,context('review'));
          }
          if(!alive())return;
          const reviewed=new Map(p.review.findings.map(item=>[item.id,item]));
          const decisions=p.primary.findings.map(item=>{const next=reviewed.get(item.id);if(!next)return{id:item.id,verdict:'rejected',reason:'Отклонено ревьюером.'};const changed=JSON.stringify({...item,review:undefined})!==JSON.stringify({...next,review:undefined});return{id:item.id,verdict:changed?'corrected':'confirmed',reason:changed?'Уточнено ревьюером.':'Подтверждено ревьюером.',...(changed?{patch:next}:{})};});
          done('review',{findings:p.review.findings,decisions},'awaiting_finalization');
          event({id:`${p.id}:final:${id()}`,type:'analysis_finalized',at:now()},'complete');
          p.status='complete';p.snapshot=null;return;
        }
        if (!p.primary) {
          p.status='primary';p.stageStartedAt=now();
          const primary=await this.runner.execute(p.user,p.id,p.snapshot,'primary',null,context('primary'));
          if(!alive())return;p.primary=primary;
        }
        p.status='review';p.stageStartedAt=now();
        const review=await this.runner.execute(p.user,p.id,p.snapshot,'review',p.primary,context('review'));
        if(!alive())return;p.review=review;p.status='complete';p.snapshot=null;
      } catch(e) {
        if(alive()){
          if(p.progress){
            const running=Object.entries(p.progress.phases).find(([,value])=>value.status==='running')?.[0];
            if(running){try{p.progress=applyProgressEvent(p.progress,{id:`${p.id}:${running}:failed:${id()}`,type:'phase_failed',phase:running,error:{code:'MODEL_FAILED',message:e.message,retryable:true},at:now()});}catch{/* keep the user-visible execution error */}}
          }
          p.status='error';p.error=e.message;
        }
      }
    })();
    return this.track(p,operation);
  }
  cancelAll() {
    for(const p of this.items.values()) if(active(p)){p.status='cancelled';p.error='Общее подключение Codex отключено. Скачайте доступный результат или создайте новую проверку.';p.snapshot=null;}
  }
  async discard(p) {
    if(p.deleted)return p.deleting;
    p.deleted=true;p.status='cancelled';
    p.deleting=(async()=>{
      await this.runner.cancel(p.user,p.id);
      await Promise.allSettled([...p.operations]);
      p.files=[];p.primary=null;p.review=null;p.snapshot=null;p.legal=null;p.error=null;
      this.items.delete(p.id);
    })();
    return p.deleting;
  }
  async sweep() {
    await Promise.all([...this.items.values()].filter(p=>p.expires<=this.clock()).map(p=>this.discard(p)));
  }
  async close() {
    this.closing=true;
    await Promise.all([...this.items.values()].map(p=>this.discard(p)));
    await Promise.allSettled([...this.operations]);
  }
}
