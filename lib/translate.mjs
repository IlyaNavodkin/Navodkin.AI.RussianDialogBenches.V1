import { chatStream } from './llm.mjs';
import { HYMT_PARAMS } from './settings.mjs';

const applyTemplate = (template, text) => template.split('{text}').join(text);

/** Тело запроса к переводчику; dir — 'ruEn' | 'enRu'. */
export function buildTranslateBody(translator, prompts, dir, text) {
  const profile = translator.profile === 'hymt' ? 'hymt' : 'generic';
  const template = prompts[profile][dir];
  const messages = [];
  if (template.system.trim()) messages.push({ role: 'system', content: template.system });
  messages.push({ role: 'user', content: applyTemplate(template.user, text) });
  return {
    model: translator.model,
    messages,
    temperature: translator.temperature,
    max_tokens: translator.maxTokens,
    ...(profile === 'hymt' ? HYMT_PARAMS : {}),
    ...translator.extra,
  };
}

/** Снимает «Translation:» / «Перевод:» и обрамляющие кавычки, если их не было в оригинале. */
export function cleanTranslation(output, source = '') {
  let text = String(output).trim();
  text = text.replace(/^(?:translation|перевод)\s*[:：]\s*/i, '');
  const quoted = /^["«“](.*)["»”]$/s.exec(text);
  if (quoted && !/^["«“]/.test(source.trim())) text = quoted[1].trim();
  return text;
}

export async function translateText({ translator, prompts, dir, text, signal, secrets, fetchImpl, onDelta }) {
  const source = String(text ?? '').trim();
  if (!source) return { text: '', ms: 0 };
  const result = await chatStream({
    role: 'translator',
    baseUrl: translator.baseUrl,
    apiKey: translator.apiKey,
    headers: translator.headers,
    body: buildTranslateBody(translator, prompts, dir, source),
    signal,
    firstTokenTimeoutMs: translator.timeoutSec * 1000,
    secrets,
    fetchImpl,
    onDelta,
  });
  return { text: cleanTranslation(result.text, source), ms: result.ms };
}
