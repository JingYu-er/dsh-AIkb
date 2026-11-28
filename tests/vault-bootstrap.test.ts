import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOOTSTRAP_CATALOG_PATH,
  BOOTSTRAP_MAP_PATH,
  runBootstrap,
} from '../src/application/vault-bootstrap.js';
import type { BootstrapFs, BootstrapWriter } from '../src/application/vault-bootstrap.js';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-05-01T00:00:00.000Z');

class MemoryFs implements BootstrapFs, BootstrapWriter {
  readonly root = '/vault';
  readonly files = new Map<string, string>();
  async exists(relPath: string): Promise<boolean> {
    return this.files.has(relPath);
  }
  async readText(relPath: string): Promise<string> {
    const text = this.files.get(relPath);
    if (text === undefined) throw new Error('missing ' + relPath);
    return text;
  }
  async writeText(relPath: string, text: string): Promise<void> {
    this.files.set(relPath, text);
  }
}

function catalog(sources: Record<string, { path: string; format: string; pages: number; chunks: number }>): string {
  return JSON.stringify({ schema: 'dsh-aikb/index@1', updatedAt: NOW.toISOString(), sources });
}

function chunkLine(page: number, text: string): string {
  return JSON.stringify({ id: SHA + ':' + page + ':0', sourceId: SHA, page, section: 'Regulator', text }) + '\n';
}

test('bootstrap refuses a vault without an index or with no sources', async () => {
  const empty = new MemoryFs();
  const noIndex = await runBootstrap(empty, empty, NOW);
  assert.equal(noIndex.ok, false);
  assert.equal(noIndex.error?.code, 'kb.bootstrap.no-index');

  const blank = new MemoryFs();
  blank.files.set(BOOTSTRAP_CATALOG_PATH, catalog({}));
  const noSources = await runBootstrap(blank, blank, NOW);
  assert.equal(noSources.ok, false);
  assert.equal(noSources.error?.code, 'kb.bootstrap.empty-index');
});

test('bootstrap writes the map and the learned profile, and reports missing chunk files', async () => {
  const fs = new MemoryFs();
  fs.files.set(BOOTSTRAP_CATALOG_PATH, catalog({
    [SHA]: { path: 'manual.pdf', format: 'pdf', pages: 2, chunks: 2 },
    ['b'.repeat(64)]: { path: 'lost.pdf', format: 'pdf', pages: 1, chunks: 1 },
  }));
  fs.files.set('.wiki/index/chunks/' + SHA + '.jsonl', [
    chunkLine(1, 'The LM7805 regulator output is 5 V. LM7805 dropout is 2 V.'),
    chunkLine(2, 'A second LM7805 page repeats the regulator name.'),
  ].join(''));

  const report = await runBootstrap(fs, fs, NOW);
  assert.equal(report.ok, true, JSON.stringify(report.error));
  assert.equal(report.map?.docs, 2);
  assert.equal(report.map?.path, BOOTSTRAP_MAP_PATH);
  assert.ok((report.map?.entities ?? 0) >= 1, 'LM7805 should become an entity');
  assert.deepEqual(report.missingSources, ['lost.pdf']);
  assert.ok(fs.files.has(BOOTSTRAP_MAP_PATH));
  assert.ok(fs.files.has('.wiki/index/taxonomy.json'));
  assert.ok(fs.files.has('.wiki/index/synonyms.json'));
  assert.ok(fs.files.has('.wiki/index/policy.json'));
  assert.ok((report.profile?.taxonomy ?? 0) >= 1);
  assert.equal(report.profile?.written.length, 3);
});
