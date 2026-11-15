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

/**
 * Inverted index in compressed sparse row form: term *i* owns the postings at
 * `offsets[i] .. offsets[i + 1]`, where `values[p]` is the document index and
 * `counts[p]` the term frequency inside that document. Typed arrays survive
 * `v8.serialize` unchanged, which is what makes a cold query skip tokenising the
 * 32 MB corpus.
 */
export interface Bm25Postings {
  readonly terms: readonly string[];
  readonly offsets: Int32Array;
  readonly counts: Int32Array;
  readonly values: Int32Array;
  /** Document frequency per term (same order as `terms`). */
  readonly df: Int32Array;
  readonly idf: Float64Array;
  readonly lengths: Int32Array;
  readonly averageLength: number;
  readonly size: number;
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
  /** Snapshot for caching on disk; pair it with `createBm25FromPostings`. */
  toPostings(): Bm25Postings;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/** Dependency-free BM25. Chinese needs no segmenter because tokens are bigrams. */
export function createBm25(documents: readonly Bm25Document[], options: Bm25Options = {}): Bm25Index {
  const postingsByTerm = new Map<string, number[]>();
  const lengths: number[] = [];
  let totalTokens = 0;
  for (let index = 0; index < documents.length; index += 1) {
    const tokens = tokenize(documents[index]?.text ?? '');
    lengths.push(tokens.length);
    totalTokens += tokens.length;
    if (tokens.length === 0) continue;
    // A per-document frequency table keeps the flat postings list to one pair per term.
    const local = new Map<string, number>();
    for (const token of tokens) local.set(token, (local.get(token) ?? 0) + 1);
    for (const [token, frequency] of local) {
      const list = postingsByTerm.get(token);
      if (list === undefined) postingsByTerm.set(token, [index, frequency]);
      else {
        list.push(index, frequency);
      }
    }
  }
  const size = documents.length;
  const averageLength = size === 0 ? 0 : totalTokens / size;
  return createBm25FromPostings(compressPostings(postingsByTerm, lengths, averageLength, size), options, documents);
}

/** Turn the mutable build-time map into the typed arrays a query walks. */
function compressPostings(
  postingsByTerm: Map<string, number[]>,
  lengths: readonly number[],
  averageLength: number,
  size: number,
): Bm25Postings {
  const terms = [...postingsByTerm.keys()].sort();
  const offsets = new Int32Array(terms.length + 1);
  const df = new Int32Array(terms.length);
  const idf = new Float64Array(terms.length);
  let total = 0;
  for (const list of postingsByTerm.values()) total += list.length;
  const values = new Int32Array(total / 2);
  const counts = new Int32Array(total / 2);
  let cursor = 0;
  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index] as string;
    const list = postingsByTerm.get(term) ?? [];
    offsets[index] = cursor;
    df[index] = list.length / 2;
    for (let at = 0; at < list.length; at += 2) {
      values[cursor] = list[at] as number;
      counts[cursor] = list[at + 1] as number;
      cursor += 1;
    }
    idf[index] = Math.log(1 + (size - df[index]! + 0.5) / (df[index]! + 0.5));
  }
  offsets[terms.length] = cursor;
  return {
    terms,
    offsets,
    counts,
    values,
    df,
    idf,
    lengths: Int32Array.from(lengths),
    averageLength,
    size,
  };
}

/**
 * Append one snapshot to another. The addition's document indexes are shifted by `base.size`; both
 * inputs are term-sorted, so this is a linear merge. Term frequencies, document lengths and corpus
 * size stay exact, so the merged index scores exactly like a full rebuild — which is what lets an
 * ingest add a book without re-tokenising the other 180.
 */
export function mergeBm25Postings(base: Bm25Postings, addition: Bm25Postings): Bm25Postings {
  if (addition.size === 0) return base;
  const shift = base.size;
  const size = base.size + addition.size;
  const terms: string[] = [];
  const values: number[] = [];
  const counts: number[] = [];
  const df: number[] = [];
  const emit = (from: Bm25Postings, termIndex: number, offset: number): void => {
    const start = from.offsets[termIndex] as number;
    const end = from.offsets[termIndex + 1] as number;
    for (let at = start; at < end; at += 1) {
      values.push((from.values[at] as number) + offset);
      counts.push(from.counts[at] as number);
    }
  };
  let left = 0;
  let right = 0;
  while (left < base.terms.length || right < addition.terms.length) {
    const baseTerm = base.terms[left];
    const additionTerm = addition.terms[right];
    if (baseTerm !== undefined && (additionTerm === undefined || baseTerm < additionTerm)) {
      terms.push(baseTerm);
      df.push(base.df[left] as number);
      emit(base, left, 0);
      left += 1;
    } else if (additionTerm !== undefined && (baseTerm === undefined || additionTerm < baseTerm)) {
      terms.push(additionTerm);
      df.push(addition.df[right] as number);
      emit(addition, right, shift);
      right += 1;
    } else {
      terms.push(baseTerm as string);
      df.push((base.df[left] as number) + (addition.df[right] as number));
      emit(base, left, 0);
      emit(addition, right, shift);
      left += 1;
      right += 1;
    }
  }
  const offsets = new Int32Array(terms.length + 1);
  const idf = new Float64Array(terms.length);
  for (let index = 0; index < terms.length; index += 1) {
    offsets[index + 1] = offsets[index]! + (df[index] as number);
    idf[index] = Math.log(1 + (size - (df[index] as number) + 0.5) / ((df[index] as number) + 0.5));
  }
  const lengths = new Int32Array(size);
  lengths.set(base.lengths, 0);
  lengths.set(addition.lengths, shift);
  let totalTokens = 0;
  for (const length of lengths) totalTokens += length;
  return {
    terms,
    offsets,
    counts: Int32Array.from(counts),
    values: Int32Array.from(values),
    df: Int32Array.from(df),
    idf,
    lengths,
    averageLength: size === 0 ? 0 : totalTokens / size,
    size,
  };
}

