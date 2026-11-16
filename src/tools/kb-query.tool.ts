import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { embedQuery } from '../adapters/embeddings/embedding.js';
import type { EmbeddingEnvReport } from '../adapters/embeddings/embedding-env.js';
import { rerankPassages } from '../adapters/embeddings/rerank.js';
import type { RerankEnvReport } from '../adapters/embeddings/rerank-env.js';
import { emptyQueryReport, runQuery } from '../application/kb-query.js';
import type { QueryReport, VectorStore } from '../application/kb-query.js';
import { GLOSSARY_PATH, expansionEntries, parseGlossary } from '../application/glossary-store.js';
import type { GlossaryEntry } from '../domain/glossary.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';

export interface KbQueryArgs {
  readonly query: string;
  readonly topK?: number;
  readonly vaultPath?: string;
  /** Return the page or section text around each hit; off by default. */
  readonly expand?: 'none' | 'page' | 'section';
  readonly maxContextChars?: number;
  /** Reorder candidates with the local cross-encoder (default from config; off unless provisioned). */
  readonly rerank?: boolean;
  /** 0..1 weight of the lexical rank in the reranked score (default 0.3). */
  readonly rerankBlend?: number;
  /** Extra phrasings of the same question; each is searched on its own and the lists are fused by rank. */
  readonly queries?: readonly string[];
}

/**
 * Bilingual pairs harvested while ingesting this vault. Read once per query: the file is a few
 * hundred KB at most, and a missing file simply means "no vocabulary learned yet".
 */
function loadVaultGlossary(root: string): GlossaryEntry[] {
  try {
    const text = readFileSync(nodePath.join(root, ...GLOSSARY_PATH.split('/')), 'utf8');
    return expansionEntries(parseGlossary(text));
  } catch {
    return [];
  }
}

