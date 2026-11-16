import { createBm25, createBm25FromPostings, mergeBm25Postings } from '../domain/bm25.js';
import type { Bm25Document, Bm25Hit, Bm25Index } from '../domain/bm25.js';
import { catalogHashOf, makeSearchCache, readSearchCacheUnchecked, sourceTextHash, writeSearchCache } from './search-cache.js';
import type { SearchCache, SearchCacheChunk } from './search-cache.js';
import { expandQuery } from '../domain/glossary.js';
import type { GlossaryEntry } from '../domain/glossary.js';
import { assignFamilies } from '../domain/family.js';
import type { FamilyAssignment } from '../domain/family.js';
import { chunkQuality } from '../domain/quality.js';
import { headingFromText } from '../domain/section.js';
import { tokenize } from '../domain/text.js';
import { searchNotes } from './notes-layer.js';
import { chunkFileOf, INDEX_CATALOG_PATH } from './kb-ingest.js';

export interface QueryFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
  /** Optional: the notes layer lists markdown files at query time. */
  listFiles?(): Promise<readonly { readonly relPath: string; readonly bytes: number; readonly modifiedAt: string }[]>;
  /** Optional: the index cache is stored as a binary blob under .wiki/index/. */
  readBinary?(relPath: string): Promise<Uint8Array>;
  writeBinary?(relPath: string, data: Uint8Array): Promise<void>;
}

/** Preloaded vectors for the whole index: ids[k] owns data[k*dims..(k+1)*dims]. */
export interface VectorStore {
  readonly ids: readonly string[];
  readonly data: Float32Array;
  readonly dims: number;
}

export interface QueryOptions {
  /** Query vector; absent keeps retrieval lexical. */
  readonly queryVector?: readonly number[];
  readonly vectors?: VectorStore;
  /**
   * Share of the result list reserved for vector-only hits (rounded down, at least 1 whenever
   * vectors are available). BM25 keeps the rest, so an exact lexical page is never displaced by
   * a semantically close but page-imprecise vector hit.
   */
  readonly vectorShare?: number;
  /**
   * Weight of the vector score in a score-level blend with BM25 (0 = vectors only fill the tail).
   * Both lists are normalised by their best hit before mixing, so this is a real hybrid ranking,
   * not RRF (which was measured and rejected) and not both scores added raw.
   */
  readonly hybridWeight?: number;
  /** Term pairs harvested from this vault books ('.wiki/index/glossary.json'). */
  readonly glossary?: readonly GlossaryEntry[];
  /** Return the whole page or section containing each hit; off by default to keep tokens low. */
  readonly expand?: 'none' | 'page' | 'section';
  readonly maxContextChars?: number;
  /** Same-work editions share a quota; 3 keeps a useful spread without flooding the list. */
  readonly familyCap?: number;
  /** Disable the per-process index cache (tests, or when the caller mutates files in place). */
  readonly cache?: boolean;
  /**
   * Extra phrasings of the same question (Chinese, English, an abbreviation). Each is searched on
   * its own and the ranked lists are fused by reciprocal rank, so one bad phrasing cannot win.
   */
  readonly queries?: readonly string[];
  /**
   * Score a list of passages against the query with a cross-encoder. Supplied by the tool layer
   * so this module never spawns a process; undefined means "keep the lexical order".
   */
  readonly rerank?: (documents: readonly string[]) => Promise<readonly number[] | undefined>;
  /** How many BM25 hits enter the reranker (vector hits are added on top). */
  readonly rerankPool?: number;
  /**
   * 0 = trust the cross-encoder order, 1 = keep the BM25 order. A middle value mixes the normalised
   * BM25 score into the rerank score, so an exact lexical page is not displaced by a fluent one.
   */
  readonly rerankBlend?: number;
  /**
   * Also search the vault's markdown notes at query time and merge the best matches into the
   * result list (kind: 'note'). Off by default: callers that only want book pages keep the
   * old shape and latency.
   */
  readonly notesLayer?: boolean;
  /** How many note hits the notes layer contributes (default 5). */
  readonly notesLimit?: number;
}

export interface QueryHit {
  readonly path: string;
  readonly page: number;
  /** 'note' marks a query-time note hit; book hits leave it absent. */
  readonly kind?: 'note';
  /** First page of the chapter the hit belongs to, when it starts before `page`. */
  readonly pageStart?: number;
  /** Last page of the chapter the hit belongs to, when the book has headings. */
  readonly pageEnd?: number;
  /** Chapter title; the contract is "book + chapter + page range", not an exact page. */
  readonly section?: string;
  readonly score: number;
  readonly excerpt: string;
  /** Full page or section text, only when expand was requested. */
  readonly context?: string;
}

