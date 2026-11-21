import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NodeVaultFs } from '../src/adapters/fs/node-vault-fs.js';
import { NodeVaultWriter } from '../src/adapters/fs/node-vault-writer.js';
import { runInventory } from '../src/application/kb-inventory.js';

async function makeVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-aikb-inv-'));
  await mkdir(join(root, '.obsidian'), { recursive: true });
  await mkdir(join(root, '.wiki'), { recursive: true });
  await mkdir(join(root, '.agents', 'skills'), { recursive: true });
  await writeFile(join(root, '.wiki', '.gitkeep'), '', 'utf8');
  await writeFile(join(root, '.agents', 'skills', 'SKILL.md'), '# tool', 'utf8');
  await writeFile(join(root, 'b-book.pdf'), 'second', 'utf8');
  await writeFile(join(root, 'a-book.pdf'), 'first', 'utf8');
  await writeFile(join(root, 'note.md'), '# note', 'utf8');
  await writeFile(join(root, 'skip.png'), 'png', 'utf8');
  return root;
}

test('inventory hashes binary sources in stable order and ignores notes, images and hidden tooling', async () => {
  const root = await makeVault();
  const report = await runInventory(new NodeVaultFs(root));
  assert.equal(report.ok, true);
  assert.equal(report.written, false);
  assert.deepEqual(report.entries.map((entry) => entry.path), ['a-book.pdf', 'b-book.pdf']);
  const first = createHash('sha256').update('first').digest('hex');
  assert.equal(report.entries[0]?.sha256, first);
  assert.equal(report.totals.files, 2);
  assert.equal(report.totals.bytes, 11);
  assert.deepEqual(report.totals.byFormat, { pdf: 2 });
});

test('inventory writes the manifest only when asked and only inside the vault', async () => {
  const root = await makeVault();
  const dry = await runInventory(new NodeVaultFs(root));
  assert.equal(dry.written, false);
  const written = await runInventory(new NodeVaultFs(root), { write: true, writer: new NodeVaultWriter(root) });
  assert.equal(written.written, true);
  const text = await readFile(join(root, '.wiki', 'books.jsonl'), 'utf8');
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0] ?? '{}').path, 'a-book.pdf');
});

test('inventory limit records skipped sources', async () => {
  const root = await makeVault();
  const report = await runInventory(new NodeVaultFs(root), { limit: 1 });
  assert.equal(report.totals.files, 1);
  assert.deepEqual(report.skipped, ['b-book.pdf']);
});

test('writer refuses paths outside inbox/ and .wiki/', async () => {
  const root = await makeVault();
  const writer = new NodeVaultWriter(root);
  await assert.rejects(() => writer.writeText('a-book.pdf', 'x'));
  await assert.rejects(() => writer.writeText('../escape.txt', 'x'));
  const bytes = await writer.writeText('.wiki/books.jsonl', 'ok');
  assert.equal(bytes, 2);
});
