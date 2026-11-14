const CJK_START = 0x3400;
const CJK_END = 0x9fff;

const LATIN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with',
]);

/** CJK text is matched as bigrams (single char only when the run is one char); Latin as lowercase words. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let latin = '';
  let cjk = '';
  const flushLatin = (): void => {
    if (latin.length > 0) {
      const word = latin.toLowerCase();
      if (word.length > 1 && !LATIN_STOPWORDS.has(word)) tokens.push(word);
      latin = '';
    }
  };
  const flushCjk = (): void => {
    if (cjk.length === 1) tokens.push(cjk);
    for (let index = 0; index + 1 < cjk.length; index += 1) tokens.push(cjk.slice(index, index + 2));
    cjk = '';
  };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= CJK_START && code <= CJK_END) {
      flushLatin();
      cjk += char;
      continue;
    }
    if (/[A-Za-z0-9_+\-.#/]/.test(char)) {
      flushCjk();
      latin += char;
      continue;
    }
    flushLatin();
    flushCjk();
  }
  flushLatin();
  flushCjk();
  return tokens;
}
