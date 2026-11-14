import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, resolveVaultRoot } from '../src/config.js';
import { isWritableTarget } from '../src/domain/vault.js';
import { vaultRelPath } from '../src/domain/ids.js';

describe('vault resolution', () => {
  it('prefers an explicit path', () => {
    const r = resolveVaultRoot({ explicitPath: 'D:/vaults/main', candidates: ['D:/a', 'D:/b'] });
    assert.equal(r.ok, true);
  });

  it('refuses to guess when several vaults are found', () => {
    const r = resolveVaultRoot({ candidates: ['D:/a', 'D:/b'] });
    assert.equal(r.ok ? 'accepted' : r.error.code, 'vault.ambiguous');
  });

  it('reports a clear error when none is found', () => {
    const r = resolveVaultRoot({ candidates: [] });
    assert.equal(r.ok ? 'accepted' : r.error.code, 'vault.not-found');
  });
});

describe('write guard', () => {
  const cfg = buildConfig({ vaultRoot: 'D:/vaults/main' });

  it('allows inbox and .wiki only', () => {
    assert.equal(isWritableTarget(cfg.vault, 'inbox/draft.md'), true);
    assert.equal(isWritableTarget(cfg.vault, '.wiki/books.jsonl'), true);
    assert.equal(isWritableTarget(cfg.vault, '学习/硬件/STM32.md'), false);
    assert.equal(isWritableTarget(cfg.vault, '.obsidian/app.json'), false);
  });

  it('is read-only by default', () => {
    assert.equal(cfg.guards.allowWrites, false);
    assert.equal(cfg.guards.autoInsertLinks, false);
  });
});

describe('path safety', () => {
  it('rejects absolute and traversing paths', () => {
    assert.throws(() => vaultRelPath('/etc/passwd'));
    assert.throws(() => vaultRelPath('a/../../b'));
    assert.equal(vaultRelPath('学习/硬件/x.md'), '学习/硬件/x.md');
  });
});
