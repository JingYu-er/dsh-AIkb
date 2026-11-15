import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines } from '../src/domain/diff.js';
import { normalisePromoteDir, runPromote } from '../src/application/kb-promote.js';
import type { PromoteFs } from '../src/application/kb-promote.js';

test('diff reports added and removed lines in order', () => {
  const diff = diffLines('a\nb\nc\n', 'a\nc\nd\n');
  assert.equal(diff.removed, 1);
  assert.equal(diff.added, 1);
  assert.deepEqual(diff.lines.filter((line) => line.kind !== ' ').map((line) => line.kind + line.text), ['-b', '+d']);
});

function fakeFs(seed: Record<string, string>): PromoteFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async listCompiled() {
      return [...files.keys()].filter((key) => key.startsWith('inbox/_compiled/')).sort();
    },
    async exists(relPath) {
      return files.has(relPath);
    },
    async readText(relPath) {
      const value = files.get(relPath);
      if (value === undefined) throw new Error('missing ' + relPath);
      return value;
    },
    async writeText(relPath, content) {
      files.set(relPath, content);
    },
  };
}

test('preview maps the draft into the promote folder and writes nothing', async () => {
  const fs = fakeFs({ 'inbox/_compiled/sub/a.md': '# A\nbody\n' });
  const report = await runPromote(fs, '/vault', 'notes');
  assert.equal(report.dryRun, true);
  assert.equal(report.notes[0]?.target, 'notes/sub/a.md');
  assert.equal(report.notes[0]?.status, 'create');
  assert.equal(report.notes[0]?.written, false);
  assert.equal(fs.files.has('notes/sub/a.md'), false);
  assert.equal(report.notes[0]?.diff.some((line) => line.kind === '+'), true);
});

test('confirm writes a new note; an existing different note conflicts until forced', async () => {
  const fs = fakeFs({ 'inbox/_compiled/a.md': '# A\nnew\n', 'notes/a.md': '# A\nold\n' });
  const preview = await runPromote(fs, '/vault', 'notes', { confirm: true });
  assert.equal(preview.notes[0]?.status, 'conflict');
  assert.equal(fs.files.get('notes/a.md'), '# A\nold\n');
  const forced = await runPromote(fs, '/vault', 'notes', { confirm: true, force: true });
  assert.equal(forced.notes[0]?.status, 'update');
  assert.equal(forced.notes[0]?.written, true);
  assert.equal(fs.files.get('notes/a.md'), '# A\nnew\n');
});

test('identical content is unchanged, and the source stays in place', async () => {
  const fs = fakeFs({ 'inbox/_compiled/a.md': 'same\n', 'notes/a.md': 'same\n' });
  const report = await runPromote(fs, '/vault', 'notes', { confirm: true });
  assert.equal(report.notes[0]?.status, 'unchanged');
  assert.equal(report.totals.unchanged, 1);
  assert.equal(fs.files.has('inbox/_compiled/a.md'), true);
});

test('one source can take an explicit target, but not with a batch', async () => {
  const fs = fakeFs({ 'inbox/_compiled/a.md': 'x\n' });
  const report = await runPromote(fs, '/vault', 'notes', { source: 'inbox/_compiled/a.md', target: 'renamed.md' });
  assert.equal(report.notes[0]?.target, 'notes/renamed.md');
  const batch = fakeFs({ 'inbox/_compiled/a.md': 'x\n', 'inbox/_compiled/b.md': 'y\n' });
  await assert.rejects(() => runPromote(batch, '/vault', 'notes', { target: 'renamed.md' }), /target/);
});

test('a source outside inbox and a bad promote folder are rejected', async () => {
  const fs = fakeFs({ 'notes/a.md': 'x\n' });
  const report = await runPromote(fs, '/vault', 'notes', { source: 'notes/a.md', confirm: true });
  assert.equal(report.notes[0]?.status, 'failed');
  assert.match(report.notes[0]?.error ?? '', /inbox/);
  assert.throws(() => normalisePromoteDir(''), /promoteDir/);
  assert.throws(() => normalisePromoteDir('../outside'), /promoteDir/);
});
