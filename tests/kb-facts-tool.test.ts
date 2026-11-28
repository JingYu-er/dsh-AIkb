import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { test } from 'node:test';

import { NodeVaultFs } from '../src/adapters/fs/node-vault-fs.js';
import { buildMap, serializeMap } from '../src/application/vault-map.js';
import {
  FACTS_PATH,
  FACTS_SCHEMA,
  FACTS_VERSION,
  factId,
  parseFacts,
  serializeFacts,
} from '../src/application/vault-facts.js';
import type { FactEntry, FactsFile } from '../src/application/vault-facts.js';
import type { Evidence } from '../src/application/vault-memory.js';
import { createKbFactsTool } from '../src/tools/kb-facts.tool.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const STAMP = '2026-02-01T00:00:00.000Z';
const WRITE_STAMP = '2026-03-01T00:00:00.000Z';
const tempBase = nodePath.resolve(process.cwd(), '..', 'temp');

interface IndexedSource {
  readonly path: string;
  readonly pages: number;
}

async function makeVault(): Promise<string> {
  await mkdir(tempBase, { recursive: true });
  const root = await mkdtemp(nodePath.join(tempBase, 'kb-facts-tool-'));
  await mkdir(nodePath.join(root, '.obsidian'), { recursive: true });
  await mkdir(nodePath.join(root, '.wiki', 'index', 'chunks'), { recursive: true });
  return root;
}

