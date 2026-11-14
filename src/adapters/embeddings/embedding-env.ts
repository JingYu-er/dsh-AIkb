import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  defaultCommandRunner,
  ensurePythonEnv,
  pythonEnvOf,
  type CommandRunner,
} from '../pdf/python-env.js';

export interface EmbeddingEnvReport {
  readonly ok: boolean;
  readonly pythonPath: string;
  readonly modelDir: string;
  readonly modelReady: boolean;
  readonly tokenizersVersion: string;
  readonly onnxruntimeVersion: string;
  readonly installed: boolean;
  readonly downloaded: boolean;
  readonly actions: readonly string[];
  readonly errors: readonly string[];
}

export interface EmbeddingEnvOptions {
  readonly workspaceRoot: string;
  readonly pythonPath?: string;
  readonly venvPath?: string;
  readonly mirrorUrl?: string;
  /** Directory holding tokenizer.json and model_quantized.onnx. */
  readonly modelDir?: string;
  /** Base URL the two model files are fetched from on first use. */
  readonly modelUrl?: string;
  readonly bootstrap?: boolean;
}

export const DEFAULT_MODEL_DIR_NAME = 'multilingual-e5-small';
/** hf-mirror is the reachable mirror of the Xenova ONNX export of intfloat/multilingual-e5-small. */
export const DEFAULT_MODEL_URL = 'https://hf-mirror.com/Xenova/multilingual-e5-small/resolve/main';
const MODEL_FILES: readonly { name: string; minBytes: number }[] = [
  { name: 'tokenizer.json', minBytes: 1_000_000 },
  { name: 'model_quantized.onnx', minBytes: 50_000_000 },
];
const PROBE =
  'import sys,json,tokenizers,onnxruntime;sys.stdout.write(json.dumps({"tokenizers":tokenizers.__version__,"onnxruntime":onnxruntime.__version__}))';

interface ProbeResult {
  readonly ok: boolean;
  readonly tokenizers: string;
  readonly onnxruntime: string;
  readonly error: string;
}

async function probe(run: CommandRunner, pythonPath: string, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  try {
    const outcome = await run(pythonPath, ['-c', PROBE], { env, timeoutMs: 30_000 });
    if (outcome.code !== 0) {
      return { ok: false, tokenizers: '', onnxruntime: '', error: (outcome.stderr || 'exit ' + outcome.code).slice(-600) };
    }
    const parsed = JSON.parse(outcome.stdout.trim()) as { tokenizers?: string; onnxruntime?: string };
    return { ok: true, tokenizers: parsed.tokenizers ?? 'unknown', onnxruntime: parsed.onnxruntime ?? 'unknown', error: '' };
  } catch (error) {
    return { ok: false, tokenizers: '', onnxruntime: '', error: error instanceof Error ? error.message : String(error) };
  }
}

async function download(url: string, target: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new Error('HTTP ' + response.status + ' for ' + url);
  const partial = target + '.part';
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial));
  renameSync(partial, target);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Resolve (and on first use create) everything local embeddings need: a Python that has
 * tokenizers + onnxruntime, and the e5-small ONNX files.
 *
 * Nothing here calls a model API: the embedding runs on this machine, so a book costs CPU
 * time rather than tokens. The 113 MB model is fetched once and then reused.
 */
