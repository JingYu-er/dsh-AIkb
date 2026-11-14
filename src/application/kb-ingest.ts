import type { ChunkDraft } from '../domain/chunking.js';
import { chunkPages, DEFAULT_CHUNK_OPTIONS } from '../domain/chunking.js';
import { DomainError } from '../shared/result.js';

export interface IngestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly format: string;
  readonly bytes: number;
}

export interface IngestFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
  writeText(relPath: string, content: string): Promise<number>;
  /** Optional: drop a stale chunk file when a re-ingest reveals the source has no text layer. */
  remove?(relPath: string): Promise<void>;
}

export interface ExtractedBook {
  readonly pages: readonly { page: number; width: number; height: number; blocks: readonly string[] }[];
  readonly toc: readonly { level: number; title: string; page: number }[];
  /** Total extracted characters; absent means the adapter could not report it. */
  readonly textChars?: number;
}

/** Below this many characters a document is treated as having no text layer. */
export const MIN_TEXT_CHARS = 200;
/** Below this many characters per page it is a scan: page numbers alone clear MIN_TEXT_CHARS. */
export const MIN_CHARS_PER_PAGE = 15;

export interface IngestOptions {
  readonly limit?: number;
  readonly pathPrefix?: string;
  /** Exact vault-relative paths to ingest, when the caller names books instead of a prefix. */
  readonly paths?: readonly string[];
  readonly force?: boolean;
  readonly chunkOptions?: typeof DEFAULT_CHUNK_OPTIONS;
}

export interface IngestBookReport {
  readonly path: string;
  readonly sha256: string;
  readonly pages: number;
  readonly chunks: number;
  readonly tokens: number;
  readonly skipped: boolean;
  readonly error?: string;
}

export interface IngestReport {
  readonly ok: boolean;
  readonly error?: { code: string; message: string };
  readonly vaultRoot: string;
  readonly books: readonly IngestBookReport[];
  readonly totals: { readonly books: number; readonly pages: number; readonly chunks: number; readonly tokens: number };
  /** Which interpreter produced the text; present when the tool actually ran the extractor. */
  readonly python?: {
    readonly pythonPath: string;
    readonly source: string;
    readonly venvPath: string;
    readonly bootstrapped: boolean;
  };
  readonly elapsedMs: number;
}

export const INDEX_ROOT = '.wiki/index';
export const INDEX_CATALOG_PATH = INDEX_ROOT + '/catalog.json';
export const INDEX_SCHEMA = 'dsh-kb/index@1';
export const MANIFEST_PATH = '.wiki/books.jsonl';

const LINE_FEED = String.fromCharCode(10);

export function emptyIngestReport(vaultRoot: string, error: unknown): IngestReport {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'ingest.failed';
  return { ok: false, error: { code, message }, vaultRoot, books: [], totals: { books: 0, pages: 0, chunks: 0, tokens: 0 }, elapsedMs: 0 };
}

export function parseManifest(text: string): IngestEntry[] {
  const entries: IngestEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parsed = JSON.parse(line) as IngestEntry;
    if (typeof parsed.path === 'string' && typeof parsed.sha256 === 'string') entries.push(parsed);
  }
  return entries;
}

export function chunkFileOf(sha256: string): string {
  return INDEX_ROOT + '/chunks/' + sha256 + '.jsonl';
}

export function serializeChunks(chunks: readonly ChunkDraft[]): string {
  return chunks.map((chunk) => JSON.stringify(chunk)).join(LINE_FEED) + LINE_FEED;
}

interface CatalogSource {
  path: string;
  format: string;
  pages: number;
  chunks: number;
  tokens: number;
  ingestedAt: string;
}

interface Catalog {
  schema: string;
  updatedAt: string;
  sources: Record<string, CatalogSource>;
}