async function writeCatalog(root: string, sources: Record<string, IndexedSource>): Promise<void> {
  const body = {
    schema: 'dsh-aikb/index@1',
    updatedAt: STAMP,
    sources: Object.fromEntries(
      Object.entries(sources).map(([sha, source]) => [
        sha,
        { path: source.path, format: 'pdf', pages: source.pages, chunks: 1, tokens: 10, ingestedAt: STAMP },
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
  const map = await buildMap(new NodeVaultFs(root), { now: new Date(STAMP) });
  await writeFile(nodePath.join(root, '.wiki', 'index', 'map.json'), serializeMap(map), 'utf8');
}

interface FactSpec {
  readonly entityId: string;
  readonly entityLabel: string;
  readonly value: string;
  readonly field?: string;
  readonly unit?: string;
  readonly path?: string;
  readonly sha?: string;
  readonly status?: 'derived' | 'verified' | 'disputed';
}

function factEntry(spec: FactSpec): FactEntry {
  const field = spec.field ?? 'output_voltage';
  const path = spec.path ?? 'manual.pdf';
  const sha = spec.sha ?? SHA_A;
  const evidence: Evidence[] = [{ path, unit: 'page', locator: '1', quote: 'quote', sha }];
  return {
    id: factId(spec.entityId, field),
    entityId: spec.entityId,
    entityLabel: spec.entityLabel,
    field,
    value: spec.value,
    ...(spec.unit === undefined ? {} : { unit: spec.unit }),
    evidence,
    sources: [path],
    shaByPath: { [path]: sha },
    extractor: 'test',
    status: spec.status ?? 'verified',
    confidence: 0.8,
    updatedAt: STAMP,
    lastUsedAt: STAMP,
    useCount: 0,
  };
}

async function writeFactsFile(root: string, entries: readonly FactEntry[]): Promise<void> {
  const file: FactsFile = { schema: FACTS_SCHEMA, version: FACTS_VERSION, builtAt: STAMP, entries: [...entries] };
  await writeFile(nodePath.join(root, '.wiki', 'index', 'facts.json'), serializeFacts(file), 'utf8');
}

async function readFacts(root: string): Promise<FactsFile> {
  return parseFacts(await readFile(nodePath.join(root, '.wiki', 'index', 'facts.json'), 'utf8'));
}

interface VaultOptions {
  readonly index?: boolean;
  readonly map?: boolean;
  readonly writes?: boolean;
}

async function withVault(
  run: (root: string, factsTool: ReturnType<typeof createKbFactsTool>) => Promise<void>,
  options: VaultOptions = {},
): Promise<void> {
  const root = await makeVault();
  try {
    if (options.index !== false) await seedIndex(root);
    if (options.map !== false) await seedMap(root);
    const factsTool = createKbFactsTool({
      resolveRoot: () => root,
      allowWrites: options.writes === true,
      now: () => new Date(WRITE_STAMP),
    });
    await run(root, factsTool);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('plan reuses a fact whose source hash is still current', async () => {
  await withVault(async (root, factsTool) => {
    await writeFactsFile(root, [factEntry({ entityId: 'lm7805', entityLabel: 'LM7805', value: '5' })]);
    const report = await factsTool.execute({ action: 'plan', entities: ['LM7805'], fields: ['output_voltage'] }, {});
    assert.equal(report.ok, true);
    assert.equal(report.reuseCount, 1);
    assert.equal(report.rebuildCount, 0);
    assert.deepEqual(report.work ?? [], []);
    assert.deepEqual(report.missingEntities ?? [], []);
    assert.match(report.next ?? '', /kb_query/u);
  });
});

test('plan asks for a rebuild when the source hash changed', async () => {
  await withVault(async (root, factsTool) => {
    await writeFactsFile(root, [
      factEntry({ entityId: 'lm7805', entityLabel: 'LM7805', value: '5', sha: 'd'.repeat(64) }),
    ]);
    const report = await factsTool.execute({ action: 'plan', entities: ['LM7805'], fields: ['output_voltage'] }, {});
    assert.equal(report.ok, true);
    assert.equal(report.reuseCount, 0);
    assert.equal(report.rebuildCount, 1);
    assert.deepEqual(report.work ?? [], []);
  });
});

test('plan lists work for missing cells and reports unknown entities', async () => {
  await withVault(async (_root, factsTool) => {
    const report = await factsTool.execute({ action: 'plan', entities: ['LM7805', 'TP4056'], fields: ['mass'] }, {});
    assert.equal(report.ok, true);
    assert.deepEqual(report.missingEntities, ['TP4056']);
    const work = report.work ?? [];
    assert.equal(work.length, 1);
    const item = work[0];
    assert.ok(item !== undefined);
    assert.equal(item.entityId, 'lm7805');
    assert.equal(item.field, 'mass');
    assert.match(item.hint, /mass/u);
    assert.match(item.hint, /LM7805/u);
    assert.match(report.summary ?? '', /未知实体 1 个/u);
    assert.equal((report.notes ?? []).length, 1);
  });
});

test('plan without entities or fields is a bad request', async () => {
  await withVault(async (_root, factsTool) => {
    const noEntities = await factsTool.execute({ action: 'plan', fields: ['mass'] }, {});
    assert.equal(noEntities.ok, false);
    assert.equal(noEntities.error?.code, 'kb.facts.bad-request');
    const noFields = await factsTool.execute({ action: 'plan', entities: ['LM7805'] }, {});
    assert.equal(noFields.ok, false);
    assert.equal(noFields.error?.code, 'kb.facts.bad-request');
  });
});

test('plan without a map points at kb_map build', async () => {
  await withVault(
    async (_root, factsTool) => {
      const report = await factsTool.execute({ action: 'plan', entities: ['LM7805'], fields: ['mass'] }, {});
      assert.equal(report.ok, false);
      assert.equal(report.error?.code, 'kb.map.missing');
      assert.match(report.hint ?? '', /kb_map/u);
    },
    { map: false },
  );
});

test('write stores a fact whose quote is found in the page text', async () => {
  await withVault(
    async (root, factsTool) => {
      const report = await factsTool.execute(
        {
          action: 'write',
          facts: [
            {
              entity: 'LM7805',
              field: 'output_voltage',
              value: '5',
              unit: 'V',
              evidence: [
                { path: 'manual.pdf', unit: 'page', locator: '1', quote: 'LM7805 output is 5 V' },
              ],
            },
          ],
        },
        {},
      );
      assert.equal(report.ok, true);
      assert.equal(report.written, 1);
      assert.equal(report.rejected, 0);
      assert.equal(report.file, FACTS_PATH);
      const row = (report.results ?? [])[0];
      assert.ok(row !== undefined);
      assert.equal(row.status, 'written');
      assert.equal(row.entityId, 'lm7805');
      assert.equal(row.entryId, 'lm7805--output_voltage');

      const file = await readFacts(root);
      assert.equal(file.entries.length, 1);
      const entry = file.entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.status, 'verified');
      assert.equal(entry.value, '5');
      assert.equal(entry.unit, 'V');
      assert.deepEqual(entry.sources, ['manual.pdf']);
      assert.equal(entry.shaByPath['manual.pdf'], SHA_A);
      const evidence = entry.evidence[0];
      assert.ok(evidence !== undefined);
      assert.equal(evidence.sha, SHA_A);
      assert.equal(evidence.locator, '1');
    },
    { writes: true },
  );
});

test('write defaults a missing evidence unit to page', async () => {
  await withVault(
    async (root, factsTool) => {
      const report = await factsTool.execute(
        {
          action: 'write',
          facts: [
            {
              entity: 'LM7805',
              field: 'output_voltage',
              value: '5',
              evidence: [{ path: 'manual.pdf', locator: '1', quote: 'LM7805 output is 5 V' }],
            },
          ],
        },
        {},
      );
      assert.equal(report.ok, true);
      assert.equal(report.written, 1);
      const file = await readFacts(root);
      assert.equal(file.entries[0]?.evidence[0]?.unit, 'page');
    },
    { writes: true },
  );
});

test('write rejects a quote that is not in the stored chunks', async () => {
  await withVault(
    async (root, factsTool) => {
      const report = await factsTool.execute(
        {
          action: 'write',
          facts: [
            {
              entity: 'LM7805',
              field: 'output_voltage',
              value: '5',
              evidence: [
                { path: 'manual.pdf', unit: 'page', locator: '1', quote: 'the output is exactly five volts' },
              ],
            },
          ],
        },
        {},
      );
      assert.equal(report.ok, false);
      assert.equal(report.written, 0);
      assert.equal(report.rejected, 1);
      const row = (report.results ?? [])[0];
      assert.ok(row !== undefined);
      assert.equal(row.status, 'rejected');
      assert.equal(row.code, 'kb.facts.no-evidence');
      assert.match(row.reason ?? '', /does not verify/u);
      await assert.rejects(readFile(nodePath.join(root, '.wiki', 'index', 'facts.json'), 'utf8'));
    },
    { writes: true },
  );
});

test('write rejects an entity that is not in the map', async () => {
  await withVault(
    async (_root, factsTool) => {
      const report = await factsTool.execute(
        {
          action: 'write',
          facts: [
            {
              entity: 'TP4056',
              field: 'capacity',
              value: '1000',
              evidence: [{ path: 'manual.pdf', unit: 'page', locator: '1', quote: 'LM7805' }],
            },
          ],
        },
        {},
      );
      assert.equal(report.ok, false);
      assert.equal(report.written, 0);
      const row = (report.results ?? [])[0];
      assert.ok(row !== undefined);
      assert.equal(row.code, 'kb.facts.no-entity');
      assert.match(row.reason ?? '', /TP4056/u);
    },
    { writes: true },
  );
});

test('write is refused when writes are disabled', async () => {
  await withVault(async (root, factsTool) => {
    const report = await factsTool.execute(
      {
        action: 'write',
        facts: [
          {
            entity: 'LM7805',
            field: 'output_voltage',
            value: '5',
            evidence: [{ path: 'manual.pdf', unit: 'page', locator: '1', quote: 'LM7805 output is 5 V' }],
          },
        ],
      },
      {},
    );
    assert.equal(report.ok, false);
    assert.equal(report.error?.code, 'kb.facts.read-only');
    assert.match(report.error?.message ?? '', /allowWrites is false/u);
    await assert.rejects(readFile(nodePath.join(root, '.wiki', 'index', 'facts.json'), 'utf8'));
  });
});

test('table renders a markdown table and reports cross-entity conflicts', async () => {
  await withVault(async (root, factsTool) => {
    await writeFactsFile(root, [
      factEntry({ entityId: 'lm7805', entityLabel: 'LM7805', value: '5', unit: 'V' }),
      factEntry({ entityId: 'op07', entityLabel: 'OP07', value: '9', unit: 'V', path: 'notes/op07.md', sha: SHA_B }),
    ]);
    const report = await factsTool.execute({ action: 'table', fields: ['output_voltage'] }, {});
    assert.equal(report.ok, true);
    assert.equal(report.entryCount, 2);
    assert.equal(report.verifiedCount, 2);
    assert.equal(report.staleDropped, 0);
    const table = report.table ?? '';
    assert.match(table, /### output_voltage/u);
    assert.match(table, /\| 实体 \| 值 \| 状态 \| 出处 \|/u);
    assert.match(table, /LM7805/u);
    assert.match(table, /5 V/u);
    const conflicts = report.conflicts ?? [];
    assert.equal(conflicts.length, 1);
    const conflict = conflicts[0];
    assert.ok(conflict !== undefined);
    assert.equal(conflict.field, 'output_voltage');
    assert.deepEqual(conflict.values, ['5', '9']);
    const rendered = factsTool.output.render({ action: 'table' }, report)[0]?.text ?? '';
    assert.match(rendered, /冲突 output_voltage/u);
  });
});

test('table filters by entity label', async () => {
  await withVault(async (root, factsTool) => {
    await writeFactsFile(root, [
      factEntry({ entityId: 'lm7805', entityLabel: 'LM7805', value: '5', unit: 'V' }),
      factEntry({ entityId: 'op07', entityLabel: 'OP07', value: '9', unit: 'V', path: 'notes/op07.md', sha: SHA_B }),
    ]);
    const report = await factsTool.execute({ action: 'table', entities: ['OP07'] }, {});
    assert.equal(report.ok, true);
    assert.equal(report.entryCount, 1);
    assert.match(report.table ?? '', /OP07/u);
    assert.doesNotMatch(report.table ?? '', /LM7805/u);
  });
});

test('table without a facts file returns the empty-table message', async () => {
  await withVault(async (_root, factsTool) => {
    const report = await factsTool.execute({ action: 'table' }, {});
    assert.equal(report.ok, false);
    assert.equal(report.error?.code, 'kb.facts.bad-request');
    assert.match(report.error?.message ?? '', /库里还没有可比较的事实/u);
    assert.equal(report.entryCount, 0);
    assert.equal(report.staleDropped, 0);
    assert.deepEqual(report.conflicts ?? [], []);
  });
});

test('table drops stale facts and rewrites the file', async () => {
  await withVault(
    async (root, factsTool) => {
      await writeFactsFile(root, [
        factEntry({ entityId: 'lm7805', entityLabel: 'LM7805', value: '5', sha: 'e'.repeat(64) }),
      ]);
      const report = await factsTool.execute({ action: 'table' }, {});
      assert.equal(report.staleDropped, 1);
      assert.equal(report.entryCount, 0);
      assert.equal(report.ok, false);
      const file = await readFacts(root);
      assert.deepEqual(file.entries, []);
    },
    { writes: true },
  );
});
