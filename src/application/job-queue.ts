/**
 * Durable job queue for the distill/judge pipeline.
 *
 * One JSON file (queue.json) survives process restarts: a job enqueued by one process is
 * picked up by the next, and a process that died mid-job is repaired by recoverQueue instead
 * of losing the work. There are no timers or workers here — the queue is plain data, so a
 * caller can persist it, test it without spawning a process, and render it in the KB panel.
 *
 * Every function is pure except loadQueue/saveQueue, and every expected failure is reported
 * (a warning or a refusal) instead of thrown.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';

export const QUEUE_VERSION = 1;

export type JobKind = 'ingest' | 'judge' | 'embed';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRecord {
  readonly id: string;
  readonly kind: JobKind;
  readonly vault: string;
  readonly label: string;
  readonly payload: Record<string, unknown>;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly lastError?: string;
  readonly result?: Record<string, unknown>;
}

export interface JobQueue {
  readonly version: number;
  readonly jobs: JobRecord[];
}

const JOB_KINDS: readonly JobKind[] = ['ingest', 'judge', 'embed'];
const JOB_STATUSES: readonly JobStatus[] = ['pending', 'running', 'done', 'failed', 'cancelled'];

const DEFAULT_MAX_ATTEMPTS = 3;
const ATTEMPT_LIMIT = 10;
const DEFAULT_KEEP_DONE = 50;

/** Timestamp used for a job whose creation time is missing on disk; valid ISO, sorts first. */
const ZERO_TIME = new Date(0).toISOString();

const INTERRUPTED =
  'kb.job.interrupted: the process stopped while this job was running';

/** Where queue.json lives. An explicit argument wins over KB_JOBS_DIR, which wins over the default. */
export function jobQueueDir(dir?: string): string {
  const explicit = typeof dir === 'string' ? dir.trim() : '';
  if (explicit !== '') return nodePath.resolve(explicit);
  const fromEnv = (process.env.KB_JOBS_DIR ?? '').trim();
  if (fromEnv !== '') return nodePath.resolve(fromEnv);
  return nodePath.join(homedir(), '.dsh-aikb', 'jobs');
}

export function jobQueuePath(dir?: string): string {
  return nodePath.join(jobQueueDir(dir), 'queue.json');
}

/**
 * Read the queue. A missing file is an empty queue, a broken file is an empty queue plus a
 * warning, and invalid jobs are dropped one by one so a single bad record cannot hide the
 * rest of the work.
 */
export async function loadQueue(dir?: string): Promise<{ queue: JobQueue; path: string; warnings: string[] }> {
  const path = jobQueuePath(dir);
  const warnings: string[] = [];
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { queue: emptyQueue(), path, warnings };
    warnings.push('kb.job.corrupt: ' + path + ' (' + describeError(error) + ')');
    return { queue: emptyQueue(), path, warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnings.push('kb.job.corrupt: ' + path + ' (' + describeError(error) + ')');
    return { queue: emptyQueue(), path, warnings };
  }

  if (!isPlainObject(parsed)) {
    warnings.push('kb.job.corrupt: ' + path + ' (the file is not a JSON object)');
    return { queue: emptyQueue(), path, warnings };
  }
  const document = parsed;
  if (!Array.isArray(document.jobs)) {
    warnings.push('kb.job.corrupt: ' + path + ' (jobs is not an array)');
    return { queue: emptyQueue(), path, warnings };
  }

  const jobs: JobRecord[] = [];
  document.jobs.forEach((entry, index) => {
    const normalized = normalizeJob(entry, index);
    if ('warning' in normalized) warnings.push(normalized.warning);
    else jobs.push(normalized.job);
  });

  const version =
    typeof document.version === 'number' && Number.isInteger(document.version) && document.version > 0
      ? document.version
      : QUEUE_VERSION;
  return { queue: { version, jobs }, path, warnings };
}

/** Write atomically: a partial write can never replace a good queue. */
export async function saveQueue(
  queue: JobQueue,
  dir?: string,
): Promise<{ ok: boolean; path: string; error?: { code: string; message: string } }> {
  const path = jobQueuePath(dir);
  const temp = path + '.tmp';
  try {
    await mkdir(nodePath.dirname(path), { recursive: true });
    await writeFile(temp, JSON.stringify(queue, null, 2) + '\n', 'utf8');
    await rename(temp, path);
    return { ok: true, path };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    return {
      ok: false,
      path,
      error: { code: 'kb.job.write-failed', message: describeError(error) },
    };
  }
}

/**
 * Add a job. Re-enqueueing an identical job while it is still pending returns the queued one
 * instead of piling up duplicates; once it is running or finished, a new one is added.
 */
