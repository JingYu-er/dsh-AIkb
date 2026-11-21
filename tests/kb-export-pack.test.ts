import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { test } from 'node:test';

import { NodeVaultFs } from '../src/adapters/fs/node-vault-fs.js';
import { nodePackWriter, runExportPack } from '../src/application/kb-export-pack.js';
import type { PackRefusal, PackReport, PackSuccess } from '../src/application/kb-export-pack.js';
import { createKbExportPackTool } from '../src/tools/kb-export-pack.tool.js';

const LINE_FEED = String.fromCharCode(10);
const tempBase = nodePath.resolve(process.cwd(), '..', 'temp');

interface FixtureChunk {
  readonly page: number;
  readonly section?: string;
  readonly text: string;
}

interface FixtureSource {
  readonly sha256: string;
  readonly path: string;
  readonly pages?: number;
  readonly chunks: readonly FixtureChunk[];
  /** What the catalog claims; defaults to the number of chunk lines written. */
  readonly catalogChunks?: number;
}

interface ManifestSource {
  readonly path: string;
  readonly sha256: string;
  readonly pages: number;
  readonly chunks: number;
}

interface ManifestShape {
  readonly schema: string;
  readonly name: string;
  readonly generatedAt: string;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly vault: { readonly name: string; readonly path: string };
  readonly counts: { readonly sources: number; readonly chunks: number };
  readonly sources: readonly ManifestSource[];
}

async function makeVault(specs: readonly FixtureSource[]): Promise<string> {
  await mkdir(tempBase, { recursive: true });
  const root = await mkdtemp(nodePath.join(tempBase, 'kb-pack-vault-'));
  await mkdir(nodePath.join(root, '.obsidian'), { recursive: true });
  if (specs.length === 0) return root;
  const indexDir = nodePath.join(root, '.wiki', 'index');
  await mkdir(nodePath.join(indexDir, 'chunks'), { recursive: true });
  const sources: Record<string, unknown> = {};
  for (const spec of specs) {
    sources[spec.sha256] = {
      path: spec.path,
      format: 'pdf',
      pages: spec.pages ?? 0,
      chunks: spec.catalogChunks ?? spec.chunks.length,
      tokens: 0,
      ingestedAt: '2026-01-01T00:00:00.000Z',
    };
    if (spec.chunks.length === 0) continue;
    const lines = spec.chunks.map((chunk, index) => JSON.stringify({
      id: spec.sha256 + ':' + chunk.page + ':' + index,
      sourceId: spec.sha256,
      page: chunk.page,
      section: chunk.section,
      text: chunk.text,
      tokens: 1,
    }));
    await writeFile(nodePath.join(indexDir, 'chunks', spec.sha256 + '.jsonl'), lines.join(LINE_FEED) + LINE_FEED, 'utf8');
  }
  const catalog = { schema: 'dsh-aikb/index@1', updatedAt: '2026-01-01T00:00:00.000Z', sources };
  await writeFile(nodePath.join(indexDir, 'catalog.json'), JSON.stringify(catalog), 'utf8');
  return root;
}

async function makePackRoot(): Promise<string> {
  await mkdir(tempBase, { recursive: true });
  return mkdtemp(nodePath.join(tempBase, 'kb-pack-out-'));
}

function packTool(root: string, configuredPackDir: string, allowWrites = true) {
  return createKbExportPackTool({
    resolveRoot: (explicit?: string) => explicit ?? root,
    allowWrites,
    packDir: () => configuredPackDir,
  });
}

function assertSuccess(report: PackReport): asserts report is PackSuccess {
  if (report.ok !== true) assert.fail('expected a pack, got refusal ' + JSON.stringify(report));
}

function assertRefusal(report: PackReport): asserts report is PackRefusal {
  if (report.ok !== false) assert.fail('expected a refusal, got a pack');
}

async function readChunkLines(packDir: string): Promise<string[]> {
  const text = await readFile(nodePath.join(packDir, 'chunks.jsonl'), 'utf8');
  return text.split(LINE_FEED).filter((line) => line !== '');
}

async function readManifest(packDir: string): Promise<ManifestShape> {
  return JSON.parse(await readFile(nodePath.join(packDir, 'manifest.json'), 'utf8')) as ManifestShape;
}

