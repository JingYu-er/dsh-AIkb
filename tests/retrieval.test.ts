import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBm25, createBm25FromPostings, mergeBm25Postings } from '../src/domain/bm25.js';
import { makeSearchCache, readSearchCache, writeSearchCache } from '../src/application/search-cache.js';
import { chunkPages } from '../src/domain/chunking.js';
import { tokenize } from '../src/domain/text.js';

const pages = [
  { page: 1, width: 600, height: 800, blocks: ['第一章 镜像电流源', '镜像电流源由两个匹配的晶体管构成，输出电流由参考电流镜像得到。'.repeat(3)] },
  { page: 2, width: 600, height: 800, blocks: ['图 1-3 电流镜的偏置电路。'.repeat(20)] },
];

test('tokenize emits CJK bigrams and lowercases Latin words', () => {
  const tokens = tokenize('镜像电流源 Mirror Current Source 3.3V');
  assert.ok(tokens.includes('镜像'));
  assert.ok(tokens.includes('电流'));
  assert.ok(tokens.includes('mirror'));
  assert.ok(tokens.includes('current'));
  assert.ok(!tokens.includes('the'));
});

test('chunks never cross a page and carry a section title', () => {
  const toc = [{ level: 1, title: '镜像电流源', page: 1 }];
  const chunks = chunkPages('src', pages, toc, { maxTokens: 60, minChars: 10 });
  assert.ok(chunks.length >= 3);
  assert.deepEqual([...new Set(chunks.map((chunk) => chunk.page))], [1, 2]);
  const first = chunks[0];
  assert.equal(first?.section, '镜像电流源');
  for (const chunk of chunks) assert.ok(chunk.tokens <= 90, 'chunk too large: ' + chunk.tokens);
});

test('documentWeight scopes a query to the book it names', () => {
  const index = createBm25(
    [
      { id: 'other', text: '电压转换 振荡器 电压转换 振荡器' },
      { id: 'named', text: '电压转换 振荡器' },
    ],
    { documentWeight: (document) => (document.id === 'named' ? 2.5 : 1) },
  );
  assert.equal(index.search('电压转换 振荡器')[0]?.id, 'named');
});

test('coverage is weighted by IDF so a rare device name can carry the match', () => {
  const index = createBm25([
    { id: 'common', text: '失调电压 失调电压 失调电压 温漂 运放' },
    { id: 'rare', text: 'ada4505 失调电压 3 mV maximum' },
  ]);
  // 'ada4505' appears in exactly one document, so matching it is worth more than matching 失调电压.
  const hits = index.search('ada4505 失调电压 最大是多少');
  assert.equal(hits[0]?.id, 'rare');
});

test('coverage separates a question phrased in the corpus words from one that is not', () => {
  const index = createBm25([
    { id: 'a', text: '镜像电流源 参考电流 匹配晶体管' },
    { id: 'b', text: '运放的增益带宽积与压摆率' },
  ]);
  // Every token (bigram included) of the question occurs somewhere in these two pages.
  assert.equal(index.coverage('镜像电流源'), 1);
  // 'switch-mode supply' never occurs, and unseen tokens count with a large idf, so coverage drops.
  const partial = index.coverage('镜像电流源 开关电源');
  assert.ok(partial > 0 && partial < 1, 'expected partial coverage, got ' + partial);
  assert.equal(index.coverage(''), 0);
});

test('bm25 ranks the matching page first', () => {
  const index = createBm25([
    { id: 'a', text: '镜像电流源 参考电流 匹配晶体管' },
    { id: 'b', text: '运放的增益带宽积与压摆率' },
    { id: 'c', text: '开关电源的纹波与布局' },
  ]);
  const hits = index.search('电流源 镜像');
  assert.equal(hits[0]?.id, 'a');
  assert.deepEqual(index.search(''), []);
});

test('createBm25FromPostings reproduces scores and coverage', () => {
  const documents = [
    { id: 'a', text: '镜像电流源 参考电流 匹配晶体管' },
    { id: 'b', text: '运放的增益带宽积与压摆率' },
    { id: 'c', text: '开关电源的纹波与布局' },
  ];
  const weight = (document: { id: string }): number => (document.id === 'b' ? 1.2 : 1);
  const index = createBm25(documents, { documentWeight: weight });
  const restored = createBm25FromPostings(index.toPostings(), { documentWeight: weight }, documents);
  assert.deepEqual(restored.search('电流源 镜像 增益'), index.search('电流源 镜像 增益'));
  assert.equal(restored.coverage('电流源 增益'), index.coverage('电流源 增益'));
});

test('mergeBm25Postings scores an appended book like a full rebuild', () => {
  const first = [
    { id: 'a', text: '镜像电流源 参考电流 匹配晶体管' },
    { id: 'b', text: '运放的增益带宽积与压摆率' },
  ];
  const second = [
    { id: 'c', text: '开关电源的纹波与布局 电流源' },
    { id: 'd', text: '锁相环的相位噪声与杂散' },
  ];
  const weight = (document: { id: string }): number => (document.id === 'c' ? 1.3 : 1);
  const merged = createBm25FromPostings(
    mergeBm25Postings(createBm25(first).toPostings(), createBm25(second).toPostings()),
    { documentWeight: weight },
    [...first, ...second],
  );
  const whole = createBm25([...first, ...second], { documentWeight: weight });
  for (const query of ['电流源', '增益 纹波', '锁相环', '不相干的词']) {
    assert.deepEqual(merged.search(query), whole.search(query));
    assert.equal(merged.coverage(query), whole.coverage(query));
  }
});

test('search cache round-trips through the binary format', async () => {
  const files = new Map<string, Uint8Array>();
  const fs = {
    exists: async (relPath: string): Promise<boolean> => files.has(relPath),
    readBinary: async (relPath: string): Promise<Uint8Array> => files.get(relPath) ?? new Uint8Array(),
    writeBinary: async (relPath: string, data: Uint8Array): Promise<void> => {
      files.set(relPath, data);
    },
  };
  const index = createBm25([{ id: 'a', text: '镜像电流源 参考电流' }]);
  const cache = makeSearchCache({
    catalogHash: 'h',
    sources: [{ sha256: 's', path: 'p', pages: 1, family: 's' }],
    chunks: [{ id: 'a', section: '', quality: 1, chapter: -1 }],
    chapters: [],
    byPage: [],
    bySection: [],
    byChapter: [],
    postings: index.toPostings(),
  });
  assert.equal(await writeSearchCache(fs, cache), true);
  assert.deepEqual(await readSearchCache(fs, 'h'), cache);
  assert.equal(await readSearchCache(fs, 'stale'), undefined);
});