export function enqueueJob(
  queue: JobQueue,
  input: {
    kind: JobKind;
    vault: string;
    label?: string;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
    now?: string;
  },
): { queue: JobQueue; job: JobRecord } {
  const now = nowIso(input.now);
  const vault = input.vault;
  const label = asNonEmpty(input.label) ?? input.kind + ' ' + (nodePath.basename(vault) || vault);

  const existing = queue.jobs.find(
    (job) => job.status === 'pending' && job.kind === input.kind && job.vault === vault && job.label === label,
  );
  if (existing !== undefined) return { queue, job: existing };

  const job: JobRecord = {
    id: makeJobId(input.kind, now),
    kind: input.kind,
    vault,
    label,
    payload: { ...(input.payload ?? {}) },
    status: 'pending',
    attempts: 0,
    maxAttempts: clampMaxAttempts(input.maxAttempts),
    createdAt: now,
    updatedAt: now,
  };
  return { queue: { version: queue.version, jobs: [...queue.jobs, job] }, job };
}

/** Take the oldest pending job and mark it running. */
export function claimNextJob(
  queue: JobQueue,
  now?: string,
): { queue: JobQueue; job?: JobRecord; reason?: string } {
  const at = nowIso(now);
  const pending = queue.jobs.filter((job) => job.status === 'pending');
  if (pending.length === 0) {
    const running = queue.jobs.find((job) => job.status === 'running');
    if (running !== undefined) return { queue, reason: 'kb.job.busy: ' + running.id + ' is still running' };
    return { queue, reason: 'kb.job.empty: nothing queued' };
  }

  const next = [...pending].sort(compareOldest)[0];
  if (next === undefined) return { queue, reason: 'kb.job.empty: nothing queued' };
  const index = queue.jobs.indexOf(next);
  const claimed: JobRecord = {
    ...next,
    status: 'running',
    attempts: next.attempts + 1,
    startedAt: at,
    updatedAt: at,
  };
  const jobs = [...queue.jobs];
  jobs[index] = claimed;
  return { queue: { version: queue.version, jobs }, job: claimed };
}

/**
 * Record an attempt's outcome. A failure below maxAttempts returns the job to pending (the
 * next claim picks it up again); a failure at the limit is terminal.
 */
export function finishJob(
  queue: JobQueue,
  id: string,
  outcome: { ok: boolean; result?: Record<string, unknown>; error?: string },
  now?: string,
): { queue: JobQueue; job?: JobRecord } {
  const at = nowIso(now);
  const index = queue.jobs.findIndex((job) => job.id === id);
  if (index < 0) return { queue };
  const current = queue.jobs[index];
  if (current === undefined) return { queue };

  const { lastError: _previousError, result: _previousResult, ...rest } = current;
  let next: JobRecord;
  if (outcome.ok) {
    next = {
      ...rest,
      status: 'done',
      updatedAt: at,
      finishedAt: at,
      ...(outcome.result === undefined ? {} : { result: { ...outcome.result } }),
    };
  } else {
    const message = asNonEmpty(outcome.error) ?? 'kb.job.failed: the job failed';
    if (current.attempts < current.maxAttempts) {
      const { startedAt: _started, finishedAt: _finished, ...retryable } = rest;
      next = { ...retryable, status: 'pending', lastError: message, updatedAt: at };
    } else {
      next = { ...rest, status: 'failed', lastError: message, finishedAt: at, updatedAt: at };
    }
  }

  const jobs = [...queue.jobs];
  jobs[index] = next;
  return { queue: { version: queue.version, jobs }, job: next };
}

/** Stop a job that has not finished yet. Done and cancelled jobs are already settled. */
export function cancelJob(
  queue: JobQueue,
  id: string,
  now?: string,
): { queue: JobQueue; job?: JobRecord } {
  const at = nowIso(now);
  const index = queue.jobs.findIndex((job) => job.id === id);
  if (index < 0) return { queue };
  const current = queue.jobs[index];
  if (current === undefined) return { queue };
  if (current.status === 'done' || current.status === 'cancelled') return { queue, job: current };

  const next: JobRecord = { ...current, status: 'cancelled', finishedAt: at, updatedAt: at };
  const jobs = [...queue.jobs];
  jobs[index] = next;
  return { queue: { version: queue.version, jobs }, job: next };
}

/**
 * Repair the queue after an unclean shutdown. A running job was interrupted, not failed, so it
 * goes back to pending with a note and keeps its attempt count.
 */
export function recoverQueue(queue: JobQueue, now?: string): { queue: JobQueue; recovered: number } {
  const at = nowIso(now);
  let recovered = 0;
  const jobs: JobRecord[] = queue.jobs.map((job): JobRecord => {
    if (job.status !== 'running') return job;
    recovered += 1;
    const { startedAt: _started, finishedAt: _finished, ...rest } = job;
    return { ...rest, status: 'pending', lastError: INTERRUPTED, updatedAt: at };
  });
  if (recovered === 0) return { queue, recovered };
  return { queue: { version: queue.version, jobs }, recovered };
}

