/**
 * Per-vault learned presets ("vault profile"): the vocabulary a vault actually uses, learned from
 * its own chunks instead of shipped as a hardcoded domain list.
 *
 * A profile is three JSON documents under .wiki/index/:
 *   taxonomy.json  surface forms the vault repeats, grouped by SHAPE (cjk-term, ascii-term,
 *                  identifier, acronym, numeric-with-unit, quoted-phrase), never by topic
 *   synonyms.json  pairs the vault states explicitly: glossary hits and "中文（English）" /
 *                  "English (中文)" parentheses where the two sides use different scripts
 *   policy.json    what this vault decided about its own vocabulary (values, not behaviour)
 *
 * Everything here is pure: no fs, no network, no model. The classifier looks only at how a form is
 * written, so a vault of any subject produces its own vocabulary and this module names none.
 * A vault with no profile simply gets no expansion; guessing one would be worse than nothing.
 */

import { DomainError } from '../shared/result.js';

/** Where each profile document lives, relative to the vault root. */
export const TAXONOMY_PATH = '.wiki/index/taxonomy.json';
export const SYNONYMS_PATH = '.wiki/index/synonyms.json';
export const POLICY_PATH = '.wiki/index/policy.json';

export const TAXONOMY_SCHEMA = 'dsh-aikb/taxonomy@1';
export const SYNONYMS_SCHEMA = 'dsh-aikb/synonyms@1';
export const POLICY_SCHEMA = 'dsh-aikb/policy@1';

/** Layout version written into every document; bump only on an incompatible change. */
export const PROFILE_VERSION = 1;

/** Provenance is capped so one large vault cannot grow the sidecar without bound. */
export const MAX_SOURCE_SHAS = 5000;
export const MAX_TAXONOMY_PER_CLASS = 40;
export const MAX_SYNONYMS = 200;
export const MAX_SOURCES_PER_ENTRY = 20;
export const MAX_FORM_LENGTH = 60;
export const MAX_QUERY_TERMS = 8;

const MAX_ENTRY_COUNT = 1000000;
/** Occurrences of one form inside one chunk; beyond this a single page could outvote a book. */
const MAX_CHUNK_HITS = 5;
const EPOCH_ISO = new Date(0).toISOString();

export type ProfileSection = 'taxonomy' | 'synonyms' | 'policy';
export type EntryOrigin = 'harvest' | 'manual';
export type SurfaceClass =
  | 'cjk-term'
  | 'ascii-term'
  | 'identifier'
  | 'acronym'
  | 'numeric-with-unit'
  | 'quoted-phrase';

/** Written order of the classes; serialization groups by it so the file stays readable. */
const CLASS_ORDER: readonly SurfaceClass[] = [
  'cjk-term',
  'ascii-term',
  'identifier',
  'acronym',
  'numeric-with-unit',
  'quoted-phrase',
];
const CLASS_RANK = new Map<SurfaceClass, number>(CLASS_ORDER.map((cls, index) => [cls, index]));

export interface TaxonomyEntry {
  readonly label: string;
  /** Casefolded merge key; always recomputed from label on write. */
  readonly key: string;
  readonly class: SurfaceClass;
  readonly count: number;
  readonly origin: EntryOrigin;
  /** Vault-relative paths this form was seen in; empty means the glossary taught it. */
  readonly sources: readonly string[];
  /** Extra spellings a human declared equivalent. Never harvested, never guessed. */
  readonly aliases?: readonly string[];
  /** Sources are gone from the vault; kept until a prune is asked for. */
  readonly stale?: boolean;
}

export interface SynonymEntry {
  readonly a: string;
  readonly b: string;
  /** Sorted casefolded pair key; always recomputed from a and b on write. */
  readonly key: string;
  readonly count: number;
  readonly origin: EntryOrigin;
  readonly sources: readonly string[];
  readonly stale?: boolean;
}

export interface PolicyEntry {
  readonly key: string;
  readonly value: string;
  readonly origin: EntryOrigin;
}

export interface ProfileHeader {
  readonly schema: string;
  readonly version: number;
  readonly builtAt: string;
  readonly sourceShas: Readonly<Record<string, string>>;
}

export interface TaxonomyFile extends ProfileHeader {
  readonly entries: readonly TaxonomyEntry[];
}

export interface SynonymsFile extends ProfileHeader {
  readonly entries: readonly SynonymEntry[];
}

export interface PolicyFile extends ProfileHeader {
  readonly entries: readonly PolicyEntry[];
}

export interface VaultProfile {
  readonly taxonomy: TaxonomyFile;
  readonly synonyms: SynonymsFile;
  readonly policy: PolicyFile;
}

/** One chunk of vault text; sourceId is the caller's locator, path is what provenance records. */
export interface ProfileChunk {
  readonly sourceId: string;
  readonly path: string;
  readonly text: string;
}

export interface HarvestedTaxonomyEntry {
  readonly label: string;
  readonly class: SurfaceClass;
  readonly count: number;
  readonly sources: readonly string[];
  readonly origin?: EntryOrigin;
}

export interface HarvestedSynonymEntry {
  readonly a: string;
  readonly b: string;
  readonly count: number;
  readonly sources: readonly string[];
  readonly origin?: EntryOrigin;
}

export interface HarvestedProfile {
  readonly taxonomy: readonly HarvestedTaxonomyEntry[];
  readonly synonyms: readonly HarvestedSynonymEntry[];
}

export interface MergeOptions {
  /** Everything harvested in this pass is a human decision, not machine evidence. */
  readonly manual?: boolean;
  /**
   * Full inventory snapshot: vault-relative path -> sha256 of the source it was learned from.
   * Omit it and no provenance judgement is possible, so nothing is marked stale or pruned.
   */
  readonly sourceShas?: Readonly<Record<string, string>>;
  /** Drop stale harvest entries instead of marking them. Manual entries are never dropped. */
  readonly pruneSources?: boolean;
  /** Injectable clock so a merge can be replayed byte for byte. */
  readonly now?: Date;
}

