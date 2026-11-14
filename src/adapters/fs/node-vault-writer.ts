import { promises as fsPromises } from 'node:fs';
import * as nodePath from 'node:path';
import { isWritableTarget, openVault } from '../../domain/vault.js';
import { vaultRelPath } from '../../domain/ids.js';
import type { InventoryWriter } from '../../application/kb-inventory.js';
import { DomainError } from '../../shared/result.js';

/** Writes only where the domain allows: inbox/ and .wiki/, never a user note. */
export class NodeVaultWriter implements InventoryWriter {
  readonly root: string;

  constructor(root: string) {
    this.root = nodePath.resolve(root);
  }

  async writeText(relPath: string, content: string): Promise<number> {
    const layout = openVault(this.root);
    const rel = vaultRelPath(relPath);
    if (!isWritableTarget(layout, rel)) {
      throw new DomainError('vault.write-denied', 'refusing to write outside inbox/ and .wiki/: ' + rel);
    }
    const absolute = nodePath.join(this.root, rel.split('/').join(nodePath.sep));
    await fsPromises.mkdir(nodePath.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content, 'utf8');
    return Buffer.byteLength(content, 'utf8');
  }
}
