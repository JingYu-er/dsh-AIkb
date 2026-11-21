/**
 * Exact-identifier matching: standard numbers, section numbers, part numbers, register names and
 * pin names are the tokens a reader greps for, and BM25 treats them as ordinary words. Pulling them
 * out of both sides lets retrieval reward the chunk that literally contains the token instead of a
 * chunk that happens to repeat its pieces. Pure functions only: ranking owns the policy.
 */

export interface IdentifierMatch {
  /** Canonical forms of the query identifiers that occur in the text, in query order. */
  matched: string[];
  /** Weighted count: rarer identifier shapes weigh more, repeats add a little. */
  score: number;
}

const STANDARD = /\b(?:GB(?:\/T)?|ISO|IEC|ANSI|ASTM|JIS|DIN|EN|IEEE)\s?\d[\d.\-:]*/gi;
const REGISTER = /\b[A-Z][A-Z0-9]{1,}_[A-Z0-9_]{1,}\b/g;
const PIN = /\bP[A-K]\d{1,2}\b/g;
const SECTION = /(?<![\w.])\d+(?:\.\d+){1,4}(?![\w.%])/g;
const MODEL = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\d[A-Z0-9\-]*\b/g;

/** Upper case, one dash form, no spaces: the same identifier typed by two people compares equal. */
export function normalizeIdentifier(token: string): string {
  return token
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/**
 * Model numbers are the loosest pattern, so they are filtered by shape: a digit, four characters or
 * more, and not something a section-number or unit pattern already explains (3V3, 100nF).
 */
function looksLikeModel(token: string): boolean {
  if (token.length < 4) return false;
  if (!/\d/.test(token)) return false;
  if (/^\d/.test(token)) return false;
  if (/^(?:V|A|MA|MV|KV|NF|UF|PF|UH|MH|W|KW|MM|CM|KM|HZ|KHZ|MHZ|GHZ)$/.test(token)) return false;
  // Units hugging a number (3V3, 5V, 100nF) are values, not part numbers.
  if (/^\d+(?:\.\d+)?(?:V|A|MA|F|NF|UF|PF|H|MH|UH|W|KW|MM|CM|KM|HZ|KHZ|MHZ|GHZ|OHM|K)$/.test(token)) return false;
  return true;
}

const WEIGHT_STANDARD = 3;
const WEIGHT_REGISTER = 3;
const WEIGHT_PIN = 2;
const WEIGHT_MODEL = 2;
const WEIGHT_SECTION = 1.5;

/** Extract the identifiers a query or a chunk contains; duplicates collapse to their first spelling. */
export function extractIdentifiers(text: string): string[] {
  const input = String(text ?? '');
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (token: string): void => {
    const canonical = normalizeIdentifier(token);
    if (canonical === '' || seen.has(canonical)) return;
    seen.add(canonical);
    found.push(canonical);
  };
  for (const match of input.matchAll(STANDARD)) add(match[0]);
  for (const match of input.matchAll(REGISTER)) add(match[0]);
  for (const match of input.matchAll(PIN)) add(match[0]);
  for (const match of input.matchAll(SECTION)) add(match[0]);
  for (const match of input.matchAll(MODEL)) {
    if (looksLikeModel(match[0])) add(match[0]);
  }
  return found;
}

/** Shape-based weights on the canonical form, so no global regex state can leak between tokens. */
function weightOf(token: string): number {
  if (/^(?:GB\/T|GB|ISO|IEC|ANSI|ASTM|JIS|DIN|EN|IEEE)\d[\d.\-:]*$/.test(token)) return WEIGHT_STANDARD;
  if (/^[A-Z][A-Z0-9]{1,}_[A-Z0-9_]{1,}$/.test(token)) return WEIGHT_REGISTER;
  if (/^P[A-K]\d{1,2}$/.test(token)) return WEIGHT_PIN;
  if (/^\d+(?:\.\d+)+$/.test(token)) return WEIGHT_SECTION;
  return WEIGHT_MODEL;
}

/**
 * Does the chunk literally contain the query's identifiers? Counting occurrences (capped) keeps a
 * page that names the token five times ahead of one that names it once, without letting a table of
 * contents swamp the ranking.
 */
export function matchIdentifiers(query: string, text: string): IdentifierMatch {
  const queryIds = extractIdentifiers(query);
  if (queryIds.length === 0) return { matched: [], score: 0 };
  const haystack = normalizeIdentifier(String(text ?? ''));
  if (haystack === '') return { matched: [], score: 0 };
  const matched: string[] = [];
  let score = 0;
  for (const token of queryIds) {
    const occurrences = haystack.split(token).length - 1;
    if (occurrences === 0) continue;
    matched.push(token);
    score += weightOf(token) * Math.min(3, occurrences);
  }
  return { matched, score: Math.round(score * 100) / 100 };
}
