import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('source numbering: Word lists, overrides, styles, clauses, pages and uncertain numbering',()=>{
  execFileSync('python3',[fileURLToPath(new URL('./extract_test.py',import.meta.url))],{stdio:'pipe'});
});
