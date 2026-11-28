import { DomainError } from '../shared/result.js';
import { parseGlossary } from './glossary-store.js';

/**
 * L1 vault map: which documents the compiled index holds, which sections they carry, and
 * which surface forms look like entities. Everything is derived from .wiki/index
 * (catalog.json, chunk files, glossary) with no model, no network and no writes, so the map
 * is disposable and rebuildable.
 *
 * Incremental rebuilds: a document whose source hash is unchanged is copied verbatim from
 * the previous map. To keep that copy equal to a full rebuild, each parsed document carries
 * forms - the entity evidence it contributed. A document without forms (an unparsed source,
 * or a map written by an older builder) is re-read instead, so a stale cache can never
 * poison the entity table.
 */

export const MAP_SCHEMA = 'dsh-aikb/map@1';

/** Where the compiled index lives; the catalog and chunk files are the only inputs. */
export const MAP_INDEX_ROOT = '.wiki/index';

/** Read view of the compiled index; NodeVaultFs already satisfies it. */
export interface MapFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
}

export interface MapSection {
  readonly title: string;
  readonly pageStart: number;
  readonly pageEnd: number;
}

export interface MapPageCount {
  readonly page: number;
  readonly count: number;
}

/** One surface form a document contributed, with the pages it appears on. */
export interface MapDocForm {
  /** The spelling as printed; casing is preserved so aliases stay readable. */
  readonly form: string;
  readonly pages: readonly MapPageCount[];
  /** Other sides of the glossary pairs that admitted this form; they become aliases. */
  readonly pairs?: readonly string[];
}

export interface MapDoc {
  readonly path: string;
  readonly sha: string;
  readonly title: string;
  readonly pageCount: number;
  readonly firstLine: string;
  readonly sections: readonly MapSection[];
  /** Entity evidence; absent when the document could not be parsed. */
  readonly forms?: readonly MapDocForm[];
}

export interface MapMention {
  readonly path: string;
  readonly unit: 'page';
  /** 1-based page number; 0 means the document title line. */
  readonly locator: number;
  readonly count: number;
}

export interface MapEntity {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly mentions: readonly MapMention[];
}

export interface MapCoverage {
  readonly docs: number;
  readonly pages: number;
  readonly sections: number;
  readonly entities: number;
  readonly docsWithoutSections: number;
  readonly docsWithoutEntities: number;
  /** Documents the index lists but could not provide chunks for. */
  readonly unparsed: readonly string[];
}

export interface MapFile {
  readonly schema: typeof MAP_SCHEMA;
  readonly builtAt: string;
  readonly docs: readonly MapDoc[];
  readonly entities: readonly MapEntity[];
  readonly coverage: MapCoverage;
}

/** One source the caller already hashed; when absent the catalog is the source of truth. */
export interface MapSourceRef {
  readonly path: string;
  readonly sha: string;
  /** Catalog page count; absent falls back to the highest page that has a chunk. */
  readonly pages?: number;
}

export interface BuildMapOptions {
  /** Where catalog.json, chunks/ and glossary.json live; defaults to .wiki/index. */
  readonly indexRoot?: string;
  /** Current sources; absent reads catalog.json. */
  readonly sources?: readonly MapSourceRef[];
  /** Previous map for an incremental rebuild. */
  readonly previous?: MapFile;
  /** Clock for builtAt; tests pin it. */
  readonly now?: Date;
}

interface GlossaryPair {
  readonly a: string;
  readonly b: string;
}

interface StoredChunk {
  readonly page: number;
  readonly section: string | undefined;
  readonly text: string;
}

interface PageView {
  readonly page: number;
  readonly text: string;
  readonly section: string | undefined;
}

interface CandidateForm {
  readonly path: string;
  readonly form: string;
  readonly pages: readonly MapPageCount[];
  readonly pairs?: readonly string[];
}

type FormPages = Map<number, number>;

/** slug -> spelling -> page counts, for one document. */
type DocFormIndex = Map<string, Map<string, FormPages>>;

interface PageEntry {
  readonly lines: string[];
  section: string | undefined;
}

const CJK = /[\u3400-\u9fff]/u;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;
const DIGIT = /[0-9]/;
const LETTER = /[A-Za-z]/;

