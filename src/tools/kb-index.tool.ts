import { NodeNotesFs } from '../adapters/fs/notes-fs.js';
import { runIndex } from '../application/kb-index.js';
import type { IndexReport } from '../application/kb-index.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbIndexArgs {
  readonly vaultPath?: string;
  readonly write?: boolean;
}

export interface KbIndexDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: () => boolean;
}

const LINE_FEED = String.fromCharCode(10);
const PREVIEW_LINES = 24;

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
    written: { type: 'boolean', required: true },
    index: { type: 'string', required: true },
    stats: { type: 'json', required: true },
    preview: { type: 'string', required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    elapsedMs: { type: 'integer', required: true },
  },
};

function renderReport(report: IndexReport): string {
  const stats = report.stats;
  const byType = Object.entries(stats.byType).map(([type, count]) => type + ' ' + count).join(' · ');
  const lines = [
    'index: ' + stats.notes + ' note(s) in ' + report.vaultRoot + ' | ' + byType + ' | orphans ' + stats.orphans
      + ' · broken links ' + stats.brokenLinks + ' · untyped ' + stats.untyped + (report.written ? ' | written ' + report.index : ' | preview only')
      + ' | ' + report.elapsedMs + ' ms',
  ];
  for (const warning of report.warnings) lines.push('! ' + warning);
  const preview = report.preview.split(LINE_FEED);
  for (const line of preview.slice(0, PREVIEW_LINES)) lines.push('  ' + line);
  if (preview.length > PREVIEW_LINES) lines.push('  …');
  return lines.join(LINE_FEED);
}

function failedReport(vaultRoot: string, error: unknown): IndexReport & { error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'index.failed';
  return {
    ok: true,
    vaultRoot,
    written: false,
    index: 'index.md',
    stats: { notes: 0, byType: { concept: 0, thought: 0, source: 0, reference: 0, log: 0, moc: 0, draft: 0, unknown: 0 }, orphans: 0, brokenLinks: 0, untyped: 0, inbox: 0 },
    preview: '',
    warnings: [],
    elapsedMs: 0,
    error: { code, message },
  };
}

export function createKbIndexTool(deps: KbIndexDeps) {
  return defineTool<KbIndexArgs, IndexReport>({
    name: 'kb_index',
    description:
      'Build the deterministic vault catalog: scan every markdown note (skipping dot dirs, node_modules and inbox/_compiled), parse frontmatter type/title/tags/status and [[wikilinks]], count inbound/outbound links, and render index.md grouped by type with per-type stats, recent changes, orphan pages and untyped notes. write:false (default) returns a preview; write:true writes index.md and appends one log.md line.',
    parameters: {
      vaultPath: { type: 'string', description: 'Override the configured vault root.' },
      write: { type: 'boolean', description: 'Write index.md (and one log.md line). Default false: preview only.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        if (args.write === true && !deps.allowWrites()) {
          return failedReport(root, Object.assign(new Error('writes are disabled for this vault'), { code: 'kb.writes-disabled' }));
        }
        return await runIndex(new NodeNotesFs(root), root, args.write === true ? { write: true } : {});
      } catch (error) {
        return failedReport(root, error);
      }
    },
  });
}