export async function ensureEmbeddingEnv(
  options: EmbeddingEnvOptions,
  run: CommandRunner = defaultCommandRunner,
): Promise<EmbeddingEnvReport> {
  const workspaceRoot = nodePath.resolve(options.workspaceRoot);
  const env = pythonEnvOf(workspaceRoot);
  const modelDir =
    options.modelDir !== undefined && options.modelDir.trim() !== ''
      ? nodePath.resolve(options.modelDir.trim())
      : nodePath.join(workspaceRoot, '.kb', 'models', DEFAULT_MODEL_DIR_NAME);
  const actions: string[] = [];
  const errors: string[] = [];
  let installed = false;
  let downloaded = false;

  const base = await ensurePythonEnv(
    {
      workspaceRoot,
      bootstrap: options.bootstrap,
      ...(options.pythonPath !== undefined ? { pythonPath: options.pythonPath } : {}),
      ...(options.venvPath !== undefined ? { venvPath: options.venvPath } : {}),
      ...(options.mirrorUrl !== undefined ? { mirrorUrl: options.mirrorUrl } : {}),
    },
    run,
  );
  for (const action of base.actions) actions.push(action);
  if (!base.ok) {
    for (const error of base.errors) errors.push(error);
    return {
      ok: false, pythonPath: '', modelDir, modelReady: false, tokenizersVersion: '', onnxruntimeVersion: '',
      installed, downloaded, actions, errors,
    };
  }
  const pythonPath = base.pythonPath;

  let probed = await probe(run, pythonPath, env);
  if (!probed.ok) {
    actions.push('embedding probe failed: ' + probed.error);
    if (options.bootstrap !== true) {
      errors.push('tokenizers/onnxruntime unavailable: ' + probed.error);
      return { ok: false, pythonPath, modelDir, modelReady: false, tokenizersVersion: '', onnxruntimeVersion: '', installed, downloaded, actions, errors };
    }
    const mirror = options.mirrorUrl !== undefined && options.mirrorUrl.trim() !== ''
      ? options.mirrorUrl.trim()
      : 'https://pypi.tuna.tsinghua.edu.cn/simple';
    const attempts = [
      ['-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', '-i', mirror, 'tokenizers', 'onnxruntime', 'numpy'],
      ['-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', 'tokenizers', 'onnxruntime', 'numpy'],
    ];
    for (const args of attempts) {
      const outcome = await run(pythonPath, args, { env, timeoutMs: 900_000 });
      if (outcome.code !== 0) {
        errors.push('pip failed: ' + (outcome.stderr || 'exit ' + outcome.code).slice(-600));
        continue;
      }
      installed = true;
      actions.push('installed tokenizers/onnxruntime');
      probed = await probe(run, pythonPath, env);
      if (probed.ok) break;
    }
    if (!probed.ok) {
      errors.push('after install: ' + probed.error);
      return { ok: false, pythonPath, modelDir, modelReady: false, tokenizersVersion: '', onnxruntimeVersion: '', installed, downloaded, actions, errors };
    }
  }

  const missing = MODEL_FILES.filter((file) => fileSize(nodePath.join(modelDir, file.name)) < file.minBytes);
  if (missing.length > 0) {
    if (options.bootstrap !== true) {
      errors.push('embedding model missing in ' + modelDir + ': ' + missing.map((file) => file.name).join(', '));
      return { ok: false, pythonPath, modelDir, modelReady: false, tokenizersVersion: probed.tokenizers, onnxruntimeVersion: probed.onnxruntime, installed, downloaded, actions, errors };
    }
    mkdirSync(modelDir, { recursive: true });
    const baseUrl = options.modelUrl !== undefined && options.modelUrl.trim() !== ''
      ? options.modelUrl.trim().replace(/\/+$/, '')
      : DEFAULT_MODEL_URL;
    for (const file of missing) {
      const target = nodePath.join(modelDir, file.name);
      try {
        actions.push('downloading ' + file.name);
        await download(baseUrl + '/' + file.name, target);
        downloaded = true;
      } catch (error) {
        errors.push('download failed for ' + file.name + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    const stillMissing = MODEL_FILES.filter((file) => fileSize(nodePath.join(modelDir, file.name)) < file.minBytes);
    if (stillMissing.length > 0) {
      return { ok: false, pythonPath, modelDir, modelReady: false, tokenizersVersion: probed.tokenizers, onnxruntimeVersion: probed.onnxruntime, installed, downloaded, actions, errors };
    }
  }

  const modelReady = MODEL_FILES.every((file) => existsSync(nodePath.join(modelDir, file.name)));
  actions.push('probe ' + pythonPath + ' -> tokenizers ' + probed.tokenizers + ', onnxruntime ' + probed.onnxruntime);
  return {
    ok: modelReady, pythonPath, modelDir, modelReady, tokenizersVersion: probed.tokenizers,
    onnxruntimeVersion: probed.onnxruntime, installed, downloaded, actions, errors,
  };
}