/** Letters and digits mixed: model numbers, register names, standards, bus names. */
const IDENTIFIER_TOKEN = /[A-Za-z0-9]+(?:(?:[._/-])[A-Za-z0-9]+)*/gu;
/** Classic part numbers (1N4148, 74HC00, 3V3) lead with digits; unit values (5V, 10uF, 3.3V) do not fit. */
const DIGIT_LED_MODEL = /^\d{1,2}[A-Z][A-Z0-9]*\d$/u;
/** "P12" in a table of contents is a page reference, not a pin. */
const PAGE_REFERENCE = /^p\d{1,3}$/iu;

const TITLE_LATIN = /[A-Za-z][A-Za-z0-9]*(?:(?:[._-])[A-Za-z0-9]+)*/gu;
const TITLE_CJK = /[\u3400-\u9fff]+/gu;
const TITLE_STOP = new Set(['the', 'and', 'of', 'for', 'to', 'in', 'on', 'with', 'a', 'an', 'de', 'la', 'le']);

const MAX_HEADING_LENGTH = 80;
/** A map is a locator, not a concordance: caps keep the sidecar small enough to load per query. */
export const MAX_ENTITIES = 4000;
const MAX_MENTIONS_PER_ENTITY = 24;
const MAX_FORMS_PER_DOC = 120;
const PAGE_NUMBER_PREFIX = /^\d{1,4}\s+/u;
const CHAPTER_WORD = /^第\s*(?:\d{1,3}|[一二三四五六七八九十百零〇两]{1,4})\s*[章节篇部]/u;
const ENGLISH_CHAPTER = /^(?:chapter|part|appendix|section)\s+[0-9]{1,3}(?:\.\d{1,3})*\b/iu;
const DOTTED_NUMBER = /^(\d{1,3}(?:\.\d{1,3}){1,3})[\s、.．:：]*(\S.*)$/u;
const PLAIN_NUMBER = /^(\d{1,3})[、.．]\s*(\S.*)$/u;
const TOC_LEADER = /[.．·…]{3,}/u;
const PROSE_TAIL = /[。；;]$/u;
const TRAILING_NUMBER = /\s\d{1,4}$/u;

/** Build the map from the compiled index. Pure with respect to the vault: reads only. */
export async function buildMap(fs: MapFs, options: BuildMapOptions = {}): Promise<MapFile> {
  const indexRoot = (options.indexRoot ?? MAP_INDEX_ROOT).replace(/\/+$/u, '');
  const sources = dedupeSources(options.sources ?? (await readCatalogSources(fs, indexRoot)));
  const glossary = await readGlossaryPairs(fs, indexRoot);
  const builtAt = (options.now ?? new Date()).toISOString();
  const previous = previousDocsByPath(options.previous);

  const docs: MapDoc[] = [];
  const unparsed: string[] = [];
  for (const source of sources) {
    const reused = previous.get(source.path);
    if (reused !== undefined && reused.sha === source.sha && reused.forms !== undefined) {
      docs.push(reused);
      continue;
    }
    const chunks = await readChunks(fs, indexRoot, source.sha);
    const pages = chunks === undefined ? [] : pageViews(chunks);
    const title = titleOf(source.path);
    if (pages.length === 0) {
      // The catalog knows the document even when the index has no text for it. Keeping the
      // entry (instead of dropping it) is what makes the gap visible in coverage.
      docs.push({ path: source.path, sha: source.sha, title, pageCount: source.pages ?? 0, firstLine: '', sections: [] });
      unparsed.push(source.path);
      continue;
    }
    const analysis = analysePages(pages, glossary);
    const lastPage = pages[pages.length - 1]?.page ?? 0;
    docs.push({
      path: source.path,
      sha: source.sha,
      title,
      pageCount: source.pages ?? lastPage,
      firstLine: analysis.firstLine,
      sections: analysis.sections,
      forms: analysis.forms,
    });
  }

  const entities = buildEntities(docs);
  const mentioned = new Set<string>();
  for (const entity of entities) for (const mention of entity.mentions) mentioned.add(mention.path);

  const coverage: MapCoverage = {
    docs: docs.length,
    pages: docs.reduce((sum, doc) => sum + doc.pageCount, 0),
    sections: docs.reduce((sum, doc) => sum + doc.sections.length, 0),
    entities: entities.length,
    docsWithoutSections: docs.filter((doc) => doc.sections.length === 0).length,
    docsWithoutEntities: docs.filter((doc) => !mentioned.has(doc.path)).length,
    unparsed,
  };
  return { schema: MAP_SCHEMA, builtAt, docs, entities, coverage };
}

