import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearQueryCache, runQuery } from '../src/application/kb-query.js';
import type { QueryFs } from '../src/application/kb-query.js';
import { chunkFileOf, INDEX_CATALOG_PATH } from '../src/application/kb-ingest.js';

const SHA = 'a'.repeat(64);
const BASE = '项目/砖块/7-模拟电子技术基础（第五版）.pdf';

function fakeVault(root: string): QueryFs {
  const catalog = {
    schema: 'dsh-aikb/index@1',
    sources: { [SHA]: { path: BASE, pages: 30, chunks: 2 } },
  };
  const chunks = [
    {
      id: 'p10',
      sourceId: SHA,
      page: 10,
      tokens: 1,
      section: '稳压电路',
      text: '稳压二极管工作在反向击穿区，限流电阻决定流过管子的电流，稳压值由击穿电压决定。',
    },
    {
      id: 'p20',
      sourceId: SHA,
      page: 20,
      tokens: 1,
      section: '开关电源',
      text: '开关电源通过电感储能与脉宽调制实现升压和降压转换，效率明显高于线性稳压电路。',
    },
  ];
  const files = new Map<string, string>();
  files.set(INDEX_CATALOG_PATH, JSON.stringify(catalog));
  files.set(chunkFileOf(SHA), chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + '\n');
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

test('one query keeps the lexical order and reports no fusion', async () => {
  clearQueryCache();
  const report = await runQuery(fakeVault('vault-one'), '稳压管的限流电阻怎么算', 3, { cache: false });
  assert.equal(report.ok, true);
  assert.equal(report.hits[0]?.page, 10);
  assert.equal(report.searched.queries, undefined);
  assert.equal(report.retrieval, 'bm25');
});

test('a second phrasing pulls in its own page and reports the fused count', async () => {
  clearQueryCache();
  const report = await runQuery(fakeVault('vault-multi'), '稳压管的限流电阻怎么算', 3, {
    cache: false,
    queries: ['开关电源 电感 脉宽调制 升降压'],
  });
  assert.equal(report.ok, true);
  assert.equal(report.searched.queries, 2);
  const pages = report.hits.map((hit) => hit.page);
  assert.ok(pages.includes(10), 'the original query still contributes its page');
  assert.ok(pages.includes(20), 'the extra phrasing contributes its page');
});

test('duplicate and blank phrasings collapse into the single-query path', async () => {
  clearQueryCache();
  const report = await runQuery(fakeVault('vault-dupe'), '稳压管的限流电阻怎么算', 3, {
    cache: false,
    queries: ['  ', '稳压管的限流电阻怎么算'],
  });
  assert.equal(report.searched.queries, undefined);
  assert.equal(report.hits[0]?.page, 10);
});
