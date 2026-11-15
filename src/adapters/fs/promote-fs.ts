import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PromoteFs } from '../../application/kb-promote.js';

function denied(message: string): Error {
  return Object.assign(new Error(message), { code: 'vault.write-denied' });
}

/** Reads the whole vault, writes only inside the configured promote folder. */
export class NodePromoteFs implements PromoteFs {
  private readonly root: string;
  private readonly target: string;

  constructor(vaultRoot: string, promoteDir: string) {
    this.root = path.resolve(vaultRoot);
    this.target = path.resolve(this.root, promoteDir);
  }

  async listCompiled(): Promise<readonly string[]> {
    const base = path.join(this.root, 'inbox', '_compiled');
    const out: string[] = [];
    const walk = async (absolute: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          await walk(path.join(absolute, entry.name), prefix + entry.name + '/');
          continue;
        }
        if (entry.isFile() && /\.md$/i.test(entry.name)) out.push('inbox/_compiled/' + prefix + entry.name);
      }
    };
    await walk(base, '');
    out.sort();
    return out;
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(this.readPath(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async readText(relPath: string): Promise<string> {
    return fs.readFile(this.readPath(relPath), 'utf8');
  }

  async writeText(relPath: string, content: string): Promise<void> {
    const absolute = this.writePath(relPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }

  private readPath(relPath: string): string {
    const normalised = relPath.replace(/\\/g, '/');
    if (normalised === '' || path.isAbsolute(normalised) || normalised.split('/').includes('..')) {
      throw denied('path escapes the vault: ' + relPath);
    }
    return path.join(this.root, normalised);
  }

  private writePath(relPath: string): string {
    const normalised = relPath.replace(/\\/g, '/');
    if (normalised === '' || path.isAbsolute(normalised) || normalised.split('/').includes('..')) {
      throw denied('path escapes the vault: ' + relPath);
    }
    const absolute = path.join(this.root, normalised);
    const relative = path.relative(this.target, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw denied('write outside ' + this.target + ': ' + relPath);
    }
    return absolute;
  }
}
