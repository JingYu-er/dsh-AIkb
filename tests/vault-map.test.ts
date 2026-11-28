import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { NodeVaultFs } from '../src/adapters/fs/node-vault-fs.js';
import { buildMap, docFor, findEntities, mapCoverage, serializeMap } from '../src/application/vault-map.js';
import type { MapFile, MapFs, MapSourceRef } from '../src/application/vault-map.js';
import { DomainError } from '../src/shared/result.js';

const SHA_A = 'a'.repeat(64);
const SHA_B1 = 'b'.repeat(64);
const SHA_B2 = 'd'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'e'.repeat(64);
const SHA_E = 'f'.repeat(64);
const T1 = new Date('2026-02-01T00:00:00.000Z');
const T2 = new Date('2026-02-02T00:00:00.000Z');

interface ChunkSpec {
  readonly page: number;
  readonly text: string;
  readonly section?: string;
}

interface SourceSpec extends MapSourceRef {
  readonly chunks?: readonly ChunkSpec[];
}

async function writeChunks(root: string, sha: string, chunks: readonly ChunkSpec[]): Promise<void> {
  const abs = path.join(root, '.wiki/index/chunks/' + sha + '.jsonl');
  await mkdir(path.dirname(abs), { recursive: true });
  const lines = chunks.map((chunk, index) =>
    JSON.stringify({
      id: sha + ':p' + chunk.page + ':' + index,
      sourceId: sha,
      page: chunk.page,
      section: chunk.section ?? '',
      text: chunk.text,
      tokens: 1,
    }),
  );
  await writeFile(abs, lines.join('\n') + '\n', 'utf8');
}

