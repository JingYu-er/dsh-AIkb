import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  QUEUE_VERSION,
  cancelJob,
  claimNextJob,
  enqueueJob,
  finishJob,
  jobQueueDir,
  jobQueuePath,
  loadQueue,
  pruneQueue,
  queueSummary,
  recoverQueue,
  saveQueue,
} from '../src/application/job-queue.js';
import type { JobQueue, JobRecord } from '../src/application/job-queue.js';

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), 'aikb-jobs-' + label + '-'));
}

function empty(): JobQueue {
  return { version: QUEUE_VERSION, jobs: [] };
}

function queueOf(...jobs: JobRecord[]): JobQueue {
  return { version: QUEUE_VERSION, jobs };
}

function makeJob(overrides: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    id: overrides.id,
    kind: overrides.kind ?? 'ingest',
    vault: overrides.vault ?? '/books',
    label: overrides.label ?? 'ingest books',
    payload: overrides.payload ?? {},
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00.000Z',
    ...(overrides.startedAt === undefined ? {} : { startedAt: overrides.startedAt }),
    ...(overrides.finishedAt === undefined ? {} : { finishedAt: overrides.finishedAt }),
    ...(overrides.lastError === undefined ? {} : { lastError: overrides.lastError }),
    ...(overrides.result === undefined ? {} : { result: overrides.result }),
  };
}

