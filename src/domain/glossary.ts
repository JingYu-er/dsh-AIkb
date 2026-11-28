/**
 * Cross-language query expansion, fed only by the vault's own glossary.
 *
 * A Chinese question about an English source shares almost no tokens with the page that
 * answers it, and BM25 alone cannot bridge that gap. Which term pairs apply is a property
 * of the corpus, not of this plugin: kb_ingest harvests them from the documents themselves
 * and stores them in `.wiki/index/glossary.json`. A fresh vault starts empty and grows its
 * own vocabulary; this module hard-codes no field of study.
 */

/** One term pair; a query containing one side also searches the other. */
export interface GlossaryEntry {
  readonly a: string;
  readonly b: string;
}

/** The most expansions one query may carry; beyond that the extra words drown the question. */
const MAX_EXPANSIONS = 8;

function isTermSide(side: string): boolean {
  const text = side.trim();
  if (text.length < 3 || text.length > 60) return false;
  // Register names and part numbers ("TIM3", "I2C", "TIM16/TIM17") are identifiers, not
  // translations: expanding 通用定时器 to TIM3 pulls every MCU manual into a textbook question.
  if (/[0-9]/.test(text) && text.length <= 16) return false;
  return true;
}

/**
 * Harvested pairs are noisy: datasheet tables produce "通用定时器 (TIM3)" and "UID (可选)".
 * Only phrase-like translations survive; identifiers and two-character filler are dropped.
 */
export function isExpandablePair(entry: GlossaryEntry): boolean {
  if (!isTermSide(entry.a) || !isTermSide(entry.b)) return false;
  return entry.a.includes(' ') || entry.b.includes(' ') || entry.a.length >= 6 || entry.b.length >= 6;
}

/**
 * Extra search terms for a query, so a Chinese question can reach an English page.
 *
 * Only the vault's harvested glossary is used; an empty list means no expansion, which is
 * correct for a corpus that has not accumulated bilingual pairs yet.
 */
export function expandQuery(queryText: string, extraEntries: readonly GlossaryEntry[] = []): string[] {
  const lower = queryText.toLowerCase();
  const extra: string[] = [];
  const push = (term: string): void => {
    const text = term.trim();
    if (text.length < 2) return;
    if (lower.includes(text.toLowerCase())) return;
    if (extra.includes(text)) return;
    extra.push(text);
  };
  for (const entry of extraEntries) {
    if (extra.length >= MAX_EXPANSIONS) break;
    if (!isExpandablePair(entry)) continue;
    if (entry.a.length >= 2 && lower.includes(entry.a.toLowerCase())) push(entry.b);
    if (entry.b.length >= 2 && lower.includes(entry.b.toLowerCase())) push(entry.a);
  }
  return extra;
}
