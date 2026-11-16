import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import { ensureEmbeddingEnv } from './adapters/embeddings/embedding-env.js';
import type { EmbeddingEnvReport } from './adapters/embeddings/embedding-env.js';
import { ensureRerankEnv } from './adapters/embeddings/rerank-env.js';
import type { RerankEnvReport } from './adapters/embeddings/rerank-env.js';
import { ensureOcrEnv } from './adapters/pdf/ocr-env.js';
import type { OcrEnvReport } from './adapters/pdf/ocr-env.js';
import { ensureOcrModel } from './adapters/pdf/ocr-model.js';
import type { OcrModelReport } from './adapters/pdf/ocr-model.js';
import { ensurePythonEnv } from './adapters/pdf/python-env.js';
import type { PythonEnvReport } from './adapters/pdf/python-env.js';
import { registerTool } from './tools/definition.js';
import { createKbDoctorTool } from './tools/kb-doctor.tool.js';
import { createKbEmbedTool } from './tools/kb-embed.tool.js';
import { createKbCompileTool } from './tools/kb-compile.tool.js';
import { createKbIngestTool } from './tools/kb-ingest.tool.js';
import { createKbInventoryTool } from './tools/kb-inventory.tool.js';
import { createKbLintTool } from './tools/kb-lint.tool.js';
import { createKbPromoteTool } from './tools/kb-promote.tool.js';
import { createKbQueryTool } from './tools/kb-query.tool.js';
import { createKbSuggestLinksTool } from './tools/kb-suggest-links.tool.js';

/** Stable cordis plugin identity. */
export const name = 'dsh-kb';

/**
 * Cordis services this plugin needs before apply() runs. Declaring "tools" is what
 * makes ctx.tools exist: a plugin that reads it without injecting it is applied too
 * early and throws, and the whole bundle silently disappears from the tool list.
 */
export const inject = ['tools'];

export interface KbPluginConfig {
  /** Absolute path of the Obsidian vault. Unset: discover from the working directory. */
  readonly vaultPath?: string;
  /** Off by default; enabling it only allows inbox/ and .wiki/ to change. */
  readonly allowWrites?: boolean;
  /** Base interpreter used to create the private venv (must exist). Default "python". */
  readonly pythonPath?: string;
  /** Extra directory on PYTHONPATH when PyMuPDF is installed outside the interpreter. */
  readonly pythonLibPath?: string;
  /** Private venv the plugin prepares for itself. Default <workspaceRoot>/.kb/venv. */
  readonly venvPath?: string;
  /** Directory the venv is anchored to; defaults to the host working directory. */
  readonly workspaceRoot?: string;
  /** pip index for the one-time PyMuPDF install. Default: Tsinghua mirror. */
  readonly pythonMirror?: string;
  /** Local OCR for scanned PDFs. On by default; set false to skip image-only books. */
  readonly ocrEnabled?: boolean;
  /** OCR worker processes. Default 4. */
  readonly ocrWorkers?: number;
  /** OCR only the first N pages of each scanned book (a cheap first experiment). */
  readonly ocrMaxPages?: number;
  /** Directory holding the PP-OCRv4 recognizer. Default <workspaceRoot>/.kb/models/ocr. */
  readonly ocrModelDir?: string;
  /** Base URL the PP-OCRv4 graph is fetched from on first OCR use. Default: hf-mirror. */
  readonly ocrModelUrl?: string;
  /** Local embeddings for hybrid search. On by default; kb_embed builds them on demand. */
  readonly embedEnabled?: boolean;
  /** Embed newly ingested books in the same kb_ingest call. Default true; false leaves it to kb_embed. */
  readonly embedOnIngest?: boolean;
  /** Directory holding tokenizer.json + model_quantized.onnx. Default <workspaceRoot>/.kb/models/multilingual-e5-small. */
  readonly embedModelDir?: string;
  /** Base URL the ONNX files are fetched from on first use. Default: hf-mirror. */
  readonly embedModelUrl?: string;
  /**
   * Rerank every query with the local cross-encoder. Off by default: ~1-3 s per query and a
   * 279 MB model on first use. A single kb_query call can still pass rerank:true.
   */
  readonly rerankEnabled?: boolean;
  /** Directory holding the reranker files. Default <workspaceRoot>/.kb/models/bge-reranker-base. */
  readonly rerankModelDir?: string;
  /** Base URL the reranker files are fetched from on first use. Default: hf-mirror. */
  readonly rerankModelUrl?: string;
  /**
   * Widen queries with bilingual pairs harvested from this vault's books. Off by default: on the
   * 26-question evaluation the full list cost five page hits, and frequency-gated pairs were
   * neutral. Turn it on for a library that mixes Chinese questions with English books.
   */
  readonly glossaryExpansion?: boolean;
  /** Vault-relative folder kb_promote writes into. Unset disables promotion. */
  readonly promoteDir?: string;
}