export interface QueryReport {
  readonly ok: boolean;
  readonly error?: { code: string; message: string };
  readonly vaultRoot: string;
  readonly query: string;
  readonly hits: readonly QueryHit[];
  readonly searched: { readonly sources: number; readonly chunks: number; readonly vectors?: number; readonly families?: number; readonly queries?: number };
  readonly retrieval?: 'bm25' | 'hybrid';
  /** True when a cross-encoder reordered the candidates for this query. */
  readonly reranked?: boolean;
  /** IDF-weighted share of the question's tokens that appear anywhere in the corpus (0..1). */
  readonly coverage?: number;
  readonly elapsedMs: number;
}

interface Catalog {
  schema: string;
  sources: Record<string, { path: string; pages: number; chunks: number }>;
}

interface StoredChunk {
  id: string;
  sourceId: string;
  page: number;
  section?: string;
  text: string;
  tokens: number;
}

interface IndexedChunk {
  readonly chunk: StoredChunk;
  readonly path: string;
  readonly family: string;
  readonly quality: number;
  /** PDF outline heading, or one recovered from the page head; empty when neither exists. */
  readonly section: string;
  /** Index into chapters, or -1 when the page has no heading. */
  readonly chapter: number;
}

/** Outline heading first; scanned books without an outline fall back to the page head. */
function sectionOf(chunk: StoredChunk): string {
  const outline = (chunk.section ?? '').trim();
  if (outline !== '') return outline;
  return headingFromText(chunk.text) ?? '';
}

