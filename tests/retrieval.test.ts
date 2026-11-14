import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBm25 } from '../src/domain/bm25.js';
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
