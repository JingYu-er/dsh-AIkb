/**
 * Per-vault page history: a copy of a note kept before it is overwritten, stored inside the vault so
 * a restore travels with a sync or a clone.
 *
 * Layout: <vault>/.dsh-aikb/history/<slug>/<stamp>.md, where <slug> is the note path with '/' replaced
 * by '__' and the .md suffix removed, and <stamp> is a UTC ISO string with ':' replaced by '-'.
 * Reads are free; writes need allowWrites and never touch a note outside the vault.
 */

import type { Dirent } from 'node:fs';
import fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';

export interface HistoryEntry {
  readonly stamp: string;
  /** Absolute path of the stored copy. */
  readonly path: string;
  readonly bytes: number;
}

export interface HistoryReport {
  readonly notePath: string;
  /** Absolute history directory for this vault. */
  readonly root: string;
  /** Newest first. */
  readonly entries: HistoryEntry[];
}

/** Largest note accepted into history: a page, not a library dump. */
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Stored copies kept per note. */
const DEFAULT_KEEP = 20;

const ENTRY_SUFFIX = '.md';

interface HistoryError {
  readonly code: string;
  readonly message: string;
}

type NoteLocation =
  | { readonly ok: true; readonly absolute: string; readonly relative: string }
  | { readonly ok: false; readonly error: HistoryError };

export function historyRoot(vaultRoot: string): string {
  return nodePath.join(nodePath.resolve(vaultRoot), '.dsh-aikb', 'history');
}

export function historyDir(vaultRoot: string, notePath: string): string {
  return nodePath.join(historyRoot(vaultRoot), noteSlug(notePath));
}

/**
 * Keep the copy of a note before its content is replaced. Refuses when writes are off, when the note
 * is blank or oversized, and reports the newest copy instead of writing the same text twice.
 */
export async function captureHistory(
  vaultRoot: string,
  notePath: string,
  text: string,
  options: { readonly allowWrites: boolean; readonly maxBytes?: number; readonly keep?: number; readonly stamp?: string },
): Promise<{ ok: boolean; entry?: HistoryEntry; error?: HistoryError }> {
  const located = locateNote(vaultRoot, notePath);
  if (!located.ok) return failure(located.error.code, located.error.message);
  if (!options.allowWrites) {
    return failure('kb.history.read-only', 'Writes are disabled; enable allowWrites to keep page history.');
  }
  const body = String(text ?? '');
  if (body.trim() === '') {
    return failure('kb.history.empty', 'The note is empty; there is nothing worth keeping in history.');
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  const maxBytes = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  if (bytes > maxBytes) {
    return failure('kb.history.too-large', 'The note is ' + String(bytes) + ' bytes; the history limit is ' + String(maxBytes) + '.');
  }
  const requestedKeep = options.keep ?? DEFAULT_KEEP;
  const keep = Number.isFinite(requestedKeep) ? Math.max(1, Math.floor(requestedKeep)) : DEFAULT_KEEP;
  const dir = historyDir(vaultRoot, located.relative);

  const previous = (await readEntries(dir))[0];
  if (previous !== undefined) {
    const newestText = await fsPromises.readFile(previous.path, 'utf8').catch(() => null);
    if (newestText === body) return { ok: true, entry: previous };
  }

  const stamp = options.stamp !== undefined ? cleanStamp(options.stamp) : await nextStamp(dir, Date.now());
  if (stamp === null) {
    return failure('kb.history.invalid-stamp', 'A history stamp must be a bare file name: ' + String(options.stamp) + '.');
  }

  const target = nodePath.join(dir, stamp + ENTRY_SUFFIX);
  const temp = target + '.tmp';
  try {
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(temp, body, 'utf8');
    await fsPromises.rename(temp, target);
  } catch (error) {
    await fsPromises.rm(temp, { force: true }).catch(() => undefined);
    return failure('kb.history.write-failed', errorMessage(error));
  }

  const entry: HistoryEntry = { stamp, path: target, bytes };
  await prune(dir, keep);
  return { ok: true, entry };
}

/** Every stored copy for a note, newest first. A missing directory reads as empty, never as an error. */
export async function listHistory(vaultRoot: string, notePath: string): Promise<HistoryReport> {
  const root = historyRoot(vaultRoot);
  const located = locateNote(vaultRoot, notePath);
  if (!located.ok) return { notePath, root, entries: [] };
  const entries = await readEntries(historyDir(vaultRoot, located.relative));
  return { notePath, root, entries };
}

/** Read one stored copy. Stamps stay a bare file name so a crafted stamp cannot leave the directory. */
export async function readHistoryEntry(
  vaultRoot: string,
  notePath: string,
  stamp: string,
): Promise<{ ok: boolean; text?: string; error?: HistoryError }> {
  const located = locateNote(vaultRoot, notePath);
  if (!located.ok) return failure(located.error.code, located.error.message);
  const clean = cleanStamp(stamp);
  if (clean === null) {
    return failure('kb.history.invalid-stamp', 'A history stamp must be a bare file name: ' + String(stamp) + '.');
  }
  const path = nodePath.join(historyDir(vaultRoot, located.relative), clean + ENTRY_SUFFIX);
  try {
    const text = await fsPromises.readFile(path, 'utf8');
    return { ok: true, text };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return failure('kb.history.missing', 'No history entry "' + clean + '" exists for ' + located.relative + '.');
    }
    return failure('kb.history.read-failed', errorMessage(error));
  }
}

