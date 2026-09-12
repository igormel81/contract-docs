export const PROGRESSIVE_PHASES = Object.freeze([
  'qualification',
  'contract_risks',
  'legal_modules',
  'review'
]);

const COLLECTIONS = Object.freeze({
  qualifications: item => item.type,
  findings: item => item.id,
  legalModules: item => item.id
});
const PHASE_OUTPUTS = Object.freeze({
  qualification: new Set(['qualifications']),
  contract_risks: new Set(['qualifications', 'findings']),
  legal_modules: new Set(['qualifications', 'findings', 'legalModules']),
  review: new Set(['qualifications', 'findings', 'legalModules', 'decisions'])
});
const EVENT_TYPES = new Set(['phase_started', 'phase_result', 'phase_failed', 'analysis_finalized']);
const DELETE_KEYS = new Set(['deleted', '_delete', 'remove']);

const copy = value => structuredClone(value);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} должен быть непустой строкой.`);
  return value;
}

function phaseIndex(phase) {
  const index = PROGRESSIVE_PHASES.indexOf(phase);
  if (index === -1) throw new TypeError(`Неизвестная фаза: ${String(phase)}.`);
  return index;
}

function assertState(state) {
  if (!state || typeof state !== 'object' || state.schemaVersion !== 1 || !state.analysisId || !state.phases || !state.results || !state._processedEvents) {
    throw new TypeError('Некорректное состояние прогрессивного анализа.');
  }
}

function assertPhaseCanStart(state, phase) {
  const index = phaseIndex(phase);
  const firstIncomplete = PROGRESSIVE_PHASES.findIndex(name => state.phases[name].status !== 'completed');
  if (firstIncomplete !== index) {
    const required = firstIncomplete === -1 ? 'finalization' : PROGRESSIVE_PHASES[firstIncomplete];
    throw new Error(`Нельзя начать ${phase}: сначала должна завершиться фаза ${required}.`);
  }
  const status = state.phases[phase].status;
  if (!['pending', 'failed'].includes(status)) throw new Error(`Фаза ${phase} уже ${status}.`);
}

function assertNoDeletion(item) {
  for (const key of DELETE_KEYS) {
    if (item[key] === true) throw new Error('Опубликованные элементы нельзя удалять; ревью должно сохранить решение и его статус.');
  }
}

function mergeCollection(state, collection, incoming) {
  if (!Array.isArray(incoming)) throw new TypeError(`${collection} должен быть массивом.`);
  const getKey = COLLECTIONS[collection];
  const seen = new Set();
  const target = state.results[collection];
  const positions = new Map(target.map((item, index) => [getKey(item), index]));
  const changes = [];

  for (const supplied of incoming) {
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new TypeError(`Элемент ${collection} должен быть объектом.`);
    assertNoDeletion(supplied);
    const item = copy(supplied);
    const key = requiredString(getKey(item), `Стабильный ключ ${collection}`);
    if (seen.has(key)) throw new Error(`Повторяющийся стабильный ключ ${collection}: ${key}.`);
    seen.add(key);
    const position = positions.get(key);
    if (position === undefined) {
      target.push(item);
      positions.set(key, target.length - 1);
      changes.push({ collection, key, operation: 'added', before: null, after: copy(item) });
    } else {
      const before = copy(target[position]);
      const after = { ...target[position], ...item };
      target[position] = after;
      if (canonical(before) !== canonical(after)) changes.push({ collection, key, operation: 'updated', before, after: copy(after) });
    }
  }
  return changes;
}

function applyReviewDecisions(state, decisions, eventAt) {
  if (!Array.isArray(decisions)) throw new TypeError('decisions должен быть массивом.');
  const seen = new Set();
  const positions = new Map(state.results.findings.map((item, index) => [item.id, index]));
  const changes = [];
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new TypeError('Решение ревью должно быть объектом.');
    const id = requiredString(decision.id, 'ID замечания в решении ревью');
    if (seen.has(id)) throw new Error(`Повторяющееся решение ревью для ${id}.`);
    seen.add(id);
    if (!positions.has(id)) throw new Error(`Ревью ссылается на неизвестное замечание ${id}.`);
    if (!['confirmed', 'corrected', 'rejected'].includes(decision.verdict)) throw new Error(`Неизвестный вердикт ревью для ${id}.`);
    const reason = requiredString(decision.reason, 'Причина решения ревью');
    const patch = decision.patch ?? {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Исправление ревью должно быть объектом.');
    assertNoDeletion(patch);
    if (Object.hasOwn(patch, 'id') && patch.id !== id) throw new Error(`Ревью не может изменить стабильный ID ${id}.`);
    if (decision.verdict !== 'corrected' && Object.keys(patch).length) throw new Error('Patch разрешён только для исправленного замечания.');

    const position = positions.get(id);
    const before = copy(state.results.findings[position]);
    state.results.findings[position] = {
      ...state.results.findings[position],
      ...copy(patch),
      id,
      reviewDecision: { verdict: decision.verdict, reason, at: eventAt }
    };
    changes.push({ collection: 'findings', key: id, operation: 'reviewed', before, after: copy(state.results.findings[position]) });
  }
  return changes;
}

function phaseResult(state, event) {
  const phase = requiredString(event.phase, 'Фаза события');
  phaseIndex(phase);
  if (state.phases[phase].status !== 'running') throw new Error(`Результат фазы ${phase} можно принять только после её запуска.`);
  const output = event.output ?? {};
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new TypeError('Результат фазы должен быть объектом.');
  const allowed = new Set([...Object.keys(COLLECTIONS), 'decisions']);
  const unknown = Object.keys(output).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Неизвестные поля результата фазы: ${unknown.join(', ')}.`);
  const premature = Object.keys(output).find(key => !PHASE_OUTPUTS[phase].has(key));
  if (premature) throw new Error(`${premature} нельзя публиковать на фазе ${phase}.`);
  if (output.decisions !== undefined && phase !== 'review') throw new Error('Решения по замечаниям разрешены только на фазе review.');

  const changes = [];
  for (const collection of Object.keys(COLLECTIONS)) {
    if (output[collection] !== undefined) changes.push(...mergeCollection(state, collection, output[collection]));
  }
  if (output.decisions !== undefined) changes.push(...applyReviewDecisions(state, output.decisions, event.at));
  state.phases[phase].status = 'completed';
  state.phases[phase].completedAt = event.at;
  state.phases[phase].error = null;
  state.status = phase === 'review' ? 'awaiting_finalization' : 'running';
  return changes;
}

