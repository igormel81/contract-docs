import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

// Exact public allowlist. Never resolve a user-provided filesystem path.
const assets=new Map([
  ['/docs/downloads/contract-docs-0.3.1.tar.gz',['downloads/contract-docs-0.3.1.tar.gz','application/gzip','contract-docs-0.3.1.tar.gz']],
  ['/docs/downloads/contract-docs-0.3.1.tar.gz.sha256',['downloads/contract-docs-0.3.1.tar.gz.sha256','text/plain; charset=utf-8','contract-docs-0.3.1.tar.gz.sha256']],
  ['/docs/local-installation/',['local-installation/index.html','text/html; charset=utf-8']],
  ['/docs/local-installation/publication.css',['local-installation/publication.css','text/css; charset=utf-8']],
  ...['architecture','deployment','normative'].flatMap(name=>[
    [`/docs/local-installation/${name}.html`,[`local-installation/${name}.html`,'text/html; charset=utf-8']],
    [`/docs/local-installation/${name}.md`,[`local-installation/${name}.md`,'text/markdown; charset=utf-8',`${name}.md`]]
  ]),
  ['/docs/downloads/contract-docs-0.2.1.tar.gz',['downloads/contract-docs-0.2.1.tar.gz','application/gzip','contract-docs-0.2.1.tar.gz']],
  ['/docs/downloads/contract-docs-0.2.1.tar.gz.sha256',['downloads/contract-docs-0.2.1.tar.gz.sha256','text/plain; charset=utf-8','contract-docs-0.2.1.tar.gz.sha256']],
  ['/docs/downloads/contract-docs-0.2.2.tar.gz',['downloads/contract-docs-0.2.2.tar.gz','application/gzip','contract-docs-0.2.2.tar.gz']],
  ['/docs/downloads/contract-docs-0.2.2.tar.gz.sha256',['downloads/contract-docs-0.2.2.tar.gz.sha256','text/plain; charset=utf-8','contract-docs-0.2.2.tar.gz.sha256']],
  ['/docs/downloads/contract-docs-0.3.0.tar.gz',['downloads/contract-docs-0.3.0.tar.gz','application/gzip','contract-docs-0.3.0.tar.gz']],
  ['/docs/downloads/contract-docs-0.3.0.tar.gz.sha256',['downloads/contract-docs-0.3.0.tar.gz.sha256','text/plain; charset=utf-8','contract-docs-0.3.0.tar.gz.sha256']],
  ['/docs/downloads/manifest.json',['downloads/manifest.json','application/json; charset=utf-8']]
]);
export async function servePublication(req,res,path,root){
  if(!['GET','HEAD'].includes(req.method))return false;
  if(path==='/docs/local-installation'){res.writeHead(308,{Location:'/docs/local-installation/'});res.end();return true;}
  const item=assets.get(path);if(!item)return false;
  try{
    const bytes=await readFile(join(root,'public',item[0]));
    res.setHeader('Content-Type',item[1]);res.setHeader('Content-Length',bytes.length);
    if(item[2])res.setHeader('Content-Disposition',`attachment; filename="${item[2]}"`);
    res.writeHead(200);res.end(req.method==='HEAD'?undefined:bytes);
  }catch(e){if(e.code!=='ENOENT')throw e;res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8'});res.end(req.method==='HEAD'?undefined:'Материал ещё не собран. Обратитесь к администратору.');}
  return true;
}
