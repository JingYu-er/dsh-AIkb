import { createBm25 } from '../domain/bm25.js';
import type { Bm25Document, Bm25Index } from '../domain/bm25.js';
import { expandQuery } from '../domain/glossary.js';
import type { GlossaryEntry } from '../domain/glossary.js';
import { assignFamilies } from '../domain/family.js';
import { chunkQuality } from '../domain/quality.js';
import { headingFromText } from '../domain/section.js';
import { tokenize } from '../domain/text.js';
import { chunkFileOf, INDEX_CATALOG_PATH } from './kb-ingest.js';

export interface QueryFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
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
   * Score a list of passages against the query with a cross-encoder. Supplied by the tool layer
   * so this module never spawns a process; undefined means "keep the lexical order".
   */
  readonly rerank?: (documents: readonly string[]) => Promise<readonly number[] | undefined>;
  /** How many BM25 hits enter the reranker (vector hits are added on top). */
  readonly rerankPool?: number;
}

export interface QueryHit {
  readonly path: string;
  readonly page: number;
  /** Last page of the chapter the hit belongs to, when the book has headings. */
  readonly pageEnd?: number;
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
  readonly searched: { readonly sources: number; readonly chunks: number; readonly vectors?: number; readonly families?: number };
  readonly retrieval?: 'bm25' | 'hybrid';
  /** True when a cross-encoder reordered the candidates for this query. */
  readonly reranked?: boolean;
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

/**
 * Build the searchable snapshot: chunk documents, families (same work, different edition),
 * chapter ranges taken from the headings that ingestion copied onto each chunk, and a small
 * BM25 index over chapter titles. Everything is derived from the chunk files, so an existing
 * index gets these features without re-extracting a single PDF.
 */
async function buildIndex(fs: QueryFs, key: string): Promise<IndexSnapshot> {
  const catalog = JSON.parse(key) as Catalog;
  const sources: { sha256: string; path: string; pages: number; chunks: StoredChunk[] }[] = [];
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
    sources.push({ sha256, path: source.path, pages: source.pages > 0 ? source.pages : maxPage, chunks });
  }

  const assignments = assignFamilies(
    sources.map((source) => ({
      sha256: source.sha256,
      path: source.path,
      pages: source.pages,
      sample: sampleOf(source.chunks),
    })),
  );

  const documents: Bm25Document[] = [];
  const byId = new Map<string, IndexedChunk>();
  const chapters: ChapterDoc[] = [];
  const byPage = new Map<string, string[]>();
  const bySection = new Map<string, string[]>();
  // Contiguous runs only: the same heading can reappear later ("思考题"), and a window must not
  // splice those distant pages together.
  const byChapter = new Map<string, string[]>();