/** Stable JSON for the map file: fixed key order, sorted arrays, one trailing newline. */
export function serializeMap(map: MapFile): string {
  const payload = {
    schema: map.schema,
    builtAt: map.builtAt,
    docs: map.docs.map((doc) => ({
      path: doc.path,
      sha: doc.sha,
      title: doc.title,
      pageCount: doc.pageCount,
      firstLine: doc.firstLine,
      sections: doc.sections.map((section) => ({
        title: section.title,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
      })),
      ...(doc.forms === undefined
        ? {}
        : {
            forms: doc.forms.map((form) => ({
              form: form.form,
              pages: form.pages.map((page) => ({ page: page.page, count: page.count })),
              ...(form.pairs === undefined ? {} : { pairs: form.pairs }),
            })),
          }),
    })),
    entities: map.entities.map((entity) => ({
      id: entity.id,
      label: entity.label,
      aliases: entity.aliases,
      mentions: entity.mentions.map((mention) => ({
        path: mention.path,
        unit: mention.unit,
        locator: mention.locator,
        count: mention.count,
      })),
    })),
    coverage: {
      docs: map.coverage.docs,
      pages: map.coverage.pages,
      sections: map.coverage.sections,
      entities: map.coverage.entities,
      docsWithoutSections: map.coverage.docsWithoutSections,
      docsWithoutEntities: map.coverage.docsWithoutEntities,
      unparsed: map.coverage.unparsed,
    },
  };
  return JSON.stringify(payload) + String.fromCharCode(10);
}

/** Human-readable summary for the settings panel; lists the gaps worth acting on. */
export function mapCoverage(map: MapFile): string {
  const { coverage } = map;
  const lines = ['文档 ' + coverage.docs + ' 篇，共 ' + coverage.pages + ' 页；小节 ' + coverage.sections + ' 个，实体 ' + coverage.entities + ' 个。'];
  const withoutSections = map.docs.filter((doc) => doc.sections.length === 0).map((doc) => doc.path);
  if (withoutSections.length > 0) lines.push('无小节文档 ' + withoutSections.length + ' 篇：' + summarisePaths(withoutSections));
  const withoutEntities = map.docs.filter((doc) => !hasMention(map, doc.path)).map((doc) => doc.path);
  if (withoutEntities.length > 0) lines.push('无实体文档 ' + withoutEntities.length + ' 篇：' + summarisePaths(withoutEntities));
  if (coverage.unparsed.length > 0) lines.push('未解析文档 ' + coverage.unparsed.length + ' 篇：' + summarisePaths(coverage.unparsed));
  return lines.join(String.fromCharCode(10));
}

/** Exact match on id/label/alias first, case-insensitive second. */
export function findEntities(map: MapFile, term: string): readonly MapEntity[] {
  const needle = term.trim();
  if (needle === '') return [];
  const exact = map.entities.filter(
    (entity) => entity.id === needle || entity.label === needle || entity.aliases.includes(needle),
  );
  if (exact.length > 0) return exact;
  const folded = needle.toLowerCase();
  return map.entities.filter(
    (entity) =>
      entity.id.toLowerCase() === folded ||
      entity.label.toLowerCase() === folded ||
      entity.aliases.some((alias) => alias.toLowerCase() === folded),
  );
}

export function docFor(map: MapFile, path: string): MapDoc | undefined {
  const wanted = normalizePath(path);
  return map.docs.find((doc) => doc.path === wanted);
}

function hasMention(map: MapFile, path: string): boolean {
  return map.entities.some((entity) => entity.mentions.some((mention) => mention.path === path));
}

