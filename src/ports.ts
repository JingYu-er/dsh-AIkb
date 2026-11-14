import type { Chunk } from './domain/chunk.js';
import type { Note } from './domain/note.js';
import type { SourceDocument } from './domain/source.js';
import type { VaultRelPath } from './domain/ids.js';
import type { Result } from './shared/result.js';

/**
 * Ports are the only way the application layer touches the world.
 * Infrastructure supplies adapters; the DSH plugin and tests share the same contracts.
 */

export interface Clock {
  now(): Date;
}

export interface Hasher {
  sha256File(absolutePath: string): Promise<string>;
  sha256Text(text: string): string;
}

export interface VaultReader {
  /** All markdown notes, relative to the vault root. */
  listNotePaths(): Promise<readonly VaultRelPath[]>;
  readNote(relPath: VaultRelPath): Promise<Result<Note>>;
  /** Source documents (PDF/EPUB...) known to the vault, without reading their bytes. */
  listSources(): Promise<readonly { relPath: VaultRelPath; bytes: number; modifiedAt: string }[]>;
}

export interface VaultWriter {
  /** Only inbox/** and .wiki/** are writable; the adapter must enforce it too. */
  writeDraft(relPath: VaultRelPath, content: string): Promise<Result<{ bytes: number }>>;
  move(from: VaultRelPath, to: VaultRelPath): Promise<Result<void>>;
}

export interface IndexStore {
  upsert(chunks: readonly Chunk[]): Promise<void>;
  /** Hybrid retrieval; the implementation decides the fusion, the caller decides the budget. */
  search(query: string, limit: number): Promise<readonly { chunk: Chunk; score: number }[]>;
  stats(): Promise<{ chunks: number; notes: number; sources: number }>;
}

export interface IngestLedger {
  get(sourceRelPath: string): Promise<{ sha256: string; chunks: number; ingestedAt: string } | undefined>;
  record(entry: { sourceRelPath: string; sha256: string; chunks: number; ingestedAt: string }): Promise<void>;
}

export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface ChatModel {
  readonly id: string;
  complete(input: { system?: string; user: string; maxTokens?: number }): Promise<string>;
}

export interface OcrEngine {
  available(): Promise<boolean>;
  ocrPage(source: SourceDocument, page: number): Promise<Result<readonly Chunk[]>>;
}

export interface PdfTextLayer {
  pageCount(absolutePath: string): Promise<number>;
  hasTextLayer(absolutePath: string): Promise<boolean>;
  extractPage(absolutePath: string, page: number): Promise<string>;
}

export interface UseCaseDeps {
  readonly clock: Clock;
  readonly hasher: Hasher;
  readonly vault: VaultReader;
  readonly writer: VaultWriter;
  readonly index: IndexStore;
  readonly ledger: IngestLedger;
  readonly embeddings?: EmbeddingModel;
  readonly chat?: ChatModel;
  readonly ocr?: OcrEngine;
  readonly pdf?: PdfTextLayer;
}
