import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { test } from 'node:test';

import { NodeVaultFs } from '../src/adapters/fs/node-vault-fs.js';
import { MAP_SCHEMA, buildMap, serializeMap } from '../src/application/vault-map.js';
import { MAP_MISSING_HINT, MAP_MISSING_MESSAGE, createKbMapTool } from '../src/tools/kb-map.tool.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const BUILT_AT = '2026-02-01T00:00:00.000Z';
const tempBase = nodePath.resolve(process.cwd(), '..', 'temp');

interface IndexedSource {
  readonly path: string;
  readonly pages: number;
}

async function makeVault(): Promise<string> {
  await mkdir(tempBase, { recursive: true });
  const root = await mkdtemp(nodePath.join(tempBase, 'kb-map-tool-'));
  await mkdir(nodePath.join(root, '.obsidian'), { recursive: true });
  await mkdir(nodePath.join(root, '.wiki', 'index', 'chunks'), { recursive: true });
  return root;
}

async function writeCatalog(root: string, sources: Record<string, IndexedSource>): Promise<void> {
  const body = {
    schema: 'dsh-aikb/index@1',
    updatedAt: BUILT_AT,
    sources: Object.fromEntries(
      Object.entries(sources).map(([sha, source]) => [
        sha,
        {
          path: source.path,
          format: 'pdf',
          pages: source.pages,
          chunks: 1,
          tokens: 10,
          ingestedAt: BUILT_AT,
        },
      ]),
    ),
  };
  await writeFile(nodePath.join(root, '.wiki', 'index', 'catalog.json'), JSON.stringify(body, null, 2) + '\n', 'utf8');
}

function chunkLine(sha: string, id: string, page: number, section: string | undefined, text: string): Record<string, unknown> {
  return {
    id,
    sourceId: sha,
    page,
    ...(section === undefined ? {} : { section }),
    text,
    tokens: text.split(' ').length,
  };
}

async function writeChunks(root: string, sha: string, lines: readonly Record<string, unknown>[]): Promise<void> {
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  await writeFile(nodePath.join(root, '.wiki', 'index', 'chunks', sha + '.jsonl'), text, 'utf8');
}

async function seedIndex(root: string): Promise<void> {
  await writeCatalog(root, {
    [SHA_A]: { path: 'manual.pdf', pages: 2 },
    [SHA_B]: { path: 'notes/op07.md', pages: 1 },
    [SHA_C]: { path: 'plain.md', pages: 1 },
  });
  await writeChunks(root, SHA_A, [
    chunkLine(SHA_A, SHA_A + ':1:0', 1, 'Regulator', 'LM7805 regulator: LM7805 output is 5 V.'),
    chunkLine(SHA_A, SHA_A + ':2:0', 2, 'Dropout', 'Dropout voltage is 2 V at 1 A.'),
  ]);
  await writeChunks(root, SHA_B, [chunkLine(SHA_B, SHA_B + ':1:0', 1, 'Op amp', 'OP07 offset is 10 uV. OP07 is precision.')]);
  await writeChunks(root, SHA_C, [chunkLine(SHA_C, SHA_C + ':1:0', 1, undefined, 'Plain notes with no part numbers at all.')]);
}

async function seedMap(root: string): Promise<void> {
  const map = await buildMap(new NodeVaultFs(root), { now: new Date(BUILT_AT) });
  await writeFile(nodePath.join(root, '.wiki', 'index', 'map.json'), serializeMap(map), 'utf8');
}

