/**
 * Клиент OpenAI-совместимого /chat/completions: потоковый ответ, таймауты и
 * понятные русские ошибки. Ключ уходит только в заголовок Authorization и
 * вычищается из любых текстов ошибок.
 */

export class LlmError extends Error {
  constructor(message, { code = 'llm', role = '', status = 0 } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.role = role;
    this.status = status;
  }
}

const ROLE_NAMES = { brain: 'мозг', translator: 'переводчик' };
export const roleTitle = (role) => ROLE_NAMES[role] ?? role;

/** Убирает известные секреты из текста. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}

export function chatUrl(baseUrl) {
  return `${String(baseUrl).trim().replace(/\/+$/, '')}/chat/completions`;
}

export function validateBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl).trim());
  } catch {
    return 'Адрес должен быть вида http://127.0.0.1:8180/v1';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Адрес должен начинаться с http:// или https://';
  return null;
}

function connectionMessage(error, role, baseUrl) {
  const who = roleTitle(role);
  const code = error?.cause?.code ?? error?.code ?? '';
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // оставляем как есть
  }
  if (code === 'ECONNREFUSED') {
    return `Сервер для роли «${who}» не запущен: ${host} отказал в соединении. Запусти llama-server (команды — в README) или поправь адрес в настройках.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Роль «${who}»: не удалось найти хост ${host}. Проверь адрес и подключение к сети.`;
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return `Роль «${who}»: соединение с ${host} оборвалось посреди ответа (сервер упал или перезапускается?).`;
  }
  if (code === 'CERT_HAS_EXPIRED' || String(code).startsWith('ERR_TLS') || String(code).includes('CERT')) {
    return `Роль «${who}»: ошибка TLS-сертификата у ${host} (${code}).`;
  }
  return `Роль «${who}»: не удалось связаться с ${host} (${error?.cause?.message ?? error?.message ?? 'неизвестная ошибка'}).`;
}

function httpMessage(status, detail, role) {
  const who = roleTitle(role);
  const tail = detail ? ` Ответ сервера: ${detail}` : '';
  if (status === 401 || status === 403) return `Роль «${who}»: сервер не принял ключ (HTTP ${status}). Проверь ключ в настройках или в корневом .env.${tail}`;
  if (status === 404) return `Роль «${who}»: адрес или модель не найдены (HTTP 404). Проверь base URL (обычно оканчивается на /v1) и имя модели.${tail}`;
  if (status === 429) return `Роль «${who}»: слишком много запросов или кончился лимит (HTTP 429). Подожди и повтори.${tail}`;
  if (status === 503) return `Роль «${who}»: сервер занят или ещё грузит модель (HTTP 503). Подожди несколько секунд и повтори.${tail}`;
  if (status === 400 || status === 422) return `Роль «${who}»: сервер отклонил запрос (HTTP ${status}) — проверь имя модели и «дополнительные параметры».${tail}`;
  if (status >= 500) return `Роль «${who}»: ошибка на стороне сервера (HTTP ${status}).${tail}`;
  return `Роль «${who}»: неожиданный ответ HTTP ${status}.${tail}`;
}

async function readErrorDetail(response, secrets) {
  let text = '';
  try {
    text = (await response.text()).slice(0, 600);
  } catch {
    return '';
  }
  try {
    const json = JSON.parse(text);
    const message = json?.error?.message ?? json?.message ?? json?.error;
    if (typeof message === 'string') text = message;
  } catch {
    // не JSON — берём как есть
  }
  return redact(text, secrets).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Прячет «размышления» из content, если модель отдаёт их тегами <think>…</think> в самом тексте. */
export class ThinkFilter {
  constructor() {
    this.inside = false;
    this.pending = '';
  }

  push(chunk) {
    let text = this.pending + chunk;
    this.pending = '';
    let out = '';
    while (text) {
      if (this.inside) {
        const end = text.indexOf('</think>');
        if (end === -1) {
          // Хвост может быть началом закрывающего тега — придержим.
          this.pending = tagPrefixTail(text, '</think>');
          return out;
        }
        text = text.slice(end + '</think>'.length).replace(/^\s+/, '');
        this.inside = false;
      } else {
        const start = text.indexOf('<think>');
        if (start === -1) {
          const hold = tagPrefixTail(text, '<think>');
          out += text.slice(0, text.length - hold.length);
          this.pending = hold;
          return out;
        }
        out += text.slice(0, start);
        text = text.slice(start + '<think>'.length);
        this.inside = true;
      }
    }
    return out;
  }

  flush() {
    const rest = this.inside ? '' : this.pending;
    this.pending = '';
    return rest;
  }
}

function tagPrefixTail(text, tag) {
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len -= 1) {
    if (text.endsWith(tag.slice(0, len))) return text.slice(-len);
  }
  return '';
}

/**
 * Потоковый запрос. onDelta(текст) вызывается по мере поступления content.
 * Возвращает { text, ttftMs, ms, finishReason, reasoningChars }.
 */
