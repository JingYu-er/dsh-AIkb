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
    assert.equal(report.nextActions.length, 0);
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
