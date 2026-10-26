import fs from 'node:fs/promises';
import path from 'node:path';

let counter = 0;

/**
 * Атомарная запись JSON: данные пишутся во временный файл рядом, сбрасываются
 * на диск и переименовываются поверх целевого. Читатель видит либо старое
 * содержимое, либо новое целиком — оборванная запись не портит файл.
 */
export async function writeJsonAtomic(file, value, { mode } = {}) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${(counter += 1)}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await fs.open(tmp, 'w', mode);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // На Windows rename поверх файла иногда кратко отказывает (антивирус, индексатор).
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
      }
    }
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Читает JSON; нет файла → null; битый файл откладывается в `.corrupt-<время>` и → null. */
export async function readJsonSafe(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    return null;
  }
}
