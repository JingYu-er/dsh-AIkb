import { join } from 'node:path';
import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { NodeVaultWriter } from '../adapters/fs/node-vault-writer.js';
import { extractPdf } from '../adapters/pdf/pymupdf.js';
import { emptyIngestReport, runIngest } from '../application/kb-ingest.js';
import type { IngestReport } from '../application/kb-ingest.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';

export interface KbIngestArgs {
  readonly vaultPath?: string;
  readonly limit?: number;
  readonly pathPrefix?: string;
  readonly force?: boolean;
}

export interface KbIngestDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: boolean;
  readonly pythonPath: string;
  readonly pythonLibPath: string;
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
    books: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          sha256: { type: 'string', required: true },
          pages: { type: 'integer', required: true },
          chunks: { type: 'integer', required: true },
          tokens: { type: 'integer', required: true },
          skipped: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
    },
    totals: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        books: { type: 'integer', required: true },
        pages: { type: 'integer', required: true },
        chunks: { type: 'integer', required: true },
        tokens: { type: 'integer', required: true },
      },
    },
    elapsedMs: { type: 'integer', required: true },
  },
};

function renderReport(report: IngestReport): string {
  if (!report.ok) return 'kb_ingest FAILED ' + (report.error?.code ?? 'unknown') + ': ' + (report.error?.message ?? '');
  const lines: string[] = [];
  lines.push('ingested ' + report.totals.books + ' book(s): ' + report.totals.pages + ' pages, ' + report.totals.chunks + ' chunks, ~' + report.totals.tokens + ' tokens');
  for (const book of report.books.slice(0, 10)) {
    if (book.error !== undefined) lines.push('FAILED ' + book.path + ': ' + book.error);
    else if (book.skipped) lines.push('skip (indexed) ' + book.path);
    else lines.push('ok ' + book.path + ' -> ' + book.pages + 'p/' + book.chunks + ' chunks');
  }
  if (report.books.length > 10) lines.push('... ' + (report.books.length - 10) + ' more');
  lines.push('elapsed: ' + report.elapsedMs + ' ms');
  return lines.join(LINE_FEED);
}

export function createKbIngestTool(deps: KbIngestDeps) {
  return defineTool<KbIngestArgs, IngestReport>({
    name: 'kb_ingest',
    description:
      'Compile selected PDF sources into the search index: extract page text with PyMuPDF, cut page-scoped chunks (never crossing a page), and write .wiki/index/<sha256>.jsonl plus the catalog. Incremental by content hash; requires writes enabled. Sources are cited by path + page, never copied into notes.',
    parameters: {
      vaultPath: { type: 'string', description: 'Absolute vault path. Defaults to the plugin config, then vault discovery.' },
      limit: { type: 'integer', description: 'Ingest at most this many sources from the manifest.' },
      pathPrefix: { type: 'string', description: 'Only sources whose vault-relative path starts with this prefix.' },
      force: { type: 'boolean', description: 'Re-extract even when a chunk file for the same content hash exists.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, report) => [{ type: 'text', text: renderReport(report) }] },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        if (!deps.allowWrites) throw new Error('kb.writes-disabled: enable allowWrites in the plugin config to write the index');
        const vaultFs = new NodeVaultFs(root);
        const writer = new NodeVaultWriter(root);
        const fs = {
          root,
          exists: (relPath: string) => vaultFs.exists(relPath),
          readText: (relPath: string) => vaultFs.readText(relPath),
          writeText: (relPath: string, content: string) => writer.writeText(relPath, content),
        };
        return await runIngest(
          fs,
          (entry) => extractPdf(join(root, entry.path.split('/').join(process.platform === 'win32' ? '\\' : '/')), {
            pythonPath: deps.pythonPath,
            pythonLibPath: deps.pythonLibPath,
          }),
          { limit: args.limit, pathPrefix: args.pathPrefix, force: args.force },
        );
      } catch (error) {
        return emptyIngestReport(root, error);
      }
    },
  });
}
