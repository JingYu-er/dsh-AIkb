import { formatOf } from '../domain/source.js';

export interface InventoryFile {
  readonly relPath: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

export interface InventoryFs {
  readonly root: string;
  listFiles(): Promise<readonly InventoryFile[]>;
  sha256File(relPath: string): Promise<string>;
}

/** One line of .wiki/books.jsonl. Sources are referenced, never copied. */
export interface InventoryEntry {
  readonly path: string;
  readonly format: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly modifiedAt: string;
}

export interface InventoryTotals {
  readonly files: number;
  readonly bytes: number;
  readonly byFormat: Readonly<Record<string, number>>;
}

export interface InventoryError {
  readonly code: string;
  readonly message: string;
}

export interface InventoryReport {
  readonly ok: boolean;
  readonly error?: InventoryError;
  readonly vaultRoot: string;
  readonly manifestPath: string;
  readonly written: boolean;
  readonly entries: readonly InventoryEntry[];
  readonly totals: InventoryTotals;
  readonly skipped: readonly string[];
  readonly elapsedMs: number;
}

export interface InventoryWriter {
  writeText(relPath: string, content: string): Promise<number>;
}

export interface InventoryOptions {
  readonly manifestPath?: string;
  readonly write?: boolean;
  readonly limit?: number;
  readonly includeExtensions?: readonly string[];
  readonly writer?: InventoryWriter;
}

export const BOOK_MANIFEST_PATH = '.wiki/books.jsonl';
export const BOOK_MANIFEST_SCHEMA = 'dsh-aikb/books@1';
/** Binary documents that must be parsed into chunks. Notes are already text and are not sources. */
const SOURCE_EXTENSIONS = new Set(['pdf', 'epub', 'djvu']);
const LINE_FEED = String.fromCharCode(10);

function extensionOf(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  return dot > relPath.lastIndexOf('/') ? relPath.slice(dot + 1).toLowerCase() : '';
}

export function emptyInventoryReport(vaultRoot: string, error: unknown, manifestPath = BOOK_MANIFEST_PATH): InventoryReport {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'inventory.failed';
  return {
    ok: false,
    error: { code, message },
    vaultRoot,
    manifestPath,
    written: false,
    entries: [],
    totals: { files: 0, bytes: 0, byFormat: {} },
    skipped: [],
    elapsedMs: 0,
  };
}

/**
 * Build the source inventory: one hash + locator per source file, in stable path order.
 * Hashing is the only expensive step and it is what makes re-ingest idempotent.
 */
export async function runInventory(fs: InventoryFs, options: InventoryOptions = {}): Promise<InventoryReport> {
  const started = Date.now();
  const manifestPath = options.manifestPath ?? BOOK_MANIFEST_PATH;
  const include = new Set(options.includeExtensions ?? [...SOURCE_EXTENSIONS]);
  const files = await fs.listFiles();

  const candidates = files
    .filter((file) => include.has(extensionOf(file.relPath)))
    .sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0));

  const selected = options.limit !== undefined && options.limit > 0 ? candidates.slice(0, options.limit) : candidates;
  const skipped = candidates.slice(selected.length).map((file) => file.relPath);

  const entries: InventoryEntry[] = [];
  const byFormat: Record<string, number> = {};
  let totalBytes = 0;

  for (const file of selected) {
    const sha256 = await fs.sha256File(file.relPath);
    const format = formatOf(file.relPath);
    entries.push({ path: file.relPath, format, bytes: file.bytes, sha256, modifiedAt: file.modifiedAt });
    byFormat[format] = (byFormat[format] ?? 0) + 1;
    totalBytes += file.bytes;
  }

  let written = false;
  if (options.write === true) {
    if (options.writer === undefined) throw new Error('inventory.write-requires-writer');
    const content = entries.map((entry) => JSON.stringify(entry)).join(LINE_FEED) + LINE_FEED;
    await options.writer.writeText(manifestPath, content);
    written = true;
  }

  return {
    ok: true,
    vaultRoot: fs.root,
    manifestPath,
    written,
    entries,
    totals: { files: entries.length, bytes: totalBytes, byFormat },
    skipped,
    elapsedMs: Date.now() - started,
  };
}
