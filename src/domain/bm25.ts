import { tokenize } from './text.js';

export interface Bm25Document {
  readonly id: string;
  readonly text: string;
}

export interface Bm25Hit {
  readonly id: string;
  readonly score: number;
}

export interface Bm25Options {
  readonly k1?: number;
  readonly b?: number;
  /** Optional per-document multiplier, e.g. to scope a query to the book it names. */
  readonly documentWeight?: (document: Bm25Document) => number;
}

/** Loosely related terms (query expansion): scored, but they never lower the coverage of the question itself. */
export interface Bm25Expansion {
  readonly text: string;
  /** How much an expansion match counts against a real query term. */
  readonly scale?: number;
}

export interface Bm25Index {
  search(
    query: string,
    topK?: number,
    weight?: (document: Bm25Document, documentIndex: number) => number,
    expansion?: Bm25Expansion,
  ): Bm25Hit[];
  readonly size: number;
  /**
   * IDF-weighted share of the query's tokens that occur somewhere in the corpus. A low value means
   * the question uses words these books do not: the case where an alternative phrasing is worth
   * paying for. Tokens that never occur count with the idf they would have had if seen once.
   */
  coverage(query: string): number;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/** Dependency-free BM25. Chinese needs no segmenter because tokens are bigrams. */
export function createBm25(documents: readonly Bm25Document[], options: Bm25Options = {}): Bm25Index {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;
  const documentWeight = options.documentWeight;
  const docTokens: string[][] = [];
  const docLengths: number[] = [];
  const df = new Map<string, number>();
  const averageLength = (() => {
    let total = 0;
    for (const document of documents) {
      const tokens = tokenize(document.text);
      docTokens.push(tokens);
      docLengths.push(tokens.length);
      total += tokens.length;
      for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
    }
    return documents.length === 0 ? 0 : total / documents.length;
  })();

  const idf = new Map<string, number>();
  const total = documents.length;
  for (const [token, frequency] of df) {
    idf.set(token, Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5)));
  }

  const unseenIdf = total === 0 ? 1 : Math.log(1 + (total + 0.5) / 0.5);

  return {
    size: documents.length,
    coverage(query: string): number {
      const tokens = [...new Set(tokenize(query))];
      if (tokens.length === 0) return 0;
      let seen = 0;
      let all = 0;
      for (const token of tokens) {
        const weight = idf.get(token) ?? unseenIdf;
        all += weight;
        if (df.has(token)) seen += weight;
      }
      return all === 0 ? 0 : seen / all;
    },
    search(
      query: string,
      topK = 8,
      weight?: (document: Bm25Document, documentIndex: number) => number,
      expansion?: Bm25Expansion,
    ): Bm25Hit[] {
      const queryTokens = [...new Set(tokenize(query))];
      if (queryTokens.length === 0 || documents.length === 0) return [];
      const expansionTokens = expansion === undefined ? [] : [...new Set(tokenize(expansion.text))];
      const expansionScale = expansion?.scale ?? 0.35;
      const hits: Bm25Hit[] = [];
      for (let index = 0; index < documents.length; index += 1) {
        const tokens = docTokens[index] ?? [];
        if (tokens.length === 0) continue;
        const frequencies = new Map<string, number>();
        for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
        let score = 0;
        let matchedWeight = 0;
        let totalWeight = 0;
        for (const token of queryTokens) {
          const weight = idf.get(token) ?? 0;
          totalWeight += weight;
          const frequency = frequencies.get(token);
          if (frequency === undefined) continue;
          matchedWeight += weight;
          const denominator = frequency + k1 * (1 - b + b * (tokens.length / (averageLength || 1)));
          score += weight * ((frequency * (k1 + 1)) / denominator);
        }
        // A chunk that matches half the question should not outrank one that covers all of it.
        // Coverage is weighted by IDF: missing a common word costs less than missing a rare one,
        // so a part number or a device name carries the match on its own.
        const coverage = totalWeight === 0 ? 0 : matchedWeight / totalWeight;
        score *= 0.4 + 0.6 * coverage;
        // Expansion words help a translation reach a Chinese page, but at a fraction of the
        // weight: otherwise an English phrase pulls a textbook question into a datasheet.
        for (const token of expansionTokens) {
          const frequency = frequencies.get(token);
          if (frequency === undefined) continue;
          const idfValue = idf.get(token) ?? 0;
          const denominator = frequency + k1 * (1 - b + b * (tokens.length / (averageLength || 1)));
          score += expansionScale * idfValue * ((frequency * (k1 + 1)) / denominator);
        }
        // Query-time weights (named device, chapter match) stay outside the cached index: the
        // token counts are built once, only the multiplier is recomputed per query.
        const factor = weight !== undefined
          ? weight(documents[index] as Bm25Document, index)
          : documentWeight !== undefined
            ? documentWeight(documents[index] as Bm25Document)
            : 1;
        score *= factor;
        if (score > 0) hits.push({ id: documents[index]?.id ?? '', score });
      }
      hits.sort((left, right) => right.score - left.score);
      return hits.slice(0, topK);
    },
  };
}
