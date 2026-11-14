import { createHash } from 'node:crypto';
import { createReadStream, promises as fsPromises } from 'node:fs';
import * as nodePath from 'node:path';
import type { DoctorEntry, DoctorVaultFs } from '../../application/kb-doctor.js';

/** Directories whose contents are never part of the knowledge base. */
const SKIP_DIRECTORIES = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.kb', '.stfolder']);

/** Node adapter for the read-only vault view. Writes are deliberately absent. */
export class NodeVaultFs implements DoctorVaultFs {
  readonly root: string;

  constructor(root: string) {
    this.root = nodePath.resolve(root);
  }

  absolute(relPath: string): string {
    return nodePath.join(this.root, relPath.split('/').join(nodePath.sep));
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fsPromises.access(this.absolute(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(): Promise<readonly DoctorEntry[]> {
    const out: DoctorEntry[] = [];
    await this.walk('', out);
    return out;
  }

  async sha256File(relPath: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(this.absolute(relPath));
      stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    return hash.digest('hex');
  }

  async versionControl(): Promise<'vault' | 'ancestor' | undefined> {
    if (await this.exists('.git')) return 'vault';
    let current = nodePath.dirname(this.root);
    for (let depth = 0; depth < 6; depth += 1) {
      if (await pathExists(nodePath.join(current, '.git'))) return 'ancestor';
      const parent = nodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  }

  private async walk(relDir: string, out: DoctorEntry[]): Promise<void> {
    const absoluteDir = relDir === '' ? this.root : this.absolute(relDir);
    let entries;
    try {
      entries = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : relDir + '/' + entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
        await this.walk(relPath, out);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fsPromises.stat(nodePath.join(absoluteDir, entry.name));
        out.push({ relPath, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
      } catch {
        continue;
      }
    }
  }

  async readText(relPath: string): Promise<string> {
    return fsPromises.readFile(this.absolute(relPath), 'utf8');
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fsPromises.access(value);
    return true;
  } catch {
    return false;
  }
}
