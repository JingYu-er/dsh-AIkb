/** Compile inbox drafts in bulk. Writes stay inside inbox/. */

import { createHash } from 'node:crypto';
import { compileDraft, compiledHashOf } from '../domain/compile.js';

export interface CompileFs {
  /** Markdown paths relative to the inbox root, recursive. */
  listDrafts(): Promise<readonly string[]>;
  readText(relPath: string): Promise<string>;
  writeText(relPath: string, content: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
}

export interface CompileOptions {
  readonly paths?: readonly string[];
  readonly limit?: number;
  /** Overwrite the source draft instead of writing inbox/_compiled/<path>. */
  readonly inPlace?: boolean;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface CompileNoteReport {
  readonly path: string;
  readonly output: string;
  readonly title: string;
  readonly type: string;
  readonly typeInferred: boolean;
  readonly sources: readonly string[];
  readonly links: readonly string[];
  readonly changes: readonly string[];
  readonly skipped: boolean;
  readonly written: boolean;
  readonly error?: string;
}

export interface CompileReport {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly notes: readonly CompileNoteReport[];
  readonly totals: { scanned: number; compiled: number; skipped: number; failed: number };
  readonly dryRun: boolean;
  readonly elapsedMs: number;
  readonly error?: { code: string; message: string };
}

export const COMPILED_DIR = '_compiled';

function normalisePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\\/g, '/');
}

/** Skip the output folder and anything an editor or plugin keeps hidden. */
function isDraft(path: string): boolean {
  if (!/\.md$/i.test(path)) return false;
  const parts = path.split('/');
  return !parts.some((part) => part.startsWith('.') || part === COMPILED_DIR);
}

export async function runCompile(fs: CompileFs, vaultRoot: string, options: CompileOptions = {}): Promise<CompileReport> {
  const started = Date.now();
  const dryRun = options.dryRun === true;
  const wanted = options.paths === undefined ? undefined : new Set(options.paths.map(normalisePath));
  const all = (await fs.listDrafts()).map(normalisePath).filter(isDraft);
  const selected = (wanted === undefined ? all : all.filter((path) => wanted.has(path))).slice(0, options.limit ?? all.length);
  const notes: CompileNoteReport[] = [];
  for (const path of selected) {
    const output = options.inPlace === true ? path : COMPILED_DIR + '/' + path;
    try {
      const text = await fs.readText(path);
      const sourceHash = createHash('sha256').update(text, 'utf8').digest('hex');
      const existing = (await fs.exists(output)) ? await fs.readText(output) : undefined;
      if (options.force !== true && existing !== undefined && compiledHashOf(existing) === sourceHash) {
        notes.push({
          path, output, title: '', type: '', typeInferred: false, sources: [], links: [], changes: [],
          skipped: true, written: false,
        });
        continue;
      }
      const compiled = compileDraft({ relPath: path, text, sourceHash });
      const written = !dryRun;
      if (written) await fs.writeText(output, compiled.content);
      notes.push({
        path,
        output,
        title: compiled.title,
        type: compiled.noteType,
        typeInferred: compiled.typeInferred,
        sources: compiled.sources,
        links: compiled.links,
        changes: compiled.changes,
        skipped: false,
        written,
      });
    } catch (error) {
      notes.push({
        path, output, title: '', type: '', typeInferred: false, sources: [], links: [], changes: [],
        skipped: false, written: false, error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failed = notes.filter((note) => note.error !== undefined).length;
  return {
    ok: true,
    vaultRoot,
    notes,
    totals: {
      scanned: selected.length,
      compiled: notes.filter((note) => !note.skipped && note.error === undefined).length,
      skipped: notes.filter((note) => note.skipped).length,
      failed,
    },
    dryRun,
    elapsedMs: Date.now() - started,
  };
}
