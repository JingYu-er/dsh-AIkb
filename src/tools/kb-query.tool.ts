import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { embedQuery } from '../adapters/embeddings/embedding.js';
import type { EmbeddingEnvReport } from '../adapters/embeddings/embedding-env.js';
import { rerankPassages } from '../adapters/embeddings/rerank.js';
import type { RerankEnvReport } from '../adapters/embeddings/rerank-env.js';
import { emptyQueryReport, runQuery } from '../application/kb-query.js';
import { ensureNoteVectors } from '../application/notes-vectors.js';
import type { NoteVectors } from '../application/notes-layer.js';
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
  /** Also search the vault's markdown notes at query time and merge them in as kind: 'note'. Off by default. */
  readonly notesLayer?: boolean;
  /** How many note hits the notes layer contributes (default 5). */
  readonly notesLimit?: number;
  /** Weight note titles 3x and headings 2x, body 1x (default true). */
  readonly notesWeight?: boolean;
  /** Multiplier for sprawling notes (>20k body chars or >40 wikilinks); 0.5 default, 0 disables. */
  readonly notesHubPenalty?: number;
  /** Also embed the note blocks and mix 0.4 cosine into the note score (default false; costs CPU). */
  readonly notesEmbed?: boolean;
  /** Reorder the note candidates with the local cross-encoder (default false; ~1 s per query). */
  readonly notesRerank?: boolean;
  /** 0..1 weight of the lexical note score in the reranked note score (default 0.3). */
  readonly notesRerankBlend?: number;
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

