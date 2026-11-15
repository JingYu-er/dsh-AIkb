import type { GlossaryEntry } from './glossary.js';

export type TermKind = 'zh-en' | 'en-zh' | 'abbrev';

export interface HarvestedTerm {
  readonly a: string;
  readonly b: string;
  readonly kind: TermKind;
}

/** "静态工作点 (quiescent operating point)" and the reverse order. */
const ZH_EN = /([\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9·\-\s]{1,24}?)\s*[（(]\s*([A-Za-z][A-Za-z0-9\s\-/&.,]{1,48}?)\s*[）)]/g;
const EN_ZH = /([A-Za-z][A-Za-z0-9\s\-/&.]{2,48}?)\s*[（(]\s*([\u4e00-\u9fff][\u4e00-\u9fff\s]{1,20}?)\s*[）)]/g;
/** "Advanced RISC Machine (ARM)": the acronym is what people type, the full form is what books print. */
const ABBREV = /([A-Z][A-Za-z]+(?:\s+[A-Za-z]+){1,6})\s*[（(]\s*([A-Z][A-Z0-9]{1,7})\s*[）)]/g;

const REJECT = new Set([
  '图', '表', '注', '见', '页', '章', '节', '式', '例', '等等', '以下', '如下', '上述', '其中',
  '如图', '如表', '公式', '单位', '说明', '注意', '备注', '来源', '参考',
]);

const MAX_A = 40;
const MAX_B = 60;

function clean(value: string): string | undefined {
  const text = value.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
  if (text === '' || text.length > MAX_B) return undefined;
  if (REJECT.has(text)) return undefined;
  if (!/[\u4e00-\u9fffA-Za-z]/.test(text)) return undefined;
  return text;
}

function push(out: HarvestedTerm[], a: string | undefined, b: string | undefined, kind: TermKind): void {
  if (a === undefined || b === undefined) return;
  if (a.toLowerCase() === b.toLowerCase()) return;
  if (a.length > MAX_A || b.length > MAX_B) return;
  if (!out.some((entry) => entry.a === a && entry.b === b)) out.push({ a, b, kind });
}

/**
 * Extract bilingual / acronym pairs from text. No dictionary and no model: parenthesised
 * translations and acronym definitions are the two places where books state a term pair
 * explicitly. Everything else is left to the sentence itself.
 */
export function harvestTermPairs(text: string): HarvestedTerm[] {
  const out: HarvestedTerm[] = [];
  for (const match of text.matchAll(ZH_EN)) {
    push(out, clean(match[1] ?? ''), clean(match[2] ?? ''), 'zh-en');
  }
  for (const match of text.matchAll(EN_ZH)) {
    push(out, clean(match[1] ?? ''), clean(match[2] ?? ''), 'en-zh');
  }
  for (const match of text.matchAll(ABBREV)) {
    const full = clean(match[1] ?? '');
    const acronym = clean(match[2] ?? '');
    if (full === undefined || acronym === undefined) continue;
    // A real definition expands to more words than the acronym itself.
    if (full.split(' ').length < 2 || acronym.length >= full.length) continue;
    push(out, acronym, full, 'abbrev');
  }
  return out;
}

export function toGlossaryEntries(terms: readonly HarvestedTerm[]): GlossaryEntry[] {
  return terms.map((term) => ({ a: term.a, b: term.b }));
}
