import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/main.mjs';
import {includedSource,assertPublishable,renderMarkdown} from '../scripts/publication.mjs';

test('published documentation escapes markup, renders tables, code and source links without external scripts',()=>{
  const result=renderMarkdown('# Test\n\n## Section\n\n<script>alert(1)</script>\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```sh\nprintf "<hello>"\n```\n\n[Guide](<../references/local-deployment.md>)');
  assert.match(result.html,/&lt;script&gt;/);assert.doesNotMatch(result.html,/<script/);
  assert.match(result.html,/<thead>/);assert.match(result.html,/&lt;hello&gt;/);
  assert.match(result.html,/href="deployment.html"/);assert.equal(result.toc.length,2);
});
test('source publication is allowlisted and rejects credential-like material',()=>{
  for(const file of ['server/main.mjs','public/app.js','deploy/onprem/preflight.mjs','references/local-deployment.md'])assert.equal(includedSource(file),true);
  for(const file of ['deploy/route.py','deploy/contract-docs.service','test/vps-smoke.mjs','changelog/(sep-26).md','public/downloads/source.tar.gz','data/contracts.sqlite','.env','auth.json'])assert.equal(includedSource(file),false);
  assert.throws(()=>assertPublishable('data/contracts.sqlite',Buffer.from('x')));
  assert.throws(()=>assertPublishable('server/example.mjs',Buffer.from('sk-'+'x'.repeat(40))));
  assert.doesNotThrow(()=>assertPublishable('server/example.mjs',Buffer.from('no credentials')));
});
test('documents are public while application data and arbitrary source paths stay protected',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'docs-publication-test-'));
  const app=await createApp({dir:join(dir,'data'),runtime:join(dir,'runtime'),origin:'http://127.0.0.1:3107',sandbox:false,autoTick:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  try{
    for(const path of ['/docs/local-installation/','/docs/local-installation/architecture.html','/docs/local-installation/deployment.html','/docs/local-installation/normative.html','/docs/local-installation/publication.css']){
      const res=await fetch(base+path);assert.equal(res.status,200,path);assert.equal(res.headers.get('x-content-type-options'),'nosniff');assert.ok((await res.text()).length>100);
    }
    const head=await fetch(base+'/docs/local-installation/architecture.html',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    const md=await fetch(base+'/docs/local-installation/deployment.md');assert.equal(md.status,200);assert.match(md.headers.get('content-disposition'),/attachment/);assert.match(await md.text(),/не готовая сборка с локальными моделями/);
    for(const path of ['/docs/api/bootstrap','/docs/api/legal-base','/docs/api/codex'])assert.equal((await fetch(base+path)).status,401);
    for(const path of ['/docs/downloads/auth.json','/docs/local-installation/server/main.mjs','/docs/downloads/%2e%2e%2fdata/contracts.sqlite','/docs/local-installation/__proto__'])assert.equal((await fetch(base+path)).status,404);
    assert.equal((await fetch(base+'/docs/local-installation/architecture.html',{method:'POST'})).status,404);
    assert.match(await readFile(new URL('../public/app.js',import.meta.url),'utf8'),/Локальная установка/);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
