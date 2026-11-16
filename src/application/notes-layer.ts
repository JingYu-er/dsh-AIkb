import { parseDraft } from '../domain/frontmatter.js';
import { createBm25 } from '../domain/bm25.js';
import type { Bm25Document } from '../domain/bm25.js';
import { tokenize } from '../domain/text.js';

/** Minimal vault view the notes layer needs: list the markdown files, read them. */
export interface NoteFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
  listFiles?(): Promise<readonly { readonly relPath: string; readonly bytes: number; readonly modifiedAt: string }[]>;
}

export interface NoteHitDraft {
  readonly path: string;
  readonly page: number;
  readonly section?: string;
  readonly score: number;
  readonly excerpt: string;
}

/** Dense block vectors for the notes corpus (ids are chunk indexes as strings). */
export interface NoteVectors {
  readonly ids: readonly string[];
  readonly data: Float32Array;
  readonly dims: number;
}

export interface NoteSearchOptions {
  /**
   * Weight the title (filename + frontmatter title/aliases/tags) 3x, headings 2x and body 1x when
   * accumulating BM25 term frequencies. On by default: note value sits in names, not prose.
   */
  readonly fieldWeight?: boolean;
  /** Multiplier for sprawling notes (body > 20k chars or > 40 wikilinks). 0.5 by default; 0 disables. */
  readonly hubPenalty?: number;
  /** Body length (characters) that makes a note a hub. */
  readonly hubSizeChars?: number;
  /** Wikilink count that makes a note a hub (an index note). */
  readonly hubLinks?: number;
  /** Block vectors; requires queryVector. Off by default (costs CPU). */
  readonly vectors?: NoteVectors;
  readonly queryVector?: readonly number[];
  /** Dense share of the mixed score (default 0.4, i.e. 0.6 BM25 + 0.4 cosine). */
  readonly vectorWeight?: number;
  /** Cross-encoder over the lexical candidates (supplied by the tool layer). Off by default. */
  readonly rerank?: (documents: readonly string[]) => Promise<readonly number[] | undefined>;
  /** 0 = pure cross-encoder order, 1 = keep the lexical order (default 0.3). */
  readonly rerankBlend?: number;
  /** How many chunks the cross-encoder sees (default 20). */
  readonly rerankPool?: number;
}

export interface NoteChunk {
  readonly path: string;
  readonly page: number;
  readonly section: string;
  /** Legacy chunk text: the heading line is included, exactly as before field weighting existed. */
  readonly text: string;
  /** Chunk text without the leading heading line, scored as the body field. */
  readonly body: string;
  /** Filename plus frontmatter title/aliases/tags, scored as the title field. */
  readonly title: string;
  /** Stripped-body length of the whole note, in characters. */
  readonly bodyChars: number;
  /** Wikilink count of the whole note. */
  readonly links: number;
}

interface NoteIndex {
  readonly key: string;
  readonly chunks: readonly NoteChunk[];
  readonly bm25?: ReturnType<typeof createBm25>;
  readonly fields?: FieldIndex;
}

/** Inverted index over weighted field term frequencies (term -> chunk -> weighted tf). */
interface FieldIndex {
  readonly postings: Map<string, Map<number, number>>;
  readonly idf: Map<string, number>;
  readonly lengths: Float64Array;
  readonly averageLength: number;
  readonly titleTokens: readonly (readonly string[])[];
  readonly size: number;
}

/** ~600 characters per note chunk: enough context to judge a match, small enough to cite. */
const NOTE_CHUNK_CHARS = 600;
const TITLE_WEIGHT = 3;
const HEADING_WEIGHT = 2;
const BODY_WEIGHT = 1;
/** A title token that is literally in the question lifts the chunk slightly (bounded, no runaway). */
const TITLE_BONUS = 1.1;
const DEFAULT_HUB_PENALTY = 0.5;
const DEFAULT_HUB_SIZE_CHARS = 20_000;
const DEFAULT_HUB_LINKS = 40;
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const TITLE_KEYS = new Set(['title', '标题', 'aliases', 'alias', '别名', 'tags', 'tag', '标签', 'name']);

