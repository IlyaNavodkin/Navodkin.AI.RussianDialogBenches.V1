import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './atomic.mjs';
import { defaultSettings, mergeSettings } from './settings.mjs';

export const FILE_VERSION = 1;

/**
 * Один JSON-файл `data/chat.json`: настройки, история, журнал сравнений.
 * Ключи доступа лежат отдельно (`data/keys.json`) и в экспорт не попадают.
 */
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'chat.json');
    this.keysFile = path.join(dir, 'keys.json');
    this.data = Store.empty();
    this.keys = {};
    this.chain = Promise.resolve();
  }

  static empty() {
    return { version: FILE_VERSION, settings: defaultSettings(), messages: [], comparisons: [], notesCache: null };
  }

  async load() {
    const saved = await readJsonSafe(this.file);
    const data = Store.empty();
    if (saved && typeof saved === 'object') {
      data.settings = mergeSettings(data.settings, saved.settings ?? {}).settings;
      if (Array.isArray(saved.messages)) data.messages = saved.messages.filter((m) => m && typeof m.id === 'string');
      if (Array.isArray(saved.comparisons)) data.comparisons = saved.comparisons.filter((c) => c && typeof c.id === 'string');
      if (saved.notesCache && typeof saved.notesCache.hash === 'string') data.notesCache = saved.notesCache;
    }
    this.data = data;
    const keys = await readJsonSafe(this.keysFile);
    this.keys = keys && typeof keys === 'object' ? { brain: String(keys.brain ?? ''), translator: String(keys.translator ?? '') } : {};
    return data;
  }

  /** Записи ставятся в очередь: файл всегда соответствует последнему состоянию. */
  save() {
    const run = () => writeJsonAtomic(this.file, this.data);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  saveKeys() {
    const run = () => writeJsonAtomic(this.keysFile, this.keys, { mode: 0o600 });
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  /** Дождаться всех поставленных в очередь записей. */
  async flush() {
    await this.chain;
  }
}