interface ChapterDoc {
  readonly id: string;
  readonly text: string;
  readonly path: string;
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

interface IndexSnapshot {
  readonly key: string;
  readonly sources: number;
  readonly families: number;
  readonly documents: readonly Bm25Document[];
  readonly byId: Map<string, IndexedChunk>;
  readonly chapters: readonly ChapterDoc[];
  readonly chapterIndex: Bm25Index;
  readonly index: Bm25Index;
  readonly byPage: Map<string, readonly string[]>;
  readonly bySection: Map<string, readonly string[]>;
  readonly byChapter: Map<string, readonly string[]>;
}

const EXCERPT_LENGTH = 240;
const MAX_HITS_PER_BOOK = 2;
const DEFAULT_FAMILY_CAP = 3;
const DEFAULT_CONTEXT_CHARS = 3000;
const CHAPTER_POOL = 24;
const DEFAULT_RERANK_POOL = 40;
/**
 * Weight of the lexical rank in the reranked score. Measured on the 38 Chinese questions: pure
 * cross-encoder ordering (0) kept 21/38 page@5, 0.3 kept 23/38 with MRR unchanged (0.39), and 0.5
 * or more drifted back down. English does not need reranking at all, so this only tunes drift.
 */
const DEFAULT_RERANK_BLEND = 0.3;
const RRF_K = 60;

/** One built index per vault; rebuilt when the catalog changes. 30 MB of tokens is worth keeping. */
const INDEX_CACHE = new Map<string, IndexSnapshot>();

/** Test hook: the fake fs in unit tests reuses paths with different content. */
export function clearQueryCache(): void {
  INDEX_CACHE.clear();
}

function chunkOrder(id: string): number {
  const at = id.lastIndexOf(':');
  return at < 0 ? 0 : Number(id.slice(at + 1)) || 0;
}

/** Book name + heading are searchable too: a question often names the device or chapter. */
function documentTextOf(path: string, chunk: StoredChunk): string {
  const book = (path.split('/').pop() ?? '').replace(/\.pdf$/i, '');
  // Outline headings only: a heading recovered from the page top is useful for windowing but
  // too noisy to boost twice in the searchable text.
  const section = chunk.section ?? '';
  // Book name and heading are repeated so a named device or a chapter title can outrank a
  // passing mention of the same words deep inside another book.
  return [book, book, section, section, chunk.text].filter((part) => part !== '').join(' ');
}

/** Up to eight chunks spread over the book: enough for a stable SimHash, cheap to collect. */
function sampleOf(chunks: readonly StoredChunk[]): string {
  const step = Math.max(1, Math.floor(chunks.length / 8));
  const parts: string[] = [];
  for (let index = 0; index < chunks.length && parts.length < 8; index += step) {
    parts.push((chunks[index]?.text ?? '').slice(0, 400));
  }
  return parts.join('\n');
}

interface SourceDoc {
  readonly sha256: string;
  readonly path: string;
  readonly pages: number;
  readonly chunks: readonly StoredChunk[];
  /** Cheap way to notice that a book was re-extracted without changing its chunk ids. */
  readonly textHash: string;
}

/** Everything the build accumulates per chunk; shared by a full build and an append. */
interface BuildState {
  readonly documents: Bm25Document[];
  readonly chunkMeta: SearchCacheChunk[];
  readonly byId: Map<string, IndexedChunk>;
  readonly chapters: ChapterDoc[];
  readonly byPage: Map<string, string[]>;
  readonly bySection: Map<string, string[]>;
  readonly byChapter: Map<string, string[]>;
}

function createBuildState(): BuildState {
  return {
    documents: [],
    chunkMeta: [],
    byId: new Map(),
    chapters: [],
    byPage: new Map(),
    bySection: new Map(),
    byChapter: new Map(),
  };
}

/**
 * Index one book into the shared state. Chapter ids continue from the chapters already present, so
 * appending a book leaves the cached chapter ids — and the cached chapter scores — valid.
 */
function appendSource(state: BuildState, source: SourceDoc, family: string): void {
  let run: { title: string; start: number; end: number; chapter: number } | undefined;
  const flush = (): void => {
    if (run === undefined || run.title === '') return;
    state.chapters.push({
      id: source.sha256 + '#ch' + state.chapters.length,
      text: run.title + ' ' + run.title + ' ' + source.path,
      path: source.path,
      title: run.title,
      start: run.start,
      end: run.end,
    });
    run = undefined;
  };
  for (const chunk of source.chunks) {
    const section = sectionOf(chunk);
    if (section !== '') {
      if (run === undefined || run.title !== section) {
        flush();
        run = { title: section, start: chunk.page, end: chunk.page, chapter: state.chapters.length };
      }
    } else {
      flush();
    }
    const chapter = run === undefined ? -1 : run.chapter;
    const indexed: IndexedChunk = {
      chunk,
      path: source.path,
      family,
      quality: chunkQuality(chunk.text),
      section,
      chapter,
    };
    state.byId.set(chunk.id, indexed);
    state.chunkMeta.push({ id: chunk.id, section, quality: indexed.quality, chapter });
    state.documents.push({ id: chunk.id, text: documentTextOf(source.path, chunk) });
    const pageKey = source.path + '#' + chunk.page;
    const pageGroup = state.byPage.get(pageKey);
    if (pageGroup === undefined) state.byPage.set(pageKey, [chunk.id]);
    else pageGroup.push(chunk.id);
    if (section !== '') {
      const sectionKey = source.path + '\u0000' + section;
      const sectionGroup = state.bySection.get(sectionKey);
      if (sectionGroup === undefined) state.bySection.set(sectionKey, [chunk.id]);
      else sectionGroup.push(chunk.id);
    }
    if (run !== undefined) {
      run.end = chunk.page;
      const chapterKey = source.path + '#' + run.chapter;
      const chapterGroup = state.byChapter.get(chapterKey);
      if (chapterGroup === undefined) state.byChapter.set(chapterKey, [chunk.id]);
      else chapterGroup.push(chunk.id);
    }
  }
  flush();
}

function sortBuildGroups(state: BuildState): void {
  for (const group of state.byPage.values()) group.sort((left, right) => chunkOrder(left) - chunkOrder(right));
  for (const group of state.bySection.values()) group.sort((left, right) => chunkOrder(left) - chunkOrder(right));
  for (const group of state.byChapter.values()) group.sort((left, right) => chunkOrder(left) - chunkOrder(right));
}

/**
 * Seed the state from the cached prefix so only appended books get tokenised. Cached chunks carry
 * section, quality and chapter, so the reused documents need an id but no text — their postings
 * come from the cache. Any mismatch (a removed book, an edited chunk file) returns undefined and
 * the caller rebuilds from scratch.
 */
function seedFromCache(
  cached: SearchCache,
  sources: readonly SourceDoc[],
  assignments: FamilyAssignment,
): { readonly state: BuildState; readonly reused: number } | undefined {
  const oldCount = cached.sources.length;
  const oldChunks = cached.chunks.length;
  if (oldCount === 0 || oldCount > sources.length || cached.postings.size !== oldChunks) return undefined;
  const state = createBuildState();
  let cursor = 0;
  for (let index = 0; index < oldCount; index += 1) {
    const source = sources[index];
    const meta = cached.sources[index];
    if (source === undefined || meta === undefined) return undefined;
    if (source.sha256 !== meta.sha256 || source.path !== meta.path || source.textHash !== meta.textHash) return undefined;
    const family = assignments.bySha.get(source.sha256)?.id ?? source.sha256;
    for (const chunk of source.chunks) {
      const stored = cached.chunks[cursor];
      if (stored === undefined || stored.id !== chunk.id) return undefined;
      cursor += 1;
      state.byId.set(chunk.id, {
        chunk,
        path: meta.path,
        family,
        quality: stored.quality,
        section: stored.section,
        chapter: stored.chapter,
      });
      state.chunkMeta.push(stored);
      state.documents.push({ id: chunk.id, text: '' });
    }
  }
  if (cursor !== oldChunks) return undefined;
  for (const chapter of cached.chapters) state.chapters.push({ ...chapter });
  for (const [mapKey, ids] of cached.byPage) state.byPage.set(mapKey, [...ids]);
  for (const [mapKey, ids] of cached.bySection) state.bySection.set(mapKey, [...ids]);
  for (const [mapKey, ids] of cached.byChapter) state.byChapter.set(mapKey, [...ids]);
  return { state, reused: oldCount };
}

/** Cache hit path: same order as the build, so document indexes line up with the postings. */
function restoreFromCache(
  cached: SearchCache,
  sources: readonly SourceDoc[],
  key: string,
): IndexSnapshot | undefined {
  const documents: Bm25Document[] = [];
  const byId = new Map<string, IndexedChunk>();
  let cursor = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const meta = cached.sources[index];
    if (source === undefined || meta === undefined) return undefined;
    for (const chunk of source.chunks) {
      const stored = cached.chunks[cursor];
      if (stored === undefined || stored.id !== chunk.id) return undefined;
      cursor += 1;
      const indexed: IndexedChunk = {
        chunk,
        path: meta.path,
        family: meta.family,
        quality: stored.quality,
        section: stored.section,
        chapter: stored.chapter,
      };
      byId.set(chunk.id, indexed);
      documents.push({ id: chunk.id, text: documentTextOf(meta.path, chunk) });
    }
  }
  const chapters = cached.chapters.map((chapter) => ({ ...chapter }));
  const chapterDocs = chapters.map((chapter) => ({ id: chapter.id, text: chapter.text }));
  const index = createBm25FromPostings(
    cached.postings,
    { documentWeight: (document) => byId.get(document.id)?.quality ?? 1 },
    documents,
  );
  const chapterIndex = cached.chapterPostings === undefined
    ? createBm25(chapterDocs)
    : createBm25FromPostings(cached.chapterPostings, {}, chapterDocs);
  return {
    key,
    sources: sources.length,
    families: new Set(cached.sources.map((source) => source.family)).size,
    documents,
    byId,
    chapters,
    chapterIndex,
    index,
    byPage: new Map(cached.byPage.map(([mapKey, ids]) => [mapKey, [...ids]])),
    bySection: new Map(cached.bySection.map(([mapKey, ids]) => [mapKey, [...ids]])),
    byChapter: new Map(cached.byChapter.map(([mapKey, ids]) => [mapKey, [...ids]])),
  };
}

