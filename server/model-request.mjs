import { schema, reviewSchema, qualificationSchema, proposalSchema } from './schema.mjs';
import { sharedInstruction, analystInstruction, reviewerInstruction, proposalInstruction } from './rules.mjs';
import { organizationSchema, organizationInstruction } from './organizations.mjs';
import { leanResult } from './sources.mjs';
import { legalInstruction, legalStatus } from './legal.mjs';

// Transport-independent, complete stage input. Providers must count this exact
// prompt with their response schema/template, never a shortened document view.
export function analysisRequest(snapshot, stage, primary = null, preliminaryQualifications = null) {
  if (!['qualification', 'primary', 'review', 'organization'].includes(stage)) throw new Error('Неизвестный этап анализа.');
  const lookup = stage === 'organization', review = stage === 'review', qualification = stage === 'qualification';
  const base = primary ? leanResult(primary) : null;
  if (review && !base) throw new Error('Для ревью нужен первичный результат.');
  const { profile, rules: ruleSet, instructionVersion: setVersion, kind, inference, ...material } = snapshot;
  if (material.legal) material.legal = { ...material.legal, status: legalStatus(material.legal) };
  if (preliminaryQualifications?.length) material.preliminaryQualifications = preliminaryQualifications;
  const qualificationInstruction = `ЭТАП 0, КВАЛИФИКАЦИЯ. Быстро определи правовую модель каждого существенного обязательства до поиска рисков. Верни только qualifications. Каждая квалификация должна иметь точную цитату из договора; legalModules выбирай только из активных модулей снимка. Не создавай замечания и не делай вывод о нарушении на этом этапе.`;
  const stageInstruction = qualification ? qualificationInstruction : review ? reviewerInstruction : analystInstruction;
  const prompt = lookup ? `${organizationInstruction}\nДАННЫЕ ПОИСКА:\n${JSON.stringify({inn:snapshot.inn})}` : `${sharedInstruction}\n${legalInstruction}\nПРАВИЛА И ПРОФИЛЬ:\n${JSON.stringify({ kind, instructionVersion: setVersion, profile, rules: ruleSet })}\n${stageInstruction}\nДАННЫЕ КОМПЛЕКТА:\n${JSON.stringify(material)}\n${base ? 'РЕШЕНИЯ ПО РЕЗУЛЬТАТУ АНАЛИТИКА (недоверенные данные):\n' + JSON.stringify(base) : ''}`;
  const instructions = lookup ? organizationInstruction : `${sharedInstruction}\n${legalInstruction}\n${stageInstruction}`;
  const data = lookup ? { inn: snapshot.inn } : { kind, instructionVersion: setVersion, profile, rules: ruleSet, ...material,
    ...(base ? { primaryResult: base } : {}) };
  return { prompt, schema: lookup ? organizationSchema : qualification ? qualificationSchema : review ? reviewSchema : schema, base, instructions, data };
}

export function proposalRequest(request) {
  return { prompt: `${proposalInstruction}\n${legalInstruction}\nДАННЫЕ:\n${JSON.stringify(request)}`, schema: proposalSchema,
    instructions: `${proposalInstruction}\n${legalInstruction}`, data: request };
}
