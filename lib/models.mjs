import path from 'node:path';

/**
 * Реестр локальных моделей (GGUF) и путь к llama-server. Используется и сервером приложения
 * (выбор модели в вебе), и скриптом scripts/llm.mjs.
 */
export const HOME = process.env.LLM_HOME || 'D:\\localai\\llm';
export const MODELS_DIR = path.join(HOME, 'models');
export const SERVER = process.env.LLAMA_SERVER || path.join(HOME, 'llama.cpp', 'b11889', 'llama-server.exe');

/**
 * Размеры и SHA-256 взяты из API Hugging Face (tree/main) 26.10.2026.
 * role — какую роль модель обычно играет и на каком порту по умолчанию живёт.
 * args — дополнительные флаги llama-server (параметры сэмплирования задаёт приложение).
 */
export const MODELS = {
  'hymt2-1.8b': {
    title: 'Hy-MT2-1.8B Q4_K_M — переводчик Tencent (Apache-2.0)',
    repo: 'tencent/Hy-MT2-1.8B-GGUF',
    file: 'Hy-MT2-1.8B-Q4_K_M.gguf',
    bytes: 1_133_080_448,
    sha256: 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699',
    port: 8181,
    alias: 'translator',
  },
  'qwen3.5-4b': {
    title: 'Qwen3.5-4B Q4_K_M — мозг (Apache-2.0, Unsloth-сборка)',
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    bytes: 2_740_937_888,
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    port: 8180,
    alias: 'brain',
  },
  'bolt-e4b': {
    title: 'Nemotron-3.5-Bolt-E4B Q4_K_M — мозг (NVIDIA, OpenMDW-1.1, база Gemma 4)',
    repo: 'nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB',
    file: 'Nemotron-3.5-Bolt-E4B-Q4_K_M.gguf',
    bytes: 6_180_446_208,
    sha256: 'c8af2b8aea10a690a1d9491db744a9446660173cb38fc489612b556615a69612',
    port: 8180,
    alias: 'brain',
  },
  'lfm2.5-24b': {
    title: 'LFM2.5-24B-A2B UD-Q3_K_XL — мозг (LiquidAI LFM 1.0, квант Unsloth; всегда «думает»)',
    repo: 'unsloth/LFM2.5-24B-A2B-GGUF',
    file: 'LFM2.5-24B-A2B-UD-Q3_K_XL.gguf',
    bytes: 10_947_100_928,
    sha256: 'd54834c785c7e265f1cb7375e47aa6f55a0b7cfab75816254c4d2e0c82fd5efc',
    port: 8180,
    alias: 'brain',
    thinks: true, // всегда размышляет: нужен большой лимит токенов
  },
  // Файлы, положенные пользователем вручную (источник не известен, SHA-256 посчитан локально 26.10.2026).
  'lfm2.5-2.6b-unc': { title: 'LFM2.5-2.6B Uncensored Q8_0 — мозг (сторонняя модификация)', repo: 'SC117/LFM2.5-2.6B-Uncensored-GGUF',
    file: 'LFM2.5-2.6B-Uncensored-Q8_0.gguf', bytes: 2_874_779_296, sha256: 'bc7472c05f596876b24040ea8ad8a1475ccb9ff45208c4b0a2fd43757a988e0b', port: 8180, alias: 'brain', thinks: true },
  'lfm2.5-8b-unc': { title: 'LFM2.5-8B-A1B Uncensored Q6_K — мозг (сторонняя модификация)', repo: 'zaakirio/LFM2.5-8B-A1B-Uncensored-GGUF',
    file: 'LFM2.5-8B-A1B-Uncensored-Q6_K.gguf', bytes: 6_959_786_688, sha256: 'e43042a23d85093be0a0987a3a62288f886d7817a72bd70b08b4de849968e6b8', port: 8180, alias: 'brain', thinks: true },
  'lfm2.5-24b-abl': { title: 'LFM2.5-24B-A2B Abliterated UD-IQ3_XXS — мозг (сторонняя модификация)', file: 'LFM2.5-24B-A2B-Abliterated-UD-IQ3_XXS.gguf', bytes: 8_959_328_480, sha256: 'f7de3abe93401891580936573d6f7cc289b504f633628bc6f0609e12d4e5d76e', port: 8180, alias: 'brain', thinks: true },
  luqwen5: { title: 'Luqwen5-4B Q8_0 — мозг (сторонняя сборка)', repo: 'LLiserginov/Luqwen5-4B',
    file: 'Luqwen5-4B_q8_0.gguf', bytes: 4_610_579_744, sha256: '3ad469f8c5ed83b9ef7d23f4acc52a2d23f1b6ae13524e2914ef8ec22137cf94', port: 8180, alias: 'brain' },
  // Уже лежат на диске (скачаны основным проектом) — тут только чтобы запускать тем же скриптом.
  tlite: { title: 'T-lite-it-2.1 8B Q4_K_M (уже скачана)', file: 'T-lite-it-2.1-Q4_K_M.gguf', port: 8180, alias: 'brain' },
  gigachat: { title: 'GigaChat3.1-10B-A1.8B Q4_K_M (уже скачана)', repo: 'ai-sage/GigaChat3.1-10B-A1.8B-GGUF',
    file: 'GigaChat3.1-10B-A1.8B-q4_K_M.gguf', bytes: 6_474_702_976, sha256: '68a8732fb5cee04f83ebffd7924e15c534d4442c5a43d2ba9e2041fe310b8deb', port: 8180, alias: 'brain' },
  'gigachat-lightning-unc-q6': { title: 'GigaChat3.1-Lightning Uncensored Q6_K — мозг (сторонняя модификация, MIT)', repo: 'mradermacher/GigaChat3.1-Lightning-Uncensored-GGUF',
    file: 'GigaChat3.1-Lightning-Uncensored.Q6_K.gguf', bytes: 8_782_244_256, sha256: '9b2a56310796ebfedde0bca0e9e751bbd5df8e26ec08ef9bb502df94956cf138', port: 8180, alias: 'brain' },
  'gigachat-lightning-unc-q4': { title: 'GigaChat3.1-Lightning Uncensored Q4_K_M — мозг (сторонняя модификация, MIT)', repo: 'mradermacher/GigaChat3.1-Lightning-Uncensored-GGUF',
    file: 'GigaChat3.1-Lightning-Uncensored.Q4_K_M.gguf', bytes: 6_474_703_776, sha256: 'd3e2ee5eb0bd0d0e2520224cb0a983ebb20d6c55de3e683cc774b4b182462c41', port: 8180, alias: 'brain' },
  rusmind: { title: 'RusMind Моментум 4.7 (4.6B) Q4_K_M — мозг (DICPlay, своя лицензия, личное использование)', repo: 'DICPlay/RusMind-4.7-Momentum',
    file: 'RusMind-Momentum-4.7-Q4_K_M.gguf', bytes: 3_427_880_800, sha256: '99684d0f58f456ed3b7ec889d7264159b724c5525923e723764856ba246d01cb', port: 8180, alias: 'brain' },
};
