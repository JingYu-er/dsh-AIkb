import { createBm25 } from '../domain/bm25.js';
import type { Bm25Document } from '../domain/bm25.js';
import { expandQuery } from '../domain/glossary.js';
import { chunkFileOf, INDEX_CATALOG_PATH } from './kb-ingest.js';

export interface QueryFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
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
  readonly searched: { readonly sources: number; readonly chunks: number };
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

/** Book name + heading are searchable too: a question often names the device or chapter. */
function documentTextOf(path: string, chunk: StoredChunk): string {
  const book = (path.split('/').pop() ?? '').replace(/\.pdf$/i, '');
  const section = chunk.section ?? '';
  // The heading is repeated so a chapter title can outrank a passing mention deeper in another chapter.
  return [book, section, section, chunk.text].filter((part) => part !== '').join(' ');
}

export function emptyQueryReport(vaultRoot: string, queryText: string, error: unknown): QueryReport {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'query.failed';
  return { ok: false, error: { code, message }, vaultRoot, query: queryText, hits: [], searched: { sources: 0, chunks: 0 }, elapsedMs: 0 };
}

export async function runQuery(fs: QueryFs, queryText: string, topK = 8): Promise<QueryReport> {
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
  const index = createBm25(documents);
  const extra = expandQuery(queryText);
  const searchText = extra.length === 0 ? queryText : queryText + ' ' + extra.join(' ');
  const hits: QueryHit[] = index.search(searchText, topK).map((hit) => {
    const stored = chunksById.get(hit.id);
    const base: QueryHit = {
      path: stored?.path ?? '',
      page: stored?.chunk.page ?? 0,
      score: Number(hit.score.toFixed(3)),
      excerpt: (stored?.chunk.text ?? '').slice(0, EXCERPT_LENGTH),
    };
    return stored?.chunk.section === undefined ? base : { ...base, section: stored.chunk.section };
  });
  return { ok: true, vaultRoot: fs.root, query: queryText, hits, searched: { sources, chunks: documents.length }, elapsedMs: Date.now() - started };
}
