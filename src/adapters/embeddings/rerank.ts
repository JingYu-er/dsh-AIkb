import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonEnvOf } from '../pdf/python-env.js';

/** dist/adapters/embeddings/*.js -> plugin root; the script ships in scripts/. */
export const RERANK_SCRIPT_PATH = fileURLToPath(new URL('../../../scripts/rerank.py', import.meta.url));

export interface RerankCallOptions {
  readonly pythonPath: string;
  readonly workspaceRoot: string;
  readonly modelDir: string;
  readonly threads?: number;
  readonly batch?: number;
  /** Truncation length for the pair encoding; 128 keeps the query plus a page's opening. */
  readonly maxLen?: number;
  readonly timeoutMs?: number;
}

export interface RerankResult {
  readonly ok: boolean;
  readonly scores: readonly number[];
  readonly seconds: number;
  readonly error?: string;
}

/** Long passages add tokens but no signal: the head of a page is what the query matched. */
const MAX_PASSAGE_CHARS = 1600;
/**
 * Pair truncation. 512 tokens costs ~7.7 s for 40 candidates on this CPU, 128 costs ~1.1 s; the
 * page opening plus the query already carries the decision (measured on the 26-question set:
 * 128 keeps page@5 and lifts MRR to 0.30, so the extra tokens buy latency, not accuracy).
 */
const DEFAULT_MAX_LEN = 128;
const DEFAULT_TIMEOUT_MS = 120_000;

interface Worker {
  readonly child: ChildProcessWithoutNullStreams;
  buffer: string;
  /** Serializes requests over one stdin pipe; each response is one line. */
  tail: Promise<void>;
  closed: boolean;
}

const WORKERS = new Map<string, Worker>();
let exitHook = false;

function kill(worker: Worker): void {
  worker.closed = true;
  try {
    worker.child.kill();
  } catch {
    // already gone
  }
}

function workerKey(options: RerankCallOptions): string {
  return [options.pythonPath, options.modelDir, options.maxLen ?? DEFAULT_MAX_LEN, options.threads ?? 12, options.batch ?? 16].join('|');
}

function startWorker(options: RerankCallOptions): Worker | undefined {
  try {
    const child = spawn(
      options.pythonPath,
      [
        RERANK_SCRIPT_PATH,
        '--serve',
        '--model-dir', options.modelDir,
        '--threads', String(options.threads ?? 12),
        '--batch', String(options.batch ?? 16),
        '--max-len', String(options.maxLen ?? DEFAULT_MAX_LEN),
      ],
      {
        cwd: options.workspaceRoot,
        env: { ...process.env, ...pythonEnvOf(options.workspaceRoot) },
        windowsHide: true,
      },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // The worker outlives a query by design, but it must not outlive its host: with ref'd pipes a
    // CLI or test runner never reaches an empty event loop. In-flight requests are held open by
    // their timeout timer, so unref'ing here cannot cut a response short.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as unknown as { unref?: () => void }).unref?.();
    }
    const worker: Worker = { child, buffer: '', tail: Promise.resolve(), closed: false };
    // Without a listener the pipe fills and the child blocks; stderr carries tracebacks only.
    child.stderr.on('data', () => undefined);
    child.on('exit', () => {
      worker.closed = true;
      if (WORKERS.get(workerKey(options)) === worker) WORKERS.delete(workerKey(options));
    });
    child.on('error', () => {
      worker.closed = true;
      WORKERS.delete(workerKey(options));
    });
    if (!exitHook) {
      exitHook = true;
      process.once('exit', () => {
        for (const entry of WORKERS.values()) kill(entry);
      });
    }
    return worker;
  } catch {
    return undefined;
  }
}

function parseLine(line: string): RerankResult {
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; scores?: number[]; seconds?: number; error?: string };
    if (parsed.ok !== true || !Array.isArray(parsed.scores)) {
      return { ok: false, scores: [], seconds: parsed.seconds ?? 0, error: parsed.error ?? 'rerank failed' };
    }
    return { ok: true, scores: parsed.scores, seconds: parsed.seconds ?? 0 };
  } catch (error) {
    return { ok: false, scores: [], seconds: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Send one request and read exactly one response line.
 *
 * The first call also pays the model load (~2-5 s); later calls reuse the warm process and cost
 * only the forward pass. A timeout kills the worker so the next query starts clean instead of
 * reading a stale response.
 */
function send(worker: Worker, payload: unknown, timeoutMs: number): Promise<RerankResult> {
  return new Promise<RerankResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: RerankResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      worker.child.stdout.off('data', onData);
      worker.child.off('exit', onExit);
      worker.child.off('error', onError);
      resolve(result);
    };
    const take = (): void => {
      const index = worker.buffer.indexOf(String.fromCharCode(10));
      if (index < 0) return;
      const line = worker.buffer.slice(0, index).trim();
      worker.buffer = worker.buffer.slice(index + 1);
      if (line === '') return;
      finish(parseLine(line));
    };
    const onData = (chunk: string): void => {
      worker.buffer += chunk;
      take();
    };
    const onExit = (): void => finish({ ok: false, scores: [], seconds: 0, error: 'rerank worker exited' });
    const onError = (error: Error): void => finish({ ok: false, scores: [], seconds: 0, error: error.message });
    timer = setTimeout(() => {
      finish({ ok: false, scores: [], seconds: 0, error: 'rerank timed out' });
      kill(worker);
    }, timeoutMs);
    worker.child.stdout.on('data', onData);
    worker.child.once('exit', onExit);
    worker.child.once('error', onError);
    worker.child.stdin.write(JSON.stringify(payload) + String.fromCharCode(10));
    take();
  });
}

/**
 * Score how well each passage answers the query with a local cross-encoder.
 *
 * The Python worker stays warm between calls (model load is the expensive part), and requests are
 * serialized so one stdin pipe carries exactly one response per line. Any failure returns
 * ok:false and the caller keeps its lexical order.
 */
export async function rerankPassages(
  options: RerankCallOptions & { readonly query: string; readonly documents: readonly string[] },
): Promise<RerankResult> {
  if (options.documents.length === 0) return { ok: true, scores: [], seconds: 0 };
  const key = workerKey(options);
  let worker = WORKERS.get(key);
  if (worker === undefined || worker.closed) {
    worker = startWorker(options);
    if (worker === undefined) return { ok: false, scores: [], seconds: 0, error: 'could not start rerank worker' };
    WORKERS.set(key, worker);
  }
  const current: Worker = worker;
  const previous = current.tail;
  let release = (): void => undefined;
  current.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    if (current.closed) return { ok: false, scores: [], seconds: 0, error: 'rerank worker exited' };
    return await send(
      current,
      {
        query: options.query,
        documents: options.documents.map((text) => text.slice(0, MAX_PASSAGE_CHARS)),
      },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  } finally {
    release();
  }
}

/** Stop the warm worker (tests, or when the model directory changes on disk). */
export function closeRerankWorker(): void {
  for (const worker of WORKERS.values()) kill(worker);
  WORKERS.clear();
}

