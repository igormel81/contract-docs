import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRESSIVE_PHASES,
  applyProgressEvent,
  createProgressiveAnalysis,
  nextProgressivePhase,
  toPublicProgress
} from '../server/progressive-analysis.mjs';

const at = n => `2026-09-07T10:00:0${n}.000Z`;
const started = (id, phase, n) => ({ id, type: 'phase_started', phase, at: at(n) });
const result = (id, phase, n, output = {}) => ({ id, type: 'phase_result', phase, at: at(n), output });

function advance(state, phase, n, output = {}) {
  state = applyProgressEvent(state, started(`${phase}-start-${n}`, phase, n));
  return applyProgressEvent(state, result(`${phase}-result-${n}`, phase, n + 1, output));
}

function readyForReview() {
  let state = createProgressiveAnalysis({ analysisId: 'analysis-1', at: at(0) });
  state = advance(state, 'qualification', 1, {
    qualifications: [{ type: 'services', confidence: 'high', _scratch: 'model-only' }]
  });
  state = advance(state, 'contract_risks', 3, {
    findings: [
      { id: 'risk-1', title: 'Неустойка', severity: 'high' },
      { id: 'risk-2', title: 'Срок оплаты', severity: 'medium' }
    ]
  });
  return advance(state, 'legal_modules', 5, {
    legalModules: [{ id: 'civil-code', status: 'checked' }],
    findings: [{ id: 'risk-2', legalType: 'dispositive_unfavorable' }]
  });
}

test('enforces qualification -> contract risks -> legal modules -> review', () => {
  assert.deepEqual(PROGRESSIVE_PHASES, ['qualification', 'contract_risks', 'legal_modules', 'review']);
  const state = createProgressiveAnalysis({ analysisId: 'analysis-1', at: at(0) });

  assert.equal(nextProgressivePhase(state), 'qualification');
  assert.throws(
    () => applyProgressEvent(state, started('too-early', 'contract_risks', 1)),
    /qualification/
  );

  const afterQualification = advance(state, 'qualification', 1, {
    qualifications: [{ type: 'services', confidence: 'high' }]
  });
  assert.equal(nextProgressivePhase(afterQualification), 'contract_risks');
  assert.equal(toPublicProgress(afterQualification).result.qualifications[0].type, 'services');
  assert.deepEqual(toPublicProgress(afterQualification).result.findings, []);
});

test('does not publish contract findings or legal modules in an earlier phase', () => {
  let state = createProgressiveAnalysis({ analysisId: 'analysis-1', at: at(0) });
  state = applyProgressEvent(state, started('qualification-start', 'qualification', 1));
  assert.throws(
    () => applyProgressEvent(state, result('qualification-with-risk', 'qualification', 2, {
      qualifications: [{ type: 'services' }], findings: [{ id: 'risk-1' }]
    })),
    /findings.*qualification/
  );

  state = applyProgressEvent(state, result('qualification-result', 'qualification', 2, {
    qualifications: [{ type: 'services' }]
  }));
  state = applyProgressEvent(state, started('contract-start', 'contract_risks', 3));
  assert.throws(
    () => applyProgressEvent(state, result('contract-with-module', 'contract_risks', 4, {
      findings: [{ id: 'risk-1' }], legalModules: [{ id: 'civil-code' }]
    })),
    /legalModules.*contract_risks/
  );
});

test('appends and upserts published collections by stable keys without reordering them', () => {
  let state = createProgressiveAnalysis({ analysisId: 'analysis-1', at: at(0) });
  state = advance(state, 'qualification', 1, {
    qualifications: [{ type: 'services', confidence: 'medium' }]
  });
  state = advance(state, 'contract_risks', 3, {
    findings: [{ id: 'risk-1', title: 'Неустойка', severity: 'high' }]
  });
  state = advance(state, 'legal_modules', 5, {
    qualifications: [{ type: 'services', confidence: 'high' }],
    findings: [
      { id: 'risk-1', legalType: 'dispositive_unfavorable' },
      { id: 'risk-2', title: 'Персональные данные', severity: 'medium' }
    ],
    legalModules: [{ id: 'civil-code', status: 'checked' }]
  });

  const publicState = toPublicProgress(state);
  assert.deepEqual(publicState.result.qualifications, [{ type: 'services', confidence: 'high' }]);
  assert.deepEqual(publicState.result.findings.map(item => item.id), ['risk-1', 'risk-2']);
  assert.deepEqual(publicState.result.findings[0], {
    id: 'risk-1', title: 'Неустойка', severity: 'high', legalType: 'dispositive_unfavorable'
  });
});

