import fs from 'node:fs';

/** Минимальный разбор .env: KEY=value, кавычки, комментарии, `export `. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]] = value;
  }
  return out;
}

/** Читает файл .env; если файла нет — пустой объект. Значения из process.env важнее. */
export function loadEnvFile(file, { processEnv = process.env } = {}) {
  let parsed = {};
  try {
    parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    // Нет файла — не беда: останутся умолчания.
  }
  for (const key of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_SESSION_ID']) {
    if (processEnv[key]) parsed[key] = processEnv[key];
  }
  return parsed;
}
