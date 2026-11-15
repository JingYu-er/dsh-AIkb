import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileDraft, extractLinks, extractSources } from '../src/domain/compile.js';
import { compiledHashOf } from '../src/domain/compile.js';
import { parseDraft, serializeDraft } from '../src/domain/frontmatter.js';
import { runCompile } from '../src/application/kb-compile.js';
import type { CompileFs } from '../src/application/kb-compile.js';

const draft = [
  '',
  '# Node.js',
  '',
  '事件循环把回调排进队列。',
  '来源：books/node.pdf#12',
  '另见 [[事件循环]] 与 [[V8|引擎]]。',
  '',
  '',
  '',
  '结尾句。',
  '',
].join('\n');

test('frontmatter round-trips unknown keys and dash lists', () => {
  const parsed = parseDraft('---\ntitle: A\ntags:\n  - one\n  - two\ncustom: keep me\n---\nbody\n');
  assert.equal(parsed.body, 'body\n');
  const again = parseDraft(serializeDraft(parsed.frontmatter ?? [], parsed.body));
  assert.equal(again.frontmatter?.length, 3);
  assert.equal(again.frontmatter?.[1]?.[1] instanceof Array ? 'list' : 'scalar', 'list');
});

test('a draft without frontmatter gains title, type and sources', () => {
  const compiled = compileDraft({ relPath: 'node.md', text: draft, sourceHash: 'h1' });
  assert.equal(compiled.title, 'Node.js');
  assert.equal(compiled.noteType, 'thought');
  assert.equal(compiled.typeInferred, true);
  assert.deepEqual(compiled.sources, ['books/node.pdf#12']);
  assert.deepEqual(compiled.links, ['事件循环', 'V8']);
  assert.match(compiled.content, /^---\ntitle: Node\.js\ntype: thought\nsources:\n  - books\/node\.pdf#12\ncompiledHash: h1\n---\n/);
  assert.equal(compiled.content.match(/^# /gm)?.length, 1);
  assert.equal(compiled.content.endsWith('结尾句。\n'), true);
  assert.equal(compiled.content.includes('\n\n\n'), false);
  assert.equal(compiled.changes.includes('added frontmatter'), true);
});

test('existing type and title are preserved, extra keys kept', () => {
  const text = '---\ntitle: 手写标题\ntype: concept\ntags:\n  - js\n---\n# 另一个标题\n\n正文。\n';
  const compiled = compileDraft({ relPath: 'x.md', text, sourceHash: 'h2' });
  assert.equal(compiled.title, '手写标题');
  assert.equal(compiled.typeInferred, false);
  assert.match(compiled.content, /type: concept/);
  assert.match(compiled.content, /tags:\n  - js/);
  assert.equal(compiled.content.includes('# 另一个标题'), false);
});

test('sources and links are de-duplicated across forms', () => {
  const body = '来源: a.pdf#3 与 [附件](b.pdf#page=7) 和 [[a]] [[a]]';
  assert.deepEqual(extractSources(body), ['a.pdf#3', 'b.pdf#7']);
  assert.deepEqual(extractLinks(body), ['a']);
});

test('references survive spaces, parentheses and a trailing closing paren', () => {
  const body = [
    '正文。',
    '（来源：项目/砖块/7-模拟电子技术基础（第五版）高清版- 清华大学电子学教研组编、童诗白、华成英.pdf#page=473）',
    '另见 [课堂笔记](学习/硬件/模电/模拟电子技术基础(上交大郑益慧老师45集全)课堂笔记.pdf#page=88)。',
  ].join('\n');
  assert.deepEqual(extractSources(body), [
    '项目/砖块/7-模拟电子技术基础（第五版）高清版- 清华大学电子学教研组编、童诗白、华成英.pdf#473',
    '学习/硬件/模电/模拟电子技术基础(上交大郑益慧老师45集全)课堂笔记.pdf#88',
  ]);
});

test('a date-prefixed filename is not used as the title', () => {
  const compiled = compileDraft({ relPath: '2026-11-14 稳压管稳压电路的限流电阻.md', text: '正文。\n', sourceHash: 'h3' });
  assert.equal(compiled.title, '稳压管稳压电路的限流电阻');
  assert.equal(compiled.changes.includes('title from filename'), true);
});

test('an H1 that differs from the frontmatter title is reported', () => {
  const text = '---\ntitle: 带失真的静态工作点\n---\n# 静态工作点\n\n正文。\n';
  const compiled = compileDraft({ relPath: 'q.md', text, sourceHash: 'h4' });
  assert.equal(compiled.changes.includes('H1 replaced with frontmatter title'), true);
  assert.match(compiled.content, /^# 带失真的静态工作点$/m);
});

function fakeFs(seed: Record<string, string>): CompileFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async listDrafts() {
      return [...files.keys()];
    },
    async readText(relPath) {
      const value = files.get(relPath);
      if (value === undefined) throw new Error('missing ' + relPath);
      return value;
    },
    async writeText(relPath, content) {
      files.set(relPath, content);
    },
    async exists(relPath) {
      return files.has(relPath);
    },
  };
}

test('compile writes to inbox/_compiled and skips unchanged drafts', async () => {
  const fs = fakeFs({ 'node.md': draft });
  const first = await runCompile(fs, '/vault');
  assert.equal(first.totals.compiled, 1);
  assert.equal(first.notes[0]?.output, '_compiled/node.md');
  assert.equal(fs.files.has('_compiled/node.md'), true);
  assert.equal(compiledHashOf(fs.files.get('_compiled/node.md') ?? '') !== undefined, true);
  const second = await runCompile(fs, '/vault');
  assert.equal(second.totals.skipped, 1);
  assert.equal(second.totals.compiled, 0);
});

test('dryRun reports but writes nothing, inPlace overwrites the draft', async () => {
  const fs = fakeFs({ 'node.md': draft });
  const preview = await runCompile(fs, '/vault', { dryRun: true });
  assert.equal(preview.notes[0]?.written, false);
  assert.equal(fs.files.has('_compiled/node.md'), false);
  const inPlace = await runCompile(fs, '/vault', { inPlace: true });
  assert.equal(inPlace.notes[0]?.output, 'node.md');
  assert.match(fs.files.get('node.md') ?? '', /^---\ntitle: Node\.js/);
});

test('_compiled output is never treated as an input draft', async () => {
  const fs = fakeFs({ 'node.md': draft, '_compiled/node.md': 'x' });
  const report = await runCompile(fs, '/vault');
  assert.deepEqual(report.notes.map((note) => note.path), ['node.md']);
});
