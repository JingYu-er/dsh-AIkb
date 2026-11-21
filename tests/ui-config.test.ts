import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const root = process.cwd();
const NL = String.fromCharCode(10);
const work = mkdtempSync(join(tmpdir(), 'dsh-aikb-config-ui-'));
const vaultA = join(work, 'vault-a');
const vaultB = join(work, 'vault-b');
mkdirSync(vaultA, { recursive: true });
mkdirSync(vaultB, { recursive: true });
writeFileSync(join(vaultA, 'only-a.md'), '# A' + NL);
writeFileSync(join(vaultB, 'only-b.md'), '# B' + NL);
const configPath = join(work, 'config.json');
process.env.KB_CONFIG = configPath;
delete process.env.KB_VAULT;

let server: Server | undefined;
let base = '';
const get = async (path: string): Promise<any> => (await fetch(base + path)).json();
const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

test('config API: read, save with revision, then switch the active vault', async () => {
  process.env.KB_CONFIG = configPath;
  delete process.env.KB_VAULT;
  const mod = (await import(pathToFileURL(join(root, 'scripts/kb-ui.mjs')).href)) as unknown as {
    startUiServer: (options: Record<string, unknown>) => Promise<Server>;
  };
  server = await mod.startUiServer({ port: 0, vault: vaultA });
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;

  const first = await get('/api/config');
  assert.equal(first.ok, true);
  assert.equal(first.configPath, configPath);
  assert.deepEqual(first.vaults, []);
  assert.ok(first.missing.includes('vaults'), 'an empty config must ask for a vault first');
  assert.equal(first.allowWrites, undefined);
  assert.equal(first.config.allowWrites, false);

  const before = await get('/api/notes');
  assert.ok(before.notes.includes('only-a.md'), 'the pinned vault serves notes before any config exists');

  const saved = await post('/api/config', {
    vaults: [{ id: 'a', name: 'A', dir: vaultA }, { id: 'b', name: 'B', dir: vaultB }],
    activeVault: 'a',
    packDir: join(work, 'packs'),
    toolchainDir: join(work, 'toolchain'),
    allowWrites: false,
    expectRevision: first.revision,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.config.vaults.length, 2);
  assert.equal(saved.body.config.vaults[0].dir, vaultA);

  const afterSave = await get('/api/config');
  assert.equal(afterSave.vaults.find((v: any) => v.id === 'a').active, true);
  assert.equal(afterSave.vaults.find((v: any) => v.id === 'a').exists, true);
  assert.deepEqual(afterSave.missing, []);
  assert.equal(afterSave.toolchain.root, join(work, 'toolchain'));
  assert.equal(afterSave.configComplete, true);

  const notesA = await get('/api/notes');
  assert.ok(notesA.notes.includes('only-a.md'));

  const switched = await post('/api/vault/active', { id: 'b' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.activeVault, 'b');
  const notesB = await get('/api/notes');
  assert.ok(notesB.notes.includes('only-b.md'), 'switching the active vault must reroute the notes API');
  assert.ok(!notesB.notes.includes('only-a.md'));

  const vaults = await get('/api/vaults');
  assert.equal(vaults.ok, true);
  assert.equal(vaults.activeVault, 'b');
  assert.equal(vaults.vaults.find((v: any) => v.id === 'b').exists, true);

  const byAddress = await get('/api/notes?address=a');
  assert.ok(byAddress.notes.includes('only-a.md'), 'an explicit vault id still wins per request');
});

test('config API refuses stale revisions, relative paths and unknown vaults', async () => {
  process.env.KB_CONFIG = configPath;
  const stale = await post('/api/config', { packDir: join(work, 'packs2'), expectRevision: '0000000000000000' });
  assert.equal(stale.status, 409);
  assert.ok(String(stale.body.error).startsWith('kb.config.stale: '));

  const relative = await post('/api/config', { packDir: 'relative/packs' });
  assert.equal(relative.status, 400);
  assert.equal(relative.body.problems[0].field, 'path');
  assert.ok(String(relative.body.problems[0].message).startsWith('kb.config.relative: '));

  const unknown = await post('/api/vault/active', { id: 'nope' });
  assert.equal(unknown.status, 400);
  assert.match(String(unknown.body.error), /kb\.config\.unknown-vault/);

  const stillB = await get('/api/vaults');
  assert.equal(stillB.activeVault, 'b', 'a rejected write must not change the active vault');
});

test('schema API: template first, read-only refusal, then a save once writes are on', async () => {
  const sheetPath = join(vaultB, '.dsh-aikb', 'schema.md');
  const absent = await get('/api/schema?address=b');
  assert.equal(absent.ok, true);
  assert.equal(absent.exists, false);
  assert.equal(absent.allowWrites, false);
  assert.ok(String(absent.template).includes('## 页面规范'), 'a missing sheet must offer the template');

  const refused = await post('/api/schema', { address: 'b', text: '# 页面规范' + NL });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.error.code, 'kb.schema.read-only');
  assert.equal(existsSync(sheetPath), false, 'a read-only refusal must not create the file');

  const current = await get('/api/config');
  const enabled = await post('/api/config', { allowWrites: true, expectRevision: current.revision });
  assert.equal(enabled.status, 200);

  const text = '# 页面规范' + NL + NL + '- 概念页一段只讲一件事' + NL;
  const written = await post('/api/schema', { address: 'b', text });
  assert.equal(written.status, 200);
  assert.equal(written.body.ok, true);
  assert.equal(written.body.bytes, Buffer.byteLength(text, 'utf8'));

  const read = await get('/api/schema?address=b');
  assert.equal(read.exists, true);
  assert.equal(read.text, text);
  assert.equal(read.allowWrites, true);

  const empty = await post('/api/schema', { address: 'b', text: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'kb.schema.empty');
});

test('vault init creates a skeleton, registers it and honours the write switch', async () => {
  const dir = join(work, 'fresh-vault');
  const created = await post('/api/vault/init', { dir, template: 'books' });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.ok(created.body.vault.created.includes('.dsh-aikb/schema.md'));
  assert.equal(existsSync(join(dir, '.obsidian', 'app.json')), true);
  assert.equal(existsSync(join(dir, 'books')), true);
  assert.equal(created.body.registered.active, true);

  const vaults = await get('/api/vaults');
  assert.equal(vaults.vaults.length, 3, 'the init must append, not replace');
  assert.equal(vaults.activeVault, created.body.registered.id);
  const notes = await get('/api/notes');
  assert.ok(notes.notes.includes('index.md'), 'the new vault is what the notes API now reads');

  const current = await get('/api/config');
  const off = await post('/api/config', { allowWrites: false, expectRevision: current.revision });
  assert.equal(off.status, 200);
  const refused = await post('/api/vault/init', { dir: join(work, 'blocked-vault') });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'kb.init.read-only');
  assert.equal(existsSync(join(work, 'blocked-vault')), false);
});

test('job queue API: enqueue, list, cancel, prune', async () => {
  process.env.KB_CONFIG = configPath;
  const current = await get('/api/config');
  if (current.config.allowWrites !== true) {
    const on = await post('/api/config', { allowWrites: true, expectRevision: current.revision });
    assert.equal(on.status, 200);
  }
  const enqueued = await post('/api/jobs/enqueue', { kind: 'judge', vault: vaultB, label: 'demo judge', payload: { path: 'only-b.md' } });
  assert.equal(enqueued.status, 200);
  assert.equal(enqueued.body.job.status, 'pending');
  assert.ok(enqueued.body.path.startsWith(join(work, 'toolchain')), 'the queue lives under the configured toolchain dir');

  const listed = await get('/api/jobs');
  assert.equal(listed.summary.pending, 1);
  const id = listed.jobs[0].id;

  const cancelled = await post('/api/jobs/cancel', { id });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.status, 'cancelled');

  const missing = await post('/api/jobs/cancel', { id: 'nope' });
  assert.equal(missing.status, 404);

  const pruned = await post('/api/jobs/prune', { keepDone: 0 });
  assert.equal(pruned.body.removed, 1);
  const empty = await get('/api/jobs');
  assert.equal(empty.jobs.length, 0);
});

test('history API: a save snapshots the old text and restore puts it back', async () => {
  process.env.KB_CONFIG = configPath;
  const note = 'history-demo.md';
  const first = await post('/api/save?address=b', { path: note, text: 'one' + "\n" });
  assert.equal(first.status, 200);
  const second = await post('/api/save?address=b', { path: note, text: 'two' + "\n" });
  assert.equal(second.status, 200);

  const listed = await get('/api/history?address=b&path=' + note);
  assert.equal(listed.ok, true);
  assert.equal(listed.entries.length, 1, 'only overwritten text is kept');

  const stamp = listed.entries[0].stamp as string;
  const entry = await get('/api/history/entry?address=b&path=' + note + '&stamp=' + encodeURIComponent(stamp));
  assert.equal(entry.ok, true);
  assert.equal(entry.text, 'one' + "\n");

  const restored = await post('/api/history/restore?address=b', { path: note, stamp });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.text, 'one' + "\n");
  const afterRestore = await get('/api/history?address=b&path=' + note);
  assert.equal(afterRestore.entries.length, 2, 'a restore first captures what it overwrites');
});

after(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  delete process.env.KB_CONFIG;
  rmSync(work, { recursive: true, force: true });
});
