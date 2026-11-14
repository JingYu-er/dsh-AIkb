export interface EmbeddableSource {
  readonly sha256: string;
  readonly path: string;
  readonly chunks: number;
}

export interface EmbedPlan {
  readonly todo: readonly EmbeddableSource[];
  readonly upToDate: readonly EmbeddableSource[];
  readonly noChunks: readonly EmbeddableSource[];
}

/**
 * Decide which books need vectors.
 *
 * A vector file is stale when its sidecar records a different chunk count than the source
 * reports: re-ingesting a book (new chunker, more pages OCR'd) changes the count, so the
 * mismatch is the cheapest reliable signal that the vectors no longer line up with the text.
 */
export function planEmbedding(
  sources: readonly EmbeddableSource[],
  embedded: ReadonlyMap<string, number>,
  force = false,
): EmbedPlan {
  const todo: EmbeddableSource[] = [];
  const upToDate: EmbeddableSource[] = [];
  const noChunks: EmbeddableSource[] = [];
  for (const source of sources) {
    if (source.chunks <= 0) {
      noChunks.push(source);
      continue;
    }
    if (!force && embedded.get(source.sha256) === source.chunks) upToDate.push(source);
    else todo.push(source);
  }
  return { todo, upToDate, noChunks };
}

export interface EmbedBookReport {
  readonly path: string;
  readonly sha256: string;
  readonly chunks: number;
  readonly seconds?: number;
  readonly error?: string;
}

export interface EmbedReport {
  readonly ok: boolean;
  readonly error?: { code: string; message: string };
  readonly vaultRoot: string;
  readonly model?: string;
  readonly books: readonly EmbedBookReport[];
  readonly totals: { readonly books: number; readonly chunks: number; readonly upToDate: number };
  readonly elapsedMs: number;
  readonly notes?: readonly string[];
}
