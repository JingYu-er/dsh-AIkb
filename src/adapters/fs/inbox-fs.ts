import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CompileFs } from '../../application/kb-compile.js';

const SKIP_DIRECTORIES = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.kb', '.stfolder', '.stversions']);

function denied(message: string): Error {
  return Object.assign(new Error(message), { code: 'vault.write-denied' });
}

/** File access limited to <vault>/inbox, the only area drafts may write to. */
export class NodeInboxFs implements CompileFs {
  private readonly inboxRoot: string;

  constructor(vaultRoot: string) {
    this.inboxRoot = path.join(vaultRoot, 'inbox');
  }

  async listDrafts(): Promise<readonly string[]> {
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
          if (SKIP_DIRECTORIES.has(entry.name)) continue;
          await walk(path.join(absolute, entry.name), prefix + entry.name + '/');
          continue;
        }
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        out.push(prefix + entry.name);
      }
    };
    await walk(this.inboxRoot, '');
    out.sort();
    return out;
  }

  async readText(relPath: string): Promise<string> {
    return fs.readFile(this.resolve(relPath), 'utf8');
  }

  async writeText(relPath: string, content: string): Promise<void> {
    const target = this.resolve(relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relPath));
      return true;
    } catch {
      return false;
    }
  }

  private resolve(relPath: string): string {
    const normalised = relPath.replace(/\\/g, '/');
    if (normalised === '' || path.isAbsolute(normalised) || normalised.split('/').includes('..')) {
      throw denied('draft path escapes the inbox: ' + relPath);
    }
    const absolute = path.join(this.inboxRoot, normalised);
    const relative = path.relative(this.inboxRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw denied('draft path escapes the inbox: ' + relPath);
    }
    return absolute;
  }
}
