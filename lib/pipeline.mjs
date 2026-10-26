/**
 * Один ход диалога в двух режимах.
 *
 *   direct:    вопрос (ru) → мозг → ответ (ru)
 *   translate: вопрос (ru) → переводчик ru→en → мозг (en) → переводчик en→ru → ответ (ru)
 *
 * Перевод ответа идёт по предложениям параллельно с генерацией мозга
 * (если включено streamOut), поэтому «хвост» после мозга обычно короткий.
 */

import { createHash } from 'node:crypto';
import { chatStream, LlmError } from './llm.mjs';
import { SentenceSplitter } from './sentences.mjs';
import { translateText } from './translate.mjs';

const noop = () => {};
const round = (ms) => Math.round(ms);

/** Ошибка этапа с тем, что успело получиться: сервис сохранит это в историю. */
export class PipelineError extends Error {
  constructor(message, { stage, cause, partial = {} } = {}) {
    super(message);
    this.name = 'PipelineError';
    this.stage = stage;
    this.cause = cause;
    this.partial = partial;
    this.code = cause?.code ?? 'pipeline';
  }
}

const hasText = (m) => !m.error && typeof m.ru === 'string' && m.ru.trim();

/** Последние n пригодных сообщений перед вопросом. */
export function memoryWindow(messages, n) {
  if (n <= 0) return [];
  return messages.filter(hasText).slice(-n);
}

function systemPrompt(base, notesLabel, notes) {
  const text = notes.trim();
  return text ? `${base}\n\n${notesLabel}\n${text}` : base;
}

export const notesHash = (notes) => createHash('sha1').update(notes.trim()).digest('hex');

/**
 * @param {object} p
 * @param {'direct'|'translate'} p.mode
 * @param {object[]} p.history   сообщения ДО вопроса (живые объекты: недостающий `en` дописывается в них)
 * @param {{ru:string,en?:string}} p.question
 * @param {boolean} [p.retranslateQuestion]  перевести вопрос заново, даже если en уже есть (для замеров)
 * @param {{brain:object,translator:object,prompts:object,notes:string,memoryN:number,streamOut:boolean,notesCache?:object}} p.cfg
 */
