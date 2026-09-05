import test from 'node:test';
import assert from 'node:assert/strict';
import {wordDiff,legalReferences,legalSnapshotLabel} from '../public/document-ui.js';
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
test('clause comparison preserves long text and marks additions and removals safely',()=>{
  const prefix='6.2. '+('Обязанности сторон согласованы. '.repeat(20));
  const before=prefix+'Оплата 10 дней. <script>нет</script>',after=prefix+'Оплата 30 дней. <script>нет</script>';
  const diff=wordDiff(before,after,esc);
  assert.equal(diff.highlighted,true);assert.match(diff.before,/<del>10<\/del>/);assert.match(diff.after,/<ins>30<\/ins>/);
  assert.equal(diff.before.replace(/<\/?del>/g,''),esc(before));assert.equal(diff.after.replace(/<\/?ins>/g,''),esc(after));
  assert.ok(!diff.before.includes('<script>'));
  const huge=('пункт '.repeat(1000))+'Последнее условие';
  const fallback=wordDiff(huge,huge+' изменено',esc);
  assert.equal(fallback.highlighted,false);assert.equal(fallback.before,huge);assert.equal(fallback.after,huge+' изменено');
});
test('normative references retain status and only link to official HTTPS sources',()=>{
  const cards=[{title:'ГК РФ',article:'702',sourceUrl:'https://pravo.gov.ru/proxy/ips/?docbody',quote:'<обязанность>',verificationStatus:'reference_only'},{title:'Подмена',sourceUrl:'javascript:alert(1)'},{title:'Подмена домена',sourceUrl:'https://pravo.gov.ru.example.org/'}];
  const html=legalReferences(cards,esc);
  assert.equal((html.match(/<a /g)||[]).length,1);assert.match(html,/Редакция требует проверки/);assert.match(html,/&lt;обязанность&gt;/);
  assert.ok(!html.includes('javascript:'));assert.match(legalSnapshotLabel(null),/не была прикреплена/);
  assert.match(legalSnapshotLabel({status:'reference_only'}),/не подтверждена/);
});
