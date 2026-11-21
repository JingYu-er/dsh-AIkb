import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/application/config-store.js';
import { createVault, parseTemplate, planRegistration, templateFolders } from '../src/application/kb-init.js';

const NL = String.fromCharCode(10);

function withWork<T>(run: (work: string) => T): T {
  const work = mkdtempSync(join(tmpdir(), 'dsh-aikb-init-'));
  try {
    return run(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('a relative directory is refused before anything is created', () => {
  const result = createVault({ dir: 'relative/vault', allowWrites: true });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'kb.init.relative');
});

test('creating a vault needs the write switch', () => {
  withWork((work) => {
    const dir = join(work, 'vault');
    const result = createVault({ dir, allowWrites: false });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'kb.init.read-only');
    assert.equal(existsSync(dir), false);
  });
});

test('a directory holding files is never reused', () => {
  withWork((work) => {
    const dir = join(work, 'occupied');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'note.md'), '# existing' + NL);
    const result = createVault({ dir, allowWrites: true });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'kb.init.not-empty');
    assert.deepEqual(readFileSync(join(dir, 'note.md'), 'utf8'), '# existing' + NL);
  });
});

test('the notes template lays out folders, marker, sheet and index', () => {
  withWork((work) => {
    const dir = join(work, 'library');
    const result = createVault({ dir, allowWrites: true, name: 'Library' });
    assert.equal(result.ok, true);
    const vault = result.vault!;
    assert.equal(vault.name, 'Library');
    assert.equal(vault.template, 'notes');
    assert.deepEqual(vault.created, ['notes', 'sources', '.obsidian/app.json', '.dsh-aikb/schema.md', 'README.md', 'index.md']);
    for (const folder of templateFolders('notes')) assert.equal(existsSync(join(dir, folder)), true, folder);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.obsidian/app.json'), 'utf8')), {});
    const sheet = readFileSync(join(dir, '.dsh-aikb/schema.md'), 'utf8');
    assert.ok(sheet.includes('## 页面规范'));
    assert.ok(sheet.includes('Library'));
    assert.ok(readFileSync(join(dir, 'README.md'), 'utf8').startsWith('# Library'));
    const index = readFileSync(join(dir, 'index.md'), 'utf8');
    assert.ok(index.includes('type: moc'));
    assert.ok(index.includes('[[books/|books]]') === false);
    assert.ok(index.includes('[[notes/|notes]]'));
  });
});

test('the blank template creates the marker and the sheet only', () => {
  withWork((work) => {
    const dir = join(work, 'blank');
    const result = createVault({ dir, allowWrites: true, template: 'blank' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.vault!.created, ['.obsidian/app.json', '.dsh-aikb/schema.md', 'README.md', 'index.md']);
    assert.deepEqual(templateFolders('blank'), []);
  });
});

test('registering a new vault uses a slug id and can become active', () => {
  withWork((work) => {
    delete process.env.KB_VAULT;
    process.env.KB_CONFIG = join(work, 'config.json');
    try {
      const loaded = loadConfig({});
      const plan = planRegistration(loaded, { dir: join(work, 'My Vault'), name: 'My Vault' });
      assert.equal(plan.alreadyRegistered, false);
      assert.equal(plan.entry.id, 'my-vault');
      assert.equal(plan.patch.vaults.length, 1);
      assert.equal(plan.patch.activeVault, 'my-vault');
    } finally {
      delete process.env.KB_CONFIG;
    }
  });
});

test('registering an existing directory reuses its entry and honours activate false', () => {
  withWork((work) => {
    delete process.env.KB_VAULT;
    process.env.KB_CONFIG = join(work, 'config.json');
    try {
      const first = loadConfig({});
      const planA = planRegistration(first, { dir: join(work, 'lib'), name: 'Lib', activate: false });
      assert.equal(planA.patch.activeVault, first.config.activeVault);
      const loaded = {
        ...first,
        config: { ...first.config, vaults: planA.patch.vaults, activeVault: planA.patch.activeVault },
      };
      const planB = planRegistration(loaded, { dir: join(work, 'lib'), name: 'Other name' });
      assert.equal(planB.alreadyRegistered, true);
      assert.equal(planB.entry.id, 'lib');
      assert.equal(planB.patch.vaults.length, 1);
      assert.equal(planB.patch.activeVault, 'lib');
    } finally {
      delete process.env.KB_CONFIG;
    }
  });
});

test('an unknown template name falls back to notes', () => {
  assert.equal(parseTemplate('BOOKS'), 'books');
  assert.equal(parseTemplate('nonsense'), 'notes');
  assert.equal(parseTemplate(undefined), 'notes');
});
