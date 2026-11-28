import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';

/**
 * Configuration model for dsh-AIkb.
 *
 * One file is the single source of truth (~/.dsh-aikb/config.json): the settings page, the KB
 * panel and the agent tools all read the same document, so a change made in one surface is
 * visible in the others without a restart. The cordis patch config stays as an operator
 * override for pinned deployments; it wins over the file, never the other way round.
 *
 * Version 1 was a single vaultPath, and every path that mattered (venv, models, OCR graph) was
 * anchored under the working directory. Version 2 declares those anchors explicitly: multiple
 * vaults, one knowledge-pack directory, one toolchain directory shared by every vault.
 */

export interface KbVaultEntry {
  /** Stable id used by URLs and tool arguments; never derived from the display name. */
  id: string;
  /** Display name; the user may rename it without touching paths. */
  name: string;
  /** Absolute path of the Obsidian vault. */
  dir: string;
  /** Vault-relative folder holding the books (unset: auto-discover). */
  booksDir?: string;
}

export interface KbConfig {
  version: 2;
  vaults: KbVaultEntry[];
  activeVault: string;
  /** Where kb_export_pack writes packs. Empty means "not configured yet". */
  packDir: string;
  /** Where the private venv, OCR graph and ONNX models live, shared by every vault. */
  toolchainDir: string;
  pythonPath: string;
  pythonLibPath: string;
  pythonMirror: string;
  ocrEnabled: boolean;
  ocrWorkers: number;
  embedEnabled: boolean;
  embedOnIngest: boolean;
  rerankEnabled: boolean;
  allowWrites: boolean;
  /** Vault-relative folder kb_promote writes into; empty disables promotion. */
  promoteDir: string;
}

/** Subset accepted from the cordis patch; every field optional. */
export interface KbConfigOverrides {
  vaultPath?: string;
  allowWrites?: boolean;
  pythonPath?: string;
  pythonLibPath?: string;
  venvPath?: string;
  workspaceRoot?: string;
  pythonMirror?: string;
  ocrEnabled?: boolean;
  ocrWorkers?: number;
  embedEnabled?: boolean;
  embedOnIngest?: boolean;
  rerankEnabled?: boolean;
  promoteDir?: string;
}

export interface ConfigProblem {
  field: string;
  message: string;
}

export interface LoadedConfig {
  config: KbConfig;
  /** Where the values came from, for kb_doctor and the settings page. */
  sources: string[];
  warnings: string[];
  configComplete: boolean;
  missing: string[];
  revision: string;
}

export interface SaveResult {
  ok: boolean;
  config: KbConfig;
  revision: string;
  problems: ConfigProblem[];
  error?: string;
}

const DEFAULTS: Omit<KbConfig, 'vaults' | 'activeVault' | 'packDir' | 'toolchainDir'> = {
  version: 2,
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

/** Config file location; KB_CONFIG exists so tests and portable installs can point elsewhere. */
export function configFilePath(): string {
  const explicit = process.env.KB_CONFIG;
  if (explicit !== undefined && explicit.trim() !== '') return nodePath.resolve(explicit.trim());
  return nodePath.join(homedir(), '.dsh-aikb', 'config.json');
}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const asBool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
const asNumber = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

function readRaw(): { raw?: Record<string, unknown>; error?: string } {
  const file = configFilePath();
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'kb.config.invalid: ' + file + ' is not a JSON object' };
    }
    return { raw: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: 'kb.config.unreadable: ' + file + ' (' + String(error) + ')' };
  }
}

/** Ids are user-facing URL material: lowercase, no spaces, stable across renames. */
export function slugId(name: string, taken: string[] = []): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const seed = base === '' ? 'vault' : base;
  if (!taken.includes(seed)) return seed;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = seed + '-' + n;
    if (!taken.includes(candidate)) return candidate;
  }
  return seed + '-' + Date.now().toString(36);
}