test('kb_export_pack writes manifest, chunk lines and SKILL.md', async () => {
  const root = await makeVault([
    {
      sha256: 'a'.repeat(64),
      path: 'analog.pdf',
      pages: 12,
      chunks: [
        { page: 1, section: 'Getting started', text: 'first page text' },
        { page: 2, section: 'Getting started', text: 'second page text' },
      ],
    },
    { sha256: 'b'.repeat(64), path: 'notes.pdf', pages: 3, chunks: [{ page: 3, text: 'no section here' }] },
  ]);
  const packRoot = await makePackRoot();
  try {
    const report = await packTool(root, packRoot).execute({ name: 'demo', outDir: 'one' }, {});
    assertSuccess(report);
    assert.equal(report.packDir, nodePath.join(packRoot, 'one'));
    assert.deepEqual(report.files.map((file) => file.name), ['manifest.json', 'chunks.jsonl', 'SKILL.md']);
    assert.ok(report.files.every((file) => file.bytes > 0));
    assert.deepEqual(report.counts, { sources: 2, chunks: 3 });
    assert.deepEqual(report.warnings, []);

    const lines = await readChunkLines(report.packDir);
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[0] ?? ''), {
      path: 'analog.pdf',
      page: 1,
      section: 'Getting started',
      text: 'first page text',
    });
    assert.deepEqual(JSON.parse(lines[2] ?? ''), {
      path: 'notes.pdf',
      page: 3,
      section: null,
      text: 'no section here',
    });

    const manifest = await readManifest(report.packDir);
    const pkg = JSON.parse(await readFile(nodePath.resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    assert.equal(manifest.schema, 'dsh-aikb/pack@1');
    assert.equal(manifest.name, 'demo');
    assert.match(manifest.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(manifest.plugin.name, 'dsh-aikb');
    assert.equal(manifest.plugin.version, pkg.version);
    assert.deepEqual(manifest.vault, { name: nodePath.basename(root), path: root });
    assert.deepEqual(manifest.counts, { sources: 2, chunks: 3 });
    assert.deepEqual(manifest.sources.map((source) => [source.path, source.pages, source.chunks]), [
      ['analog.pdf', 12, 2],
      ['notes.pdf', 3, 1],
    ]);
    assert.equal(manifest.sources[0]?.sha256, 'a'.repeat(64));

    const skill = await readFile(nodePath.join(report.packDir, 'SKILL.md'), 'utf8');
    assert.ok(skill.includes('chunks.jsonl'));
    assert.ok(skill.includes('path#page'));
    assert.ok(skill.includes('never copy'));
    assert.equal(skill.includes(manifest.generatedAt), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
});

test('chunk lines and manifest sources are ordered by path, then page', async () => {
  const root = await makeVault([
    {
      sha256: 'c'.repeat(64),
      path: 'zeta.pdf',
      pages: 20,
      chunks: [
        { page: 5, text: 'zeta page five' },
        { page: 2, text: 'zeta page two' },
        { page: 2, text: 'zeta page two again' },
      ],
    },
    { sha256: 'd'.repeat(64), path: 'alpha.pdf', pages: 9, chunks: [{ page: 9, text: 'alpha page nine' }] },
  ]);
  const packRoot = await makePackRoot();
  try {
    const report = await packTool(root, packRoot).execute({}, {});
    assertSuccess(report);
    assert.match(nodePath.basename(report.packDir), /^pack-\d{8}-\d{6}$/);
    const lines = await readChunkLines(report.packDir);
    assert.deepEqual(lines.map((line) => {
      const row = JSON.parse(line) as { path: string; page: number; text: string };
      return row.path + '#' + row.page + ' ' + row.text;
    }), [
      'alpha.pdf#9 alpha page nine',
      'zeta.pdf#2 zeta page two',
      'zeta.pdf#2 zeta page two again',
      'zeta.pdf#5 zeta page five',
    ]);
    assert.equal(report.counts.chunks, 4);
    const manifest = await readManifest(report.packDir);
    assert.deepEqual(manifest.sources.map((source) => source.path), ['alpha.pdf', 'zeta.pdf']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
});

test('refuses to export while allowWrites is false', async () => {
  const root = await makeVault([
    { sha256: '1'.repeat(64), path: 'book.pdf', pages: 1, chunks: [{ page: 1, text: 'some text' }] },
  ]);
  const packRoot = await makePackRoot();
  try {
    const report = await packTool(root, packRoot, false).execute({ name: 'demo' }, {});
    assertRefusal(report);
    assert.equal(report.error.code, 'kb.pack.read-only');
    assert.equal(existsSync(nodePath.join(packRoot, 'demo')), false);
    assert.deepEqual(await readFile(nodePath.join(root, '.wiki', 'index', 'catalog.json'), 'utf8') !== '', true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
});

test('refuses when no pack directory is configured', async () => {
  const root = await makeVault([
    { sha256: '2'.repeat(64), path: 'book.pdf', pages: 1, chunks: [{ page: 1, text: 'some text' }] },
  ]);
  try {
    const tool = packTool(root, '');
    const noDirectory = await tool.execute({ name: 'demo' }, {});
    assertRefusal(noDirectory);
    assert.equal(noDirectory.error.code, 'kb.pack.no-pack-dir');
    assert.match(noDirectory.error.message, /settings page/);

    const relativeOutDir = await tool.execute({ name: 'demo', outDir: 'relative/one' }, {});
    assertRefusal(relativeOutDir);
    assert.equal(relativeOutDir.error.code, 'kb.pack.no-pack-dir');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses an empty index and points at kb_ingest', async () => {
  const root = await makeVault([]);
  const packRoot = await makePackRoot();
  try {
    const report = await packTool(root, packRoot).execute({ name: 'demo' }, {});
    assertRefusal(report);
    assert.equal(report.error.code, 'kb.pack.empty-index');
    assert.ok(report.error.message.includes('kb_ingest'));
    assert.equal(existsSync(nodePath.join(packRoot, 'demo')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
});

test('the same index exports byte-identical bytes apart from generatedAt', async () => {
  const root = await makeVault([{
    sha256: 'e'.repeat(64),
    path: 'book.pdf',
    pages: 4,
    chunks: [
      { page: 1, section: 'Intro', text: 'alpha text' },
      { page: 4, text: 'beta text' },
    ],
  }]);
  const packRoot = await makePackRoot();
  try {
    const first = await runExportPack(new NodeVaultFs(root), nodePackWriter, {
      vaultRoot: root,
      vaultName: 'vault',
      packName: 'demo',
      packDir: nodePath.join(packRoot, 'first'),
      generatedAt: new Date('2026-02-03T04:05:06.000Z'),
      pluginVersion: '9.9.9',
    });
    const second = await runExportPack(new NodeVaultFs(root), nodePackWriter, {
      vaultRoot: root,
      vaultName: 'vault',
      packName: 'demo',
      packDir: nodePath.join(packRoot, 'second'),
      generatedAt: new Date('2026-02-04T00:00:00.000Z'),
      pluginVersion: '9.9.9',
    });
    assert.deepEqual(first.counts, second.counts);
    const [chunksFirst, chunksSecond, skillFirst, skillSecond] = await Promise.all([
      readFile(nodePath.join(first.packDir, 'chunks.jsonl'), 'utf8'),
      readFile(nodePath.join(second.packDir, 'chunks.jsonl'), 'utf8'),
      readFile(nodePath.join(first.packDir, 'SKILL.md'), 'utf8'),
      readFile(nodePath.join(second.packDir, 'SKILL.md'), 'utf8'),
    ]);
    assert.equal(chunksFirst, chunksSecond);
    assert.equal(skillFirst, skillSecond);

    const manifestFirst = await readManifest(first.packDir);
    const manifestSecond = await readManifest(second.packDir);
    assert.equal(manifestFirst.generatedAt, '2026-02-03T04:05:06.000Z');
    assert.equal(manifestSecond.generatedAt, '2026-02-04T00:00:00.000Z');
    assert.equal(manifestFirst.plugin.version, '9.9.9');
    assert.deepEqual({ ...manifestFirst, generatedAt: '' }, { ...manifestSecond, generatedAt: '' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
});

test('README.md is written only when the pack has gaps', async () => {
  const root = await makeVault([
    { sha256: 'f'.repeat(64), path: 'good.pdf', pages: 2, chunks: [{ page: 1, text: 'present text' }] },
    { sha256: '0'.repeat(64), path: 'missing.pdf', pages: 40, chunks: [], catalogChunks: 2 },
  ]);
  const packRoot = await makePackRoot();
  try {
    const report = await packTool(root, packRoot).execute({ name: 'gaps' }, {});
    assertSuccess(report);
    assert.deepEqual(report.files.map((file) => file.name), ['manifest.json', 'chunks.jsonl', 'SKILL.md', 'README.md']);
    assert.equal(report.counts.sources, 2);
    assert.equal(report.counts.chunks, 1);
    assert.equal(report.warnings.length, 1);
    assert.ok(report.warnings[0]?.includes('missing.pdf'));

    const manifest = await readManifest(report.packDir);
    assert.deepEqual(manifest.sources.map((source) => [source.path, source.pages, source.chunks]), [
      ['good.pdf', 2, 1],
      ['missing.pdf', 40, 0],
    ]);

    const readme = await readFile(nodePath.join(report.packDir, 'README.md'), 'utf8');
    assert.ok(readme.includes('manifest.json'));
    assert.ok(readme.includes('missing.pdf'));
    assert.ok(readme.includes('kb_ingest'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
});
