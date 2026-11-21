import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { slugId } from './config-store.js';
import type { KbVaultEntry, LoadedConfig } from './config-store.js';
import { schemaTemplate } from './vault-schema.js';

/**
 * Creating a vault means writing outside the current vault, so the module does the work and
 * the tool decides who may call it. Every refusal carries a code the settings page can show.
 */

export type VaultTemplate = 'blank' | 'notes' | 'books' | 'both';

export const TEMPLATES: readonly VaultTemplate[] = ['notes', 'books', 'both', 'blank'];

export interface InitVaultOptions {
  readonly dir: string;
  readonly name?: string;
  readonly template?: VaultTemplate;
  readonly allowWrites: boolean;
}

export interface InitialisedVault {
  readonly name: string;
  readonly dir: string;
  readonly template: VaultTemplate;
  /** Vault-relative POSIX paths, in creation order. */
  readonly created: string[];
}

export interface InitVaultResult {
  readonly ok: boolean;
  readonly vault?: InitialisedVault;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Folder layout per template; a blank vault gets the marker and the sheet only. */
export function templateFolders(template: VaultTemplate): string[] {
  if (template === 'notes') return ['notes', 'sources'];
  if (template === 'books') return ['books', 'sources'];
  if (template === 'both') return ['notes', 'books', 'sources'];
  return [];
}

export function defaultVaultName(dir: string): string {
  const base = nodePath.basename(nodePath.resolve(dir));
  return base === '' || base === nodePath.parse(dir).root ? 'Knowledge Base' : base;
}

const MARKER_FILE = 'README.md';
const INDEX_FILE = 'index.md';

function markerText(name: string): string {
  return [
    '# ' + name,
    '',
    'This vault is read by dsh-AIkb: drop PDF or EPUB files in the source folders, run',
    'kb_ingest once, then ask questions with kb_query. The vault sheet in',
    '.dsh-aikb/schema.md tells both you and the agent how pages should be written.',
    '',
  ].join(String.fromCharCode(10));
}

function indexText(name: string, template: VaultTemplate): string {
  const folders = templateFolders(template);
  const lines = ['---', 'type: moc', 'title: ' + name, '---', '', '# ' + name, ''];
  for (const folder of folders) {
    lines.push('- [[' + folder + '/|' + folder + ']] — ' + (folder === 'books' ? 'PDF and EPUB sources' : folder === 'sources' ? 'other source material' : 'your own notes'));
  }
  lines.push('');
  return lines.join(String.fromCharCode(10));
}

/** Create the vault skeleton. Refuses to touch a directory that already holds files. */
export function createVault(options: InitVaultOptions): InitVaultResult {
  const dir = nodePath.resolve(options.dir);
  const name = (options.name ?? '').trim() === '' ? defaultVaultName(dir) : options.name!.trim();
  const template: VaultTemplate = options.template ?? 'notes';
  if (!nodePath.isAbsolute(options.dir)) {
    return { ok: false, error: { code: 'kb.init.relative', message: 'The vault directory must be absolute: ' + options.dir } };
  }
  if (!options.allowWrites) {
    return { ok: false, error: { code: 'kb.init.read-only', message: 'Writes are disabled; enable allowWrites in the KB settings page before creating a vault.' } };
  }
  if (existsSync(dir)) {
    const existing = readdirSync(dir);
    if (existing.length > 0) {
      return {
        ok: false,
        error: {
          code: 'kb.init.not-empty',
          message: 'The directory already has ' + existing.length + ' entries; pick an empty directory or add this one as an existing vault instead.',
        },
      };
    }
  }
  const created: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    for (const folder of templateFolders(template)) {
      mkdirSync(nodePath.join(dir, folder), { recursive: true });
      created.push(folder);
    }
    const obsidianDir = nodePath.join(dir, '.obsidian');
    mkdirSync(obsidianDir, { recursive: true });
    const appJson = nodePath.join(obsidianDir, 'app.json');
    if (!existsSync(appJson)) {
      writeFileSync(appJson, '{' + String.fromCharCode(10) + '}' + String.fromCharCode(10), 'utf8');
      created.push('.obsidian/app.json');
    }
    const sheetDir = nodePath.join(dir, '.dsh-aikb');
    mkdirSync(sheetDir, { recursive: true });
    const sheetPath = nodePath.join(sheetDir, 'schema.md');
    writeFileSync(sheetPath, schemaTemplate(name), 'utf8');
    created.push('.dsh-aikb/schema.md');
    writeFileSync(nodePath.join(dir, MARKER_FILE), markerText(name), 'utf8');
    created.push(MARKER_FILE);
    writeFileSync(nodePath.join(dir, INDEX_FILE), indexText(name, template), 'utf8');
    created.push(INDEX_FILE);
    return { ok: true, vault: { name, dir, template, created } };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'kb.init.write-failed', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export interface RegistrationPlan {
  readonly patch: { readonly vaults: KbVaultEntry[]; readonly activeVault: string };
  readonly entry: KbVaultEntry;
  readonly alreadyRegistered: boolean;
  readonly revision: string;
}

/** Work out the config patch that adds (or reuses) a vault entry without touching the file. */
export function planRegistration(
  loaded: LoadedConfig,
  input: { readonly dir: string; readonly name: string; readonly activate?: boolean },
): RegistrationPlan {
  const dir = nodePath.resolve(input.dir);
  const existing = loaded.config.vaults.find((v) => samePath(nodePath.resolve(v.dir), dir));
  const entry: KbVaultEntry = existing ?? {
    id: slugId(input.name, loaded.config.vaults.map((v) => v.id)),
    name: input.name,
    dir,
  };
  const vaults = existing === undefined ? [...loaded.config.vaults, entry] : loaded.config.vaults;
  const activate = input.activate !== false;
  const activeVault = activate ? entry.id : loaded.config.activeVault;
  return { patch: { vaults, activeVault }, entry, alreadyRegistered: existing !== undefined, revision: loaded.revision };
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function parseTemplate(value: string | undefined): VaultTemplate {
  const text = (value ?? '').trim().toLowerCase();
  return TEMPLATES.includes(text as VaultTemplate) ? (text as VaultTemplate) : 'notes';
}