function normalizeVaults(raw: Record<string, unknown>, overrides: KbConfigOverrides): { vaults: KbVaultEntry[]; activeVault: string; warnings: string[] } {
  const warnings: string[] = [];
  const list = Array.isArray(raw.vaults) ? raw.vaults : [];
  const vaults: KbVaultEntry[] = [];
  const taken: string[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const dir = asString(entry.dir);
    if (dir === '') continue;
    const name = asString(entry.name) || nodePath.basename(dir);
    const id = asString(entry.id) || slugId(name, taken);
    if (taken.includes(id)) {
      warnings.push('kb.config.duplicate-vault: id "' + id + '" skipped');
      continue;
    }
    taken.push(id);
    const booksDir = asString(entry.booksDir);
    vaults.push({ id, name, dir: nodePath.resolve(dir), ...(booksDir !== '' ? { booksDir } : {}) });
  }
  // Version 1: a single vaultPath in the patch, or a KB_VAULT environment variable.
  if (vaults.length === 0) {
    const legacy = asString(overrides.vaultPath) || asString(process.env.KB_VAULT);
    if (legacy !== '') {
      vaults.push({ id: 'default', name: nodePath.basename(nodePath.resolve(legacy)), dir: nodePath.resolve(legacy) });
      warnings.push('kb.config.migrated: treated vaultPath as vault "default"');
    }
  }
  const configured = asString(raw.activeVault);
  const activeVault = configured !== '' && vaults.some((v) => v.id === configured) ? configured : (vaults[0]?.id ?? '');
  if (configured !== '' && activeVault !== configured) {
    warnings.push('kb.config.active-vault: "' + configured + '" not found, fell back to "' + activeVault + '"');
  }
  return { vaults, activeVault, warnings };
}

/**
 * Read + merge + validate. Never throws: a broken config file must degrade to "not configured",
 * not to a plugin that fails to load.
 */
export function loadConfig(overrides: KbConfigOverrides = {}, cwd: string = process.cwd()): LoadedConfig {
  const { raw, error } = readRaw();
  const warnings: string[] = [];
  const sources: string[] = [];
  if (error !== undefined) warnings.push(error);
  if (raw !== undefined) sources.push(configFilePath());

  const base = raw ?? {};
  const { vaults, activeVault, warnings: vaultWarnings } = normalizeVaults(base, overrides);
  warnings.push(...vaultWarnings);

  const toolchainRaw = asString(base.toolchainDir) || (asString(overrides.workspaceRoot) !== '' ? nodePath.join(nodePath.resolve(asString(overrides.workspaceRoot)), '.kb') : '');
  const venvOverride = asString(overrides.venvPath);
  const config: KbConfig = {
    version: 2,
    vaults,
    activeVault,
    packDir: asString(base.packDir) !== '' ? nodePath.resolve(asString(base.packDir)) : '',
    toolchainDir: venvOverride !== '' ? nodePath.dirname(nodePath.resolve(venvOverride)) : (toolchainRaw !== '' ? nodePath.resolve(toolchainRaw) : ''),
    pythonPath: asString(base.pythonPath) || asString(overrides.pythonPath) || DEFAULTS.pythonPath,
    pythonLibPath: asString(base.pythonLibPath) || asString(overrides.pythonLibPath) || DEFAULTS.pythonLibPath,
    pythonMirror: asString(base.pythonMirror) || asString(overrides.pythonMirror) || DEFAULTS.pythonMirror,
    ocrEnabled: asBool(base.ocrEnabled, asBool(overrides.ocrEnabled, DEFAULTS.ocrEnabled)),
    ocrWorkers: asNumber(base.ocrWorkers, asNumber(overrides.ocrWorkers, DEFAULTS.ocrWorkers)),
    embedEnabled: asBool(base.embedEnabled, asBool(overrides.embedEnabled, DEFAULTS.embedEnabled)),
    embedOnIngest: asBool(base.embedOnIngest, asBool(overrides.embedOnIngest, DEFAULTS.embedOnIngest)),
    rerankEnabled: asBool(base.rerankEnabled, asBool(overrides.rerankEnabled, DEFAULTS.rerankEnabled)),
    allowWrites: asBool(base.allowWrites, asBool(overrides.allowWrites, DEFAULTS.allowWrites)),
    promoteDir: asString(base.promoteDir) || asString(overrides.promoteDir) || DEFAULTS.promoteDir,
  };
  if (config.packDir === '' && raw === undefined && asString(overrides.workspaceRoot) !== '') {
    // A fresh install with only a workspace root: keep the pack directory next to it.
    config.packDir = nodePath.join(nodePath.dirname(nodePath.resolve(asString(overrides.workspaceRoot))), 'kb-packs');
  }

  const problems = validateConfig(config);
  const missing = readiness(config);
  return { config, sources, warnings, configComplete: missing.length === 0 && problems.every((p) => p.field !== 'vaults'), missing, revision: revisionOf(config) };
}

