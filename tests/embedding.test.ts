import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planEmbedding } from '../src/application/kb-embed.js';
import { runQuery } from '../src/application/kb-query.js';
import type { QueryFs, VectorStore } from '../src/application/kb-query.js';
import { INDEX_CATALOG_PATH, chunkFileOf } from '../src/application/kb-ingest.js';

const sources = [
  { sha256: 'a', path: 'book-a.pdf', chunks: 10 },
  { sha256: 'b', path: 'book-b.pdf', chunks: 5 },
  { sha256: 'c', path: 'book-c.pdf', chunks: 0 },
];

test('embedding skips books whose chunk count still matches', () => {
  const plan = planEmbedding(sources, new Map([['a', 10], ['b', 4]]));
  assert.deepEqual(plan.todo.map((source) => source.sha256), ['b']);
  assert.deepEqual(plan.upToDate.map((source) => source.sha256), ['a']);
  assert.deepEqual(plan.noChunks.map((source) => source.sha256), ['c']);
});

test('force re-embeds everything that has chunks', () => {
  const plan = planEmbedding(sources, new Map([['a', 10], ['b', 5]]), true);
  assert.deepEqual(plan.todo.map((source) => source.sha256), ['a', 'b']);
});

function fakeFs(chunks: { id: string; page: number; text: string }[]): QueryFs {
  const files = new Map<string, string>();
  files.set(
    INDEX_CATALOG_PATH,
    JSON.stringify({ schema: 'dsh-aikb/index@1', sources: { a: { path: 'book-a.pdf', pages: 1, chunks: chunks.length } } }),
  );
  files.set(chunkFileOf('a'), chunks.map((chunk) => JSON.stringify({ sourceId: 'a', section: '', tokens: 1, ...chunk })).join('\n') + '\n');
  return {
    root: '/vault',
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
  { id: 'c1', page: 1, text: '镜像电流源由两个匹配的晶体管构成' },
  { id: 'c2', page: 2, text: '运放的增益带宽积与压摆率' },
  { id: 'c3', page: 3, text: '开关电源的纹波与布局' },
];

test('vectors rescue a chunk the lexical index ranks low', async () => {
  const fs = fakeFs(chunks);
  // A unit query vector that points at c3 only: BM25 still ranks c1 for these words.
  const dims = 2;
  const data = new Float32Array([0, 1, 0, 1, 1, 0]);
  const store: VectorStore = { ids: ['c1', 'c2', 'c3'], data, dims };
  const lexical = await runQuery(fs, '电流源 晶体管 匹配', 3);
  assert.equal(lexical.retrieval, 'bm25');
  assert.deepEqual(lexical.hits.map((hit) => hit.page), [1]);
  const hybrid = await runQuery(fs, '电流源 晶体管 匹配', 3, { vectors: store, queryVector: [1, 0] });
  assert.equal(hybrid.retrieval, 'hybrid');
  assert.equal(hybrid.searched.vectors, 3);
  // c3 shares no term with the query but is the nearest vector; fusion must surface it.
  assert.ok(hybrid.hits.some((hit) => hit.page === 3), 'vector-only hit missing: ' + JSON.stringify(hybrid.hits));
});

test('a query vector of the wrong size is ignored instead of throwing', async () => {
  const fs = fakeFs(chunks);
  const store: VectorStore = { ids: ['c1', 'c2', 'c3'], data: new Float32Array(6), dims: 2 };
  const report = await runQuery(fs, '电流源', 3, { vectors: store, queryVector: [1, 0, 0] });
  assert.equal(report.ok, true);
  assert.equal(report.retrieval, 'bm25');
});