  for (const source of sources) {
    const family = assignments.bySha.get(source.sha256)?.id ?? source.sha256;
    let run: { title: string; start: number; end: number; chapter: number } | undefined;
    const flush = (): void => {
      if (run === undefined || run.title === '') return;
      chapters.push({
        id: source.sha256 + '#ch' + chapters.length,
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
          run = { title: section, start: chunk.page, end: chunk.page, chapter: chapters.length };
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
      byId.set(chunk.id, indexed);
      documents.push({ id: chunk.id, text: documentTextOf(source.path, chunk) });
      const pageKey = source.path + '#' + chunk.page;
      const pageGroup = byPage.get(pageKey);
      if (pageGroup === undefined) byPage.set(pageKey, [chunk.id]);
      else pageGroup.push(chunk.id);
      if (section !== '') {
        const sectionKey = source.path + '\u0000' + section;
        const sectionGroup = bySection.get(sectionKey);
        if (sectionGroup === undefined) bySection.set(sectionKey, [chunk.id]);
        else sectionGroup.push(chunk.id);
      }
      if (run !== undefined) {
        run.end = chunk.page;
        const chapterKey = source.path + '#' + run.chapter;
        const chapterGroup = byChapter.get(chapterKey);
        if (chapterGroup === undefined) byChapter.set(chapterKey, [chunk.id]);
        else chapterGroup.push(chunk.id);
      }
    }
    flush();
  }
  for (const group of byPage.values()) group.sort((left, right) => chunkOrder(left) - chunkOrder(right));
  for (const group of bySection.values()) group.sort((left, right) => chunkOrder(left) - chunkOrder(right));
  for (const group of byChapter.values()) group.sort((left, right) => chunkOrder(left) - chunkOrder(right));

  // Quality is a property of the page, so it can live inside the cached index; named-entity
  // and chapter weights are query-specific and arrive per call.
  const index = createBm25(documents, { documentWeight: (document) => byId.get(document.id)?.quality ?? 1 });
  const chapterIndex = createBm25(chapters.map((chapter) => ({ id: chapter.id, text: chapter.text })));

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

  // A user who names a device ("ADA4505", "MG996R") means that datasheet; those tokens also sit
  // in the book file name, so any document whose book carries one of them is scored higher.
  const queryTokens = tokenize(queryText);
  const namedEntities = queryTokens.filter((token) => /[0-9]/.test(token) && token.length >= 4);
  const extra = expandQuery(queryText, options.glossary ?? []);
  const expansion = extra.length === 0 ? undefined : { text: extra.join(' '), scale: 0.35 };

  // Chapter-level match: a section title is the author summary of the pages below it, which is
  // exactly what a low-density textbook page lacks. Matching headings lift every chunk inside them.
  const chapterHits = snapshot.chapterIndex.search(queryText, CHAPTER_POOL, undefined, expansion);
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
  const ranked = snapshot.index.search(queryText, Math.max(topK * 8, 64), documentWeight, expansion);

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
  // Never take more than the last few slots: the top 5 stay lexical, because BM25 pages are exactly
  // right while vector pages drift by a section. Below topK=6 there is no room for a vector slot.
  const shared = Math.max(0, Math.min(Math.floor(topK * (options.vectorShare ?? 0.25)), topK - 5));
  const vectorQuota = vectorHits.length === 0 ? 0 : shared;
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
    for (const hit of ranked.slice(0, pool)) {
      if (snapshot.byId.has(hit.id) && !candidates.includes(hit.id)) candidates.push(hit.id);
    }
    // Vector hits stay out of the rerank pool on purpose: the cross-encoder already judges the
    // query against each passage, and a drifted vector page displaces a lexically exact one
    // (measured: hybrid + rerank dropped MRR from 0.30 to 0.19 on the 26-question set).
    const documents = candidates.map((id) => snapshot.byId.get(id)?.chunk.text ?? '');
    const scores = await rerank(documents);
    if (scores !== undefined && scores.length === candidates.length) {
      order = candidates
        .map((id, index) => ({ id, score: scores[index] ?? 0 }))
        .sort((left, right) => right.score - left.score);
      reranked = true;
    }
  }

  if (order !== undefined) {
    for (const hit of order) {
      if (selected.length >= topK) break;
      take(hit.id, hit.score);
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
  const hits: QueryHit[] = selected.map((hit) => {
    const item = snapshot.byId.get(hit.id);
    const stored = item?.chunk;
    const chapter = item === undefined || item.chapter < 0 ? undefined : snapshot.chapters[item.chapter];
    const pageEnd = chapter !== undefined && stored !== undefined && chapter.end > stored.page ? chapter.end : undefined;
    const section = item !== undefined && item.section !== '' ? item.section : undefined;
    return {
      path: item?.path ?? '',
      page: stored?.page ?? 0,
      score: Number(hit.score.toFixed(5)),
      excerpt: (stored?.text ?? '').slice(0, EXCERPT_LENGTH),
      ...(pageEnd === undefined ? {} : { pageEnd }),
      ...(section === undefined ? {} : { section }),
      ...(expand === 'none' ? {} : { context: contextOf(snapshot, item, expand, maxContextChars) }),
    };
  });
  const hybrid = vectorCount > 0;
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
    },
    retrieval: hybrid ? 'hybrid' : 'bm25',
    ...(reranked ? { reranked: true } : {}),
    elapsedMs: Date.now() - started,
  };
}
