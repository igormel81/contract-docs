import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rules } from '../server/rules.mjs';
// Structure only. Whether a rule actually fires is checked by npm run rules:eval
// against the real model; the suite itself stays deterministic and offline.
const dir = fileURLToPath(new URL('./rules/', import.meta.url));
test('every rule in coverage has fixtures with a case that must not raise a finding', async () => {
  const files = (await readdir(dir)).filter(name => name.endsWith('.json'));
  const expected = rules.filter(r => r.coverage !== false).map(r => r.id).sort();
  assert.deepEqual(files.map(name => name.replace('.json', '')).sort(), expected, 'One fixture file per rule that takes part in coverage');
  for (const name of files) {
    const data = JSON.parse(await readFile(join(dir, name), 'utf8'));
    assert.equal(data.rule, name.replace('.json', ''), `${name}: rule matches the file name`);
    assert.ok(Array.isArray(data.cases) && data.cases.length >= 5, `${name}: at least five cases`);
    assert.ok(data.cases.some(c => c.expect === 'no_finding'), `${name}: at least one case where a finding would be a false alarm`);
    assert.ok(data.cases.some(c => c.expect === 'finding'), `${name}: at least one case that must raise a finding`);
    for (const item of data.cases) {
      assert.ok(['finding', 'no_finding'].includes(item.expect), `${name}: expect is finding or no_finding`);
      assert.ok(typeof item.text === 'string' && item.text.trim().length >= 20, `${name}: every case needs a readable fragment`);
      assert.ok(typeof item.why === 'string' && item.why.trim().length >= 10, `${name}: every case explains itself`);
    }
  }
});
