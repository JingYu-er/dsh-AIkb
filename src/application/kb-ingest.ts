import type { ChunkDraft } from '../domain/chunking.js';
import { chunkPages, DEFAULT_CHUNK_OPTIONS } from '../domain/chunking.js';
import type { HarvestedTerm } from '../domain/glossary-harvest.js';
import { harvestTermPairs } from '../domain/glossary-harvest.js';
import { GLOSSARY_PATH, loadGlossary, mergeGlossary, serializeGlossary } from './glossary-store.js';
import { POLICY_PATH, SYNONYMS_PATH, TAXONOMY_PATH, harvestProfile, mergeProfile, parseProfile, serializeProfile } from './vault-profile.js';
import type { VaultProfile } from './vault-profile.js';
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
  /** Fallback extractor for scans; only consulted when the text layer is too thin. */
  readonly ocr?: (entry: IngestEntry) => Promise<ExtractedBook | undefined>;
}

export interface IngestBookReport {
  readonly path: string;
  readonly sha256: string;
  readonly pages: number;
  readonly chunks: number;
  readonly tokens: number;
  readonly skipped: boolean;
  /** True when the text came from OCR rather than the PDF text layer. */
  readonly ocrUsed?: boolean;
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
  /** OCR toolchain used for scanned sources; absent when the run stayed on the text layer. */
  readonly ocr?: {
    readonly ok: boolean;
    readonly pythonPath: string;
    readonly rapidocrVersion: string;
    readonly installed: boolean;
    /** PP-OCRv4 recognizer; absent when RapidOCR's bundled v3 graph ran. */
    readonly model?: {
      readonly path: string;
      readonly downloaded: boolean;
    };
  };
  /** Vector pass run after this ingest; absent when embedding is off or nothing new was ingested. */
  readonly embed?: {
    readonly books: number;
    readonly chunks: number;
    readonly upToDate: number;
    readonly elapsedMs: number;
    readonly error?: string;
  };
  /** Bilingual vocabulary learned from this run; feeds query expansion on the next search. */
  readonly glossary?: {
    readonly entries: number;
    readonly added: number;
  };
  readonly elapsedMs: number;
}

export const INDEX_ROOT = '.wiki/index';
export const INDEX_CATALOG_PATH = INDEX_ROOT + '/catalog.json';
export const INDEX_SCHEMA = 'dsh-aikb/index@1';
export const MANIFEST_PATH = '.wiki/books.jsonl';

function densityOf(book: ExtractedBook): { textChars: number; charsPerPage: number } {
  const textChars =
    book.textChars ??
    book.pages.reduce((sum, page) => sum + page.blocks.reduce((n, block) => n + block.length, 0), 0);
  return { textChars, charsPerPage: book.pages.length === 0 ? 0 : textChars / book.pages.length };
}

/** A scan can still carry page numbers, so density decides, not the mere presence of text. */
function isScan(book: ExtractedBook): boolean {
  const density = densityOf(book);
  return density.textChars < MIN_TEXT_CHARS || density.charsPerPage < MIN_CHARS_PER_PAGE;
}

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

/**
 * Every chunk the catalog currently indexes, as { sourceId, path, text }. Read from disk rather
 * than from this run's extraction so a no-op ingest (all books skipped) still rebuilds the
 * vocabulary from the whole vault instead of learning nothing.
 */
async function loadIndexedChunks(fs: IngestFs, catalog: Catalog): Promise<{ sourceId: string; path: string; text: string }[]> {
  const chunks: { sourceId: string; path: string; text: string }[] = [];
  for (const [sha, source] of Object.entries(catalog.sources)) {
    let text: string;
    try {
      text = await fs.readText(chunkFileOf(sha));
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const chunk = JSON.parse(line) as { text?: unknown };
        if (typeof chunk.text === 'string') chunks.push({ sourceId: sha, path: source.path, text: chunk.text });
      } catch {
        // A malformed chunk line is one lost excerpt, not a failed ingest.
      }
    }
  }
  return chunks;
}

