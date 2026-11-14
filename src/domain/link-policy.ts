import type { Note } from './note.js';
import { isDefinitionPage, isThoughtPage } from './note.js';
import type { Result } from '../shared/result.js';
import { err, ok } from '../shared/result.js';
import type { DomainError } from '../shared/result.js';
import { DomainError as E } from '../shared/result.js';

/**
 * Why a link exists. There are exactly three admissible reasons; anything else is decoration.
 *  1. first-occurrence: this is where the concept first appears for the reader.
 *  2. refinement: the note corrects, narrows, or contradicts the definition.
 *  3. new-application: the note applies the concept somewhere the definition does not cover.
 */
export type LinkReason = 'first-occurrence' | 'refinement' | 'new-application';

export interface LinkProposal {
  readonly fromPath: string;
  readonly toPath: string;
  readonly reason: LinkReason;
  /** The relationship in one sentence. A link whose why cannot be written does not get created. */
  readonly why: string;
}

const REASONS: readonly LinkReason[] = ['first-occurrence', 'refinement', 'new-application'];

/** Filler that carries no relationship. Rejected on purpose: it is what makes a graph useless. */
const EMPTY_WHY = ['相关', '参考', '参见', '详见', '有关', 'see also', 'related', 'reference'];

export function isLinkReason(v: unknown): v is LinkReason {
  return typeof v === 'string' && (REASONS as readonly string[]).includes(v);
}

export interface LinkPolicyInput {
  readonly from: Note;
  readonly to: Note;
  readonly proposal: LinkProposal;
  /** true when the source note already links to the target. */
  readonly alreadyLinked: boolean;
}

export type LinkRejection =
  | 'link.self'
  | 'link.reason'
  | 'link.why-missing'
  | 'link.why-empty'
  | 'link.duplicate'
  | 'link.direction'
  | 'link.target-not-definition'
  | 'link.source-not-thought';

export function judgeLink(input: LinkPolicyInput): Result<LinkProposal, DomainError> {
  const { from, to, proposal, alreadyLinked } = input;

  if (from.path === to.path) return err(new E('link.self', 'a note cannot link to itself'));

  if (!isLinkReason(proposal.reason)) {
    return err(new E('link.reason', 'reason must be one of: ' + REASONS.join(', ')));
  }

  // Only thought -> fact-source. Directory/index pages and concept-to-concept webs stay manual.
  if (!isThoughtPage(from)) {
    return err(new E('link.source-not-thought', 'only a thought note can propose an outbound link, got kind=' + from.frontmatter.kind));
  }
  if (!isDefinitionPage(to) && to.frontmatter.kind !== 'source-note') {
    return err(new E('link.target-not-definition', 'target must be a concept definition or a source note, got kind=' + to.frontmatter.kind));
  }

  if (alreadyLinked) return err(new E('link.duplicate', 'the note already links to ' + to.path));

  const why = proposal.why.trim();
  if (why === '') return err(new E('link.why-empty', 'why must state the relationship, not be empty'));
  const plain = why.toLowerCase().replace(/[\s。，,.;；:：!！?？]/g, '');
  if (EMPTY_WHY.some((w) => plain === w.toLowerCase().replace(/\s/g, ''))) {
    return err(new E('link.why-empty', 'why is filler and states no relationship: ' + why));
  }
  if (why.length < 6) {
    return err(new E('link.why-empty', 'why is too short to be usable: ' + why));
  }

  return ok({ ...proposal, why });
}

/**
 * Hard boundary: the policy only ever answers. It never writes a wikilink.
 * Writing is a separate, explicit user action (kb_promote / manual edit).
 */
export const LINKS_ARE_PROPOSED_NOT_WRITTEN = true;