/**
 * Put a stored copy back on disk. The current content is captured first, so a restore can itself be
 * undone from history.
 */
export async function restoreHistory(
  vaultRoot: string,
  notePath: string,
  stamp: string,
  options: { readonly allowWrites: boolean },
): Promise<{ ok: boolean; path?: string; bytes?: number; error?: HistoryError }> {
  const located = locateNote(vaultRoot, notePath);
  if (!located.ok) return failure(located.error.code, located.error.message);
  const clean = cleanStamp(stamp);
  if (clean === null) {
    return failure('kb.history.invalid-stamp', 'A history stamp must be a bare file name: ' + String(stamp) + '.');
  }
  if (!options.allowWrites) {
    return failure('kb.history.read-only', 'Writes are disabled; enable allowWrites to restore a note.');
  }

  const stored = await readHistoryEntry(vaultRoot, located.relative, clean);
  if (!stored.ok || stored.text === undefined) {
    return failure(stored.error?.code ?? 'kb.history.missing', stored.error?.message ?? 'The history entry is unreadable.');
  }

  let current: string | null = null;
  try {
    current = await fsPromises.readFile(located.absolute, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return failure('kb.history.write-failed', errorMessage(error));
  }
  if (current !== null && current.trim() !== '') {
    const captured = await captureHistory(vaultRoot, located.relative, current, { allowWrites: true });
    if (!captured.ok) return failure(captured.error?.code ?? 'kb.history.write-failed', captured.error?.message ?? 'The current note could not be kept.');
  }

  const body = stored.text;
  const temp = located.absolute + '.tmp';
  try {
    await fsPromises.mkdir(nodePath.dirname(located.absolute), { recursive: true });
    await fsPromises.writeFile(temp, body, 'utf8');
    await fsPromises.rename(temp, located.absolute);
  } catch (error) {
    await fsPromises.rm(temp, { force: true }).catch(() => undefined);
    return failure('kb.history.write-failed', errorMessage(error));
  }
  return { ok: true, path: located.absolute, bytes: Buffer.byteLength(body, 'utf8') };
}

function noteSlug(notePath: string): string {
  const posix = String(notePath ?? '').split('\\').join('/');
  return posix.replace(/\//g, '__').replace(/\.md$/, '');
}

/** Resolve a vault-relative note path, refusing anything that escapes the vault. */
function locateNote(vaultRoot: string, notePath: string): NoteLocation {
  const root = nodePath.resolve(vaultRoot);
  const absolute = nodePath.resolve(root, String(notePath ?? ''));
  const relative = nodePath.relative(root, absolute);
  const outside = relative === ''
    || relative === '..'
    || relative.startsWith('..' + nodePath.sep)
    || nodePath.isAbsolute(relative);
  if (outside) {
    return failure('kb.history.outside-vault', 'Refusing to touch "' + String(notePath ?? '') + '": it resolves outside the vault ' + root + '.');
  }
  return { ok: true, absolute, relative: relative.split(nodePath.sep).join('/') };
}

/** A stamp is a single path segment: no separators, no parent segments. */
function cleanStamp(stamp: string): string | null {
  const value = String(stamp ?? '').trim();
  if (value === '' || value.includes('/') || value.includes('\\') || value.includes('..')) return null;
  return value;
}

function stampFor(ms: number): string {
  return new Date(ms).toISOString().replace(/:/g, '-');
}

/** Auto stamps skip a millisecond when another copy already claims it. */
async function nextStamp(dir: string, baseMs: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stamp = stampFor(baseMs + attempt);
    if (!(await fileExists(nodePath.join(dir, stamp + ENTRY_SUFFIX)))) return stamp;
  }
  return stampFor(baseMs + 100);
}

async function readEntries(dir: string): Promise<HistoryEntry[]> {
  let dirents: Dirent[] = [];
  try {
    dirents = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = dirents
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith(ENTRY_SUFFIX))
    .map((dirent) => dirent.name);
  const found = await Promise.all(names.map(async (name): Promise<HistoryEntry | null> => {
    const path = nodePath.join(dir, name);
    try {
      const stat = await fsPromises.stat(path);
      if (!stat.isFile()) return null;
      return { stamp: name.slice(0, -ENTRY_SUFFIX.length), path, bytes: stat.size };
    } catch {
      return null;
    }
  }));
  const entries: HistoryEntry[] = [];
  for (const item of found) {
    if (item !== null) entries.push(item);
  }
  entries.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  return entries;
}

async function prune(dir: string, keep: number): Promise<void> {
  const entries = await readEntries(dir);
  for (const stale of entries.slice(keep)) {
    await fsPromises.rm(stale.path, { force: true }).catch(() => undefined);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fsPromises.stat(path);
    return true;
  } catch {
    return false;
  }
}

function failure(code: string, message: string): { ok: false; error: HistoryError } {
  return { ok: false, error: { code, message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}