interface ToolsRegistry {
  register(definition: unknown): void;
}

interface PluginContext {
  readonly tools: ToolsRegistry;
}

function nearestVault(start: string, maxDepth = 6): string | undefined {
  let current = nodePath.resolve(start);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (existsSync(nodePath.join(current, '.obsidian'))) return current;
    const parent = nodePath.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

export function resolveVaultRoot(config: KbPluginConfig, explicit?: string, cwd: string = process.cwd()): string {
  const fromArgs = explicit !== undefined && explicit.trim() !== '' ? explicit.trim() : undefined;
  const fromConfig = typeof config.vaultPath === 'string' && config.vaultPath.trim() !== '' ? config.vaultPath.trim() : undefined;
  const root = fromArgs ?? fromConfig ?? nearestVault(cwd);
  if (root === undefined) {
    throw new Error('kb.vault.not-found: set vaultPath in the dsh-kb plugin config, pass vaultPath, or start DSH inside an Obsidian vault.');
  }
  return nodePath.resolve(root);
}

/** Best-effort boot trace: a failed write must never break plugin loading. */
function logBoot(workspaceRoot: string, event: string, detail: string): void {
  try {
    const dir = nodePath.join(workspaceRoot, '.kb', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(nodePath.join(dir, 'boot.log'), new Date().toISOString() + ' ' + event + ' ' + detail + String.fromCharCode(10), 'utf8');
  } catch {
    // diagnostics only
  }
}

export function apply(ctx: PluginContext, config: KbPluginConfig = {}): void {
  const bootRoot = config.workspaceRoot !== undefined && config.workspaceRoot.trim() !== ''
    ? nodePath.resolve(config.workspaceRoot.trim())
    : process.cwd();
  logBoot(bootRoot, 'apply', 'apply() entered');
  // The web panel is an iframe over the local UI server, so make sure it is up once per process.
  void (async () => {
    const port = process.env.KB_UI_PORT ?? '7341';
    try {
      const alive = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(800) });
      if (alive.ok) return;
    } catch {
      // not listening yet: start it below
    }
    try {
      const { spawn } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const script = fileURLToPath(new URL('../scripts/kb-ui.mjs', import.meta.url));
      const child = spawn(process.execPath, [script], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          KB_VAULT: (config as unknown as { vaultPath?: string }).vaultPath ?? process.env.KB_VAULT ?? '',
          KB_UI_PORT: port,
        },
      });
      child.unref();
      logBoot(bootRoot, 'ui-start', 'spawned ' + script);
    } catch (error) {
      logBoot(bootRoot, 'ui-start-failed', String(error));
    }
  })();
  if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
    logBoot(bootRoot, 'apply-failed', 'tools service unavailable');
    throw new Error('dsh-kb: the tools service is unavailable; declare inject = ["tools"] (see src/index.ts)');
  }
  const allowWrites = config.allowWrites === true;
  const resolveRoot = (explicit?: string): string => resolveVaultRoot(config, explicit);
  const workspaceRoot = config.workspaceRoot !== undefined && config.workspaceRoot.trim() !== ''
    ? nodePath.resolve(config.workspaceRoot.trim())
    : process.cwd();
  /** One bootstrap per process: probing is cheap, installing is not. */
  let pythonEnvOnce: Promise<PythonEnvReport> | undefined;
  const pythonEnv = (bootstrap: boolean): Promise<PythonEnvReport> => {
    if (bootstrap && pythonEnvOnce !== undefined) return pythonEnvOnce;
    const options = {
      workspaceRoot,
      pythonPath: config.pythonPath ?? '',
      venvPath: config.venvPath ?? '',
      mirrorUrl: config.pythonMirror ?? '',
      bootstrap,
    };
    const pending = ensurePythonEnv(options);
    if (bootstrap) pythonEnvOnce = pending;
    return pending;
  };

  /** RapidOCR is resolved once per process, like PyMuPDF. */
  let ocrEnvOnce: Promise<OcrEnvReport> | undefined;
  const ocrEnv = (): Promise<OcrEnvReport> => {
    if (ocrEnvOnce !== undefined) return ocrEnvOnce;
    const pending = ensureOcrEnv({
      workspaceRoot,
      pythonPath: config.pythonPath ?? '',
      venvPath: config.venvPath ?? '',
      mirrorUrl: config.pythonMirror ?? '',
      bootstrap: true,
    });
    ocrEnvOnce = pending;
    return pending;
  };
  /** One 10.8 MB graph; fetched on the first OCR run, then reused. Missing it keeps v3 working. */
  let ocrModelOnce: Promise<OcrModelReport> | undefined;
  const ocrModel = (): Promise<OcrModelReport> => {
    if (ocrModelOnce !== undefined) return ocrModelOnce;
    const pending = ensureOcrModel({
      workspaceRoot,
      modelDir: config.ocrModelDir ?? '',
      modelUrl: config.ocrModelUrl ?? '',
      bootstrap: true,
    });
    ocrModelOnce = pending;
    return pending;
  };
  const ocrEnabled = config.ocrEnabled !== false;

  /** The e5-small model is downloaded once per machine, like the venv. */
  let embeddingEnvOnce: Promise<EmbeddingEnvReport> | undefined;
  const embeddingEnv = (): Promise<EmbeddingEnvReport> => {
    if (embeddingEnvOnce !== undefined) return embeddingEnvOnce;
    const pending = ensureEmbeddingEnv({
      workspaceRoot,
      pythonPath: config.pythonPath ?? '',
      venvPath: config.venvPath ?? '',
      mirrorUrl: config.pythonMirror ?? '',
      modelDir: config.embedModelDir ?? '',
      modelUrl: config.embedModelUrl ?? '',
      bootstrap: true,
    });
    embeddingEnvOnce = pending;
    return pending;
  };
  const embedEnabled = config.embedEnabled !== false;

  /** Fetched on first reranked query, not at boot: most queries do not ask for it. */
  let rerankEnvOnce: Promise<RerankEnvReport> | undefined;
  const rerankEnv = (): Promise<RerankEnvReport> => {
    if (rerankEnvOnce !== undefined) return rerankEnvOnce;
    const pending = ensureRerankEnv({
      workspaceRoot,
      pythonPath: config.pythonPath ?? '',
      venvPath: config.venvPath ?? '',
      mirrorUrl: config.pythonMirror ?? '',
      modelDir: config.rerankModelDir ?? '',
      modelUrl: config.rerankModelUrl ?? '',
      bootstrap: true,
    });
    rerankEnvOnce = pending;
    return pending;
  };
  const rerankEnabled = config.rerankEnabled === true;

  try {
    registerTool(ctx, createKbDoctorTool({ allowWrites, resolveRoot, inspectPython: () => pythonEnv(false) }));
    registerTool(ctx, createKbInventoryTool({ allowWrites, resolveRoot }));
    registerTool(ctx, createKbLintTool({ resolveRoot }));
    registerTool(ctx, createKbCompileTool({ resolveRoot, allowWrites: () => allowWrites }));
    registerTool(ctx, createKbPromoteTool({ resolveRoot, allowWrites: () => allowWrites, promoteDir: () => config.promoteDir }));
    registerTool(ctx, createKbSuggestLinksTool({ resolveRoot }));
    registerTool(
      ctx,
      createKbIngestTool({
        allowWrites,
        resolveRoot,
        preparePython: () => pythonEnv(true),
        pythonLibPath: config.pythonLibPath ?? '',
        workspaceRoot,
        ocrWorkers: config.ocrWorkers !== undefined && config.ocrWorkers > 0 ? config.ocrWorkers : 4,
        ...(config.ocrEnabled === false ? {} : { prepareOcr: () => ocrEnv(), prepareOcrModel: () => ocrModel() }),
        ...(config.ocrMaxPages !== undefined ? { ocrMaxPages: config.ocrMaxPages } : {}),
        ...(embedEnabled ? { prepareEmbedding: () => embeddingEnv(), autoEmbed: config.embedOnIngest !== false } : {}),
      }),
    );
    registerTool(
      ctx,
      createKbQueryTool({
        resolveRoot,
        workspaceRoot: () => workspaceRoot,
        embedEnabled,
        glossaryExpansion: config.glossaryExpansion === true,
        ...(embedEnabled ? { prepareEmbedding: () => embeddingEnv() } : {}),
        prepareRerank: () => rerankEnv(),
        rerankDefault: rerankEnabled,
      }),
    );
    registerTool(
      ctx,
      createKbEmbedTool({
        resolveRoot,
        workspaceRoot: () => workspaceRoot,
        allowWrites: () => allowWrites,
        prepareEmbedding: () => embeddingEnv(),
      }),
    );
  } catch (error) {
    logBoot(workspaceRoot, 'apply-failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
  logBoot(workspaceRoot, 'apply', 'registered kb_doctor kb_inventory kb_lint kb_compile kb_promote kb_suggest_links kb_ingest kb_query kb_embed');
}