/**
 * Rebuild a queryable index from a cached posting list. The documents supply ids only; their text
 * is not needed to score, so a cold start can pass the chunk objects it already had to read.
 */
export function createBm25FromPostings(
  postings: Bm25Postings,
  options: Bm25Options = {},
  documents: readonly Bm25Document[] = [],
): Bm25Index {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;
  const { terms, offsets, counts, values, df, idf, lengths, averageLength } = postings;
  const size = postings.size;
  const termIndex = new Map<string, number>();
  for (let index = 0; index < terms.length; index += 1) termIndex.set(terms[index] as string, index);
  const unseenIdf = size === 0 ? 1 : Math.log(1 + (size + 0.5) / 0.5);

  const idOf = (documentIndex: number): string => documents[documentIndex]?.id ?? '';
  const factorOf = (documentIndex: number, weight?: (document: Bm25Document, documentIndex: number) => number): number => {
    const document = documents[documentIndex];
    if (document === undefined) return 1;
    if (weight !== undefined) return weight(document, documentIndex);
    if (options.documentWeight !== undefined) return options.documentWeight(document);
    return 1;
  };

  return {
    size,
    toPostings: () => postings,
    coverage(query: string): number {
      const tokens = [...new Set(tokenize(query))];
      if (tokens.length === 0) return 0;
      let seen = 0;
      let all = 0;
      for (const token of tokens) {
        const index = termIndex.get(token);
        const weight = index === undefined ? unseenIdf : idf[index] ?? unseenIdf;
        all += weight;
        if (index !== undefined) seen += weight;
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
      if (queryTokens.length === 0 || size === 0) return [];
      const expansionTokens = expansion === undefined ? [] : [...new Set(tokenize(expansion.text))];
      const expansionScale = expansion?.scale ?? 0.35;
      const scores = new Map<number, number>();
      const matched = new Map<number, number>();
      // Expansion terms are added after the coverage factor, as they always were: a translation
      // reaching a Chinese page must not be damped by words the question itself is missing.
      const expansionScores = new Map<number, number>();
      let totalWeight = 0;
      const accumulate = (
        token: string,
        scale: number,
        countTowardsCoverage: boolean,
        target: Map<number, number>,
      ): void => {
        const index = termIndex.get(token);
        if (index === undefined) return;
        const weight = idf[index] ?? 0;
        if (weight === 0) return;
        const from = offsets[index] as number;
        const to = offsets[index + 1] as number;
        for (let at = from; at < to; at += 1) {
          const documentIndex = values[at] as number;
          const frequency = counts[at] as number;
          const denominator = frequency + k1 * (1 - b + b * ((lengths[documentIndex] ?? 0) / (averageLength || 1)));
          target.set(documentIndex, (target.get(documentIndex) ?? 0) + scale * weight * ((frequency * (k1 + 1)) / denominator));
          if (countTowardsCoverage) matched.set(documentIndex, (matched.get(documentIndex) ?? 0) + weight);
        }
      };
      for (const token of queryTokens) {
        totalWeight += termIndex.has(token) ? (idf[termIndex.get(token) as number] ?? 0) : 0;
        accumulate(token, 1, true, scores);
      }
      for (const token of expansionTokens) accumulate(token, expansionScale, false, expansionScores);
      const ranked: { documentIndex: number; score: number }[] = [];
      const considered = new Set<number>();
      const consider = (documentIndex: number): void => {
        if (considered.has(documentIndex)) return;
        considered.add(documentIndex);
        const coverage = totalWeight === 0 ? 0 : (matched.get(documentIndex) ?? 0) / totalWeight;
        const lexical = (scores.get(documentIndex) ?? 0) * (0.4 + 0.6 * coverage);
        const score = (lexical + (expansionScores.get(documentIndex) ?? 0)) * factorOf(documentIndex, weight);
        if (score > 0) ranked.push({ documentIndex, score });
      };
      for (const documentIndex of scores.keys()) consider(documentIndex);
      for (const documentIndex of expansionScores.keys()) consider(documentIndex);
      // Document order breaks ties, matching the original scan order (Array#sort is stable).
      ranked.sort((left, right) => right.score - left.score || left.documentIndex - right.documentIndex);
      return ranked.slice(0, topK).map((hit) => ({ id: idOf(hit.documentIndex), score: hit.score }));
    },
  };
}
