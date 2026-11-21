import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as nodePath from 'node:path';
import { loadConfig, resolveVaultPath } from '../src/application/config-store.js';
import type { KbConfig } from '../src/application/config-store.js';
import { SETTINGS_ROUTE_PREFIX, handleSettingsApi } from '../src/application/settings-api.js';
import type { SettingsApiDeps, SettingsApiResult } from '../src/application/settings-api.js';

/**
 * The routes are exercised directly, without an HTTP server: the host adapter only
 * collects the body and serialises the result, so testing handleSettingsApi covers
 * every decision the page can observe.
 */
const tempRoot = nodePath.resolve(process.cwd(), '..', 'temp');
mkdirSync(tempRoot, { recursive: true });
const work = mkdtempSync(nodePath.join(tempRoot, 'dsh-aikb-settings-'));
const vaultA = nodePath.join(work, 'vault-a');
const vaultB = nodePath.join(work, 'vault-b');
const jobsDir = nodePath.join(work, 'jobs');
mkdirSync(vaultA, { recursive: true });
const configPath = nodePath.join(work, 'config.json');
/**
 * The whole suite shares one process (--test-isolation=none), so the env is pinned in a
 * hook: another file's after() hook can restore KB_CONFIG after this module loads.
 */
const previousConfigEnv = process.env.KB_CONFIG;
before(() => {
  process.env.KB_CONFIG = configPath;
  delete process.env.KB_VAULT;
});

let writes = false;
const configNow = (): KbConfig => loadConfig(deps.overrides()).config;
const deps: SettingsApiDeps = {
  overrides: () => ({}),
  allowWrites: () => writes,
  // Mirrors src/index.ts: an address is either a vault id or a directory.
  vaultFor: (address) => resolveVaultPath(configNow(), address),
  jobsDir: () => jobsDir,
};

interface ApiResponse {
  status: number;
  body: any;
}

const api = async (method: string, pathname: string, body?: unknown, search = ''): Promise<ApiResponse> => {
  const result: SettingsApiResult = await handleSettingsApi(
    { method, pathname, search, body: body === undefined ? '' : JSON.stringify(body) },
    deps,
  );
  return { status: result.status, body: result.body };
};

/** Empty config plus two registered vaults; vault B is only configured, not on disk. */
const seed = async (patch: Record<string, unknown> = {}): Promise<void> => {
  rmSync(configPath, { force: true });
  writes = false;
  const current = await api('GET', '/config');
  const saved = await api('POST', '/config', {
    patch: {
      vaults: [{ id: 'a', name: 'A', dir: vaultA }, { id: 'b', name: 'B', dir: vaultB }],
      activeVault: 'a',
      packDir: nodePath.join(work, 'packs'),
      toolchainDir: nodePath.join(work, 'toolchain'),
      ...patch,
    },
    expectRevision: current.body.revision,
  });
  assert.equal(saved.status, 200, 'seed must save: ' + JSON.stringify(saved.body));
};

after(() => {
  rmSync(work, { recursive: true, force: true });
  if (previousConfigEnv === undefined) delete process.env.KB_CONFIG;
  else process.env.KB_CONFIG = previousConfigEnv;
});

test('GET config returns the settings payload with per-vault disk state', async () => {
  rmSync(configPath, { force: true });
  writes = false;
  const empty = await api('GET', '/config');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.ok, true);
  assert.equal(empty.body.configPath, configPath);
  assert.equal(typeof empty.body.revision, 'string');
  assert.equal(empty.body.config.version, 2);
  assert.deepEqual(empty.body.config.vaults, []);
  assert.equal(empty.body.activeVault, '');
  assert.equal(empty.body.readiness.ok, false);
  assert.ok(empty.body.readiness.missing.includes('vaults'), 'a fresh install must ask for a vault');
  assert.deepEqual(empty.body.missing, empty.body.readiness.missing);
  assert.deepEqual(empty.body.warnings, []);
  assert.ok(Array.isArray(empty.body.sources));
  assert.deepEqual(Object.keys(empty.body.toolchain).sort(), ['embed', 'logs', 'models', 'ocr', 'rerank', 'root', 'venv']);

  await seed();
  const seeded = await api('GET', '/config');
  assert.equal(seeded.body.vaults.length, 2);
  const a = seeded.body.vaults.find((v: any) => v.id === 'a');
  const b = seeded.body.vaults.find((v: any) => v.id === 'b');
  assert.equal(a.active, true);
  assert.equal(a.dir, vaultA);
  assert.equal(a.exists, true);
  assert.equal(b.active, false);
  assert.equal(b.exists, false, 'a configured vault whose directory is gone must report exists:false');
});

