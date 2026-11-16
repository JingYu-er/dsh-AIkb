import { NodeNotesFs } from '../adapters/fs/notes-fs.js';
import { reviewNotes } from '../application/kb-review.js';
import type { ReviewRunReport } from '../application/kb-review.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbReviewArgs {
  readonly vaultPath?: string;
  readonly note?: string;
  readonly write?: boolean;
  readonly limit?: number;
}

export interface KbReviewDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: () => boolean;
}

const LINE_FEED = String.fromCharCode(10);
const PREVIEW_LINES = 40;

const ROW_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    oldPath: { type: 'string', required: true },
    oldName: { type: 'string', required: true },
    score: { type: 'number', required: true },
    oldText: { type: 'string', required: true },
    newText: { type: 'string', required: true },
    verdict: { type: 'string', required: true },
    basis: { type: 'string', required: true },
  },
};

const CANDIDATE_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    name: { type: 'string', required: true },
    score: { type: 'number', required: true },
    statements: { type: 'integer', required: true },
    pairs: { type: 'integer', required: true },
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
    pending: { type: 'integer', required: true },
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
          candidates: { type: 'array', required: true, items: CANDIDATE_SCHEMA },
          rows: { type: 'array', required: true, items: ROW_SCHEMA },
          pending: { type: 'integer', required: true },
          written: { type: 'boolean', required: true },
          merged: { type: 'integer', required: true },
          added: { type: 'integer', required: true },
          removed: { type: 'integer', required: true },
          deleted: { type: 'boolean', required: true },
          skipped: { type: 'string' },
        },
      },
    },
    preview: { type: 'string', required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    elapsedMs: { type: 'integer', required: true },
  },
};

function renderReport(report: ReviewRunReport): string {
  const lines = [
    'review: ' + report.queues.length + ' queue(s) from ' + report.notes + ' note(s) | ' + report.pending
      + ' pending verdict(s) | ' + (report.written ? 'queues written' : 'dry run; pass write:true to write queues')
      + ' | ' + report.elapsedMs + ' ms',
  ];
  for (const warning of report.warnings) lines.push('! ' + warning);
  for (const queue of report.queues) {
    lines.push('  ' + queue.note + ' -> ' + queue.path + (queue.deleted ? ' (deleted)' : queue.written ? ' (written)' : '')
      + (queue.skipped === undefined ? '' : ' [' + queue.skipped + ']')
      + ' | rows ' + queue.rows.length + ', pending ' + queue.pending
      + (queue.removed > 0 ? ', dropped ' + queue.removed + ' noise row(s)' : ''));
    for (const candidate of queue.candidates) {
      lines.push('    ~ ' + candidate.name + ' (' + candidate.score.toFixed(3) + ', +' + candidate.pairs + ' pair(s))');
    }
  }
  if (lines.length > PREVIEW_LINES) {
    lines.splice(PREVIEW_LINES, lines.length - PREVIEW_LINES, '  …');
  }
  return lines.join(LINE_FEED);
}

function failedReport(vaultRoot: string, error: unknown): ReviewRunReport & { error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'review.failed';
  return {
    ok: true,
    vaultRoot,
    notes: 0,
    pending: 0,
    written: false,
    queues: [],
    preview: '',
    warnings: [],
    elapsedMs: 0,
    error: { code, message },
  };
}

export function createKbReviewTool(deps: KbReviewDeps) {
  return defineTool<KbReviewArgs, ReviewRunReport>({
    name: 'kb_review',
    description:
      'Detect contradiction candidates without editing anything: for one note (or the 5 most recently modified formal notes), rank the 3 most similar notes, extract the 2–3 claim-like statements from each, and write/merge review tables under inbox/review/<note-slug>.md with an empty 判定 column (冲突 / 细化 / 无关). Notes whose type is link or moc are steps/navigation and never get new candidates; merging keeps every filled verdict and drops only unfilled non-claim rows (a queue emptied that way is deleted). write:false (default) previews candidate counts and paths; formal notes are never modified.',
    parameters: {
      vaultPath: { type: 'string', description: 'Override the configured vault root.' },
      note: { type: 'string', description: 'Only this note (vault-relative path or basename). Omit to review the most recently modified 5 formal notes.' },
      write: { type: 'boolean', description: 'Write the review queue files. Default false: preview only.' },
      limit: { type: 'integer', description: 'Review at most N recent notes when note is omitted.' },
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
        return await reviewNotes(new NodeNotesFs(root), root, {
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