function summarisePaths(paths: readonly string[]): string {
  const limit = 8;
  const shown = paths.slice(0, limit).join('、');
  return paths.length > limit ? shown + ' 等' : shown;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function slugOf(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(NON_ALNUM, '-')
    .replace(/^-+|-+$/gu, '');
}

function differentScript(left: string, right: string): boolean {
  return CJK.test(left) !== CJK.test(right);
}

async function readCatalogSources(fs: MapFs, indexRoot: string): Promise<readonly MapSourceRef[]> {
  const catalogPath = indexRoot + '/catalog.json';
  if (!(await fs.exists(catalogPath))) {
    throw new DomainError('map.index-missing', 'run kb_ingest first: ' + catalogPath + ' not found');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readText(catalogPath));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DomainError('map.catalog-corrupt', catalogPath + ' is not valid JSON (' + reason + '); re-run kb_ingest');
  }
  const sources = isRecord(parsed) ? parsed.sources : undefined;
  if (!isRecord(sources)) {
    throw new DomainError('map.catalog-corrupt', catalogPath + ' has no sources object; re-run kb_ingest');
  }
  const out: MapSourceRef[] = [];
  for (const [sha, raw] of Object.entries(sources)) {
    if (!isRecord(raw)) continue;
    const path = typeof raw.path === 'string' ? normalizePath(raw.path) : '';
    if (path === '' || sha === '') continue;
    const pages = typeof raw.pages === 'number' && raw.pages > 0 ? raw.pages : undefined;
    out.push(pages === undefined ? { path, sha } : { path, sha, pages });
  }
  return out;
}

/** One path, one hash. Two hashes for one path means a stale catalog; the larger hash wins so the pick is stable. */
function dedupeSources(sources: readonly MapSourceRef[]): readonly MapSourceRef[] {
  const byPath = new Map<string, MapSourceRef>();
  for (const source of sources) {
    const path = normalizePath(source.path);
    if (path === '' || source.sha === '') continue;
    const entry: MapSourceRef = { path, sha: source.sha, ...(source.pages === undefined ? {} : { pages: source.pages }) };
    const existing = byPath.get(path);
    if (existing === undefined || existing.sha === entry.sha || entry.sha > existing.sha) byPath.set(path, entry);
  }
  return [...byPath.values()].sort((left, right) => compareText(left.path, right.path));
}

function previousDocsByPath(previous: MapFile | undefined): Map<string, MapDoc> {
  const out = new Map<string, MapDoc>();
  for (const doc of previous?.docs ?? []) out.set(normalizePath(doc.path), doc);
  return out;
}

async function readChunks(fs: MapFs, indexRoot: string, sha: string): Promise<StoredChunk[] | undefined> {
  const relPath = indexRoot + '/chunks/' + sha + '.jsonl';
  try {
    if (!(await fs.exists(relPath))) return undefined;
    return parseChunkLines(await fs.readText(relPath));
  } catch {
    return undefined;
  }
}

/** Chunk files are written by this plugin, but a partial write or a hand-edited file must not crash the map. */
function parseChunkLines(text: string): StoredChunk[] {
  const out: StoredChunk[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const page = parsed.page;
    const body = parsed.text;
    if (typeof page !== 'number' || !Number.isFinite(page) || page < 1) continue;
    if (typeof body !== 'string' || body.trim() === '') continue;
    const section = typeof parsed.section === 'string' ? parsed.section : undefined;
    out.push({ page: Math.trunc(page), text: body, section });
  }
  return out;
}

function pageViews(chunks: readonly StoredChunk[]): PageView[] {
  const byPage = new Map<number, PageEntry>();
  for (const chunk of chunks) {
    const entry: PageEntry = byPage.get(chunk.page) ?? { lines: [], section: undefined };
    entry.lines.push(chunk.text);
    if (entry.section === undefined && chunk.section !== undefined && chunk.section.trim() !== '') entry.section = chunk.section;
    byPage.set(chunk.page, entry);
  }
  return [...byPage.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([page, entry]) => ({ page, text: entry.lines.join(String.fromCharCode(10)), section: entry.section }));
}

function titleOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const title = stem.replace(/\s+/gu, ' ').trim();
  return title !== '' ? title : path;
}

function firstLineOf(pages: readonly PageView[]): string {
  for (const page of pages) {
    for (const raw of page.text.split(/\r?\n/u)) {
      const line = raw.replace(/\s+/gu, ' ').trim();
      if (line === '') continue;
      return line.length > 160 ? line.slice(0, 160) : line;
    }
  }
  return '';
}

interface PageAnalysis {
  readonly sections: readonly MapSection[];
  readonly firstLine: string;
  readonly forms: readonly MapDocForm[];
}

