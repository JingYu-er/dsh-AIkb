import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { NodeNotesFs } from '../src/adapters/fs/notes-fs.js';
import { claimLike, extractStatements, parseReviewQueue, reviewNote, reviewNotes, REVIEW_QUEUE_DIR } from '../src/application/kb-review.js';

async function makeVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-aikb-review-'));
  for (const [rel, body] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, body, 'utf8');
  }
  return root;
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function note(type: string, title: string, body: string): string {
  return ['---', 'type: ' + type, 'title: ' + title, '---', '', '# ' + title, '', body].join('\n');
}

const OLD = note('concept', '旧说', [
  '向量检索的结论是：余弦相似度必须大于 0.75 才算命中，否则视为噪声。',
  '',
  '倒排索引负责召回，词频加权只用于重排，因此这两步不能合并。',
].join('\n'));

const NEW = note('thought', '新说', [
  '向量检索的结论是：余弦相似度必须大于 0.60 就算命中，0.75 的门槛过于保守。',
  '',
  '倒排索引负责召回，词频加权只用于重排，因此这两步不能合并。',
].join('\n'));

const UNRELATED = note('concept', '烘焙', [
  '面包发酵的注意点是温度必须保持在 26 度左右，面团过度发酵会塌陷。',
  '',
  '高筋面粉的蛋白质含量大于百分之十二，所以适合做吐司。',
].join('\n'));

test('reviewNote picks only the similar note and leaves every verdict empty', async () => {
  const root = await makeVault({
    '学习/笔记/旧说.md': OLD,
    '学习/笔记/新说.md': NEW,
    '学习/笔记/烘焙.md': UNRELATED,
  });
  try {
    const fs = new NodeNotesFs(root);
    const queue = await reviewNote(fs, '学习/笔记/新说.md');

    assert.equal(queue.candidates.length, 1);
    assert.equal(queue.candidates[0]?.name, '旧说');
    assert.ok((queue.candidates[0]?.score ?? 0) > 0.15);
    assert.equal(queue.rows.length, 2);
    assert.equal(queue.pending, 2);
    assert.equal(queue.written, false);
    assert.equal(queue.path, REVIEW_QUEUE_DIR + '/学习__笔记__新说.md');
    assert.ok(queue.rows.every((row) => row.verdict === ''));
    assert.ok(queue.rows.every((row) => row.oldName === '旧说'));
    assert.ok(queue.rows.some((row) => row.newText.includes('0.60')));
    assert.ok(queue.rows.some((row) => row.oldText.includes('0.75')));

    // Preview only: no file may appear before write:true.
    await assert.rejects(readFile(path.join(root, queue.path), 'utf8'));
  } finally {
    await cleanup(root);
  }
});

test('write:true creates the queue table and a rerun keeps a filled verdict', async () => {
  const root = await makeVault({
    '学习/笔记/旧说.md': OLD,
    '学习/笔记/新说.md': NEW,
    '学习/笔记/烘焙.md': UNRELATED,
  });
  try {
    const fs = new NodeNotesFs(root);
    const first = await reviewNote(fs, '学习/笔记/新说.md', { write: true });
    assert.equal(first.written, true);

    const absolute = path.join(root, first.path);
    const text = await readFile(absolute, 'utf8');
    assert.ok(text.includes('type: review-queue'));
    assert.ok(text.includes('| 旧笔记 | 相似度 | 旧说法（摘录） | 新说法（摘录） | 判定（待填） | 依据（待填） |'));
    assert.equal(parseReviewQueue(text).length, 2);

    // A human fills the first row; it must survive the next run.
    const filled = text.replace('|  |  |', '| 冲突 | 人工判断 |');
    await writeFile(absolute, filled, 'utf8');
    assert.equal(parseReviewQueue(filled)[0]?.verdict, '冲突');

    const before = await readFile(path.join(root, '学习/笔记/新说.md'), 'utf8');
    const second = await reviewNote(fs, '学习/笔记/新说.md', { write: true });
    const after = await readFile(path.join(root, '学习/笔记/新说.md'), 'utf8');
    assert.equal(before, after, 'review must never edit the formal note');

    assert.equal(second.merged, 2);
    assert.equal(second.added, 0);
    assert.equal(second.rows.length, 2);
    assert.equal(second.rows[0]?.verdict, '冲突');
    assert.equal(second.rows[0]?.basis, '人工判断');
    assert.equal(second.pending, 1);

    const reread = parseReviewQueue(await readFile(absolute, 'utf8'));
    assert.equal(reread.length, 2);
    assert.equal(reread[0]?.verdict, '冲突');
  } finally {
    await cleanup(root);
  }
});