function eventRecord(event, changes = []) {
  return {
    eventId: event.id,
    type: event.type,
    ...(event.phase ? { phase: event.phase } : {}),
    at: event.at,
    ...(event.error ? { error: {
      code: typeof event.error.code === 'string' ? event.error.code : 'PHASE_FAILED',
      message: event.error.message,
      retryable: event.error.retryable !== false
    } } : {}),
    changes
  };
}

export function createProgressiveAnalysis({ analysisId, at = new Date().toISOString() } = {}) {
  requiredString(analysisId, 'analysisId');
  requiredString(at, 'Время создания');
  return {
    schemaVersion: 1,
    analysisId,
    status: 'running',
    createdAt: at,
    updatedAt: at,
    finalizedAt: null,
    phases: Object.fromEntries(PROGRESSIVE_PHASES.map(phase => [phase, {
      status: 'pending', attempts: 0, startedAt: null, completedAt: null, error: null
    }])),
    results: { qualifications: [], findings: [], legalModules: [] },
    failures: [],
    events: [],
    _processedEvents: {}
  };
}

export function nextProgressivePhase(state) {
  assertState(state);
  return PROGRESSIVE_PHASES.find(phase => state.phases[phase].status !== 'completed') ?? null;
}

export function applyProgressEvent(previous, event) {
  assertState(previous);
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Событие должно быть объектом.');
  const id = requiredString(event.id, 'ID события');
  requiredString(event.at, 'Время события');
  if (!EVENT_TYPES.has(event.type)) throw new TypeError(`Неизвестный тип события: ${String(event.type)}.`);
  const fingerprint = canonical(event);
  if (previous._processedEvents[id] !== undefined) {
    if (previous._processedEvents[id] !== fingerprint) throw new Error(`Событие ${id} повторно получено с другим содержимым.`);
    return previous;
  }
  if (previous.status === 'complete') throw new Error('Финализированный анализ нельзя изменять.');

  const state = copy(previous);
  let changes = [];
  if (event.type === 'phase_started') {
    const phase = requiredString(event.phase, 'Фаза события');
    assertPhaseCanStart(state, phase);
    const phaseState = state.phases[phase];
    phaseState.status = 'running';
    phaseState.attempts += 1;
    phaseState.startedAt = event.at;
    phaseState.completedAt = null;
    phaseState.error = null;
    state.status = 'running';
  } else if (event.type === 'phase_result') {
    changes = phaseResult(state, event);
  } else if (event.type === 'phase_failed') {
    const phase = requiredString(event.phase, 'Фаза события');
    phaseIndex(phase);
    if (state.phases[phase].status !== 'running') throw new Error(`Ошибка фазы ${phase} принимается только для запущенной фазы.`);
    if (!event.error || typeof event.error !== 'object' || Array.isArray(event.error)) throw new TypeError('Ошибка фазы должна быть объектом.');
    const failure = {
      phase,
      code: typeof event.error.code === 'string' ? event.error.code : 'PHASE_FAILED',
      message: requiredString(event.error.message, 'Сообщение об ошибке'),
      retryable: event.error.retryable !== false,
      at: event.at
    };
    state.phases[phase].status = 'failed';
    state.phases[phase].error = copy(failure);
    state.failures.push(failure);
    state.status = 'error';
  } else {
    if (state.phases.review.status !== 'completed') throw new Error('Анализ нельзя финализировать до завершения фазы review.');
    state.status = 'complete';
    state.finalizedAt = event.at;
  }

  state.updatedAt = event.at;
  state.events.push(eventRecord(event, changes));
  state._processedEvents[id] = fingerprint;
  return state;
}

function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, nested]) => [key, publicValue(nested)]));
  }
  return value;
}

export function toPublicProgress(state) {
  assertState(state);
  const currentPhase = nextProgressivePhase(state);
  return publicValue({
    analysisId: state.analysisId,
    status: state.status,
    final: state.status === 'complete',
    currentPhase,
    progress: PROGRESSIVE_PHASES.map(phase => ({ phase, ...state.phases[phase] })),
    result: state.results,
    errors: state.failures,
    history: state.events,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    finalizedAt: state.finalizedAt
  });
}
