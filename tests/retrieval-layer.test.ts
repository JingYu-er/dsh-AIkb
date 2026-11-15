import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearQueryCache, runQuery } from '../src/application/kb-query.js';
import type { QueryFs } from '../src/application/kb-query.js';
import { chunkFileOf, INDEX_CATALOG_PATH } from '../src/application/kb-ingest.js';
import { mergeGlossary, parseGlossary, serializeGlossary } from '../src/application/glossary-store.js';
import { assignFamilies, hamming64, simhash64, titleKeyOf } from '../src/domain/family.js';
import { harvestTermPairs } from '../src/domain/glossary-harvest.js';
import { chunkQuality } from '../src/domain/quality.js';

const BASE =
  '共射放大电路的静态工作点由基极偏置电阻决定，集电极电流会随温度升高而增大，需要负反馈来稳定。' +
  '设计时先确定电源电压与集电极电阻，再按输出摆幅选取工作点，最后核对非线性失真与增益。';

interface FakeChunk {
  readonly id: string;
  readonly page: number;
  readonly text: string;
  readonly section?: string;
}

interface FakeSource {
  readonly sha256: string;
  readonly path: string;
  readonly pages: number;
  readonly chunks: readonly FakeChunk[];
}

function fakeVault(root: string, sources: readonly FakeSource[]): QueryFs {
  const files = new Map<string, string>();
  const catalog = { schema: 'dsh-kb/index@1', sources: {} as Record<string, unknown> };
  for (const source of sources) {
    catalog.sources[source.sha256] = { path: source.path, pages: source.pages, chunks: source.chunks.length };
    const lines = source.chunks.map((chunk) =>
      JSON.stringify({ sourceId: source.sha256, tokens: 1, section: '', ...chunk }),
    );
    files.set(chunkFileOf(source.sha256), lines.join('\n') + '\n');
  }
  files.set(INDEX_CATALOG_PATH, JSON.stringify(catalog));
  return {
    root,
    async exists(relPath) {
      return files.has(relPath);
    },
    async readText(relPath) {
      const value = files.get(relPath);
      if (value === undefined) throw new Error('missing ' + relPath);
      return value;
    },
  };
}

test('title keys drop edition markers but keep the author', () => {
  assert.equal(
    titleKeyOf('学习/砖块/项目/7-模拟电子技术基础（第五版）.pdf'),
    titleKeyOf('学习/砖块/项目/14-模拟电子技术基础（第6版）.pdf'),
  );
  assert.notEqual(titleKeyOf('书/电路（邱关源）.pdf'), titleKeyOf('书/电路（童诗白）.pdf'));
});

test('editions of one work share a family, unrelated books do not', () => {
  const assignment = assignFamilies([
    { sha256: 'a'.repeat(64), path: '书/模拟电子技术基础（第五版）.pdf', pages: 549, sample: BASE },
    { sha256: 'b'.repeat(64), path: '书/模拟电子技术基础（第6版）.pdf', pages: 598, sample: BASE },
    {
      sha256: 'c'.repeat(64),
      path: '书/高速数字设计.pdf',
      pages: 300,
      sample: '时域反射与传输线阻抗匹配决定了高速链路的眼图质量，端接电阻用于抑制反射，差分对布线要求等长。',
    },
  ]);
  assert.equal(assignment.families, 2);
  assert.equal(assignment.bySha.get('a'.repeat(64)), assignment.bySha.get('b'.repeat(64)));
  assert.notEqual(assignment.bySha.get('a'.repeat(64)), assignment.bySha.get('c'.repeat(64)));
});

test('identical content under a different name is still one family', () => {
  const assignment = assignFamilies([
    { sha256: 'a'.repeat(64), path: '书/模拟电子技术基础.pdf', pages: 500, sample: BASE },
    { sha256: 'b'.repeat(64), path: '书/Analog Electronics Fundamentals.pdf', pages: 500, sample: BASE },
  ]);
  assert.equal(assignment.families, 1);
  assert.equal(hamming64(simhash64(BASE), simhash64(BASE)), 0);
  assert.equal(hamming64('', simhash64(BASE)), 64);
});

test('pages made of headers and numbers score low, prose scores around one', () => {
  const headerPage = ['RM0008', 'www.st.com', 'https://example.com', 'ABCD12', 'Rev. 4', '123', 'RM0008', 'www.ti.com'].join('\n');
  assert.ok(chunkQuality(headerPage) < 0.5, 'header page: ' + chunkQuality(headerPage));
  assert.ok(chunkQuality(BASE) >= 1, 'prose: ' + chunkQuality(BASE));
  assert.ok(chunkQuality('例 3-2 ' + BASE) > 1, 'worked example should get a bonus');
});

test('bilingual and acronym pairs are harvested, figure references are not', () => {
  const zhEn = harvestTermPairs('当温度升高时，静态工作点 (quiescent operating point) 会移动。');
  assert.ok(
    zhEn.some((term) => term.a === '静态工作点' && term.b === 'quiescent operating point' && term.kind === 'zh-en'),
    JSON.stringify(zhEn),
  );
  const abbrev = harvestTermPairs('Advanced RISC Machine (ARM) 是一种处理器架构。');
  assert.ok(
    abbrev.some((term) => term.a === 'ARM' && term.b === 'Advanced RISC Machine' && term.kind === 'abbrev'),
    JSON.stringify(abbrev),
  );
  assert.deepEqual(harvestTermPairs('Figure (图) 1 shows the curve.'), []);
});

