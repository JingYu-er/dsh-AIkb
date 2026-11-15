import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQuery } from '../src/application/kb-query.js';
import type { QueryFs } from '../src/application/kb-query.js';
import { INDEX_CATALOG_PATH, chunkFileOf } from '../src/application/kb-ingest.js';

function fakeFs(chunks: { id: string; page: number; text: string }[]): QueryFs {
  const files = new Map<string, string>();
  files.set(
    INDEX_CATALOG_PATH,
    JSON.stringify({ schema: 'dsh-kb/index@1', sources: { a: { path: 'book-a.pdf', pages: 1, chunks: chunks.length } } }),
  );
  files.set(chunkFileOf('a'), chunks.map((chunk) => JSON.stringify({ sourceId: 'a', section: '', tokens: 1, ...chunk })).join('\n') + '\n');
  return {
    root: '/vault-rerank',
    async exists(relPath) {
      return files.has(relPath);
    },
    async readText(relPath) {
      const value = files.get(relPath);
      if (value === undefined) throw new Error('missing ' + relPath);
      return value;
    },
  };
}

const chunks = [
  { id: 'c1', page: 10, text: '稳压管的限流电阻计算，输入电压最高时电流最大' },
  { id: 'c2', page: 11, text: '共射放大电路静态工作点与失真' },
  { id: 'c3', page: 12, text: '开关电源纹波与布局' },
];

test('rerank reorders the lexical candidates and reports it', async () => {
  const fs = fakeFs(chunks);
  let seen: readonly string[] = [];
  const report = await runQuery(fs, '电路 电阻 失真', 3, {
    cache: false,
    rerank: async (documents) => {
      seen = documents;
      // The cross-encoder decides the second candidate answers better even though BM25 ranked
      // the resistor page first.
      return documents.map((text) => (text.includes('共射') ? 1 : 0));
    },
  });
  assert.ok(seen.length >= 2, 'rerank received too few passages: ' + JSON.stringify(seen));
  assert.ok(seen.some((text) => text.includes('稳压管')), 'rerank did not receive the passages');
  assert.equal(report.reranked, true);
  assert.equal(report.hits[0]?.page, 11);
});

test('a reranker that returns nothing leaves the lexical order untouched', async () => {
  const fs = fakeFs(chunks);
  const report = await runQuery(fs, '稳压管 限流电阻', 3, { cache: false, rerank: async () => undefined });
  assert.equal(report.reranked, undefined);
  assert.equal(report.hits[0]?.page, 10);
});

test('rerank is skipped entirely when the caller does not pass it', async () => {
  const fs = fakeFs(chunks);
  const report = await runQuery(fs, '稳压管 限流电阻', 3, { cache: false });
  assert.equal(report.reranked, undefined);
  assert.equal(report.hits[0]?.page, 10);
});
