// Opt-in live acceptance. No user documents and no durable organization records.
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {createApp} from '../server/main.mjs';
if(process.env.DOCS_LIVE_ORGANIZATION_SMOKE!=='1'||!process.env.DOCS_SHARED_CODEX_HOME?.endsWith('/codex/application'))throw new Error('Explicit live smoke and application credential path required');
const root=await mkdtemp(join(tmpdir(),'docs-organization-live-'));
let app;
try{
  app=await createApp({dir:join(root,'data'),runtime:join(root,'runtime'),autoTick:false});
  app.runner.home=()=>process.env.DOCS_SHARED_CODEX_HOME;
  const runId=randomUUID();console.log(JSON.stringify({runId,status:'START',scope:'public INN only'}));
  const result=await app.runner.organizationLookup('live-public-inn-smoke',runId,'7707083893',()=>true,summary=>console.log(JSON.stringify({runId,eventSummary:summary})));
  assert.equal(result.inn,'7707083893');assert.ok(result.name);assert.ok(result.sources.length);
  assert.deepEqual(await readdir(app.runner.lookupRoot),[]);
  console.log(JSON.stringify({runId,status:'PASS',inn:result.inn,name:result.name,sourceCount:result.sources.length,sourceUrls:[...new Set(result.sources.map(s=>s.url))],note:result.note,disclaimer:'Live search result only, not independently verified registry extract; nothing saved in service'}));
}finally{if(app)await app.close();await rm(root,{recursive:true,force:true});}
