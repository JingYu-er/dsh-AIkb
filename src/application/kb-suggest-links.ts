import { tokenize } from '../domain/text.js';

/** Read-only link suggestions between notes; nothing is written. */

export interface SuggestEntry {
  readonly relPath: string;
}

export interface SuggestFs {
  listFiles(): Promise<readonly SuggestEntry[]>;
  readText(relPath: string): Promise<string>;
}

export interface LinkSuggestion {
  readonly from: string;
  readonly to: string;
  readonly why: string;
  readonly confidence: number;
}

export interface SuggestReport {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly notes: number;
  readonly suggestions: readonly LinkSuggestion[];
  readonly elapsedMs: number;
}

const SKIP_PREFIX = /^(copilot|\.agents|\.claude|\.wiki)\//i;
/** Compiled drafts are copies of inbox drafts; suggesting links between the two is noise. */
const COMPILED_PREFIX = /^inbox\/_compiled\//i;
/** Templating trees (Zotlit's ZtTemplates, .trash) are code, not notes. */
const SKIP_PATH = /(^|\/)(ZtTemplates|Templater|Templates|\.trash)\//i;
const TEMPLATE_NAME = /\.(eta|template)\.md$|^zotlit-/i;
const FENCED = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---/;
const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const EMBED = /!\[\[[^\]]*\]\]/g;
const MD_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const URL_TOKEN = /https?:\/\/\S+/gi;
/** A note that is only boilerplate + embeds has nothing to reason about. */
const MIN_BODY = 30;

function basenameOf(relPath: string): string {
  const file = relPath.split('/').pop() ?? relPath;
  return file.replace(/\.md$/i, '');
}

/** CJK terms are bigrams; glue neighbours (稳\u538b + \u538b\u7ba1 -> \u7a33\u538b\u7ba1) so the reason reads like words. */
function mergeTerms(terms: readonly string[]): string[] {
  const pool = [...terms];
  const out: string[] = [];
  while (pool.length > 0) {
    let word = pool.shift() ?? '';
    let extended = true;
    while (extended) {
      extended = false;
      for (let index = 0; index < pool.length; index += 1) {
        const term = pool[index] ?? '';
        if (word.endsWith(term.charAt(0))) {
          word += term.slice(1);
        } else if (term.endsWith(word.charAt(0))) {
          word = term.slice(0, -1) + word;
        } else {
          continue;
        }
        pool.splice(index, 1);
        extended = true;
        break;
      }
    }
    out.push(word);
  }
  return out;
}

const CJK_TERM = /^[\u3400-\u9fff]{2}$/;
const ASCII_TERM = /^[A-Za-z][A-Za-z-]{2,14}$/;

/** Tokenizer emits CJK bigrams and code-ish fragments; keep only terms a human can read as a reason. */
function isReadableTerm(term: string): boolean {
  if (CJK_TERM.test(term)) return true;
  if (!ASCII_TERM.test(term)) return false;
  if (!/[aeiou]/i.test(term)) return false;
  return !/(.)\1\1/.test(term);
}

/** Prefer Chinese terms; merge bigrams into words, then keep the three most telling ones. */
function whyTerms(terms: readonly string[]): string {
  const readable = terms.filter(isReadableTerm);
  const cjk = readable.filter((term) => CJK_TERM.test(term));
  const chosen = cjk.length > 0 ? cjk : readable;
  return mergeTerms(chosen)
    .filter((word) => word.length >= 2 && word.length <= 10 && !/[A-Za-z]{8,}/.test(word))
    .slice(0, 3)
    .join('\u3001');
}

interface Doc {
  readonly path: string;
  readonly name: string;
  readonly weights: Map<string, number>;
  readonly links: Set<string>;
  readonly norm: number;
}

