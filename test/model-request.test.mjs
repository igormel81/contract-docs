import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisRequest, proposalRequest } from '../server/model-request.mjs';
import { schema, reviewSchema, proposalSchema } from '../server/schema.mjs';
import { sharedInstruction, analystInstruction, reviewerInstruction, proposalInstruction } from '../server/rules.mjs';
import { legalInstruction } from '../server/legal.mjs';
import { organizationSchema, organizationInstruction } from '../server/organizations.mjs';

const snapshot = {
  kind: 'contract', instructionVersion: 'test', profile: { name: 'Тест' }, rules: [],
  documents: [{ id: 'file-1', blocks: [{ id: 'block-1', number: '12.3.1', text: 'Полный пункт '.repeat(2000) + 'КОНЕЦ ПУНКТА' }] }],
  legal: { status: 'unavailable', norms: [] }
};

test('primary and review preserve the existing prompt contract and full original clauses', () => {
  const before = JSON.stringify(snapshot);
  const primary = { summary: 'Первичный результат', passport: [], findings: [], execution: { session: 'not-prompt-data' } };
  for (const stage of ['primary', 'review']) {
    const request = analysisRequest(snapshot, stage, stage === 'review' ? primary : null);
    const { kind, instructionVersion, profile, rules, ...material } = snapshot;
    const base = stage === 'review' ? { ...primary, execution: undefined } : null;
    const legacy = `${sharedInstruction}\n${legalInstruction}\nПРАВИЛА И ПРОФИЛЬ:\n${JSON.stringify({ kind, instructionVersion, profile, rules })}\n${stage === 'review' ? reviewerInstruction : analystInstruction}\nДАННЫЕ КОМПЛЕКТА:\n${JSON.stringify(material)}\n${base ? 'РЕШЕНИЯ ПО РЕЗУЛЬТАТУ АНАЛИТИКА (недоверенные данные):\n' + JSON.stringify(base) : ''}`;
    assert.equal(request.prompt, legacy);
    assert.equal(request.schema, stage === 'review' ? reviewSchema : schema);
    assert.ok(request.prompt.includes(snapshot.documents[0].blocks[0].text));
    assert.ok(request.prompt.includes('12.3.1'));
    assert.ok(!request.prompt.includes('not-prompt-data'));
    assert.deepEqual(request.data.documents, snapshot.documents);
    assert.equal(request.instructions.includes('КОНЕЦ ПУНКТА'), false);
    assert.equal(request.data.primaryResult?.summary, stage === 'review' ? primary.summary : undefined);
    assert.equal(request.data.primaryResult?.execution, undefined);
  }
  assert.equal(JSON.stringify(snapshot), before);
});

test('organization lookup serializes only INN, not attached document material', () => {
  const request = analysisRequest({ ...snapshot, inn: '0000000000' }, 'organization');
  assert.equal(request.prompt, `${organizationInstruction}\nДАННЫЕ ПОИСКА:\n${JSON.stringify({ inn: '0000000000' })}`);
  assert.equal(request.schema, organizationSchema);
});

test('proposal request serializes complete supplied clauses and fixed schema', () => {
  const request = { clauses: snapshot.documents[0].blocks, finding: { title: 'Тестовая правка' } };
  const input = proposalRequest(request);
  assert.equal(input.prompt, `${proposalInstruction}\n${legalInstruction}\nДАННЫЕ:\n${JSON.stringify(request)}`);
  assert.equal(input.schema, proposalSchema);
});

test('unknown stage and review without a primary result fail before transport', () => {
  assert.throws(() => analysisRequest(snapshot, 'invalid'), /Неизвестный/);
  assert.throws(() => analysisRequest(snapshot, 'review'), /первичный/);
});