test('omitting note reviews at most five recent notes and never touches them', async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 6; index += 1) {
    files['学习/笔记/笔记' + index + '.md'] = note('concept', '笔记' + index, '第 ' + index + ' 篇的结论是：这条判断必须成立，因此不能删掉这一行正文。');
  }
  const root = await makeVault(files);
  try {
    const fs = new NodeNotesFs(root);
    const before = await Promise.all(
      Object.keys(files).map(async (rel) => [rel, await readFile(path.join(root, rel), 'utf8')] as const),
    );
    const report = await reviewNotes(fs, root, { write: true, now: new Date('2026-11-16T00:00:00.000Z') });
    assert.equal(report.notes, 5);
    assert.equal(report.queues.length, 5);
    assert.equal(report.warnings.length, 0);
    for (const queue of report.queues) {
      assert.ok(queue.path.startsWith(REVIEW_QUEUE_DIR + '/'));
      assert.equal(queue.written, true);
      const text = await readFile(path.join(root, queue.path), 'utf8');
      assert.ok(text.includes('type: review-queue'));
    }
    for (const [rel, expected] of before) {
      assert.equal(await readFile(path.join(root, rel), 'utf8'), expected);
    }
  } finally {
    await cleanup(root);
  }
});
const BT = String.fromCharCode(96);

function queueFile(target: string, rows: readonly string[]): string {
  const header = '| 旧笔记 | 相似度 | 旧说法（摘录） | 新说法（摘录） | 判定（待填） | 依据（待填） |';
  const rule = '| --- | --- | --- | --- | --- | --- |';
  return ['---', 'type: review-queue', 'note: ' + target, '---', '', '# 目标', '', header, rule, ...rows].join('\n') + '\n';
}

test('a link note generates no queue and never grows one', async () => {
  const LINK = note('link', '步骤', '向量检索的结论是：余弦相似度必须大于 0.75 才算命中，否则视为噪声。');
  const root = await makeVault({ '学习/笔记/旧说.md': OLD, '学习/笔记/步骤.md': LINK });
  try {
    const fs = new NodeNotesFs(root);
    const queue = await reviewNote(fs, '学习/笔记/步骤.md', { write: true });
    assert.equal(queue.skipped, 'link');
    assert.equal(queue.candidates.length, 0);
    assert.equal(queue.rows.length, 0);
    assert.equal(queue.written, false);
    assert.equal(queue.deleted, false);
    // A link note does not even create an empty queue file.
    await assert.rejects(readFile(path.join(root, queue.path), 'utf8'));
  } finally {
    await cleanup(root);
  }
});

test('pure image paragraphs and index lists produce no candidates', async () => {
  const bodyText = ['![[diagram.png]]', '', '直流通路 交流通路 BJT-图解法 小信号模型分析法', '', '## 关联', '', '- [[旧说]]', '- [[新说]]'].join('\n');
  const NAV = note('concept', '导航', bodyText);
  assert.equal(claimLike('![[diagram.png]]'), false);
  assert.equal(claimLike('## 关联'), false);
  assert.equal(claimLike('直流通路 交流通路 BJT-图解法'), false);
  assert.equal(extractStatements(bodyText).length, 0);

  const root = await makeVault({ '学习/笔记/旧说.md': OLD, '学习/笔记/新说.md': NEW, '学习/笔记/导航.md': NAV });
  try {
    const fs = new NodeNotesFs(root);
    const queue = await reviewNote(fs, '学习/笔记/导航.md');
    assert.equal(queue.rows.length, 0);
    assert.equal(queue.pending, 0);
    assert.ok(queue.candidates.every((candidate) => candidate.pairs === 0));
  } finally {
    await cleanup(root);
  }
});

test('both sides passing the claim gate still yields a candidate pair', async () => {
  const root = await makeVault({ '学习/笔记/旧说.md': OLD, '学习/笔记/新说.md': NEW, '学习/笔记/烘焙.md': UNRELATED });
  try {
    const fs = new NodeNotesFs(root);
    const queue = await reviewNote(fs, '学习/笔记/新说.md');
    assert.ok(queue.rows.length >= 1);
    assert.ok(queue.rows.every((row) => claimLike(row.oldText) && claimLike(row.newText)));
    assert.ok(queue.rows.some((row) => row.newText.includes('0.60')));
  } finally {
    await cleanup(root);
  }
});