const NOTE_CACHE = new Map<string, NoteIndex>();

/** Drafts and inbox material are workspace artefacts, not finished notes. */
function isNotePath(relPath: string): boolean {
  if (!relPath.toLowerCase().endsWith('.md')) return false;
  const parts = relPath.split('/');
  const dirs = parts.slice(0, -1);
  if (dirs.some((dir) => dir.startsWith('.'))) return false;
  return !dirs.some((dir) => dir === 'node_modules' || dir === 'inbox' || dir === 'templates');
}

function baseName(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath;
  return name.replace(/\.md$/i, '');
}

/**
 * Title field: the filename carries the note's topic in this vault, and frontmatter repeats it as
 * title/aliases/tags. Templater-style values are harmless tokens; the filename still anchors them.
 */
function titleFieldOf(relPath: string, entries: readonly (readonly [string, string | readonly string[]])[] | undefined): string {
  const parts: string[] = [baseName(relPath)];
  for (const [key, value] of entries ?? []) {
    if (!TITLE_KEYS.has(key.toLowerCase())) continue;
    if (typeof value === 'string') {
      if (value.trim() !== '') parts.push(value);
    } else {
      for (const item of value) if (item.trim() !== '') parts.push(item);
    }
  }
  return parts.join(' ');
}

/** Split a section at ~NOTE_CHUNK_CHARS, preferring paragraph and then character boundaries. */
function splitBody(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const pieces: string[] = [];
  let buffer = '';
  const flush = (): void => {
    const value = buffer.trim();
    buffer = '';
    if (value !== '') pieces.push(value);
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > NOTE_CHUNK_CHARS) {
      flush();
      for (let at = 0; at < paragraph.length; at += NOTE_CHUNK_CHARS) {
        const piece = paragraph.slice(at, at + NOTE_CHUNK_CHARS).trim();
        if (piece !== '') pieces.push(piece);
      }
      continue;
    }
    if (buffer !== '' && buffer.length + paragraph.length > NOTE_CHUNK_CHARS) flush();
    buffer += (buffer === '' ? '' : '\n\n') + paragraph;
  }
  flush();
  return pieces;
}

function frontmatterText(entries: readonly (readonly [string, string | readonly string[]])[] | undefined): string {
  if (entries === undefined || entries.length === 0) return '';
  return entries
    .map(([key, value]) => key + ': ' + (typeof value === 'string' ? value : value.join(', ')))
    .join('\n');
}