export async function chatStream({
  role,
  baseUrl,
  apiKey = '',
  headers = {},
  body,
  signal,
  firstTokenTimeoutMs = 120_000,
  idleTimeoutMs = 60_000,
  totalTimeoutMs = 600_000,
  onDelta,
  secrets = [],
  fetchImpl = fetch,
}) {
  const invalid = validateBaseUrl(baseUrl);
  if (invalid) throw new LlmError(`Роль «${roleTitle(role)}»: ${invalid}`, { code: 'config', role });

  const started = performance.now();
  const controller = new AbortController();
  let abortReason = null;
  const abort = (reason) => {
    abortReason ??= reason;
    controller.abort();
  };
  const onExternalAbort = () => abort('cancel');
  if (signal) {
    if (signal.aborted) abort('cancel');
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timer = null;
  const arm = (ms, reason) => {
    clearTimeout(timer);
    timer = setTimeout(() => abort(reason), ms);
  };
  const totalTimer = setTimeout(() => abort('total'), totalTimeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', onExternalAbort);
  };

  const timeoutError = () => {
    const who = roleTitle(role);
    if (abortReason === 'first') {
      return new LlmError(`Роль «${who}»: нет ответа за ${Math.round(firstTokenTimeoutMs / 1000)} с. Модель не отвечает или слишком медленная; увеличь таймаут в настройках.`, { code: 'timeout', role });
    }
    if (abortReason === 'idle') {
      return new LlmError(`Роль «${who}»: поток ответа замолчал на ${Math.round(idleTimeoutMs / 1000)} с.`, { code: 'timeout', role });
    }
    if (abortReason === 'total') {
      return new LlmError(`Роль «${who}»: ответ не закончился за ${Math.round(totalTimeoutMs / 1000)} с.`, { code: 'timeout', role });
    }
    return null;
  };

  try {
    arm(firstTokenTimeoutMs, 'first');
    let response;
    try {
      response = await fetchImpl(chatUrl(baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream, application/json',
          ...headers,
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
    } catch (error) {
      if (abortReason === 'cancel') throw new LlmError('Остановлено.', { code: 'cancel', role });
      throw timeoutError() ?? new LlmError(redact(connectionMessage(error, role, baseUrl), secrets), { code: 'connect', role });
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response, [apiKey, ...secrets]);
      throw new LlmError(httpMessage(response.status, detail, role), { code: 'http', role, status: response.status });
    }

    const filter = new ThinkFilter();
    let text = '';
    let reasoningChars = 0;
    let serverTimings = null;
    let usage = null;
    let ttftMs = null;
    let finishReason = null;

    const emit = (piece) => {
      if (!piece) return;
      if (ttftMs === null) ttftMs = performance.now() - started;
      text += piece;
      onDelta?.(piece);
    };

    const handleChunk = (json) => {
      if (json?.error) {
        const message = redact(typeof json.error === 'string' ? json.error : json.error.message ?? 'ошибка', [apiKey, ...secrets]);
        throw new LlmError(`Роль «${roleTitle(role)}»: ${message}`, { code: 'stream', role });
      }
      // llama-server отдаёт timings (tok/s) и usage в последнем куске потока.
      if (json?.timings) serverTimings = json.timings;
      if (json?.usage) usage = json.usage;
      const choice = json?.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? choice.message ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string') reasoningChars += reasoning.length;
      if (typeof delta.content === 'string') emit(filter.push(delta.content));
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    const contentType = response.headers.get('content-type') ?? '';
    // Таймер «первого токена» остаётся взведённым до первого куска тела: обработка
    // длинного промпта на CPU может идти дольше, чем разрешено молчать потоку.
    try {
      if (contentType.includes('application/json')) {
        // Сервер проигнорировал stream: целый JSON.
        handleChunk(await response.json());
      } else {
        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;
        for await (const part of response.body) {
          arm(idleTimeoutMs, 'idle');
          buffer += decoder.decode(part, { stream: true });
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              done = true;
              break;
            }
            let json;
            try {
              json = JSON.parse(payload);
            } catch {
              continue;
            }
            handleChunk(json);
          }
          if (done) break;
        }
      }
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (abortReason === 'cancel') throw new LlmError('Остановлено.', { code: 'cancel', role });
      throw timeoutError() ?? new LlmError(redact(connectionMessage(error, role, baseUrl), secrets), { code: 'connect', role });
    }

    emit(filter.flush());
    const ms = performance.now() - started;
    const result = { text: text.trim(), ttftMs: ttftMs ?? ms, ms, finishReason, reasoningChars, timings: serverTimings, usage };
    if (!result.text) {
      const hint = reasoningChars > 0
        ? ' Модель потратила все токены на «размышления» — отключи их (настройка «Размышления») или увеличь лимит токенов.'
        : '';
      throw new LlmError(`Роль «${roleTitle(role)}»: модель вернула пустой ответ.${hint}`, { code: 'empty', role });
    }
    return result;
  } finally {
    cleanup();
  }
}

/** Лёгкая проверка доступности: GET {base}/models. Любой HTTP-ответ — сервер жив. */
export async function probe({ role, baseUrl, apiKey = '', headers = {}, timeoutMs = 3000, fetchImpl = fetch, secrets = [] }) {
  const invalid = validateBaseUrl(baseUrl);
  if (invalid) return { ok: false, message: invalid };
  const started = performance.now();
  try {
    const response = await fetchImpl(`${String(baseUrl).trim().replace(/\/+$/, '')}/models`, {
      headers: { ...headers, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Math.round(performance.now() - started);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, ms, message: 'Сервер жив, но ключ не принят.' };
    }
    if (response.status === 503) return { ok: false, status: 503, ms, message: 'Сервер жив, модель ещё загружается.' };
    return { ok: true, status: response.status, ms, message: 'Доступен.' };
  } catch (error) {
    if (error?.name === 'TimeoutError') return { ok: false, message: `Нет ответа за ${timeoutMs / 1000} с.` };
    return { ok: false, message: redact(connectionMessage(error, role, baseUrl), [apiKey, ...secrets]) };
  }
}
