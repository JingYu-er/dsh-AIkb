import type { EmbedReport } from '../application/kb-embed.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';
import type { EmbedRunnerDeps } from './embed-runner.js';
import { runEmbedPass } from './embed-runner.js';

export interface KbEmbedArgs {
  readonly vaultPath?: string;
  readonly limit?: number;
  readonly force?: boolean;
}

export type KbEmbedDeps = EmbedRunnerDeps;

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
    model: { type: 'string' },
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
          chunks: { type: 'integer', required: true },
          seconds: { type: 'number' },
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
        chunks: { type: 'integer', required: true },
        upToDate: { type: 'integer', required: true },
      },
    },
    elapsedMs: { type: 'integer', required: true },
    notes: { type: 'array', required: false, items: { type: 'string' } },
  },
};

function renderReport(report: EmbedReport): string {
  if (!report.ok) return 'kb_embed FAILED ' + (report.error?.code ?? 'unknown') + ': ' + (report.error?.message ?? '');
  const head = 'kb_embed: ' + report.totals.books + ' books / ' + report.totals.chunks + ' chunks embedded, ' +
    report.totals.upToDate + ' already up to date' + (report.model === undefined ? '' : ' (' + report.model + ')');
  const lines = [head];
  for (const book of report.books) {
    lines.push((book.error === undefined ? '  ok  ' : '  ERR ') + book.path + ' — ' + book.chunks + ' chunks' + (book.seconds === undefined ? '' : ' in ' + book.seconds.toFixed(1) + ' s') + (book.error === undefined ? '' : ': ' + book.error));
  }
  for (const note of report.notes ?? []) lines.push('note: ' + note);
  return lines.join(String.fromCharCode(10));
}

export function createKbEmbedTool(deps: KbEmbedDeps) {
  return defineTool<KbEmbedArgs, EmbedReport>({
    name: 'kb_embed',
    description:
      'Build local embeddings (intfloat/multilingual-e5-small ONNX, 384 dims) for indexed book chunks so kb_query can fuse vectors with BM25. Runs on this machine — no model API, no tokens. Incremental: books whose vector sidecar already matches the chunk count are skipped; force redoes them. Writes only under .wiki/index/vectors/.',
    parameters: {
      vaultPath: { type: 'string', description: 'Absolute vault path. Defaults to the plugin config, then vault discovery.' },
      limit: { type: 'integer', description: 'Embed at most this many books in this run (default: all pending).' },
      force: { type: 'boolean', description: 'Re-embed books even when their vectors are current.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, report) => [{ type: 'text', text: renderReport(report) }] },
    execute: (args) => runEmbedPass(deps, args),
  });
}
