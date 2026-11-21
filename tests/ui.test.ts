/** The page must parse and its handlers must bind; the server must serve, save and link. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const root = process.cwd();
const NL = String.fromCharCode(10);

test('the page script parses and every byId key it uses is registered', () => {
  const html = readFileSync(join(root, 'scripts/kb-ui.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'page must carry an inline script');
  const code = String((match as RegExpMatchArray)[1]);
  assert.doesNotThrow(() => new Script(code), 'the page script must be valid JS');
  const list = code.match(/\[((?:\s*"[^"]+"\s*,?)+)\]\.forEach/);
  assert.ok(list, 'the byId id list must exist');
  const registered = new Set([...String((list as RegExpMatchArray)[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...code.matchAll(/byId\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !registered.has(id));
  assert.deepEqual(missing, [], 'byId keys used without being registered: ' + missing.join(', '));
});

const vault = mkdtempSync(join(tmpdir(), 'dsh-aikb-ui-'));
mkdirSync(join(vault, 'sub'), { recursive: true });
mkdirSync(join(vault, 'inbox', '_compiled'), { recursive: true });
writeFileSync(join(vault, 'a.md'), '# A' + NL + '[[c.pdf]] and [[missing.md]]' + NL);
writeFileSync(join(vault, 'c.md'), '# C' + NL);
writeFileSync(join(vault, 'c.pdf'), 'pdf');
writeFileSync(join(vault, 'sub', 'b.md'), '# B' + NL);
writeFileSync(join(vault, 'inbox', 'd1.md'), '# draft' + NL);
writeFileSync(join(vault, 'inbox', '_compiled', 'c1.md'), '# compiled' + NL);

let server: Server | undefined;
let base = '';

test('server routes: notes, note, links, save and drafts', async () => {
  const mod = (await import(pathToFileURL(join(root, 'scripts/kb-ui.mjs')).href)) as unknown as {
    startUiServer: (options: Record<string, unknown>) => Promise<Server>;
  };
  server = await mod.startUiServer({ port: 0, vault, promoteDir: 'notes' });
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const get = async (p: string): Promise<any> => (await fetch(base + p)).json();

  const notes: any = await get('/api/notes');
  assert.equal(notes.ok, true);
  for (const expected of ['a.md', 'c.md', 'sub/b.md']) assert.ok(notes.notes.includes(expected), 'missing note ' + expected);
  assert.ok(!notes.notes.includes('c.pdf'), 'attachments must not appear as notes');

  const note: any = await get('/api/note?path=a.md');
  assert.equal(note.ok, true);
  assert.match(note.text, /\[\[c\.pdf\]\]/);
  assert.equal(typeof note.mtime, 'number');

  const links: any = await get('/api/links?path=a.md');
  assert.equal(links.ok, true);
  const pdf = links.out.find((l: any) => l.raw === 'c.pdf');
  assert.deepEqual({ path: pdf.path, kind: pdf.kind }, { path: 'c.md', kind: 'note' });
  assert.deepEqual(links.broken, ['missing.md']);

  const stale: any = await (await fetch(base + '/api/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'a.md', text: 'x', mtime: 1 }),
  })).json();
  assert.equal(stale.code, 'conflict');
  assert.match(stale.text, /\[\[c\.pdf\]\]/, 'a conflict must return the current text');

  const saved: any = await (await fetch(base + '/api/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'a.md', text: 'rewritten', mtime: note.mtime }),
  })).json();
  assert.equal(saved.ok, true);
  assert.equal(readFileSync(join(vault, 'a.md'), 'utf8'), 'rewritten');
  assert.ok(existsSync(saved.backup), 'a save must keep a backup copy');

  const drafts: any = await get('/api/drafts');
  assert.equal(drafts.ok, true);
  assert.deepEqual(drafts.drafts, ['d1.md']);
  assert.deepEqual(drafts.compiled, ['inbox/_compiled/c1.md']);
});

after(() => {
  if (server !== undefined) server.close();
});