export interface ProfileConflict {
  readonly section: ProfileSection;
  readonly key: string;
  readonly reason: 'manual-wins' | 'manual-conflict';
  readonly keptLabel: string;
  readonly incomingLabel: string;
  readonly keptOrigin: EntryOrigin;
  readonly droppedOrigin: EntryOrigin;
}

export interface MergeResult {
  readonly profile: VaultProfile;
  readonly added: { readonly taxonomy: number; readonly synonyms: number };
  readonly conflicts: readonly ProfileConflict[];
}

export interface ProfileReadiness {
  readonly ok: boolean;
  readonly counts: { readonly taxonomy: number; readonly synonyms: number };
  readonly gaps: string[];
}

/** Canonical text of each document, keyed by the path suffix that holds it. */
export interface ProfileFiles {
  readonly taxonomy: string;
  readonly synonyms: string;
  readonly policy: string;
}

export interface ProfileInputs {
  readonly taxonomy?: string;
  readonly synonyms?: string;
  readonly policy?: string;
}

export interface SurfaceForm {
  readonly form: string;
  readonly class: SurfaceClass;
}

/** Defaults a vault inherits until policy.json overrides them with an entry. */
export const DEFAULT_POLICY: Readonly<Record<string, string>> = {
  maxTaxonomyPerClass: String(MAX_TAXONOMY_PER_CLASS),
  maxSynonyms: String(MAX_SYNONYMS),
  expandOnQuery: 'true',
};

const CJK = /[\u3400-\u9fff]/;
const ASCII_LETTER = /[A-Za-z]/;
const DIGIT = /[0-9]/;

/** Generic measurement units only: a unit is shape, not a subject. */
const NUMERIC_WITH_UNIT = /^\d+(?:[.,]\d+)?\s?(?:%|°C|GHz|MHz|kHz|km|kg|mg|mL|µg|µs|ns|min|cm|mm|ms|Hz|m|g|s|h|L|K)$/i;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*(?:[._/@+-][A-Za-z0-9]+)*$/;
const ACRONYM = /^[A-Z]{2,8}$/;
const ASCII_TERM = /^[A-Za-z][A-Za-z0-9]*(?:[ -][A-Za-z0-9]+)*$/;

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['《', '》'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
];

/** Function characters that end a CJK term instead of being part of one. */
const CJK_SPLIT = new Set('的了是在和与及或而并被把从到为之其此所者于对由用让使得地吗呢啊个这那也就都'.split(''));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Code-unit order, not locale order: the same profile must serialize the same on every machine. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function cleanText(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isCjkOnly(text: string): boolean {
  return CJK.test(text) && !ASCII_LETTER.test(text);
}

function isAsciiOnly(text: string): boolean {
  return ASCII_LETTER.test(text) && !CJK.test(text);
}

/** Merge key for a surface form: NFKC, casefolded, single-spaced. */
export function entryKey(label: string): string {
  return String(label ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapQuoted(text: string): string | undefined {
  for (const pair of QUOTE_PAIRS) {
    const open = pair[0];
    const close = pair[1];
    if (text.length < open.length + close.length + 2) continue;
    if (!text.startsWith(open) || !text.endsWith(close)) continue;
    return text.slice(open.length, text.length - close.length);
  }
  return undefined;
}

/**
 * Classify a surface form by SHAPE alone. Returns undefined for anything that is not a term, which
 * is how short filler ("the", "note") and bare numbers stay out of the taxonomy.
 */
export function classifySurface(form: string): SurfaceClass | undefined {
  const raw = cleanText(form);
  if (raw === '') return undefined;

  const quoted = unwrapQuoted(raw);
  if (quoted !== undefined) {
    const inner = cleanText(quoted);
    if (inner.length < 2 || inner.length > MAX_FORM_LENGTH) return undefined;
    if (!/[\u3400-\u9fffA-Za-z]/.test(inner)) return undefined;
    return 'quoted-phrase';
  }

  if (raw.length > MAX_FORM_LENGTH) return undefined;
  if (isCjkOnly(raw)) return raw.length >= 2 && raw.length <= 12 ? 'cjk-term' : undefined;
  // Mixed-script text is a phrase, not one surface form; the pair extractor handles those.
  if (!isAsciiOnly(raw)) return undefined;

  if (NUMERIC_WITH_UNIT.test(raw)) return 'numeric-with-unit';
  if (raw.length >= 3 && DIGIT.test(raw) && IDENTIFIER.test(raw)) return 'identifier';
  if (ACRONYM.test(raw)) return 'acronym';
  if (ASCII_TERM.test(raw) && (raw.includes(' ') || raw.includes('-') || raw.length >= 6)) {
    return 'ascii-term';
  }
  return undefined;
}

function isSurfaceClass(value: unknown): value is SurfaceClass {
  return typeof value === 'string' && CLASS_RANK.has(value as SurfaceClass);
}

function classRank(cls: SurfaceClass): number {
  return CLASS_RANK.get(cls) ?? CLASS_ORDER.length;
}

function cjkSegments(run: string): string[] {
  const out: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length >= 2 && current.length <= 12) out.push(current);
    current = '';
  };
  for (const char of run) {
    if (CJK_SPLIT.has(char)) {
      flush();
      continue;
    }
    current += char;
    if (current.length > 12) {
      // Sliding windows would invent phrases; a long run simply ends at the cap.
      out.push(current.slice(0, 12));
      current = '';
    }
  }
  flush();
  return out;
}

interface CollectedSurface {
  readonly form: string;
  readonly class: SurfaceClass;
  readonly hits: number;
}

/** Occurrence tally per form inside one text, capped so one chunk cannot dominate a merge. */
function collectSurfaces(text: string): Map<string, CollectedSurface> {
  const map = new Map<string, CollectedSurface>();
  const add = (form: string, fixed?: SurfaceClass): void => {
    const cleaned = cleanText(form);
    if (cleaned === '') return;
    const cls = fixed ?? classifySurface(cleaned);
    if (cls === undefined) return;
    const key = entryKey(cleaned);
    if (key === '') return;
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, { form: cleaned, class: cls, hits: 1 });
      return;
    }
    if (existing.hits < MAX_CHUNK_HITS) {
      map.set(key, { form: existing.form, class: existing.class, hits: existing.hits + 1 });
    }
  };

  const input = String(text ?? '');
  for (const match of input.matchAll(/[《“「『]([^》”」』\n]{2,40})[》”」』]/g)) {
    add(match[1] ?? '', 'quoted-phrase');
  }
  for (const match of input.matchAll(/"([^"\n]{2,40})"/g)) {
    add(match[1] ?? '', 'quoted-phrase');
  }
  for (const match of input.matchAll(/[\u3400-\u9fff]+/g)) {
    for (const segment of cjkSegments(match[0])) add(segment, 'cjk-term');
  }
  for (const match of input.matchAll(/[A-Za-z0-9][A-Za-z0-9._/@+-]*/g)) {
    const token = (match[0] ?? '').replace(/[._/@+-]+$/, '');
    if (token !== '') add(token);
  }
  return map;
}

