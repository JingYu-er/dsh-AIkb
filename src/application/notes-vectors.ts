import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { embedChunkFiles } from '../adapters/embeddings/embedding.js';
import { noteChunksOf, noteDocText } from './notes-layer.js';
import type { NoteFs, NoteVectors } from './notes-layer.js';

/** Cache location: one meta file plus the raw float32 matrix, next to the book vectors. */
export const NOTES_VECTORS_META = '.wiki/index/notes-vectors.json';
export const NOTES_VECTORS_DATA = '.wiki/index/notes-vectors.vec';
const MODEL_NAME = 'multilingual-e5-small';

export interface NoteVectorEnv {
  readonly pythonPath: string;
  readonly modelDir: string;
  /** Directory that owns temp/ (the plugin workspace, not the vault). */
  readonly workspaceRoot: string;
  readonly threads?: number;
}

interface NoteVectorMeta {
  readonly hash?: string;
  readonly count?: number;
  readonly dims?: number;
  readonly ids?: readonly string[];
  readonly model?: string;
}

/**
 * Read the cached matrix. With a hash, a cache built for a different note corpus is ignored, so an
 * edited note forces a re-embed instead of silently scoring stale vectors.
 */
export function loadNoteVectors(root: string, hash?: string): NoteVectors | undefined {
  try {
    const meta = JSON.parse(readFileSync(nodePath.join(root, NOTES_VECTORS_META.split('/').join(nodePath.sep)), 'utf8')) as NoteVectorMeta;
    if (hash !== undefined && meta.hash !== hash) return undefined;
    const count = meta.count ?? 0;
    const dims = meta.dims ?? 0;
    if (count <= 0 || dims <= 0 || !Array.isArray(meta.ids)) return undefined;
    const buffer = readFileSync(nodePath.join(root, NOTES_VECTORS_DATA.split('/').join(nodePath.sep)));
    if (buffer.byteLength !== count * dims * 4) return undefined;
    const data = new Float32Array(count * dims);
    new Uint8Array(data.buffer).set(buffer);
    return { ids: meta.ids.slice(0, count), data, dims };
  } catch {
    return undefined;
  }
}

function corpusHash(texts: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(MODEL_NAME);
  hash.update('\u0000');
  for (const text of texts) {
    hash.update(text);
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * Embed every note block with the provisioned e5 model, caching the result under .wiki/index/.
 *
 * Reuses the book embedding adapter (parse_chunks-like jobs file, staged writes because the venv
 * interpreter may not write inside the vault). Returns undefined on any failure: the caller keeps
 * the lexical ranking.
 */
export async function ensureNoteVectors(fs: NoteFs, env: NoteVectorEnv): Promise<NoteVectors | undefined> {
  const chunks = await noteChunksOf(fs);
  if (chunks.length === 0) return undefined;
  const texts = chunks.map((chunk) => noteDocText(chunk));
  const hash = corpusHash(texts);
  const cached = loadNoteVectors(fs.root, hash);
  if (cached !== undefined) return cached;

  const workspace = nodePath.resolve(env.workspaceRoot);
  const staging = nodePath.join(workspace, 'temp', 'embed', 'staging');
  const tempDir = nodePath.join(workspace, 'temp', 'embed');
  mkdirSync(staging, { recursive: true });
  const chunksPath = nodePath.join(tempDir, 'notes-' + hash + '.jsonl');
  writeFileSync(
    chunksPath,
    texts.map((text, index) => JSON.stringify({ id: String(index), text })).join('\n') + '\n',
    'utf8',
  );
  const outPath = nodePath.join(staging, 'notes-' + hash + '.vec');
  const metaPath = nodePath.join(staging, 'notes-' + hash + '.json');
  const reports = await embedChunkFiles({
    pythonPath: env.pythonPath,
    workspaceRoot: workspace,
    modelDir: env.modelDir,
    ...(env.threads === undefined ? {} : { threads: env.threads }),
    jobs: [{ chunksPath, outPath, metaPath }],
  }).catch(() => []);
  const report = reports[0];
  if (report === undefined || !report.ok) return undefined;

  try {
    const indexDir = nodePath.join(fs.root, '.wiki', 'index');
    mkdirSync(indexDir, { recursive: true });
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(metaPath, JSON.stringify({ ...meta, hash, model: MODEL_NAME }), 'utf8');
    const pairs: [string, string][] = [
      [outPath, nodePath.join(fs.root, NOTES_VECTORS_DATA.split('/').join(nodePath.sep))],
      [metaPath, nodePath.join(fs.root, NOTES_VECTORS_META.split('/').join(nodePath.sep))],
    ];
    for (const [from, to] of pairs) {
      try {
        renameSync(from, to);
      } catch {
        copyFileSync(from, to);
      }
    }
  } catch {
    return undefined;
  }
  return loadNoteVectors(fs.root, hash);
}
