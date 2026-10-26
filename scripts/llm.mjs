#!/usr/bin/env node
/**
 * Модели и llama-server для translate-chat. Самостоятельный скрипт: ничего не
 * импортирует из основного репозитория.
 *
 *   node scripts/llm.mjs list                  что известно и что уже скачано
 *   node scripts/llm.mjs pull <id> [<id>…]     докачать файлы (с проверкой SHA-256)
 *   node scripts/llm.mjs serve <id> [--port N] [--threads N] [--ctx N] [--normal-priority]
 *
 * Куда: D:\localai\llm (меняется переменной LLM_HOME). llama-server берётся из
 * LLAMA_SERVER или <LLM_HOME>\llama.cpp\b11889\llama-server.exe.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { MODELS, MODELS_DIR, SERVER } from '../lib/models.mjs';


const fmt = (n) => `${(n / 2 ** 30).toFixed(2)} ГиБ`;

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

const sizeOf = async (file) => fs.stat(file).then((s) => s.size).catch(() => null);

/** Докачка: недокачанное лежит в <файл>.part, запрос продолжается с нужного байта; в итоге размер и SHA-256 обязаны совпасть. */
export async function pull(id) {
  const model = MODELS[id];
  if (!model?.repo) throw new Error(`«${id}» нечего скачивать (нет repo). Доступно: ${Object.keys(MODELS).filter((k) => MODELS[k].repo).join(', ')}`);
  await fs.mkdir(MODELS_DIR, { recursive: true });
  const dest = path.join(MODELS_DIR, model.file);
  const part = `${dest}.part`;
  const url = `https://huggingface.co/${model.repo}/resolve/main/${model.file}`;

  if ((await sizeOf(dest)) === model.bytes) {
    if ((await sha256File(dest)) === model.sha256) {
      console.log(`= ${model.file} уже на месте и проверен`);
      return;
    }
    await fs.rm(dest);
  }

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const offset = (await sizeOf(part)) ?? 0;
    if (offset === model.bytes) break;
    const response = await fetch(url, { redirect: 'follow', headers: offset ? { Range: `bytes=${offset}-` } : {} }).catch((error) => ({ error }));
    if ('error' in response || (!response.ok && response.status !== 416)) {
      console.log(`! ${model.file}: ${'error' in response ? response.error.message : `HTTP ${response.status}`}, попытка ${attempt}/8`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    if (response.status === 416) break;
    if (offset && response.status === 200) await fs.rm(part, { force: true });
    const append = offset > 0 && response.status === 206;
    let received = append ? offset : 0;
    let lastReport = received;
    console.log(`↓ ${model.file}${append ? ` (с ${fmt(offset)})` : ''}`);
    const body = Readable.fromWeb(response.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      if (received - lastReport >= 512 * 2 ** 20) {
        lastReport = received;
        console.log(`  ${fmt(received)} / ${fmt(model.bytes)} (${Math.round((received / model.bytes) * 100)}%)`);
      }
    });
    try {
      await pipeline(body, createWriteStream(part, { flags: append ? 'a' : 'w' }));
    } catch (error) {
      console.log(`! обрыв: ${error.message}, попытка ${attempt}/8`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    break;
  }

  const size = await sizeOf(part);
  if (size !== model.bytes) throw new Error(`${model.file}: скачано ${size ?? 0} из ${model.bytes} байт — запусти ещё раз, докачает`);
  console.log(`… проверяю SHA-256 ${model.file}`);
  const actual = await sha256File(part);
  if (actual !== model.sha256) {
    await fs.rm(part, { force: true });
    throw new Error(`SHA-256 не совпал для ${model.file}: ${actual}`);
  }
  await fs.rename(part, dest);
  console.log(`✓ ${model.file} (${fmt(size)})`);
}

async function list() {
  console.log(`Папка моделей: ${MODELS_DIR}\nllama-server:  ${SERVER}${existsSync(SERVER) ? '' : '  (НЕ НАЙДЕН)'}\n`);
  for (const [id, model] of Object.entries(MODELS)) {
    const have = await sizeOf(path.join(MODELS_DIR, model.file));
    const state = have === null ? 'нет' : model.bytes && have !== model.bytes ? `неполный (${fmt(have)})` : `есть (${fmt(have)})`;
    console.log(`${id.padEnd(11)} ${state.padEnd(22)} ${model.title}${model.bytes ? `, ${fmt(model.bytes)}` : ''}`);
  }
}

function serve(id, flags) {
  const model = MODELS[id];
  if (!model) throw new Error(`Неизвестная модель «${id}». Доступно: ${Object.keys(MODELS).join(', ')}`);
  const gguf = path.join(MODELS_DIR, model.file);
  if (!existsSync(SERVER)) throw new Error(`Нет llama-server: ${SERVER}`);
  if (!existsSync(gguf)) throw new Error(`Нет файла ${gguf}. Скачай: node scripts/llm.mjs pull ${id}`);
  const get = (name, fallback) => {
    const i = flags.indexOf(`--${name}`);
    return i >= 0 ? flags[i + 1] : fallback;
  };
  const port = get('port', String(model.port));
  const args = [
    '-m', gguf,
    '--alias', get('alias', model.alias),
    '--host', '127.0.0.1',
    '--port', port,
    '-c', get('ctx', '4096'),
    '-t', get('threads', '6'),
    '-np', '1',
    '--jinja',
    '--cache-reuse', '256',
  ];
  console.log(`${SERVER} ${args.join(' ')}`);
  const child = spawn(SERVER, args, { stdio: 'inherit', windowsHide: true });
  if (!flags.includes('--normal-priority') && child.pid) {
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // не критично
    }
  }
  console.log(`Слушает http://127.0.0.1:${port}/v1 (роль «${get('alias', model.alias)}»). Остановить: Ctrl+C.`);
  const stop = () => child.kill();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

const [command, ...rest] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (command === 'list') await list();
    else if (command === 'pull') {
      const ids = rest.filter((a) => !a.startsWith('--'));
      if (!ids.length) throw new Error('Укажи id: node scripts/llm.mjs pull hymt2-1.8b qwen3.5-4b');
      for (const id of ids) await pull(id);
    } else if (command === 'serve') {
      const [id, ...flags] = rest;
      serve(id, flags);
    } else {
      console.log('Команды: list | pull <id>… | serve <id> [--port N] [--threads N] [--ctx N] [--alias имя] [--normal-priority]');
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
