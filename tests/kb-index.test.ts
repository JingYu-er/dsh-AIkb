import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { NodeNotesFs } from '../src/adapters/fs/notes-fs.js';
import { appendLog, logLine, sanitiseLogField } from '../src/application/kb-log.js';
import { isOrphanEligible, normaliseLinkTarget, runIndex, scanVault } from '../src/application/kb-index.js';

async function makeVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-aikb-index-'));
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

const CONCEPT_A = ['---', 'type: concept', 'title: 概念 A', 'tags:', '  - 检索', '---', '', '# 概念 A', '', '向量的定义。'].join('\n');
const THOUGHT_A = ['---', 'type: thought', 'title: 判断 A', '---', '', '# 判断 A', '', '这里引用了 [[concept-a|概念 A]]。'].join('\n');
const ORPHAN = ['---', 'type: concept', 'title: 孤儿概念', '---', '', '正文。'].join('\n');
const UNTYPED = ['# 没有类型', '', '这条笔记缺 type。'].join('\n');
const BROKEN = ['---', 'type: thought', 'title: 断链', '---', '', '指向 [[不存在的笔记]]。'].join('\n');
const DRAFT = ['---', 'type: draft', 'title: 草稿', '---', '', '草稿正文。'].join('\n');

const FILES: Record<string, string> = {
  'concept-a.md': CONCEPT_A,
  'thought-a.md': THOUGHT_A,
  'orphan-concept.md': ORPHAN,
  'untyped.md': UNTYPED,
  'broken.md': BROKEN,
  'inbox/draft.md': DRAFT,
};

test('scanVault counts types, inbound links, orphans and broken links', async () => {
  const root = await makeVault(FILES);
  try {
    const scan = await scanVault(new NodeNotesFs(root), root);
    assert.equal(scan.stats.notes, 6);
    assert.deepEqual(scan.stats.byType, { concept: 2, thought: 2, source: 0, reference: 0, log: 0, link: 0, moc: 0, draft: 1, unknown: 1 });
    assert.equal(scan.stats.inbox, 1);
    assert.equal(scan.stats.untyped, 1);
    assert.equal(scan.stats.brokenLinks, 1);
    assert.equal(scan.broken[0]?.target, '不存在的笔记');
    assert.equal(scan.stats.orphans, 4, 'thought-a, orphan-concept, untyped and broken all have no inbound link');

    const concept = scan.notes.find((note) => note.path === 'concept-a.md');
    assert.equal(concept?.inbound, 1);
    assert.equal(concept?.outbound, 0);
    assert.equal(concept?.title, '概念 A');
    assert.deepEqual(concept?.tags, ['检索']);
    assert.equal(scan.notes.find((note) => note.path === 'inbox/draft.md')?.type, 'draft');
    assert.equal(scan.notes.find((note) => note.path === 'untyped.md')?.orphan, true);
  } finally {
    await cleanup(root);
  }
});

test('runIndex previews without writing, then writes index.md and one log line', async () => {
  const root = await makeVault(FILES);
  const fs = new NodeNotesFs(root);
  try {
    const preview = await runIndex(fs, root, { now: new Date('2026-11-16T00:00:00.000Z') });
    assert.equal(preview.written, false);
    assert.ok(preview.preview.includes('# 知识库索引'));
    await assert.rejects(readFile(path.join(root, 'index.md'), 'utf8'));

    const written = await runIndex(fs, root, { write: true, now: new Date('2026-11-16T00:00:00.000Z') });
    assert.equal(written.written, true);
    assert.equal(written.stats.notes, 6);

    const index = await readFile(path.join(root, 'index.md'), 'utf8');
    assert.ok(index.includes('## concept (2)'));
    assert.ok(index.includes('- [[concept-a.md|概念 A]] · 入链 1'));
    assert.ok(index.includes('## 孤儿页（无入链）'));
    assert.ok(index.includes('不存在的笔记'));

    const log = await readFile(path.join(root, 'log.md'), 'utf8');
    assert.ok(log.includes('# 操作日志'));
    assert.match(log, /- \d{4}-\d{2}-\d{2}T[\d:.]+Z \| index \| index\.md \| 6 notes, 4 orphans, 1 broken links/);

    const rescan = await scanVault(fs, root);
    assert.equal(rescan.stats.notes, 6, 'index.md and log.md are generated and must not enter the catalog');
  } finally {
    await cleanup(root);
  }
});

test('appendLog creates the header once and appends sanitised lines', async () => {
  const root = await makeVault({});
  const fs = new NodeNotesFs(root);
  try {
    await appendLog(fs, 'promote', '学习/笔记/a.md', '1 note promoted', new Date('2026-11-16T01:02:03.000Z'));
    await appendLog(fs, 'compile', 'inbox/_compiled', 'line one\nline two', new Date('2026-11-16T04:05:06.000Z'));
    const log = await readFile(path.join(root, 'log.md'), 'utf8');
    const lines = log.split('\n').filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '- 2026-11-16T01:02:03.000Z | promote | 学习/笔记/a.md | 1 note promoted');
    assert.equal(lines[1], '- 2026-11-16T04:05:06.000Z | compile | inbox/_compiled | line one line two');
    assert.equal(log.split('# 操作日志').length - 1, 1);
  } finally {
    await cleanup(root);
  }
});

test('log helpers flatten pipes and newlines', () => {
  assert.equal(sanitiseLogField(' a|b\nc '), 'a/b c');
  assert.equal(logLine('link', 'p', 's', new Date('2026-01-02T03:04:05.000Z')), '- 2026-01-02T03:04:05.000Z | link | p | s');
});

test('normaliseLinkTarget strips alias, anchor, path and extension', () => {
  assert.equal(normaliseLinkTarget('学习/笔记/概念 A.md#定义|别名'), '概念 a');
  assert.equal(normaliseLinkTarget('./概念'), '概念');
});

test('isOrphanEligible excludes drafts, mocs and generated notes', () => {
  assert.equal(isOrphanEligible({ path: 'a.md', type: 'concept', inbox: false }), true);
  assert.equal(isOrphanEligible({ path: 'inbox/a.md', type: 'draft', inbox: true }), false);
  assert.equal(isOrphanEligible({ path: 'a.md', type: 'moc', inbox: false }), false);
  assert.equal(isOrphanEligible({ path: 'index.md', type: 'unknown', inbox: false }), false);
});
