import { appendFeedback, markFeedbackDone, readFeedback } from '../application/vault-feedback.js';
import type { FeedbackRow } from '../application/vault-feedback.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbFeedbackArgs {
  readonly action?: 'list' | 'add' | 'done';
  readonly note?: string;
  readonly text?: string;
  readonly index?: number;
  readonly vaultPath?: string;
}

export interface KbFeedbackDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: () => boolean;
}

export interface KbFeedbackReport {
  readonly ok: boolean;
  readonly action: string;
  readonly path: string;
  readonly note: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly rows: readonly FeedbackRow[];
  readonly index?: number;
}

const LINE_FEED = String.fromCharCode(10);

const ROW_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true },
    done: { type: 'boolean', required: true },
    at: { type: 'string', required: true },
    note: { type: 'string', required: true },
    text: { type: 'string', required: true },
  },
};

const OUTPUT_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    action: { type: 'string', required: true },
    path: { type: 'string', required: true },
    note: { type: 'string', required: true },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    rows: { type: 'array', items: ROW_SCHEMA, required: true },
    index: { type: 'integer' },
  },
};

function renderReport(report: KbFeedbackReport): string {
  if (!report.ok && report.error !== undefined) return 'kb_feedback refused [' + report.error.code + '] ' + report.error.message;
  if (report.action === 'add') return 'feedback added: ' + report.path + ' row ' + String(report.index ?? 0);
  if (report.action === 'done') return 'feedback row ' + String(report.index ?? 0) + ' marked done';
  const open = report.rows.filter((row) => !row.done).length;
  const lines = [report.path + ': ' + report.rows.length + ' row(s), ' + open + ' open'];
  for (const row of report.rows) {
    lines.push('  [' + (row.done ? 'x' : ' ') + '] ' + row.index + ' ' + row.at + ' ' + row.note + ' — ' + row.text);
  }
  return lines.join(LINE_FEED);
}

export function createKbFeedbackTool(deps: KbFeedbackDeps) {
  return defineTool<KbFeedbackArgs, KbFeedbackReport>({
    name: 'kb_feedback',
    description:
      'Page feedback queue (inbox/feedback.md): list rows, append one for a note, or mark a row done. A row is a dated line with the note path and what the reader found wrong, so a later pass can fix the page and check the box. Rows are never deleted.',
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'done'], description: 'Default list.' },
      note: { type: 'string', description: 'add: vault-relative POSIX path of the page the feedback is about.' },
      text: { type: 'string', description: 'add: what is wrong or missing (2000 bytes max).' },
      index: { type: 'integer', description: 'done: the row index from list.' },
      vaultPath: { type: 'string', description: 'Absolute vault path. Defaults to the plugin config, then the nearest ancestor directory containing .obsidian.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      const action = args.action ?? 'list';
      const root = deps.resolveRoot(args.vaultPath);
      const note = String(args.note ?? '').trim();
      if (action === 'add') {
        const written = await appendFeedback(root, { note, text: String(args.text ?? '') }, { allowWrites: deps.allowWrites() });
        if (!written.ok) return { ok: false, action, path: written.path, note, rows: [], error: written.error };
        const report = await readFeedback(root);
        return { ok: true, action, path: report.path, note, rows: report.rows, index: written.index ?? 0 };
      }
      if (action === 'done') {
        const index = typeof args.index === 'number' ? args.index : -1;
        const marked = await markFeedbackDone(root, index, { allowWrites: deps.allowWrites() });
        if (!marked.ok) return { ok: false, action, path: marked.path, note, rows: [], error: marked.error };
        const report = await readFeedback(root);
        return { ok: true, action, path: report.path, note, rows: report.rows, index };
      }
      const report = await readFeedback(root);
      return { ok: true, action: 'list', path: report.path, note, rows: report.rows };
    },
  });
}