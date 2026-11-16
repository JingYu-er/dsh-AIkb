import { NodeNotesFs } from '../adapters/fs/notes-fs.js';
import { reviewLinks } from '../application/kb-links.js';
import type { ReviewReport } from '../application/kb-links.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbLinkReviewArgs {
  readonly vaultPath?: string;
  readonly note?: string;
  readonly write?: boolean;
  readonly limit?: number;
}

export interface KbLinkReviewDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: () => boolean;
}

const LINE_FEED = String.fromCharCode(10);
const PREVIEW_LINES = 40;

const CANDIDATE_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    toPath: { type: 'string', required: true },
    title: { type: 'string', required: true },
    confidence: { type: 'number', required: true },
    direction: { type: 'string', required: true },
    warning: { type: 'string' },
    why: { type: 'string', required: true },
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
    notes: { type: 'integer', required: true },
    candidates: { type: 'integer', required: true },
    rejected: { type: 'integer', required: true },
    written: { type: 'boolean', required: true },
    queues: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          note: { type: 'string', required: true },
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                target: { type: 'string', required: true },
                confidence: { type: 'number', required: true },
                direction: { type: 'string', required: true },
                why: { type: 'string', required: true },
                applied: { type: 'boolean', required: true },
              },
            },
          },
          candidates: { type: 'array', required: true, items: CANDIDATE_SCHEMA },
          written: { type: 'boolean', required: true },
          merged: { type: 'integer', required: true },
        },
      },
    },
    preview: { type: 'string', required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    elapsedMs: { type: 'integer', required: true },
  },
};

function renderReport(report: ReviewReport): string {
  const lines = [
    'link-review: ' + report.candidates + ' candidate(s) in ' + report.queues.length + ' queue(s) from ' + report.notes
      + ' note(s) | ' + report.rejected + ' rejected by direction | '
      + (report.written ? 'queues written' : 'dry run; pass write:true to write queues') + ' | ' + report.elapsedMs + ' ms',
  ];
  for (const warning of report.warnings) lines.push('! ' + warning);
  for (const queue of report.queues) {
    lines.push('  ' + queue.note + ' -> ' + queue.path + (queue.written ? ' (written)' : '') + ' | rows ' + queue.rows.length);
    for (const candidate of queue.candidates) {
      lines.push('    -> ' + candidate.to + ' (' + candidate.confidence.toFixed(2) + ', ' + candidate.direction + ')'
        + (candidate.why === '' ? '' : ' · ' + candidate.why));
      if (candidate.warning !== undefined) lines.push('      ! ' + candidate.warning);
    }
  }
  if (lines.length > PREVIEW_LINES) {
    lines.splice(PREVIEW_LINES, lines.length - PREVIEW_LINES, '  …');
  }
  return lines.join(LINE_FEED);
}

function failedReport(vaultRoot: string, error: unknown): ReviewReport & { error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'link-review.failed';
  return { ok: true, vaultRoot, notes: 0, candidates: 0, rejected: 0, written: false, queues: [], preview: '', warnings: [], elapsedMs: 0, error: { code, message } };
}

export function createKbLinkReviewTool(deps: KbLinkReviewDeps) {
  return defineTool<KbLinkReviewArgs, ReviewReport>({
    name: 'kb_link_review',
    description:
      'Scan notes for link candidates (reusing kb_suggest_links similarity), filter them through the SCHEMA direction rules (thought→concept/source and moc→any allowed; source→source rejected; thought→thought and concept→concept flagged; max 8 per note; confidence below 0.25 dropped), and write review queues to inbox/links/<note-slug>.md with one row per candidate and an empty why column. Never edits formal notes. write:false (default) previews the plan.',
    parameters: {
      vaultPath: { type: 'string', description: 'Override the configured vault root.' },
      note: { type: 'string', description: 'Only this note (vault-relative path or unique basename).' },
      write: { type: 'boolean', description: 'Write the queue files. Default false: preview only.' },
      limit: { type: 'integer', description: 'Write queues for at most N notes.' },
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
        return await reviewLinks(new NodeNotesFs(root), root, {
          ...(args.note === undefined ? {} : { note: args.note }),
          ...(args.write === true ? { write: true } : {}),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });
      } catch (error) {
        return failedReport(root, error);
      }
    },
  });
}