export async function suggestLinks(fs: SuggestFs, vaultRoot: string, options: { note?: string; limit?: number; minScore?: number; perNote?: number } = {}): Promise<SuggestReport> {
  const started = Date.now();
  const entries = (await fs.listFiles()).filter(
    (entry) =>
      /\.md$/i.test(entry.relPath) &&
      !SKIP_PREFIX.test(entry.relPath) &&
      !COMPILED_PREFIX.test(entry.relPath) &&
      !SKIP_PATH.test(entry.relPath) &&
      !TEMPLATE_NAME.test(basenameOf(entry.relPath)),
  );
  const raw: { path: string; name: string; terms: Map<string, number>; links: Set<string> }[] = [];
  const df = new Map<string, number>();
  for (const entry of entries) {
    let text = '';
    try {
      text = await fs.readText(entry.relPath);
    } catch {
      continue;
    }
    const body = text
      .replace(FRONTMATTER, '')
      .replace(FENCED, '')
      .replace(MD_IMAGE, ' ')
      .replace(EMBED, ' ')
      .replace(URL_TOKEN, ' ');
    if (body.trim().length < MIN_BODY) continue;
    const terms = new Map<string, number>();
    for (const term of tokenize(body)) terms.set(term, (terms.get(term) ?? 0) + 1);
    const links = new Set<string>();
    for (const match of body.matchAll(LINK)) {
      const target = (match[1] ?? '').split('/').pop() ?? '';
      if (target !== '') links.add(target.trim().toLowerCase());
    }
    for (const term of terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    raw.push({ path: entry.relPath, name: basenameOf(entry.relPath), terms, links });
  }
  const total = raw.length;
  const docs: Doc[] = raw.map((doc) => {
    const weights = new Map<string, number>();
    let norm = 0;
    for (const [term, tf] of doc.terms) {
      const idf = Math.log(1 + total / Math.max(1, df.get(term) ?? 1));
      const weight = (1 + Math.log(tf)) * idf;
      weights.set(term, weight);
      norm += weight * weight;
    }
    return { path: doc.path, name: doc.name, weights, links: doc.links, norm: Math.sqrt(norm) };
  });
  const postings = new Map<string, { doc: number; weight: number }[]>();
  docs.forEach((doc, index) => {
    for (const [term, weight] of doc.weights) {
      const list = postings.get(term);
      if (list === undefined) postings.set(term, [{ doc: index, weight }]);
      else list.push({ doc: index, weight });
    }
  });
  const minScore = options.minScore ?? 0.2;
  const only = options.note === undefined ? undefined : docs.findIndex((doc) => doc.path === options.note || doc.name.toLowerCase() === (options.note ?? '').toLowerCase());
  const perNote = Math.max(1, options.perNote ?? 2);
  const picked: LinkSuggestion[] = [];
  docs.forEach((doc, index) => {
    if (only !== undefined && only >= 0 && index !== only) return;
    if (doc.norm === 0) return;
    const scores = new Map<number, number>();
    for (const [term, weight] of doc.weights) {
      for (const posting of postings.get(term) ?? []) {
        if (posting.doc === index) continue;
        scores.set(posting.doc, (scores.get(posting.doc) ?? 0) + weight * posting.weight);
      }
    }
    const candidates = [...scores.entries()]
      .map(([target, dot]) => ({ target, cosine: dot / (doc.norm * (docs[target]?.norm ?? 1)) }))
      .filter((entry) => entry.cosine >= minScore)
      .sort((left, right) => right.cosine - left.cosine);
    let taken = 0;
    const rareCutoff = Math.max(3, Math.floor(total * 0.012));
    for (const candidate of candidates) {
      if (taken >= perNote) break;
      const other = docs[candidate.target];
      if (other === undefined) continue;
      if (doc.links.has(other.name.toLowerCase())) continue;
      // A draft and its promoted copy keep the same file name; they are one note in
      // two stages, so suggesting either to the other is noise.
      if (other.name.toLowerCase() === doc.name.toLowerCase() && /^inbox\//i.test(doc.path) !== /^inbox\//i.test(other.path)) continue;
      const shared = [...doc.weights.keys()]
        .filter((term) => other.weights.has(term))
        .sort((left, right) => (doc.weights.get(right) ?? 0) - (doc.weights.get(left) ?? 0));
      const specific = shared.some((term) => (df.get(term) ?? 0) <= rareCutoff);
      // Boilerplate sections (引脚/单位/说明) make every datasheet note look alike; demand a rare term unless the pair is nearly identical.
      if (!specific && candidate.cosine < 0.85) continue;
      picked.push({ from: doc.path, to: other.name, why: whyTerms(shared), confidence: Number(candidate.cosine.toFixed(3)) });
      taken += 1;
    }
  });
  picked.sort((left, right) => right.confidence - left.confidence);
  const seen = new Set<string>();
  const unique = picked.filter((entry) => {
    const key = [basenameOf(entry.from), entry.to].sort().join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const limit = Math.max(1, options.limit ?? 40);
  return { ok: true, vaultRoot, notes: docs.length, suggestions: unique.slice(0, limit), elapsedMs: Date.now() - started };
}
