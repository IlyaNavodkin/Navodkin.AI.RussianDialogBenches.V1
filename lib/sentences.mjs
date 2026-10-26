/**
 * Нарезка потока текста на предложения для построчного перевода обратно на
 * русский. Предложение считается законченным, когда за знаком конца уже
 * пришёл пробел и начало следующего; слишком короткие куски склеиваются.
 */

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'e.g', 'i.e', 'u.s', 'no', 'inc', 'jr', 'sr']);

const BOUNDARY = /([.!?…]+["'»)\]]*)(\s+)(?=\S)/g;

function endsWithAbbreviation(segment) {
  const word = /([A-Za-z.]+)[.!?…]+["'»)\]]*$/.exec(segment.trimEnd())?.[1]?.toLowerCase();
  if (!word) return false;
  if (ABBREVIATIONS.has(word)) return true;
  // Инициал: «J. Smith».
  return /^[a-z]$/.test(word);
}

export class SentenceSplitter {
  constructor({ minChars = 24, maxChars = 400 } = {}) {
    this.minChars = minChars;
    this.maxChars = maxChars;
    this.buffer = '';
  }

  /** Добавляет текст, возвращает готовые куски [{ text, tail }] (tail — разделитель после). */
  push(text) {
    this.buffer += text;
    const out = [];
    for (;;) {
      const piece = this.#takeOne();
      if (!piece) break;
      out.push(piece);
    }
    return out;
  }

  /** Остаток в конце потока. */
  flush() {
    const text = this.buffer.trim();
    this.buffer = '';
    return text ? { text, tail: '' } : null;
  }

  #takeOne() {
    // Абзацы и строки списков — всегда граница.
    const paragraph = /\n+/.exec(this.buffer);
    BOUNDARY.lastIndex = 0;
    let candidate = null;
    for (let m = BOUNDARY.exec(this.buffer); m; m = BOUNDARY.exec(this.buffer)) {
      const end = m.index + m[1].length;
      const head = this.buffer.slice(0, end);
      if (endsWithAbbreviation(head)) continue;
      if (head.trim().length < this.minChars) continue;
      candidate = { end, tailEnd: end + m[2].length, tail: m[2] };
      break;
    }
    if (paragraph) {
      const head = this.buffer.slice(0, paragraph.index);
      const useParagraph = !candidate || paragraph.index < candidate.end;
      if (useParagraph && head.trim()) {
        this.buffer = this.buffer.slice(paragraph.index + paragraph[0].length);
        return { text: head.trim(), tail: '\n' };
      }
      if (useParagraph && !head.trim()) {
        this.buffer = this.buffer.slice(paragraph.index + paragraph[0].length);
        return this.#takeOne();
      }
    }
    if (candidate) {
      const text = this.buffer.slice(0, candidate.end).trim();
      this.buffer = this.buffer.slice(candidate.tailEnd);
      return { text, tail: candidate.tail.includes('\n') ? '\n' : ' ' };
    }
    if (this.buffer.length > this.maxChars) {
      // Нет знаков препинания слишком долго: режем по последнему пробелу.
      const cut = this.buffer.lastIndexOf(' ', this.maxChars);
      if (cut > this.minChars) {
        const text = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut + 1);
        return { text, tail: ' ' };
      }
    }
    return null;
  }
}