/** Surface forms in one text, deduplicated and sorted; the classifier is the only judge. */
export function extractSurfaceForms(text: string): SurfaceForm[] {
  const collected = [...collectSurfaces(text).values()].map((surface) => ({
    form: surface.form,
    class: surface.class,
  }));
  collected.sort((left, right) => compareText(left.form, right.form));
  return collected;
}

const PAIR_CJK_FIRST = /([\u3400-\u9fff][\u3400-\u9fff·\s]{1,13}?)\s*[（(]\s*([A-Za-z][A-Za-z0-9 ./&+-]{1,40}?)\s*[）)]/g;
const PAIR_ASCII_FIRST = /([A-Za-z][A-Za-z0-9 ./&+-]{1,40}?)\s*[（(]\s*([\u3400-\u9fff][\u3400-\u9fff·\s]{1,13}?)\s*[）)]/g;

function cleanPairSide(value: string): string | undefined {
  const text = cleanText(value).replace(/[.,;:、。]+$/, '');
  if (text.length < 2 || text.length > MAX_FORM_LENGTH) return undefined;
  if (!/[\u3400-\u9fffA-Za-z]/.test(text)) return undefined;
  return text;
}

/**
 * "中文（English）" and "English (中文)" are the two places a vault states a term pair itself. A pair
 * only counts when the sides use different scripts: an expansion like "Advanced RISC Machine (ARM)"
 * is a definition, not a translation, and is left to the sentence.
 */
function extractPairs(text: string): { readonly a: string; readonly b: string }[] {
  const input = String(text ?? '');
  const out: { a: string; b: string }[] = [];
  const push = (left: string, right: string): void => {
    const a = cleanPairSide(left);
    const b = cleanPairSide(right);
    if (a === undefined || b === undefined) return;
    const differentScripts = (isCjkOnly(a) && isAsciiOnly(b)) || (isAsciiOnly(a) && isCjkOnly(b));
    if (!differentScripts) return;
    const keyA = entryKey(a);
    const keyB = entryKey(b);
    if (keyA === keyB) return;
    if (out.some((pair) => entryKey(pair.a) === keyA && entryKey(pair.b) === keyB)) return;
    out.push({ a, b });
  };
  for (const match of input.matchAll(PAIR_CJK_FIRST)) push(match[1] ?? '', match[2] ?? '');
  for (const match of input.matchAll(PAIR_ASCII_FIRST)) push(match[1] ?? '', match[2] ?? '');
  return out;
}

function safeCount(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(MAX_ENTRY_COUNT, Math.trunc(number)));
}

function normalizeSources(values: readonly string[] | undefined): string[] {
  const set = new Set<string>();
  for (const value of values ?? []) {
    const text = cleanText(value);
    if (text !== '') set.add(text);
  }
  return [...set].sort(compareText).slice(0, MAX_SOURCES_PER_ENTRY);
}

function unionSources(left: readonly string[], right: readonly string[]): string[] {
  return normalizeSources([...left, ...right]);
}

/**
 * Class for a form the vault itself stated as vocabulary. The shape rules stay the default, but a
 * stated pair is evidence, not a guess, so an admitted side falls back to its script's class.
 */
function statedClass(label: string): SurfaceClass | undefined {
  const cls = classifySurface(label);
  if (cls !== undefined) return cls;
  if (isCjkOnly(label)) return 'cjk-term';
  if (isAsciiOnly(label)) return 'ascii-term';
  return undefined;
}

function pairKey(a: string, b: string): string {
  const left = entryKey(a);
  const right = entryKey(b);
  return left <= right ? left + '|' + right : right + '|' + left;
}

interface TaxonomyTally {
  form: string;
  cls: SurfaceClass;
  count: number;
  sources: Set<string>;
}

interface SynonymTally {
  a: string;
  b: string;
  count: number;
  sources: Set<string>;
}

/**
 * Learn a vault's own vocabulary. Frequency decides who survives the per-class cap; no dictionary,
 * no model, no field of study. The result is sorted so the same chunks always harvest the same bytes.
 */
