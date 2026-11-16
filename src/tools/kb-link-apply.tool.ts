import { NodeNotesFs } from '../adapters/fs/notes-fs.js';
import { applyLinks } from '../application/kb-links.js';
import type { ApplyReport } from '../application/kb-links.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbLinkApplyArgs {
  readonly vaultPath?: string;
  readonly queue?: string;
  readonly note?: string;
  readonly confirm?: boolean;
}

export interface KbLinkApplyDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: () => boolean;
}

const LINE_FEED = String.fromCharCode(10);

const DIFF_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lines: {
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
    added: { type: 'integer', required: true },
    removed: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
  },
};

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
    confirm: { type: 'boolean', required: true },
    applied: { type: 'integer', required: true },
    skipped: { type: 'integer', required: true },
    pending: { type: 'integer', required: true },
    rows: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queue: { type: 'string', required: true },
          note: { type: 'string', required: true },
          target: { type: 'string', required: true },
          why: { type: 'string', required: true },
          written: { type: 'boolean', required: true },
          backup: { type: 'string' },
          skipped: { type: 'string' },
          diff: { ...DIFF_SCHEMA, required: true },
        },
      },
    },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    elapsedMs: { type: 'integer', required: true },
  },
};

function renderReport(report: ApplyReport): string {
  const lines = [
    'link-apply: ' + report.applied + ' applied, ' + report.skipped + ' skipped, ' + report.pending + ' pending, '
      + report.rows.length + ' row(s) | ' + (report.confirm ? 'written' : 'preview; pass confirm:true to write') + ' | ' + report.elapsedMs + ' ms',
  ];
  for (const warning of report.warnings) lines.push('! ' + warning);
  for (const row of report.rows) {
    if (row.skipped !== undefined) {
      lines.push('  x ' + row.note + ' ← [[' + row.target + ']] skipped (' + row.skipped + ')');
      continue;
    }
    lines.push('  ' + (row.written ? '+' : '·') + ' ' + row.note + ' ← [[' + row.target + ']]'
      + (row.backup === undefined ? '' : ' | backup ' + row.backup));
    for (const line of row.diff.lines) lines.push('    ' + line.kind + line.text);
    if (row.diff.truncated) lines.push('    … diff truncated');
  }
  return lines.join(LINE_FEED);
}

function failedReport(vaultRoot: string, error: unknown): ApplyReport & { error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'link-apply.failed';
  return { ok: true, vaultRoot, confirm: false, applied: 0, skipped: 0, pending: 0, rows: [], warnings: [], elapsedMs: 0, error: { code, message } };
}

export function createKbLinkApplyTool(deps: KbLinkApplyDeps) {
  return defineTool<KbLinkApplyArgs, ApplyReport>({
    name: 'kb_link_apply',
    description:
      'Apply approved link queue rows: only rows whose why column is filled are processed. confirm:false (default) returns a per-row diff preview and writes nothing. confirm:true appends "- [[目标]] — why" to the end of the "## 关联" section of the source note that owns the queue (creating the section when absent), backs that note up to .wiki/backups/<ISO>-<flatten>.md first, logs the link, and marks the queue row [x].',
    parameters: {
      vaultPath: { type: 'string', description: 'Override the configured vault root.' },
      queue: { type: 'string', description: 'One queue path (inbox/links/...) or a note path/name whose queue to use; omit for every queue.' },
      note: { type: 'string', description: 'Only the queue belonging to this note.' },
      confirm: { type: 'boolean', description: 'Actually write notes (with backup). Omit for a diff-only preview.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        if (args.confirm === true && !deps.allowWrites()) {
          return failedReport(root, Object.assign(new Error('writes are disabled for this vault'), { code: 'kb.writes-disabled' }));
        }
        return await applyLinks(new NodeNotesFs(root), root, {
          ...(args.queue === undefined ? {} : { queue: args.queue }),
          ...(args.note === undefined ? {} : { note: args.note }),
          ...(args.confirm === true ? { confirm: true } : {}),
        });
      } catch (error) {
        return failedReport(root, error);
      }
    },
  });
}