test('merging drops unfilled noise rows and keeps decided rows', async () => {
  const target = '学习/笔记/目标.md';
  const queuePath = REVIEW_QUEUE_DIR + '/学习__笔记__目标.md';
  const noise = '1. 打开设置 2. 点击保存';
  const decided = '| [[甲]]<br>' + BT + '学习/笔记/甲.md' + BT + ' | 0.500 | ' + noise + ' | ![[x.png]] | 冲突 | 人工判断 |';
  const unfilledNoise = '| [[乙]]<br>' + BT + '学习/笔记/乙.md' + BT + ' | 0.400 | 目录 索引 术语表 | ![[y.png]] |  |  |';
  const unfilledClaim = '| [[丙]]<br>' + BT + '学习/笔记/丙.md' + BT + ' | 0.300 | 余弦相似度必须大于 0.75 才算命中，否则视为噪声。 | 余弦相似度必须大于 0.60 就算命中，0.75 的门槛过于保守。 |  |  |';
  const root = await makeVault({
    [target]: note('thought', '目标', '目标笔记的结论必须成立，因此这条判断只能保留自己的主张。'),
    [queuePath]: queueFile(target, [decided, unfilledNoise, unfilledClaim]),
  });
  try {
    const fs = new NodeNotesFs(root);
    const queue = await reviewNote(fs, target, { write: true });
    assert.equal(queue.removed, 1);
    assert.equal(queue.rows.length, 2);
    assert.equal(queue.rows[0]?.verdict, '冲突');
    assert.equal(queue.rows[0]?.basis, '人工判断');
    assert.equal(queue.rows[1]?.verdict, '');
    assert.ok(queue.rows[1]?.oldText.includes('0.75'));
    assert.equal(queue.deleted, false);
    const reread = parseReviewQueue(await readFile(path.join(root, queuePath), 'utf8'));
    assert.equal(reread.length, 2);
    assert.equal(reread[0]?.verdict, '冲突');
  } finally {
    await cleanup(root);
  }
});



test('a claims scan marks machine hits 待复核 and clears an undecided similarity queue', async () => {
  const root = await makeVault({
    '学习/笔记/共模.md': note('concept', '共模', ['| 参数 | 数值 |', '| --- | --- |', '| 共模增益 | 20 |'].join('\n')),
    '学习/笔记/共模另一处.md': note('thought', '共模另一处', ['| 参数 | 数值 |', '| --- | --- |', '| 共模电压增益 | 40 |'].join('\n')),
    '学习/笔记/单独.md': note('concept', '单独', '这一篇只有一段普通说明：它讲的是如何整理书桌，没有任何参数表，也没有可以比较的数值。'),
  });
  try {
    const fs = new NodeNotesFs(root);
    const stale = path.join(root, REVIEW_QUEUE_DIR, '学习__笔记__单独.md');
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(
      stale,
      [
        '---',
        'type: review-queue',
        'note: 学习/笔记/单独.md',
        '---',
        '',
        '| 旧笔记 | 相似度 | 旧说法（摘录） | 新说法（摘录） | 判定（待填） | 依据（待填） |',
        '| --- | --- | --- | --- | --- | --- |',
        '| [[别的]]<br>\u0060学习/笔记/别的.md\u0060 | 0.5 | 两段措辞不同的同一句话 | 两段措辞不同的同一句话 |  |  |',
      ].join('\n'),
      'utf8',
    );

    const cleared = await reviewNote(fs, '学习/笔记/单独.md', { write: true, claimMode: 'claims' });
    assert.equal(cleared.rows.length, 0);
    assert.equal(cleared.deleted, true);

    const queue = await reviewNote(fs, '学习/笔记/共模.md', { write: true, claimMode: 'claims', claimProfile: { aliases: new Map([['共模电压增益', '共模增益']]) } });
    assert.equal(queue.rows.length, 1);
    assert.equal(queue.rows[0]?.verdict, '待复核');
    assert.equal(queue.rows[0]?.oldName, '共模另一处');
    assert.match(queue.rows[0]?.basis ?? '', /规则配对/);
  } finally {
    await cleanup(root);
  }
});