export function harvestProfile(
  chunks: readonly ProfileChunk[],
  glossaryPairs: readonly { readonly a: string; readonly b: string }[] = [],
): HarvestedProfile {
  const taxonomy = new Map<string, TaxonomyTally>();
  const synonyms = new Map<string, SynonymTally>();

  const addTaxonomy = (form: string, cls: SurfaceClass, source: string, hits: number): void => {
    const cleaned = cleanText(form);
    const key = entryKey(cleaned);
    if (key === '') return;
    const existing = taxonomy.get(key);
    if (existing === undefined) {
      taxonomy.set(key, { form: cleaned, cls, count: hits, sources: new Set(source === '' ? [] : [source]) });
      return;
    }
    existing.count = Math.min(MAX_ENTRY_COUNT, existing.count + hits);
    if (source !== '') existing.sources.add(source);
  };

  const addSynonym = (a: string, b: string, source: string, hits: number): void => {
    const left = cleanPairSide(a);
    const right = cleanPairSide(b);
    if (left === undefined || right === undefined) return;
    const key = pairKey(left, right);
    if (entryKey(left) === entryKey(right)) return;
    const existing = synonyms.get(key);
    if (existing === undefined) {
      synonyms.set(key, { a: left, b: right, count: hits, sources: new Set(source === '' ? [] : [source]) });
      return;
    }
    existing.count = Math.min(MAX_ENTRY_COUNT, existing.count + hits);
    if (source !== '') existing.sources.add(source);
  };

  const keepStated = (pair: { readonly a: string; readonly b: string }, source: string): void => {
    addSynonym(pair.a, pair.b, source, 1);
    // A stated pair is the vault's own claim, so its sides are vocabulary even when the shape rules
    // alone would keep them out of the taxonomy.
    for (const side of [pair.a, pair.b]) {
      const cleaned = cleanText(side);
      const cls = statedClass(cleaned);
      if (cls !== undefined) addTaxonomy(cleaned, cls, source, 1);
    }
  };

  for (const chunk of chunks) {
    const path = cleanText(chunk.path);
    for (const surface of collectSurfaces(chunk.text).values()) {
      addTaxonomy(surface.form, surface.class, path, surface.hits);
    }
    for (const pair of extractPairs(chunk.text)) keepStated(pair, path);
  }

  // A glossary pair is already a stated equivalence; its sides are also vocabulary worth keeping.
  for (const pair of glossaryPairs) keepStated(pair, '');

  const harvestedTaxonomy: HarvestedTaxonomyEntry[] = [];
  for (const cls of CLASS_ORDER) {
    const group = [...taxonomy.values()]
      .filter((entry) => entry.cls === cls)
      .sort((left, right) => right.count - left.count || compareText(left.form, right.form))
      .slice(0, MAX_TAXONOMY_PER_CLASS);
    for (const entry of group) {
      harvestedTaxonomy.push({
        label: entry.form,
        class: entry.cls,
        count: entry.count,
        sources: normalizeSources([...entry.sources]),
        origin: 'harvest',
      });
    }
  }

  const harvestedSynonyms: HarvestedSynonymEntry[] = [...synonyms.entries()]
    .sort((left, right) => right[1].count - left[1].count || compareText(left[0], right[0]))
    .slice(0, MAX_SYNONYMS)
    .map(([, entry]) => ({
      a: entry.a,
      b: entry.b,
      count: entry.count,
      sources: normalizeSources([...entry.sources]),
      origin: 'harvest' as const,
    }));

  return { taxonomy: harvestedTaxonomy, synonyms: harvestedSynonyms };
}

export function emptyProfile(): VaultProfile {
  const header = { version: PROFILE_VERSION, builtAt: EPOCH_ISO, sourceShas: {} as Record<string, string> };
  return {
    taxonomy: { schema: TAXONOMY_SCHEMA, ...header, entries: [] },
    synonyms: { schema: SYNONYMS_SCHEMA, ...header, entries: [] },
    policy: { schema: POLICY_SCHEMA, ...header, entries: [] },
  };
}

function capSourceShas(shas: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  let kept = 0;
  // Insertion order is the caller's recency order, so the cap keeps the newest inventory first.
  for (const path of Object.keys(shas)) {
    if (kept >= MAX_SOURCE_SHAS) break;
    const sha = shas[path];
    if (path === '' || typeof sha !== 'string' || sha === '') continue;
    out[path] = sha;
    kept += 1;
  }
  return out;
}

function sortTaxonomy(entries: readonly TaxonomyEntry[]): TaxonomyEntry[] {
  return [...entries].sort(
    (left, right) => classRank(left.class) - classRank(right.class) || compareText(left.key, right.key),
  );
}

function normalizeAliases(values: readonly string[] | undefined, key: string): string[] {
  const set = new Set<string>();
  for (const value of values ?? []) {
    const text = cleanText(value);
    if (text === '' || entryKey(text) === key) continue;
    set.add(text);
  }
  return [...set].sort(compareText);
}

function normalizeTaxonomyEntry(entry: TaxonomyEntry): TaxonomyEntry {
  const label = cleanText(entry.label);
  const key = entryKey(label);
  const aliases = normalizeAliases(entry.aliases, key);
  const sources = normalizeSources(entry.sources);
  return {
    label,
    key,
    class: isSurfaceClass(entry.class)
      ? entry.class
      : (classifySurface(label) ?? (isCjkOnly(label) ? 'cjk-term' : 'ascii-term')),
    count: safeCount(entry.count),
    origin: entry.origin === 'manual' ? 'manual' : 'harvest',
    sources,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(entry.stale === true ? { stale: true } : {}),
  };
}

