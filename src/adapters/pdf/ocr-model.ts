import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** PP-OCRv4's recognizer is 10.8 MB; anything smaller is a failed or partial download. */
const MIN_BYTES = 8_000_000;

export const DEFAULT_OCR_REC_FILE = 'ch_PP-OCRv4_rec_infer.onnx';
export const DEFAULT_OCR_REC_URL =
  'https://hf-mirror.com/SWHL/RapidOCR/resolve/main/PP-OCRv4/' + DEFAULT_OCR_REC_FILE;

export interface OcrModelReport {
  readonly ok: boolean;
  /** Absolute path of the recognizer graph; empty when it is unavailable. */
  readonly path: string;
  readonly downloaded: boolean;
  readonly actions: readonly string[];
  readonly errors: readonly string[];
}

export interface OcrModelOptions {
  readonly workspaceRoot: string;
  /** Directory holding the ONNX graphs; defaults to <workspaceRoot>/.kb/models/ocr. */
  readonly modelDir?: string;
  readonly modelUrl?: string;
  /** Fetch the model when it is missing. Off for read-only checks. */
  readonly bootstrap?: boolean;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function download(url: string, target: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new Error('HTTP ' + response.status + ' for ' + url);
  const partial = target + '.part';
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial));
  renameSync(partial, target);
}

/**
 * Make PP-OCRv4's recognizer available to the OCR script.
 *
 * RapidOCR ships PP-OCRv3 weights. v4 reads the same scans noticeably better at 200 dpi — 放大 /
 * 性能 / 工程 instead of 放太 / 性熊 / 王程 — and it is one 10.8 MB ONNX graph: no extra Python
 * package, no torch, no paddle. Fetched once from the HF mirror and reused afterwards.
 */
export async function ensureOcrModel(options: OcrModelOptions): Promise<OcrModelReport> {
  const actions: string[] = [];
  const errors: string[] = [];
  const workspaceRoot = nodePath.resolve(options.workspaceRoot);
  const modelDir =
    options.modelDir !== undefined && options.modelDir.trim() !== ''
      ? nodePath.resolve(options.modelDir.trim())
      : nodePath.join(workspaceRoot, '.kb', 'models', 'ocr');
  const target = nodePath.join(modelDir, DEFAULT_OCR_REC_FILE);
  const existing = sizeOf(target);
  if (existing >= MIN_BYTES) {
    actions.push('ocr model ' + target + ' (' + existing + ' bytes)');
    return { ok: true, path: target, downloaded: false, actions, errors };
  }
  if (options.bootstrap !== true) {
    errors.push('ocr model missing: ' + target);
    return { ok: false, path: '', downloaded: false, actions, errors };
  }
  const url =
    options.modelUrl !== undefined && options.modelUrl.trim() !== '' ? options.modelUrl.trim() : DEFAULT_OCR_REC_URL;
  try {
    mkdirSync(modelDir, { recursive: true });
    actions.push('download ' + url);
    await download(url, target);
    const size = sizeOf(target);
    if (size < MIN_BYTES) throw new Error('downloaded file is only ' + size + ' bytes');
    actions.push('ocr model ' + target + ' (' + size + ' bytes)');
    return { ok: true, path: target, downloaded: true, actions, errors };
  } catch (error) {
    errors.push('ocr model download failed: ' + (error instanceof Error ? error.message : String(error)));
    return { ok: false, path: '', downloaded: false, actions, errors };
  }
}
