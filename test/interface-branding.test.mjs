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

test('document logo replaces the letter mark and is a self-contained SVG',async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const svg=await readFile(new URL('../public/logo.svg',import.meta.url),'utf8');
  assert.doesNotMatch(app,/<span class="mark"[^>]*>Д<\/span>/);
  assert.equal([...app.matchAll(/<img class="mark" src="\/docs\/logo.svg" width="30" height="34" alt="" aria-hidden="true">/g)].length,2);
  assert.match(html,/<link rel="icon" href="\/docs\/logo.svg" type="image\/svg\+xml">/);
  assert.match(svg,/viewBox="0 0 30 34"/);
  assert.doesNotMatch(svg,/<(?:script|foreignObject|image|use|style)\b|\bon\w+=|\bhref=|url\(/i);
});

test('public introduction explains audience, benefits and current AI limitations',async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const login=app.slice(app.indexOf('function loginView()'),app.indexOf('function loginView()')+6000);
  assert.match(login,/aria-labelledby="promo-title"/);
  assert.match(login,/Для подрядчиков, юристов и руководителей проектов/);
  assert.match(login,/со ссылками на исходные пункты/);
  assert.match(login,/отдельным ревью/);
  assert.match(login,/Разовая проверка без добавления в хранилище/);
  assert.match(login,/не заменяет юридическую экспертизу/);
  assert.match(login,/текст передаётся в Codex/);
  assert.ok(login.indexOf('promo-title')<login.indexOf('data-form="auth"'));
});
