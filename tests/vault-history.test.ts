import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  captureHistory,
  historyDir,
  historyRoot,
  listHistory,
  readHistoryEntry,
  restoreHistory,
} from '../src/application/vault-history.js';

function makeVault(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedNote(root: string, relPath: string, text: string): string {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  return file;
}

function noteBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

test('capture and restore refuse when writes are disabled', async () => {
  const root = makeVault('dsh-aikb-history-ro-');
  try {
    const note = seedNote(root, 'notes/demo.md', 'current body');
    const captured = await captureHistory(root, 'notes/demo.md', 'older body', { allowWrites: false });
    assert.equal(captured.ok, false);
    assert.equal(captured.error?.code, 'kb.history.read-only');
    const restored = await restoreHistory(root, 'notes/demo.md', '2026-01-01T00-00-00.000Z', { allowWrites: false });
    assert.equal(restored.ok, false);
    assert.equal(restored.error?.code, 'kb.history.read-only');
    assert.equal(readFileSync(note, 'utf8'), 'current body');
    assert.equal(existsSync(historyRoot(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blank and oversized notes are refused before anything is stored', async () => {
  const root = makeVault('dsh-aikb-history-bad-');
  try {
    const blank = await captureHistory(root, 'notes/demo.md', '  \n\t ', { allowWrites: true });
    assert.equal(blank.ok, false);
    assert.equal(blank.error?.code, 'kb.history.empty');
    const oversized = await captureHistory(root, 'notes/demo.md', 'x'.repeat(65), { allowWrites: true, maxBytes: 64 });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error?.code, 'kb.history.too-large');
    const report = await listHistory(root, 'notes/demo.md');
    assert.deepEqual(report.entries, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a capture lands under the vault history directory and reads back', async () => {
  const root = makeVault('dsh-aikb-history-ok-');
  try {
    seedNote(root, 'notes/demo.md', 'second body');
    const body = 'first body';
    const captured = await captureHistory(root, 'notes/demo.md', body, { allowWrites: true });
    const entry = captured.entry;
    assert.equal(captured.ok, true);
    if (!entry) assert.fail('capture returned no entry');
    const expectedDir = join(root, '.dsh-aikb', 'history', 'notes__demo');
    assert.equal(dirname(entry.path), expectedDir);
    assert.equal(entry.bytes, noteBytes(body));
    assert.ok(entry.path.endsWith(entry.stamp + '.md'));
    const read = await readHistoryEntry(root, 'notes/demo.md', entry.stamp);
    assert.equal(read.ok, true);
    assert.equal(read.text, body);
    const report = await listHistory(root, 'notes/demo.md');
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0]?.path, entry.path);
    assert.equal(report.root, historyRoot(root));
    assert.equal(report.notePath, 'notes/demo.md');
    assert.equal(historyDir(root, 'notes/demo.md'), expectedDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identical content is stored only once', async () => {
  const root = makeVault('dsh-aikb-history-dupe-');
  try {
    seedNote(root, 'notes/demo.md', 'current body');
    const first = await captureHistory(root, 'notes/demo.md', 'same body', { allowWrites: true });
    const second = await captureHistory(root, 'notes/demo.md', 'same body', { allowWrites: true });
    assert.equal(second.ok, true);
    assert.equal(second.entry?.path, first.entry?.path);
    const report = await listHistory(root, 'notes/demo.md');
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0]?.bytes, noteBytes('same body'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruning keeps only the newest N copies', async () => {
  const root = makeVault('dsh-aikb-history-prune-');
  try {
    seedNote(root, 'notes/demo.md', 'current body');
    const stamps = [
      '2026-01-01T00-00-01.000Z',
      '2026-01-01T00-00-02.000Z',
      '2026-01-01T00-00-03.000Z',
      '2026-01-01T00-00-04.000Z',
      '2026-01-01T00-00-05.000Z',
    ];
    for (const [index, stamp] of stamps.entries()) {
      const captured = await captureHistory(root, 'notes/demo.md', 'body ' + String(index), { allowWrites: true, keep: 3, stamp });
      assert.equal(captured.ok, true);
    }
    const report = await listHistory(root, 'notes/demo.md');
    assert.equal(report.entries.length, 3);
    assert.deepEqual(report.entries.map((entry) => entry.stamp), stamps.slice(2).reverse());
    const evicted = await readHistoryEntry(root, 'notes/demo.md', '2026-01-01T00-00-01.000Z');
    assert.equal(evicted.error?.code, 'kb.history.missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listHistory is newest first and ignores stray files', async () => {
  const root = makeVault('dsh-aikb-history-list-');
  try {
    seedNote(root, 'notes/demo.md', 'current body');
    const dir = historyDir(root, 'notes/demo.md');
    await captureHistory(root, 'notes/demo.md', 'older body', { allowWrites: true, stamp: '2026-03-01T00-00-00.000Z' });
    await captureHistory(root, 'notes/demo.md', 'newer body', { allowWrites: true, stamp: '2026-04-01T00-00-00.000Z' });
    writeFileSync(join(dir, 'scratch.txt'), 'ignore me', 'utf8');
    mkdirSync(join(dir, 'nested.md'), { recursive: true });
    const report = await listHistory(root, 'notes/demo.md');
    assert.deepEqual(report.entries.map((entry) => entry.stamp), ['2026-04-01T00-00-00.000Z', '2026-03-01T00-00-00.000Z']);
    assert.ok(report.entries.every((entry) => entry.bytes > 0));
    assert.ok(!report.entries.some((entry) => entry.path.includes('scratch')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore puts the old text back and keeps the overwritten text', async () => {
  const root = makeVault('dsh-aikb-history-restore-');
  try {
    const note = seedNote(root, 'notes/demo.md', 'first body');
    const kept = await captureHistory(root, 'notes/demo.md', 'first body', { allowWrites: true });
    const stamp = kept.entry?.stamp ?? '';
    assert.notEqual(stamp, '');
    writeFileSync(note, 'second body', 'utf8');
    const restored = await restoreHistory(root, 'notes/demo.md', stamp, { allowWrites: true });
    assert.equal(restored.ok, true);
    assert.equal(restored.path, note);
    assert.equal(restored.bytes, noteBytes('first body'));
    assert.equal(readFileSync(note, 'utf8'), 'first body');
    const report = await listHistory(root, 'notes/demo.md');
    assert.ok(report.entries.length >= 2);
    const texts: string[] = [];
    for (const entry of report.entries) {
      const read = await readHistoryEntry(root, 'notes/demo.md', entry.stamp);
      if (read.text !== undefined) texts.push(read.text);
    }
    assert.ok(texts.includes('second body'), 'the overwritten text is still undoable');
    assert.deepEqual(report.entries.map((entry) => entry.stamp), [...report.entries.map((entry) => entry.stamp)].sort().reverse());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stamps with separators or parent segments are refused', async () => {
  const root = makeVault('dsh-aikb-history-stamp-');
  try {
    const note = seedNote(root, 'notes/demo.md', 'body');
    for (const stamp of ['../escape', 'nested/stamp', '..', 'a\\b']) {
      const read = await readHistoryEntry(root, 'notes/demo.md', stamp);
      assert.equal(read.ok, false);
      assert.equal(read.error?.code, 'kb.history.invalid-stamp');
    }
    const restored = await restoreHistory(root, 'notes/demo.md', '../escape', { allowWrites: true });
    assert.equal(restored.ok, false);
    assert.equal(restored.error?.code, 'kb.history.invalid-stamp');
    assert.equal(readFileSync(note, 'utf8'), 'body');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('note paths outside the vault are refused', async () => {
  const root = makeVault('dsh-aikb-history-escape-');
  const escapeName = 'escaped-' + basename(root) + '.md';
  try {
    const relativeEscape = join('..', escapeName);
    const captured = await captureHistory(root, relativeEscape, 'body', { allowWrites: true });
    assert.equal(captured.ok, false);
    assert.equal(captured.error?.code, 'kb.history.outside-vault');
    const restored = await restoreHistory(root, relativeEscape, '2026-01-01T00-00-00.000Z', { allowWrites: true });
    assert.equal(restored.ok, false);
    assert.equal(restored.error?.code, 'kb.history.outside-vault');
    const absoluteEscape = join(tmpdir(), escapeName);
    const absolute = await captureHistory(root, absoluteEscape, 'body', { allowWrites: true });
    assert.equal(absolute.error?.code, 'kb.history.outside-vault');
    assert.equal(existsSync(join(root, '..', escapeName)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing entry reads as missing and an absent directory lists empty', async () => {
  const root = makeVault('dsh-aikb-history-missing-');
  try {
    const read = await readHistoryEntry(root, 'notes/demo.md', '2026-01-01T00-00-00.000Z');
    assert.equal(read.ok, false);
    assert.equal(read.error?.code, 'kb.history.missing');
    const report = await listHistory(root, 'notes/demo.md');
    assert.deepEqual(report.entries, []);
    assert.equal(report.root, historyRoot(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
