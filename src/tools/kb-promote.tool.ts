import { NodePromoteFs } from '../adapters/fs/promote-fs.js';
import { runPromote } from '../application/kb-promote.js';
import { appendLog } from '../application/kb-log.js';
import { NodeNotesFs } from '../adapters/fs/notes-fs.js';
import { reviewNote } from '../application/kb-review.js';
import type { PromoteReport } from '../application/kb-promote.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbPromoteArgs {
  readonly vaultPath?: string;
  readonly source?: string;
  readonly target?: string;
  readonly confirm?: boolean;
  readonly force?: boolean;
  readonly limit?: number;
}

export interface KbPromoteDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: () => boolean;
  /** Vault-relative folder compiled notes are promoted into; unset disables the tool. */
  readonly promoteDir: () => string | undefined;
}

const LINE_FEED = String.fromCharCode(10);

const OUTPUT_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    vaultRoot: { type: 'string', required: true },
    promoteDir: { type: 'string', required: true },
    dryRun: { type: 'boolean', required: true },
    elapsedMs: { type: 'integer', required: true },
    totals: { type: 'json', required: true },
    notes: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          target: { type: 'string', required: true },
          status: { type: 'string', required: true },
          added: { type: 'integer', required: true },
          removed: { type: 'integer', required: true },
          written: { type: 'boolean', required: true },
          diff: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

function renderReport(report: PromoteReport): string {
  const totals = report.totals;
  const lines = [
    'promote: ' + totals.scanned + ' compiled draft(s) -> ' + report.promoteDir
      + ' | ' + totals.created + ' new, ' + totals.updated + ' updated, ' + totals.conflicts + ' conflict(s), '
      + totals.unchanged + ' unchanged, ' + totals.failed + ' failed'
      + (report.dryRun ? ' (preview; pass confirm:true to write)' : '') + ' | ' + report.elapsedMs + ' ms',
  ];
  if (report.error !== undefined) lines.push('error [' + report.error.code + '] ' + report.error.message);
  for (const warning of report.warnings ?? []) lines.push('! ' + warning);
  for (const note of report.notes) {
    lines.push('  ' + note.status + ' ' + note.source + ' -> ' + note.target
      + (note.status === 'conflict' || note.status === 'update' ? ' (+' + note.added + ' / -' + note.removed + ')' : ''));
    if (note.error !== undefined) lines.push('    ! ' + note.error);
    for (const line of note.diff) lines.push('    ' + line.kind + line.text);
  }
  return lines.join(LINE_FEED);
}

function failedReport(vaultRoot: string, promoteDir: string, error: unknown): PromoteReport & { error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'promote.failed';
  return {
    ok: true,
    vaultRoot,
    promoteDir,
    notes: [],
    totals: { scanned: 0, created: 0, updated: 0, conflicts: 0, unchanged: 0, failed: 0 },
    dryRun: true,
    elapsedMs: 0,
    error: { code, message },
  };
}

export function createKbPromoteTool(deps: KbPromoteDeps) {
  return defineTool<KbPromoteArgs, PromoteReport>({
    name: 'kb_promote',
    description:
      'Move compiled drafts from inbox/_compiled/ into the configured vault folder, showing a line diff first. Without confirm:true it only previews (create / update / conflict / unchanged). An existing target note is never overwritten unless force:true; the compiled draft stays in place as the review record.',
    parameters: {
      vaultPath: { type: 'string', description: 'Override the configured vault root.' },
      source: { type: 'string', description: 'One compiled draft, vault-relative (inbox/_compiled/...); omit to promote all of them.' },
      target: { type: 'string', description: 'Single source only: file name relative to the promote folder.' },
      confirm: { type: 'boolean', description: 'Actually write. Omit for a diff-only preview.' },
      force: { type: 'boolean', description: 'Overwrite an existing target note that differs.' },
      limit: { type: 'integer', description: 'Promote at most this many drafts.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      let root = '(unresolved)';
      let dir = '(unset)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        const configured = deps.promoteDir();
        if (configured === undefined || configured.trim() === '') {
          return failedReport(root, dir, Object.assign(
            new Error('promoteDir is not configured; set it to a vault-relative folder, e.g. "学习/笔记"'),
            { code: 'promote.dir-not-configured' },
          ));
        }
        dir = configured;
        if (args.confirm === true && !deps.allowWrites()) {
          return failedReport(root, dir, Object.assign(new Error('writes are disabled for this vault'), { code: 'kb.writes-disabled' }));
        }
        const report = await runPromote(new NodePromoteFs(root, configured), root, configured, {
          ...(args.source === undefined ? {} : { source: args.source }),
          ...(args.target === undefined ? {} : { target: args.target }),
          ...(args.confirm === true ? { confirm: true } : {}),
          ...(args.force === true ? { force: true } : {}),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });
        // Only a confirmed write is worth a log line; a failed append must not undo the promote.
        const changed = report.totals.created + report.totals.updated;
        const warnings: string[] = [];
        if (args.confirm === true && changed > 0) {
          const notesFs = new NodeNotesFs(root);
          try {
            await appendLog(notesFs, 'promote', configured, changed + ' note(s) promoted (' + report.totals.created + ' new, ' + report.totals.updated + ' updated)');
          } catch (error) {
            console.warn('[dsh-kb] log append failed: ' + (error instanceof Error ? error.message : String(error)));
          }
          // Best-effort: seed a contradiction review queue for every note this run wrote.
          // The queue lives in inbox/review/; the promoted note itself is never touched again.
          for (const note of report.notes) {
            if (!note.written || (note.status !== 'create' && note.status !== 'update')) continue;
            try {
              const queue = await reviewNote(notesFs, note.target, { write: true });
              try {
                await appendLog(notesFs, 'review', note.target, queue.pending + ' pending verdict(s) -> ' + queue.path);
              } catch (error) {
                warnings.push('review log append failed for ' + note.target + ': ' + (error instanceof Error ? error.message : String(error)));
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              warnings.push('review failed for ' + note.target + ': ' + message);
              try {
                await appendLog(notesFs, 'review', note.target, 'failed: ' + message);
              } catch {
                // best effort only; the promote result already succeeded
              }
            }
          }
        }
        return warnings.length === 0 ? report : { ...report, warnings };
      } catch (error) {
        return failedReport(root, dir, error);
      }
    },
  });
}
