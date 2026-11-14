import type { ChunkId, SourceId } from './ids.js';
import type { Locator } from './source.js';

/** Multimodal block kinds. A figure with no caption is a dead end for retrieval. */
export type Modality = 'text' | 'equation' | 'table' | 'figure' | 'caption' | 'code';

export interface Chunk {
  readonly id: ChunkId;
  readonly sourceId: SourceId;
  readonly ordinal: number;
  readonly locator: Locator;
  readonly modality: Modality;
  readonly text: string;
  /** Cheap estimate used for budgeting before any tokenizer runs. */
  readonly approxTokens: number;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

/**
 * Rough token estimate: CJK ~1 token per character, other scripts ~1 per 4 characters.
 * This mirrors the planning numbers in the design note (~665 tokens per dense page).
 */
export function approxTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function makeChunk(args: {
  id: ChunkId;
  sourceId: SourceId;
  ordinal: number;
  locator: Locator;
  modality: Modality;
  text: string;
}): Chunk {
  return { ...args, approxTokens: approxTokens(args.text) };
}
