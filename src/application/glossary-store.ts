import type { GlossaryEntry } from '../domain/glossary.js';
import { isExpandablePair } from '../domain/glossary.js';
import type { HarvestedTerm } from '../domain/glossary-harvest.js';

export const GLOSSARY_PATH = '.wiki/index/glossary.json';
export const GLOSSARY_SCHEMA = 'dsh-aikb/glossary@1';
/** Beyond this the query expansion starts adding more noise than signal. */
const MAX_ENTRIES = 4000;

export interface StoredGlossaryEntry {
  readonly a: string;
  readonly b: string;
  /** How many times the pair was seen while ingesting. */
  readonly hits: number;
  /** How many times the pair was seen while ingesting (books and chunks both count). */
  readonly books: number;
  readonly kind: string;
}

export interface GlossaryFile {
  readonly schema: string;
  readonly updatedAt: string;
  readonly entries: readonly StoredGlossaryEntry[];
}

export interface GlossaryFs {
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
  writeText(relPath: string, content: string): Promise<number>;
}

function keyOf(a: string, b: string): string {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left <= right ? left + '|' + right : right + '|' + left;
}

export function emptyGlossary(): GlossaryFile {
  return { schema: GLOSSARY_SCHEMA, updatedAt: new Date(0).toISOString(), entries: [] };
}

export function parseGlossary(text: string): GlossaryFile {
  const parsed = JSON.parse(text) as Partial<GlossaryFile>;
  const entries: StoredGlossaryEntry[] = [];
  for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
    const a = typeof raw.a === 'string' ? raw.a.trim() : '';
    const b = typeof raw.b === 'string' ? raw.b.trim() : '';
    if (a === '' || b === '') continue;
    entries.push({
      a,
      b,
      hits: typeof raw.hits === 'number' ? raw.hits : 1,
      books: typeof raw.books === 'number' ? raw.books : 1,
      kind: typeof raw.kind === 'string' ? raw.kind : 'zh-en',
    });
  }
  return { schema: GLOSSARY_SCHEMA, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(), entries };
}

/** Merge one book's harvested pairs into the vault glossary. */
export function mergeGlossary(
  current: GlossaryFile | undefined,
  terms: readonly HarvestedTerm[],
  _sha256: string,
  now: Date = new Date(),
): { file: GlossaryFile; added: number } {
  const byKey = new Map<string, StoredGlossaryEntry>();
  for (const entry of current?.entries ?? []) byKey.set(keyOf(entry.a, entry.b), entry);
  const before = byKey.size;
  for (const term of terms) {
    const key = keyOf(term.a, term.b);
    const existing = byKey.get(key);
    byKey.set(
      key,
      existing === undefined
        ? { a: term.a, b: term.b, hits: 1, books: 1, kind: term.kind }
        : { ...existing, hits: existing.hits + 1, books: existing.books + 1 },
    );
  }
  // Keep single mentions too: a term explained once in one textbook is exactly the one a reader
  // cannot type in the other language. Frequency only decides who survives MAX_ENTRIES.
  const entries = [...byKey.values()]
    .sort((left, right) => right.books * 10 + right.hits - (left.books * 10 + left.hits))
    .slice(0, MAX_ENTRIES);
  const file: GlossaryFile = { schema: GLOSSARY_SCHEMA, updatedAt: now.toISOString(), entries };
  return { file, added: Math.max(0, byKey.size - before) };
}

export function glossaryEntries(file: GlossaryFile | undefined): GlossaryEntry[] {
  if (file === undefined) return [];
  return file.entries.map((entry) => ({ a: entry.a, b: entry.b }));
}

/**
 * Pairs safe enough to widen a query. Measured on the 26-question set: expanding with the whole
 * harvested list lost five page hits (11/26 → 7/26), because a single book teaches its own table
 * shorthand ("通用定时器 (TIM3)"). Five mentions plus the phrase test was the only gate that did
 * not regress the 104-question benchmark; it adds one Chinese page-5 hit and is applied to CJK
 * queries only, because widening English queries cost a hit on the small English set.
 */
export const MIN_EXPANSION_HITS = 5;

export function expansionEntries(file: GlossaryFile | undefined): GlossaryEntry[] {
  if (file === undefined) return [];
  return file.entries
    .filter((entry) => entry.hits >= MIN_EXPANSION_HITS && isExpandablePair(entry))
    .map((entry) => ({ a: entry.a, b: entry.b }));
}

export function serializeGlossary(file: GlossaryFile): string {
  return JSON.stringify(file, null, 2) + String.fromCharCode(10);
}

export async function loadGlossary(fs: GlossaryFs): Promise<GlossaryFile | undefined> {
  if (!(await fs.exists(GLOSSARY_PATH))) return undefined;
  try {
    return parseGlossary(await fs.readText(GLOSSARY_PATH));
  } catch {
    return undefined;
  }
}
