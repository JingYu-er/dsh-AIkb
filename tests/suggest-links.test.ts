import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestLinks } from '../src/application/kb-suggest-links.js';

const FILES: Record<string, string> = {
  'a.md': '# 稳压管限流电阻\n\n稳压管稳压电路需要限流电阻，限流电阻按最大电流计算。',
  'b.md': '# 稳压管电路\n\n限流电阻决定稳压管的工作电流，稳压管稳压电路常见误区。',
  'c.md': '# 稳压管笔记\n\n已经链到 [[a]]，同样讲稳压管与限流电阻。',
  'music.md': '# 吉他练习\n\n每天练习音阶与和弦转换。',
};

const fakeFs = {
  listFiles: async () => Object.keys(FILES).map((relPath) => ({ relPath })),
  readText: async (relPath: string) => FILES[relPath] ?? '',
};

test('suggests a pair that shares rare terms', async () => {
  const report = await suggestLinks(fakeFs, '/vault');
  const pair = report.suggestions.find((entry) => entry.from === 'a.md' && entry.to === 'b');
  assert.ok(pair !== undefined, JSON.stringify(report.suggestions));
  assert.ok(pair.why.includes('\u7a33\u538b\u7ba1'), pair.why);
  assert.ok(pair.confidence > 0.2);
});

test('skips pairs that are already linked', async () => {
  const report = await suggestLinks(fakeFs, '/vault');
  assert.equal(report.suggestions.some((entry) => entry.from === 'c.md' && entry.to === 'a'), false);
});

test('unrelated notes are not suggested', async () => {
  const report = await suggestLinks(fakeFs, '/vault');
  assert.equal(report.suggestions.some((entry) => entry.to === '\u5409\u4ed6\u7ec3\u4e60'), false);
});

test('note filter limits the scan to one note', async () => {
  const report = await suggestLinks(fakeFs, '/vault', { note: 'a.md' });
  assert.ok(report.suggestions.every((entry) => entry.from === 'a.md'));
});

test('a draft is not suggested to its own promoted copy', async () => {
  const body = '稳压管稳压电路与限流电阻的选型，稳压管工作电流。';
  const files: Record<string, string> = {
    '学习/笔记/稳压管.md': body,
    'inbox/稳压管.md': body,
    'b.md': '# 限流电阻\n\n稳压管限流电阻按最大电流选。',
  };
  const fs = {
    listFiles: async () => Object.keys(files).map((relPath) => ({ relPath })),
    readText: async (relPath: string) => files[relPath] ?? '',
  };
  const report = await suggestLinks(fs, '/vault');
  const cross = report.suggestions.filter((entry) => entry.from.startsWith('inbox/') && entry.to === '稳压管');
  assert.deepEqual(cross, []);
});

test('template trees are never suggested', async () => {
  const files: Record<string, string> = {
    ...FILES,
    'ZtTemplates/zt-note.eta.md': '稳压管 限流电阻 稳压管',
    'ZtTemplates/zotlit-cite.eta.md': '稳压管 限流电阻',
  };
  const fs = {
    listFiles: async () => Object.keys(files).map((relPath) => ({ relPath })),
    readText: async (relPath: string) => files[relPath] ?? '',
  };
  const report = await suggestLinks(fs, '/vault');
  assert.equal(report.suggestions.some((entry) => entry.from.includes('ZtTemplates') || entry.to.startsWith('zt-note') || entry.to.startsWith('zotlit-')), false);
});

test('emits one suggestion per unordered pair', async () => {
  const report = await suggestLinks(fakeFs, '/vault', { limit: 40 });
  const keys = report.suggestions.map((entry) => [entry.from, entry.to].sort().join('|'));
  assert.equal(new Set(keys).size, keys.length);
});
