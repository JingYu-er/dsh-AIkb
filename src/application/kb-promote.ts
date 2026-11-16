/** Promote compiled drafts into the configured vault folder, with a diff
 * preview unless the caller explicitly confirms.
 */

import { diffLines } from '../domain/diff.js';
import type { DiffLine } from '../domain/diff.js';

export interface PromoteFs {
  /** Compiled drafts, vault-relative, i.e. inbox/_compiled/**&#47;*.md. */
  listCompiled(): Promise<readonly string[]>;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
  writeText(relPath: string, content: string): Promise<void>;
}

export interface PromoteOptions {
  readonly source?: string;
  /** Only meaningful with a single source; relative to promoteDir. */
  readonly target?: string;
  readonly confirm?: boolean;
  readonly force?: boolean;
  readonly limit?: number;
}

export type PromoteStatus = 'create' | 'update' | 'conflict' | 'unchanged' | 'failed';

export interface PromoteNoteReport {
  readonly source: string;
  readonly target: string;
  readonly status: PromoteStatus;
  readonly added: number;
  readonly removed: number;
  readonly diff: readonly DiffLine[];
  readonly written: boolean;
  readonly error?: string;
}

export interface PromoteReport {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly promoteDir: string;
  readonly notes: readonly PromoteNoteReport[];
  readonly totals: {
    scanned: number;
    created: number;
    updated: number;
    conflicts: number;
    unchanged: number;
    failed: number;
  };
  readonly dryRun: boolean;
  readonly elapsedMs: number;
  readonly error?: { code: string; message: string };
  /** Best-effort follow-up problems (e.g. contradiction review generation) that must not fail the promote. */
  readonly warnings?: readonly string[];
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Reject anything that would leave the configured folder. */
export function normalisePromoteDir(dir: string): string {
  const value = normalise(dir).replace(/\/+$/, '');
  if (value === '' || value.split('/').includes('..')) {
    throw coded('promote.dir-not-configured', 'promoteDir must be a relative folder inside the vault, got "' + dir + '"');
  }
  return value;
}

export async function runPromote(
  fs: PromoteFs,
  vaultRoot: string,
  promoteDir: string,
  options: PromoteOptions = {},
): Promise<PromoteReport> {
  const started = Date.now();
  const dir = normalisePromoteDir(promoteDir);
  const confirm = options.confirm === true;
  const sources = options.source === undefined
    ? [...(await fs.listCompiled())]
    : [normalise(options.source)];
  if (options.target !== undefined && sources.length !== 1) {
    throw coded('promote.target-ambiguous', 'target: is only accepted together with a single source');
  }
  const selected = sources.slice(0, options.limit ?? sources.length);
  const notes: PromoteNoteReport[] = [];
  for (const source of selected) {
    const relative = source.replace(/^inbox\/(?:_compiled\/)?/, '');
    const target = options.target === undefined
      ? dir + '/' + relative
      : dir + '/' + normalise(options.target);
    try {
      if (!source.startsWith('inbox/')) throw coded('promote.source-outside-inbox', source + ' is not under inbox/');
      if (target.split('/').includes('..')) throw coded('vault.write-denied', 'target escapes ' + dir);
      const content = await fs.readText(source);
      const exists = await fs.exists(target);
      if (!exists) {
        if (confirm) await fs.writeText(target, content);
        const diff = diffLines('', content);
        notes.push({ source, target, status: 'create', added: diff.added, removed: 0, diff: diff.lines, written: confirm });
        continue;
      }
      const existing = await fs.readText(target);
      if (existing === content) {
        notes.push({ source, target, status: 'unchanged', added: 0, removed: 0, diff: [], written: false });
        continue;
      }
      const diff = diffLines(existing, content);
      const overwrite = options.force === true;
      if (!overwrite) {
        notes.push({
          source, target, status: 'conflict', added: diff.added, removed: diff.removed, diff: diff.lines, written: false,
        });
        continue;
      }
      if (confirm) await fs.writeText(target, content);
      notes.push({
        source, target, status: 'update', added: diff.added, removed: diff.removed, diff: diff.lines, written: confirm,
      });
    } catch (error) {
      notes.push({
        source, target, status: 'failed', added: 0, removed: 0, diff: [], written: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const count = (status: PromoteStatus): number => notes.filter((note) => note.status === status).length;
  return {
    ok: true,
    vaultRoot,
    promoteDir: dir,
    notes,
    totals: {
      scanned: selected.length,
      created: count('create'),
      updated: count('update'),
      conflicts: count('conflict'),
      unchanged: count('unchanged'),
      failed: count('failed'),
    },
    dryRun: !confirm,
    elapsedMs: Date.now() - started,
  };
}
