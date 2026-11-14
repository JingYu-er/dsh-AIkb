import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { NodeVaultWriter } from '../adapters/fs/node-vault-writer.js';
import { BOOK_MANIFEST_PATH, emptyInventoryReport, runInventory } from '../application/kb-inventory.js';
import type { InventoryReport } from '../application/kb-inventory.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';

export interface KbInventoryArgs {
  readonly vaultPath?: string;
  readonly write?: boolean;
  readonly limit?: number;
}

export interface KbInventoryDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: boolean;
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
      properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
    },
    vaultRoot: { type: 'string', required: true },
    manifestPath: { type: 'string', required: true },
    written: { type: 'boolean', required: true },
    totals: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        files: { type: 'integer', required: true },
        bytes: { type: 'integer', required: true },
        byFormat: { type: 'json', required: true },
      },
    },
    entries: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          format: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          sha256: { type: 'string', required: true },
          modifiedAt: { type: 'string', required: true },
        },
      },
    },
    skipped: { type: 'array', required: true, items: { type: 'string' } },
    elapsedMs: { type: 'integer', required: true },
  },
};

function renderReport(report: InventoryReport): string {
  if (!report.ok) {
    return 'kb_inventory FAILED ' + (report.error?.code ?? 'unknown') + ': ' + (report.error?.message ?? '');
  }
  const formats = Object.entries(report.totals.byFormat)
    .map(([format, count]) => format + '=' + count)
    .join(' ');
  const lines: string[] = [];
  lines.push('sources: ' + report.totals.files + ' files, ' + Math.round(report.totals.bytes / 1048576) + ' MiB (' + formats + ')');
  lines.push('manifest: ' + report.manifestPath + (report.written ? ' written' : ' not written (dry run)'));
  lines.push('elapsed: ' + report.elapsedMs + ' ms');
  if (report.skipped.length > 0) lines.push('skipped: ' + report.skipped.length + ' (limit reached)');
  const preview = report.entries.slice(0, 3);
  for (const entry of preview) {
    lines.push('- ' + entry.path + ' sha256=' + entry.sha256.slice(0, 12) + '... ' + Math.round(entry.bytes / 1024) + ' KiB');
  }
  if (report.entries.length > preview.length) lines.push('... ' + (report.entries.length - preview.length) + ' more');
  return lines.join(LINE_FEED);
}

export function createKbInventoryTool(deps: KbInventoryDeps) {
  return defineTool<KbInventoryArgs, InventoryReport>({
    name: 'kb_inventory',
    description:
      'Build or refresh the source inventory: hash every PDF/EPUB/Markdown source, record its size and mtime, and optionally write .wiki/books.jsonl. Incremental ingestion and provenance both depend on this manifest. Sources are referenced by path and sha256, never copied.',
    parameters: {
      vaultPath: { type: 'string', description: 'Absolute vault path. Defaults to the plugin config, then vault discovery.' },
      write: { type: 'boolean', description: 'Write the manifest to .wiki/books.jsonl. Requires writes to be enabled; default false (dry run).' },
      limit: { type: 'integer', description: 'Hash at most this many sources (useful for a first smoke run).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        if (args.write === true && !deps.allowWrites) {
          throw new Error('kb.writes-disabled: enable allowWrites in the plugin config to write .wiki/books.jsonl');
        }
        const vaultFs = new NodeVaultFs(root);
        const writer = args.write === true ? new NodeVaultWriter(root) : undefined;
        return await runInventory(vaultFs, { write: args.write === true, writer, limit: args.limit });
      } catch (error) {
        return emptyInventoryReport(root, error, BOOK_MANIFEST_PATH);
      }
    },
  });
}
