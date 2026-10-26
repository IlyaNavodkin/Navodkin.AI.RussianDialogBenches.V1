#!/usr/bin/env node
/**
 * Диалоговый бенч: один и тот же «живой русский разговор» (dialog-scenario.mjs) на каждой модели.
 *   категория 1 — два прогона: через переводчик Hy-MT2-1.8B и напрямую;
 *   категория 2 — один прогон напрямую.
 * Пишет reports/data/<модель>-<режим>.json, reports/<модель>.md и reports/таблица.md.
 *
 *   node scripts/dialog-bench.mjs                  все модели
 *   node scripts/dialog-bench.mjs qwen3.5-4b,luqwen5  только указанные id (через запятую)
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MODELS } from '../lib/models.mjs';
import { ModelRunner } from '../lib/runner.mjs';
import { ChatService } from '../lib/service.mjs';
import { NEUTRAL_PROMPTS, SCENARIO, SUMMARY } from './dialog-scenario.mjs';

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(appDir, 'reports');
const dataDir = path.join(reportsDir, 'data');
const workDir = path.join(appDir, 'data-dialog');
const envFile = process.env.LLM_ENV_FILE || undefined;
const MEMORY_N = 8;
const TRANSLATOR_ID = 'hymt2-1.8b';

const JOBS = [
  { id: 'lfm2.5-2.6b-unc', modes: ['translate', 'direct'] },
  { id: 'lfm2.5-8b-unc', modes: ['translate', 'direct'] },
  { id: 'bolt-e4b', modes: ['translate', 'direct'] },
  { id: 'qwen3.5-4b', modes: ['translate', 'direct'] },
  { id: 'gigachat', modes: ['direct'] },
  { id: 'luqwen5', modes: ['direct'] },
  { id: 'rusmind', modes: ['direct'] },
  { id: 'gigachat-lightning-unc-q6', modes: ['direct'] },
  { id: 'gigachat-lightning-unc-q4', modes: ['direct'] },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toLocaleTimeString('ru-RU');
const log = (line) => console.log(`${stamp()}  ${line}`);

/** Пик и текущий рабочий набор процесса (Windows). Пик — максимум с момента старта llama-server. */
async function ramOf(pid) {
  if (!pid) return null;
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `$p = Get-Process -Id ${Number(pid)}; "$($p.PeakWorkingSet64) $($p.WorkingSet64)"`,
    ]);
    const [peak, now] = stdout.trim().split(/\s+/).map(Number);
    return { peakMB: Math.round(peak / 2 ** 20), nowMB: Math.round(now / 2 ** 20) };
  } catch {
    return null;
  }
}

