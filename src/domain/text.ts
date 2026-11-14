const CJK_START = 0x3400;
const CJK_END = 0x9fff;

/** Function characters that turn a CJK bigram into noise ("的共", "是在"). */
const CJK_STOP_CHARS = new Set('的了是在和与及或为时后前个这那也就都而并被把从到会可以之其此所者于对由用让使得地吗呢啊'.split(''));

/** Question filler ("怎么", "原理", "区别") that carries no topical signal. */
const CJK_STOP_BIGRAMS = new Set([
  '什么', '怎么', '如何', '为什', '哪些', '哪个', '区别', '原理', '工作', '作用', '用法',
  '使用', '介绍', '讲解', '请问', '是否', '可以', '需要', '一般', '通常', '基本', '主要',
  '有什', '么用', '怎样', '有哪', '的是', '是什', '么区', '哪些', '一下', '详细', '具体',
]);

function isStopBigram(bigram: string): boolean {
  if (CJK_STOP_BIGRAMS.has(bigram)) return true;
  return CJK_STOP_CHARS.has(bigram[0] ?? '') || CJK_STOP_CHARS.has(bigram[1] ?? '');
}

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
    for (let index = 0; index + 1 < cjk.length; index += 1) {
      const bigram = cjk.slice(index, index + 2);
      if (!isStopBigram(bigram)) tokens.push(bigram);
    }
    cjk = '';
  };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= CJK_START && code <= CJK_END) {
      flushLatin();
      cjk += char;
      continue;
    }
    if (/[A-Za-z0-9]/.test(char)) {
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
