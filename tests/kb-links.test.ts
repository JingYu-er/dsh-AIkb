import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { NodeNotesFs } from '../src/adapters/fs/notes-fs.js';
import { runLint } from '../src/application/kb-lint.js';
import {
  appendAssociation,
  applyLinks,
  backupPathFor,
  judgeDirection,
  parseQueue,
  queuePathFor,
  renderQueue,
  reviewLinks,
} from '../src/application/kb-links.js';

async function makeVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-aikb-links-'));
  for (const [rel, content] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  return root;
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function note(type: string, title: string, body: string): string {
  return ['---', 'type: ' + type, 'title: ' + title, '---', '', '# ' + title, '', body].join('\n');
}

const SHARED = '向量检索把文本映射到同一个向量空间，用余弦相似度找最近的片段，再用倒排索引与词频加权做混合排序。';

const QUEUE_HEADER = [
  '---',
  'type: link-queue',
  'note: 学习/乙.md',
  'generated: 2026-11-16T00:00:00.000Z',
  '---',
  '',
  '| 状态 | 目标 | 置信度 | 方向 | why（待填） |',
  '| --- | --- | --- | --- | --- |',
];

test('judgeDirection implements the SCHEMA direction table', () => {
  assert.equal(judgeDirection('thought', 'concept').allowed, true);
  assert.equal(judgeDirection('thought', 'concept').warning, undefined);
  assert.equal(judgeDirection('moc', 'source').allowed, true);
  assert.equal(judgeDirection('source', 'source').allowed, false);
  assert.equal(judgeDirection('draft', 'concept').allowed, false);
  assert.match(judgeDirection('thought', 'thought').warning ?? '', /同层/);
  assert.match(judgeDirection('concept', 'concept').warning ?? '', /上下位/);
});

test('queue render/parse round-trips why text with pipes and marks applied rows', () => {
  const text = renderQueue({
    note: '学习/笔记/向量检索.md',
    generated: '2026-11-16T00:00:00.000Z',
    rows: [
      { target: '概念 A', confidence: 0.62, direction: 'thought→concept', why: '', applied: false },
      { target: '概念 B', confidence: 0.51, direction: 'thought→concept', why: '支撑 | 判断', applied: true },
    ],
  });
  assert.ok(text.includes('type: link-queue'));
  assert.ok(text.includes('note: 学习/笔记/向量检索.md'));
  const queue = parseQueue('inbox/links/x.md', text);
  assert.equal(queue.note, '学习/笔记/向量检索.md');
  assert.equal(queue.rows.length, 2);
  assert.deepEqual(queue.rows[0], { target: '概念 A', confidence: 0.62, direction: 'thought→concept', why: '', applied: false });
  assert.equal(queue.rows[1]?.why, '支撑 | 判断');
  assert.equal(queue.rows[1]?.applied, true);
});

test('queuePathFor is path derived and stable', () => {
  assert.equal(queuePathFor('学习/笔记/向量检索.md'), 'inbox/links/学习__笔记__向量检索.md');
});

test('reviewLinks writes a queue with an empty why and never touches formal notes', async () => {
  const root = await makeVault({
    '学习/向量检索判断.md': note('thought', '向量检索判断', SHARED + ' 这是判断。'),
    '概念/向量检索.md': note('concept', '向量检索', SHARED),
    '学习/无关.md': note('thought', '无关', '完全无关的内容：做饭、跑步、睡眠。'),
  });
  const fs = new NodeNotesFs(root);
  try {
    const preview = await reviewLinks(fs, root);
    assert.ok(preview.candidates >= 1);
    const queuePath = queuePathFor('学习/向量检索判断.md');
    await assert.rejects(readFile(path.join(root, queuePath), 'utf8'), 'dry run must not write queues');

    const written = await reviewLinks(fs, root, { write: true });
    assert.equal(written.written, true);
    const queue = parseQueue(queuePath, await readFile(path.join(root, queuePath), 'utf8'));
    assert.equal(queue.note, '学习/向量检索判断.md');
    assert.ok(queue.rows.length >= 1);
    assert.ok(queue.rows.every((row) => row.why === ''), 'review never pre-fills why');
    assert.ok(queue.rows.some((row) => row.target === '向量检索'));

    const formal = await readFile(path.join(root, '概念/向量检索.md'), 'utf8');
    assert.ok(!formal.includes('## 关联'), 'review must not edit formal notes');
  } finally {
    await cleanup(root);
  }
});

test('reviewLinks skips links that already exist and rejects source→source', async () => {
  const root = await makeVault({
    '学习/已连.md': note('thought', '已连', SHARED + ' 见 [[向量检索]]。'),
    '概念/向量检索.md': note('concept', '向量检索', SHARED),
    '来源/书一.md': note('source', '书一', SHARED),
    '来源/书二.md': note('source', '书二', SHARED),
  });
  const fs = new NodeNotesFs(root);
  try {
    const report = await reviewLinks(fs, root);
    for (const queue of report.queues) {
      for (const candidate of queue.candidates) {
        assert.ok(!(queue.note.startsWith('来源/') && candidate.to.startsWith('书')), 'source→source must be filtered');
      }
    }
    const existing = report.queues.find((queue) => queue.note === '学习/已连.md');
    assert.ok(existing === undefined || !existing.candidates.some((candidate) => candidate.to === '向量检索'));
  } finally {
    await cleanup(root);
  }
});

test('applyLinks previews diffs, applies only approved rows, backs up and marks [x]', async () => {
  const root = await makeVault({
    '学习/乙.md': note('thought', '乙', '乙的判断。'),
    '概念/甲.md': note('concept', '甲', '甲的定义。'),
    '概念/丙.md': note('concept', '丙', '丙的定义。'),
    'inbox/links/学习__乙.md': QUEUE_HEADER.concat([
      '| [ ] | [[甲]] | 0.62 | thought→concept | 支撑判断 |',
      '| [ ] | [[丙]] | 0.51 | thought→concept |  |',
      '| [ ] | [[不存在]] | 0.30 | thought→concept | 待确认 |',
      '',
    ]).join('\n'),
  });
  const fs = new NodeNotesFs(root);
  const queuePath = 'inbox/links/学习__乙.md';
  const now = new Date('2026-11-16T02:03:04.000Z');
  try {
    const preview = await applyLinks(fs, root, { now });
    assert.equal(preview.confirm, false);
    assert.equal(preview.applied, 0);
    assert.equal(preview.pending, 1);
    assert.equal(preview.rows.length, 2);
    assert.equal(preview.rows.some((row) => row.written), false);
    const pendingRow = preview.rows.find((row) => row.skipped === undefined);
    assert.ok(pendingRow !== undefined);
    assert.ok(pendingRow.diff.added > 0);
    assert.equal(preview.rows.find((row) => row.target === '不存在')?.skipped, 'target-not-found');
    assert.ok(!(await readFile(path.join(root, '学习/乙.md'), 'utf8')).includes('## 关联'));

    const applied = await applyLinks(fs, root, { confirm: true, now });
    assert.equal(applied.applied, 1);
    const row = applied.rows.find((entry) => entry.written);
    assert.ok(row !== undefined);
    assert.equal(row.note, '学习/乙.md', 'the approved link is written into the queue owner (the source note)');
    assert.equal(row.target, '甲');
    assert.equal(row.backup, backupPathFor(now, '学习/乙.md'));
    const backup = await readFile(path.join(root, row.backup ?? ''), 'utf8');
    assert.ok(backup.includes('乙的判断。'));
    assert.ok(!backup.includes('## 关联'), 'backup is the pre-write content');

    const source = await readFile(path.join(root, '学习/乙.md'), 'utf8');
    assert.ok(source.includes('## 关联'));
    assert.ok(source.includes('- [[甲]] — 支撑判断'));
    const target = await readFile(path.join(root, '概念/甲.md'), 'utf8');
    assert.ok(!target.includes('## 关联'), 'target note is not touched');

    const rewritten = await readFile(path.join(root, queuePath), 'utf8');
    const queue = parseQueue(queuePath, rewritten);
    assert.equal(queue.rows.find((entry) => entry.target === '甲')?.applied, true);
    assert.equal(queue.rows.find((entry) => entry.target === '丙')?.applied, false);

    const log = await readFile(path.join(root, 'log.md'), 'utf8');
    assert.match(log, /\| link \| 学习\/乙\.md \|/);
  } finally {
    await cleanup(root);
  }
});

test('appendAssociation appends at the end of an existing section and preserves CRLF', () => {
  const existing = ['# 判断', '', '## 关联', '', '- [[旧]] — 旧理由', '', '## 其他', '', '内容'].join('\n');
  const next = appendAssociation(existing, '新', '新理由');
  assert.ok(next.includes('- [[旧]] — 旧理由\n- [[新]] — 新理由\n\n## 其他'));
  const crlf = appendAssociation(['# 判断', '', '正文'].join('\r\n'), '新', '理由');
  assert.ok(crlf.includes('\r\n## 关联\r\n'));
});

const LINT_FILES: Record<string, string> = {
  'thought-a.md': '---\ntype: thought\n---\n\n## 关联\n\n- [[concept-a]] 没有说明理由',
  'concept-a.md': '---\ntype: concept\n---\n\n定义。',
  'source-a.md': '---\ntype: source\n---\n\n[[source-b]]',
  'source-b.md': '---\ntype: source\n---\n\n书。',
  'thought-b.md': '---\ntype: thought\n---\n\n[[thought-c]]',
  'thought-c.md': '---\ntype: thought\n---\n\n[[concept-a]]',
  'flood.md': '---\ntype: thought\n---\n\n' + Array.from({ length: 31 }, (_, index) => '[[concept-a]]').join(' '),
  'orphan.md': '---\ntype: concept\n---\n\n没有人链接这里。',
  'index.md': '# 索引',
  'moc.md': '---\ntype: moc\n---\n\n地图。',
};

const lintFs = {
  listFiles: async () => Object.keys(LINT_FILES).map((relPath) => ({ relPath })),
  readText: async (relPath: string) => LINT_FILES[relPath] ?? '',
};

test('lint reports link-missing-why for 关联 entries without a reason', async () => {
  const report = await runLint(lintFs, '/vault');
  const finding = report.findings.find((entry) => entry.rule === 'link-missing-why');
  assert.ok(finding !== undefined);
  assert.equal(finding.path, 'thought-a.md');
  assert.match(finding.detail, /缺少 why/);
});

test('lint reports link-wrong-direction for source→source and thought→thought', async () => {
  const report = await runLint(lintFs, '/vault');
  const findings = report.findings.filter((entry) => entry.rule === 'link-wrong-direction');
  const paths = findings.map((entry) => entry.path);
  assert.ok(paths.includes('source-a.md'));
  assert.ok(paths.includes('thought-b.md'));
});

test('lint reports link-flood above 30 outlinks', async () => {
  const report = await runLint(lintFs, '/vault');
  const finding = report.findings.find((entry) => entry.rule === 'link-flood');
  assert.ok(finding !== undefined);
  assert.equal(finding.path, 'flood.md');
  assert.match(finding.detail, /outlinks=31/);
});

test('lint reports orphan for a note with no inbound link and skips index/moc', async () => {
  const report = await runLint(lintFs, '/vault');
  const paths = report.findings.filter((entry) => entry.rule === 'orphan').map((entry) => entry.path);
  assert.ok(paths.includes('orphan.md'));
  assert.ok(!paths.includes('index.md'));
  assert.ok(!paths.includes('moc.md'));
});

test('applyLinks reports already-linked rows without writing twice', async () => {
  const root = await makeVault({
    '学习/乙.md': note('thought', '乙', '正文。\n\n## 关联\n\n- [[甲]] — 已在'),
    '概念/甲.md': note('concept', '甲', '正文。'),
    'inbox/links/q.md': [
      '---',
      'type: link-queue',
      'note: 学习/乙.md',
      'generated: 2026-11-16T00:00:00.000Z',
      '---',
      '',
      '| 状态 | 目标 | 置信度 | 方向 | why（待填） |',
      '| --- | --- | --- | --- | --- |',
      '| [ ] | [[甲]] | 0.62 | thought→concept | 理由 |',
    ].join('\n'),
  });
  const fs = new NodeNotesFs(root);
  try {
    const report = await applyLinks(fs, root, { confirm: true });
    assert.equal(report.applied, 0);
    assert.equal(report.skipped, 1);
    assert.equal(report.rows[0]?.skipped, 'already-linked');
    const source = await readFile(path.join(root, '学习/乙.md'), 'utf8');
    assert.equal(source.split('[[甲]]').length - 1, 1);
  } finally {
    await cleanup(root);
  }
});