async function waitReady(runner, role, timeoutMs = 300_000) {
  const started = Date.now();
  for (;;) {
    const slot = runner.status()[role];
    if (!slot) throw new Error(`сервер роли «${role}» не запущен`);
    if (slot.status === 'ready') return (Date.now() - started) / 1000;
    if (slot.status === 'failed' || slot.status === 'stopped') {
      throw new Error(slot.error ?? `сервер роли «${role}»: ${slot.status}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`роль «${role}»: модель не загрузилась за ${timeoutMs / 1000} с`);
    await sleep(500);
  }
}

async function runOne(runner, id, mode) {
  const key = `${id}-${mode}`;
  const withTranslator = mode === 'translate';
  const result = {
    id,
    key,
    title: MODELS[id].title,
    file: MODELS[id].file,
    bytes: MODELS[id].bytes ?? null,
    mode,
    withTranslator,
    memoryN: MEMORY_N,
    loadSec: null,
    translatorLoadSec: null,
    ram: {},
    error: null,
    messages: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  await fs.rm(path.join(workDir, key), { recursive: true, force: true });
  await runner.stopAll();
  const service = await new ChatService({ dataDir: path.join(workDir, key), envFile, runner }).init();
  let brainPid = null;
  let translatorPid = null;
  try {
    await service.updateSettings({ mode, memoryN: MEMORY_N, streamOut: true, notes: '', prompts: NEUTRAL_PROMPTS });
    log(`${key}: загружаю мозг…`);
    await service.startModel('brain', id);
    result.loadSec = await waitReady(runner, 'brain');
    brainPid = runner.slots.brain?.child.pid ?? null;
    result.ram.brainLoaded = await ramOf(brainPid);
    if (withTranslator) {
      await service.startModel('translator', TRANSLATOR_ID);
      result.translatorLoadSec = await waitReady(runner, 'translator');
      translatorPid = runner.slots.translator?.child.pid ?? null;
    } else {
      await service.stopModel('translator');
    }
    log(`${key}: мозг готов за ${result.loadSec.toFixed(1)} с, пишу диалог`);
    for (const step of [...SCENARIO, SUMMARY]) {
      const reply = await service.send({ text: step.text, mode });
      log(`${key}: ${step.label}: ${reply.ok ? 'ok' : `ОШИБКА ${reply.error}`}`);
    }
    result.ram.brain = await ramOf(brainPid);
    result.ram.translator = withTranslator ? await ramOf(translatorPid) : null;
  } catch (error) {
    result.error = error.message;
    log(`${key}: ОШИБКА ${error.message}`);
  } finally {
    result.messages = service.data.messages;
    result.finishedAt = new Date().toISOString();
    await service.store.flush();
    await runner.stopAll();
  }
  return result;
}

// ------------------------------------------------------------------ отчёты

const sec = (ms) => (ms == null || Number.isNaN(ms) ? '—' : `${(ms / 1000).toFixed(1).replace('.', ',')} с`);
const secs = (s) => (s == null ? '—' : `${s.toFixed(1).replace('.', ',')} с`);
const num = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d).replace('.', ','));
const avg = (list) => {
  const v = list.filter((x) => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const sizeGiB = (bytes) => (bytes ? `${(bytes / 2 ** 30).toFixed(2).replace('.', ',')} ГиБ` : '—');
const quote = (text) => text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
const oneLine = (text) => text.replace(/\n+/g, ' ');
const table = (rows) =>
  [
    `| ${rows[0].join(' | ')} |`,
    `|${rows[0].map(() => '---').join('|')}|`,
    ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
const answered = (run) => run.messages.filter((m) => m.role === 'assistant' && !m.error && m.timings);
const LABELS = [...SCENARIO.map((s) => s.label), SUMMARY.label];

function metrics(run) {
  const t = answered(run).map((m) => m.timings);
  const ram = run.ram;
  return [
    ['Загрузка мозга', secs(run.loadSec)],
    ['RAM мозга сразу после загрузки', ram.brainLoaded ? `${ram.brainLoaded.nowMB} МБ` : '—'],
    ['Пик RAM мозга за весь диалог', ram.brain ? `${ram.brain.peakMB} МБ` : '—'],
    ['Пик RAM переводчика', run.withTranslator ? (ram.translator ? `${ram.translator.peakMB} МБ` : '—') : 'не запускался'],
    ['Скорость мозга, tok/s (среднее)', num(avg(t.map((x) => x.tokPerSec)))],
    ['Первый токен мозга (среднее)', sec(avg(t.map((x) => x.ttftMs)))],
    ['Время мозга на ответ (среднее)', sec(avg(t.map((x) => x.brainMs)))],
    ['Перевод вопроса RU→EN (среднее)', run.withTranslator ? sec(avg(t.map((x) => x.inMs))) : 'не делался'],
    ['Перевод ответа EN→RU, хвост после мозга (среднее)', run.withTranslator ? sec(avg(t.map((x) => x.outMs))) : 'не делался'],
    ['Первая русская фраза (среднее)', sec(avg(t.map((x) => x.firstRuMs)))],
    ['Итого на ответ (среднее)', sec(avg(t.map((x) => x.totalMs)))],
    ['Ошибок в диалоге', String(run.messages.filter((m) => m.error).length + (run.error ? 1 : 0))],
  ];
}

function timingLine(m) {
  const t = m.timings;
  const parts = [];
  if (m.mode === 'translate') parts.push(`перевод вопроса ${sec(t.inMs)}`);
  parts.push(`мозг ${sec(t.brainMs)} (первый токен ${sec(t.ttftMs)})`);
  parts.push(`${num(t.tokPerSec)} tok/s, ${t.genTokens ?? '—'} токенов`);
  if (m.mode === 'translate') parts.push(`хвост перевода ${sec(t.outMs)}`, `первая фраза ${sec(t.firstRuMs)}`);
  parts.push(`итого ${sec(t.totalMs)}`);
  return `⏱ ${parts.join(' · ')}`;
}

function renderDialog(messages) {
  const out = [];
  let index = 0;
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(`#### ${LABELS[index] ?? `Сообщение ${index + 1}`}`, '', quote(m.ru), '');
      index += 1;
      if (m.en) out.push(`*Для мозга (EN):* ${oneLine(m.en)}`, '');
    } else {
      if (m.en) out.push(`*Мозг (EN):* ${oneLine(m.en)}`, '');
      if (m.error) out.push(`> **Ошибка:** ${m.error}`, '');
      if (m.ru) out.push(`**Вася:** ${m.ru}`, '');
      if (m.timings) out.push(`_${timingLine(m)}_`, '');
    }
  }
  return out.join('\n');
}

function renderRun(run) {
  const heading = run.withTranslator
    ? '## Режим 1: через переводчик (Hy-MT2-1.8B, RU→EN→RU)'
    : '## Режим 2: напрямую, без переводчика';
  return [
    heading,
    '',
    table([['Метрика', 'Значение'], ...metrics(run)]),
    '',
    run.error ? `> **Прогон прерван:** ${run.error}` : '',
    '### Диалог',
    '',
    renderDialog(run.messages),
  ].join('\n');
}

function renderModel(id, runs) {
  const meta = MODELS[id];
  return [
    `# ${meta.title}`,
    '',
    `- Файл: \`${meta.file}\`, ${sizeGiB(meta.bytes)}`,
    `- Сценарий: ${SCENARIO.length} реплик + просьба о пересказе, память диалога ${MEMORY_N} сообщений`,
    `- Прогоны: ${runs.map((r) => `${r.withTranslator ? 'с переводчиком' : 'напрямую'} (${new Date(r.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })})`).join(', ')}`,
    '',
    runs.map(renderRun).join('\n\n---\n\n'),
    '',
  ].join('\n');
}

