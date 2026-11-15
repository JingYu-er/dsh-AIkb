import * as nodePath from 'node:path';
import { defaultCommandRunner, type CommandRunner } from '../pdf/python-env.js';
import { ensureOnnxModelEnv } from './onnx-env.js';
import type { OnnxEnvReport, OnnxModelFile } from './onnx-env.js';

export interface RerankEnvReport extends OnnxEnvReport {}

export interface RerankEnvOptions {
  readonly workspaceRoot: string;
  readonly pythonPath?: string;
  readonly venvPath?: string;
  readonly mirrorUrl?: string;
  readonly modelDir?: string;
  readonly modelUrl?: string;
  readonly bootstrap?: boolean;
}

export const DEFAULT_RERANK_DIR_NAME = 'bge-reranker-base';
/** Same Xenova export used for embeddings, so one mirror serves both. */
export const DEFAULT_RERANK_URL = 'https://hf-mirror.com/Xenova/bge-reranker-base/resolve/main';
const MODEL_FILES: readonly OnnxModelFile[] = [
  { name: 'tokenizer.json', minBytes: 1_000_000 },
  { name: 'model_quantized.onnx', minBytes: 200_000_000 },
];

/**
 * A cross-encoder scores a (query, passage) pair jointly, which is what separates the right
 * chapter from a page that merely repeats the words. 279 MB quantized: fetched once on first
 * use, then every query costs CPU time only.
 */
export async function ensureRerankEnv(
  options: RerankEnvOptions,
  run: CommandRunner = defaultCommandRunner,
): Promise<RerankEnvReport> {
  const workspaceRoot = nodePath.resolve(options.workspaceRoot);
  const modelDir =
    options.modelDir !== undefined && options.modelDir.trim() !== ''
      ? nodePath.resolve(options.modelDir.trim())
      : nodePath.join(workspaceRoot, '.kb', 'models', DEFAULT_RERANK_DIR_NAME);
  return ensureOnnxModelEnv(
    {
      workspaceRoot,
      modelDir,
      modelUrl: options.modelUrl !== undefined && options.modelUrl.trim() !== '' ? options.modelUrl : DEFAULT_RERANK_URL,
      files: MODEL_FILES,
      ...(options.bootstrap !== undefined ? { bootstrap: options.bootstrap } : {}),
      ...(options.pythonPath !== undefined ? { pythonPath: options.pythonPath } : {}),
      ...(options.venvPath !== undefined ? { venvPath: options.venvPath } : {}),
      ...(options.mirrorUrl !== undefined ? { mirrorUrl: options.mirrorUrl } : {}),
    },
    run,
  );
}
