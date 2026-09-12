import test from 'node:test';
import assert from 'node:assert/strict';
import { LegalPackagesUI } from '../public/legal-packages-ui.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const btn = (title, action, value = '', cls = '', disabled = false) =>
  `<button data-action="${action}" data-value="${value}" class="${cls}"${disabled ? ' disabled' : ''}>${title}</button>`;
const packageRow = {
  packageId: 'core-1', digest: 'a'.repeat(64), version: 'core-v1', edition: 'edition <unsafe>',
  state: 'staged', legalStatus: 'reference_only', signatureKeyId: 'publisher',
  expiresAt: '2026-10-01T00:00:00Z', reviewDueAt: '2026-09-30', modules: [], importerId: 'importer'
};

function fixture({ canManage = true, response = { packages: [packageRow], history: [], active: null } } = {}) {
  const calls = [], boot = { legalPackages: { canManage } };
  const ui = new LegalPackagesUI({
    esc, btn, getBoot: () => boot, render: () => { calls.push(['render']); },
    api: async (path, data, method) => { calls.push([path, data, method]); return response; }
  });
  return { ui, calls, boot };
}

test('management UI is hidden unless the bootstrap permission allows it', () => {
  const { ui } = fixture({ canManage: false });
  assert.equal(ui.view(), '');
});

test('load is explicit and renders untrusted package fields escaped', async () => {
  const { ui, calls } = fixture();
  assert.match(ui.view(), /Обновить список/);
  assert.equal(calls.length, 0);
  await ui.action('legal-package-load');
  assert.deepEqual(calls.find(call => call[0] === '/legal-packages'), ['/legal-packages', undefined, undefined]);
  assert.match(ui.view(), /edition &lt;unsafe&gt;/);
  assert.match(ui.view(), /Согласовать/);
});

test('import posts parsed JSON only after an explicit button action', async () => {
  const { ui, calls } = fixture({ response: { packageId: 'core-1', digest: 'a'.repeat(64), state: 'staged' } });
  const previous = globalThis.document;
  globalThis.document = { querySelector: () => ({ files: [{ text: async () => '{"packageId":"core-1"}' }] }) };
  try {
    await ui.action('legal-package-import');
    assert.deepEqual(calls[0], ['/legal-packages', { packageId: 'core-1' }, undefined]);
  } finally { globalThis.document = previous; }
});

test('approve and activate send the displayed digest and entered reason', async () => {
  const { ui, calls } = fixture();
  ui.packages = [packageRow, { ...packageRow, packageId: 'core-2', state: 'approved', digest: 'b'.repeat(64) }];
  const previous = globalThis.document;
  globalThis.document = { querySelector: selector => selector.includes('core-1') ? { value: 'Проверено ответственным' } : null };
  try {
    await ui.action('legal-package-approve', 'core-1');
    ui.packages = [packageRow, { ...packageRow, packageId: 'core-2', state: 'approved', digest: 'b'.repeat(64) }];
    await ui.action('legal-package-activate', 'core-2');
  } finally { globalThis.document = previous; }
  assert.deepEqual(calls.find(call => call[0] === '/legal-packages/core-1/approve'), ['/legal-packages/core-1/approve', { digest: 'a'.repeat(64), decision: 'approved', reason: 'Проверено ответственным' }, undefined]);
  assert.deepEqual(calls.find(call => call[0] === '/legal-packages/core-2/activate'), ['/legal-packages/core-2/activate', { digest: 'b'.repeat(64) }, undefined]);
});

test('API errors remain visible in the module', async () => {
  const { ui } = fixture();
  ui.api = async () => { throw new Error('Сервер недоступен'); };
  await ui.action('legal-package-load');
  assert.match(ui.view(), /Сервер недоступен/);
});
