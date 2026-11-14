import type { Sha256, SourceId, VaultRelPath } from './ids.js';

export type SourceFormat = 'pdf' | 'epub' | 'markdown' | 'image' | 'video' | 'unknown';

/** A position a reader can verify: page first, then an optional finer locator. */
export interface Locator {
  readonly page?: number;
  readonly section?: string;
  /** [x0, y0, x1, y1] in PDF points, for figures and equations. */
  readonly bbox?: readonly [number, number, number, number];
  /** 1-based line, for text sources. */
  readonly line?: number;
}

export interface SourceDocument {
  readonly id: SourceId;
  readonly relPath: VaultRelPath;
  readonly format: SourceFormat;
  readonly bytes: number;
  readonly sha256: Sha256;
  readonly pageCount?: number;
  /** false means a scan: the OCR path decides cost and quality, not the parser. */
  readonly hasTextLayer?: boolean;
  readonly modifiedAt?: string;
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i + 1).toLowerCase();
}

export function formatOf(relPath: string): SourceFormat {
  switch (extOf(relPath)) {
    case 'pdf': return 'pdf';
    case 'epub': return 'epub';
    case 'md':
    case 'markdown': return 'markdown';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp': return 'image';
    case 'mp4':
    case 'mov':
    case 'mkv': return 'video';
    default: return 'unknown';
  }
}

/**
 * Source bytes are never copied into the repository or the index:
 * only the hash, the locator and the extracted chunk are persisted.
 */
export const SOURCE_IS_REFERENCED_NOT_STORED = true;
