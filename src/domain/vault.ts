import { DomainError } from '../shared/result.js';

/**
 * Where the AI is allowed to read and write.
 * The vault root is user configuration, never discovered by guessing:
 * the adapter resolves it from config, then from a .obsidian marker walking upward,
 * and refuses to continue when more than one vault is in scope.
 */
export interface VaultLayout {
  /** Absolute path of the Obsidian vault. */
  readonly root: string;
  /** Human-owned drafts produced by the AI. Never the formal area. */
  readonly inboxDir: string;
  /** Compiled artefacts: chunks, ledgers, snapshots. Disposable. */
  readonly wikiDir: string;
  /** Where Obsidian keeps attachments. Read-only for the AI. */
  readonly attachmentsDir: string;
  /** Paths the AI must never write, relative to root. */
  readonly readOnly: readonly string[];
}

export const DEFAULT_LAYOUT: Omit<VaultLayout, 'root'> = {
  inboxDir: 'inbox',
  wikiDir: '.wiki',
  attachmentsDir: 'attachments',
  readOnly: ['.obsidian', '.trash'],
};

const DRIVE_ABS = /^[A-Za-z]:[\\/]/;

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || DRIVE_ABS.test(p);
}

export function openVault(root: string, overrides: Partial<Omit<VaultLayout, 'root'>> = {}): VaultLayout {
  const layout: VaultLayout = { ...DEFAULT_LAYOUT, ...overrides, root };
  if (!isAbsolutePath(layout.root)) {
    throw new DomainError('vault.root.relative', 'vault root must be absolute: ' + layout.root);
  }
  for (const dir of [layout.inboxDir, layout.wikiDir, layout.attachmentsDir]) {
    if (isAbsolutePath(dir) || dir.split('/').includes('..')) {
      throw new DomainError('vault.dir.invalid', 'vault sub-directory must stay inside the vault: ' + dir);
    }
  }
  if (!layout.readOnly.includes('.obsidian')) {
    throw new DomainError('vault.guard', '.obsidian must always be read-only');
  }
  return layout;
}

/** The only place the compiler is allowed to write: drafts, and never a Note the user owns. */
export function isWritableTarget(layout: VaultLayout, relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const blocked = layout.readOnly.some((p) => normalized === p || normalized.startsWith(p + '/'));
  if (blocked) return false;
  return normalized.startsWith(layout.inboxDir + '/') || normalized.startsWith(layout.wikiDir + '/');
}