function analysePages(pages: readonly PageView[], glossary: readonly GlossaryPair[]): PageAnalysis {
  const sections = sectionsOf(pages);
  const firstLine = firstLineOf(pages);

  const index: DocFormIndex = new Map();
  for (const page of pages) {
    for (const match of page.text.matchAll(IDENTIFIER_TOKEN)) {
      const token = match[0];
      if (!identifierCandidate(token)) continue;
      addForm(index, token, page.page, 1);
    }
  }

  const pairs = new Map<string, Set<string>>();
  addGlossaryForms(index, pairs, pages, glossary);

  return { sections, firstLine, forms: formsOf(index, pairs) };
}

function identifierCandidate(token: string): boolean {
  if (token.length < 3 || token.length > 32) return false;
  if (!DIGIT.test(token) || !LETTER.test(token)) return false;
  if (/^[0-9]/u.test(token)) return DIGIT_LED_MODEL.test(token);
  return !PAGE_REFERENCE.test(token);
}

function addForm(index: DocFormIndex, form: string, page: number, count: number): void {
  const slug = slugOf(form);
  if (slug === '') return;
  let forms = index.get(slug);
  if (forms === undefined) {
    forms = new Map();
    index.set(slug, forms);
  }
  let pages = forms.get(form);
  if (pages === undefined) {
    pages = new Map();
    forms.set(form, pages);
  }
  pages.set(page, (pages.get(page) ?? 0) + count);
}

function attachPair(pairs: Map<string, Set<string>>, slug: string, partner: string): void {
  const label = partner.trim();
  if (label === '' || slugOf(label) === '') return;
  const set = pairs.get(slug);
  if (set === undefined) pairs.set(slug, new Set([label]));
  else set.add(label);
}

/**
 * The glossary is the only vocabulary the map trusts across scripts: a term paired with a
 * different-script term is evidence that the pair names one thing. Scanning thousands of
 * pairs against every page would be quadratic, so each side is first filtered by the set of
 * character bigrams the document actually contains, then counted page by page.
 */
function addGlossaryForms(
  index: DocFormIndex,
  pairs: Map<string, Set<string>>,
  pages: readonly PageView[],
  glossary: readonly GlossaryPair[],
): void {
  if (glossary.length === 0) return;
  const joined = pages.map((page) => page.text).join(String.fromCharCode(10)).toLowerCase();
  const bigrams = pairKeys(joined);
  for (const pair of glossary) {
    for (const [side, other] of [
      [pair.a, pair.b],
      [pair.b, pair.a],
    ] as const) {
      const cjk = CJK.test(side);
      const needle = cjk ? side.trim() : side.trim().toLowerCase();
      if (needle.length < 2 || needle.length > 60) continue;
      if (!hasAllPairs(bigrams, needle)) continue;
      const perPage = new Map<number, number>();
      let total = 0;
      for (const page of pages) {
        const haystack = cjk ? page.text : page.text.toLowerCase();
        const count = countOccurrences(haystack, needle);
        if (count > 0) {
          perPage.set(page.page, count);
          total += count;
        }
      }
      if (total < 2) continue;
      const slug = slugOf(side);
      if (slug === '') continue;
      if (index.has(slug)) {
        // The identifier scan already counted the same occurrences; only the link is new.
        attachPair(pairs, slug, other);
        continue;
      }
      for (const [page, count] of perPage) addForm(index, side, page, count);
      attachPair(pairs, slug, other);
    }
  }
}

function pairKeys(text: string): Set<number> {
  const keys = new Set<number>();
  for (let index = 0; index + 1 < text.length; index += 1) {
    keys.add((text.charCodeAt(index) << 16) | text.charCodeAt(index + 1));
  }
  return keys;
}

function hasAllPairs(keys: ReadonlySet<number>, text: string): boolean {
  if (text.length < 2) return false;
  for (let index = 0; index + 1 < text.length; index += 1) {
    if (!keys.has((text.charCodeAt(index) << 16) | text.charCodeAt(index + 1))) return false;
  }
  return true;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '' || haystack.length < needle.length) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** A form must recur at least twice in the document; that gate is what keeps prose noise out. */
