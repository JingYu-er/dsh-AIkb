import {
  captureHistory,
  listHistory,
  readHistoryEntry,
  restoreHistory,
} from '../application/vault-history.js';
import type { HistoryEntry } from '../application/vault-history.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbHistoryArgs {
  readonly action?: 'list' | 'read' | 'restore';
  readonly note?: string;
  readonly stamp?: string;
  readonly vaultPath?: string;
}

export interface KbHistoryDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: () => boolean;
}

export interface KbHistoryReport {
  readonly ok: boolean;
  readonly action: string;
  readonly note: string;
  readonly root: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly entries: readonly HistoryEntry[];
  readonly text?: string;
  readonly bytes?: number;
  readonly restored?: { readonly path: string; readonly bytes: number };
}

const LINE_FEED = String.fromCharCode(10);

const OUTPUT_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    action: { type: 'string', required: true },
    note: { type: 'string', required: true },
    root: { type: 'string', required: true },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    entries: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stamp: { type: 'string', required: true },
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
    },
    text: { type: 'string' },
    bytes: { type: 'integer' },
    restored: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
      },
    },
  },
};

function renderReport(report: KbHistoryReport): string {
  if (!report.ok && report.error !== undefined) {
    return 'kb_history refused [' + report.error.code + '] ' + report.error.message;
  }
  if (report.action === 'read') {
    return 'history: ' + report.note + ' @ ' + String(report.bytes ?? 0) + ' B' + LINE_FEED + (report.text ?? '');
  }
  if (report.action === 'restore') {
    return 'restored: ' + report.note + ' <- ' + String(report.restored?.path ?? '') + ' (' + String(report.restored?.bytes ?? 0) + ' B)';
  }
  const lines = [report.note + ': ' + report.entries.length + ' version(s) under ' + report.root];
  for (const entry of report.entries) lines.push('  ' + entry.stamp + ' (' + entry.bytes + ' B)');
  return lines.join(LINE_FEED);
}

export function createKbHistoryTool(deps: KbHistoryDeps) {
  return defineTool<KbHistoryArgs, KbHistoryReport>({
    name: 'kb_history',
    description:
      'Version history for one note: every save through the KB panel keeps a copy under <vault>/.dsh-aikb/history, newest last. list shows the versions, read returns one, restore puts it back and first captures the text it overwrites. Nothing is deleted except the oldest copies past the per-note limit.',
    parameters: {
      action: { type: 'string', enum: ['list', 'read', 'restore'], description: 'Default list.' },
      note: { type: 'string', description: 'Vault-relative POSIX path of the note, for example "学习/note.md".' },
      stamp: { type: 'string', description: 'read and restore: the version stamp from list.' },
      vaultPath: { type: 'string', description: 'Absolute vault path. Defaults to the plugin config, then the nearest ancestor directory containing .obsidian.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      const action = args.action ?? 'list';
      const note = String(args.note ?? '').trim();
      const root = deps.resolveRoot(args.vaultPath);
      if (note === '') {
        return { ok: false, action, note, root, entries: [], error: { code: 'kb.history.invalid-note', message: 'note is required: pass the vault-relative path' } };
      }
      if (action === 'read') {
        const entry = await readHistoryEntry(root, note, String(args.stamp ?? ''));
        if (!entry.ok) return { ok: false, action, note, root, entries: [], error: entry.error };
        return { ok: true, action, note, root, entries: [], text: entry.text ?? '', bytes: Buffer.byteLength(entry.text ?? '', 'utf8') };
      }
      if (action === 'restore') {
        if (!deps.allowWrites()) {
          return { ok: false, action, note, root, entries: [], error: { code: 'kb.history.read-only', message: 'Writes are disabled; enable allowWrites in the KB settings page.' } };
        }
        const restored = await restoreHistory(root, note, String(args.stamp ?? ''), { allowWrites: true });
        if (!restored.ok || restored.path === undefined) {
          return { ok: false, action, note, root, entries: [], error: restored.error ?? { code: 'kb.history.write-failed', message: 'restore failed' } };
        }
        return { ok: true, action, note, root, entries: [], restored: { path: restored.path, bytes: restored.bytes ?? 0 } };
      }
      const report = await listHistory(root, note);
      return { ok: true, action: 'list', note, root, entries: report.entries };
    },
  });
}

/** Kept for callers that only need to snapshot a note before a write. */
export { captureHistory };
