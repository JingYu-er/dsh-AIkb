import type { Note, NoteKind, Mastery } from '../../src/domain/note.js';
import { vaultRelPath } from '../../src/domain/ids.js';

export function note(args: {
  path: string;
  kind?: NoteKind;
  mastery?: Mastery;
  title?: string;
  body?: string;
}): Note {
  return {
    path: vaultRelPath(args.path),
    title: args.title ?? args.path,
    frontmatter: { kind: args.kind ?? 'unknown', mastery: args.mastery ?? 'unknown', tags: [], extra: {} },
    body: args.body ?? '',
  };
}