/** Directory-level checks. Existence is a warning in loadConfig and an error in saveConfig. */
export function validateConfig(config: KbConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  if (config.vaults.length === 0) problems.push({ field: 'vaults', message: 'kb.config.vaults-empty: add at least one knowledge base' });
  const ids = new Set<string>();
  for (const vault of config.vaults) {
    if (ids.has(vault.id)) problems.push({ field: 'vaults.' + vault.id, message: 'kb.config.vault-id-duplicate: ' + vault.id });
    ids.add(vault.id);
    if (!nodePath.isAbsolute(vault.dir)) problems.push({ field: 'vaults.' + vault.id + '.dir', message: 'kb.config.relative: ' + vault.dir });
  }
  for (const vault of [config.packDir, config.toolchainDir]) {
    if (vault !== '' && !nodePath.isAbsolute(vault)) problems.push({ field: 'path', message: 'kb.config.relative: ' + vault });
  }
  return problems;
}

/**
 * What the first-run gate keys on: a usable vault and a pack directory. An empty
 * toolchainDir is not missing — it means the default root under the home directory,
 * so flagging it would contradict the field's own placeholder.
 */
export function readiness(config: KbConfig): string[] {
  const missing: string[] = [];
  const active = config.vaults.find((v) => v.id === config.activeVault);
  if (active === undefined) missing.push('vaults');
  else if (!existsSync(active.dir)) missing.push('vaults.dir');
  if (config.packDir === '') missing.push('packDir');
  return missing;
}

/**
 * Whether a tool call may proceed. An explicit vaultPath always passes (tests and scripts pin one);
 * otherwise the config must name a vault directory that exists. packDir and toolchainDir are
 * reported by readiness() but do not block reading, so a half-configured install stays searchable.
 */
export function vaultGate(config: KbConfig, explicit?: string): { ok: boolean; missing: string[] } {
  if (asString(explicit) !== '') return { ok: true, missing: [] };
  const missing = readiness(config).filter((field) => field === 'vaults' || field === 'vaults.dir');
  return { ok: missing.length === 0, missing };
}