test('POST config saves the whitelist and refuses a stale revision', async () => {
  rmSync(configPath, { force: true });
  writes = false;
  const before = await api('GET', '/config');
  const saved = await api('POST', '/config', {
    patch: {
      vaults: [{ id: 'a', name: 'A', dir: vaultA }, { id: 'b', name: 'B', dir: vaultB }],
      activeVault: 'b',
      packDir: nodePath.join(work, 'packs'),
      toolchainDir: nodePath.join(work, 'toolchain'),
      ocrWorkers: 2,
      unknownKey: 'ignored',
    },
    expectRevision: before.body.revision,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.activeVault, 'b');
  assert.equal(saved.body.config.ocrWorkers, 2);
  assert.equal(saved.body.config.unknownKey, undefined);
  assert.notEqual(saved.body.revision, before.body.revision);

  const stale = await api('POST', '/config', { patch: { allowWrites: true }, expectRevision: '0000000000000000' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'kb.config.stale');
  assert.ok(String(stale.body.error.message).startsWith('kb.config.stale: '));
  const unchanged = await api('GET', '/config');
  assert.equal(unchanged.body.config.allowWrites, false, 'a rejected write must not change the file');
});

test('POST config rejects relative paths and malformed JSON', async () => {
  await seed();
  const relative = await api('POST', '/config', { patch: { packDir: 'relative/packs' } });
  assert.equal(relative.status, 400);
  assert.equal(relative.body.ok, false);
  assert.equal(relative.body.error.code, 'kb.config.invalid');
  assert.equal(relative.body.error.message, 'the settings did not validate');
  assert.equal(relative.body.problems[0].field, 'path');

  const broken = await handleSettingsApi({ method: 'POST', pathname: '/config', search: '', body: '{not json' }, deps);
  assert.equal(broken.status, 400);
  assert.equal((broken.body as any).error.code, 'kb.api.bad-json');
});

test('schema routes read the sheet, refuse read-only writes, then save', async () => {
  await seed();
  const sheetPath = nodePath.join(vaultA, '.dsh-aikb', 'schema.md');
  const absent = await api('GET', '/schema', undefined, '?address=a');
  assert.equal(absent.status, 200);
  assert.equal(absent.body.ok, true);
  assert.equal(absent.body.path, sheetPath);
  assert.equal(absent.body.exists, false);
  assert.equal(absent.body.bytes, 0);
  assert.equal(absent.body.text, '');
  assert.equal(absent.body.allowWrites, false);
  assert.ok(String(absent.body.template).includes('vault-a'), 'the template is named after the vault');

  const refused = await api('POST', '/schema', { text: '# Sheet', address: 'a' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'kb.schema.read-only');

  writes = true;
  const saved = await api('POST', '/schema', { text: '# Sheet' + String.fromCharCode(10), address: 'a' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.path, sheetPath);
  assert.equal(readFileSync(sheetPath, 'utf8'), '# Sheet' + String.fromCharCode(10));

  const read = await api('GET', '/schema', undefined, '?address=a');
  assert.equal(read.body.exists, true);
  assert.equal(read.body.text, '# Sheet' + String.fromCharCode(10));
  assert.equal(read.body.allowWrites, true);
});

test('vault/init is gated on allowWrites and registers the new vault', async () => {
  await seed();
  const dir = nodePath.join(work, 'fresh');
  const refused = await api('POST', '/vault/init', { dir, name: 'Fresh' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'kb.init.read-only');

  writes = true;
  const created = await api('POST', '/vault/init', { dir, name: 'Fresh', template: 'blank', activate: true });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.ok, true);
  assert.equal(created.body.vault.dir, dir);
  assert.equal(created.body.vault.name, 'Fresh');
  assert.equal(created.body.registered.name, 'Fresh');
  assert.equal(created.body.registered.active, true);
  assert.equal(created.body.registered.alreadyRegistered, false);
  assert.equal(typeof created.body.revision, 'string');
  assert.equal(existsSync(nodePath.join(dir, '.obsidian')), true);

  const listed = await api('GET', '/vaults');
  assert.equal(listed.body.activeVault, created.body.registered.id);
  assert.ok(listed.body.vaults.some((v: any) => v.id === created.body.registered.id && v.active === true && v.exists === true));

  const again = await api('POST', '/vault/init', { dir, name: 'Fresh' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'kb.init.not-empty');
});

test('vault/active switches the active vault and validates the id', async () => {
  await seed();
  const unknown = await api('POST', '/vault/active', { id: 'nope' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'kb.config.unknown-vault');

  const switched = await api('POST', '/vault/active', { id: 'b' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.ok, true);
  assert.equal(switched.body.activeVault, 'b');
  assert.equal(typeof switched.body.revision, 'string');

  const listed = await api('GET', '/vaults');
  assert.equal(listed.body.activeVault, 'b');
  assert.equal(listed.body.vaults.find((v: any) => v.id === 'b').active, true);

  const stale = await api('POST', '/vault/active', { id: 'a', expectRevision: '0000000000000000' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'kb.config.stale');
  assert.equal((await api('GET', '/vaults')).body.activeVault, 'b');
});

test('feedback routes append, list and mark rows done', async () => {
  await seed();
  const empty = await api('GET', '/feedback', undefined, '?address=a');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.ok, true);
  assert.equal(empty.body.path, nodePath.join(vaultA, 'inbox/feedback.md'));
  assert.deepEqual(empty.body.rows, []);
  assert.equal(empty.body.allowWrites, false);

  const refused = await api('POST', '/feedback', { path: 'notes/a.md', text: 'this is wrong', address: 'a' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'kb.feedback.read-only');

  writes = true;
  const appended = await api('POST', '/feedback', { path: 'notes/a.md', text: 'this is wrong', address: 'a' });
  assert.equal(appended.status, 200, JSON.stringify(appended.body));
  assert.equal(appended.body.ok, true);
  assert.equal(appended.body.index, 0);
  assert.equal(appended.body.rows.length, 1);
  assert.equal(appended.body.rows[0].note, 'notes/a.md');
  assert.equal(appended.body.rows[0].text, 'this is wrong');
  assert.equal(appended.body.rows[0].done, false);

  const listed = await api('GET', '/feedback', undefined, '?address=a');
  assert.equal(listed.body.rows.length, 1);

  const done = await api('POST', '/feedback/done', { index: 0, address: 'a' });
  assert.equal(done.status, 200);
  assert.equal(done.body.rows[0].done, true);

  const missing = await api('POST', '/feedback/done', { index: 99, address: 'a' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'kb.feedback.missing-index');
});

test('job routes list, prune, recover and reject unknown ids', async () => {
  await seed();
  const listed = await api('GET', '/jobs');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.ok, true);
  assert.equal(listed.body.path, nodePath.join(jobsDir, 'queue.json'));
  assert.deepEqual(listed.body.warnings, []);
  assert.deepEqual(listed.body.jobs, []);
  assert.equal(listed.body.summary.total, 0);

  const unknown = await api('POST', '/jobs/cancel', { id: 'missing' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'kb.job.unknown');

  const pruned = await api('POST', '/jobs/prune', { keepDone: 0 });
  assert.equal(pruned.status, 200);
  assert.equal(pruned.body.ok, true);
  assert.equal(pruned.body.summary.total, 0);

  const recovered = await api('POST', '/jobs/recover');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.ok, true);
  assert.equal(typeof recovered.body.summary.pending, 'number');
});

test('unknown paths and methods answer 404 with the not-found code', async () => {
  await seed();
  for (const [method, pathname] of [['GET', '/nope'], ['GET', ''], ['POST', '/vaults'], ['POST', '/feedback/bogus']] as const) {
    const result = await api(method, pathname);
    assert.equal(result.status, 404, method + ' ' + pathname);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'kb.api.not-found');
  }
  assert.equal(SETTINGS_ROUTE_PREFIX, '/api/v1/aikb');
});
