import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { emptyQueryReport, runQuery } from '../application/kb-query.js';
import type { QueryReport } from '../application/kb-query.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';

export interface KbQueryArgs {
  readonly query: string;
  readonly topK?: number;
  readonly vaultPath?: string;
}

export interface KbQueryDeps {
  readonly resolveRoot: (explicit?: string) => string;
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
    query: { type: 'string', required: true },
    hits: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          page: { type: 'integer', required: true },
          section: { type: 'string' },
          score: { type: 'number', required: true },
          excerpt: { type: 'string', required: true },
        },
      },
    },
    searched: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: { sources: { type: 'integer', required: true }, chunks: { type: 'integer', required: true } },
    },
    elapsedMs: { type: 'integer', required: true },
  },
};

function renderReport(report: QueryReport): string {
  if (!report.ok) return 'kb_query FAILED ' + (report.error?.code ?? 'unknown') + ': ' + (report.error?.message ?? '');
  if (report.hits.length === 0) return 'no hits for "' + report.query + '" across ' + report.searched.chunks + ' chunks (' + report.searched.sources + ' sources)';
  const lines: string[] = [];
  lines.push('query: ' + report.query + ' | ' + report.searched.chunks + ' chunks from ' + report.searched.sources + ' sources | ' + report.elapsedMs + ' ms');
  report.hits.forEach((hit, index) => {
    lines.push('[' + (index + 1) + '] ' + hit.path + ' p.' + hit.page + (hit.section ? ' §' + hit.section : '') + ' (' + hit.score + ')');
    lines.push(hit.excerpt.replace(/\s+/g, ' '));
  });
  return lines.join(LINE_FEED);
}

export function createKbQueryTool(deps: KbQueryDeps) {
  return defineTool<KbQueryArgs, QueryReport>({
    name: 'kb_query',
    description:
      'Search the compiled index (BM25 over page-scoped chunks) and return snippets with exact citations: vault-relative path, page and section. Read-only. The caller composes the answer; this tool never fabricates page numbers.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language question or keywords (Chinese or English).' },
      topK: { type: 'integer', description: 'Maximum number of snippets (default 8).' },
      vaultPath: { type: 'string', description: 'Absolute vault path. Defaults to the plugin config, then vault discovery.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, report) => [{ type: 'text', text: renderReport(report) }] },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        return await runQuery(new NodeVaultFs(root), args.query, args.topK ?? 8);
      } catch (error) {
        return emptyQueryReport(root, args.query, error);
      }
    },
  });
}
