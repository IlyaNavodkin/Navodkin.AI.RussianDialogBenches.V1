#!/usr/bin/env node
/**
 * Прогон набора русских вопросов через «Сравнить» (напрямую vs через переводчик).
 * Работает на отдельной копии данных (data-bench/), чат пользователя не трогает.
 *
 *   node scripts/bench.mjs [--file scripts/questions.ru.json] [--limit N]
 *        [--brain-url URL] [--brain-model имя] [--translator-url URL] [--translator-model имя]
 *        [--profile generic|hymt] [--no-thinking on|off|auto] [--brain-max-tokens N] [--no-stream-out] [--memory N]
 *
 * Результат: data-bench/bench-<время>.json (те же записи, что в журнале сравнений)
 * и таблица в консоли. Оценку качества ставит человек: смотри ответы бок о бок.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const questions = JSON.parse(await fs.readFile(path.resolve(opt('file', path.join(appDir, 'scripts', 'questions.ru.json'))), 'utf8'));
const limit = Number(opt('limit', questions.length));
const dataDir = path.join(appDir, 'data-bench');
const app = await createApp({ dataDir, log: (line) => console.error(line) });
const { port } = await app.listen(0);
const base = `http://127.0.0.1:${port}`;

const call = async (method, url, body) => {
  const response = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`${method} ${url}: ${(await response.json().catch(() => ({}))).error ?? response.status}`);
  return response;
};

const patch = {
  memoryN: Number(opt('memory', 0)),
  streamOut: !flag('no-stream-out'),
  brain: { baseUrl: opt('brain-url', ''), model: opt('brain-model', ''), noThinking: opt('no-thinking', 'auto'), ...(opt('brain-max-tokens') ? { maxTokens: Number(opt('brain-max-tokens')) } : {}) },
  translator: { baseUrl: opt('translator-url', ''), model: opt('translator-model', ''), profile: opt('profile', 'generic') },
};
await call('PUT', '/api/settings', patch);
const cfg = app.service.cfg();
console.log(`Мозг: ${cfg.brain.baseUrl} «${cfg.brain.model}»\nПереводчик: ${cfg.translator.baseUrl} «${cfg.translator.model}» (${cfg.translator.profile})\nПамять: ${patch.memoryN}, перевод по предложениям: ${patch.streamOut}\n`);

const sec = (ms) => (ms === undefined || ms === null ? '   —' : `${(ms / 1000).toFixed(1).padStart(5)}`);
const rows = [];
for (const item of questions.slice(0, limit)) {
  await call('POST', '/api/chat/clear');
  const response = await call('POST', '/api/compare', { text: item.q });
  let entry = null;
  for (const line of (await response.text()).split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'compare') entry = event.entry;
    if (event.type === 'error') console.error(`  ! ${event.message}`);
  }
  if (!entry) continue;
  rows.push({ ...entry, benchId: item.id });
  const d = entry.direct;
  const t = entry.translate;
  console.log(`${item.id.padEnd(9)} напрямую: итого ${sec(d.timings?.totalMs)} с | через переводчик: вход ${sec(t.timings?.inMs)} мозг ${sec(t.timings?.brainMs)} хвост ${sec(t.timings?.outMs)} 1-я фраза ${sec(t.timings?.firstRuMs)} итого ${sec(t.timings?.totalMs)} с${d.error ? ` | ОШИБКА напрямую: ${d.error}` : ''}${t.error ? ` | ОШИБКА перевода: ${t.error}` : ''}`);
}

const avg = (side, key) => {
  const values = rows.filter((r) => !r[side].error).map((r) => r[side].timings?.[key]).filter((x) => typeof x === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
};
console.log(`\nСреднее: напрямую итого ${sec(avg('direct', 'totalMs'))} с (1-й токен ${sec(avg('direct', 'ttftMs'))}); через переводчик итого ${sec(avg('translate', 'totalMs'))} с, вход ${sec(avg('translate', 'inMs'))}, мозг ${sec(avg('translate', 'brainMs'))}, хвост ${sec(avg('translate', 'outMs'))}, 1-я фраза ${sec(avg('translate', 'firstRuMs'))}`);

const file = path.join(dataDir, `bench-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.json`);
await fs.writeFile(file, JSON.stringify({ settings: patch, roles: { brain: { baseUrl: cfg.brain.baseUrl, model: cfg.brain.model }, translator: { baseUrl: cfg.translator.baseUrl, model: cfg.translator.model, profile: cfg.translator.profile } }, rows }, null, 2));
console.log(`Сохранено: ${file}`);
await app.close();
