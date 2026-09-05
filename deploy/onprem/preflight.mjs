import {execFileSync} from 'node:child_process';
import {accessSync,constants} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {extract} from '../../server/documents.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const version=process.versions.node.split('.').map(Number);
if(version[0]<22 || (version[0]===22&&version[1]<13))throw new Error('Node >=22.13 required');
const db=new DatabaseSync(':memory:');db.close();
for(const binary of ['/usr/bin/node','/usr/bin/python3','/usr/bin/bwrap','/usr/bin/pdftotext','/usr/bin/antiword'])accessSync(binary,constants.X_OK);
const dir=await mkdtemp(join(tmpdir(),'docs-preflight-'));
try {
  const file=join(dir,'synthetic.docx');
  const bytes=execFileSync('/usr/bin/python3',['-c',`import io,sys,zipfile
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>1.1. Synthetic installation check.</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())`]);
  await writeFile(file,bytes,{mode:0o600});
  const result=await extract(file,'docx',true);
  if(result.status!=='ready'||!result.extraction.blocks.some(b=>b.text.includes('Synthetic installation check')))throw new Error('Sandboxed extraction failed. Check bubblewrap/user namespaces; do not disable isolation.');
}finally{await rm(dir,{recursive:true,force:true});}
console.log('PASS Node, SQLite, dependencies and real sandboxed DOCX extraction.');
console.log('Model access, HTTPS and OS-level deployment still require separate acceptance checks.');
