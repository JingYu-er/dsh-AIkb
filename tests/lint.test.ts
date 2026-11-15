import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLint } from '../src/application/kb-lint.js';

const FILES: Record<string, string> = {
  'a.md': '---\ntype: concept\ntitle: A\n---\n\nsee [[B]] and [[missing]]',
  'b.md': '---\ntitle: B\n---\n\nback to [[A]]',
  'dup/B.md': '---\ntype: concept\n---\n\n[[A]]',
  'c.md': '---\ntype: concept\n---\n\nnobody links here',
  'img.md': '---\ntype: concept\n---\n\n![[diagram.png]]',
  'plain.md': 'no frontmatter, links [[a]]',
};

const fakeFs = {
  listFiles: async () => Object.keys(FILES).map((relPath) => ({ relPath })),
  readText: async (relPath: string) => FILES[relPath] ?? '',
};

test('lint reports broken links, duplicates, orphans and missing type', async () => {
  const report = await runLint(fakeFs, '/vault');
  assert.equal(report.notes, 6);
  assert.equal(report.counts['link.broken'], 1);
  assert.equal(report.counts['title.duplicate'], 1);
  assert.equal(report.counts['frontmatter.missing'], 1);
  assert.equal(report.counts['frontmatter.type'], 1);
});

test('compiled drafts are machine copies, not notes', async () => {
  const fs = {
    listFiles: async () => [{ relPath: 'a.md' }, { relPath: 'inbox/_compiled/a.md' }, { relPath: 'inbox/draft.md' }],
    readText: async (relPath: string) => (relPath === 'a.md' ? '---\ntype: concept\n---\n\nbody' : '---\ntitle: A\ntype: thought\n---\n\nbody'),
  };
  const report = await runLint(fs, '/vault');
  assert.equal(report.notes, 2);
  assert.equal(report.counts['title.duplicate'] ?? 0, 0);
});

test('attachment embeds are not treated as notes', async () => {
  const report = await runLint(fakeFs, '/vault');
  const broken = report.findings.filter((finding) => finding.rule === 'link.broken');
  assert.deepEqual(broken.map((finding) => finding.detail), ['no note named "missing"']);
});

test('a concept page with no inbound link is reported once', async () => {
  const report = await runLint(fakeFs, '/vault');
  const orphans = report.findings.filter((finding) => finding.rule === 'concept.orphan');
  assert.deepEqual(orphans.map((finding) => finding.path).sort(), ['c.md', 'img.md']);
});