function formsOf(index: DocFormIndex, pairs: Map<string, Set<string>>): MapDocForm[] {
  const out: MapDocForm[] = [];
  for (const [slug, forms] of index) {
    let total = 0;
    for (const pages of forms.values()) for (const count of pages.values()) total += count;
    if (total < 2) continue;
    for (const [form, pages] of forms) {
      const counts = [...pages.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([page, count]) => ({ page, count }));
      const partners = pairs.get(slug);
      out.push(partners === undefined ? { form, pages: counts } : { form, pages: counts, pairs: [...partners].sort(compareText) });
    }
  }
  out.sort((left, right) => compareText(left.form, right.form));
  if (out.length <= MAX_FORMS_PER_DOC) return out;
  const keep = new Set(
    [...out]
      .sort((left, right) => formTotal(right) - formTotal(left) || compareText(left.form, right.form))
      .slice(0, MAX_FORMS_PER_DOC)
      .map((form) => form.form),
  );
  return out.filter((form) => keep.has(form.form));
}

function formTotal(form: MapDocForm): number {
  return form.pages.reduce((sum, page) => sum + page.count, 0);
}

function looksLikeContentsPage(lines: readonly string[]): boolean {
  let numbered = 0;
  for (const line of lines) {
    const text = line.replace(/\s+/gu, ' ').trim();
    if (headingOfLine(text) === undefined) continue;
    if (TRAILING_NUMBER.test(text)) numbered += 1;
  }
  return numbered >= 2;
}

function sectionsOf(pages: readonly PageView[]): MapSection[] {
  const heads: { readonly title: string; readonly page: number }[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const lines = page.text.split(/\r?\n/u);
    // A contents page repeats every heading with its page number; counting them as sections
    // would anchor chapters on the table of contents instead of the body.
    if (looksLikeContentsPage(lines)) continue;
    for (const raw of lines) {
      const title = headingOfLine(raw);
      if (title === undefined) continue;
      const key = title.toLowerCase();
      // Running headers repeat the chapter title on every page; only the first occurrence starts a section.
      if (seen.has(key)) continue;
      seen.add(key);
      heads.push({ title, page: page.page });
    }
  }
  if (heads.length === 0) return outlineSections(pages);
  return spanSections(heads, pages[pages.length - 1]?.page ?? 0);
}

function spanSections(heads: readonly { readonly title: string; readonly page: number }[], lastPage: number): MapSection[] {
  return heads.map((head, index) => {
    const next = heads[index + 1];
    return { title: head.title, pageStart: head.page, pageEnd: next === undefined ? lastPage : next.page };
  });
}

/** Books with a PDF outline but no recognisable page heads still carry section names on their chunks. */
function outlineSections(pages: readonly PageView[]): MapSection[] {
  const heads: { readonly title: string; readonly page: number }[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const title = page.section?.replace(/\s+/gu, ' ').trim();
    if (title === undefined || title === '') continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    heads.push({ title, page: page.page });
  }
  if (heads.length === 0) return [];
  return spanSections(heads, pages[pages.length - 1]?.page ?? 0);
}

function headingOfLine(raw: string): string | undefined {
  const line = raw.replace(/\s+/gu, ' ').trim();
  const direct = looksLikeHeading(line);
  if (direct !== undefined) return direct;
  // A printed page number above the heading ("447 9.4 稳压管稳压电路"): drop it only when the
  // remainder is itself a heading; otherwise the leading digits belong to the text.
  const stripped = line.replace(PAGE_NUMBER_PREFIX, '');
  if (stripped === '' || stripped === line) return undefined;
  return looksLikeHeading(stripped);
}

function looksLikeHeading(line: string): string | undefined {
  if (line.length < 2 || line.length > MAX_HEADING_LENGTH) return undefined;
  if (TOC_LEADER.test(line)) return undefined;
  if (PROSE_TAIL.test(line) || /[；;]/u.test(line)) return undefined;
  if (line.includes('，') || line.includes(',')) return undefined;
  if (CHAPTER_WORD.test(line)) return line;
  if (ENGLISH_CHAPTER.test(line)) return line;
  const dotted = DOTTED_NUMBER.exec(line);
  if (dotted !== null) {
    const numbering = dotted[1] ?? '';
    // Decimals ("0.5 安培") are data, not section numbers; real section numbers start at 1.
    // Once a dotted numbering was seen, the plain-number rule must not re-read its tail.
    if (!numbering.startsWith('0.') && headingRest(dotted[2] ?? '') !== undefined) return line;
    return undefined;
  }
  const plain = PLAIN_NUMBER.exec(line);
  if (plain !== null && headingRest(plain[2] ?? '') !== undefined) return line;
  return undefined;
}