/** One page per heading section: heading levels are the note's own table of contents. */
function chunksOf(relPath: string, text: string, withFrontmatterChunk: boolean): NoteChunk[] {
  const parsed = parseDraft(text);
  const body = parsed.body.replace(/^\uFEFF/, '');
  const title = titleFieldOf(relPath, parsed.frontmatter);
  const links = (text.match(/\[\[/g) ?? []).length;
  const bodyChars = body.length;
  const lines = body.split(/\r?\n/);
  const sections: { title: string; heading: string; lines: string[] }[] = [{ title: '', heading: '', lines: [] }];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const current = sections[sections.length - 1];
    if (current === undefined) break;
    if (heading === null) {
      current.lines.push(line);
      continue;
    }
    sections.push({ title: (heading[2] ?? '').trim(), heading: line, lines: [line] });
  }
  const chunks: NoteChunk[] = [];
  for (const section of sections) {
    const raw = section.lines.join('\n').trim();
    if (raw === '') continue;
    const sectionBody = section.heading === '' ? raw : section.lines.slice(1).join('\n').trim();
    for (const piece of splitBody(raw)) {
      // The heading line is part of the legacy chunk text; keep it out of the body field so the
      // heading weight (2x) is not paid twice.
      const bodyPiece = section.heading !== '' && piece.startsWith(section.heading)
        ? piece.slice(section.heading.length).trim()
        : piece;
      chunks.push({
        path: relPath,
        page: chunks.length + 1,
        section: section.title,
        text: piece,
        body: bodyPiece,
        title,
        bodyChars,
        links,
      });
    }
  }
  // A note that is nothing but frontmatter (a Templater template, a property table) still exists and
  // should be findable by its title. Only the field-weighted layout indexes it, so the legacy path
  // stays byte-identical.
  if (chunks.length === 0 && withFrontmatterChunk) {
    const summary = frontmatterText(parsed.frontmatter);
    chunks.push({
      path: relPath, page: 1, section: '', text: summary, body: summary,
      title, bodyChars, links,
    });
  }
  return chunks;
}

function buildFieldIndex(chunks: readonly NoteChunk[]): FieldIndex {
  const postings = new Map<string, Map<number, number>>();
  const lengths = new Float64Array(chunks.length);
  const titleTokens: string[][] = [];
  let total = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) continue;
    const title = tokenize(chunk.title);
    titleTokens.push(title);
    const heading = chunk.section === '' ? [] : tokenize(chunk.section);
    const body = tokenize(chunk.body);
    const weightedLength = TITLE_WEIGHT * title.length + HEADING_WEIGHT * heading.length + BODY_WEIGHT * body.length;
    lengths[index] = weightedLength;
    total += weightedLength;
    const local = new Map<string, number>();
    const add = (tokens: readonly string[], weight: number): void => {
      for (const token of tokens) local.set(token, (local.get(token) ?? 0) + weight);
    };
    add(title, TITLE_WEIGHT);
    add(heading, HEADING_WEIGHT);
    add(body, BODY_WEIGHT);
    for (const [term, frequency] of local) {
      let posting = postings.get(term);
      if (posting === undefined) {
        posting = new Map<number, number>();
        postings.set(term, posting);
      }
      posting.set(index, frequency);
    }
  }
  const size = chunks.length;
  const idf = new Map<string, number>();
  for (const [term, posting] of postings) {
    const df = posting.size;
    idf.set(term, Math.log(1 + (size - df + 0.5) / (df + 0.5)));
  }
  return { postings, idf, lengths, averageLength: size === 0 ? 0 : total / size, titleTokens, size };
}

/** Field-weighted BM25 over every chunk, with the same coverage damping as the book index. */
function scoreFields(index: FieldIndex, query: string): { index: number; score: number }[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0 || index.size === 0) return [];
  const scores = new Map<number, number>();
  const matched = new Map<number, number>();
  let totalWeight = 0;
  for (const token of queryTokens) {
    const idf = index.idf.get(token);
    if (idf === undefined) continue;
    totalWeight += idf;
    const posting = index.postings.get(token);
    if (posting === undefined) continue;
    for (const [chunkIndex, frequency] of posting) {
      const length = index.lengths[chunkIndex] ?? 0;
      const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (length / (index.averageLength || 1)));
      scores.set(chunkIndex, (scores.get(chunkIndex) ?? 0) + idf * ((frequency * (BM25_K1 + 1)) / denominator));
      matched.set(chunkIndex, (matched.get(chunkIndex) ?? 0) + idf);
    }
  }
  const querySet = new Set(queryTokens);
  const ranked: { index: number; score: number }[] = [];
  for (const [chunkIndex, raw] of scores) {
    if (raw <= 0) continue;
    const coverage = totalWeight === 0 ? 0 : (matched.get(chunkIndex) ?? 0) / totalWeight;
    let score = raw * (0.4 + 0.6 * coverage);
    const title = index.titleTokens[chunkIndex] ?? [];
    if (title.some((token) => querySet.has(token))) score *= TITLE_BONUS;
    ranked.push({ index: chunkIndex, score });
  }
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked;
}

