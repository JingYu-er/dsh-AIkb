import { copyFileSync, existsSync as nodePathExists, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import * as nodePath from 'node:path';
import { embedChunkFiles } from '../adapters/embeddings/embedding.js';
import type { EmbeddingEnvReport } from '../adapters/embeddings/embedding-env.js';
import { planEmbedding } from '../application/kb-embed.js';
import type { EmbedReport, EmbeddableSource } from '../application/kb-embed.js';
import { chunkFileOf, INDEX_CATALOG_PATH } from '../application/kb-ingest.js';
import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';

export interface KbEmbedArgs {
  readonly vaultPath?: string;
  readonly limit?: number;
  readonly force?: boolean;
}

export interface KbEmbedDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly workspaceRoot: () => string;
  readonly allowWrites: () => boolean;
  readonly prepareEmbedding: () => Promise<EmbeddingEnvReport>;
  /** Vault-relative directory holding <sha>.vec + <sha>.json. */
  readonly vectorsDir: string;
}

const VECTORS_DIR = '.wiki/index/vectors';

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

interface Catalog {
  schema: string;
  sources: Record<string, { path: string; pages: number; chunks: number }>;
}

function readEmbedded(root: string): Map<string, number> {
  const embedded = new Map<string, number>();
  const dir = nodePath.join(root, ...VECTORS_DIR.split('/'));
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return embedded;
  }
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(nodePath.join(dir, name), 'utf8')) as { count?: number; ids?: unknown };
      if (typeof meta.count === 'number') embedded.set(name.replace(/\.json$/, ''), meta.count);
    } catch {
      continue;
    }
  }
  return embedded;
}

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
    async execute(args) {
      const started = Date.now();
      const root = deps.resolveRoot(args.vaultPath);
      const fail = (code: string, message: string): EmbedReport => ({
        ok: false, error: { code, message }, vaultRoot: root, books: [],
        totals: { books: 0, chunks: 0, upToDate: 0 }, elapsedMs: Date.now() - started,
      });
      try {
        if (!deps.allowWrites()) return fail('kb.writes-disabled', 'allowWrites is false: enable it in the plugin config to write vectors');
        const fs = new NodeVaultFs(root);
        if (!(await fs.exists(INDEX_CATALOG_PATH))) return fail('embed.index-missing', 'no index yet: run kb_ingest first');
        const catalog = JSON.parse(await fs.readText(INDEX_CATALOG_PATH)) as Catalog;
        const sources: EmbeddableSource[] = Object.entries(catalog.sources).map(([sha256, source]) => ({
          sha256, path: source.path, chunks: source.chunks,
        }));
        const plan = planEmbedding(sources, readEmbedded(root), args.force === true);
        let todo = plan.todo;
        if (args.limit !== undefined && args.limit > 0) todo = todo.slice(0, args.limit);
        const env = await deps.prepareEmbedding();
        if (!env.ok || !env.modelReady) {
          return fail('embed.model-missing', 'embedding model unavailable: ' + (env.errors.join('; ') || 'unknown error'));
        }
        const vectorsRoot = nodePath.join(root, ...VECTORS_DIR.split('/'));
        mkdirSync(vectorsRoot, { recursive: true });
        // The venv interpreter is denied writes inside this vault (the host Node is not), so
        // Python stages into the workspace temp dir and the files are moved in afterwards.
        const staging = nodePath.join(deps.workspaceRoot(), 'temp', 'embed', 'staging');
        mkdirSync(staging, { recursive: true });
        const jobs = [];
        for (const source of todo) {
          const chunksPath = nodePath.join(root, ...chunkFileOf(source.sha256).split('/'));
          jobs.push({
            chunksPath,
            outPath: nodePath.join(staging, source.sha256 + '.vec'),
            metaPath: nodePath.join(staging, source.sha256 + '.json'),
          });
        }
        const reports = await embedChunkFiles({
          pythonPath: env.pythonPath,
          workspaceRoot: deps.workspaceRoot(),
          modelDir: env.modelDir,
          jobs,
        });
        const byChunks = new Map(todo.map((source) => [source.sha256, source] as const));
        const moveErrors = new Map<string, string>();
        for (const source of todo) {
          if (!nodePathExists(nodePath.join(staging, source.sha256 + '.vec'))) continue;
          try {
            for (const extension of ['.vec', '.json']) {
              const from = nodePath.join(staging, source.sha256 + extension);
              const to = nodePath.join(vectorsRoot, source.sha256 + extension);
              try {
                renameSync(from, to);
              } catch {
                copyFileSync(from, to);
                unlinkSync(from);
              }
            }
          } catch (error) {
            // An uncommitted pair stays pending: the next run re-embeds this book.
            moveErrors.set(source.sha256, error instanceof Error ? error.message : String(error));
          }
        }
        const books = reports.map((report) => {
          const sha = nodePath.basename(report.chunksPath).replace(/\.jsonl$/, '');
          const source = byChunks.get(sha);
          const moveError = moveErrors.get(sha);
          return {
            path: source?.path ?? sha,
            sha256: sha,
            chunks: report.count,
            ...(report.ok && moveError === undefined
              ? { seconds: report.seconds }
              : { error: moveError ?? report.error ?? 'embedding failed' }),
          };
        });
        const failed = books.filter((book) => 'error' in book).length;
        return {
          ok: failed === 0,
          vaultRoot: root,
          model: env.modelDir.split(nodePath.sep).pop() ?? 'unknown',
          books,
          totals: {
            books: books.length - failed,
            chunks: books.reduce((sum, book) => sum + ('error' in book ? 0 : book.chunks), 0),
            upToDate: plan.upToDate.length,
          },
          elapsedMs: Date.now() - started,
          ...(failed === 0 ? {} : { notes: [failed + ' book(s) failed; rerun kb_embed to retry (finished books are skipped)'] }),
        };
      } catch (error) {
        return fail('embed.failed', error instanceof Error ? error.message : String(error));
      }
    },
  });
}