/** A numbered line is only a heading when what follows the number reads like a title, not a value. */
function headingRest(raw: string): string | undefined {
  const text = raw.replace(/\s+/gu, ' ').trim();
  if (text === '') return undefined;
  if (PROSE_TAIL.test(text)) return undefined;
  const cjk = CJK.test(text);
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length;
  if (!cjk && latin < 2) return undefined;
  return text;
}

function titleTokens(title: string): string[] {
  const out: string[] = [];
  for (const match of title.matchAll(TITLE_LATIN)) {
    const token = match[0];
    if (token.length < 2) continue;
    if (TITLE_STOP.has(token.toLowerCase())) continue;
    out.push(token);
  }
  for (const match of title.matchAll(TITLE_CJK)) {
    const token = match[0];
    if (token.length >= 2 && token.length <= 12) out.push(token);
  }
  return out;
}

/** A token shared by two titles is a topic; a token in one title is just that title's name. */
function titleCandidates(docs: readonly MapDoc[]): CandidateForm[] {
  const bySlug = new Map<string, Map<string, Map<string, number>>>();
  for (const doc of docs) {
    if (doc.title.trim() === '') continue;
    for (const token of titleTokens(doc.title)) {
      const slug = slugOf(token);
      if (slug === '') continue;
      let forms = bySlug.get(slug);
      if (forms === undefined) {
        forms = new Map();
        bySlug.set(slug, forms);
      }
      let paths = forms.get(token);
      if (paths === undefined) {
        paths = new Map();
        forms.set(token, paths);
      }
      paths.set(doc.path, (paths.get(doc.path) ?? 0) + 1);
    }
  }
  const out: CandidateForm[] = [];
  for (const forms of bySlug.values()) {
    const docCount = new Set<string>();
    for (const paths of forms.values()) for (const path of paths.keys()) docCount.add(path);
    if (docCount.size < 2) continue;
    for (const [form, paths] of forms) {
      for (const [path, count] of paths) out.push({ path, form, pages: [{ page: 0, count }] });
    }
  }
  return out;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    this.add(key);
    let root = key;
    for (;;) {
      const next = this.parent.get(root) ?? root;
      if (next === root) break;
      root = next;
    }
    let cursor = key;
    while (cursor !== root) {
      const next = this.parent.get(cursor) ?? root;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  /** Deterministic root: the smaller key wins, so grouping does not depend on discovery order. */
  union(left: string, right: string): string {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return a;
    if (compareText(a, b) < 0) {
      this.parent.set(b, a);
      return a;
    }
    this.parent.set(a, b);
    return b;
  }
}

function formKey(form: string): string {
  return 'form:' + slugOf(form);
}

function buildEntities(docs: readonly MapDoc[]): MapEntity[] {
  const candidates: CandidateForm[] = [];
  for (const doc of docs) {
    for (const form of doc.forms ?? []) {
      candidates.push({ path: doc.path, form: form.form, pages: form.pages, ...(form.pairs === undefined ? {} : { pairs: form.pairs }) });
    }
  }
  candidates.push(...titleCandidates(docs));

  const sets = new DisjointSet();
  for (const candidate of candidates) {
    sets.add(formKey(candidate.form));
    for (const partner of candidate.pairs ?? []) {
      const other = slugOf(partner);
      if (other === '' || other === slugOf(candidate.form)) continue;
      sets.union(formKey(candidate.form), formKey(partner));
    }
  }

  const groups = new Map<string, CandidateForm[]>();
  for (const candidate of candidates) {
    const root = sets.find(formKey(candidate.form));
    const list = groups.get(root);
    if (list === undefined) groups.set(root, [candidate]);
    else list.push(candidate);
  }

  const entities: MapEntity[] = [];
  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    const mentions = new Map<string, MapMention>();
    const aliases = new Set<string>();
    for (const candidate of group) {
      let total = 0;
      for (const page of candidate.pages) {
        total += page.count;
        const key = candidate.path + '|' + page.page;
        const existing = mentions.get(key);
        mentions.set(key, {
          path: candidate.path,
          unit: 'page',
          locator: page.page,
          count: (existing?.count ?? 0) + page.count,
        });
      }
      counts.set(candidate.form, (counts.get(candidate.form) ?? 0) + total);
      aliases.add(candidate.form);
      for (const alias of familyAliases(candidate.form)) aliases.add(alias);
      for (const partner of candidate.pairs ?? []) {
        aliases.add(partner);
        for (const alias of familyAliases(partner)) aliases.add(alias);
      }
    }
    let label = '';
    let best = -1;
    for (const [form, count] of counts) {
      if (count > best || (count === best && (label === '' || compareText(form, label) < 0))) {
        label = form;
        best = count;
      }
    }
    const id = slugOf(label);
    if (id === '') continue;
    // One document is a coincidence, not an entity; and a fragment like "TI", "00B0" or "SE" is
    // page furniture. Both gates are shape-only so a vault of any subject keeps its own terms.
    if (noisyLabel(label)) continue;
    if (total(entityDraft(label, mentions)) < 2) continue;
    aliases.delete(label);
    const sortedMentions = [...mentions.values()]
      .sort((left, right) => right.count - left.count || compareText(left.path, right.path) || left.locator - right.locator)
      .slice(0, MAX_MENTIONS_PER_ENTITY)
      .sort((left, right) => compareText(left.path, right.path) || left.locator - right.locator);
    entities.push({ id, label, aliases: [...aliases].sort(compareText), mentions: sortedMentions });
  }
  const ranked = [...entities].sort(
    (left, right) => spread(right) - spread(left) || total(right) - total(left) || compareText(left.id, right.id),
  );
  const kept = ranked.slice(0, MAX_ENTITIES);
  kept.sort((left, right) => compareText(left.id, right.id) || compareText(left.label, right.label));
  return kept;
}

