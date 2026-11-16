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
  /** 'table' and 'formula' blocks are extracted separately and never merged into running text. */
  readonly kind?: 'table' | 'formula';
}

const TABLE_MARK = '\u27e6TABLE\u27e7';
const FORMULA_MARK = '\u27e6FORMULA\u27e7';

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
  return parts.flatMap((part) => (approxTokens(part) > maxTokens ? hardSplit(part, maxTokens) : [part]));
}

/**
 * Last-resort split for blocks without sentence punctuation (table rows, formulas):
 * walk characters until the token budget is reached, so no chunk can exceed maxTokens.
 */
function hardSplit(text: string, maxTokens: number): string[] {
  const parts: string[] = [];
  let current = '';
  let cost = 0;
  for (const char of text) {
    const unit = isCjkCode(char.codePointAt(0) ?? 0) ? 1 : 0.25;
    if (cost + unit > maxTokens && current !== '') {
      parts.push(current);
      current = '';
      cost = 0;
    }
    current += char;
    cost += unit;
  }
  if (current !== '') parts.push(current);
  return parts;
}

function isCjkCode(code: number): boolean {
  return (code >= 0x3400 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af);
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
      const trimmed = raw.trim();
      const marked: 'table' | 'formula' | undefined = trimmed.startsWith(TABLE_MARK)
        ? 'table'
        : trimmed.startsWith(FORMULA_MARK) ? 'formula' : undefined;
      if (marked !== undefined) {
        // A table or formula stays one unit: merging rows into prose destroys the column order
        // that makes a datasheet row searchable.
        flush();
        const body = trimmed.slice(marked === 'table' ? TABLE_MARK.length : FORMULA_MARK.length).trim();
        for (const piece of splitLongBlock(body, options.maxTokens)) {
          const text = piece.trim();
          if (text.length < 8) continue;
          drafts.push({ id: sourceId + ':' + page.page + ':' + index, sourceId, page: page.page, section, text, tokens: approxTokens(text), kind: marked });
          index += 1;
        }
        continue;
      }
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