function normalizeSynonymEntry(entry: SynonymEntry): SynonymEntry {
  const a = cleanText(entry.a);
  const b = cleanText(entry.b);
  return {
    a,
    b,
    key: pairKey(a, b),
    count: safeCount(entry.count),
    origin: entry.origin === 'manual' ? 'manual' : 'harvest',
    sources: normalizeSources(entry.sources),
    ...(entry.stale === true ? { stale: true } : {}),
  };
}

function withStaleTaxonomy(entry: TaxonomyEntry, stale: boolean): TaxonomyEntry {
  return {
    label: entry.label,
    key: entry.key,
    class: entry.class,
    count: entry.count,
    origin: entry.origin,
    sources: entry.sources,
    ...(entry.aliases !== undefined ? { aliases: entry.aliases } : {}),
    ...(stale ? { stale: true } : {}),
  };
}

function withStaleSynonym(entry: SynonymEntry, stale: boolean): SynonymEntry {
  return {
    a: entry.a,
    b: entry.b,
    key: entry.key,
    count: entry.count,
    origin: entry.origin,
    sources: entry.sources,
    ...(stale ? { stale: true } : {}),
  };
}

/**
 * Merge one harvest pass into the profile that is already on disk.
 *
 * Manual entries are never dropped, rewritten or outvoted; a collision keeps the manual side and
 * records a conflict so the panel can show what the harvest wanted. Harvest entries merge by
 * casefolded key: counts add and provenance unions. Provenance is only judged when the caller
 * supplies the current inventory — otherwise an entry is never declared stale on a guess.
 */
export function mergeProfile(
  current: VaultProfile | undefined,
  harvested: HarvestedProfile,
  options: MergeOptions = {},
): MergeResult {
  const builtAt = (options.now ?? new Date()).toISOString();
  const incomingOrigin: EntryOrigin = options.manual === true ? 'manual' : 'harvest';
  const sourceShas = options.sourceShas === undefined
    ? capSourceShas(current?.taxonomy.sourceShas ?? {})
    : capSourceShas(options.sourceShas);
  const known = options.sourceShas === undefined ? undefined : new Set(Object.keys(options.sourceShas));
  const fresh = new Set<string>();
  for (const entry of harvested.taxonomy) for (const source of entry.sources ?? []) fresh.add(cleanText(source));
  for (const entry of harvested.synonyms) for (const source of entry.sources ?? []) fresh.add(cleanText(source));

  const conflicts: ProfileConflict[] = [];
  const taxonomy = new Map<string, TaxonomyEntry>();
  const synonyms = new Map<string, SynonymEntry>();

  for (const entry of current?.taxonomy.entries ?? []) {
    const normalized = normalizeTaxonomyEntry(entry);
    if (normalized.label === '') continue;
    if (!taxonomy.has(normalized.key)) taxonomy.set(normalized.key, normalized);
  }
  for (const entry of current?.synonyms.entries ?? []) {
    const normalized = normalizeSynonymEntry(entry);
    if (normalized.a === '' || normalized.b === '') continue;
    if (!synonyms.has(normalized.key)) synonyms.set(normalized.key, normalized);
  }

  let addedTaxonomy = 0;
  for (const raw of harvested.taxonomy) {
    const label = cleanText(raw.label);
    const key = entryKey(label);
    if (key === '') continue;
    const classOf = isSurfaceClass(raw.class)
      ? raw.class
      : (classifySurface(label) ?? (isCjkOnly(label) ? 'cjk-term' : 'ascii-term'));
    const count = safeCount(raw.count);
    const sources = normalizeSources(raw.sources);
    const origin: EntryOrigin = options.manual === true ? 'manual' : (raw.origin ?? incomingOrigin);
    const existing = taxonomy.get(key);

    if (existing === undefined) {
      taxonomy.set(key, { label, key, class: classOf, count, origin, sources });
      addedTaxonomy += 1;
      continue;
    }

    if (existing.origin === 'manual') {
      if (origin === 'manual' && existing.label === label && existing.class === classOf) {
        // The same manual entry asserted again: evidence accumulates, nothing is overwritten.
        taxonomy.set(key, {
          ...existing,
          count: Math.min(MAX_ENTRY_COUNT, existing.count + count),
          sources: unionSources(existing.sources, sources),
        });
        continue;
      }
      conflicts.push({
        section: 'taxonomy',
        key,
        reason: origin === 'manual' ? 'manual-conflict' : 'manual-wins',
        keptLabel: existing.label,
        incomingLabel: label,
        keptOrigin: 'manual',
        droppedOrigin: origin,
      });
      continue;
    }

    if (origin === 'manual') {
      taxonomy.set(key, {
        label,
        key,
        class: classOf,
        count: Math.min(MAX_ENTRY_COUNT, existing.count + count),
        origin: 'manual',
        sources: unionSources(existing.sources, sources),
      });
      conflicts.push({
        section: 'taxonomy',
        key,
        reason: 'manual-wins',
        keptLabel: label,
        incomingLabel: existing.label,
        keptOrigin: 'manual',
        droppedOrigin: 'harvest',
      });
      addedTaxonomy += 1;
      continue;
    }

    taxonomy.set(key, {
      ...existing,
      count: Math.min(MAX_ENTRY_COUNT, existing.count + count),
      sources: unionSources(existing.sources, sources),
    });
  }

  let addedSynonyms = 0;
  for (const raw of harvested.synonyms) {
    const a = cleanText(raw.a);
    const b = cleanText(raw.b);
    const key = pairKey(a, b);
    if (a === '' || b === '' || entryKey(a) === entryKey(b)) continue;
    const count = safeCount(raw.count);
    const sources = normalizeSources(raw.sources);
    const origin: EntryOrigin = options.manual === true ? 'manual' : (raw.origin ?? incomingOrigin);
    const existing = synonyms.get(key);

    if (existing === undefined) {
      synonyms.set(key, { a, b, key, count, origin, sources });
      addedSynonyms += 1;
      continue;
    }

    if (existing.origin === 'manual') {
      if (origin === 'manual' && existing.a === a && existing.b === b) {
        synonyms.set(key, {
          ...existing,
          count: Math.min(MAX_ENTRY_COUNT, existing.count + count),
          sources: unionSources(existing.sources, sources),
        });
        continue;
      }
      conflicts.push({
        section: 'synonyms',
        key,
        reason: origin === 'manual' ? 'manual-conflict' : 'manual-wins',
        keptLabel: existing.a + ' / ' + existing.b,
        incomingLabel: a + ' / ' + b,
        keptOrigin: 'manual',
        droppedOrigin: origin,
      });
      continue;
    }

    if (origin === 'manual') {
      synonyms.set(key, {
        a,
        b,
        key,
        count: Math.min(MAX_ENTRY_COUNT, existing.count + count),
        origin: 'manual',
        sources: unionSources(existing.sources, sources),
      });
      conflicts.push({
        section: 'synonyms',
        key,
        reason: 'manual-wins',
        keptLabel: a + ' / ' + b,
        incomingLabel: existing.a + ' / ' + existing.b,
        keptOrigin: 'manual',
        droppedOrigin: 'harvest',
      });
      addedSynonyms += 1;
      continue;
    }

    synonyms.set(key, {
      ...existing,
      count: Math.min(MAX_ENTRY_COUNT, existing.count + count),
      sources: unionSources(existing.sources, sources),
    });
  }

  if (known !== undefined) {
    for (const [key, entry] of [...taxonomy]) {
      if (entry.origin === 'manual' || entry.sources.length === 0) continue;
      const alive = entry.sources.some((source) => known.has(source) || fresh.has(source));
      if (alive) {
        if (entry.stale === true) taxonomy.set(key, withStaleTaxonomy(entry, false));
        continue;
      }
      if (options.pruneSources === true) taxonomy.delete(key);
      else if (entry.stale !== true) taxonomy.set(key, withStaleTaxonomy(entry, true));
    }
    for (const [key, entry] of [...synonyms]) {
      if (entry.origin === 'manual' || entry.sources.length === 0) continue;
      const alive = entry.sources.some((source) => known.has(source) || fresh.has(source));
      if (alive) {
        if (entry.stale === true) synonyms.set(key, withStaleSynonym(entry, false));
        continue;
      }
      if (options.pruneSources === true) synonyms.delete(key);
      else if (entry.stale !== true) synonyms.set(key, withStaleSynonym(entry, true));
    }
  }

  const policy = new Map<string, PolicyEntry>();
  for (const entry of current?.policy.entries ?? []) {
    const key = cleanText(entry.key);
    if (key === '') continue;
    const origin: EntryOrigin = entry.origin === 'manual' ? 'manual' : 'harvest';
    const value = String(entry.value ?? '');
    const existing = policy.get(key);
    if (existing === undefined) policy.set(key, { key, value, origin });
    else if (existing.origin === 'harvest' && origin === 'manual') policy.set(key, { key, value, origin });
  }

  const header = { version: PROFILE_VERSION, builtAt, sourceShas };
  const profile: VaultProfile = {
    taxonomy: { schema: TAXONOMY_SCHEMA, ...header, entries: sortTaxonomy([...taxonomy.values()]) },
    synonyms: {
      schema: SYNONYMS_SCHEMA,
      ...header,
      entries: [...synonyms.values()].sort((left, right) => compareText(left.key, right.key)),
    },
    policy: {
      schema: POLICY_SCHEMA,
      ...header,
      entries: [...policy.values()].sort((left, right) => compareText(left.key, right.key)),
    },
  };

  conflicts.sort(
    (left, right) => compareText(left.section, right.section) || compareText(left.key, right.key),
  );
  return { profile, added: { taxonomy: addedTaxonomy, synonyms: addedSynonyms }, conflicts };
}

