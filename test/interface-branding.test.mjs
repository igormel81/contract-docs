import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('interface uses user organizations without built-in companies',async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(app+html,/Кастис|Модеус/i);

  assert.ok(app.includes("select('contractor','Подрядчик',Object.entries(state.boot.profiles)"));
  const quick=await readFile(new URL('../public/quick.js',import.meta.url),'utf8');
  assert.ok(quick.includes('id="quick-contractor"'));
  assert.ok(quick.includes('Object.entries(this.getBoot().profiles)'));
  const rules=await readFile(new URL('../server/rules.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(rules+quick,/Кастис|Модеус|custis|modeus|Обе компании/i);
});