test('a missing queue file loads as an empty version 1 queue', async () => {
  const dir = tempDir('empty');
  try {
    const loaded = await loadQueue(dir);
    assert.deepEqual(loaded.queue, { version: QUEUE_VERSION, jobs: [] });
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.path, jobQueuePath(dir));
    assert.ok(loaded.path.startsWith(resolve(dir)), 'queue lives under the requested directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt or structurally wrong files degrade to an empty queue with a warning', async () => {
  const dir = tempDir('corrupt');
  try {
    writeFileSync(jobQueuePath(dir), '{ not json', 'utf8');
    const broken = await loadQueue(dir);
    assert.deepEqual(broken.queue, { version: QUEUE_VERSION, jobs: [] });
    assert.equal(broken.warnings.length, 1);
    assert.ok(broken.warnings[0]?.startsWith('kb.job.corrupt: ' + broken.path + ' ('));

    writeFileSync(jobQueuePath(dir), '[]', 'utf8');
    const wrongShape = await loadQueue(dir);
    assert.deepEqual(wrongShape.queue.jobs, []);
    assert.equal(wrongShape.warnings.length, 1);
    assert.ok(wrongShape.warnings[0]?.startsWith('kb.job.corrupt: '));

    writeFileSync(jobQueuePath(dir), JSON.stringify({ version: 1, jobs: {} }), 'utf8');
    const notArray = await loadQueue(dir);
    assert.deepEqual(notArray.queue.jobs, []);
    assert.equal(notArray.warnings.length, 1);
    assert.ok(notArray.warnings[0]?.includes('jobs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid jobs are dropped one by one and the valid ones survive', async () => {
  const dir = tempDir('invalid');
  try {
    const good = makeJob({ id: 'ingest-good' });
    writeFileSync(
      jobQueuePath(dir),
      JSON.stringify({
        version: 1,
        jobs: [
          good,
          { kind: 'ingest', status: 'pending' },
          { id: 'judge-x', kind: 'summarise', status: 'pending' },
          { id: 'judge-y', kind: 'judge', status: 'sleeping' },
          'nope',
        ],
      }),
      'utf8',
    );
    const loaded = await loadQueue(dir);
    assert.equal(loaded.queue.jobs.length, 1);
    assert.equal(loaded.queue.jobs[0]?.id, 'ingest-good');
    assert.equal(loaded.warnings.length, 4);
    for (const warning of loaded.warnings) {
      assert.ok(warning.startsWith('kb.job.invalid: '), warning);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveQueue round-trips and leaves no temp file behind', async () => {
  const dir = tempDir('roundtrip');
  try {
    const enqueued = enqueueJob(empty(), {
      kind: 'judge',
      vault: '/books/manuals',
      now: '2024-02-01T00:00:00.000Z',
    });
    const saved = await saveQueue(enqueued.queue, dir);
    assert.equal(saved.ok, true);
    assert.equal(saved.path, jobQueuePath(dir));
    assert.ok(existsSync(saved.path));
    assert.ok(!existsSync(saved.path + '.tmp'), 'the temp file is renamed, not left behind');
    assert.deepEqual(readdirSync(dir), ['queue.json']);

    const loaded = await loadQueue(dir);
    assert.deepEqual(loaded.queue, enqueued.queue);
    assert.deepEqual(loaded.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveQueue reports kb.job.write-failed instead of throwing', async () => {
  const dir = tempDir('write-fail');
  try {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'x', 'utf8');
    const saved = await saveQueue(empty(), join(blocked, 'nested'));
    assert.equal(saved.ok, false);
    assert.equal(saved.error?.code, 'kb.job.write-failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enqueueJob fills defaults, clamps attempts and reuses an identical pending job', () => {
  const now = '2024-03-01T00:00:00.000Z';
  const first = enqueueJob(empty(), { kind: 'judge', vault: '/books/manuals', now });
  assert.equal(first.job.label, 'judge manuals');
  assert.equal(first.job.status, 'pending');
  assert.equal(first.job.attempts, 0);
  assert.equal(first.job.maxAttempts, 3);
  assert.equal(first.job.createdAt, now);
  assert.equal(first.job.updatedAt, now);
  assert.match(first.job.id, /^judge-[0-9a-z]+-[0-9a-z]{4}$/);
  assert.equal(first.queue.jobs.length, 1);

  const again = enqueueJob(first.queue, {
    kind: 'judge',
    vault: '/books/manuals',
    payload: { page: 3 },
    now,
  });
  assert.equal(again.queue.jobs.length, 1, 'an identical pending job is returned, not duplicated');
  assert.equal(again.job.id, first.job.id);
  assert.deepEqual(again.job.payload, {}, 'the existing job is not rewritten');

  assert.equal(enqueueJob(empty(), { kind: 'ingest', vault: '/v', maxAttempts: 0, now }).job.maxAttempts, 1);
  assert.equal(enqueueJob(empty(), { kind: 'ingest', vault: '/v', maxAttempts: 99, now }).job.maxAttempts, 10);

  const other = enqueueJob(first.queue, {
    kind: 'judge',
    vault: '/books/manuals',
    label: 'manual re-judge',
    now,
  });
  assert.equal(other.queue.jobs.length, 2, 'a different label is a different job');
});

test('an identical job may be enqueued again once the first is no longer pending', () => {
  const now = '2024-03-02T00:00:00.000Z';
  const queued = enqueueJob(empty(), { kind: 'embed', vault: '/v', now });
  const running = claimNextJob(queued.queue, now);
  const duplicate = enqueueJob(running.queue, { kind: 'embed', vault: '/v', now });
  assert.equal(duplicate.queue.jobs.length, 2);
  assert.notEqual(duplicate.job.id, queued.job.id);
  assert.equal(duplicate.job.status, 'pending');
});

test('claimNextJob takes the oldest pending job and marks it running', () => {
  const late = enqueueJob(empty(), {
    kind: 'ingest',
    vault: '/v',
    label: 'late',
    now: '2024-01-01T00:00:02.000Z',
  });
  const early = enqueueJob(late.queue, {
    kind: 'judge',
    vault: '/v',
    label: 'early',
    now: '2024-01-01T00:00:01.000Z',
  });
  const claimed = claimNextJob(early.queue, '2024-01-01T00:00:09.000Z');
  assert.equal(claimed.job?.id, early.job.id);
  assert.equal(claimed.job?.status, 'running');
  assert.equal(claimed.job?.attempts, 1);
  assert.equal(claimed.job?.startedAt, '2024-01-01T00:00:09.000Z');
  assert.equal(claimed.job?.updatedAt, '2024-01-01T00:00:09.000Z');
  assert.equal(claimed.queue.jobs.find((job) => job.id === late.job.id)?.status, 'pending');

  const tieNow = '2024-05-01T00:00:00.000Z';
  const a = enqueueJob(empty(), { kind: 'ingest', vault: '/v', label: 'a', now: tieNow });
  const b = enqueueJob(a.queue, { kind: 'ingest', vault: '/v', label: 'b', now: tieNow });
  const tied = claimNextJob(b.queue, tieNow);
  assert.equal(tied.job?.id, [a.job.id, b.job.id].sort()[0], 'ties break on id');
});

test('claimNextJob explains an empty or busy queue', () => {
  const idle = claimNextJob(empty());
  assert.equal(idle.job, undefined);
  assert.equal(idle.reason, 'kb.job.empty: nothing queued');

  const queued = enqueueJob(empty(), { kind: 'embed', vault: '/v' });
  const running = claimNextJob(queued.queue);
  const busy = claimNextJob(running.queue);
  assert.equal(busy.job, undefined);
  assert.equal(busy.reason, 'kb.job.busy: ' + queued.job.id + ' is still running');
  assert.deepEqual(busy.queue, running.queue, 'a refused claim does not touch the queue');
});

test('a failing job is retried until maxAttempts and then fails', () => {
  const now = '2024-04-01T00:00:00.000Z';
  const queued = enqueueJob(empty(), { kind: 'judge', vault: '/v', maxAttempts: 2, now });
  const id = queued.job.id;

  const first = claimNextJob(queued.queue, now);
  assert.equal(first.job?.attempts, 1);
  const retry = finishJob(first.queue, id, { ok: false, error: 'model timeout' }, now);
  assert.equal(retry.job?.status, 'pending');
  assert.equal(retry.job?.attempts, 1);
  assert.equal(retry.job?.lastError, 'model timeout');
  assert.equal(retry.job?.startedAt, undefined, 'a retried job can be claimed again');
  assert.equal(retry.job?.finishedAt, undefined);

  const second = claimNextJob(retry.queue, now);
  assert.equal(second.job?.attempts, 2);
  const failed = finishJob(second.queue, id, { ok: false, error: 'model timeout again' }, now);
  assert.equal(failed.job?.status, 'failed');
  assert.equal(failed.job?.lastError, 'model timeout again');
  assert.equal(failed.job?.finishedAt, now);
  assert.equal(failed.job?.updatedAt, now);
});

test('finishJob records a successful result and ignores unknown ids', () => {
  const now = '2024-04-02T00:00:00.000Z';
  const queued = enqueueJob(empty(), { kind: 'embed', vault: '/v', now });
  const claimed = claimNextJob(queued.queue, now);
  const done = finishJob(claimed.queue, queued.job.id, { ok: true, result: { vectors: 12 } }, now);
  assert.equal(done.job?.status, 'done');
  assert.deepEqual(done.job?.result, { vectors: 12 });
  assert.equal(done.job?.finishedAt, now);
  assert.equal(done.job?.lastError, undefined);

  const missing = finishJob(done.queue, 'no-such-job', { ok: true }, now);
  assert.equal(missing.job, undefined);
  assert.deepEqual(missing.queue, done.queue);
});

test('cancelJob stops queued, running and failed jobs but never done ones', () => {
  const now = '2024-05-01T00:00:00.000Z';

  const pendingQ = queueOf(makeJob({ id: 'ingest-p' }));
  const cancelledPending = cancelJob(pendingQ, 'ingest-p', now);
  assert.equal(cancelledPending.job?.status, 'cancelled');
  assert.equal(cancelledPending.job?.finishedAt, now);

  const runningQ = queueOf(
    makeJob({ id: 'judge-r', kind: 'judge', status: 'running', attempts: 1, startedAt: now }),
  );
  assert.equal(cancelJob(runningQ, 'judge-r', now).job?.status, 'cancelled');

  const failedQ = queueOf(
    makeJob({ id: 'judge-f', kind: 'judge', status: 'failed', lastError: 'x', finishedAt: now }),
  );
  assert.equal(cancelJob(failedQ, 'judge-f', now).job?.status, 'cancelled');

  const doneQ = queueOf(makeJob({ id: 'embed-d', kind: 'embed', status: 'done', finishedAt: now }));
  const kept = cancelJob(doneQ, 'embed-d', now);
  assert.equal(kept.job?.status, 'done');
  assert.equal(kept.queue, doneQ, 'a done job is left exactly as it was');

  const unknown = cancelJob(doneQ, 'missing', now);
  assert.equal(unknown.job, undefined);
  assert.equal(unknown.queue, doneQ);
});

test('recoverQueue requeues jobs interrupted by a stopped process', () => {
  const now = '2024-06-01T00:00:00.000Z';
  const queue = queueOf(
    makeJob({ id: 'ingest-a', status: 'running', attempts: 1, startedAt: '2024-05-01T00:00:00.000Z' }),
    makeJob({ id: 'judge-b', kind: 'judge', status: 'running', attempts: 2, startedAt: now }),
    makeJob({ id: 'embed-c', kind: 'embed' }),
  );
  const recovered = recoverQueue(queue, now);
  assert.equal(recovered.recovered, 2);

  const a = recovered.queue.jobs.find((job) => job.id === 'ingest-a');
  assert.equal(a?.status, 'pending');
  assert.equal(a?.attempts, 1, 'the interrupted attempt still counts');
  assert.equal(a?.startedAt, undefined);
  assert.equal(a?.updatedAt, now);
  assert.equal(a?.lastError, 'kb.job.interrupted: the process stopped while this job was running');
  assert.equal(recovered.queue.jobs.find((job) => job.id === 'embed-c')?.status, 'pending');
});

test('pruneQueue keeps the newest finished jobs and never touches live or failed work', () => {
  const queue = queueOf(
    makeJob({ id: 'done-1', status: 'done', finishedAt: '2024-01-01T00:00:01.000Z' }),
    makeJob({ id: 'done-2', status: 'done', finishedAt: '2024-01-01T00:00:02.000Z' }),
    makeJob({ id: 'done-3', status: 'done', finishedAt: '2024-01-01T00:00:03.000Z' }),
    makeJob({ id: 'cancelled-4', status: 'cancelled', finishedAt: '2024-01-01T00:00:04.000Z' }),
    makeJob({ id: 'failed-5', status: 'failed', finishedAt: '2024-01-01T00:00:00.000Z' }),
    makeJob({ id: 'pending-6' }),
    makeJob({ id: 'running-7', status: 'running' }),
  );
  const pruned = pruneQueue(queue, { keepDone: 2 });
  assert.equal(pruned.removed, 2);
  assert.deepEqual(
    pruned.queue.jobs.map((job) => job.id),
    ['done-3', 'cancelled-4', 'failed-5', 'pending-6', 'running-7'],
  );

  const untouched = pruneQueue(queue);
  assert.equal(untouched.removed, 0);
  assert.equal(untouched.queue, queue);
});

test('queueSummary counts statuses and kinds', () => {
  const queue = queueOf(
    makeJob({ id: 'a', kind: 'ingest' }),
    makeJob({ id: 'b', kind: 'ingest', status: 'running' }),
    makeJob({ id: 'c', kind: 'judge', status: 'done' }),
    makeJob({ id: 'd', kind: 'judge', status: 'failed' }),
    makeJob({ id: 'e', kind: 'embed', status: 'cancelled' }),
  );
  assert.deepEqual(queueSummary(queue), {
    total: 5,
    pending: 1,
    running: 1,
    done: 1,
    failed: 1,
    cancelled: 1,
    byKind: { ingest: 2, judge: 2, embed: 1 },
  });
});

test('jobQueueDir honours an explicit directory and then KB_JOBS_DIR', () => {
  const dir = tempDir('dir');
  const previous = process.env.KB_JOBS_DIR;
  try {
    process.env.KB_JOBS_DIR = dir;
    assert.equal(jobQueueDir(), resolve(dir));
    assert.equal(jobQueuePath(), join(resolve(dir), 'queue.json'));

    const explicit = join(dir, 'explicit');
    assert.equal(jobQueueDir(explicit), resolve(explicit));
    assert.equal(jobQueuePath(explicit), join(resolve(explicit), 'queue.json'));
    assert.equal(jobQueueDir('   '), resolve(dir), 'a blank argument falls through to the environment');
  } finally {
    if (previous === undefined) delete process.env.KB_JOBS_DIR;
    else process.env.KB_JOBS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