async function makeVault(sources: readonly SourceSpec[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-aikb-map-'));
  const catalog = {
    schema: 'dsh-aikb/index@1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sources: {} as Record<string, unknown>,
  };
  for (const source of sources) {
    catalog.sources[source.sha] = {
      path: source.path,
      format: 'pdf',
      pages: source.pages ?? 0,
      chunks: source.chunks?.length ?? 0,
      tokens: 0,
      ingestedAt: '2026-01-01T00:00:00.000Z',
    };
    if (source.chunks !== undefined) await writeChunks(root, source.sha, source.chunks);
  }
  await mkdir(path.join(root, '.wiki/index'), { recursive: true });
  await writeFile(path.join(root, '.wiki/index/catalog.json'), JSON.stringify(catalog), 'utf8');
  return root;
}

async function writeGlossary(root: string, entries: readonly { readonly a: string; readonly b: string }[]): Promise<void> {
  const payload = {
    schema: 'dsh-aikb/glossary@1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: entries.map((entry) => ({ a: entry.a, b: entry.b, hits: 9, books: 3, kind: 'zh-en' })),
  };
  await writeFile(path.join(root, '.wiki/index/glossary.json'), JSON.stringify(payload), 'utf8');
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

interface CountingFs {
  readonly fs: MapFs;
  readonly reads: string[];
}

function countingFs(root: string): CountingFs {
  const inner = new NodeVaultFs(root);
  const reads: string[] = [];
  return {
    fs: {
      root,
      exists: (relPath: string) => inner.exists(relPath),
      readText: (relPath: string) => {
        reads.push(relPath);
        return inner.readText(relPath);
      },
    },
    reads,
  };
}

test('sections split on structural headings and skip the contents page', async () => {
  const root = await makeVault([
    {
      path: '书/电路基础.pdf',
      sha: SHA_A,
      pages: 5,
      chunks: [
        { page: 1, text: '目录\n1.1 基本概念 2\n1.2 分析方法 4' },
        { page: 2, text: '第1章 绪论\n本章介绍电路的模型。' },
        { page: 3, text: '1.1 基本概念\n电压与电流。' },
        { page: 4, text: '1.2 分析方法\n节点法与网孔法。' },
        { page: 5, text: '第2章 正弦稳态\n相量法。' },
      ],
    },
  ]);
  try {
    const map = await buildMap(new NodeVaultFs(root), { now: T1 });
    assert.equal(map.schema, 'dsh-aikb/map@1');
    assert.equal(map.docs.length, 1);
    const doc = map.docs[0];
    assert.ok(doc);
    assert.equal(doc.title, '电路基础');
    assert.equal(doc.pageCount, 5);
    assert.equal(doc.firstLine, '目录');
    assert.deepEqual(doc.sections, [
      { title: '第1章 绪论', pageStart: 2, pageEnd: 3 },
      { title: '1.1 基本概念', pageStart: 3, pageEnd: 4 },
      { title: '1.2 分析方法', pageStart: 4, pageEnd: 5 },
      { title: '第2章 正弦稳态', pageStart: 5, pageEnd: 5 },
    ]);
    assert.equal(map.coverage.docs, 1);
    assert.equal(map.coverage.pages, 5);
    assert.equal(map.coverage.sections, 4);
    assert.equal(map.coverage.docsWithoutSections, 0);
    assert.deepEqual(map.coverage.unparsed, []);
  } finally {
    await cleanup(root);
  }
});

test('a document without chunks is kept and listed as unparsed', async () => {
  const root = await makeVault([
    {
      path: 'a/好卷.pdf',
      sha: SHA_A,
      pages: 2,
      chunks: [
        { page: 1, text: '第1章 概述\n正文。' },
        { page: 2, text: '继续。' },
      ],
    },
    { path: '书/缺卷.pdf', sha: SHA_B1, pages: 12 },
  ]);
  try {
    const map = await buildMap(new NodeVaultFs(root), { now: T1 });
    assert.deepEqual(
      map.docs.map((doc) => doc.path),
      ['a/好卷.pdf', '书/缺卷.pdf'],
    );
    const missing = docFor(map, '书/缺卷.pdf');
    assert.ok(missing);
    assert.equal(missing.pageCount, 12);
    assert.equal(missing.firstLine, '');
    assert.deepEqual(missing.sections, []);
    assert.deepEqual(map.coverage.unparsed, ['书/缺卷.pdf']);
    assert.equal(map.coverage.docsWithoutSections, 1);
    assert.equal(map.coverage.docsWithoutEntities, 2);
  } finally {
    await cleanup(root);
  }
});

test('prose, decimals, bare numbers and TOC leaders are not headings; page numbers are stripped', async () => {
  const root = await makeVault([
    {
      path: '书/数字电路.pdf',
      sha: SHA_A,
      pages: 1,
      chunks: [
        {
          page: 1,
          text: '0.5 安培\n5V 输入\n2.5.1\n1.1 基本概念 ...... 12\n447 9.4 稳压管稳压电路\n第 3 章 数字电路\n1. 实验步骤',
        },
      ],
    },
  ]);
  try {
    const map = await buildMap(new NodeVaultFs(root), { now: T1 });
    const doc = map.docs[0];
    assert.ok(doc);
    assert.deepEqual(doc.sections, [
      { title: '9.4 稳压管稳压电路', pageStart: 1, pageEnd: 1 },
      { title: '第 3 章 数字电路', pageStart: 1, pageEnd: 1 },
      { title: '1. 实验步骤', pageStart: 1, pageEnd: 1 },
    ]);
  } finally {
    await cleanup(root);
  }
});

test('incremental rebuild equals a full rebuild and re-reads only changed documents', async () => {
  const root = await makeVault([
    {
      path: 'a/alpha.pdf',
      sha: SHA_A,
      pages: 2,
      chunks: [
        { page: 1, text: '第1章 起点\nALPHA42 模块。' },
        { page: 2, text: 'ALPHA42 继续。' },
      ],
    },
    {
      path: 'b/beta.pdf',
      sha: SHA_B1,
      pages: 2,
      chunks: [
        { page: 1, text: 'BETA7 芯片。\nBETA7 说明。' },
        { page: 2, text: 'BETA7 封装。' },
      ],
    },
    { path: 'c/gamma.pdf', sha: SHA_C, pages: 1, chunks: [{ page: 1, text: 'GAMMA9 附录。' }] },
  ]);
  try {
    const full = await buildMap(new NodeVaultFs(root), { now: T1 });
    assert.deepEqual(
      full.entities.map((entity) => entity.id),
      ['alpha42', 'beta7'],
    );

    await writeChunks(root, SHA_B2, [{ page: 1, text: 'BETA7 只出现一次。' }]);
    const sources: readonly MapSourceRef[] = [
      { path: 'a/alpha.pdf', sha: SHA_A, pages: 2 },
      { path: 'b/beta.pdf', sha: SHA_B2, pages: 1 },
    ];
    const previous = JSON.parse(serializeMap(full)) as MapFile;
    const counted = countingFs(root);
    const incremental = await buildMap(counted.fs, { sources, previous, now: T2 });
    const rebuild = await buildMap(new NodeVaultFs(root), { sources, now: T2 });

    assert.equal(serializeMap(incremental), serializeMap(rebuild));
    assert.deepEqual(
      incremental.docs.map((doc) => doc.path),
      ['a/alpha.pdf', 'b/beta.pdf'],
    );
    assert.deepEqual(
      incremental.entities.map((entity) => entity.id),
      ['alpha42'],
    );
    assert.deepEqual(counted.reads, ['.wiki/index/chunks/' + SHA_B2 + '.jsonl']);
  } finally {
    await cleanup(root);
  }
});

test('serialization is deterministic and ids are stable across runs', async () => {
  const root = await makeVault([
    {
      path: 'a/电源.pdf',
      sha: SHA_A,
      pages: 1,
      chunks: [{ page: 1, text: '第1章 电源\nLM7805 两次。\nLM7805 再来。' }],
    },
    {
      path: 'b/封装.pdf',
      sha: SHA_B1,
      pages: 1,
      chunks: [{ page: 1, text: 'TO220 封装。\nTO220 散热。' }],
    },
  ]);
  try {
    const first = serializeMap(await buildMap(new NodeVaultFs(root), { now: T1 }));
    const second = serializeMap(await buildMap(new NodeVaultFs(root), { now: T1 }));
    assert.equal(first, second);
    assert.ok(first.endsWith('\n'));

    const docsAt = first.indexOf('"docs"');
    const entitiesAt = first.indexOf('"entities"');
    const coverageAt = first.indexOf('"coverage"');
    assert.ok(first.indexOf('"schema"') >= 0 && first.indexOf('"schema"') < first.indexOf('"builtAt"'));
    assert.ok(first.indexOf('"builtAt"') < docsAt && docsAt < entitiesAt && entitiesAt < coverageAt);

    const parsed = JSON.parse(first) as MapFile;
    assert.deepEqual(
      parsed.docs.map((doc) => doc.path),
      ['a/电源.pdf', 'b/封装.pdf'],
    );
    assert.deepEqual(
      parsed.entities.map((entity) => entity.id),
      parsed.entities.map((entity) => entity.id).slice().sort(),
    );
    assert.deepEqual(parsed.docs[0] === undefined ? [] : Object.keys(parsed.docs[0]), [
      'path',
      'sha',
      'title',
      'pageCount',
      'firstLine',
      'sections',
      'forms',
    ]);
    for (const entity of parsed.entities) {
      for (const mention of entity.mentions) assert.equal(mention.unit, 'page');
    }
  } finally {
    await cleanup(root);
  }
});

test('one entity merges its spellings and mentions across two documents', async () => {
  const root = await makeVault([
    {
      path: 'a/电源.pdf',
      sha: SHA_A,
      pages: 1,
      chunks: [{ page: 1, text: 'LM7805 稳压器输出 5V。\nLM7805 需要散热。' }],
    },
    {
      path: 'b/封装.pdf',
      sha: SHA_B1,
      pages: 2,
      chunks: [
        { page: 1, text: 'LM7805 提供 1A。' },
        { page: 2, text: 'lm7805 的封装。' },
      ],
    },
  ]);
  try {
    const map = await buildMap(new NodeVaultFs(root), { now: T1 });
    const matches = findEntities(map, 'LM7805');
    assert.equal(matches.length, 1);
    const entity = matches[0];
    assert.ok(entity);
    assert.equal(entity.id, 'lm7805');
    assert.equal(entity.label, 'LM7805');
    assert.deepEqual(entity.aliases, ['lm7805']);
    assert.deepEqual(entity.mentions, [
      { path: 'a/电源.pdf', unit: 'page', locator: 1, count: 2 },
      { path: 'b/封装.pdf', unit: 'page', locator: 1, count: 1 },
      { path: 'b/封装.pdf', unit: 'page', locator: 2, count: 1 },
    ]);
  } finally {
    await cleanup(root);
  }
});

test('noisy lines do not all become entities', async () => {
  const root = await makeVault([
    {
      path: 'book-a.pdf',
      sha: SHA_A,
      pages: 1,
      chunks: [
        {
          page: 1,
          text: 'ABC123 只出现一次。\nXYZ42 也只出现一次。\nOP07 出现两次。\nOP07 再来一次。\n3.3 是电压。',
        },
      ],
    },
  ]);
  try {
    const map = await buildMap(new NodeVaultFs(root), { now: T1 });
    assert.deepEqual(
      map.entities.map((entity) => entity.id),
      ['op07'],
    );
    const entity = map.entities[0];
    assert.ok(entity);
    assert.equal(entity.label, 'OP07');
    assert.deepEqual(entity.mentions, [{ path: 'book-a.pdf', unit: 'page', locator: 1, count: 2 }]);
  } finally {
    await cleanup(root);
  }
});

test('a title token shared by two documents becomes an entity', async () => {
  const root = await makeVault([
    { path: '书/STM32 入门.pdf', sha: SHA_A, pages: 1, chunks: [{ page: 1, text: '第一章 起点\n正文。' }] },
    { path: '书/STM32 精通.pdf', sha: SHA_B1, pages: 1, chunks: [{ page: 1, text: '第一章 进阶\n正文。' }] },
  ]);
  try {
    const map = await buildMap(new NodeVaultFs(root), { now: T1 });
    assert.deepEqual(
      map.entities.map((entity) => entity.id),
      ['stm32'],
    );
    const entity = map.entities[0];
    assert.ok(entity);
    assert.equal(entity.label, 'STM32');
    assert.deepEqual(entity.mentions, [
      { path: '书/STM32 入门.pdf', unit: 'page', locator: 0, count: 1 },
      { path: '书/STM32 精通.pdf', unit: 'page', locator: 0, count: 1 },
    ]);
  } finally {
    await cleanup(root);
  }
});

test('a glossary pair admits a cross-script term and its alias', async () => {
  const root = await makeVault([
    {
      path: '书/放大器.pdf',
      sha: SHA_A,
      pages: 1,
      chunks: [{ page: 1, text: '运算放大器 输入阻抗高。\n运算放大器 增益大。' }],
    },
  ]);
  try {
    await writeGlossary(root, [{ a: '运算放大器', b: 'operational amplifier' }]);
    const map = await buildMap(new NodeVaultFs(root), { now: T1 });
    assert.equal(map.entities.length, 1);
    const entity = map.entities[0];
    assert.ok(entity);
    assert.equal(entity.id, '运算放大器');
    assert.equal(entity.label, '运算放大器');
    assert.deepEqual(entity.aliases, ['operational amplifier']);
    assert.equal(findEntities(map, 'operational amplifier').length, 1);
    assert.equal(findEntities(map, 'OPERATIONAL AMPLIFIER').length, 1);
  } finally {
    await cleanup(root);
  }
});

test('report API normalizes paths and finds entities exactly then case-insensitively', async () => {
  const root = await makeVault([
    {
      path: '书/联合测试.pdf',
      sha: SHA_A,
      pages: 1,
      chunks: [{ page: 1, text: '第1章 概述\nLM7805 两次。\nLM7805 再来。' }],
    },
  ]);
  try {
    const map = await buildMap(new NodeVaultFs(root), { now: T1 });
    assert.ok(docFor(map, '书\\联合测试.pdf'));
    assert.ok(docFor(map, './书/联合测试.pdf'));
    assert.equal(docFor(map, '书/不存在.pdf'), undefined);
    assert.equal(findEntities(map, 'lm7805').length, 1);
    assert.equal(findEntities(map, 'LM7805').length, 1);
    assert.equal(findEntities(map, 'missing').length, 0);
    const report = mapCoverage(map);
    assert.ok(report.includes('文档 1 篇'));
    assert.ok(report.includes('实体 1 个'));
  } finally {
    await cleanup(root);
  }
});

test('a missing catalog is a clear error, not an empty map', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-aikb-map-'));
  try {
    await assert.rejects(
      () => buildMap(new NodeVaultFs(root)),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'map.index-missing');
        return true;
      },
    );
  } finally {
    await cleanup(root);
  }
});