/**
 * Build the searchable snapshot: chunk documents, families (same work, different edition),
 * chapter ranges taken from the headings that ingestion copied onto each chunk, and a small
 * BM25 index over chapter titles. Everything is derived from the chunk files, so an existing
 * index gets these features without re-extracting a single PDF.
 */
async function buildIndex(fs: QueryFs, key: string): Promise<IndexSnapshot> {
  const catalog = JSON.parse(key) as Catalog;
  const sources: SourceDoc[] = [];
  for (const [sha256, source] of Object.entries(catalog.sources)) {
    const relPath = chunkFileOf(sha256);
    if (!(await fs.exists(relPath))) continue;
    const chunks: StoredChunk[] = [];
    for (const line of (await fs.readText(relPath)).split(/\r?\n/)) {
      if (line.trim() === '') continue;
      chunks.push(JSON.parse(line) as StoredChunk);
    }
    chunks.sort((left, right) => left.page - right.page || chunkOrder(left.id) - chunkOrder(right.id));
    const maxPage = chunks.reduce((max, chunk) => Math.max(max, chunk.page), 0);
    sources.push({ sha256, path: source.path, pages: source.pages > 0 ? source.pages : maxPage, chunks, textHash: sourceTextHash(chunks) });
  }

  const cached = await readSearchCacheUnchecked(fs);
  const exact = cached !== undefined && cached.catalogHash === catalogHashOf(key);
  if (exact && cached !== undefined) {
    const totalChunks = sources.reduce((sum, source) => sum + source.chunks.length, 0);
    const aligned = cached.sources.length === sources.length
      && cached.chunks.length === totalChunks
      && cached.postings.size === totalChunks
      && cached.sources.every((source, index) => source.sha256 === sources[index]?.sha256 && source.textHash === sources[index]?.textHash);
    if (aligned) {
      const restored = restoreFromCache(cached, sources, key);
      if (restored !== undefined) {
        return restored;
      }
    }
  }

  const assignments = assignFamilies(
    sources.map((source) => ({
      sha256: source.sha256,
      path: source.path,
      pages: source.pages,
      sample: sampleOf(source.chunks),
    })),
  );

  // An appended book reuses the cached prefix; anything else starts from an empty state.
  const appended = cached !== undefined && !exact ? seedFromCache(cached, sources, assignments) : undefined;
  const state = appended?.state ?? createBuildState();
  for (const source of sources.slice(appended?.reused ?? 0)) {
    appendSource(state, source, assignments.bySha.get(source.sha256)?.id ?? source.sha256);
  }
  sortBuildGroups(state);
  const { documents, chunkMeta, byId, chapters, byPage, bySection, byChapter } = state;

  // Quality is a property of the page, so it can live inside the cached index; named-entity
  // and chapter weights are query-specific and arrive per call.
  const documentWeight = (document: Bm25Document): number => byId.get(document.id)?.quality ?? 1;
  const chapterDocs = chapters.map((chapter) => ({ id: chapter.id, text: chapter.text }));
  let index: Bm25Index;
  let chapterIndex: Bm25Index;
  if (appended !== undefined && cached !== undefined) {
    const oldChapters = cached.chapters.map((chapter) => ({ id: chapter.id, text: chapter.text }));
    const oldChapterPostings = cached.chapterPostings ?? createBm25(oldChapters).toPostings();
    const addedDocuments = createBm25(documents.slice(cached.chunks.length));
    index = createBm25FromPostings(
      mergeBm25Postings(cached.postings, addedDocuments.toPostings()),
      { documentWeight },
      documents,
    );
    const addedChapters = createBm25(chapterDocs.slice(cached.chapters.length));
    chapterIndex = createBm25FromPostings(
      mergeBm25Postings(oldChapterPostings, addedChapters.toPostings()),
      {},
      chapterDocs,
    );
  } else {
    index = createBm25(documents, { documentWeight });
    chapterIndex = createBm25(chapterDocs);
  }
  await writeSearchCache(fs, makeSearchCache({
    catalogHash: catalogHashOf(key),
    sources: sources.map((source) => ({
      sha256: source.sha256,
      path: source.path,
      pages: source.pages,
      family: assignments.bySha.get(source.sha256)?.id ?? source.sha256,
      textHash: source.textHash,
    })),
    chunks: chunkMeta,
    chapters,
    byPage: [...byPage],
    bySection: [...bySection],
    byChapter: [...byChapter],
    postings: index.toPostings(),
    chapterPostings: chapterIndex.toPostings(),
  }));

  return {
    key,
    sources: sources.length,
    families: assignments.families,
    documents,
    byId,
    chapters,
    chapterIndex,
    index,
    byPage,
    bySection,
    byChapter,
  };
}

