import type { VaultRelPath } from './ids.js';

/**
 * Note type is an explicit marker in frontmatter. It is never inferred from prose,
 * because a wrong type silently corrupts the link graph.
 */
export type NoteKind = 'concept' | 'thought' | 'source-note' | 'project' | 'index' | 'log' | 'unknown';

/**
 * Mastery is only ever what the user declared, or what a passed quiz proved.
 * "The AI stopped explaining this" is not evidence of mastery.
 */
export type Mastery = 'solid' | 'learning' | 'unknown';

export interface NoteFrontmatter {
  readonly title?: string;
  readonly kind?: NoteKind;
  readonly mastery?: Mastery;
  readonly tags: readonly string[];
  readonly source?: string;
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface Note {
  readonly path: VaultRelPath;
  readonly title: string;
  readonly frontmatter: NoteFrontmatter;
  readonly body: string;
  readonly updatedAt?: string;
}

const KINDS: readonly NoteKind[] = ['concept', 'thought', 'source-note', 'project', 'index', 'log'];
const MASTERIES: readonly Mastery[] = ['solid', 'learning'];

export function parseNoteKind(raw: unknown): NoteKind {
  if (typeof raw !== 'string') return 'unknown';
  const v = raw.trim().toLowerCase();
  return (KINDS as readonly string[]).includes(v) ? (v as NoteKind) : 'unknown';
}

export function parseMastery(raw: unknown): Mastery {
  if (typeof raw !== 'string') return 'unknown';
  const v = raw.trim().toLowerCase();
  return (MASTERIES as readonly string[]).includes(v) ? (v as Mastery) : 'unknown';
}

/** Definition pages are the hub of the graph: many inbound links, few outbound. */
export function isDefinitionPage(note: Note): boolean {
  return note.frontmatter.kind === 'concept';
}

export function isThoughtPage(note: Note): boolean {
  return note.frontmatter.kind === 'thought';
}
