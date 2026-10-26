import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadEnvFile } from './env.mjs';
import { LlmError, probe, redact } from './llm.mjs';
import { runPipeline, PipelineError } from './pipeline.mjs';
import { effectivePrompts, mergeSettings, publicSettings, resolveRole } from './settings.mjs';
import { ModelRunner, RunnerError } from './runner.mjs';
import { Store } from './store.mjs';
import { translateText } from './translate.mjs';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_TEXT = 8000;
const newId = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const normMode = (mode, fallback) => (mode === 'direct' || mode === 'translate' ? mode : fallback);

function makeMessage(role, fields) {
  return { id: newId('m'), role, ru: '', en: null, mode: 'direct', timings: null, models: null, edited: { ru: false, en: false }, at: new Date().toISOString(), ...fields };
}

export class ChatService {
  constructor({ dataDir, envFile, fetchImpl = fetch, runner = new ModelRunner() } = {}) {
    this.store = new Store(dataDir);
    this.runner = runner;
    this.envFile = envFile;
    this.fetchImpl = fetchImpl;
    this.busy = false;
  }

  async init() {
    await this.store.load();
    return this;
  }

  get data() {
    return this.store.data;
  }

  env() {
    return this.envFile ? loadEnvFile(this.envFile) : {};
  }

  secrets() {
    const env = this.env();
    return [env.LLM_API_KEY, this.store.keys.brain, this.store.keys.translator].filter(Boolean);
  }

  cfg() {
    const { settings } = this.data;
    const env = this.env();
    const ctx = { env, keys: this.store.keys };
    return {
      brain: resolveRole('brain', settings, ctx),
      translator: resolveRole('translator', settings, ctx),
      prompts: effectivePrompts(settings),
      notes: settings.notes,
      memoryN: settings.memoryN,
      streamOut: settings.streamOut,
      notesCache: this.data.notesCache,
    };
  }

  async #exclusive(fn) {
    if (this.busy) throw new HttpError(409, 'Предыдущий запрос ещё выполняется. Дождись ответа или нажми «Стоп».');
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------- чтение

  state() {
    const env = this.env();
    const pending = [...this.data.comparisons].reverse().find((c) => !c.verdict) ?? null;
    return {
      messages: this.data.messages,
      settings: publicSettings(this.data.settings, { env, keys: this.store.keys }),
      busy: this.busy,
      pendingCompare: pending,
      comparisonCount: this.data.comparisons.length,
    };
  }

  comparisons() {
    return this.data.comparisons;
  }

  exportData(what = 'all') {
    const cfg = this.cfg();
    const roles = {
      brain: { baseUrl: cfg.brain.baseUrl, model: cfg.brain.model },
      translator: { baseUrl: cfg.translator.baseUrl, model: cfg.translator.model, profile: cfg.translator.profile },
    };
    const head = { app: 'translate-chat', exportedAt: new Date().toISOString(), roles };
    if (what === 'chat') return { ...head, settings: this.data.settings, messages: this.data.messages };
    if (what === 'compare') return { ...head, memoryN: this.data.settings.memoryN, comparisons: this.data.comparisons };
    return { ...head, settings: this.data.settings, messages: this.data.messages, comparisons: this.data.comparisons };
  }

  // ---------------------------------------------------------------- модели

  modelsState() {
    return { models: this.runner.list(), ...this.runner.status() };
  }

  /** Запускает локальную модель в роли и сразу направляет роль на неё в настройках. */
  async startModel(role, id, options = {}) {
    let slot;
    try {
      slot = await this.runner.start(role, id, options);
    } catch (error) {
      if (error instanceof RunnerError) throw new HttpError(error.code === 'memory' ? 409 : 400, error.message);
      throw error;
    }
    const thinks = Boolean(this.runner.registry[id].thinks);
    const patch =
      role === 'brain'
        ? { brain: { baseUrl: `http://127.0.0.1:${slot.port}/v1`, model: 'brain', noThinking: thinks ? 'off' : 'on', maxTokens: thinks ? 1500 : 600, timeoutSec: 180 } }
        : { translator: { baseUrl: `http://127.0.0.1:${slot.port}/v1`, model: 'translator', profile: id === 'hymt2-1.8b' ? 'hymt' : 'generic', maxTokens: 800, timeoutSec: 180 } };
    const { settings } = mergeSettings(this.data.settings, patch);
    this.data.settings = settings;
    await this.store.save();
    return this.modelsState();
  }

  async stopModel(role) {
    if (role !== 'brain' && role !== 'translator') throw new HttpError(400, 'Неизвестная роль.');
    await this.runner.stop(role);
    return this.modelsState();
  }