async function renderOverview() {
  const files = (await fs.readdir(dataDir)).filter((f) => f.endsWith('.json'));
  const runs = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(path.join(dataDir, f), 'utf8'))));
  const order = (r) => [JOBS.findIndex((j) => j.id === r.id), r.withTranslator ? 0 : 1];
  runs.sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
  const rows = [
    ['Модель', 'Режим', 'Загрузка', 'Пик RAM мозга', 'Пик RAM переводчика', 'tok/s мозга', '1-й токен', 'Перевод вопроса', 'Хвост перевода', 'Первая фраза', 'Итого на ответ', 'Ошибок'],
    ...runs.map((r) => {
      const m = Object.fromEntries(metrics(r).map(([k, v]) => [k, v]));
      return [
        MODELS[r.id].title.split(' — ')[0],
        r.withTranslator ? 'с переводчиком' : 'напрямую',
        m['Загрузка мозга'],
        m['Пик RAM мозга за весь диалог'],
        m['Пик RAM переводчика'],
        m['Скорость мозга, tok/s (среднее)'],
        m['Первый токен мозга (среднее)'],
        m['Перевод вопроса RU→EN (среднее)'],
        m['Перевод ответа EN→RU, хвост после мозга (среднее)'],
        m['Первая русская фраза (среднее)'],
        m['Итого на ответ (среднее)'],
        m['Ошибок в диалоге'],
      ];
    }),
  ];
  await fs.writeFile(path.join(reportsDir, 'таблица.md'), `# Сводная таблица диалогового бенча\n\n${table(rows)}\n`);
}

async function save(result) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, `${result.key}.json`), JSON.stringify(result, null, 2));
}

async function main() {
  const only = process.argv[2] ? process.argv[2].split(',').map((s) => s.trim()) : null;
  await fs.mkdir(reportsDir, { recursive: true });
  const runner = new ModelRunner();
  const stopAndExit = async () => {
    await runner.stopAll();
    process.exit(1);
  };
  process.on('SIGINT', stopAndExit);
  process.on('SIGTERM', stopAndExit);

  for (const job of JOBS) {
    if (only && !only.includes(job.id)) continue;
    const runs = [];
    for (const mode of job.modes) {
      const result = await runOne(runner, job.id, mode);
      await save(result);
      runs.push(result);
      log(`${result.key}: сохранено в reports/data/${result.key}.json`);
    }
    await fs.writeFile(path.join(reportsDir, `${job.id}.md`), renderModel(job.id, runs));
    await renderOverview();
    log(`${job.id}: отчёт reports/${job.id}.md`);
  }
  await runner.stopAll();
  log('готово');
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
