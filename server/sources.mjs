import { locationLabel } from '../public/document-ui.js';

export function sourceRecord(source,documents,context={}) {
  const file=documents.find(f=>f.id===source.fileId),block=file?.blocks.find(b=>b.id===source.blockId);
  if(!block)return null;
  const norm=text=>text.replace(/\s+/g,' ').trim();
  if(typeof source.quote!=='string'||norm(source.quote).length<5||!norm(block.text).includes(norm(source.quote)))return null;
  return {fileId:file.id,blockId:block.id,quote:source.quote,location:locationLabel(block),fileName:file.name,fileHash:file.hash,...context};
}
export function resultSources(result,snapshot,analysisId=null) {
  if(!result)return result;
  const context={revisionId:snapshot.revisionId||null,revisionNumber:snapshot.version,analysisId};
  return {...result,passport:result.passport.map(f=>({...f,sources:f.sources.map(s=>sourceRecord(s,snapshot.documents,context)||s)})),findings:result.findings.map(f=>({...f,sources:f.sources.map(s=>sourceRecord(s,snapshot.documents,context)||s)}))};
}
