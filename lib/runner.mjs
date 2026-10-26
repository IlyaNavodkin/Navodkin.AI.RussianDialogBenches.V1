import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODELS, MODELS_DIR, SERVER } from './models.mjs';

export const ROLE_PORTS = { brain: 8180, translator: 8181 };
const LOG_LINES = 40;
const READY_TIMEOUT_MS = 300_000;

const GIB = 2 ** 30;
const fmtGiB = (n) => `${(n / GIB).toFixed(1).replace('.', ',')} ГиБ`;

/**
 * Запускает и останавливает llama-server для ролей «мозг» (порт 8180) и «переводчик» (8181).
 * Принимает только id из реестра моделей: произвольные команды и пути извне не принимаются.
 */
export class ModelRunner {
  constructor({
    registry = MODELS,
    modelsDir = MODELS_DIR,
    serverExe = SERVER,
    spawnImpl = spawn,
    fetchImpl = fetch,
    freeMem = () => os.freemem(),
    ports = ROLE_PORTS,
    pollMs = 500,
  } = {}) {
    Object.assign(this, { registry, modelsDir, serverExe, spawnImpl, fetchImpl, freeMem, ports, pollMs });
    this.slots = { brain: null, translator: null };
  }

  filePath(id) {
    return path.join(this.modelsDir, this.registry[id].file);
  }

  list() {
    return Object.entries(this.registry).map(([id, model]) => {
      let size = null;
      try {
        size = statSync(this.filePath(id)).size;
      } catch {
        // файла нет
      }
      return { id, title: model.title, file: model.file, size, present: size !== null, thinks: Boolean(model.thinks), hint: model.alias };
    });
  }

  status() {
    const slot = (s) => (s ? { id: s.id, port: s.port, status: s.status, error: s.error, log: s.log.slice(-8), startedAt: s.startedAt, readyAt: s.readyAt } : null);
    return { brain: slot(this.slots.brain), translator: slot(this.slots.translator), freeMem: this.freeMem(), serverFound: existsSync(this.serverExe) };
  }

  async #healthy(port) {
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Возвращает слот; готовность придёт позже (статус «loading» → «ready» / «failed»). */
  async start(role, id, { force = false, threads = 6, ctx = 4096 } = {}) {
    const port = this.ports[role];
    if (!port) throw new RunnerError('Неизвестная роль.');
    const model = this.registry[id];
    if (!model) throw new RunnerError('Такой модели нет в списке.');
    const file = this.filePath(id);
    if (!existsSync(file)) throw new RunnerError(`Файла модели нет: ${file}`);
    if (!existsSync(this.serverExe)) throw new RunnerError(`Не найден llama-server: ${this.serverExe}`);

    await this.stop(role);
    if (await this.#healthy(port)) {
      throw new RunnerError(`На порту ${port} уже работает чужой сервер (не запущенный из приложения). Останови его или укажи его адрес в настройках.`);
    }
    const need = (statSync(file).size) * 1.2;
    const free = this.freeMem();
    if (!force && free < need) {
      throw new RunnerError(`Не хватает свободной памяти: модели нужно около ${fmtGiB(need)}, свободно ${fmtGiB(free)}. Закрой что-нибудь или запусти всё равно.`, { code: 'memory' });
    }

    const args = ['-m', file, '--alias', role, '--host', '127.0.0.1', '--port', String(port), '-c', String(ctx), '-t', String(threads), '-np', '1', '--jinja', '--cache-reuse', '256'];
    const child = this.spawnImpl(this.serverExe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const slot = { id, port, child, status: 'loading', error: null, log: [], startedAt: Date.now(), readyAt: null, stopping: false };
    this.slots[role] = slot;
    if (child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // не критично
      }
    }
    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        slot.log.push(line.slice(0, 300));
        if (slot.log.length > LOG_LINES) slot.log.shift();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      slot.status = 'failed';
      slot.error = `Не удалось запустить llama-server: ${error.message}`;
    });
    child.on('exit', (code) => {
      slot.exited = true;
      if (slot.stopping) {
        slot.status = 'stopped';
      } else if (slot.status !== 'failed') {
        slot.status = 'failed';
        const tail = slot.log.filter((l) => /error|fail|unknown|cannot|unsupported/i.test(l)).slice(-2).join(' | ');
        slot.error = `llama-server завершился с кодом ${code}${tail ? `: ${tail}` : ''}`;
      }
    });
    this.#waitReady(slot);
    return slot;
  }

  async #waitReady(slot) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (slot.status === 'loading') {
      if (Date.now() > deadline) {
        slot.status = 'failed';
        slot.error = 'Модель не загрузилась за 5 минут.';
        slot.child.kill();
        return;
      }
      if (await this.#healthy(slot.port)) {
        if (slot.status === 'loading') {
          slot.status = 'ready';
          slot.readyAt = Date.now();
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  async stop(role) {
    const slot = this.slots[role];
    if (!slot) return;
    slot.stopping = true;
    if (!slot.exited) {
      const exited = new Promise((resolve) => slot.child.once('exit', resolve));
      slot.child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    slot.status = 'stopped';
    this.slots[role] = null;
  }

  async stopAll() {
    await Promise.all(['brain', 'translator'].map((role) => this.stop(role)));
  }
}

export class RunnerError extends Error {
  constructor(message, { code = 'runner' } = {}) {
    super(message);
    this.code = code;
  }
}