  /** Мозг снова облачный: локальный сервер останавливается, адрес и модель берутся из корневого .env. */
  async useCloudBrain() {
    await this.runner.stop('brain');
    const { settings } = mergeSettings(this.data.settings, { brain: { baseUrl: '', model: '', noThinking: 'auto', maxTokens: 600, timeoutSec: 120 } });
    this.data.settings = settings;
    await this.store.save();
    return this.modelsState();
  }

  // ------------------------------------------------------------- настройки

  async updateSettings(patch) {
    const { settings, errors } = mergeSettings(this.data.settings, patch);
    if (errors.length) throw new HttpError(400, errors.join('; '));
    this.data.settings = settings;
    await this.store.save();
    return this.state();
  }

  /** Ключ роли: строка — сохранить, null — удалить. Значение нигде не возвращается и не логируется. */
  async setKey(role, key) {
    if (role !== 'brain' && role !== 'translator') throw new HttpError(400, 'Неизвестная роль');
    if (key === null || key === '') delete this.store.keys[role];
    else if (typeof key === 'string' && key.trim()) this.store.keys[role] = key.trim();
    else throw new HttpError(400, 'Ключ должен быть строкой');
    await this.store.saveKeys();
    return this.state();
  }

  async health() {
    const cfg = this.cfg();
    const secrets = this.secrets();
    const [brain, translator] = await Promise.all(
      [cfg.brain, cfg.translator].map((r) => probe({ role: r.role, baseUrl: r.baseUrl, apiKey: r.apiKey, headers: r.headers, secrets, fetchImpl: this.fetchImpl })),
    );
    return { brain, translator };
  }

  /** Круговой перевод ru→en→ru для проверки переводчика из настроек. */
  async translateTest(text) {
    const source = String(text ?? '').trim().slice(0, 2000);
    if (!source) throw new HttpError(400, 'Нужен текст для проверки.');
    const cfg = this.cfg();
    const secrets = this.secrets();
    try {
      const toEn = await translateText({ translator: cfg.translator, prompts: cfg.prompts, dir: 'ruEn', text: source, secrets, fetchImpl: this.fetchImpl });
      const toRu = await translateText({ translator: cfg.translator, prompts: cfg.prompts, dir: 'enRu', text: toEn.text, secrets, fetchImpl: this.fetchImpl });
      return { ru: source, en: toEn.text, back: toRu.text, enMs: Math.round(toEn.ms), backMs: Math.round(toRu.ms) };
    } catch (error) {
      throw new HttpError(502, redact(error.message, secrets));
    }
  }

  // ------------------------------------------------------------- сообщения

