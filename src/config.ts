import type { VaultLayout } from './domain/vault.js';
import { openVault } from './domain/vault.js';
import type { Result } from './shared/result.js';
import { err, ok } from './shared/result.js';
import { DomainError } from './shared/result.js';

export type RetrievalMode = 'hybrid' | 'bm25' | 'vector';

export interface KbLimits {
  /** Hard ceiling on snippets returned by one kb_query. */
  readonly maxSnippets: number;
  /** Soft ceiling on the answer budget, in estimated tokens. */
  readonly maxAnswerTokens: number;
  /** How many scanned pages one compile may OCR before it must ask. */
  readonly ocrPageBudget: number;
}

export interface KbConfig {
  readonly vault: VaultLayout;
  readonly retrieval: { readonly mode: RetrievalMode; readonly k: number };
  readonly limits: KbLimits;
  readonly guards: {
    /** Writes are opt-in; the default build is read-only. */
    readonly allowWrites: boolean;
    /** Links are never auto-inserted; this must stay false for the shipped profile. */
    readonly autoInsertLinks: false;
  };
}

export const DEFAULT_LIMITS: KbLimits = { maxSnippets: 12, maxAnswerTokens: 4000, ocrPageBudget: 20 };

/**
 * Vault discovery is deliberately strict: an explicit path wins, several discovered vaults are an error.
 * Picking "the first one" is how an AI writes into the wrong knowledge base.
 */
export function resolveVaultRoot(input: {
  readonly explicitPath?: string;
  readonly candidates: readonly string[];
}): Result<string, DomainError> {
  const explicit = input.explicitPath?.trim();
  if (explicit !== undefined && explicit !== '') return ok(explicit);

  const unique = [...new Set(input.candidates.map((c) => c.trim()).filter((c) => c !== ''))];
  if (unique.length === 0) {
    return err(new DomainError('vault.not-found', 'no Obsidian vault found; set kb.vaultPath in the plugin config'));
  }
  if (unique.length > 1) {
    return err(new DomainError('vault.ambiguous', 'several vaults found, set kb.vaultPath explicitly: ' + unique.join(', ')));
  }
  return ok(unique[0] as string);
}

export function buildConfig(input: {
  readonly vaultRoot: string;
  readonly mode?: RetrievalMode;
  readonly k?: number;
  readonly limits?: Partial<KbLimits>;
  readonly allowWrites?: boolean;
}): KbConfig {
  return {
    vault: openVault(input.vaultRoot),
    retrieval: { mode: input.mode ?? 'hybrid', k: input.k ?? 8 },
    limits: { ...DEFAULT_LIMITS, ...input.limits },
    guards: { allowWrites: input.allowWrites ?? false, autoInsertLinks: false },
  };
}