function normalizeIso(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return EPOCH_ISO;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return EPOCH_ISO;
  return new Date(time).toISOString();
}

function canonicalShas(shas: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (shas === undefined) return out;
  let kept = 0;
  for (const path of Object.keys(shas).sort(compareText)) {
    if (kept >= MAX_SOURCE_SHAS) break;
    const sha = shas[path];
    if (path === '' || typeof sha !== 'string' || sha === '') continue;
    out[path] = sha;
    kept += 1;
  }
  return out;
}

function canonicalTaxonomyEntry(entry: TaxonomyEntry): Record<string, unknown> {
  const label = cleanText(entry.label);
  const key = entryKey(label);
  const aliases = normalizeAliases(entry.aliases, key);
  const sources = normalizeSources(entry.sources);
  const out: Record<string, unknown> = {
    label,
    key,
    class: isSurfaceClass(entry.class)
      ? entry.class
      : (classifySurface(label) ?? (isCjkOnly(label) ? 'cjk-term' : 'ascii-term')),
    count: safeCount(entry.count),
    origin: entry.origin === 'manual' ? 'manual' : 'harvest',
  };
  if (aliases.length > 0) out.aliases = aliases;
  if (sources.length > 0) out.sources = sources;
  if (entry.stale === true) out.stale = true;
  return out;
}

function canonicalSynonymEntry(entry: SynonymEntry): Record<string, unknown> {
  const a = cleanText(entry.a);
  const b = cleanText(entry.b);
  const sources = normalizeSources(entry.sources);
  const out: Record<string, unknown> = {
    a,
    b,
    key: pairKey(a, b),
    count: safeCount(entry.count),
    origin: entry.origin === 'manual' ? 'manual' : 'harvest',
  };
  if (sources.length > 0) out.sources = sources;
  if (entry.stale === true) out.stale = true;
  return out;
}

