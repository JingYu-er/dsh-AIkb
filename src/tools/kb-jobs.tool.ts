import {
  cancelJob,
  enqueueJob,
  loadQueue,
  pruneQueue,
  recoverQueue,
  queueSummary,
  saveQueue,
} from '../application/job-queue.js';
import type { JobKind, JobQueue, JobRecord } from '../application/job-queue.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbJobsArgs {
  readonly action?: 'list' | 'enqueue' | 'cancel' | 'recover' | 'prune' | 'summary';
  readonly kind?: JobKind;
  readonly label?: string;
  readonly vault?: string;
  readonly payload?: Record<string, unknown>;
  readonly maxAttempts?: number;
  readonly id?: string;
  readonly keepDone?: number;
  readonly status?: string;
}

export interface KbJobsDeps {
  /** Queue directory; empty means the module default (~/.dsh-aikb/jobs, or KB_JOBS_DIR). */
  readonly queueDir: () => string;
}

export interface KbJobsReport {
  readonly ok: boolean;
  readonly path: string;
  readonly action: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly summary: { readonly total: number; readonly pending: number; readonly running: number; readonly done: number; readonly failed: number; readonly cancelled: number; readonly byKind: Record<string, number> };
  readonly jobs: readonly JobRecord[];
  readonly warnings: readonly string[];
}

const LINE_FEED = String.fromCharCode(10);
const KINDS: readonly JobKind[] = ['ingest', 'judge', 'embed'];

const JOB_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    vault: { type: 'string', required: true },
    label: { type: 'string', required: true },
    payload: { type: 'object', additionalProperties: true },
    status: { type: 'string', required: true },
    attempts: { type: 'integer', required: true },
    maxAttempts: { type: 'integer', required: true },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
    startedAt: { type: 'string' },
    finishedAt: { type: 'string' },
    lastError: { type: 'string' },
    result: { type: 'object', additionalProperties: true },
  },
};

const SUMMARY_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer', required: true },
    pending: { type: 'integer', required: true },
    running: { type: 'integer', required: true },
    done: { type: 'integer', required: true },
    failed: { type: 'integer', required: true },
    cancelled: { type: 'integer', required: true },
    byKind: { type: 'object', additionalProperties: true, required: true },
  },
};

const OUTPUT_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    path: { type: 'string', required: true },
    action: { type: 'string', required: true },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    summary: { ...SUMMARY_SCHEMA, required: true },
    jobs: { type: 'array', items: JOB_SCHEMA, required: true },
    warnings: { type: 'array', items: { type: 'string' }, required: true },
  },
};

function renderReport(report: KbJobsReport): string {
  if (!report.ok && report.error !== undefined) return 'kb_jobs refused [' + report.error.code + '] ' + report.error.message;
  const summary = report.summary;
  const lines = [
    'queue: ' + report.path + ' | ' + summary.total + ' job(s): '
      + summary.pending + ' pending, ' + summary.running + ' running, ' + summary.failed + ' failed, '
      + summary.done + ' done, ' + summary.cancelled + ' cancelled',
  ];
  for (const job of report.jobs) {
    lines.push('  [' + job.status + '] ' + job.id + ' ' + job.kind + ' ' + job.label
      + ' (attempt ' + job.attempts + '/' + job.maxAttempts + ')'
      + (job.lastError === undefined ? '' : ' ! ' + job.lastError));
  }
  for (const warning of report.warnings) lines.push('! ' + warning);
  return lines.join(LINE_FEED);
}

function filterJobs(queue: JobQueue, status: string): readonly JobRecord[] {
  const wanted = status.trim().toLowerCase();
  const jobs = wanted === '' || wanted === 'all' ? queue.jobs : queue.jobs.filter((job) => job.status === wanted);
  return jobs.slice(-50);
}

export function createKbJobsTool(deps: KbJobsDeps) {
  return defineTool<KbJobsArgs, KbJobsReport>({
    name: 'kb_jobs',
    description:
      'Manage the durable job queue (one JSON file, survives restarts): list or summarise jobs, enqueue an ingest/judge/embed job for a vault, cancel one, recover jobs that a crash left running, or prune finished history. Jobs carry kind, vault, payload, attempts and maxAttempts so a retry decision is visible; this tool only owns the queue, the worker is the KB panel.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'enqueue', 'cancel', 'recover', 'prune', 'summary'],
        description: 'Default list. summary returns counts only; recover turns running jobs back into pending.',
      },
      kind: { type: 'string', enum: ['ingest', 'judge', 'embed'], description: 'enqueue: which worker the job belongs to.' },
      label: { type: 'string', description: 'enqueue: short human label; defaults to "<kind> <vault>". An identical pending job is reused.' },
      vault: { type: 'string', description: 'enqueue: absolute vault path the job works on.' },
      payload: { type: 'object', additionalProperties: true, description: 'enqueue: worker parameters, for example {limit: 5} or {path: "inbox/a.md"}. Stored verbatim.' },
      maxAttempts: { type: 'integer', description: 'enqueue: retries before the job is marked failed (1-10, default 3).' },
      id: { type: 'string', description: 'cancel: job id.' },
      keepDone: { type: 'integer', description: 'prune: how many finished jobs to keep (default 50).' },
      status: { type: 'string', description: 'list: only jobs in this status (pending, running, done, failed, cancelled, or all).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      const action = args.action ?? 'list';
      const dir = deps.queueDir();
      const loaded = await loadQueue(dir === '' ? undefined : dir);
      let queue = loaded.queue;
      let error: KbJobsReport['error'];
      if (action === 'enqueue') {
        const vault = String(args.vault ?? '').trim();
        const kind = String(args.kind ?? '').trim() as JobKind;
        if (vault === '') error = { code: 'kb.job.invalid', message: 'vault is required: pass the absolute vault path the job works on' };
        else if (!KINDS.includes(kind)) error = { code: 'kb.job.invalid', message: 'kind must be one of ' + KINDS.join(', ') };
        else {
          const enqueued = enqueueJob(queue, {
            kind,
            vault,
            ...(args.label === undefined ? {} : { label: args.label }),
            ...(args.payload === undefined ? {} : { payload: args.payload }),
            ...(args.maxAttempts === undefined ? {} : { maxAttempts: args.maxAttempts }),
          });
          queue = enqueued.queue;
        }
      } else if (action === 'cancel') {
        const cancelled = cancelJob(queue, String(args.id ?? ''));
        queue = cancelled.queue;
        if (cancelled.job === undefined) error = { code: 'kb.job.unknown', message: 'no job with id ' + String(args.id ?? '') };
      } else if (action === 'recover') {
        queue = recoverQueue(queue).queue;
      } else if (action === 'prune') {
        queue = pruneQueue(queue, args.keepDone === undefined ? {} : { keepDone: args.keepDone }).queue;
      }
      if (error === undefined && action !== 'list' && action !== 'summary') {
        const saved = await saveQueue(queue, dir === '' ? undefined : dir);
        if (!saved.ok) error = saved.error;
      }
      return {
        ok: error === undefined,
        path: loaded.path,
        action,
        ...(error === undefined ? {} : { error }),
        summary: queueSummary(queue),
        jobs: action === 'summary' ? [] : filterJobs(queue, String(args.status ?? '')),
        warnings: loaded.warnings,
      };
    },
  });
}