export function revisionOf(config: KbConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

export function activeVaultEntry(config: KbConfig): KbVaultEntry | undefined {
  return config.vaults.find((v) => v.id === config.activeVault) ?? config.vaults[0];
}

/** Tool arguments may name a vault by id, by absolute path, or leave it to the active one. */
export function resolveVaultPath(config: KbConfig, explicit?: string): string {
  const wanted = asString(explicit);
  if (wanted !== '') {
    const byId = config.vaults.find((v) => v.id === wanted);
    if (byId !== undefined) return byId.dir;
    const resolved = nodePath.resolve(wanted);
    // Windows paths are case-insensitive, and users type them by hand; match like the shell would.
    const samePath = (left: string, right: string): boolean => (process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right);
    const byPath = config.vaults.find((v) => samePath(nodePath.resolve(v.dir), resolved));
    if (byPath !== undefined) return byPath.dir;
    // An explicit path outside the configured list is still honoured: discovery is a feature.
    return resolved;
  }
  const active = activeVaultEntry(config);
  if (active !== undefined) return active.dir;
  throw new Error('kb.vault.not-configured: open the settings page and add a knowledge base, or pass vaultPath.');
}

export interface ToolchainPaths {
  root: string;
  venv: string;
  models: string;
  ocr: string;
  embed: string;
  rerank: string;
  logs: string;
}

/**
 * Every heavy artifact lives under one shared root so two vaults never download the same model
 * twice. Callers still pass an explicit path when the config sets one (venvPath, ocrModelDir...).
 */
export function toolchainPaths(config: KbConfig): ToolchainPaths {
  const root = config.toolchainDir !== '' ? config.toolchainDir : nodePath.join(homedir(), '.dsh-aikb', 'toolchain');
  return {
    root,
    venv: nodePath.join(root, 'venv'),
    models: nodePath.join(root, 'models'),
    ocr: nodePath.join(root, 'models', 'ocr'),
    embed: nodePath.join(root, 'models', 'multilingual-e5-small'),
    rerank: nodePath.join(root, 'models', 'bge-reranker-base'),
    logs: nodePath.join(root, 'logs'),
  };
}

/**
 * Atomic write: a half-written config would leave the panel pointing at a path that no longer
 * parses. expectRevision makes two surfaces (settings page, panel) detect each other's edits
 * instead of silently overwriting them.
 */
export function saveConfig(patch: Partial<KbConfig>, options: { expectRevision?: string; overrides?: KbConfigOverrides } = {}): SaveResult {
  const loaded = loadConfig(options.overrides ?? {});
  const current = loaded.config;
  if (options.expectRevision !== undefined && options.expectRevision !== '' && options.expectRevision !== loaded.revision) {
    return { ok: false, config: current, revision: loaded.revision, problems: [], error: 'kb.config.stale: the config changed since it was read; reload before saving' };
  }
  const merged: KbConfig = {
    ...current,
    ...patch,
    version: 2,
    vaults: Array.isArray(patch.vaults) ? patch.vaults.map((v) => ({ ...v, dir: nodePath.resolve(v.dir), ...(v.booksDir !== undefined && v.booksDir !== '' ? { booksDir: v.booksDir } : {}) })) : current.vaults,
  };
  const problems = validateConfig(merged);
  if (problems.length > 0) return { ok: false, config: merged, revision: loaded.revision, problems };
  const file = configFilePath();
  try {
    mkdirSync(nodePath.dirname(file), { recursive: true });
    readRaw(); // surface an unreadable file before replacing it
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    return { ok: false, config: merged, revision: loaded.revision, problems, error: 'kb.config.write-failed: ' + String(error) };
  }
  const revision = revisionOf(merged);
  return { ok: true, config: merged, revision, problems: [] };
}

/** mtime is the hot-reload signal: the panel re-reads on change, no restart, no watcher. */
export function configMtime(): number {
  try {
    return statSync(configFilePath()).mtimeMs;
  } catch {
    return 0;
  }
}

/** Plain, JSON-safe view of the config for kb_doctor, the settings page and logs. */
export interface ConfigSnapshot {
  path: string;
  revision: string;
  configComplete: boolean;
  missing: string[];
  warnings: string[];
  sources: string[];
  activeVault: string;
  vaults: { id: string; name: string; dir: string; exists: boolean; active: boolean }[];
  toolchain: ToolchainPaths;
}

/** Never throws: an unreadable config becomes undefined so callers can still report the vault. */
export function configSnapshot(): ConfigSnapshot | undefined {
  try {
    const loaded = loadConfig();
    return {
      path: configFilePath(),
      revision: loaded.revision,
      configComplete: loaded.configComplete,
      missing: loaded.missing,
      warnings: loaded.warnings,
      sources: loaded.sources,
      activeVault: loaded.config.activeVault,
      vaults: loaded.config.vaults.map((v) => ({
        id: v.id,
        name: v.name,
        dir: v.dir,
        exists: existsSync(v.dir),
        active: v.id === loaded.config.activeVault,
      })),
      toolchain: toolchainPaths(loaded.config),
    };
  } catch {
    return undefined;
  }
}