export interface KbQueryDeps {
  readonly resolveRoot: (explicit?: string) => string;
  /** Enabled only when the embedding model has been provisioned by kb_embed. */
  readonly prepareEmbedding?: () => Promise<EmbeddingEnvReport>;
  readonly embedEnabled?: boolean;
  /** Workspace root used for the venv/temp directory; defaults to the vault root. */
  readonly workspaceRoot?: () => string;
  /** Widen queries with the vault's harvested bilingual pairs. Off by default: measured neutral. */
  readonly glossaryExpansion?: boolean;
  /** Present only when kb_query may rerank; absent keeps the tool on BM25/vectors. */
  readonly prepareRerank?: () => Promise<RerankEnvReport>;
  /** Rerank every query without the caller asking. Off by default: it costs ~1-3 s per query. */
  readonly rerankDefault?: boolean;
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
          pageStart: { type: 'integer' },
          pageEnd: { type: 'integer' },
          section: { type: 'string' },
          score: { type: 'number', required: true },
          excerpt: { type: 'string', required: true },
          context: { type: 'string' },
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
        families: { type: 'integer' },
        queries: { type: 'integer' },
      },
    },
    retrieval: { type: 'string' },
    reranked: { type: 'boolean' },
    coverage: { type: 'number' },
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
  const mode = (report.retrieval === 'hybrid'
    ? 'hybrid (BM25 + vectors)'
    : 'BM25' + (report.searched.vectors === undefined ? '' : ' (vectors unavailable)'))
    + (report.reranked === true ? ' + rerank' : '')
    + (report.searched.queries === undefined ? '' : ' + fused(' + report.searched.queries + ' phrasings)');
  if (report.hits.length === 0) return 'no hits for "' + report.query + '" across ' + report.searched.chunks + ' chunks (' + report.searched.sources + ' sources, ' + mode + ')';
  const lines: string[] = [];
  const coverage = report.coverage === undefined ? '' : ' | coverage ' + report.coverage.toFixed(2);
  lines.push('query: ' + report.query + ' | ' + report.searched.chunks + ' chunks from ' + report.searched.sources + ' sources | ' + mode + coverage + ' | ' + report.elapsedMs + ' ms');
  report.hits.forEach((hit, index) => {
    const from = hit.pageStart ?? hit.page;
    const pages = hit.pageEnd === undefined || hit.pageEnd <= from ? ' p.' + from : ' p.' + from + '-' + hit.pageEnd;
    lines.push('[' + (index + 1) + '] ' + hit.path + pages + (hit.section ? ' §' + hit.section : '') + ' (' + hit.score + ')');
    lines.push(hit.excerpt.replace(/\s+/g, ' '));
    if (hit.context !== undefined && hit.context !== '') lines.push('--- context ---' + LINE_FEED + hit.context);
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
      expand: {
        type: 'string',
        enum: ['none', 'page', 'section'],
        description: 'Also return the surrounding page or the whole section for each hit (default none). Each hit carries the text in context; keep maxContextChars small.',
      },
      maxContextChars: { type: 'integer', description: 'Cap on context characters per hit (default 3000).' },
      rerank: {
        type: 'boolean',
        description: 'Reorder the candidate pool with the local cross-encoder (bge-reranker-base). Slower (~1-3 s) but fixes page drift. Defaults to the plugin config.',
      },
      rerankBlend: {
        type: 'number',
        description: 'How much of the lexical rank to keep in the reranked score, 0..1 (default 0.3). Raise it when the cross-encoder collapses a multi-page topic onto one page; 0 is a pure cross-encoder sort.',
      },
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional extra phrasings of the same question (Chinese, English, an abbreviation, a device name). Each is searched separately and the results are fused by rank, so one bad phrasing cannot win; prefer this over calling kb_query twice. Up to 5 extra (6 total).',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, report) => [{ type: 'text', text: renderReport(report) }] },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        const workspaceRoot = deps.workspaceRoot?.() ?? root;
        // Reranking never blocks search: a missing model or a timed-out process leaves the
        // lexical order untouched, and the hit list simply reports reranked: false.
        const wantRerank = args.rerank ?? deps.rerankDefault === true;
        let rerank: ((documents: readonly string[]) => Promise<readonly number[] | undefined>) | undefined;
        if (wantRerank && deps.prepareRerank !== undefined) {
          const rerankReady = await deps.prepareRerank().catch(() => undefined);
          if (rerankReady !== undefined && rerankReady.ok && rerankReady.modelReady) {
            rerank = async (documents) => {
              const result = await rerankPassages({
                pythonPath: rerankReady.pythonPath,
                workspaceRoot,
                modelDir: rerankReady.modelDir,
                query: args.query,
                documents,
              }).catch(() => undefined);
              return result !== undefined && result.ok ? result.scores : undefined;
            };
          }
        }
        // Rank fusion needs each phrasing spelled out; blank entries and duplicates are dropped in
        // runQuery, and more than six variants only dilute the vote.
        const extraQueries = (args.queries ?? [])
          .map((text) => text.trim())
          .filter((text) => text !== '')
          .slice(0, 5);
        const window = {
          glossary: deps.glossaryExpansion === true ? loadVaultGlossary(root) : [],
          ...(args.expand === undefined ? {} : { expand: args.expand }),
          ...(args.maxContextChars === undefined ? {} : { maxContextChars: args.maxContextChars }),
          ...(rerank === undefined ? {} : { rerank }),
          ...(args.rerankBlend === undefined ? {} : { rerankBlend: args.rerankBlend }),
          ...(extraQueries.length === 0 ? {} : { queries: extraQueries }),
        };
        // Reranking supersedes the vector tail slots: the cross-encoder compares the query with each
        // passage directly, so spending 1-2 s on a query embedding and then ignoring its hits is waste.
        if (rerank !== undefined) {
          return await runQuery(new NodeVaultFs(root), args.query, args.topK ?? 8, window);
        }
        // A fused list is built from full questions and already fills every slot, so the vector
        // tail would only displace better-ranked pages; skip the query embedding entirely.
        if (extraQueries.length > 0) {
          return await runQuery(new NodeVaultFs(root), args.query, args.topK ?? 8, window);
        }
        const vectors = deps.embedEnabled === false ? undefined : loadVectors(root);
        if (vectors === undefined || deps.prepareEmbedding === undefined) {
          return await runQuery(new NodeVaultFs(root), args.query, args.topK ?? 8, window);
        }
        // A failed probe (no model yet) must not break search: fall back to BM25 silently.
        const env = await deps.prepareEmbedding().catch(() => undefined);
        if (env === undefined || !env.ok || !env.modelReady) {
          return await runQuery(new NodeVaultFs(root), args.query, args.topK ?? 8, window);
        }
        const queryVector = await embedQuery({
          pythonPath: env.pythonPath,
          workspaceRoot,
          modelDir: env.modelDir,
          text: args.query,
        });
        return await runQuery(new NodeVaultFs(root), args.query, args.topK ?? 8, {
          ...window,
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
