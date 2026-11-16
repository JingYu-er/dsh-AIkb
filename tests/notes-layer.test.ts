import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearNotesCache, searchNotes } from '../src/application/notes-layer.js';

function vault(files: Record<string, string>) {
  return {
    root: '/vault-' + Object.keys(files).length + '-' + Object.keys(files).join('|'),
    exists: async () => true,
    readText: async (relPath: string) => files[relPath] ?? '',
    listFiles: async () => Object.keys(files).map((relPath) => ({ relPath, bytes: 0, modifiedAt: '2026-11-16T00:00:00.000Z' })),
  };
}

test('a note is found by a heading-scoped BM25 match', async () => {
  clearNotesCache();
  const fs = vault({
    '学习/电容.md': '---\ntitle: 电容\n---\n\n## 介质\n\nNPO 温度稳定，X7R 次之，Z5U 和 Y5V 容量随温度变化大。\n',
    '随记/别的.md': '今天吃了面，天气不错。\n',
  });
  const hits = await searchNotes(fs, 'NPO X7R 温度 特性', 5);
  assert.equal(hits[0]?.path, '学习/电容.md');
  assert.equal(hits[0]?.section, '介质');
  assert.ok((hits[0]?.score ?? 0) > 0);
});

test('one note contributes at most one hit', async () => {
  clearNotesCache();
  const fs = vault({
    'a.md': '# 甲\n\n滤波器 电容 电阻\n\n# 乙\n\n滤波器 电容 电阻 再来一遍\n',
    'b.md': '# 丙\n\n滤波器\n',
  });
  const hits = await searchNotes(fs, '滤波器 电容 电阻', 5);
  assert.deepEqual(hits.map((hit) => hit.path), ['a.md', 'b.md']);
});

test('drafts, templates and dot directories are not notes', async () => {
  clearNotesCache();
  const fs = vault({
    'inbox/draft.md': '# 草稿\n\n滤波器 电容\n',
    'templates/t.md': '# 模板\n\n滤波器 电容\n',
    '.trash/old.md': '# 旧\n\n滤波器 电容\n',
    'node_modules/pkg/readme.md': '# 包\n\n滤波器 电容\n',
    'real.md': '# 真\n\n滤波器 电容\n',
  });
  const hits = await searchNotes(fs, '滤波器 电容', 10);
  assert.deepEqual(hits.map((hit) => hit.path), ['real.md']);
});

test('limit bounds the number of notes', async () => {
  clearNotesCache();
  const fs = vault({
    'a.md': '# 甲\n\n滤波器\n',
    'b.md': '# 乙\n\n滤波器\n',
    'c.md': '# 丙\n\n滤波器\n',
  });
  const hits = await searchNotes(fs, '滤波器', 2);
  assert.equal(hits.length, 2);
});