/** Ingest selected sources: extract -> page-scoped chunks -> .wiki/index. Incremental by content hash. */
export async function runIngest(
  fs: IngestFs,
  extract: (entry: IngestEntry) => Promise<ExtractedBook>,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const started = Date.now();
  if (!(await fs.exists(MANIFEST_PATH))) {
    throw new DomainError('ingest.manifest-missing', 'run kb_inventory with write=true first: ' + MANIFEST_PATH + ' not found');
  }
  const manifest = parseManifest(await fs.readText(MANIFEST_PATH));
  let selected = manifest;
  if (options.pathPrefix !== undefined && options.pathPrefix !== '') {
    selected = selected.filter((entry) => entry.path.startsWith(options.pathPrefix ?? ''));
  }
  if (options.paths !== undefined && options.paths.length > 0) {
    const wanted = new Set(options.paths);
    selected = selected.filter((entry) => wanted.has(entry.path));
  }
  if (options.limit !== undefined && options.limit > 0) selected = selected.slice(0, options.limit);

  const catalog: Catalog = (await fs.exists(INDEX_CATALOG_PATH))
    ? (JSON.parse(await fs.readText(INDEX_CATALOG_PATH)) as Catalog)
    : { schema: INDEX_SCHEMA, updatedAt: new Date(0).toISOString(), sources: {} };

  const books: IngestBookReport[] = [];
  for (const entry of selected) {
    const chunkPath = chunkFileOf(entry.sha256);
    if (options.force !== true && (await fs.exists(chunkPath))) {
      const existing = catalog.sources[entry.sha256];
      books.push({
        path: entry.path,
        sha256: entry.sha256,
        pages: existing?.pages ?? 0,
        chunks: existing?.chunks ?? 0,
        tokens: existing?.tokens ?? 0,
        skipped: true,
      });
      continue;
    }
    try {
      const extracted = await extract(entry);
      const textChars = extracted.textChars ?? extracted.pages.reduce((sum, page) => sum + page.blocks.reduce((n, block) => n + block.length, 0), 0);
      const charsPerPage = extracted.pages.length === 0 ? 0 : textChars / extracted.pages.length;
      if (textChars < MIN_TEXT_CHARS || charsPerPage < MIN_CHARS_PER_PAGE) {
        // A scan can still carry page numbers, so density decides; drop whatever an earlier
        // run indexed from the same file so a stale chunk file cannot keep haunting queries.
        if (catalog.sources[entry.sha256] !== undefined) {
          delete catalog.sources[entry.sha256];
          if (fs.remove !== undefined) await fs.remove(chunkPath);
        }
        books.push({
          path: entry.path,
          sha256: entry.sha256,
          pages: extracted.pages.length,
          chunks: 0,
          tokens: 0,
          skipped: false,
          error: 'pdf.no-text-layer: ' + textChars + ' extractable characters in ' + extracted.pages.length + ' pages (' + charsPerPage.toFixed(1) + ' chars/page; scanned image PDF, OCR is not implemented yet)',
        });
        continue;
      }
      const chunks = chunkPages(entry.sha256, extracted.pages, extracted.toc, options.chunkOptions ?? DEFAULT_CHUNK_OPTIONS);
      const tokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
      await fs.writeText(chunkPath, serializeChunks(chunks));
      catalog.sources[entry.sha256] = {
        path: entry.path,
        format: entry.format,
        pages: extracted.pages.length,
        chunks: chunks.length,
        tokens,
        ingestedAt: new Date().toISOString(),
      };
      books.push({ path: entry.path, sha256: entry.sha256, pages: extracted.pages.length, chunks: chunks.length, tokens, skipped: false });
    } catch (error) {
      books.push({ path: entry.path, sha256: entry.sha256, pages: 0, chunks: 0, tokens: 0, skipped: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  catalog.updatedAt = new Date().toISOString();
  await fs.writeText(INDEX_CATALOG_PATH, JSON.stringify(catalog, null, 2) + LINE_FEED);

  const done = books.filter((book) => book.error === undefined);
  return {
    ok: true,
    vaultRoot: fs.root,
    books,
    totals: {
      books: done.length,
      pages: done.reduce((sum, book) => sum + book.pages, 0),
      chunks: done.reduce((sum, book) => sum + book.chunks, 0),
      tokens: done.reduce((sum, book) => sum + book.tokens, 0),
    },
    elapsedMs: Date.now() - started,
  };
}
