import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { IndexEntry, IndexFs } from '../../application/kb-index.js';

/** Directories never walked and never written. */
const READ_ONLY_DIRS = new Set(['.obsidian', '.git', '.trash', '.kb', 'node_modules', '.stfolder', '.stversions']);
/** Template trees hold code, not notes. */
const SKIP_DIRS = new Set(['node_modules', '.kb', '.stfolder', '.stversions', 'ZtTemplates', 'Templater', 'Templates']);
/** The compiled index cache is machine state; the compile layer must not rewrite it. */
const WRITE_DENY = ['.obsidian/', '.git/', '.trash/', '.kb/', 'node_modules/', '.wiki/index/'];

function denied(message: string): Error {
  return Object.assign(new Error(message), { code: 'vault.write-denied' });
}

/** Vault-wide markdown access for the compile layer: reads every note, writes catalogs and notes. */
export class NodeNotesFs implements IndexFs {
  constructor(private readonly root: string) {}

  async listFiles(): Promise<readonly IndexEntry[]> {
    const out: IndexEntry[] = [];
    const walk = async (absolute: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fsp.readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
          await walk(path.join(absolute, entry.name), prefix + entry.name + '/');
          continue;
        }
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        let modifiedMs = 0;
        try {
          modifiedMs = (await fsp.stat(path.join(absolute, entry.name))).mtimeMs;
        } catch {
          modifiedMs = 0;
        }
        out.push({ relPath: prefix + entry.name, modifiedMs });
      }
    };
    await walk(this.root, '');
    out.sort((left, right) => left.relPath.localeCompare(right.relPath));
    return out;
  }

  async readText(relPath: string): Promise<string> {
    return fsp.readFile(this.resolve(relPath, false), 'utf8');
  }

  async writeText(relPath: string, content: string): Promise<void> {
    const target = this.resolve(relPath, true);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }

  async remove(relPath: string): Promise<void> {
    await fsp.rm(this.resolve(relPath, true), { force: true });
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fsp.access(this.resolve(relPath, false));
      return true;
    } catch {
      return false;
    }
  }

  private resolve(relPath: string, write: boolean): string {
    const normalised = relPath.replace(/\\/g, '/');
    if (normalised.trim() === '' || path.isAbsolute(normalised) || normalised.split('/').includes('..')) {
      throw denied('path escapes the vault: ' + relPath);
    }
    const absolute = path.resolve(this.root, normalised);
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw denied('path escapes the vault: ' + relPath);
    }
    const first = (normalised.split('/')[0] ?? '').toLowerCase();
    if (READ_ONLY_DIRS.has(first)) throw denied('refusing to touch ' + relPath + ' (' + first + ' is read-only)');
    if (write) {
      const lower = normalised.toLowerCase();
      for (const prefix of WRITE_DENY) {
        if (lower === prefix.replace(/\/$/, '') || lower.startsWith(prefix)) {
          throw denied('refusing to write ' + relPath + ' (' + prefix + ' is machine state)');
        }
      }
    }
    return absolute;
  }
}