/** Documents an entity appears in; the ranking that decides which entities survive the cap. */
function spread(entity: MapEntity): number {
  return new Set(entity.mentions.map((mention) => mention.path)).size;
}

function total(entity: MapEntity): number {
  return entity.mentions.reduce((sum, mention) => sum + mention.count, 0);
}

function entityDraft(label: string, mentions: ReadonlyMap<string, MapMention>): MapEntity {
  return { id: slugOf(label), label, aliases: [], mentions: [...mentions.values()] };
}

/**
 * Datasheets name a family either as a slash list ("AB-12-1/AB-12-2") or per variant ("AB-12-1").
 * A reader asks for the family, so the shared stem becomes an alias. Shape-only: digits required.
 */
function familyAliases(form: string): string[] {
  const out: string[] = [];
  const parts = form.split('/').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length > 1) {
    for (const part of parts) if (part !== form) out.push(part);
    let prefix = parts[0] ?? '';
    for (const part of parts.slice(1)) {
      let index = 0;
      const limit = Math.min(prefix.length, part.length);
      while (index < limit && prefix.charAt(index).toLowerCase() === part.charAt(index).toLowerCase()) index += 1;
      prefix = prefix.slice(0, index);
    }
    const stem = prefix.replace(/[^\p{L}\p{N}]+$/gu, '');
    if (stem.length >= 4 && DIGIT.test(stem)) out.push(stem);
    return out;
  }
  const match = /^(.+)-([A-Za-z0-9]{1,3})$/u.exec(form);
  if (match !== null) {
    const stem = match[1] ?? '';
    if (stem.length >= 4 && DIGIT.test(stem)) out.push(stem);
  }
  return out;
}

/**
 * Page furniture and register addresses are not entities. The test is structural: too short to be a
 * term, or a bare hex literal; nothing here knows a subject.
 */
function noisyLabel(label: string): boolean {
  const ascii = !CJK.test(label);
  if (ascii && label.replace(/[^A-Za-z0-9]+/gu, '').length < 3) return true;
  if (CJK.test(label)) return false;
  if (/^[0-9A-Fa-f]{2,8}$/u.test(label)) return true;
  return /^[A-Z]{1,2}$/u.test(label);
}

async function readGlossaryPairs(fs: MapFs, indexRoot: string): Promise<GlossaryPair[]> {
  const relPath = indexRoot + '/glossary.json';
  try {
    if (!(await fs.exists(relPath))) return [];
    const file = parseGlossary(await fs.readText(relPath));
    const pairs: GlossaryPair[] = [];
    for (const entry of file.entries) {
      if (entry.a.length < 2 || entry.b.length < 2) continue;
      if (entry.a.length > 60 || entry.b.length > 60) continue;
      if (!differentScript(entry.a, entry.b)) continue;
      pairs.push({ a: entry.a, b: entry.b });
    }
    return pairs;
  } catch {
    // The glossary is an optional side file: a corrupt one must not block the map.
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
