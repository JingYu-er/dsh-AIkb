import { createBm25 } from '../domain/bm25.js';
import type { Bm25Document } from '../domain/bm25.js';

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

interface NoteChunk {
  readonly path: string;
  readonly page: number;
  readonly section: string;
  readonly text: string;
}

interface NoteIndex {
  readonly key: string;
  readonly bm25: ReturnType<typeof createBm25>;
  readonly chunks: readonly NoteChunk[];
}

/** ~600 characters per note chunk: enough context to judge a match, small enough to cite. */
const NOTE_CHUNK_CHARS = 600;
const NOTE_CACHE = new Map<string, NoteIndex>();

/** Drafts and inbox material are workspace artefacts, not finished notes. */
function isNotePath(relPath: string): boolean {
  if (!relPath.toLowerCase().endsWith('.md')) return false;
  const parts = relPath.split('/');
  const dirs = parts.slice(0, -1);
  if (dirs.some((dir) => dir.startsWith('.'))) return false;
  return !dirs.some((dir) => dir === 'node_modules' || dir === 'inbox' || dir === 'templates');
}

function stripFrontmatter(text: string): string {
  const body = text.replace(/^\uFEFF/, '');
  if (!body.startsWith('---')) return body;
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  return match === null ? body : body.slice(match[0].length);
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

/** One page per heading section: heading levels are the note's own table of contents. */
function chunksOf(relPath: string, text: string): NoteChunk[] {
  const body = stripFrontmatter(text);
  const lines = body.split(/\r?\n/);
  const sections: { title: string; lines: string[] }[] = [{ title: '', lines: [] }];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const current = sections[sections.length - 1];
    if (current === undefined) break;
    if (heading === null) {
      current.lines.push(line);
      continue;
    }
    sections.push({ title: (heading[2] ?? '').trim(), lines: [line] });
  }
  const chunks: NoteChunk[] = [];
  for (const section of sections) {
    const raw = section.lines.join('\n').trim();
    if (raw === '') continue;
    for (const piece of splitBody(raw)) {
      chunks.push({ path: relPath, page: chunks.length + 1, section: section.title, text: piece });
    }
  }
  return chunks;
}

async function buildNoteIndex(fs: NoteFs): Promise<NoteIndex | undefined> {
  if (fs.listFiles === undefined) return undefined;
  const files = (await fs.listFiles()).filter((file) => isNotePath(file.relPath));
  files.sort((left, right) => left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0);
  let newest = '';
  for (const file of files) if (file.modifiedAt > newest) newest = file.modifiedAt;
  const key = files.length + ':' + newest;
  const cached = NOTE_CACHE.get(fs.root);
  if (cached !== undefined && cached.key === key) return cached;

  const chunks: NoteChunk[] = [];
  for (const file of files) {
    try {
      chunks.push(...chunksOf(file.relPath, await fs.readText(file.relPath)));
    } catch {
      // A note deleted between listing and reading is not worth failing the query over.
    }
  }
  const documents: Bm25Document[] = chunks.map((chunk, index) => ({
    id: String(index),
    text: chunk.section === '' ? chunk.text : chunk.section + '\n' + chunk.text,
  }));
  const index: NoteIndex = { key, bm25: createBm25(documents), chunks };
  NOTE_CACHE.set(fs.root, index);
  return index;
}

/** Lexical note retrieval: BM25 over heading-scoped note chunks (k1=1.5, b=0.75 defaults). */
export async function searchNotes(fs: NoteFs, query: string, limit: number): Promise<NoteHitDraft[]> {
  const index = await buildNoteIndex(fs);
  if (index === undefined || index.chunks.length === 0 || limit <= 0) return [];
  // Ask for a wider pool so one long note cannot fill every slot: keep the best chunk per note.
  const hits = index.bm25.search(query, Math.max(1, limit * 4));
  const best = hits[0]?.score ?? 0;
  const seen = new Set<string>();
  const out: NoteHitDraft[] = [];
  for (const hit of hits) {
    const chunk = index.chunks[Number(hit.id)];
    if (chunk === undefined || seen.has(chunk.path)) continue;
    seen.add(chunk.path);
    out.push({
      path: chunk.path,
      page: chunk.page,
      score: best > 0 ? hit.score / best : 0,
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