async function withVault(
  run: (root: string, mapTool: ReturnType<typeof createKbMapTool>) => Promise<void>,
  options: { readonly index?: boolean; readonly map?: boolean } = {},
): Promise<void> {
  const root = await makeVault();
  try {
    if (options.index !== false) await seedIndex(root);
    if (options.map !== false) await seedMap(root);
    const mapTool = createKbMapTool({ resolveRoot: () => root, now: () => new Date(BUILT_AT) });
    await run(root, mapTool);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('coverage reports the map totals as text and as counts', async () => {
  await withVault(async (root, mapTool) => {
    const report = await mapTool.execute({}, {});
    assert.equal(report.ok, true);
    assert.equal(report.action, 'coverage');
    assert.equal(report.vaultRoot, root);
    assert.equal(report.builtAt, BUILT_AT);
    const coverage = report.coverage;
    assert.ok(coverage !== undefined);
    assert.equal(coverage.docs, 3);
    assert.equal(coverage.pages, 4);
    assert.equal(coverage.sections, 3);
    assert.equal(coverage.entities, 2);
    assert.equal(coverage.docsWithoutSections, 1);
    assert.equal(coverage.docsWithoutEntities, 1);
    assert.deepEqual(coverage.unparsed, []);
    assert.match(coverage.text, /文档 3 篇/u);
    assert.match(coverage.text, /实体 2 个/u);
  });
});

test('coverage renders a readable text report', async () => {
  await withVault(async (_root, mapTool) => {
    const report = await mapTool.execute({ action: 'coverage' }, {});
    assert.equal(report.ok, true);
    const rendered = mapTool.output.render({}, report);
    assert.equal(rendered.length, 1);
    const text = rendered[0]?.text ?? '';
    assert.match(text, /库地图覆盖/u);
    assert.match(text, /"docs":3/u);
    assert.match(text, /"unparsed":0/u);
  });
});

test('docs lists documents with page and section counts', async () => {
  await withVault(async (_root, mapTool) => {
    const report = await mapTool.execute({ action: 'docs' }, {});
    assert.equal(report.ok, true);
    assert.equal(report.docCount, 3);
    const docs = report.docs ?? [];
    assert.equal(docs.length, 3);
    assert.deepEqual(docs.map((row) => row.path), ['manual.pdf', 'notes/op07.md', 'plain.md']);
    assert.deepEqual(docs.map((row) => row.pageCount), [2, 1, 1]);
    assert.deepEqual(docs.map((row) => row.sections), [2, 1, 0]);
    for (const row of docs) assert.ok(row.title.length > 0);
  });
});

test('docs filters on path or title and honours limit', async () => {
  await withVault(async (_root, mapTool) => {
    const filtered = await mapTool.execute({ action: 'docs', query: 'OP07' }, {});
    assert.equal(filtered.ok, true);
    assert.equal(filtered.docCount, 1);
    assert.deepEqual((filtered.docs ?? []).map((row) => row.path), ['notes/op07.md']);

    const limited = await mapTool.execute({ action: 'docs', limit: 1 }, {});
    assert.equal(limited.ok, true);
    assert.equal(limited.limit, 1);
    assert.equal(limited.docCount, 3);
    assert.equal((limited.docs ?? []).length, 1);
    assert.equal(limited.docs?.[0]?.path, 'manual.pdf');
  });
});

test('entities lists entities sorted by mention count', async () => {
  await withVault(async (_root, mapTool) => {
    const report = await mapTool.execute({ action: 'entities' }, {});
    assert.equal(report.ok, true);
    assert.equal(report.entityCount, 2);
    const rows = report.entities ?? [];
    assert.equal(rows.length, 2);
    const first = rows[0];
    assert.ok(first !== undefined);
    assert.equal(first.id, 'lm7805');
    assert.equal(first.label, 'LM7805');
    assert.equal(first.mentions, 2);
    assert.deepEqual(first.sources, ['manual.pdf']);
    const second = rows[1];
    assert.ok(second !== undefined);
    assert.equal(second.id, 'op07');
    assert.deepEqual(second.sources, ['notes/op07.md']);
  });
});

test('entities looks up a name case-insensitively', async () => {
  await withVault(async (_root, mapTool) => {
    const report = await mapTool.execute({ action: 'entities', query: 'op07' }, {});
    assert.equal(report.ok, true);
    assert.equal(report.entityCount, 1);
    const row = report.entities?.[0];
    assert.ok(row !== undefined);
    assert.equal(row.id, 'op07');
    assert.equal(row.mentions, 2);
  });
});

test('sections lists anchors for one document', async () => {
  await withVault(async (_root, mapTool) => {
    const report = await mapTool.execute({ action: 'sections', path: 'notes/op07.md' }, {});
    assert.equal(report.ok, true);
    const doc = report.doc;
    assert.ok(doc !== undefined);
    assert.equal(doc.path, 'notes/op07.md');
    assert.equal(doc.pageCount, 1);
    const sections = report.sections ?? [];
    assert.equal(sections.length, 1);
    const section = sections[0];
    assert.ok(section !== undefined);
    assert.equal(section.title, 'Op amp');
    assert.equal(section.pageStart, 1);
    assert.equal(section.pageEnd, 1);
    assert.equal(section.anchor, 'notes/op07.md#Op amp');
    assert.match(report.note ?? '', /path#title/u);
  });
});

test('sections without a path is a usage error, not a crash', async () => {
  await withVault(async (_root, mapTool) => {
    const report = await mapTool.execute({ action: 'sections' }, {});
    assert.equal(report.ok, false);
    assert.equal(report.error?.code, 'kb.map.missing');
    assert.match(report.error?.message ?? '', /sections 需要 path/u);
    assert.ok((report.hint ?? '').length > 0);
  });
});

test('sections on an unknown document reports the missing path', async () => {
  await withVault(async (_root, mapTool) => {
    const report = await mapTool.execute({ action: 'sections', path: 'nope.pdf' }, {});
    assert.equal(report.ok, false);
    assert.equal(report.error?.code, 'kb.map.missing');
    assert.match(report.error?.message ?? '', /库里没有这篇文档：nope\.pdf/u);
  });
});

test('a missing map is reported with the exact hint and never auto-built', async () => {
  await withVault(
    async (root, mapTool) => {
      const report = await mapTool.execute({ action: 'coverage' }, {});
      assert.equal(report.ok, false);
      assert.equal(report.error?.code, 'kb.map.missing');
      assert.equal(report.error?.message, MAP_MISSING_MESSAGE);
      assert.equal(report.hint, MAP_MISSING_HINT);
      await assert.rejects(readFile(nodePath.join(root, '.wiki', 'index', 'map.json'), 'utf8'));
    },
    { map: false },
  );
});

test('a corrupt map is reported like a missing one', async () => {
  await withVault(
    async (root, mapTool) => {
      await writeFile(nodePath.join(root, '.wiki', 'index', 'map.json'), 'not json', 'utf8');
      const report = await mapTool.execute({ action: 'docs' }, {});
      assert.equal(report.ok, false);
      assert.equal(report.error?.code, 'kb.map.missing');
      assert.equal(report.error?.message, MAP_MISSING_MESSAGE);
      assert.match(report.hint ?? '', /重建/u);
    },
    { map: false },
  );
});

test('build writes map.json and read actions work afterwards', async () => {
  await withVault(
    async (root, mapTool) => {
      const built = await mapTool.execute({ action: 'build' }, {});
      assert.equal(built.ok, true);
      assert.equal(built.written, true);
      assert.equal(built.incremental, false);
      assert.equal(built.mapPath, '.wiki/index/map.json');
      assert.equal(built.docCount, 3);
      assert.equal(built.entityCount, 2);
      assert.equal(built.builtAt, BUILT_AT);

      const text = await readFile(nodePath.join(root, '.wiki', 'index', 'map.json'), 'utf8');
      const parsed = JSON.parse(text) as { schema?: string; docs?: unknown[] };
      assert.equal(parsed.schema, MAP_SCHEMA);
      assert.equal((parsed.docs ?? []).length, 3);

      const coverage = await mapTool.execute({ action: 'coverage' }, {});
      assert.equal(coverage.ok, true);
      assert.equal(coverage.coverage?.docs, 3);
    },
    { map: false },
  );
});

test('build reuses the previous map when one exists', async () => {
  await withVault(async (_root, mapTool) => {
    const built = await mapTool.execute({ action: 'build' }, {});
    assert.equal(built.ok, true);
    assert.equal(built.incremental, true);
    assert.match(built.summary ?? '', /增量/u);
  });
});

test('build without an index explains the kb_ingest prerequisite', async () => {
  await withVault(
    async (_root, mapTool) => {
      const built = await mapTool.execute({ action: 'build' }, {});
      assert.equal(built.ok, false);
      assert.equal(built.error?.code, 'kb.map.missing');
      assert.match(built.hint ?? '', /kb_ingest/u);
    },
    { map: false, index: false },
  );
});