function canonicalPolicyEntry(entry: PolicyEntry): Record<string, unknown> {
  return {
    key: cleanText(entry.key),
    value: String(entry.value ?? ''),
    origin: entry.origin === 'manual' ? 'manual' : 'harvest',
  };
}

function stringifyDocument(document: Record<string, unknown>): string {
  return JSON.stringify(document, null, 2) + '\n';
}

/**
 * Canonical bytes for the three documents: fixed field order, sorted provenance, sorted entries and
 * a UTC-normalised builtAt. Two profiles that describe the same vocabulary serialize identically,
 * which is what makes the sidecar diffable instead of churning on every harvest.
 */
export function serializeProfile(profile: VaultProfile): ProfileFiles {
  const taxonomyEntries = [...profile.taxonomy.entries]
    .map(canonicalTaxonomyEntry)
    .sort((left, right) => {
      const leftClass = left.class as SurfaceClass;
      const rightClass = right.class as SurfaceClass;
      return classRank(leftClass) - classRank(rightClass) || compareText(String(left.key), String(right.key));
    });
  const synonymEntries = [...profile.synonyms.entries]
    .map(canonicalSynonymEntry)
    .sort((left, right) => compareText(String(left.key), String(right.key)));
  const policyEntries = [...profile.policy.entries]
    .map(canonicalPolicyEntry)
    .filter((entry) => entry.key !== '')
    .sort((left, right) => compareText(String(left.key), String(right.key)));

  const header = (schema: string, file: ProfileHeader): Record<string, unknown> => ({
    schema,
    version: PROFILE_VERSION,
    builtAt: normalizeIso(file.builtAt),
    sourceShas: canonicalShas(file.sourceShas),
  });

  return {
    taxonomy: stringifyDocument({
      ...header(TAXONOMY_SCHEMA, profile.taxonomy),
      entries: taxonomyEntries,
    }),
    synonyms: stringifyDocument({
      ...header(SYNONYMS_SCHEMA, profile.synonyms),
      entries: synonymEntries,
    }),
    policy: stringifyDocument({
      ...header(POLICY_SCHEMA, profile.policy),
      entries: policyEntries,
    }),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DomainError('profile.invalid-json', 'profile document is not valid JSON (' + reason + ')');
  }
}

function readShas(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [path, sha] of Object.entries(value)) {
    if (path === '' || typeof sha !== 'string' || sha === '') continue;
    out[path] = sha;
  }
  return out;
}

function documentOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    return isRecord(parsed) ? parsed : undefined;
  }
  return isRecord(value) ? value : undefined;
}

function parseTaxonomyFile(value: unknown): TaxonomyFile {
  const doc = documentOf(value);
  const entries: TaxonomyEntry[] = [];
  const rawEntries = doc !== undefined && Array.isArray(doc.entries) ? doc.entries : [];
  for (const item of rawEntries) {
    if (!isRecord(item)) continue;
    const label = typeof item.label === 'string' ? cleanText(item.label) : '';
    if (label === '' || label.length > MAX_FORM_LENGTH) continue;
    const key = entryKey(label);
    const cls = isSurfaceClass(item.class)
      ? item.class
      : (classifySurface(label) ?? (isCjkOnly(label) ? 'cjk-term' : 'ascii-term'));
    const aliases = Array.isArray(item.aliases)
      ? normalizeAliases(item.aliases.filter((alias): alias is string => typeof alias === 'string'), key)
      : [];
    entries.push({
      label,
      key,
      class: cls,
      count: safeCount(item.count),
      origin: item.origin === 'manual' ? 'manual' : 'harvest',
      sources: Array.isArray(item.sources)
        ? normalizeSources(item.sources.filter((source): source is string => typeof source === 'string'))
        : [],
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(item.stale === true ? { stale: true } : {}),
    });
  }
  return {
    schema: TAXONOMY_SCHEMA,
    version: typeof doc?.version === 'number' ? doc.version : PROFILE_VERSION,
    builtAt: typeof doc?.builtAt === 'string' ? doc.builtAt : EPOCH_ISO,
    sourceShas: readShas(doc?.sourceShas),
    entries,
  };
}

function parseSynonymsFile(value: unknown): SynonymsFile {
  const doc = documentOf(value);
  const entries: SynonymEntry[] = [];
  const rawEntries = doc !== undefined && Array.isArray(doc.entries) ? doc.entries : [];
  for (const item of rawEntries) {
    if (!isRecord(item)) continue;
    const a = typeof item.a === 'string' ? cleanText(item.a) : '';
    const b = typeof item.b === 'string' ? cleanText(item.b) : '';
    if (a === '' || b === '' || entryKey(a) === entryKey(b)) continue;
    entries.push({
      a,
      b,
      key: pairKey(a, b),
      count: safeCount(item.count),
      origin: item.origin === 'manual' ? 'manual' : 'harvest',
      sources: Array.isArray(item.sources)
        ? normalizeSources(item.sources.filter((source): source is string => typeof source === 'string'))
        : [],
      ...(item.stale === true ? { stale: true } : {}),
    });
  }
  return {
    schema: SYNONYMS_SCHEMA,
    version: typeof doc?.version === 'number' ? doc.version : PROFILE_VERSION,
    builtAt: typeof doc?.builtAt === 'string' ? doc.builtAt : EPOCH_ISO,
    sourceShas: readShas(doc?.sourceShas),
    entries,
  };
}

