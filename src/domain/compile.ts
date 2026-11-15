/** Compile an inbox draft into a reviewable note draft.
 *
 * Everything here is deterministic: no model call, no prose interpretation.
 * The only inferred field is `type`, and the report says so, so the user can
 * correct it before the note is promoted into the vault.
 */

import {
  listOf,
  parseDraft,
  scalarOf,
  serializeDraft,
} from './frontmatter.js';
import type { FrontmatterEntries, FrontmatterValue } from './frontmatter.js';

export const DEFAULT_NOTE_TYPE = 'thought';
export const NOTE_TYPES = ['concept', 'thought', 'source-note', 'project', 'index', 'log'] as const;

export interface CompileInput {
  /** Inbox-relative path; used for the filename fallback title. */
  readonly relPath: string;
  /** Full draft text, frontmatter included. */
  readonly text: string;
  /** SHA-256 of `text`; stored so the next run can skip unchanged drafts. */
  readonly sourceHash: string;
}

export interface CompiledDraft {
  readonly title: string;
  readonly noteType: string;
  readonly typeInferred: boolean;
  readonly sources: readonly string[];
  readonly links: readonly string[];
  readonly changes: readonly string[];
  readonly content: string;
}

const H1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m;
const LINK = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const SOURCE_CN = /[（(]?来源\s*[:：]\s*([^\s，,；;）)]+)(?:\s*(?:#|p\.?|第)\s*(\d+))?/g;
const SOURCE_EN = /\bsource\s*[:：]\s*([^\s，,;；)]+)(?:\s*(?:#|page\s*|p\.?)\s*(\d+))?/gi;
const PDF_LINK = /\]\(([^)\s]+\.pdf)(?:#(?:page=)?(\d+))?\)/gi;
const FENCE = /^\s*(\x60{3,}|~{3,})/;

function fileStem(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath;
  return name.replace(/\.md$/i, '').replace(/^~+/, '').trim();
}

function cleanReference(raw: string): string | undefined {
  let value = raw.trim().replace(/^[<"'`]|[>"'`]$/g, '');
  value = value.replace(/[。，,；;、）)]+$/u, '');
  if (value === '' || value.length > 300) return undefined;
  return value;
}

function addSource(into: string[], seen: Set<string>, raw: string, page?: string): void {
  const path = cleanReference(raw);
  if (path === undefined) return;
  const key = page === undefined ? path : path + '#' + page;
  const lower = key.toLowerCase();
  if (seen.has(lower)) return;
  seen.add(lower);
  into.push(key);
}

/** Pull "来源: path#12" / "source: path p.12" / pdf links out of the prose. */
export function extractSources(body: string, seed: readonly string[] = []): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of seed) addSource(out, seen, item);
  for (const match of body.matchAll(SOURCE_CN)) addSource(out, seen, match[1] ?? '', match[2]);
  for (const match of body.matchAll(SOURCE_EN)) addSource(out, seen, match[1] ?? '', match[2]);
  for (const match of body.matchAll(PDF_LINK)) addSource(out, seen, match[1] ?? '', match[2]);
  return out;
}

/** Wikilink targets, without the alias and the section suffix. */
export function extractLinks(body: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(LINK)) {
    const target = (match[1] ?? '').trim();
    if (target === '') continue;
    const lower = target.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(target);
  }
  return out;
}

/** Collapse blank-line runs outside fenced code; keep fenced blocks untouched. */
function normaliseBody(lines: readonly string[]): { lines: string[]; collapsed: number } {
  const out: string[] = [];
  let fence: string | undefined;
  let collapsed = 0;
  let blanks = 0;
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      fence = fence === undefined ? (fenceMatch[1] ?? '') : undefined;
      out.push(line);
      blanks = 0;
      continue;
    }
    if (fence !== undefined) {
      out.push(line);
      continue;
    }
    if (line.trim() === '') {
      blanks += 1;
      if (blanks > 1) {
        collapsed += 1;
        continue;
      }
      out.push('');
      continue;
    }
    blanks = 0;
    out.push(line);
  }
  return { lines: out, collapsed };
}

export function compileDraft(input: CompileInput): CompiledDraft {
  const parsed = parseDraft(input.text);
  const existing = parsed.frontmatter;
  const body = parsed.body;
  const heading = H1.exec(body);
  const headingTitle = heading === null ? undefined : (heading[1] ?? '').trim();
  const frontTitle = scalarOf(existing, 'title');
  const title = (frontTitle !== undefined && frontTitle !== '' ? frontTitle : headingTitle) ?? fileStem(input.relPath);
  const declared = scalarOf(existing, 'type') ?? scalarOf(existing, 'kind');
  const declaredType = declared === undefined ? undefined : (NOTE_TYPES as readonly string[]).find((value) => value === declared.trim().toLowerCase());
  const noteType = declaredType ?? DEFAULT_NOTE_TYPE;
  const typeInferred = declaredType === undefined;
  const sources = extractSources(body, listOf(existing, 'sources'));
  const links = extractLinks(body);
  const changes: string[] = [];

  // Remove the leading H1; it is re-emitted from the resolved title.
  let rest = body;
  if (heading !== null && heading.index !== undefined) {
    rest = body.slice(0, heading.index) + body.slice(heading.index + heading[0].length);
  }
  const { lines: bodyLines, collapsed } = normaliseBody(rest.split(/\r?\n/));
  const trimmed = bodyLines.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '');

  if (existing === undefined) changes.push('added frontmatter');
  if (frontTitle === undefined && headingTitle !== undefined) changes.push('title from heading');
  else if (frontTitle === undefined) changes.push('title from filename');
  if (typeInferred) changes.push('type inferred as ' + DEFAULT_NOTE_TYPE);
  const knownSources = new Set(listOf(existing, 'sources').map((item) => item.toLowerCase()));
  const addedSources = sources.filter((item) => !knownSources.has(item.toLowerCase())).length;
  if (addedSources > 0) changes.push('+' + addedSources + ' source(s) from body');
  if (heading === null) changes.push('added H1');
  if (collapsed > 0) changes.push('collapsed ' + collapsed + ' blank line(s)');

  const entries: [string, FrontmatterValue][] = [];
  entries.push(['title', title]);
  entries.push(['type', noteType]);
  if (sources.length > 0) entries.push(['sources', sources]);
  if (existing !== undefined) {
    for (const [key, value] of existing) {
      const lower = key.toLowerCase();
      if (lower === 'title' || lower === 'type' || lower === 'sources' || lower === 'compiledhash' || lower === 'kind') continue;
      entries.push([key, value]);
    }
  }
  entries.push(['compiledHash', input.sourceHash]);

  const content = serializeDraft(entries, '# ' + title + '\n\n' + trimmed);
  return { title, noteType, typeInferred, sources, links, changes, content };
}

/** Read the compiledHash out of an existing compiled draft. */
export function compiledHashOf(content: string): string | undefined {
  return scalarOf(parseDraft(content).frontmatter, 'compiledHash');
}
