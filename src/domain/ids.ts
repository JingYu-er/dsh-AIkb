import { DomainError } from '../shared/result.js';

/** Path relative to the vault root, POSIX separators, never absolute, never escaping the root. */
export type VaultRelPath = string & { readonly __vaultPath: unique symbol };

const DRIVE = /^[A-Za-z]:[\\/]/;
const TRAVERSAL = /(^|\/)\.\.(\/|$)/;

export function vaultRelPath(input: string): VaultRelPath {
  const normalized = input.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.trim() === '') throw new DomainError('path.empty', 'path must not be empty');
  if (normalized.startsWith('/')) throw new DomainError('path.absolute', 'path must be relative to the vault root: ' + normalized);
  if (DRIVE.test(normalized)) throw new DomainError('path.absolute', 'path must be relative to the vault root: ' + normalized);
  if (TRAVERSAL.test(normalized)) throw new DomainError('path.traversal', 'path must not escape the vault root: ' + normalized);
  return normalized as VaultRelPath;
}

/** Lowercase hex sha-256, the only content identity the compiler trusts. */
export type Sha256 = string & { readonly __sha256: unique symbol };

export function sha256FromHex(hex: string): Sha256 {
  const normalized = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new DomainError('hash.invalid', 'not a sha-256 hex digest: ' + hex);
  return normalized as Sha256;
}

/** Stable, prefixed surrogate ids (deterministic from content, so re-ingest is idempotent). */
export type ChunkId = string & { readonly __chunkId: unique symbol };
export type SourceId = string & { readonly __sourceId: unique symbol };

export function sourceIdOf(sha: Sha256): SourceId {
  return ('src_' + sha.slice(0, 16)) as SourceId;
}

export function chunkIdOf(source: SourceId, ordinal: number): ChunkId {
  return (source + '_c' + String(ordinal).padStart(5, '0')) as ChunkId;
}
