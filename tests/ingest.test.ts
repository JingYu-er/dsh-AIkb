import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runIngest, type IngestFs } from '../src/application/kb-ingest.js';

test('reports pdf.no-text-layer instead of writing an empty chunk file', async () => {
  const written: string[] = [];
  const sha = 'a'.repeat(64);
  const fs: IngestFs = {
    root: '/vault',
    exists: async (relPath) => relPath === '.wiki/books.jsonl' || written.includes(relPath),
    readText: async () => JSON.stringify({ path: '书/scan.pdf', sha256: sha, format: 'pdf', bytes: 10, modifiedAt: '2026-01-01T00:00:00.000Z' }),
    writeText: async (relPath, content) => { written.push(relPath); return content.length; },
  };
  const report = await runIngest(fs, async () => ({ pages: [{ page: 1, width: 1, height: 1, blocks: [] }], toc: [], textChars: 0 }));
  assert.match(report.books[0]?.error ?? '', /^pdf\.no-text-layer:/);
  assert.equal(written.some((relPath) => relPath.includes('/chunks/')), false);
  assert.equal(report.totals.chunks, 0);
});