async function buildNoteIndex(fs: NoteFs, fieldWeight: boolean): Promise<NoteIndex | undefined> {
  if (fs.listFiles === undefined) return undefined;
  const files = (await fs.listFiles()).filter((file) => isNotePath(file.relPath));
  files.sort((left, right) => left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0);
  let newest = '';
  for (const file of files) if (file.modifiedAt > newest) newest = file.modifiedAt;
  const key = files.length + ':' + newest + ':' + (fieldWeight ? 'field' : 'legacy');
  const cached = NOTE_CACHE.get(fs.root + '|' + (fieldWeight ? 'field' : 'legacy'));
  if (cached !== undefined && cached.key === key) return cached;

  const chunks: NoteChunk[] = [];
  for (const file of files) {
    try {
      chunks.push(...chunksOf(file.relPath, await fs.readText(file.relPath), fieldWeight));
    } catch {
      // A note deleted between listing and reading is not worth failing the query over.
    }
  }
  let index: NoteIndex;
  if (fieldWeight) {
    index = { key, chunks, fields: buildFieldIndex(chunks) };
  } else {
    const documents: Bm25Document[] = chunks.map((chunk, position) => ({
      id: String(position),
      text: chunk.section === '' ? chunk.text : chunk.section + '\n' + chunk.text,
    }));
    index = { key, chunks, bm25: createBm25(documents) };
  }
  NOTE_CACHE.set(fs.root + '|' + (fieldWeight ? 'field' : 'legacy'), index);
  return index;
}

/** Chunk list for the vector cache: same order the dense layer indexes. */
export async function noteChunksOf(fs: NoteFs): Promise<readonly NoteChunk[]> {
  const index = await buildNoteIndex(fs, true);
  return index?.chunks ?? [];
}

/** Text a chunk is embedded and reranked as: heading context plus the chunk body. */
export function noteDocText(chunk: NoteChunk): string {
  return chunk.section === '' ? chunk.text : chunk.section + '\n' + chunk.text;
}

function cosineAt(data: Float32Array, offset: number, query: readonly number[], dims: number): number {
  let dot = 0;
  for (let index = 0; index < dims; index += 1) {
    dot += (data[offset + index] ?? 0) * (query[index] ?? 0);
  }
  return dot;
}

/** Map chunk index -> row offset in the vector matrix, or undefined when the corpus moved on. */
function vectorOffsets(vectors: NoteVectors, size: number): Map<number, number> | undefined {
  if (vectors.dims <= 0) return undefined;
  const offsets = new Map<number, number>();
  for (let index = 0; index < vectors.ids.length; index += 1) {
    const id = vectors.ids[index];
    if (id === undefined) continue;
    const chunkIndex = Number(id);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= size) return undefined;
    offsets.set(chunkIndex, index * vectors.dims);
  }
  return offsets.size === size ? offsets : undefined;
}

function hubFactorOf(
  chunk: NoteChunk,
  penalty: number,
  sizeChars: number,
  links: number,
): number {
  if (penalty <= 0 || penalty >= 1) return 1;
  const sprawling = chunk.bodyChars > sizeChars || chunk.links > links;
  return sprawling ? penalty : 1;
}

/**
 * Lexical (and optionally dense / cross-encoded) note retrieval.
 *
 * Field weighting and the hub penalty are on by default: they cost nothing and explain the two
 * failure modes this layer used to have (a title-only note was invisible; a 54 KB root note won
 * every query by term frequency). Vectors and rerank stay opt-in because they spawn Python.
 */