export async function runPipeline({ mode, history, question, cfg, signal, emit = noop, fetchImpl, retranslateQuestion = false }) {
  const started = performance.now();
  const secrets = [cfg.brain.apiKey, cfg.translator.apiKey].filter(Boolean);
  const timings = { inMs: 0, brainMs: 0, ttftMs: 0, outMs: 0, outWorkMs: 0, firstRuMs: 0, totalMs: 0 };
  const models = { brain: cfg.brain.model, translator: mode === 'translate' ? cfg.translator.model : null };
  const stage = (name, status, extra = {}) => emit({ type: 'stage', stage: name, status, ...extra });
  const effects = { patches: [], notesCache: null };
  const partial = { qEn: null, en: '', ru: '' };

  const translate = (dir, text, onDelta) =>
    translateText({ translator: cfg.translator, prompts: cfg.prompts, dir, text, signal, secrets, fetchImpl, onDelta });

  const run = async (stageName, fn) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof PipelineError) throw error;
      throw new PipelineError(error.message, { stage: stageName, cause: error, partial: { ...partial, timings } });
    }
  };

  const window = memoryWindow(history, cfg.memoryN);
  let messages;
  let qEn = null;
  let notesEn = '';

  if (mode === 'direct') {
    messages = [
      { role: 'system', content: systemPrompt(cfg.prompts.brainRu, cfg.prompts.notesRu, cfg.notes) },
      ...window.map((m) => ({ role: m.role, content: m.ru })),
      { role: 'user', content: question.ru },
    ];
  } else {
    // Заметки по-английски: перевод кэшируется, пока текст заметок не поменялся.
    if (cfg.notes.trim()) {
      const hash = notesHash(cfg.notes);
      if (cfg.notesCache?.hash === hash && cfg.notesCache.en) {
        notesEn = cfg.notesCache.en;
      } else {
        stage('notes', 'start');
        const t0 = performance.now();
        const result = await run('notes', () => translate('ruEn', cfg.notes));
        notesEn = result.text;
        timings.notesMs = round(performance.now() - t0);
        effects.notesCache = { hash, en: notesEn };
        stage('notes', 'done', { ms: timings.notesMs });
      }
    }

    // Старые реплики без английской версии (например, из режима «напрямую») переводим один раз.
    const missing = window.filter((m) => !m.en || !m.en.trim());
    if (missing.length) {
      stage('ctx', 'start');
      const t0 = performance.now();
      for (const m of missing) {
        const result = await run('ctx', () => translate('ruEn', m.ru));
        m.en = result.text;
        effects.patches.push({ id: m.id, en: result.text });
      }
      timings.ctxMs = round(performance.now() - t0);
      stage('ctx', 'done', { ms: timings.ctxMs });
    }

    if (question.en && question.en.trim() && !retranslateQuestion) {
      qEn = question.en;
      stage('in', 'done', { ms: 0, reused: true, en: qEn });
    } else {
      stage('in', 'start');
      const t0 = performance.now();
      const result = await run('in', () => translate('ruEn', question.ru));
      timings.inMs = round(performance.now() - t0);
      qEn = result.text;
      stage('in', 'done', { ms: timings.inMs, en: qEn });
    }
    partial.qEn = qEn;

    messages = [
      { role: 'system', content: systemPrompt(cfg.prompts.brainEn, cfg.prompts.notesEn, notesEn) },
      ...window.map((m) => ({ role: m.role, content: m.en })),
      { role: 'user', content: qEn },
    ];
  }

  // --- мозг (+ параллельный построчный перевод ответа) ---
  const splitter = new SentenceSplitter();
  let queue = Promise.resolve();
  let queueError = null;
  let ruText = '';
  let outStarted = false;
  let brainEndedAt = null;
  const brainStart = performance.now();

  const enqueue = (segment) => {
    queue = queue.then(async () => {
      if (queueError) return;
      if (!outStarted) {
        outStarted = true;
        stage('out', 'start');
      }
      const t0 = performance.now();
      try {
        const result = await translate('enRu', segment.text);
        timings.outWorkMs += round(performance.now() - t0);
        ruText += result.text + segment.tail;
        partial.ru = ruText;
        if (!timings.firstRuMs) timings.firstRuMs = round(performance.now() - started);
        emit({ type: 'out', text: result.text + segment.tail });
      } catch (error) {
        queueError = error;
      }
    });
  };

  stage('brain', 'start');
  const body = {
    model: cfg.brain.model,
    messages,
    temperature: cfg.brain.temperature,
    max_tokens: cfg.brain.maxTokens,
    ...(cfg.brain.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    ...cfg.brain.extra,
  };
  const brain = await run('brain', () =>
    chatStream({
      role: 'brain',
      baseUrl: cfg.brain.baseUrl,
      apiKey: cfg.brain.apiKey,
      headers: cfg.brain.headers,
      body,
      signal,
      firstTokenTimeoutMs: cfg.brain.timeoutSec * 1000,
      secrets,
      fetchImpl,
      onDelta: (piece) => {
        partial.en += piece;
        emit({ type: 'brain', text: piece });
        if (mode === 'translate' && cfg.streamOut) {
          for (const segment of splitter.push(piece)) enqueue(segment);
        }
      },
    }),
  );
  brainEndedAt = performance.now();
  timings.brainMs = round(brain.ms);
  timings.ttftMs = round(brain.ttftMs);
  timings.genTokens = brain.usage?.completion_tokens ?? brain.timings?.predicted_n ?? null;
  timings.tokPerSec = brain.timings?.predicted_per_second != null
    ? Math.round(brain.timings.predicted_per_second * 10) / 10
    : timings.genTokens && brain.ms > brain.ttftMs
      ? Math.round((timings.genTokens / ((brain.ms - brain.ttftMs) / 1000)) * 10) / 10
      : null;
  stage('brain', 'done', { ms: timings.brainMs, ttftMs: timings.ttftMs });

  if (mode === 'direct') {
    timings.firstRuMs = timings.ttftMs;
    timings.totalMs = round(performance.now() - started);
    return { mode, qEn: null, en: null, ru: brain.text, timings, models, effects };
  }

  partial.en = brain.text;
  if (cfg.streamOut) {
    const rest = splitter.flush();
    if (rest) enqueue(rest);
  } else {
    enqueue({ text: brain.text, tail: '' });
  }
  await queue;
  if (queueError) {
    timings.totalMs = round(performance.now() - started);
    const cause = queueError instanceof LlmError ? queueError : new LlmError(queueError.message);
    throw new PipelineError(cause.message, { stage: 'out', cause, partial: { ...partial, en: brain.text, timings } });
  }
  timings.outMs = round(performance.now() - brainEndedAt);
  stage('out', 'done', { ms: timings.outMs, workMs: timings.outWorkMs });
  timings.totalMs = round(performance.now() - started);
  return { mode, qEn, en: brain.text, ru: ruText.trim(), timings, models, effects };
}
