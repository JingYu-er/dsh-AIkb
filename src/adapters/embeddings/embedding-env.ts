import * as nodePath from 'node:path';
import { defaultCommandRunner, type CommandRunner } from '../pdf/python-env.js';
import { ensureOnnxModelEnv } from './onnx-env.js';
import type { OnnxEnvReport, OnnxModelFile } from './onnx-env.js';

export interface EmbeddingEnvReport extends OnnxEnvReport {}

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
const MODEL_FILES: readonly OnnxModelFile[] = [
  { name: 'tokenizer.json', minBytes: 1_000_000 },
  { name: 'model_quantized.onnx', minBytes: 50_000_000 },
];

/**
 * Resolve (and on first use create) everything local embeddings need: a Python that has
 * tokenizers + onnxruntime, and the e5-small ONNX files.
 *
 * The 113 MB model is fetched once and then reused; embeddings cost CPU time, not tokens.
 */
export async function ensureEmbeddingEnv(
  options: EmbeddingEnvOptions,
  run: CommandRunner = defaultCommandRunner,
): Promise<EmbeddingEnvReport> {
  const workspaceRoot = nodePath.resolve(options.workspaceRoot);
  const modelDir =
    options.modelDir !== undefined && options.modelDir.trim() !== ''
      ? nodePath.resolve(options.modelDir.trim())
      : nodePath.join(workspaceRoot, '.kb', 'models', DEFAULT_MODEL_DIR_NAME);
  return ensureOnnxModelEnv(
    {
      workspaceRoot,
      modelDir,
      modelUrl: options.modelUrl !== undefined && options.modelUrl.trim() !== '' ? options.modelUrl : DEFAULT_MODEL_URL,
      files: MODEL_FILES,
      ...(options.bootstrap !== undefined ? { bootstrap: options.bootstrap } : {}),
      ...(options.pythonPath !== undefined ? { pythonPath: options.pythonPath } : {}),
      ...(options.venvPath !== undefined ? { venvPath: options.venvPath } : {}),
      ...(options.mirrorUrl !== undefined ? { mirrorUrl: options.mirrorUrl } : {}),
    },
    run,
  );
}
