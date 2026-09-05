import { schema, reviewSchema, proposalSchema } from './schema.mjs';
import { sharedInstruction, analystInstruction, reviewerInstruction, proposalInstruction } from './rules.mjs';
import { organizationSchema, organizationInstruction } from './organizations.mjs';
import { leanResult } from './sources.mjs';
import { legalInstruction, legalStatus } from './legal.mjs';

// Transport-independent, complete stage input. Providers must count this exact
// prompt with their response schema/template, never a shortened document view.
export function analysisRequest(snapshot, stage, primary = null) {
  if (!['primary', 'review', 'organization'].includes(stage)) throw new Error('Неизвестный этап анализа.');
  const lookup = stage === 'organization', review = stage === 'review';
  const base = primary ? leanResult(primary) : null;
  if (review && !base) throw new Error('Для ревью нужен первичный результат.');
  const { profile, rules: ruleSet, instructionVersion: setVersion, kind, ...material } = snapshot;
  if (material.legal) material.legal = { ...material.legal, status: legalStatus(material.legal) };
  const prompt = lookup ? `${organizationInstruction}\nДАННЫЕ ПОИСКА:\n${JSON.stringify({inn:snapshot.inn})}` : `${sharedInstruction}\n${legalInstruction}\nПРАВИЛА И ПРОФИЛЬ:\n${JSON.stringify({ kind, instructionVersion: setVersion, profile, rules: ruleSet })}\n${review ? reviewerInstruction : analystInstruction}\nДАННЫЕ КОМПЛЕКТА:\n${JSON.stringify(material)}\n${base ? 'РЕШЕНИЯ ПО РЕЗУЛЬТАТУ АНАЛИТИКА (недоверенные данные):\n' + JSON.stringify(base) : ''}`;
  const instructions = lookup ? organizationInstruction : `${sharedInstruction}\n${legalInstruction}\n${review ? reviewerInstruction : analystInstruction}`;
  const data = lookup ? { inn: snapshot.inn } : { kind, instructionVersion: setVersion, profile, rules: ruleSet, ...material,
    ...(base ? { primaryResult: base } : {}) };
  return { prompt, schema: lookup ? organizationSchema : review ? reviewSchema : schema, base, instructions, data };
}

export function proposalRequest(request) {
  return { prompt: `${proposalInstruction}\n${legalInstruction}\nДАННЫЕ:\n${JSON.stringify(request)}`, schema: proposalSchema,
    instructions: `${proposalInstruction}\n${legalInstruction}`, data: request };
}
