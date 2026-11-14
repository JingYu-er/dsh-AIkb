import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCommandRunner, pythonEnvOf, type CommandRunner } from '../pdf/python-env.js';

/** dist/adapters/embeddings/*.js -> plugin root; the script ships in scripts/. */
export const EMBEDDING_SCRIPT_PATH = fileURLToPath(new URL('../../../scripts/embed_chunks.py', import.meta.url));

export interface EmbeddingJob {
  /** Absolute path of the chunk JSONL file. */
  readonly chunksPath: string;
  /** Absolute path of the raw float32 output (<sha256>.vec). */
  readonly outPath: string;
  /** Absolute path of the sidecar metadata (<sha256>.json). */
  readonly metaPath: string;
}

export interface EmbeddingJobReport {
  readonly ok: boolean;
  readonly count: number;
  readonly dims: number;
  readonly seconds: number;
  readonly error?: string;
  readonly chunksPath: string;
}

export interface EmbeddingCallOptions {
  readonly pythonPath: string;
  readonly workspaceRoot: string;
  readonly modelDir: string;
  readonly threads?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function scriptArgs(options: EmbeddingCallOptions, jobsFile: string): string[] {
  return [
    EMBEDDING_SCRIPT_PATH,
    '--model-dir', options.modelDir,
    '--jobs', jobsFile,
    '--threads', String(options.threads ?? 12),
  ];
}

/**
 * Embed many books in one process.
 *
 * Python loads the ONNX session once and streams one JSON line per book, so a failure on
 * one book does not discard the vectors already written for the others.
 */
export async function embedChunkFiles(
  options: EmbeddingCallOptions & { readonly jobs: readonly EmbeddingJob[] },
  run: CommandRunner = defaultCommandRunner,
): Promise<readonly EmbeddingJobReport[]> {
  if (options.jobs.length === 0) return [];
  const dir = nodePath.join(nodePath.resolve(options.workspaceRoot), 'temp', 'embed');
  mkdirSync(dir, { recursive: true });
  const jobsFile = nodePath.join(dir, 'jobs-' + Date.now() + '.json');
  writeFileSync(
    jobsFile,
    JSON.stringify(options.jobs.map((job) => ({ chunks: job.chunksPath, out: job.outPath, meta: job.metaPath, prefix: 'passage: ' }))),
    'utf8',
  );
  const outcome = await run(options.pythonPath, scriptArgs(options, jobsFile), {
    env: pythonEnvOf(options.workspaceRoot),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const reports: EmbeddingJobReport[] = [];
  const byChunks = new Map(options.jobs.map((job) => [job.chunksPath, job] as const));
  const lines = outcome.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  lines.forEach((line, index) => {
    try {
      const parsed = JSON.parse(line) as { ok?: boolean; count?: number; dims?: number; seconds?: number; error?: string; chunks?: string };
      // The script echoes its input path; if an older script does not, fall back to job order
      // (the script always reports one line per job, in the order jobs were submitted).
      const job = parsed.chunks !== undefined
        ? byChunks.get(nodePath.resolve(parsed.chunks)) ?? byChunks.get(parsed.chunks)
        : options.jobs[index];
      reports.push({
        ok: parsed.ok === true,
        count: parsed.count ?? 0,
        dims: parsed.dims ?? 0,
        seconds: parsed.seconds ?? 0,
        ...(parsed.error !== undefined ? { error: parsed.error } : {}),
        chunksPath: job?.chunksPath ?? '',
      });
    } catch {
      return;
    }
  });
  if (outcome.code !== 0 && reports.length === 0) {
    throw new Error('embedding process exited ' + outcome.code + ': ' + (outcome.stderr || '').slice(-800));
  }
  return reports;
}

/** Embed one query with the same model (e5 wants the "query: " prefix). */
export async function embedQuery(
  options: EmbeddingCallOptions & { readonly text: string },
  run: CommandRunner = defaultCommandRunner,
): Promise<readonly number[] | undefined> {
  try {
    const outcome = await run(
      options.pythonPath,
      [EMBEDDING_SCRIPT_PATH, '--model-dir', options.modelDir, '--query', options.text, '--threads', String(options.threads ?? 8)],
      { env: pythonEnvOf(options.workspaceRoot), timeoutMs: options.timeoutMs ?? 120_000 },
    );
    if (outcome.code !== 0) return undefined;
    const line = outcome.stdout.split(/\r?\n/).find((entry) => entry.trim().startsWith('{'));
    if (line === undefined) return undefined;
    const parsed = JSON.parse(line) as { vector?: number[] };
    return Array.isArray(parsed.vector) ? parsed.vector : undefined;
  } catch {
    return undefined;
  }
}