function parsePolicyFile(value: unknown): PolicyFile {
  const doc = documentOf(value);
  const entries: PolicyEntry[] = [];
  const rawEntries = doc !== undefined && Array.isArray(doc.entries) ? doc.entries : [];
  for (const item of rawEntries) {
    if (!isRecord(item)) continue;
    const key = typeof item.key === 'string' ? cleanText(item.key) : '';
    if (key === '') continue;
    entries.push({
      key,
      value: typeof item.value === 'string' ? item.value : String(item.value ?? ''),
      origin: item.origin === 'manual' ? 'manual' : 'harvest',
    });
  }
  return {
    schema: POLICY_SCHEMA,
    version: typeof doc?.version === 'number' ? doc.version : PROFILE_VERSION,
    builtAt: typeof doc?.builtAt === 'string' ? doc.builtAt : EPOCH_ISO,
    sourceShas: readShas(doc?.sourceShas),
    entries,
  };
}

function sectionOfSchema(value: unknown): ProfileSection | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('dsh-aikb/taxonomy')) return 'taxonomy';
  if (value.startsWith('dsh-aikb/synonyms')) return 'synonyms';
  if (value.startsWith('dsh-aikb/policy')) return 'policy';
  return undefined;
}

function inferSection(doc: Record<string, unknown>): ProfileSection {
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  for (const item of entries) {
    if (!isRecord(item)) continue;
    if ('a' in item || 'b' in item) return 'synonyms';
    if ('label' in item) return 'taxonomy';
  }
  return 'policy';
}

/**
 * Read a profile back. Accepts one document, a bundle of the three, or the three texts; missing
 * fields and unknown extras are tolerated, because a hand-edited sidecar should still load.
 * Invalid JSON is refused instead of silently discarded: a corrupt profile is not an empty one.
 */
export function parseProfile(input: string | ProfileInputs): VaultProfile {
  if (typeof input === 'string') {
    const parsed = parseJson(input);
    if (!isRecord(parsed)) {
      throw new DomainError('profile.invalid-shape', 'profile document is not a JSON object');
    }
    const sections: Record<ProfileSection, unknown> = {
      taxonomy: parsed.taxonomy,
      synonyms: parsed.synonyms,
      policy: parsed.policy,
    };
    const isBundle = (['taxonomy', 'synonyms', 'policy'] as const).some(
      (section) => isRecord(sections[section]) || typeof sections[section] === 'string',
    );
    if (isBundle) {
      return {
        taxonomy: parseTaxonomyFile(sections.taxonomy),
        synonyms: parseSynonymsFile(sections.synonyms),
        policy: parsePolicyFile(sections.policy),
      };
    }
    const section = sectionOfSchema(parsed.schema) ?? inferSection(parsed);
    const empty = emptyProfile();
    if (section === 'taxonomy') return { ...empty, taxonomy: parseTaxonomyFile(parsed) };
    if (section === 'synonyms') return { ...empty, synonyms: parseSynonymsFile(parsed) };
    return { ...empty, policy: parsePolicyFile(parsed) };
  }
  return {
    taxonomy: parseTaxonomyFile(input.taxonomy),
    synonyms: parseSynonymsFile(input.synonyms),
    policy: parsePolicyFile(input.policy),
  };
}

/**
 * Extra search terms for one surface form: the exact counterpart of a stated pair, or a manual
 * alias, matched on the casefolded key. An empty or unknown profile returns nothing — the correct
 * answer for a vault that has not taught this vocabulary yet.
 */
export function profileForQuery(profile: VaultProfile | undefined, term: string): string[] {
  if (profile === undefined || typeof term !== 'string') return [];
  const needle = entryKey(term);
  if (needle === '') return [];

  const out: string[] = [];
  const push = (candidate: string): void => {
    if (out.length >= MAX_QUERY_TERMS) return;
    const text = cleanText(candidate);
    if (text === '') return;
    const key = entryKey(text);
    if (key === needle || key.length < 2) return;
    if (out.some((value) => entryKey(value) === key)) return;
    out.push(text);
  };

  for (const entry of profile.synonyms.entries) {
    const keyA = entryKey(entry.a);
    const keyB = entryKey(entry.b);
    if (keyA === needle) push(entry.b);
    else if (keyB === needle) push(entry.a);
  }

  for (const entry of profile.taxonomy.entries) {
    const aliases = entry.aliases ?? [];
    if (entry.key === needle) {
      for (const alias of aliases) push(alias);
      continue;
    }
    if (aliases.some((alias) => entryKey(alias) === needle)) {
      push(entry.label);
      for (const alias of aliases) push(alias);
    }
  }

  return out;
}

/**
 * Is the profile usable, and what is missing? An absent profile is a report, not an exception: a
 * fresh vault is the normal starting state, and readiness tells the panel what to ask for.
 */
export function profileReadiness(profile: VaultProfile | undefined): ProfileReadiness {
  const taxonomy = profile?.taxonomy.entries.length ?? 0;
  const synonyms = profile?.synonyms.entries.length ?? 0;
  const gaps: string[] = [];
  if (taxonomy === 0 && synonyms === 0) {
    gaps.push('profile.empty');
  } else {
    if (taxonomy === 0) gaps.push('taxonomy.empty');
    if (synonyms === 0) gaps.push('synonyms.empty');
  }
  const shas = profile === undefined
    ? 0
    : Object.keys(profile.taxonomy.sourceShas).length
      + Object.keys(profile.synonyms.sourceShas).length
      + Object.keys(profile.policy.sourceShas).length;
  if (shas === 0) gaps.push('profile.no-source-shas');
  return { ok: taxonomy > 0 && synonyms > 0, counts: { taxonomy, synonyms }, gaps };
}

/** One policy value: the vault's own entry wins, then the built-in default, then undefined. */
export function policyValue(profile: VaultProfile | undefined, key: string): string | undefined {
  const stored = profile?.policy.entries.find((entry) => entry.key === key);
  if (stored !== undefined) return stored.value;
  return DEFAULT_POLICY[key];
}
