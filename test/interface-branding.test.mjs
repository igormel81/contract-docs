import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('interface names contractors only through their selection lists',async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(app+html,/Кастис|Модеус/i);
  assert.doesNotMatch(app,/profiles\[c\.contractor\]\.name/);
  assert.ok(app.includes("select('contractor','Подрядчик',Object.entries(state.boot.profiles)"));
  const quick=await readFile(new URL('../public/quick.js',import.meta.url),'utf8');
  assert.ok(quick.includes('id="quick-contractor"'));
  assert.ok(quick.includes('Object.entries(this.getBoot().profiles)'));
});