const STAGE_SCHEMA: SchemaNode = {
  type: 'object',
  required: true,
  additionalProperties: false,
  properties: {
    ran: { type: 'boolean', required: true },
    candidates: { type: 'integer', required: true },
    ms: { type: 'integer', required: true },
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
          kind: { type: 'string' },
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
    notes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hits: { type: 'integer', required: true },
        weight: { type: 'boolean', required: true },
        hubPenalty: { type: 'number', required: true },
        embed: { type: 'boolean', required: true },
        rerank: { type: 'boolean', required: true },
      },
    },
    elapsedMs: { type: 'integer', required: true },
    trace: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        query: { type: 'string', required: true },
        queries: { type: 'integer', required: true },
        stages: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            lexical: STAGE_SCHEMA,
            vector: STAGE_SCHEMA,
            rerank: STAGE_SCHEMA,
          },
        },
        noHitReason: {
          type: 'string',
          enum: ['empty-index', 'no-term-match', 'below-threshold', 'reranked-out'],
        },
        elapsedMs: { type: 'integer', required: true },
      },
    },
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
  if (report.hits.length === 0) {
    const reason = report.trace.noHitReason === undefined ? '' : ' | reason ' + report.trace.noHitReason;
    return 'no hits for "' + report.query + '" across ' + report.searched.chunks + ' chunks (' + report.searched.sources + ' sources, ' + mode + ')' + reason;
  }
  const lines: string[] = [];
  const coverage = report.coverage === undefined ? '' : ' | coverage ' + report.coverage.toFixed(2);
  const notesMode = report.notes === undefined
    ? ''
    : ' | notes ' + report.notes.hits
      + (report.notes.weight ? ' weighted' : ' flat')
      + (report.notes.hubPenalty === 0 ? '' : ' hub x' + report.notes.hubPenalty)
      + (report.notes.embed ? ' + vectors' : '')
      + (report.notes.rerank ? ' + rerank' : '');
  lines.push('query: ' + report.query + ' | ' + report.searched.chunks + ' chunks from ' + report.searched.sources + ' sources | ' + mode + coverage + notesMode + ' | ' + report.elapsedMs + ' ms');
  report.hits.forEach((hit, index) => {
    const from = hit.pageStart ?? hit.page;
    const pages = hit.pageEnd === undefined || hit.pageEnd <= from ? ' p.' + from : ' p.' + from + '-' + hit.pageEnd;
    lines.push('[' + (index + 1) + '] ' + hit.path + pages + (hit.section ? ' §' + hit.section : '') + (hit.kind === 'note' ? ' (note)' : '') + ' (' + hit.score + ')');
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
      notesLayer: {
        type: 'boolean',
        description: "Also search the vault's markdown notes (frontmatter stripped, one chunk per heading) with BM25 and merge the matches into the hit list as kind: 'note'. Books keep their own ranking; notes interleave by normalised score. Off by default: the compiled PDF/EPUB index is unchanged.",
      },
      notesLimit: {
        type: 'integer',
        description: 'How many note hits the notes layer contributes (default 5). Only used when notesLayer is true.',
      },
      notesWeight: {
        type: 'boolean',
        description: 'Rank note titles (filename + frontmatter title/aliases/tags) 3x, headings 2x and body 1x instead of treating the whole chunk as flat text. On by default: it is what makes a title-only note findable.',
      },
      notesHubPenalty: {
        type: 'number',
        description: 'Multiplier applied to sprawling notes (body over 20k characters or more than 40 wikilinks). Default 0.5. Set 0 to disable: a big root note otherwise wins on term frequency alone.',
      },
      notesEmbed: {
        type: 'boolean',
        description: 'Embed the note blocks with the local e5 model and mix 0.4 x cosine with 0.6 x normalised BM25 (vectors cached under .wiki/index/notes-vectors.*). Off by default: matrix build costs CPU and a Python process.',
      },
      notesRerank: {
        type: 'boolean',
        description: 'Rerank the top note candidates with the local bge-reranker before merging them into the hit list. Off by default: ~1 s per query on top of the book search.',
      },
      notesRerankBlend: {
        type: 'number',
        description: 'How much of the lexical note score to keep in the reranked note score, 0..1 (default 0.3).',
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
        // One builder for both passes: the book list and the note list want the same model, and a
        // second probe would pay another Python start for nothing.
        const buildRerank = async (): Promise<((documents: readonly string[]) => Promise<readonly number[] | undefined>) | undefined> => {
          if (deps.prepareRerank === undefined) return undefined;
          const rerankReady = await deps.prepareRerank().catch(() => undefined);
          if (rerankReady === undefined || !rerankReady.ok || !rerankReady.modelReady) return undefined;
          return async (documents) => {
            const result = await rerankPassages({
              pythonPath: rerankReady.pythonPath,
              workspaceRoot,
              modelDir: rerankReady.modelDir,
              query: args.query,
              documents,
            }).catch(() => undefined);
            return result !== undefined && result.ok ? result.scores : undefined;
          };
        };
        const rerank = wantRerank ? await buildRerank() : undefined;
        // Notes: the lexical switches cost nothing, so they ride along with notesLayer; the vector
        // and rerank switches start Python, so they run only when asked for explicitly.
        const noteWindow: {
          notesWeight?: boolean;
          notesHubPenalty?: number;
          notesVectors?: NoteVectors;
          notesQueryVector?: readonly number[];
          notesRerank?: (documents: readonly string[]) => Promise<readonly number[] | undefined>;
          notesRerankBlend?: number;
        } = {};
        if (args.notesLayer === true) {
          if (args.notesWeight !== undefined) noteWindow.notesWeight = args.notesWeight;
          if (args.notesHubPenalty !== undefined) noteWindow.notesHubPenalty = args.notesHubPenalty;
          if (args.notesRerankBlend !== undefined) noteWindow.notesRerankBlend = args.notesRerankBlend;
          if (args.notesRerank === true) {
            const notesReranker = rerank ?? (await buildRerank());
            if (notesReranker !== undefined) noteWindow.notesRerank = notesReranker;
          }
          if (args.notesEmbed === true && deps.embedEnabled !== false && deps.prepareEmbedding !== undefined) {
            const noteEnv = await deps.prepareEmbedding().catch(() => undefined);
            if (noteEnv !== undefined && noteEnv.ok && noteEnv.modelReady) {
              const notesVectors = await ensureNoteVectors(new NodeVaultFs(root), {
                pythonPath: noteEnv.pythonPath,
                modelDir: noteEnv.modelDir,
                workspaceRoot,
              });
              if (notesVectors !== undefined) {
                noteWindow.notesVectors = notesVectors;
                const notesQueryVector = await embedQuery({
                  pythonPath: noteEnv.pythonPath,
                  workspaceRoot,
                  modelDir: noteEnv.modelDir,
                  text: args.query,
                });
                if (notesQueryVector !== undefined) noteWindow.notesQueryVector = notesQueryVector;
              }
            }
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
          ...(args.notesLayer === undefined ? {} : { notesLayer: args.notesLayer }),
          ...(args.notesLimit === undefined ? {} : { notesLimit: args.notesLimit }),
          ...noteWindow,
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
