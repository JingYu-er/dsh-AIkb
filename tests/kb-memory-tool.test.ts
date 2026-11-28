import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { test } from 'node:test';

import { CONSOLIDATION_LOG, ITEMS_PATH, serializeItems } from '../src/application/vault-memory.js';
import type { MemoryItem } from '../src/application/vault-memory.js';
import { createKbMemoryTool } from '../src/tools/kb-memory.tool.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const STAMP = '2026-04-01T00:00:00.000Z';
const LATER = '2026-04-10T00:00:00.000Z';
const tempBase = nodePath.resolve(process.cwd(), '..', 'temp');

async function makeVault(): Promise<string> {
  await mkdir(tempBase, { recursive: true });
  const root = await mkdtemp(nodePath.join(tempBase, 'kb-memory-tool-'));
  await mkdir(nodePath.join(root, '.obsidian'), { recursive: true });
  await mkdir(nodePath.join(root, '.wiki', 'index', 'chunks'), { recursive: true });
  await mkdir(nodePath.join(root, '.wiki', 'memory'), { recursive: true });
  return root;
}

async function seedIndex(root: string): Promise<void> {
  const catalog = {
    schema: 'dsh-aikb/index@1',
    updatedAt: STAMP,
    sources: {
      [SHA_A]: { path: 'manual.pdf', format: 'pdf', pages: 2, chunks: 2, tokens: 20, ingestedAt: STAMP },
      [SHA_B]: { path: 'notes/op07.md', format: 'markdown', pages: 1, chunks: 1, tokens: 5, ingestedAt: STAMP },
    },
  };
  await writeFile(nodePath.join(root, '.wiki', 'index', 'catalog.json'), JSON.stringify(catalog), 'utf8');
  const lines = [
    { id: SHA_A + ':1:0', sourceId: SHA_A, page: 1, section: 'Regulator', text: 'LM7805 output is 5 V at 1 A.', tokens: 8 },
    { id: SHA_A + ':2:0', sourceId: SHA_A, page: 2, section: 'Dropout', text: 'Dropout voltage is 2 V.', tokens: 5 },
  ];
  await writeFile(nodePath.join(root, '.wiki', 'index', 'chunks', SHA_A + '.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const noteLines = [{ id: SHA_B + ':1:0', sourceId: SHA_B, page: 1, section: 'Op amp', text: 'OP07 offset is 10 uV.', tokens: 5 }];
  await writeFile(nodePath.join(root, '.wiki', 'index', 'chunks', SHA_B + '.jsonl'), noteLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  await writeFile(
    nodePath.join(root, 'chapter.md'),
    '# Chapter\n\nIntro paragraph.\n\n## Method\n\nWe measured 120 samples on 2026-03-02.\n\n## Results\n\nAccuracy reached 97 percent.\n',
    'utf8',
  );
}

function toolFor(root: string, now = STAMP) {
  return createKbMemoryTool({ resolveRoot: () => root, now: () => new Date(now) });
}

async function readLedger(root: string): Promise<MemoryItem[]> {
  const text = await readFile(nodePath.join(root, ITEMS_PATH), 'utf8');
  return text.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as MemoryItem);
}

test('add verifies a page quote and stores the claim', async () => {
  const root = await makeVault();
  try {
    await seedIndex(root);
    const tool = toolFor(root);
    const report = await tool.execute({
      action: 'add',
      kind: 'claim',
      subject: 'LM7805 输出',
      statement: 'LM7805 输出 5 V',
      evidence: [{ path: 'manual.pdf', unit: 'page', locator: 1, quote: 'LM7805 output is 5 V' }],
    }, {});
    assert.equal(report.ok, true);
    assert.equal(report.added, true);
    assert.equal(report.total, 1);
    assert.equal(report.byKind?.claim, 1);
    const ledger = await readLedger(root);
    assert.equal(ledger.length, 1);
    const item = ledger[0];
    assert.ok(item !== undefined);
    assert.equal(item.status, 'verified');
    assert.equal(item.evidence[0]?.sha, SHA_A);
    assert.match(item.id, /^m-[0-9a-f]{10}$/u);
    const rendered = tool.output.render({ action: 'add' }, report)[0]?.text ?? '';
    assert.match(rendered, /记忆 1 条/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('add refuses a quote that is not in the source', async () => {
  const root = await makeVault();
  try {
    await seedIndex(root);
    const tool = toolFor(root);
    const report = await tool.execute({
      action: 'add',
      subject: 'LM7805 输出',
      statement: 'LM7805 输出 12 V',
      evidence: [{ path: 'manual.pdf', unit: 'page', locator: 1, quote: 'output is 12 V' }],
    }, {});
    assert.equal(report.ok, false);
    assert.equal(report.error?.code, 'kb.memory.no-evidence');
    assert.match(report.error?.message ?? '', /quote-not-found/u);
    await assert.rejects(readFile(nodePath.join(root, ITEMS_PATH), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preferences and gaps need no documentary evidence', async () => {
  const root = await makeVault();
  try {
    await seedIndex(root);
    const tool = toolFor(root);
    const preference = await tool.execute({
      action: 'add',
      kind: 'preference',
      subject: '回答格式',
      statement: '偏好先给结论再给依据',
      importance: 3,
    }, {});
    assert.equal(preference.ok, true);
    const gap = await tool.execute({ action: 'add', kind: 'unknown', subject: '温度漂移', statement: '还没查到高温下的偏置电流' }, {});
    assert.equal(gap.ok, true);
    assert.equal(gap.total, 2);
    assert.equal(gap.byKind?.preference, 1);
    assert.equal(gap.byKind?.unknown, 1);
    const ledger = await readLedger(root);
    assert.equal(ledger.every((item) => item.status === 'derived'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evidence resolves a markdown note section, never a note page', async () => {
  const root = await makeVault();
  try {
    await seedIndex(root);
    const tool = toolFor(root);
    const good = await tool.execute({
      action: 'add',
      subject: '实验方法',
      statement: '本章方法部分测量了 120 个样本',
      evidence: [{ path: 'chapter.md', unit: 'section', locator: 'Method', quote: 'We measured 120 samples' }],
    }, {});
    assert.equal(good.ok, true);
    assert.equal((await readLedger(root))[0]?.evidence[0]?.path, 'chapter.md');
    const bad = await tool.execute({
      action: 'add',
      subject: '实验页码',
      statement: '笔记第 3 页',
      evidence: [{ path: 'chapter.md', unit: 'page', locator: 3, quote: 'We measured 120 samples' }],
    }, {});
    assert.equal(bad.ok, false);
    assert.match(bad.error?.message ?? '', /missing-source/u);
    const noSection = await tool.execute({
      action: 'add',
      subject: '不存在的节',
      statement: '不存在',
      evidence: [{ path: 'chapter.md', unit: 'section', locator: 'Missing', quote: 'We measured' }],
    }, {});
    assert.equal(noSection.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hot ranks a recent preference above an old claim and respects the budget', async () => {
  const root = await makeVault();
  try {
    await seedIndex(root);
    const old: MemoryItem = {
      id: 'm-old',
      kind: 'claim',
      subject: '旧结论',
      statement: 'old claim',
      evidence: [],
      status: 'verified',
      confidence: 0.5,
      importance: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      lastUsedAt: '2025-01-01T00:00:00.000Z',
      useCount: 0,
    };
    const fresh: MemoryItem = {
      id: 'm-new',
      kind: 'preference',
      subject: '格式',
      statement: '新偏好：先给结论',
      evidence: [],
      status: 'derived',
      confidence: 0.7,
      importance: 4,
      createdAt: STAMP,
      lastUsedAt: STAMP,
      useCount: 2,
    };
    await writeFile(nodePath.join(root, ITEMS_PATH), serializeItems([old, fresh]), 'utf8');
    const tool = toolFor(root);
    const report = await tool.execute({ action: 'hot', budgetTokens: 400 }, {});
    assert.equal(report.ok, true);
    assert.deepEqual(report.hot?.map((row) => row.id), ['m-new', 'm-old']);
    // Two large statements do not both fit into 100 tokens.
    const longA: MemoryItem = { ...fresh, id: 'm-long-a', statement: 'x'.repeat(300), importance: 5 };
    const longB: MemoryItem = { ...fresh, id: 'm-long-b', statement: 'y'.repeat(300), importance: 4 };
    await writeFile(nodePath.join(root, ITEMS_PATH), serializeItems([longA, longB]), 'utf8');
    const tight = await tool.execute({ action: 'hot', budgetTokens: 100 }, {});
    assert.deepEqual(tight.hot?.map((row) => row.id), ['m-long-a']);
    assert.ok((tight.tokens ?? 0) <= 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('touch records reuse and shows up in the ledger', async () => {
  const root = await makeVault();
  try {
    await seedIndex(root);
    const tool = toolFor(root);
    const added = await tool.execute({ action: 'add', kind: 'preference', subject: '格式', statement: '先给结论' }, {});
    const id = (await readLedger(root))[0]?.id ?? '';
    assert.ok(id !== '');
    const touched = await tool.execute({ action: 'touch', ids: [id] }, {});
    assert.equal(touched.ok, true);
    const item = await readLedger(root);
    assert.equal(item[0]?.useCount, 1);
    assert.equal(item[0]?.lastUsedAt, STAMP);
    assert.equal(added.total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('forget guards preferences and logs every attempt', async () => {
  const root = await makeVault();
  try {
    await seedIndex(root);
    const tool = toolFor(root);
    await tool.execute({ action: 'add', kind: 'preference', subject: '格式', statement: '先给结论' }, {});
    const refused = await tool.execute({ action: 'forget', subject: '格式', reason: 'test' }, {});
    assert.equal(refused.ok, true);
    assert.match(refused.audit ?? '', /forget-refused/u);
    assert.equal((await readLedger(root)).length, 1);
    const forced = await tool.execute({ action: 'forget', subject: '格式', force: true, reason: '用户要求' }, {});
    assert.match(forced.audit ?? '', /forced/u);
    assert.equal((await readLedger(root)).length, 0);
    const log = await readFile(nodePath.join(root, CONSOLIDATION_LOG), 'utf8');
    assert.match(log, /forget-refused/u);
    assert.match(log, /用户要求/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('consolidate marks stale evidence and merges duplicates without deleting statements', async () => {
  const root = await makeVault();
  try {
    await seedIndex(root);
    const base = {
      evidence: [],
      status: 'verified' as const,
      confidence: 0.6,
      importance: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      useCount: 0,
    };
    const items: MemoryItem[] = [
      { ...base, id: 'm-one', kind: 'claim', subject: '库存', statement: '库存为 120 件', evidence: [{ path: 'manual.pdf', unit: 'page', locator: '1', quote: 'LM7805 output is 5 V', sha: 'deadbeef' }] },
      { ...base, id: 'm-two', kind: 'claim', subject: '库存', statement: '库存为 120 件' },
    ];
    await writeFile(nodePath.join(root, ITEMS_PATH), serializeItems(items), 'utf8');
    const tool = toolFor(root);
    const plan = await tool.execute({ action: 'consolidate' }, {});
    assert.equal(plan.ok, true);
    assert.equal(plan.applied, false);
    assert.equal((plan.actions ?? []).some((action) => action.kind === 'dedupe'), true);
    assert.equal((plan.actions ?? []).some((action) => action.kind === 'stale'), true);
    const applied = await tool.execute({ action: 'consolidate', apply: true }, {});
    assert.equal(applied.applied, true);
    const ledger = await readLedger(root);
    assert.ok(ledger.length >= 1);
    assert.equal(ledger.some((item) => item.status === 'stale'), true);
    const log = await readFile(nodePath.join(root, CONSOLIDATION_LOG), 'utf8');
    assert.match(log, /dedupe/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
