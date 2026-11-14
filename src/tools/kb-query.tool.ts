import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { embedQuery } from '../adapters/embeddings/embedding.js';
import type { EmbeddingEnvReport } from '../adapters/embeddings/embedding-env.js';
import { emptyQueryReport, runQuery } from '../application/kb-query.js';
import type { QueryReport, VectorStore } from '../application/kb-query.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';

export interface KbQueryArgs {
  readonly query: string;
  readonly topK?: number;
  readonly vaultPath?: string;
}

export interface KbQueryDeps {
  readonly resolveRoot: (explicit?: string) => string;
  /** Enabled only when the embedding model has been provisioned by kb_embed. */
  readonly prepareEmbedding?: () => Promise<EmbeddingEnvReport>;
  readonly embedEnabled?: boolean;
  /** Workspace root used for the venv/temp directory; defaults to the vault root. */
  readonly workspaceRoot?: () => string;
}

const LINE_FEED = String.fromCharCode(10);
const VECTORS_DIR = '.wiki/index/vectors';
// Vector hits are semantically right but page-imprecise (a match can land in the right section
// yet 20 pages off), so they only fill the tail of the list: 1 slot for the default top-5, 2 for
// top-8. Lexical pages therefore always keep the top spots.
const VECTOR_SHARE = 0.25;

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
      properties: {
        sources: { type: 'integer', required: true },
        chunks: { type: 'integer', required: true },
        vectors: { type: 'integer' },
      },
    },
    retrieval: { type: 'string' },
    elapsedMs: { type: 'integer', required: true },
  },
};

interface VectorMeta {
  readonly model?: string;
  readonly dims?: number;
  readonly count?: number;
  readonly ids?: readonly string[];
}

/**
 * Load every stored .vec file into one contiguous buffer.
 *
 * 23k chunks x 384 dims is ~36 MB: small enough to read per query, and keeping it in one
 * Float32Array keeps the cosine loop cache-friendly.
 */
function loadVectors(root: string): VectorStore | undefined {
  const dir = nodePath.join(root, ...VECTORS_DIR.split('/'));
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return undefined;
  }
  const ids: string[] = [];
  const chunks: Float32Array[] = [];
  let dims = 0;
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(nodePath.join(dir, name), 'utf8')) as VectorMeta;
      const vecName = name.replace(/\.json$/, '.vec');
      const buffer = readFileSync(nodePath.join(dir, vecName));
      const count = meta.count ?? 0;
      const rowDims = meta.dims ?? dims;
      if (count === 0 || rowDims === 0 || !Array.isArray(meta.ids)) continue;
      if (dims === 0) dims = rowDims;
      if (rowDims !== dims) continue;
      if (buffer.byteLength !== count * rowDims * 4) continue;
      const copy = new Float32Array(count * rowDims);
      new Uint8Array(copy.buffer).set(buffer);
      ids.push(...meta.ids.slice(0, count));
      chunks.push(copy);
    } catch {
      continue;
    }
  }
  if (ids.length === 0 || dims === 0) return undefined;
  const data = new Float32Array(ids.length * dims);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return { ids, data, dims };
}

function renderReport(report: QueryReport): string {
  if (!report.ok) return 'kb_query FAILED ' + (report.error?.code ?? 'unknown') + ': ' + (report.error?.message ?? '');
  const mode = report.retrieval === 'hybrid'
    ? 'hybrid (BM25 + vectors)'
    : 'BM25' + (report.searched.vectors === undefined ? '' : ' (vectors unavailable)');
  if (report.hits.length === 0) return 'no hits for "' + report.query + '" across ' + report.searched.chunks + ' chunks (' + report.searched.sources + ' sources, ' + mode + ')';
  const lines: string[] = [];
  lines.push('query: ' + report.query + ' | ' + report.searched.chunks + ' chunks from ' + report.searched.sources + ' sources | ' + mode + ' | ' + report.elapsedMs + ' ms');
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
      'Search the compiled index (BM25 over page-scoped chunks, fused with local multilingual-e5 embeddings when kb_embed has built them) and return snippets with exact citations: vault-relative path, page and section. Read-only. The caller composes the answer; this tool never fabricates page numbers.',
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
        const vectors = deps.embedEnabled === false ? undefined : loadVectors(root);
        if (vectors === undefined || deps.prepareEmbedding === undefined) {
          return await runQuery(new NodeVaultFs(root), args.query, args.topK ?? 8);
        }
        // A failed probe (no model yet) must not break search: fall back to BM25 silently.
        const env = await deps.prepareEmbedding().catch(() => undefined);
        if (env === undefined || !env.ok || !env.modelReady) {
          return await runQuery(new NodeVaultFs(root), args.query, args.topK ?? 8);
        }
        const queryVector = await embedQuery({
          pythonPath: env.pythonPath,
          workspaceRoot: deps.workspaceRoot?.() ?? root,
          modelDir: env.modelDir,
          text: args.query,
        });
        return await runQuery(new NodeVaultFs(root), args.query, args.topK ?? 8, {
          vectors,
          vectorShare: VECTOR_SHARE,
          ...(queryVector === undefined ? {} : { queryVector }),
        });
      } catch (error) {
        return emptyQueryReport(root, args.query, error);
      }
    },
  });
}
