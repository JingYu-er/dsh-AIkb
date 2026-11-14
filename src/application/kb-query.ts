import { createBm25 } from '../domain/bm25.js';
import type { Bm25Document } from '../domain/bm25.js';
import { chunkFileOf, INDEX_CATALOG_PATH } from './kb-ingest.js';

export interface QueryFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
}

export interface QueryHit {
  readonly path: string;
  readonly page: number;
  readonly section: string | undefined;
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
      documents.push({ id: chunk.id, text: chunk.text });
      chunksById.set(chunk.id, { chunk, path: source.path });
    }
  }
  const index = createBm25(documents);
  const hits: QueryHit[] = index.search(queryText, topK).map((hit) => {
    const stored = chunksById.get(hit.id);
    return {
      path: stored?.path ?? '',
      page: stored?.chunk.page ?? 0,
      section: stored?.chunk.section,
      score: Number(hit.score.toFixed(3)),
      excerpt: (stored?.chunk.text ?? '').slice(0, EXCERPT_LENGTH),
    };
  });
  return { ok: true, vaultRoot: fs.root, query: queryText, hits, searched: { sources, chunks: documents.length }, elapsedMs: Date.now() - started };
}