export async function searchNotes(
  fs: NoteFs,
  query: string,
  limit: number,
  options: NoteSearchOptions = {},
): Promise<NoteHitDraft[]> {
  const fieldWeight = options.fieldWeight !== false;
  const hubPenalty = Math.max(0, Math.min(1, options.hubPenalty ?? DEFAULT_HUB_PENALTY));
  const hubSize = options.hubSizeChars ?? DEFAULT_HUB_SIZE_CHARS;
  const hubLinks = options.hubLinks ?? DEFAULT_HUB_LINKS;
  const index = await buildNoteIndex(fs, fieldWeight);
  if (index === undefined || index.chunks.length === 0 || limit <= 0) return [];

  const queryVector = options.queryVector;
  const vectors = options.vectors;
  const offsets = vectors !== undefined && queryVector !== undefined && queryVector.length > 0
    ? vectorOffsets(vectors, index.chunks.length)
    : undefined;
  const denseWeight = Math.max(0, Math.min(1, options.vectorWeight ?? 0.4));

  let scored: { index: number; score: number }[];
  if (index.fields !== undefined) {
    scored = scoreFields(index.fields, query);
  } else {
    // Legacy path: ask for a wider pool so one long note cannot fill every slot.
    const pool = offsets !== undefined || options.rerank !== undefined
      ? index.chunks.length
      : Math.max(1, limit * 4);
    scored = index.bm25?.search(query, pool).map((hit) => ({ index: Number(hit.id), score: hit.score })) ?? [];
  }

  if (hubPenalty !== 0) {
    for (const entry of scored) {
      const chunk = index.chunks[entry.index];
      if (chunk !== undefined) entry.score *= hubFactorOf(chunk, hubPenalty, hubSize, hubLinks);
    }
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
  }

  if (offsets !== undefined && vectors !== undefined && queryVector !== undefined) {
    const best = scored[0]?.score ?? 0;
    for (const entry of scored) {
      const offset = offsets.get(entry.index);
      if (offset === undefined) continue;
      const lexical = best > 0 ? entry.score / best : 0;
      const cosine = Math.max(0, cosineAt(vectors.data, offset, queryVector, vectors.dims));
      entry.score = (1 - denseWeight) * lexical + denseWeight * cosine;
    }
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
  }

  if (options.rerank !== undefined && scored.length > 0) {
    const pool = Math.max(1, options.rerankPool ?? 20);
    const candidates = scored.slice(0, pool);
    const documents = candidates.map((entry) => {
      const chunk = index.chunks[entry.index];
      return chunk === undefined ? '' : noteDocText(chunk).slice(0, 1600);
    });
    let scores: readonly number[] | undefined;
    try {
      scores = await options.rerank(documents);
    } catch {
      scores = undefined;
    }
    if (scores !== undefined && scores.length === candidates.length) {
      const blend = Math.max(0, Math.min(1, options.rerankBlend ?? 0.3));
      const bestLexical = candidates[0]?.score ?? 0;
      const reranked = candidates
        .map((entry, position) => {
          const crossEncoder = scores[position] ?? 0;
          if (blend === 0 || bestLexical <= 0) return { index: entry.index, score: crossEncoder };
          const lexical = entry.score / bestLexical;
          return { index: entry.index, score: (1 - blend) * crossEncoder + blend * lexical };
        })
        .sort((left, right) => right.score - left.score || left.index - right.index);
      const inPool = new Set(reranked.map((entry) => entry.index));
      scored = reranked.concat(scored.filter((entry) => !inPool.has(entry.index)));
    }
  }

  const best = scored[0]?.score ?? 0;
  const seen = new Set<string>();
  const out: NoteHitDraft[] = [];
  for (const entry of scored) {
    const chunk = index.chunks[entry.index];
    if (chunk === undefined || seen.has(chunk.path)) continue;
    seen.add(chunk.path);
    out.push({
      path: chunk.path,
      page: chunk.page,
      score: best > 0 ? entry.score / best : 0,
      ...(chunk.section === '' ? {} : { section: chunk.section }),
      excerpt: chunk.text.slice(0, 240),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Test seam: forget the per-process note index (a note edited during a long session). */
export function clearNotesCache(): void {
  NOTE_CACHE.clear();
}
