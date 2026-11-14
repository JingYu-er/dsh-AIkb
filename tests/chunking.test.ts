import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkPages } from '../src/domain/chunking.js';

test('hard-splits a block without sentence punctuation to respect maxTokens', () => {
  const row = 'a'.repeat(4000);
  const chunks = chunkPages('src', [{ page: 1, width: 0, height: 0, blocks: [row] }], [], { maxTokens: 300, minChars: 24 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.tokens <= 300, 'chunk tokens ' + chunk.tokens);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), row);
});

test('keeps every chunk on its own page', () => {
  const chunks = chunkPages('src', [
    { page: 1, width: 0, height: 0, blocks: ['第一页内容'.repeat(40)] },
    { page: 2, width: 0, height: 0, blocks: ['第二页内容'.repeat(40)] },
  ], [], { maxTokens: 700, minChars: 24 });
  assert.deepEqual([...new Set(chunks.map((chunk) => chunk.page))], [1, 2]);
});
