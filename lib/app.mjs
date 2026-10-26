import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatService, HttpError } from './service.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const MAX_BODY = 1_000_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Запрос должен быть корректным JSON.');
  }
}

/** Запросы принимаются только по loopback-адресам: защита от DNS rebinding и чужих страниц. */
function hostAllowed(req) {
  const host = (req.headers.host ?? '').toLowerCase();
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.host.toLowerCase() === (req.headers.host ?? '').toLowerCase() && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** NDJSON-поток событий; обрыв соединения клиентом отменяет запросы к моделям. */
async function streamTo(res, handler) {
  const controller = new AbortController();
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', ...SECURITY_HEADERS });
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  const emit = (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  try {
    await handler({ signal: controller.signal, emit });
  } catch (error) {
    emit({ type: 'error', stage: 'request', message: error instanceof HttpError ? error.message : 'Внутренняя ошибка сервера.', status: error.status ?? 500 });
  }
  res.end();
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Не найдено.' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    sendJson(res, 404, { error: 'Не найдено.' });
  }
}

/**
 * @param {{dataDir?:string, envFile?:string, fetchImpl?:typeof fetch, log?:(line:string)=>void}} options
 */
export async function createApp({ dataDir = path.join(APP_DIR, 'data'), envFile = process.env.LLM_ENV_FILE, fetchImpl, runner, log = () => {} } = {}) {
  const service = await new ChatService({ dataDir, envFile, fetchImpl, runner }).init();

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const { pathname } = url;
    if (!hostAllowed(req)) return sendJson(res, 403, { error: 'Недопустимый Host: приложение отвечает только на 127.0.0.1 / localhost.' });

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Метод не поддерживается.' });
      return serveStatic(req, res, pathname);
    }
    if (req.method !== 'GET' && !originAllowed(req)) return sendJson(res, 403, { error: 'Запрос с чужого источника отклонён.' });

    const route = `${req.method} ${pathname}`;
    try {
      if (route === 'GET /api/state') return sendJson(res, 200, service.state());
      if (route === 'GET /api/health') return sendJson(res, 200, await service.health());
      if (route === 'GET /api/models') return sendJson(res, 200, service.modelsState());
      if (route === 'GET /api/compare') return sendJson(res, 200, { comparisons: service.comparisons() });
      if (route === 'GET /api/export') {
        const what = ['chat', 'compare'].includes(url.searchParams.get('what')) ? url.searchParams.get('what') : 'all';
        const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
        return sendJson(res, 200, service.exportData(what), {
          'content-disposition': `attachment; filename="translate-chat-${what}-${stamp}.json"`,
        });
      }

      if (route === 'PUT /api/settings') return sendJson(res, 200, await service.updateSettings(await readBody(req)));
      if (route === 'PUT /api/key') {
        const body = await readBody(req);
        return sendJson(res, 200, await service.setKey(body.role, body.key ?? null));
      }
      if (route === 'POST /api/models/start') {
        const body = await readBody(req);
        return sendJson(res, 200, await service.startModel(body.role, body.id, { force: body.force === true }));
      }
      if (route === 'POST /api/models/stop') return sendJson(res, 200, await service.stopModel((await readBody(req)).role));
      if (route === 'POST /api/models/cloud') return sendJson(res, 200, await service.useCloudBrain());
      if (route === 'POST /api/translate-test') return sendJson(res, 200, await service.translateTest((await readBody(req)).text));

      if (route === 'POST /api/chat/send') {
        const body = await readBody(req);
        return streamTo(res, (ctx) => service.send({ text: body.text, mode: body.mode, ...ctx }));
      }
      if (route === 'POST /api/chat/regenerate') {
        const body = await readBody(req);
        return streamTo(res, (ctx) => service.regenerate({ mode: body.mode, ...ctx }));
      }
      if (route === 'POST /api/chat/clear') return sendJson(res, 200, await service.clear());
      if (route === 'POST /api/compare') {
        const body = await readBody(req);
        return streamTo(res, (ctx) => service.compare({ text: body.text, ...ctx }));
      }
      if (route === 'DELETE /api/compare') return sendJson(res, 200, await service.clearComparisons());

      let m = /^POST \/api\/compare\/([\w-]+)\/choose$/.exec(route);
      if (m) return sendJson(res, 200, await service.chooseComparison(m[1], (await readBody(req)).verdict));

      m = /^POST \/api\/chat\/messages\/([\w-]+)\/edit$/.exec(route);
      if (m) {
        const body = await readBody(req);
        if (body.regenerate) return streamTo(res, (ctx) => service.edit(m[1], body, ctx));
        return sendJson(res, 200, await service.edit(m[1], body));
      }
      m = /^DELETE \/api\/chat\/messages\/([\w-]+)$/.exec(route);
      if (m) return sendJson(res, 200, await service.remove(m[1], { after: url.searchParams.get('after') === '1' }));

      return sendJson(res, 404, { error: 'Нет такого маршрута.' });
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      log(`ошибка ${route}: ${error.message}`);
      return sendJson(res, 500, { error: 'Внутренняя ошибка сервера.' });
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`необработанная ошибка: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера.' });
      else res.end();
    });
  });

  return {
    server,
    service,
    listen: (port = 3200) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        // Только loopback: наружу приложение не торчит.
        server.listen(port, '127.0.0.1', () => resolve(server.address()));
      }),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await service.runner.stopAll();
      await service.store.flush();
    },
  };
}
