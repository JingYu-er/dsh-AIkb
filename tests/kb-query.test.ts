import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearQueryCache, runQuery } from '../src/application/kb-query.js';
import type { QueryFs, VectorStore } from '../src/application/kb-query.js';
import { chunkFileOf, INDEX_CATALOG_PATH } from '../src/application/kb-ingest.js';

interface FakeChunk {
  readonly id: string;
  readonly page: number;
  readonly text: string;
  readonly section?: string;
}

interface FakeSource {
  readonly sha256: string;
  readonly path: string;
  readonly pages: number;
  readonly chunks: readonly FakeChunk[];
}

function fakeVault(root: string, sources: readonly FakeSource[]): QueryFs {
  const files = new Map<string, string>();
  const catalog = { schema: 'dsh-aikb/index@1', sources: {} as Record<string, unknown> };
  for (const source of sources) {
    catalog.sources[source.sha256] = { path: source.path, pages: source.pages, chunks: source.chunks.length };
    const lines = source.chunks.map((chunk) =>
      JSON.stringify({ sourceId: source.sha256, tokens: 1, section: '', ...chunk }),
    );
    files.set(chunkFileOf(source.sha256), lines.join('\n') + '\n');
  }
  files.set(INDEX_CATALOG_PATH, JSON.stringify(catalog));
  return {
    root,
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

const SHA = 'a'.repeat(64);
const CHUNKS: readonly FakeChunk[] = [
  { id: 'q:1:0', page: 1, text: '稳压二极管工作在反向击穿区，限流电阻决定流过管子的电流。' },
  { id: 'q:2:0', page: 2, text: '开关电源通过电感储能与脉宽调制实现升压和降压转换。' },
];

function vault(root: string): QueryFs {
  return fakeVault(root, [{ sha256: SHA, path: '书/稳压电源.pdf', pages: 2, chunks: CHUNKS }]);
}

test('an empty index reports empty-index instead of blaming the query', async () => {
  clearQueryCache();
  const report = await runQuery(fakeVault('/vault-trace-empty', []), '稳压管 限流电阻', 5, { cache: false });
  assert.equal(report.ok, true);
  assert.equal(report.hits.length, 0);
  assert.equal(report.trace.noHitReason, 'empty-index');
  assert.equal(report.trace.query, '稳压管 限流电阻');
  assert.equal(report.trace.queries, 1);
  assert.equal(report.trace.stages.lexical.ran, true);
  assert.equal(report.trace.stages.lexical.candidates, 0);
  assert.equal(report.trace.stages.vector.ran, false);
  assert.equal(report.trace.stages.rerank.ran, false);
  assert.ok(Number.isInteger(report.trace.elapsedMs));
  assert.ok(report.trace.elapsedMs >= 0);
});

test('terms absent from every chunk report no-term-match', async () => {
  clearQueryCache();
  const report = await runQuery(vault('/vault-trace-absent'), 'zzzz qqqq', 5, { cache: false });
  assert.equal(report.hits.length, 0);
  assert.equal(report.trace.noHitReason, 'no-term-match');
  assert.equal(report.trace.stages.lexical.candidates, 0);
  assert.equal(report.trace.stages.vector.candidates, 0);
});

test('the vector stage reports its candidates and wall time when embeddings are supplied', async () => {
  clearQueryCache();
  const vectors: VectorStore = {
    ids: CHUNKS.map((chunk) => chunk.id),
    data: new Float32Array([1, 0, 0, 1]),
    dims: 2,
  };
  const report = await runQuery(vault('/vault-trace-vector'), '稳压管 限流电阻', 5, {
    cache: false,
    vectors,
    queryVector: [1, 0],
    vectorShare: 0.5,
  });
  assert.ok(report.trace.stages.lexical.candidates > 0, 'the lexical stage still supplies the top slots');
  assert.equal(report.trace.stages.vector.ran, true);
  assert.equal(report.trace.stages.vector.candidates, 2);
  assert.equal(report.searched.vectors, 2);
  for (const stage of Object.values(report.trace.stages)) {
    assert.ok(Number.isInteger(stage.ms));
    assert.ok(stage.ms >= 0);
  }
});

test('trace counts the phrasings that were actually searched', async () => {
  clearQueryCache();
  const single = await runQuery(vault('/vault-trace-queries'), '稳压管的限流电阻', 5, { cache: false });
  assert.equal(single.trace.queries, 1);
  assert.equal('noHitReason' in single.trace, false);
  const fused = await runQuery(vault('/vault-trace-queries'), '稳压管的限流电阻', 5, {
    cache: false,
    queries: ['开关电源 电感', '  ', '稳压管的限流电阻'],
  });
  assert.equal(fused.trace.queries, 2);
  assert.ok(fused.trace.stages.lexical.candidates > 0);
});

test('the rerank stage reports the pool it scored and its wall time', async () => {
  clearQueryCache();
  let pool = 0;
  const report = await runQuery(vault('/vault-trace-rerank'), '稳压管 限流电阻', 3, {
    cache: false,
    rerank: async (documents) => {
      pool = documents.length;
      return documents.map(() => 1);
    },
  });
  assert.ok(pool >= 1);
  assert.equal(report.reranked, true);
  assert.equal(report.trace.stages.rerank.ran, true);
  assert.equal(report.trace.stages.rerank.candidates, pool);
  assert.ok(Number.isInteger(report.trace.stages.rerank.ms));
  assert.ok(report.trace.stages.rerank.ms >= 0);
});

test('a page carrying the named standard outranks a page that only shares the words', async () => {
  clearQueryCache();
  const fs = fakeVault('/vault-identifier-boost', [
    {
      sha256: SHA,
      path: '书/质量体系.pdf',
      pages: 2,
      chunks: [
        { id: 'gb:1:0', page: 1, text: '体系要求写在另一节，这里只作概述。' },
        { id: 'gb:2:0', page: 2, text: '质量管理体系要求由 GB/T 19001 规定。' },
      ],
    },
  ]);
  const report = await runQuery(fs, 'GB/T 19001 质量管理体系要求', 2, { cache: false });
  assert.equal(report.ok, true);
  assert.equal(report.hits.length, 2);
  assert.equal(report.hits[0]?.page, 2, 'the page with the standard number comes first');
});
