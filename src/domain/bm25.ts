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
}

export interface Bm25Index {
  search(query: string, topK?: number): Bm25Hit[];
  readonly size: number;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/** Dependency-free BM25. Chinese needs no segmenter because tokens are bigrams. */
export function createBm25(documents: readonly Bm25Document[], options: Bm25Options = {}): Bm25Index {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;
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

  return {
    size: documents.length,
    search(query: string, topK = 8): Bm25Hit[] {
      const queryTokens = [...new Set(tokenize(query))];
      if (queryTokens.length === 0 || documents.length === 0) return [];
      const hits: Bm25Hit[] = [];
      for (let index = 0; index < documents.length; index += 1) {
        const tokens = docTokens[index] ?? [];
        if (tokens.length === 0) continue;
        const frequencies = new Map<string, number>();
        for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
        let score = 0;
        for (const token of queryTokens) {
          const frequency = frequencies.get(token);
          if (frequency === undefined) continue;
          const weight = idf.get(token) ?? 0;
          const denominator = frequency + k1 * (1 - b + b * (tokens.length / (averageLength || 1)));
          score += weight * ((frequency * (k1 + 1)) / denominator);
        }
        if (score > 0) hits.push({ id: documents[index]?.id ?? '', score });
      }
      hits.sort((left, right) => right.score - left.score);
      return hits.slice(0, topK);
    },
  };
}