export function queueSummary(queue: JobQueue): {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  byKind: Record<string, number>;
} {
  const counts: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  const byKind: Record<string, number> = {};
  for (const job of queue.jobs) {
    counts[job.status] += 1;
    byKind[job.kind] = (byKind[job.kind] ?? 0) + 1;
  }
  return { total: queue.jobs.length, ...counts, byKind };
}

/**
 * Drop old finished jobs. Pending, running and failed jobs are never pruned: the first two are
 * live work, and a failed job is evidence the user may still want to inspect or retry.
 */
export function pruneQueue(
  queue: JobQueue,
  options?: { keepDone?: number },
): { queue: JobQueue; removed: number } {
  const keep = clampKeepDone(options?.keepDone);
  const terminal = queue.jobs.filter(
    (job) => job.status === 'done' || job.status === 'cancelled',
  );
  if (terminal.length <= keep) return { queue, removed: 0 };

  const kept = new Set<JobRecord>([...terminal].sort(compareNewest).slice(0, keep));
  const jobs = queue.jobs.filter(
    (job) => (job.status !== 'done' && job.status !== 'cancelled') || kept.has(job),
  );
  const removed = queue.jobs.length - jobs.length;
  if (removed === 0) return { queue, removed: 0 };
  return { queue: { version: queue.version, jobs }, removed };
}

function emptyQueue(): JobQueue {
  return { version: QUEUE_VERSION, jobs: [] };
}

function makeJobId(kind: JobKind, now: string): string {
  const parsed = Date.parse(now);
  const stamp = Number.isFinite(parsed) ? parsed : Date.now();
  return kind + '-' + stamp.toString(36) + '-' + randomSuffix(4);
}

/** Four base36 characters, enough to separate jobs enqueued in the same millisecond. */
function randomSuffix(length: number): string {
  let suffix = '';
  for (const byte of randomBytes(length)) suffix += (byte % 36).toString(36);
  return suffix;
}

function nowIso(now?: string): string {
  const candidate = typeof now === 'string' ? now.trim() : '';
  return candidate !== '' ? candidate : new Date().toISOString();
}

function normalizeJob(entry: unknown, index: number): { job: JobRecord } | { warning: string } {
  if (!isPlainObject(entry)) {
    return { warning: 'kb.job.invalid: job at index ' + index + ' is not an object' };
  }
  const raw = entry;
  const id = asString(raw.id);
  if (id === '') return { warning: 'kb.job.invalid: job at index ' + index + ' has no id' };
  if (!isJobKind(raw.kind)) {
    return { warning: 'kb.job.invalid: job ' + id + ' has unknown kind "' + asString(raw.kind) + '"' };
  }
  if (!isJobStatus(raw.status)) {
    return { warning: 'kb.job.invalid: job ' + id + ' has unknown status "' + asString(raw.status) + '"' };
  }

  const createdAt = asString(raw.createdAt) || ZERO_TIME;
  const startedAt = asString(raw.startedAt);
  const finishedAt = asString(raw.finishedAt);
  const lastError = asString(raw.lastError);
  const result = asPlainObject(raw.result);
  const job: JobRecord = {
    id,
    kind: raw.kind,
    vault: asString(raw.vault),
    label: asString(raw.label) || raw.kind + ' ' + (nodePath.basename(asString(raw.vault)) || asString(raw.vault)),
    payload: asPlainObject(raw.payload) ?? {},
    status: raw.status,
    attempts: asCount(raw.attempts),
    maxAttempts: clampMaxAttempts(raw.maxAttempts),
    createdAt,
    updatedAt: asString(raw.updatedAt) || createdAt,
    ...(startedAt === '' ? {} : { startedAt }),
    ...(finishedAt === '' ? {} : { finishedAt }),
    ...(lastError === '' ? {} : { lastError }),
    ...(result === undefined ? {} : { result }),
  };
  return { job };
}

function compareOldest(a: JobRecord, b: JobRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function compareNewest(a: JobRecord, b: JobRecord): number {
  const at = a.finishedAt ?? a.updatedAt ?? a.createdAt;
  const bt = b.finishedAt ?? b.updatedAt ?? b.createdAt;
  if (at !== bt) return at < bt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function clampMaxAttempts(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(ATTEMPT_LIMIT, Math.max(1, Math.trunc(value)));
}

function clampKeepDone(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_KEEP_DONE;
  return Math.max(0, Math.trunc(value));
}

function asCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