test('glossary merge keeps single mentions and counts repeats', () => {
  const first = mergeGlossary(undefined, [{ a: '静态工作点', b: 'quiescent operating point', kind: 'zh-en' }], 'sha-a');
  assert.equal(first.added, 1);
  assert.equal(first.file.entries.length, 1);
  const second = mergeGlossary(first.file, [{ a: '静态工作点', b: 'Quiescent Operating Point', kind: 'zh-en' }], 'sha-b');
  assert.equal(second.file.entries.length, 1);
  assert.equal(second.file.entries[0]?.hits, 2);
  assert.equal(parseGlossary(serializeGlossary(second.file)).entries.length, 1);
});

test('one work family cannot fill the result list', async () => {
  clearQueryCache();
  const fs = fakeVault('/vault-family', [
    {
      sha256: 'a'.repeat(64),
      path: '书/模拟电子技术基础（第五版）.pdf',
      pages: 500,
      chunks: [
        { id: 'a:1:0', page: 1, text: BASE },
        { id: 'a:2:0', page: 2, text: BASE },
      ],
    },
    {
      sha256: 'b'.repeat(64),
      path: '书/模拟电子技术基础（第6版）.pdf',
      pages: 520,
      chunks: [
        { id: 'b:1:0', page: 1, text: BASE },
        { id: 'b:2:0', page: 2, text: BASE },
      ],
    },
    {
      sha256: 'd'.repeat(64),
      path: '书/高速数字设计.pdf',
      pages: 300,
      chunks: [
        {
          id: 'd:1:0',
          page: 1,
          text: '时域反射与传输线阻抗匹配决定高速链路眼图，端接电阻抑制反射，差分对要求等长布线，共射放大电路不是主题。',
        },
      ],
    },
  ]);
  const capped = await runQuery(fs, '共射放大电路 静态工作点', 3, { familyCap: 1 });
  const editions = capped.hits.filter((hit) => hit.path.includes('模拟电子技术基础'));
  assert.equal(editions.length, 1, JSON.stringify(capped.hits));
  const spread = await runQuery(fs, '共射放大电路 静态工作点', 3);
  assert.ok(spread.hits.some((hit) => hit.path.includes('模拟电子技术基础')), JSON.stringify(spread.hits));
});

test('a hit reports the end of its chapter and can expand to the whole section', async () => {
  clearQueryCache();
  const fs = fakeVault('/vault-chapter', [
    {
      sha256: 'e'.repeat(64),
      path: '书/模拟电子技术基础.pdf',
      pages: 20,
      chunks: [
        { id: 'e:5:0', page: 5, section: '2.3 共射放大电路', text: '共射放大电路的静态工作点与增益计算。' },
        { id: 'e:6:0', page: 6, section: '2.3 共射放大电路', text: '续页六：温度对静态工作点的影响与负反馈稳定。' },
        { id: 'e:7:0', page: 7, section: '2.3 共射放大电路', text: '续页七：失真波形与最大输出摆幅的测量。' },
        { id: 'e:9:0', page: 9, section: '2.4 分压式偏置', text: '分压式偏置电路用两个电阻固定基极电位。' },
      ],
    },
  ]);
  const report = await runQuery(fs, '共射放大电路 增益计算', 1);
  const hit = report.hits[0];
  assert.equal(hit?.page, 5);
  assert.equal(hit?.pageEnd, 7);
  assert.equal(hit?.section, '2.3 共射放大电路');
  assert.equal(hit?.context, undefined);
  const expanded = await runQuery(fs, '共射放大电路 增益计算', 1, { expand: 'section', maxContextChars: 500 });
  assert.ok(expanded.hits[0]?.context?.includes('续页六'), expanded.hits[0]?.context);
  assert.ok(expanded.hits[0]?.context?.includes('续页七'), expanded.hits[0]?.context);
  assert.ok(!expanded.hits[0]?.context?.includes('分压式偏置电路用两个电阻'), 'section must stop before 2.4');
});

test('the vault glossary bridges languages during search', async () => {
  clearQueryCache();
  const fs = fakeVault('/vault-glossary', [
    {
      sha256: 'f'.repeat(64),
      path: '书/Transistor Circuits.pdf',
      pages: 10,
      chunks: [{ id: 'f:3:0', page: 3, text: 'Chopper stabilisation removes offset drift at the cost of a small ripple.' }],
    },
  ]);
  // The seed vocabulary already knows 偏置 (→ bias), so pick a pair only this vault learned.
  const without = await runQuery(fs, '斩波稳零', 3);
  assert.equal(without.hits.length, 0, JSON.stringify(without.hits));
  const withGlossary = await runQuery(fs, '斩波稳零', 3, {
    glossary: [{ a: '斩波稳零', b: 'chopper stabilisation' }],
  });
  assert.equal(withGlossary.hits[0]?.path, '书/Transistor Circuits.pdf');
});

test('the index is cached per vault until the catalog changes', async () => {
  clearQueryCache();
  const first = await runQuery(fakeVault('/vault-cache', [
    { sha256: 'g'.repeat(64), path: '书/甲.pdf', pages: 5, chunks: [{ id: 'g:1:0', page: 1, text: '共射放大电路的静态工作点' }] },
  ]), '静态工作点', 3);
  assert.equal(first.searched.sources, 1);
  const second = await runQuery(fakeVault('/vault-cache', [
    { sha256: 'g'.repeat(64), path: '书/甲.pdf', pages: 5, chunks: [{ id: 'g:1:0', page: 1, text: '共射放大电路的静态工作点' }] },
    { sha256: 'h'.repeat(64), path: '书/乙.pdf', pages: 5, chunks: [{ id: 'h:1:0', page: 1, text: '静态工作点由偏置网络决定' }] },
  ]), '静态工作点', 3);
  assert.equal(second.searched.sources, 2);
});
