import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import type { Bm25Postings } from '../domain/bm25.js';

/**
 * On-disk form of the query index. Building it means tokenising 32 MB of text (~3.7 s) plus
 * recomputing section headings, quality scores and edition families (~1 s); serialising the
 * result lets the next process start answering in about one second. The file lives under
 * `.wiki/index/`, next to the chunks it derives from, and is never part of the vault content.
 */
export const SEARCH_CACHE_PATH = '.wiki/index/search-cache.bin';
const FORMAT_VERSION = 1;

export interface SearchCacheSource {
  readonly sha256: string;
  readonly path: string;
  readonly pages: number;
  readonly family: string;
}

export interface SearchCacheChunk {
  readonly id: string;
  readonly section: string;
  readonly quality: number;
  readonly chapter: number;
}

export interface SearchCacheChapter {
  readonly id: string;
  readonly text: string;
  readonly path: string;
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

/** Filesystem surface the cache needs; both binary hooks are optional on read-only adapters. */
export interface SearchCacheFs {
  exists(relPath: string): Promise<boolean>;
  readBinary?(relPath: string): Promise<Uint8Array>;
  writeBinary?(relPath: string, data: Uint8Array): Promise<void>;
}

export interface SearchCache {
  readonly v: number;
  readonly catalogHash: string;
  readonly sources: readonly SearchCacheSource[];
  /** One entry per document, in build order; the arrays line up with the postings' document indexes. */
  readonly chunks: readonly SearchCacheChunk[];
  readonly chapters: readonly SearchCacheChapter[];
  readonly byPage: readonly (readonly [string, readonly string[]])[];
  readonly bySection: readonly (readonly [string, readonly string[]])[];
  readonly byChapter: readonly (readonly [string, readonly string[]])[];
  readonly postings: Bm25Postings;
  readonly chapterPostings?: Bm25Postings;
}

export function catalogHashOf(catalogText: string): string {
  return createHash('sha256').update(catalogText).digest('hex');
}

/** Any read failure (missing file, old format, truncated write) is a cache miss, never an error. */
export async function readSearchCache(fs: SearchCacheFs, catalogHash: string): Promise<SearchCache | undefined> {
  const cache = await readSearchCacheUnchecked(fs);
  if (cache === undefined || cache.catalogHash !== catalogHash) return undefined;
  return cache;
}

/**
 * The same read without the catalog check. A changed catalog is exactly the case where an append
 * can reuse the cached postings, so the caller inspects the source list itself to decide.
 */
export async function readSearchCacheUnchecked(fs: SearchCacheFs): Promise<SearchCache | undefined> {
  if (fs.readBinary === undefined) return undefined;
  try {
    if (!(await fs.exists(SEARCH_CACHE_PATH))) return undefined;
    const cache = deserialize(await fs.readBinary(SEARCH_CACHE_PATH)) as SearchCache;
    if (cache === null || typeof cache !== 'object') return undefined;
    if (cache.v !== FORMAT_VERSION) return undefined;
    if (typeof cache.catalogHash !== 'string') return undefined;
    if (!Array.isArray(cache.sources) || !Array.isArray(cache.chunks) || !Array.isArray(cache.chapters)) return undefined;
    if (cache.postings === undefined || cache.postings.size !== cache.chunks.length) return undefined;
    return cache;
  } catch {
    return undefined;
  }
}

/** Best effort: a read-only vault simply keeps rebuilding the index in memory. */
export async function writeSearchCache(fs: SearchCacheFs, cache: SearchCache): Promise<boolean> {
  if (fs.writeBinary === undefined) return false;
  try {
    await fs.writeBinary(SEARCH_CACHE_PATH, serialize(cache));
    return true;
  } catch {
    return false;
  }
}

export function makeSearchCache(input: Omit<SearchCache, 'v' | 'catalogHash'> & { catalogHash: string }): SearchCache {
  return { v: FORMAT_VERSION, ...input };
}
