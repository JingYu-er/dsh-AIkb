import { createBm25 } from '../domain/bm25.js';
import type { Bm25Document } from '../domain/bm25.js';
import { expandQuery } from '../domain/glossary.js';
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
  /** Reciprocal-rank-fusion constant; 60 is the usual default. */
  readonly rrfK?: number;
}

export interface QueryHit {
  readonly path: string;
  readonly page: number;
  readonly section?: string;
  readonly score: number;
  readonly excerpt: string;
}

export interface QueryReport {
  readonly ok: boolean;
  readonly error?: { code: string; message: string };
  readonly vaultRoot: string;
  readonly query: string;
  readonly hits: readonly QueryHit[];
  readonly searched: { readonly sources: number; readonly chunks: number; readonly vectors?: number };
  readonly retrieval?: 'bm25' | 'hybrid';
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

const EXCERPT_LENGTH = 240;
const MAX_HITS_PER_BOOK = 2;

/** Book name + heading are searchable too: a question often names the device or chapter. */
function documentTextOf(path: string, chunk: StoredChunk): string {
  const book = (path.split('/').pop() ?? '').replace(/\.pdf$/i, '');
  const section = chunk.section ?? '';
  // Book name and heading are repeated so a named device or a chapter title can outrank a
  // passing mention of the same words deep inside another book.
  return [book, book, section, section, chunk.text].filter((part) => part !== '').join(' ');
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

export async function runQuery(fs: QueryFs, queryText: string, topK = 8, options: QueryOptions = {}): Promise<QueryReport> {
  const started = Date.now();
  if (!(await fs.exists(INDEX_CATALOG_PATH))) {
    throw Object.assign(new Error('no index yet: run kb_ingest first (' + INDEX_CATALOG_PATH + ' not found)'), { code: 'query.index-missing' });
  }
  const catalog = JSON.parse(await fs.readText(INDEX_CATALOG_PATH)) as Catalog;
  const documents: Bm25Document[] = [];
  const chunksById = new Map<string, { chunk: StoredChunk; path: string }>();
  let sources = 0;
  for (const [sha256, source] of Object.entries(catalog.sources)) {
    const relPath = chunkFileOf(sha256);
    if (!(await fs.exists(relPath))) continue;
    sources += 1;
    for (const line of (await fs.readText(relPath)).split(/\r?\n/)) {
      if (line.trim() === '') continue;
      const chunk = JSON.parse(line) as StoredChunk;
      documents.push({ id: chunk.id, text: documentTextOf(source.path, chunk) });
      chunksById.set(chunk.id, { chunk, path: source.path });
    }
  }
  // A user who names a device ("ADA4505", "MG996R") means that datasheet; those tokens also sit
  // in the book file name, so any document whose book carries one of them is scored higher.
  const queryTokens = tokenize(queryText);
  const namedEntities = queryTokens.filter((token) => /[0-9]/.test(token) && token.length >= 4);
  const documentWeight = (document: Bm25Document): number => {
    if (namedEntities.length === 0) return 1;
    const book = chunksById.get(document.id)?.path.split('/').pop() ?? '';
    const bookTokens = new Set(tokenize(book));
    return namedEntities.some((token) => bookTokens.has(token)) ? 2.5 : 1;
  };
  const index = createBm25(documents, { documentWeight });
  const extra = expandQuery(queryText);
  const searchText = extra.length === 0 ? queryText : queryText + ' ' + extra.join(' ');
  const ranked = index.search(searchText, Math.max(topK * 8, 64));

  // Fusion is rank-based on purpose: BM25 scores and cosines live on different scales, and a
  // weighted sum would need per-corpus tuning that nobody can justify.
  const rrfK = options.rrfK ?? 60;
  const fused = new Map<string, number>();
  ranked.slice(0, 64).forEach((hit, rank) => fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (rrfK + rank + 1)));
  const vectors = options.vectors;
  const queryVector = options.queryVector;
  let vectorCount = 0;
  if (vectors !== undefined && queryVector !== undefined && queryVector.length > 0) {
    const vectorHits = topVectorHits(vectors, queryVector, 64);
    if (vectorHits.length > 0) vectorCount = Math.min(vectors.ids.length, Math.floor(vectors.data.length / vectors.dims));
    vectorHits.forEach((hit, rank) => fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (rrfK + rank + 1)));
  }
  const ordered = [...fused.entries()]
    .filter(([id]) => chunksById.has(id))
    .sort((left, right) => right[1] - left[1]);

  // Near-duplicate manuals (STM32F1 vs STM32C0, MSP430 family guides) would otherwise fill
  // every slot with one book. Keep the best pages but spread the hits across sources.
  const perBook = new Map<string, number>();
  const selected: { id: string; score: number }[] = [];
  for (const [id, score] of ordered) {
    const path = chunksById.get(id)?.path ?? '';
    const used = perBook.get(path) ?? 0;
    if (used >= MAX_HITS_PER_BOOK) continue;
    perBook.set(path, used + 1);
    selected.push({ id, score });
    if (selected.length >= topK) break;
  }
  const hits: QueryHit[] = selected.map((hit) => {
    const stored = chunksById.get(hit.id);
    const base: QueryHit = {
      path: stored?.path ?? '',
      page: stored?.chunk.page ?? 0,
      score: Number(hit.score.toFixed(5)),
      excerpt: (stored?.chunk.text ?? '').slice(0, EXCERPT_LENGTH),
    };
    return stored?.chunk.section === undefined ? base : { ...base, section: stored.chunk.section };
  });
  const hybrid = vectorCount > 0;
  return {
    ok: true,
    vaultRoot: fs.root,
    query: queryText,
    hits,
    searched: { sources, chunks: documents.length, ...(hybrid ? { vectors: vectorCount } : {}) },
    retrieval: hybrid ? 'hybrid' : 'bm25',
    elapsedMs: Date.now() - started,
  };
}