test('replaying an event is idempotent and a conflicting reuse of its id is rejected', () => {
  const initial = createProgressiveAnalysis({ analysisId: 'analysis-1', at: at(0) });
  const event = started('qualification-start', 'qualification', 1);
  const once = applyProgressEvent(initial, event);
  const twice = applyProgressEvent(JSON.parse(JSON.stringify(once)), event);

  assert.deepEqual(twice, once);
  assert.throws(
    () => applyProgressEvent(once, { ...event, phase: 'contract_risks' }),
    /другим содержимым/
  );
});

test('records one phase failure, preserves published data and permits a retry', () => {
  let state = createProgressiveAnalysis({ analysisId: 'analysis-1', at: at(0) });
  state = advance(state, 'qualification', 1, {
    qualifications: [{ type: 'services', confidence: 'high' }]
  });
  state = applyProgressEvent(state, started('risk-start-1', 'contract_risks', 3));
  state = applyProgressEvent(state, {
    id: 'risk-failure-1', type: 'phase_failed', phase: 'contract_risks', at: at(4),
    error: { code: 'MODEL_TIMEOUT', message: 'Истекло время', retryable: true, stack: 'internal trace' }
  });

  let publicState = toPublicProgress(state);
  assert.equal(publicState.status, 'error');
  assert.equal(publicState.progress.find(item => item.phase === 'contract_risks').status, 'failed');
  assert.equal(publicState.result.qualifications.length, 1);
  assert.equal(publicState.errors[0].code, 'MODEL_TIMEOUT');
  assert.equal(publicState.history.at(-1).error.stack, undefined);

  state = applyProgressEvent(state, started('risk-start-2', 'contract_risks', 5));
  state = applyProgressEvent(state, result('risk-result-2', 'contract_risks', 6, {
    findings: [{ id: 'risk-1', title: 'Неустойка' }]
  }));
  publicState = toPublicProgress(state);
  assert.equal(publicState.status, 'running');
  assert.equal(publicState.progress.find(item => item.phase === 'contract_risks').attempts, 2);
  assert.equal(publicState.errors.length, 1, 'failure stays explainable after retry');
});

test('review rejects and corrects without removing published findings, then finalizes', () => {
  let state = readyForReview();
  state = applyProgressEvent(state, started('review-start', 'review', 7));
  state = applyProgressEvent(state, result('review-result', 'review', 8, {
    decisions: [
      { id: 'risk-1', verdict: 'rejected', reason: 'Условие относится к другой стороне' },
      { id: 'risk-2', verdict: 'corrected', reason: 'Уточнена критичность', patch: { severity: 'low' } }
    ]
  }));

  let publicState = toPublicProgress(state);
  assert.deepEqual(publicState.result.findings.map(item => item.id), ['risk-1', 'risk-2']);
  assert.deepEqual(publicState.result.findings[0].reviewDecision, {
    verdict: 'rejected', reason: 'Условие относится к другой стороне', at: at(8)
  });
  assert.equal(publicState.result.findings[1].severity, 'low');
  assert.equal(publicState.history.at(-1).changes.find(change => change.key === 'risk-2').before.severity, 'medium');

  state = applyProgressEvent(state, { id: 'final', type: 'analysis_finalized', at: '2026-09-07T10:00:09.000Z' });
  publicState = toPublicProgress(state);
  assert.equal(publicState.status, 'complete');
  assert.equal(publicState.final, true);
  assert.equal(nextProgressivePhase(state), null);
});

test('public projection is JSON-safe and excludes reducer bookkeeping and private fields', () => {
  const publicState = toPublicProgress(readyForReview());
  const encoded = JSON.stringify(publicState);

  assert.equal(publicState.final, false);
  assert.equal(publicState.currentPhase, 'review');
  assert.ok(!encoded.includes('_processedEvents'));
  assert.ok(!encoded.includes('_scratch'));
  assert.ok(!encoded.includes('schemaVersion'));
  assert.deepEqual(JSON.parse(encoded), publicState);
});

test('cannot finalize before review or delete a previously published item', () => {
  const state = readyForReview();
  assert.throws(
    () => applyProgressEvent(state, { id: 'final-too-soon', type: 'analysis_finalized', at: at(7) }),
    /review/
  );
  const reviewing = applyProgressEvent(state, started('review-start', 'review', 7));
  assert.throws(
    () => applyProgressEvent(reviewing, result('review-delete', 'review', 8, {
      findings: [{ id: 'risk-1', deleted: true }]
    })),
    /удалять/
  );
});