function chapterScoreOf(snapshot: IndexSnapshot, chapter: number, scores: ReadonlyMap<string, number>): number {
  if (chapter < 0) return 0;
  const doc = snapshot.chapters[chapter];
  return doc === undefined ? 0 : scores.get(doc.id) ?? 0;
}

export function emptyQueryReport(vaultRoot: string, queryText: string, error: unknown): QueryReport {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'query.failed';
  return { ok: false, error: { code, message }, vaultRoot, query: queryText, hits: [], searched: { sources: 0, chunks: 0 }, elapsedMs: 0 };
}

interface VectorHit {
  readonly id: string;
  readonly cosine: number;
}

/** Cosine against every stored chunk vector; vectors are L2-normalised, so this is a dot product. */
function topVectorHits(store: VectorStore, query: readonly number[], limit: number): VectorHit[] {
  const dims = store.dims;
  if (dims === 0 || query.length !== dims) return [];
  const hits: VectorHit[] = [];
  const count = Math.min(store.ids.length, Math.floor(store.data.length / dims));
  for (let row = 0; row < count; row += 1) {
    let dot = 0;
    const offset = row * dims;
    for (let column = 0; column < dims; column += 1) dot += (store.data[offset + column] as number) * (query[column] as number);
    hits.push({ id: store.ids[row] as string, cosine: dot });
  }
  hits.sort((left, right) => right.cosine - left.cosine);
  return hits.slice(0, limit);
}