  #find(id) {
    const index = this.data.messages.findIndex((m) => m.id === id);
    if (index === -1) throw new HttpError(404, 'Сообщение не найдено (возможно, уже удалено).');
    return index;
  }

  async send({ text, mode, signal, emit }) {
    return this.#exclusive(async () => {
      const ru = String(text ?? '').trim();
      if (!ru) throw new HttpError(400, 'Пустое сообщение.');
      if (ru.length > MAX_TEXT) throw new HttpError(400, `Слишком длинное сообщение (максимум ${MAX_TEXT} символов).`);
      const chosen = normMode(mode, this.data.settings.mode);
      const question = makeMessage('user', { ru, mode: chosen });
      this.data.messages.push(question);
      await this.store.save();
      emit?.({ type: 'user', message: question });
      return this.#answer(question, chosen, { signal, emit });
    });
  }

  /** Перегенерировать ответ на последний вопрос (старый ответ удаляется). */
  async regenerate({ mode, signal, emit }) {
    return this.#exclusive(async () => {
      const question = this.#lastUser();
      this.#truncateAfter(question);
      await this.store.save();
      return this.#answer(question, normMode(mode, this.data.settings.mode), { signal, emit });
    });
  }

  #lastUser() {
    const question = [...this.data.messages].reverse().find((m) => m.role === 'user');
    if (!question) throw new HttpError(400, 'В чате нет вопроса, на который можно ответить.');
    return question;
  }

  #truncateAfter(message) {
    const index = this.data.messages.indexOf(message);
    this.data.messages.length = index + 1;
  }

  /** Общий ход: пайплайн → запись ответа. Ошибки уходят событием, а не исключением. */
  async #answer(question, mode, { signal, emit, retranslateQuestion = false }) {
    const index = this.data.messages.indexOf(question);
    const history = this.data.messages.slice(0, index);
    const cfg = this.cfg();
    const secrets = this.secrets();
    try {
      const result = await runPipeline({ mode, history, question, cfg, signal, emit, fetchImpl: this.fetchImpl, retranslateQuestion });
      this.#applyEffects(result.effects);
      if (result.qEn && !question.edited?.en) question.en = result.qEn;
      const assistant = makeMessage('assistant', { ru: result.ru, en: result.en, mode, timings: result.timings, models: result.models });
      this.data.messages.push(assistant);
      await this.store.save();
      emit?.({ type: 'message', message: assistant });
      emit?.({ type: 'done' });
      return { ok: true, message: assistant };
    } catch (error) {
      const failure = error instanceof PipelineError ? error : new PipelineError(error.message, { stage: 'brain', cause: error });
      const message = redact(failure.message, secrets);
      const cancelled = failure.code === 'cancel';
      if (failure.partial?.qEn && !question.edited?.en) question.en = failure.partial.qEn;
      let saved = null;
      if (!cancelled && failure.stage === 'out' && failure.partial?.en) {
        saved = makeMessage('assistant', {
          ru: failure.partial.ru ?? '',
          en: failure.partial.en,
          mode,
          timings: failure.partial.timings ?? null,
          models: { brain: cfg.brain.model, translator: cfg.translator.model },
          error: message,
        });
        this.data.messages.push(saved);
      }
      await this.store.save();
      if (saved) emit?.({ type: 'message', message: saved });
      emit?.({ type: 'error', stage: failure.stage, message, cancelled });
      return { ok: false, error: message, cancelled };
    }
  }

  #applyEffects(effects) {
    for (const patch of effects?.patches ?? []) {
      const target = this.data.messages.find((m) => m.id === patch.id);
      if (target && !target.en) target.en = patch.en;
    }
    if (effects?.notesCache) this.data.notesCache = effects.notesCache;
  }

  /**
   * Правка сообщения.
   *  ru пользователя  → английский сбрасывается и переводится заново при следующем ответе;
   *  en (любой)       → именно он уходит в контекст мозга;
   *  ru ответа        → только отображение.
   * retranslate: 'en' — получить en из ru, 'ru' — получить ru из en.
   */
  async edit(id, { ru, en, retranslate, regenerate, mode }, { signal, emit } = {}) {
    return this.#exclusive(async () => {
      const index = this.#find(id);
      const message = this.data.messages[index];
      const cfg = this.cfg();
      const secrets = this.secrets();
      const next = { ru: message.ru, en: message.en, edited: { ...message.edited } };

      if (typeof ru === 'string') {
        const value = ru.trim().slice(0, MAX_TEXT);
        if (!value) throw new HttpError(400, 'Русский текст не может быть пустым.');
        if (value !== message.ru) {
          next.ru = value;
          next.edited.ru = true;
          if (message.role === 'user') {
            next.en = null;
            next.edited.en = false;
          }
        }
      }
      if (typeof en === 'string') {
        const value = en.trim().slice(0, MAX_TEXT);
        if (!value) throw new HttpError(400, 'Английский текст не может быть пустым.');
        if (value !== (message.en ?? '')) {
          next.en = value;
          next.edited.en = true;
        }
      }
      if (retranslate === 'en' || retranslate === 'ru') {
        try {
          if (retranslate === 'en') {
            next.en = (await translateText({ translator: cfg.translator, prompts: cfg.prompts, dir: 'ruEn', text: next.ru, signal, secrets, fetchImpl: this.fetchImpl })).text;
            next.edited.en = false;
          } else {
            if (!next.en) throw new HttpError(400, 'Нет английского текста для перевода.');
            next.ru = (await translateText({ translator: cfg.translator, prompts: cfg.prompts, dir: 'enRu', text: next.en, signal, secrets, fetchImpl: this.fetchImpl })).text;
            next.edited.ru = false;
            delete message.error;
          }
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, redact(error.message, secrets));
        }
      }

      message.ru = next.ru;
      message.en = next.en;
      message.edited = next.edited;

      if (regenerate) {
        if (message.role !== 'user') throw new HttpError(400, 'Перегенерировать можно ответ на вопрос пользователя.');
        this.#truncateAfter(message);
        await this.store.save();
        const result = await this.#answer(message, normMode(mode, this.data.settings.mode), { signal, emit });
        return { ...result, regenerated: true };
      }
      await this.store.save();
      return { ok: true, message };
    });
  }

  async remove(id, { after = false } = {}) {
    return this.#exclusive(async () => {
      const index = this.#find(id);
      if (after) this.data.messages.length = index;
      else this.data.messages.splice(index, 1);
      await this.store.save();
      return { ok: true };
    });
  }

  async clear() {
    return this.#exclusive(async () => {
      this.data.messages = [];
      await this.store.save();
      return { ok: true };
    });
  }

  // ------------------------------------------------------------- сравнение

  /**
   * Один вопрос — два режима, подряд (не параллельно: на одном процессоре параллельный
   * запуск исказил бы тайминги). Результат пишется в журнал и ждёт выбора пользователя.
   */
  async compare({ text, signal, emit }) {
    return this.#exclusive(async () => {
      const typed = String(text ?? '').trim();
      let question;
      if (typed) {
        if (typed.length > MAX_TEXT) throw new HttpError(400, `Слишком длинное сообщение (максимум ${MAX_TEXT} символов).`);
        question = makeMessage('user', { ru: typed, mode: 'compare' });
        this.data.messages.push(question);
        await this.store.save();
        emit?.({ type: 'user', message: question });
      } else {
        question = this.#lastUser();
      }

      const index = this.data.messages.indexOf(question);
      const history = this.data.messages.slice(0, index);
      const cfg = this.cfg();
      const secrets = this.secrets();
      const entry = {
        id: newId('c'),
        at: new Date().toISOString(),
        questionId: question.id,
        question: question.ru,
        memoryN: cfg.memoryN,
        streamOut: cfg.streamOut,
        notes: Boolean(cfg.notes.trim()),
        roles: {
          brain: { baseUrl: cfg.brain.baseUrl, model: cfg.brain.model },
          translator: { baseUrl: cfg.translator.baseUrl, model: cfg.translator.model, profile: cfg.translator.profile },
        },
        direct: null,
        translate: null,
        verdict: null,
        kept: null,
      };

      for (const side of ['direct', 'translate']) {
        emit?.({ type: 'side', side, status: 'start' });
        try {
          const result = await runPipeline({
            mode: side,
            history,
            question,
            cfg,
            signal,
            emit: (event) => emit?.({ ...event, side }),
            fetchImpl: this.fetchImpl,
            retranslateQuestion: !question.edited?.en,
          });
          this.#applyEffects(result.effects);
          if (result.qEn && !question.edited?.en) question.en = result.qEn;
          entry[side] = { ru: result.ru, en: result.en, qEn: result.qEn, timings: result.timings, error: null };
        } catch (error) {
          const failure = error instanceof PipelineError ? error : new PipelineError(error.message, { stage: 'brain', cause: error });
          if (failure.code === 'cancel') {
            await this.store.save();
            emit?.({ type: 'error', stage: failure.stage, message: 'Остановлено.', cancelled: true });
            return { ok: false, cancelled: true };
          }
          entry[side] = {
            ru: failure.partial?.ru ?? '',
            en: failure.partial?.en ?? '',
            qEn: failure.partial?.qEn ?? null,
            timings: failure.partial?.timings ?? null,
            error: redact(failure.message, secrets),
            stage: failure.stage,
          };
        }
        emit?.({ type: 'side', side, status: 'done', result: entry[side] });
      }

      this.data.comparisons.push(entry);
      await this.store.save();
      emit?.({ type: 'compare', entry });
      emit?.({ type: 'done' });
      return { ok: true, entry };
    });
  }

  /** verdict: direct | translate — оставить ответ в истории; tie — ничья; bad — оба плохие. */
  async chooseComparison(id, verdict) {
    return this.#exclusive(async () => {
      const entry = this.data.comparisons.find((c) => c.id === id);
      if (!entry) throw new HttpError(404, 'Запись сравнения не найдена.');
      if (entry.verdict) throw new HttpError(409, 'Для этого сравнения выбор уже сделан.');
      if (!['direct', 'translate', 'tie', 'bad'].includes(verdict)) throw new HttpError(400, 'Неизвестный выбор.');
      let message = null;
      if (verdict === 'direct' || verdict === 'translate') {
        const side = entry[verdict];
        if (!side || side.error || !side.ru) throw new HttpError(400, 'У этого варианта нет готового ответа — выбери другой.');
        const question = this.data.messages.find((m) => m.id === entry.questionId);
        if (!question) throw new HttpError(409, 'Вопрос из этого сравнения уже удалён из истории.');
        this.#truncateAfter(question);
        message = makeMessage('assistant', {
          ru: side.ru,
          en: verdict === 'translate' ? side.en : null,
          mode: verdict,
          timings: side.timings,
          models: { brain: entry.roles.brain.model, translator: verdict === 'translate' ? entry.roles.translator.model : null },
          compareId: entry.id,
        });
        this.data.messages.push(message);
        entry.kept = message.id;
      }
      entry.verdict = verdict;
      entry.decidedAt = new Date().toISOString();
      await this.store.save();
      return { ok: true, entry, message };
    });
  }

  async clearComparisons() {
    return this.#exclusive(async () => {
      this.data.comparisons = [];
      await this.store.save();
      return { ok: true };
    });
  }
}

export const defaultDataDir = (appDir) => path.join(appDir, 'data');