/** Read the three sidecars back; absent files mean "not learned yet", corrupt ones are ignored. */
async function loadProfile(fs: IngestFs): Promise<VaultProfile | undefined> {
  const inputs: { taxonomy?: string; synonyms?: string; policy?: string } = {};
  if (await fs.exists(TAXONOMY_PATH)) inputs.taxonomy = await fs.readText(TAXONOMY_PATH);
  if (await fs.exists(SYNONYMS_PATH)) inputs.synonyms = await fs.readText(SYNONYMS_PATH);
  if (await fs.exists(POLICY_PATH)) inputs.policy = await fs.readText(POLICY_PATH);
  if (Object.keys(inputs).length === 0) return undefined;
  try {
    return parseProfile(inputs);
  } catch {
    return undefined;
  }
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
  const harvested: HarvestedTerm[] = [];
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
      let extracted = await extract(entry);
      let ocrUsed = false;
      if (isScan(extracted) && options.ocr !== undefined) {
        // Rendering every page is expensive, so OCR is a fallback: the text layer gets
        // first say, and the same density gate then judges the OCR result.
        const fromOcr = await options.ocr(entry);
        if (fromOcr !== undefined && !isScan(fromOcr)) {
          extracted = fromOcr;
          ocrUsed = true;
        }
      }
      if (isScan(extracted)) {
        // Drop whatever an earlier run indexed from the same file so a stale chunk file
        // cannot keep haunting queries.
        const density = densityOf(extracted);
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
          error: 'pdf.no-text-layer: ' + density.textChars + ' extractable characters in ' + extracted.pages.length + ' pages (' + density.charsPerPage.toFixed(1) + ' chars/page; neither the text layer nor OCR produced readable text)',
        });
        continue;
      }
      const chunks = chunkPages(entry.sha256, extracted.pages, extracted.toc, options.chunkOptions ?? DEFAULT_CHUNK_OPTIONS);
      const tokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
      await fs.writeText(chunkPath, serializeChunks(chunks));
      // Harvest bilingual pairs while the text is still in memory: "静态工作点 (quiescent
      // operating point)" and "Advanced RISC Machine (ARM)" are stated explicitly by books, so no
      // model is needed to grow the query vocabulary.
      for (const chunk of chunks) harvested.push(...harvestTermPairs(chunk.text));
      harvested.push(...harvestTermPairs(entry.path));
      catalog.sources[entry.sha256] = {
        path: entry.path,
        format: entry.format,
        pages: extracted.pages.length,
        chunks: chunks.length,
        tokens,
        ingestedAt: new Date().toISOString(),
      };
      books.push({
        path: entry.path,
        sha256: entry.sha256,
        pages: extracted.pages.length,
        chunks: chunks.length,
        tokens,
        skipped: false,
        ...(ocrUsed ? { ocrUsed: true } : {}),
      });
    } catch (error) {
      books.push({ path: entry.path, sha256: entry.sha256, pages: 0, chunks: 0, tokens: 0, skipped: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  catalog.updatedAt = new Date().toISOString();
  await fs.writeText(INDEX_CATALOG_PATH, JSON.stringify(catalog, null, 2) + LINE_FEED);

  let glossary: { entries: number; added: number } | undefined;
  let currentGlossary = await loadGlossary(fs);
  if (harvested.length > 0) {
    const merged = mergeGlossary(currentGlossary, harvested, '');
    await fs.writeText(GLOSSARY_PATH, serializeGlossary(merged.file));
    glossary = { entries: merged.file.entries.length, added: merged.added };
    currentGlossary = merged.file;
  }

  // The profile is the vault's own vocabulary, learned rather than shipped: repeated forms by
  // shape, plus the term pairs the books state. Rebuilding it on ingest costs one pass over the
  // chunks and leaves a vault that names no subject area still working.
  const profileChunks = await loadIndexedChunks(fs, catalog);
  if (profileChunks.length > 0) {
    const current = await loadProfile(fs);
    const pairs = (currentGlossary?.entries ?? []).map((entry) => ({ a: entry.a, b: entry.b }));
    const harvestedProfile = harvestProfile(profileChunks, pairs);
    const sourceShas: Record<string, string> = {};
    for (const [sha, source] of Object.entries(catalog.sources)) sourceShas[source.path] = sha;
    const merged = mergeProfile(current, harvestedProfile, { sourceShas });
    const files = serializeProfile(merged.profile);
    await fs.writeText(TAXONOMY_PATH, files.taxonomy);
    await fs.writeText(SYNONYMS_PATH, files.synonyms);
    await fs.writeText(POLICY_PATH, files.policy);
  }

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
    ...(glossary === undefined ? {} : { glossary }),
    elapsedMs: Date.now() - started,
  };
}
