import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import {
  activeVaultEntry,
  configFilePath,
  configMtime,
  loadConfig,
  readiness,
  resolveVaultPath,
  saveConfig,
  slugId,
  configSnapshot,
  toolchainPaths,
  validateConfig,
  vaultGate,
} from '../src/application/config-store.js';
import type { KbConfig } from '../src/application/config-store.js';

const tempBase = nodePath.resolve(process.cwd(), '..', 'temp');

function makeTemp(prefix: string): string {
  mkdirSync(tempBase, { recursive: true });
  return mkdtempSync(nodePath.join(tempBase, prefix));
}

/** Point the module at a throwaway config file, and keep the process environment clean afterwards. */
function withConfigFile(dir: string, run: () => void): void {
  const savedConfig = process.env.KB_CONFIG;
  const savedVault = process.env.KB_VAULT;
  process.env.KB_CONFIG = nodePath.join(dir, 'config.json');
  delete process.env.KB_VAULT;
  try {
    run();
  } finally {
    if (savedConfig === undefined) delete process.env.KB_CONFIG;
    else process.env.KB_CONFIG = savedConfig;
    if (savedVault === undefined) delete process.env.KB_VAULT;
    else process.env.KB_VAULT = savedVault;
  }
}

function writeConfig(dir: string, value: unknown): string {
  const file = nodePath.join(dir, 'config.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  return file;
}

test('configFilePath follows KB_CONFIG and defaults to the home directory', () => {
  const saved = process.env.KB_CONFIG;
  try {
    delete process.env.KB_CONFIG;
    assert.equal(configFilePath(), nodePath.join(homedir(), '.dsh-aikb', 'config.json'));
    const dir = makeTemp('kb-config-path-');
    try {
      process.env.KB_CONFIG = '  ' + nodePath.join(dir, 'custom.json') + '  ';
      assert.equal(configFilePath(), nodePath.resolve(nodePath.join(dir, 'custom.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (saved === undefined) delete process.env.KB_CONFIG;
    else process.env.KB_CONFIG = saved;
  }
});

test('an empty install loads defaults and reports the three first-run answers as missing', () => {
  const dir = makeTemp('kb-config-empty-');
  try {
    withConfigFile(dir, () => {
      const loaded = loadConfig();
      assert.deepEqual(loaded.config.vaults, []);
      assert.equal(loaded.config.pythonPath, 'python');
      assert.equal(loaded.config.pythonMirror, 'https://pypi.tuna.tsinghua.edu.cn/simple');
      assert.equal(loaded.config.ocrEnabled, true);
      assert.equal(loaded.config.ocrWorkers, 4);
      assert.equal(loaded.config.embedEnabled, true);
      assert.equal(loaded.config.embedOnIngest, true);
      assert.equal(loaded.config.rerankEnabled, false);
      assert.equal(loaded.config.allowWrites, false);
      assert.deepEqual(loaded.missing, ['vaults', 'packDir', 'toolchainDir']);
      assert.equal(loaded.configComplete, false);
      assert.deepEqual(loaded.warnings, []);
      assert.deepEqual(loaded.sources, []);
      assert.equal(loaded.revision.length, 16);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version 1 vaultPath migrates to the "default" vault and satisfies the vault gate', () => {
  const dir = makeTemp('kb-config-migrate-');
  const vault = nodePath.join(dir, 'My Vault');
  mkdirSync(vault, { recursive: true });
  try {
    withConfigFile(dir, () => {
      const loaded = loadConfig({ vaultPath: vault });
      assert.equal(loaded.config.vaults.length, 1);
      assert.equal(loaded.config.vaults[0]!.id, 'default');
      assert.equal(loaded.config.vaults[0]!.name, 'My Vault');
      assert.equal(loaded.config.vaults[0]!.dir, nodePath.resolve(vault));
      assert.equal(loaded.config.activeVault, 'default');
      assert.ok(loaded.warnings.includes('kb.config.migrated: treated vaultPath as vault "default"'));
      assert.deepEqual(loaded.missing, ['packDir', 'toolchainDir']);
      assert.equal(loaded.configComplete, false);
    });
    // KB_VAULT is the other legacy entry point and is honoured when no file exists.
    withConfigFile(dir, () => {
      process.env.KB_VAULT = vault;
      const loaded = loadConfig();
      assert.equal(loaded.config.vaults[0]!.id, 'default');
      assert.ok(loaded.warnings.includes('kb.config.migrated: treated vaultPath as vault "default"'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readiness flags a vault directory that no longer exists', () => {
  const dir = makeTemp('kb-config-readiness-');
  const vault = nodePath.join(dir, 'vault');
  const pack = nodePath.join(dir, 'packs');
  const tool = nodePath.join(dir, 'toolchain');
  mkdirSync(vault, { recursive: true });
  writeConfig(dir, { version: 2, vaults: [{ id: 'main', name: 'Main', dir: vault }], activeVault: 'main', packDir: pack, toolchainDir: tool });
  try {
    withConfigFile(dir, () => {
      const loaded = loadConfig();
      assert.deepEqual(loaded.missing, []);
      assert.equal(loaded.configComplete, true);
      assert.deepEqual(loaded.sources, [configFilePath()]);
      const renamed: KbConfig = { ...loaded.config, vaults: [{ id: 'main', name: 'Main', dir: nodePath.join(dir, 'gone') }] };
      assert.deepEqual(readiness(renamed), ['vaults.dir']);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate ids and unknown active vaults are warned about instead of thrown', () => {
  const dir = makeTemp('kb-config-vaults-');
  const a = nodePath.join(dir, 'a');
  const b = nodePath.join(dir, 'b');
  const c = nodePath.join(dir, 'c');
  for (const p of [a, b, c]) mkdirSync(p, { recursive: true });
  writeConfig(dir, {
    version: 2,
    vaults: [{ id: 'main', name: 'Main', dir: a }, { id: 'main', name: 'Dup', dir: b }, { name: '第二本', dir: c }],
    activeVault: '第二本',
    packDir: nodePath.join(dir, 'packs'),
    toolchainDir: nodePath.join(dir, 'toolchain'),
  });
  try {
    withConfigFile(dir, () => {
      const loaded = loadConfig();
      assert.deepEqual(loaded.config.vaults.map((v) => v.id), ['main', '第二本']);
      assert.equal(loaded.config.activeVault, '第二本');
      assert.ok(loaded.warnings.some((w) => w.startsWith('kb.config.duplicate-vault: id "main"')));
      assert.equal(activeVaultEntry(loaded.config)!.dir, nodePath.resolve(c));

      writeConfig(dir, { ...JSON.parse(readFileSync(nodePath.join(dir, 'config.json'), 'utf8')), activeVault: 'missing' });
      const fallback = loadConfig();
      assert.equal(fallback.config.activeVault, 'main');
      assert.ok(fallback.warnings.includes('kb.config.active-vault: "missing" not found, fell back to "main"'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken file degrades to "not configured" with a warning, never a throw', () => {
  const dir = makeTemp('kb-config-broken-');
  try {
    withConfigFile(dir, () => {
      writeConfig(dir, '{ not json');
      const unreadable = loadConfig();
      assert.equal(unreadable.config.vaults.length, 0);
      assert.ok(unreadable.warnings[0]!.startsWith('kb.config.unreadable: '));

      writeConfig(dir, '[]');
      const invalid = loadConfig();
      assert.equal(invalid.config.vaults.length, 0);
      assert.ok(invalid.warnings[0]!.startsWith('kb.config.invalid: '));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveVaultPath accepts an id, a path, nothing, or an unconfigured explicit path', () => {
  const dir = makeTemp('kb-config-resolve-');
  const a = nodePath.join(dir, 'a');
  const b = nodePath.join(dir, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeConfig(dir, { version: 2, vaults: [{ id: 'a', name: 'A', dir: a }, { id: 'b', name: 'B', dir: b }], activeVault: 'b' });
  try {
    withConfigFile(dir, () => {
      const { config } = loadConfig();
      assert.equal(resolveVaultPath(config, 'a'), nodePath.resolve(a));
      assert.equal(resolveVaultPath(config, a.toUpperCase()), nodePath.resolve(a));
      assert.equal(resolveVaultPath(config), nodePath.resolve(b));
      const outside = nodePath.join(dir, 'outside');
      assert.equal(resolveVaultPath(config, outside), nodePath.resolve(outside));
    });
    withConfigFile(makeTemp('kb-config-throw-'), () => {
      const empty = loadConfig().config;
      assert.throws(() => resolveVaultPath(empty), (error: unknown) => String(error).includes('kb.vault.not-configured'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toolchainPaths anchors every artifact under one root, and venvPath picks its parent', () => {
  const dir = makeTemp('kb-config-toolchain-');
  try {
    withConfigFile(dir, () => {
      const bare = loadConfig().config;
      const fallback = toolchainPaths(bare);
      assert.equal(fallback.root, nodePath.join(homedir(), '.dsh-aikb', 'toolchain'));
      assert.equal(fallback.venv, nodePath.join(fallback.root, 'venv'));
      assert.equal(fallback.embed, nodePath.join(fallback.root, 'models', 'multilingual-e5-small'));
      assert.equal(fallback.rerank, nodePath.join(fallback.root, 'models', 'bge-reranker-base'));

      const configured: KbConfig = { ...bare, toolchainDir: nodePath.join(dir, 'tc') };
      const paths = toolchainPaths(configured);
      assert.equal(paths.root, nodePath.join(dir, 'tc'));
      assert.equal(paths.ocr, nodePath.join(dir, 'tc', 'models', 'ocr'));
      assert.equal(paths.logs, nodePath.join(dir, 'tc', 'logs'));

      const venv = nodePath.join(dir, 'shared', 'venv');
      const derived = loadConfig({ venvPath: venv });
      assert.equal(derived.config.toolchainDir, nodePath.join(dir, 'shared'));

      const workspace = nodePath.join(dir, 'work', 'project');
      const scoped = loadConfig({ workspaceRoot: workspace });
      assert.equal(scoped.config.toolchainDir, nodePath.join(workspace, '.kb'));
      assert.equal(scoped.config.packDir, nodePath.join(dir, 'work', 'kb-packs'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveConfig writes atomically, reloads identically, and rejects stale or relative values', () => {
  const dir = makeTemp('kb-config-save-');
  const vault = nodePath.join(dir, 'vault');
  const packs = nodePath.join(dir, 'packs');
  const tool = nodePath.join(dir, 'toolchain');
  mkdirSync(vault, { recursive: true });
  try {
    withConfigFile(dir, () => {
      assert.equal(configMtime(), 0);
      const saved = saveConfig({
        vaults: [{ id: 'main', name: 'Main', dir: vault }],
        activeVault: 'main',
        packDir: packs,
        toolchainDir: tool,
        allowWrites: true,
        ocrWorkers: 2,
      });
      assert.equal(saved.ok, true);
      assert.deepEqual(saved.problems, []);
      assert.ok(existsSync(nodePath.join(dir, 'config.json')));
      assert.ok(!existsSync(nodePath.join(dir, 'config.json.tmp')));
      assert.ok(configMtime() > 0);

      const reloaded = loadConfig();
      assert.equal(reloaded.revision, saved.revision);
      assert.deepEqual(reloaded.config, saved.config);
      assert.equal(reloaded.config.vaults[0]!.dir, nodePath.resolve(vault));
      assert.equal(reloaded.config.allowWrites, true);
      assert.equal(reloaded.config.ocrWorkers, 2);
      assert.deepEqual(reloaded.missing, []);

      const stale = saveConfig({ packDir: packs }, { expectRevision: '0000000000000000' });
      assert.equal(stale.ok, false);
      assert.ok(String(stale.error).startsWith('kb.config.stale: '));

      const relative = saveConfig({ packDir: 'relative/dir' });
      assert.equal(relative.ok, false);
      assert.equal(relative.problems[0]!.field, 'path');
      assert.ok(relative.problems[0]!.message.startsWith('kb.config.relative: '));

      const untouched = loadConfig().config;
      assert.equal(untouched.packDir, nodePath.resolve(packs));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateConfig rejects empty and relative answers without touching disk', () => {
  const dir = makeTemp('kb-config-validate-');
  try {
    const empty: KbConfig = {
      version: 2,
      vaults: [],
      activeVault: '',
      packDir: '',
      toolchainDir: '',
      pythonPath: 'python',
      pythonLibPath: '',
      pythonMirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
      ocrEnabled: true,
      ocrWorkers: 4,
      embedEnabled: true,
      embedOnIngest: true,
      rerankEnabled: false,
      allowWrites: false,
      promoteDir: '',
    };
    assert.deepEqual(validateConfig(empty), [{ field: 'vaults', message: 'kb.config.vaults-empty: add at least one knowledge base' }]);
    const bad = validateConfig({ ...empty, vaults: [{ id: 'x', name: 'X', dir: 'rel/vault' }], packDir: 'rel' });
    assert.deepEqual(bad.map((p) => p.field), ['vaults.x.dir', 'path']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configSnapshot is a plain view of the file, even when the file is broken', () => {
  const dir = makeTemp('kb-config-snapshot-');
  const vault = nodePath.join(dir, 'vault');
  mkdirSync(vault, { recursive: true });
  try {
    withConfigFile(dir, () => {
      const before = configSnapshot();
      assert.ok(before !== undefined);
      assert.equal(before.configComplete, false);
      assert.ok(before.missing.includes('vaults'));
      assert.deepEqual(before.vaults, []);
      assert.equal(before.path, configFilePath());

      const saved = saveConfig({
        vaults: [{ id: 'main', name: 'Main', dir: vault }],
        packDir: nodePath.join(dir, 'packs'),
        toolchainDir: nodePath.join(dir, 'toolchain'),
      });
      assert.equal(saved.ok, true);
      const after = configSnapshot();
      assert.ok(after !== undefined);
      assert.equal(after.configComplete, true);
      assert.equal(after.vaults.length, 1);
      assert.equal(after.vaults[0]?.active, true);
      assert.equal(after.vaults[0]?.exists, true);
      assert.equal(after.toolchain.root, nodePath.join(dir, 'toolchain'));

      writeConfig(dir, '{ broken');
      const broken = configSnapshot();
      assert.ok(broken !== undefined, 'a broken file still yields a snapshot so the vault report survives');
      assert.ok(broken.warnings[0]?.startsWith('kb.config.unreadable: '));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vaultGate blocks an unconfigured vault but lets an explicit path through', () => {
  const dir = makeTemp('kb-config-gate-');
  const vault = nodePath.join(dir, 'vault');
  mkdirSync(vault, { recursive: true });
  try {
    withConfigFile(dir, () => {
      const empty = loadConfig().config;
      assert.deepEqual(vaultGate(empty), { ok: false, missing: ['vaults'] });
      assert.deepEqual(vaultGate(empty, vault), { ok: true, missing: [] });

      const configured = loadConfig({ vaultPath: vault }).config;
      assert.deepEqual(vaultGate(configured), { ok: true, missing: [] });

      const gone: KbConfig = { ...configured, vaults: [{ id: 'default', name: 'gone', dir: nodePath.join(dir, 'gone') }] };
      assert.deepEqual(vaultGate(gone), { ok: false, missing: ['vaults.dir'] });
      // packDir/toolchainDir are first-run questions, not read gates.
      assert.equal(vaultGate({ ...configured, packDir: '', toolchainDir: '' }).ok, true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slugId keeps ids URL-safe, stable across renames and unique', () => {
  assert.equal(slugId('My Notes'), 'my-notes');
  assert.equal(slugId('My Notes'), 'my-notes');
  assert.equal(slugId('  ...  '), 'vault');
  assert.equal(slugId('Main', ['main']), 'main-2');
  assert.equal(slugId('Main', ['main', 'main-2']), 'main-3');
  assert.equal(slugId('第二 本'), '第二-本');
  assert.ok(slugId('x'.repeat(64)).length <= 32);
});
