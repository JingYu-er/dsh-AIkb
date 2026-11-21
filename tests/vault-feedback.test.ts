import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFeedback, feedbackPath, markFeedbackDone, parseFeedback, readFeedback } from '../src/application/vault-feedback.js';

const NL = String.fromCharCode(10);

const makeVault = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-aikb-feedback-'));
  return dir;
};

test('appending feedback creates the inbox queue with a header', async () => {
  const vault = makeVault();
  try {
    const written = await appendFeedback(vault, { note: '学习/a.md', text: '公式编号和正文对不上' }, { allowWrites: true });
    assert.equal(written.ok, true);
    assert.equal(written.index, 0);
    const text = readFileSync(feedbackPath(vault), 'utf8');
    assert.ok(text.startsWith('# 页面反馈'), 'a new queue starts with a heading');
    assert.match(text, /- \[ \] \d{4}-\d{2}-\d{2}T[\d:]+Z · \[\[学习\/a\.md\]\] — 公式编号和正文对不上/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('rows parse in order and keep their state', async () => {
  const vault = makeVault();
  try {
    await appendFeedback(vault, { note: 'a.md', text: 'first', now: new Date('2026-01-02T03:04:05Z') }, { allowWrites: true });
    await appendFeedback(vault, { note: 'b.md', text: 'second', now: new Date('2026-01-03T03:04:05Z') }, { allowWrites: true });
    const report = await readFeedback(vault);
    assert.equal(report.exists, true);
    assert.deepEqual(report.rows.map((row) => row.note), ['a.md', 'b.md']);
    assert.deepEqual(report.rows.map((row) => row.done), [false, false]);
    assert.equal(report.rows[0]?.at, '2026-01-02T03:04:05Z');
    await markFeedbackDone(vault, 0, { allowWrites: true });
    const after = await readFeedback(vault);
    assert.deepEqual(after.rows.map((row) => row.done), [true, false]);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('writing needs allowWrites before touching the file', async () => {
  const vault = makeVault();
  try {
    const refused = await appendFeedback(vault, { note: 'a.md', text: 'x' }, { allowWrites: false });
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, 'kb.feedback.read-only');
    assert.equal(existsSync(feedbackPath(vault)), false);
    const marked = await markFeedbackDone(vault, 0, { allowWrites: true });
    assert.equal(marked.ok, false);
    assert.equal(marked.error?.code, 'kb.feedback.missing-index');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('empty and oversized feedback are refused', async () => {
  const vault = makeVault();
  try {
    const blank = await appendFeedback(vault, { note: 'a.md', text: '   ' }, { allowWrites: true });
    assert.equal(blank.error?.code, 'kb.feedback.empty');
    const noNote = await appendFeedback(vault, { note: '', text: 'x' }, { allowWrites: true });
    assert.equal(noNote.error?.code, 'kb.feedback.empty');
    const big = await appendFeedback(vault, { note: 'a.md', text: 'x'.repeat(2100) }, { allowWrites: true });
    assert.equal(big.error?.code, 'kb.feedback.too-large');
    assert.equal(existsSync(feedbackPath(vault)), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('hand-written rows are parsed and markable', async () => {
  const vault = makeVault();
  try {
    mkdirSync(join(vault, 'inbox'), { recursive: true });
    const text = '# 页面反馈' + NL + NL + '- [ ] 2026-02-01T00:00:00Z · [[x.md]] — 说明一' + NL + '- [x] 2026-02-02T00:00:00Z · [[y.md]] — 说明二' + NL;
    writeFileSync(feedbackPath(vault), text, 'utf8');
    const rows = parseFeedback(text);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.done), [false, true]);
    const marked = await markFeedbackDone(vault, 0, { allowWrites: true });
    assert.equal(marked.ok, true);
    const after = readFileSync(feedbackPath(vault), 'utf8');
    assert.match(after, /- \[x\] 2026-02-01T00:00:00Z/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('an absent queue reads as empty, not as a failure', async () => {
  const vault = makeVault();
  try {
    const report = await readFeedback(vault);
    assert.deepEqual(report.rows, []);
    assert.equal(report.exists, false);
    assert.equal(feedbackPath(vault), join(vault, 'inbox', 'feedback.md'));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});