/** Full page / section text for a hit, truncated to keep the answer budget predictable. */
function contextOf(snapshot: IndexSnapshot, item: IndexedChunk | undefined, expand: 'page' | 'section', maxChars: number): string {
  if (item === undefined) return '';
  const key = expand === 'page' ? item.path + '#' + item.chunk.page : item.path + '#' + item.chapter;
  const ids = expand === 'page'
    ? snapshot.byPage.get(key)
    : item.chapter >= 0
      ? snapshot.byChapter.get(key)
      : snapshot.bySection.get(item.path + '\u0000' + item.section);
  if (ids === undefined) return item.chunk.text.slice(0, maxChars);
  const parts: string[] = [];
  let size = 0;
  for (const id of ids) {
    const chunk = snapshot.byId.get(id)?.chunk;
    if (chunk === undefined) continue;
    if (size + chunk.text.length > maxChars && parts.length > 0) break;
    parts.push(chunk.text);
    size += chunk.text.length;
  }
  const text = parts.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

export async function runQuery(fs: QueryFs, queryText: string, topK = 8, options: QueryOptions = {}): Promise<QueryReport> {
  const started = Date.now();
  if (!(await fs.exists(INDEX_CATALOG_PATH))) {
    throw Object.assign(new Error('no index yet: run kb_ingest first (' + INDEX_CATALOG_PATH + ' not found)'), { code: 'query.index-missing' });
  }
  const catalogText = await fs.readText(INDEX_CATALOG_PATH);
  const cached = INDEX_CACHE.get(fs.root);
  let snapshot: IndexSnapshot;
  if (options.cache !== false && cached !== undefined && cached.key === catalogText) {
    snapshot = cached;
  } else {
    snapshot = await buildIndex(fs, catalogText);
    if (options.cache !== false) INDEX_CACHE.set(fs.root, snapshot);
  }

  // Each phrasing gets its own ranking; the lists are fused by reciprocal rank (RRF). Unlike
  // fusing BM25 with vectors, every input here is a full question, so a rank gap means something.
  const variants: string[] = [];
  for (const candidate of [queryText, ...(options.queries ?? [])]) {
    const text = candidate.trim();
    if (text !== '' && !variants.includes(text) && variants.length < 6) variants.push(text);
  }
  const searchPool = Math.max(topK * 8, 64);
  const extra = expandQuery(queryText, options.glossary ?? []);
  const expansion = extra.length === 0 ? undefined : { text: extra.join(' '), scale: 0.35 };

  const rankFor = (text: string, widen: boolean): Bm25Hit[] => {
    // A user who names a device ("ADA4505", "MG996R") means that datasheet; those tokens also sit
    // in the book file name, so any document whose book carries one of them is scored higher.
    const namedEntities = tokenize(text).filter((token) => /[0-9]/.test(token) && token.length >= 4);
    // Chapter-level match: a section title is the author summary of the pages below it, which is
    // exactly what a low-density textbook page lacks. Matching headings lift every chunk inside them.
    const chapterHits = snapshot.chapterIndex.search(text, CHAPTER_POOL, undefined, widen ? expansion : undefined);
    const chapterMax = chapterHits[0]?.score ?? 0;
    const chapterScores = new Map<string, number>();
    if (chapterMax > 0) {
      for (const hit of chapterHits) chapterScores.set(hit.id, hit.score / chapterMax);
    }
    const documentWeight = (document: Bm25Document): number => {
      const item = snapshot.byId.get(document.id);
      if (item === undefined) return 1;
      let weight = 1;
      if (namedEntities.length > 0) {
        const bookTokens = new Set(tokenize(item.path.split('/').pop() ?? ''));
        if (namedEntities.some((token) => bookTokens.has(token))) weight *= 2.5;
      }
      const chapterScore = chapterScoreOf(snapshot, item.chapter, chapterScores);
      if (chapterScore > 0) weight *= 1 + 0.5 * chapterScore;
      return weight;
    };
    return snapshot.index.search(text, searchPool, documentWeight, widen ? expansion : undefined);
  };
  const ranked = rankFor(queryText, true);
  let fused: readonly { id: string; score: number }[] | undefined;
  if (variants.length > 1) {
    const scores = new Map<string, number>();
    variants.forEach((text, index) => {
      const list = index === 0 ? ranked : rankFor(text, false);
      list.slice(0, searchPool).forEach((hit, rank) => {
        scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (RRF_K + rank + 1));
      });
    });
    fused = [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((left, right) => right.score - left.score);
  }

  // Lexical-first interleaving. Fusing the two lists by rank (RRF) looked reasonable but the rank
  // gaps are tiny (1/61 vs 1/62), so a page that is mediocre in BM25 and mediocre in vector space
  // beats the best lexical page; on this vault that replaced a correct datasheet page with an
  // unrelated chapter. Vectors therefore only fill the tail slots.
  const vectors = options.vectors;
  const queryVector = options.queryVector;
  let vectorCount = 0;
  let vectorHits: VectorHit[] = [];
  if (vectors !== undefined && queryVector !== undefined && queryVector.length > 0) {
    vectorHits = topVectorHits(vectors, queryVector, 64);
    if (vectorHits.length > 0) vectorCount = Math.min(vectors.ids.length, Math.floor(vectors.data.length / vectors.dims));
  }
  // Score-level hybrid: normalise both lists by their best hit and mix. RRF failed here because the
  // rank gaps are tiny (1/61 vs 1/62), which let a mediocre-on-both page beat the best lexical one.
  const hybridWeight = Math.max(0, Math.min(1, options.hybridWeight ?? 0));
  let hybridOrder: { id: string; score: number }[] | undefined;
  if (hybridWeight > 0 && vectorHits.length > 0) {
    const bm25Max = ranked[0]?.score ?? 0;
    const cosMax = Math.max(0, ...vectorHits.map((hit) => hit.cosine));
    const bm25 = new Map(ranked.map((hit) => [hit.id, bm25Max > 0 ? hit.score / bm25Max : 0]));
    const cos = new Map(vectorHits.map((hit) => [hit.id, cosMax > 0 ? hit.cosine / cosMax : 0]));
    const ids = new Set<string>([...bm25.keys(), ...cos.keys()]);
    hybridOrder = [...ids]
      .map((id) => ({ id, score: (1 - hybridWeight) * (bm25.get(id) ?? 0) + hybridWeight * (cos.get(id) ?? 0) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, searchPool);
  }

  // Never take more than the last few slots: the top 5 stay lexical, because BM25 pages are exactly
  // right while vector pages drift by a section. Below topK=6 there is no room for a vector slot.
  const shared = Math.max(0, Math.min(Math.floor(topK * (options.vectorShare ?? 0.25)), topK - 5));
  const vectorQuota = vectorHits.length === 0 || hybridOrder !== undefined ? 0 : shared;
  const lexicalQuota = topK - vectorQuota;

  // Near-duplicate manuals (STM32F1 vs STM32C0, MSP430 family guides) and different editions of
  // the same textbook would otherwise fill every slot; both a book and its work family are capped.
  const familyCap = options.familyCap ?? DEFAULT_FAMILY_CAP;
  const perBook = new Map<string, number>();
  const perFamily = new Map<string, number>();
  const selected: { id: string; score: number }[] = [];
  const take = (id: string, score: number): void => {
    const item = snapshot.byId.get(id);
    if (item === undefined) return;
    const usedBook = perBook.get(item.path) ?? 0;
    if (usedBook >= MAX_HITS_PER_BOOK) return;
    const usedFamily = perFamily.get(item.family) ?? 0;
    if (usedFamily >= familyCap) return;
    perBook.set(item.path, usedBook + 1);
    perFamily.set(item.family, usedFamily + 1);
    selected.push({ id, score });
  };
  // A local cross-encoder scores the pool jointly with the query. BM25 keeps the candidates
  // honest (it finds the exact words); reranking decides which neighbour of those words actually
  // answers the question, which is exactly where page drift happens.
  const rerank = options.rerank;
  let reranked = false;
  let order: readonly { id: string; score: number }[] | undefined;
  if (rerank !== undefined) {
    const pool = options.rerankPool ?? DEFAULT_RERANK_POOL;
    const candidates: string[] = [];
    for (const hit of (fused ?? hybridOrder ?? ranked).slice(0, pool)) {
      if (snapshot.byId.has(hit.id) && !candidates.includes(hit.id)) candidates.push(hit.id);
    }
    // Vector hits stay out of the rerank pool on purpose: the cross-encoder already judges the
    // query against each passage, and a drifted vector page displaces a lexically exact one
    // (measured: hybrid + rerank dropped MRR from 0.30 to 0.19 on the 26-question set).
    const documents = candidates.map((id) => snapshot.byId.get(id)?.chunk.text ?? '');
    const scores = await rerank(documents);
    const blend = Math.max(0, Math.min(1, options.rerankBlend ?? DEFAULT_RERANK_BLEND));
    if (scores !== undefined && scores.length === candidates.length) {
      const lexical = new Map<string, number>();
      for (const hit of (fused ?? hybridOrder ?? ranked).slice(0, pool)) lexical.set(hit.id, hit.score);
      let bestLexical = 0;
      for (const value of lexical.values()) bestLexical = Math.max(bestLexical, value);
      order = candidates
        .map((id, index) => {
          const rerankScore = scores[index] ?? 0;
          if (blend === 0 || bestLexical <= 0) return { id, score: rerankScore };
          const lexicalScore = (lexical.get(id) ?? 0) / bestLexical;
          return { id, score: (1 - blend) * rerankScore + blend * lexicalScore };
        })
        .sort((left, right) => right.score - left.score);
      reranked = true;
    }
  }

  if (order !== undefined) {
    for (const hit of order) {
      if (selected.length >= topK) break;
      take(hit.id, hit.score);
    }
  } else if (fused !== undefined) {
    // Fusion replaces the vector tail: every candidate here already came from a full question.
    const best = fused[0]?.score ?? 0;
    for (const hit of fused) {
      if (selected.length >= topK) break;
      take(hit.id, best > 0 ? hit.score / best : 0);
    }
  } else if (hybridOrder !== undefined) {
    // The blend already mixes both scores, so the vector tail is not used at all.
    const best = hybridOrder[0]?.score ?? 0;
    for (const hit of hybridOrder) {
      if (selected.length >= topK) break;
      take(hit.id, best > 0 ? hit.score / best : 0);
    }
  } else {
    const best = ranked[0]?.score ?? 0;
    let cursor = 0;
    const takeLexical = (limit: number): void => {
      while (selected.length < limit && cursor < ranked.length) {
        const hit = ranked[cursor];
        cursor += 1;
        if (hit === undefined || !snapshot.byId.has(hit.id)) continue;
        take(hit.id, best > 0 ? hit.score / best : 0);
      }
    };
    takeLexical(lexicalQuota);
    for (const hit of vectorHits) {
      if (selected.length >= topK) break;
      if (!snapshot.byId.has(hit.id)) continue;
      if (selected.some((entry) => entry.id === hit.id)) continue;
      take(hit.id, hit.cosine);
    }
    takeLexical(topK);
  }

  const expand = options.expand ?? 'none';
  const maxContextChars = options.maxContextChars ?? DEFAULT_CONTEXT_CHARS;
  const bookHits: QueryHit[] = selected.map((hit) => {
    const item = snapshot.byId.get(hit.id);
    const stored = item?.chunk;
    const chapter = item === undefined || item.chapter < 0 ? undefined : snapshot.chapters[item.chapter];
    const pageStart = chapter !== undefined && stored !== undefined && chapter.start < stored.page ? chapter.start : undefined;
    const pageEnd = chapter !== undefined && stored !== undefined && chapter.end > stored.page ? chapter.end : undefined;
    // The chapter title names the section even on a continuation page that carries no heading of
    // its own; the pages below the hit still belong to that chapter, hence the range.
    const section = chapter !== undefined && chapter.title !== ''
      ? chapter.title
      : (item !== undefined && item.section !== '' ? item.section : undefined);
    return {
      path: item?.path ?? '',
      page: stored?.page ?? 0,
      score: Number(hit.score.toFixed(5)),
      excerpt: (stored?.text ?? '').slice(0, EXCERPT_LENGTH),
      ...(pageStart === undefined ? {} : { pageStart }),
      ...(pageEnd === undefined ? {} : { pageEnd }),
      ...(section === undefined ? {} : { section }),
      ...(expand === 'none' ? {} : { context: contextOf(snapshot, item, expand, maxContextChars) }),
    };
  });

  // Query-time notes layer: BM25 over the vault's markdown notes, computed fresh from the vault
  // (books stay untouched, so their page citations and ranking are unchanged). Notes interleave
  // with book hits by normalised score rather than being appended: a note can be the exact
  // answer, and appending would bury it below every book page at topK<=5.
  let hits: QueryHit[] = bookHits;
  if (options.notesLayer === true) {
    const notes = await searchNotes(fs, queryText, options.notesLimit ?? 5);
    if (notes.length > 0) {
      const bookMax = Math.max(0, ...bookHits.map((hit) => hit.score));
      const noteMax = notes[0]?.score ?? 0;
      const merged: { hit: QueryHit; norm: number }[] = bookHits.map((hit) => ({
        hit,
        norm: bookMax > 0 ? hit.score / bookMax : 0,
      }));
      for (const note of notes) {
        merged.push({
          hit: {
            path: note.path,
            page: note.page,
            score: Number(note.score.toFixed(5)),
            excerpt: note.excerpt,
            kind: 'note',
            ...(note.section === undefined ? {} : { section: note.section }),
          },
          norm: noteMax > 0 ? note.score / noteMax : 0,
        });
      }
      merged.sort((left, right) => right.norm - left.norm);
      hits = merged.slice(0, topK).map((entry) => entry.hit);
    }
  }
  const hybrid = vectorCount > 0 && fused === undefined;
  return {
    ok: true,
    vaultRoot: fs.root,
    query: queryText,
    hits,
    searched: {
      sources: snapshot.sources,
      chunks: snapshot.documents.length,
      ...(hybrid ? { vectors: vectorCount } : {}),
      ...(snapshot.families > 0 ? { families: snapshot.families } : {}),
      ...(variants.length > 1 ? { queries: variants.length } : {}),
    },
    retrieval: hybrid ? 'hybrid' : 'bm25',
    ...(reranked ? { reranked: true } : {}),
    coverage: Number(snapshot.index.coverage(queryText).toFixed(3)),
    elapsedMs: Date.now() - started,
  };
}
