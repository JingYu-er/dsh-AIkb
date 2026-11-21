import { NodeInboxFs } from '../adapters/fs/inbox-fs.js';
import { runCompile } from '../application/kb-compile.js';
import { appendLog } from '../application/kb-log.js';
import { NodeNotesFs } from '../adapters/fs/notes-fs.js';
import type { CompileReport } from '../application/kb-compile.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbCompileArgs {
  readonly vaultPath?: string;
  readonly paths?: readonly string[];
  readonly limit?: number;
  readonly inPlace?: boolean;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface KbCompileDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: () => boolean;
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
          path: { type: 'string', required: true },
          output: { type: 'string', required: true },
          title: { type: 'string', required: true },
          type: { type: 'string', required: true },
          typeInferred: { type: 'boolean', required: true },
          sources: { type: 'array', required: true, items: { type: 'string' } },
          links: { type: 'array', required: true, items: { type: 'string' } },
          changes: { type: 'array', required: true, items: { type: 'string' } },
          skipped: { type: 'boolean', required: true },
          written: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
    },
  },
};

function renderReport(report: CompileReport): string {
  const totals = report.totals;
  const lines = [
    'compile: ' + totals.scanned + ' draft(s) in ' + report.vaultRoot
      + ' | ' + totals.compiled + ' compiled, ' + totals.skipped + ' skipped, ' + totals.failed + ' failed'
      + (report.dryRun ? ' (dry run)' : '') + ' | ' + report.elapsedMs + ' ms',
  ];
  if (report.error !== undefined) lines.push('error [' + report.error.code + '] ' + report.error.message);
  for (const note of report.notes) {
    if (note.error !== undefined) {
      lines.push('  x ' + note.path + ' — ' + note.error);
      continue;
    }
    if (note.skipped) {
      lines.push('  = ' + note.path + ' (unchanged)');
      continue;
    }
    lines.push('  > ' + note.path + ' -> ' + note.output + (note.written ? '' : ' (not written)'));
    lines.push('    ' + note.title + ' | type: ' + note.type + (note.typeInferred ? ' (inferred)' : '')
      + ' | sources: ' + note.sources.length + ' | links: ' + note.links.length);
    if (note.changes.length > 0) lines.push('    changes: ' + note.changes.join('; '));
  }
  return lines.join(LINE_FEED);
}

function failedReport(vaultRoot: string, error: unknown): CompileReport & { error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'compile.failed';
  return {
    ok: true,
    vaultRoot,
    notes: [],
    totals: { scanned: 0, compiled: 0, skipped: 0, failed: 0 },
    dryRun: false,
    elapsedMs: 0,
    error: { code, message },
  };
}

export function createKbCompileTool(deps: KbCompileDeps) {
  return defineTool<KbCompileArgs, CompileReport>({
    name: 'kb_compile',
    description:
      'Compile inbox drafts into reviewable notes: resolve a title, ensure a type field, lift "source: path#page" references and wikilinks into the report, normalise the H1 and blank lines, then write inbox/_compiled/<path> (inPlace:true overwrites the draft). Idempotent through a compiledHash; dryRun:true previews without writing.',
    parameters: {
      vaultPath: { type: 'string', description: 'Override the configured vault root.' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Inbox-relative drafts to compile; omit for every draft under inbox/.',
      },
      limit: { type: 'integer', description: 'Stop after this many drafts.' },
      inPlace: { type: 'boolean', description: 'Overwrite each draft instead of writing inbox/_compiled/.' },
      force: { type: 'boolean', description: 'Recompile even when compiledHash matches.' },
      dryRun: { type: 'boolean', description: 'Report what would change without writing anything.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        if (args.dryRun !== true && !deps.allowWrites()) {
          return failedReport(root, Object.assign(new Error('writes are disabled for this vault'), { code: 'kb.writes-disabled' }));
        }
        const report = await runCompile(new NodeInboxFs(root), root, {
          ...(args.paths === undefined ? {} : { paths: args.paths }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.inPlace === true ? { inPlace: true } : {}),
          ...(args.force === true ? { force: true } : {}),
          ...(args.dryRun === true ? { dryRun: true } : {}),
        });
        // The log is bookkeeping: a failed append must not undo a successful compile.
        if (report.dryRun !== true && report.totals.compiled > 0) {
          try {
            await appendLog(new NodeNotesFs(root), 'compile', 'inbox/_compiled', report.totals.compiled + ' draft(s) compiled');
          } catch (error) {
            console.warn('[dsh-aikb] log append failed: ' + (error instanceof Error ? error.message : String(error)));
          }
        }
        return report;
      } catch (error) {
        return failedReport(root, error);
      }
    },
  });
}
