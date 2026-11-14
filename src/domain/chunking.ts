import { approxTokens } from './chunk.js';

export interface PageText {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly blocks: readonly string[];
}

export interface TocEntry {
  readonly level: number;
  readonly title: string;
  readonly page: number;
  readonly endPage?: number;
}

export interface ChunkDraft {
  readonly id: string;
  readonly sourceId: string;
  readonly page: number;
  readonly section: string | undefined;
  readonly text: string;
  readonly tokens: number;
}

export interface ChunkOptions {
  readonly maxTokens: number;
  readonly minChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxTokens: 700, minChars: 24 };

export function sectionForPage(toc: readonly TocEntry[], page: number): string | undefined {
  let current: TocEntry | undefined;
  for (const entry of toc) {
    if (entry.page < 1) continue;
    if (entry.page <= page && (current === undefined || entry.page >= current.page)) current = entry;
  }
  return current?.title;
}

const SENTENCE_BREAK = /(?<=[。！？；.!?;])\s*/u;

function splitLongBlock(block: string, maxTokens: number): string[] {
  if (approxTokens(block) <= maxTokens) return [block];
  const parts: string[] = [];
  let buffer = '';
  for (const sentence of block.split(SENTENCE_BREAK)) {
    if (buffer !== '' && approxTokens(buffer + sentence) > maxTokens) {
      parts.push(buffer);
      buffer = '';
    }
    buffer += sentence;
  }
  if (buffer.trim() !== '') parts.push(buffer);
  return parts;
}

/**
 * Page-scoped chunking: a chunk never crosses a page boundary, so every snippet
 * can cite an exact page. Section titles come from the PDF outline when present.
 */
export function chunkPages(sourceId: string, pages: readonly PageText[], toc: readonly TocEntry[], options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  for (const page of pages) {
    const section = sectionForPage(toc, page.page);
    let buffer = '';
    let index = 0;
    const flush = (): void => {
      const text = buffer.trim();
      buffer = '';
      if (text.length < options.minChars) return;
      drafts.push({
        id: sourceId + ':' + page.page + ':' + index,
        sourceId,
        page: page.page,
        section,
        text,
        tokens: approxTokens(text),
      });
      index += 1;
    };
    for (const raw of page.blocks) {
      for (const piece of splitLongBlock(raw.trim(), options.maxTokens)) {
        if (piece.trim() === '') continue;
        if (buffer !== '' && approxTokens(buffer + piece) > options.maxTokens) flush();
        buffer += (buffer === '' ? '' : '\n') + piece;
      }
    }
    flush();
  }
  return drafts;
}
