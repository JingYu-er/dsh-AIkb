import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import * as nodePath from 'node:path';
import { runDoctor } from '../src/application/kb-doctor.js';
import { NodeVaultFs } from '../src/adapters/fs/node-vault-fs.js';

const LINE_FEED = String.fromCharCode(10);
const tempBase = nodePath.resolve(process.cwd(), '..', 'temp');

async function makeVault(): Promise<string> {
  await fsPromises.mkdir(tempBase, { recursive: true });
  const root = await fsPromises.mkdtemp(nodePath.join(tempBase, 'kb-doctor-'));
  await fsPromises.mkdir(nodePath.join(root, '.obsidian'), { recursive: true });
  await fsPromises.mkdir(nodePath.join(root, 'inbox'), { recursive: true });
  await fsPromises.mkdir(nodePath.join(root, '.wiki'), { recursive: true });
  await fsPromises.mkdir(nodePath.join(root, 'attachments'), { recursive: true });
  await fsPromises.writeFile(nodePath.join(root, 'note.md'), '# note' + LINE_FEED);
  await fsPromises.writeFile(nodePath.join(root, 'book.pdf'), 'not really a pdf');
  await fsPromises.writeFile(nodePath.join(root, 'attachments', 'figure.png'), 'png');
  await fsPromises.writeFile(
    nodePath.join(root, '.wiki', 'books.jsonl'),
    JSON.stringify({ path: 'book.pdf' }) + LINE_FEED + JSON.stringify({ path: 'book2.pdf' }) + LINE_FEED,
  );
  return root;
}

test('kb_doctor reports counts, layout and a present inventory', async () => {
  const root = await makeVault();
  try {
    const report = await runDoctor(new NodeVaultFs(root), { allowWrites: false });
    assert.equal(report.ok, true);
    assert.equal(report.counts.markdown, 1);
    assert.equal(report.counts.sources, 1);
    assert.equal(report.counts.images, 1);
    assert.equal(report.counts.attachments, 1);
    assert.equal(report.layout.inbox, true);
    assert.equal(report.booksManifest.present, true);
    assert.equal(report.booksManifest.entries, 2);
    assert.equal(report.writesEnabled, false);
    assert.equal(report.checks.find((c) => c.id === 'vault.marker')?.status, 'pass');
    assert.equal(report.checks.find((c) => c.id === 'schema')?.status, 'warn');
    assert.ok(report.nextActions.some((action) => action.includes('vault sheet')));
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('kb_doctor fails a directory that is not a vault and asks for a manifest', async () => {
  await fsPromises.mkdir(tempBase, { recursive: true });
  const root = await fsPromises.mkdtemp(nodePath.join(tempBase, 'kb-plain-'));
  try {
    await fsPromises.writeFile(nodePath.join(root, 'note.md'), '# note' + LINE_FEED);
    const report = await runDoctor(new NodeVaultFs(root), { allowWrites: true });
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((c) => c.id === 'vault.marker')?.status, 'fail');
    assert.equal(report.booksManifest.present, false);
    assert.equal(report.layout.inbox, false);
    assert.equal(report.writesEnabled, true);
    assert.ok(report.nextActions.length >= 2);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('kb_doctor reports index health: chunk files, vectors and cache', async () => {
  const root = await makeVault();
  try {
    const indexDir = nodePath.join(root, '.wiki', 'index');
    await fsPromises.mkdir(nodePath.join(indexDir, 'chunks'), { recursive: true });
    await fsPromises.mkdir(nodePath.join(indexDir, 'vectors'), { recursive: true });
    await fsPromises.writeFile(nodePath.join(indexDir, 'catalog.json'), JSON.stringify({
      schema: 'dsh-aikb/index@1',
      sources: {
        aaa: { path: 'book.pdf', pages: 2, chunks: 2 },
        bbb: { path: 'book2.pdf', pages: 1, chunks: 1 },
      },
    }));
    await fsPromises.writeFile(nodePath.join(indexDir, 'chunks', 'aaa.jsonl'), '{}\n{}\n');
    await fsPromises.writeFile(nodePath.join(indexDir, 'chunks', 'orphan.jsonl'), '{}\n');
    await fsPromises.writeFile(nodePath.join(indexDir, 'vectors', 'aaa.json'), JSON.stringify({ count: 2 }));
    await fsPromises.writeFile(nodePath.join(indexDir, 'search-cache.bin'), 'cache');
    const report = await runDoctor(new NodeVaultFs(root), { allowWrites: false });
    assert.equal(report.index?.catalogSources, 2);
    assert.equal(report.index?.chunkFiles, 2);
    assert.equal(report.index?.orphanChunkFiles, 1);
    assert.equal(report.index?.missingChunkFiles, 1);
    assert.equal(report.index?.vectorFiles, 1);
    assert.equal(report.index?.missingVectors, 1);
    assert.equal(report.index?.staleVectors, 0);
    assert.equal(report.checks.find((check) => check.id === 'index.vectors')?.status, 'warn');
    assert.equal(report.checks.find((check) => check.id === 'index.cache')?.status, 'pass');
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
