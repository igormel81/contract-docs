import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm,readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/main.mjs';
const dir=await mkdtemp(join(tmpdir(),'contract-docs-smoke-'));
const app=await createApp({dir,runtime:process.env.DOCS_TEST_RUNTIME||'/run/contract-docs-verify',origin:'https://igoruan.ru',sandbox:true,autoTick:false});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${app.server.address().port}/docs/api`;
let cookie='';
async function request(path,data){const res=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:'https://igoruan.ru','X-Docs-Request':'1','Content-Type':'application/json',Cookie:cookie},body:data===undefined?undefined:JSON.stringify(data)});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,data:await res.json()};}
try{
 assert.equal((await request('/register',{login:'smoke_test',password:'ephemeral-test-only'})).status,200);
 const organization=await request('/organizations',{name:'Синтетический исполнитель'});assert.equal(organization.status,201);
 const packet=await request('/quick-checks',{contractor:organization.data.id});assert.equal(packet.status,201);
 const docx=execFileSync('/usr/bin/python3',['-c',`import io,zipfile,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Test contract software delivery.</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())`]);
 const stream='BT /F1 12 Tf 40 80 Td (Software implementation contract.) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const start=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
 const files=[['sample.docx',docx],['sample.pdf',Buffer.from(pdf)],['sample.doc',await readFile(process.env.DOCS_TEST_DOC||'/tmp/docs-smoke.doc')]];
 for(const [name,bytes] of files){const res=await fetch(base+'/quick-checks/'+packet.data.id+'/files',{method:'POST',headers:{Origin:'https://igoruan.ru','X-Docs-Request':'1','X-File-Name':name,Cookie:cookie},body:bytes});const value=await res.json();assert.equal(res.status,201,JSON.stringify(value));assert.equal(value.file.status,'ready',JSON.stringify(value));assert.ok(value.file.extraction.blocks.length);console.log('PASS isolated extraction: '+name);}
 assert.deepEqual(await readdir(app.quick.root),[]);assert.equal(app.db.prepare('SELECT count(*) n FROM contracts').get().n,0);await request('/quick-checks/'+packet.data.id+'/discard',{});
 console.log('PASS Linux temporary PDF/DOC/DOCX extraction, no originals left, catalogue empty. No real documents or Codex account used.');
}finally{await app.close();await rm(dir,{recursive:true,force:true});}
