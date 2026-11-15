/** Minimal YAML frontmatter reader/writer for drafts.
 *
 * It understands only the subset the vault already uses: scalar lines and
 * dash lists. Unknown keys and their raw values are preserved byte-for-byte,
 * because a draft may carry fields this plugin does not own.
 */

export type FrontmatterValue = string | readonly string[];
export type FrontmatterEntry = readonly [string, FrontmatterValue];
export type FrontmatterEntries = readonly FrontmatterEntry[];

export interface ParsedDraft {
  /** Undefined when the text has no leading YAML block at all. */
  readonly frontmatter: FrontmatterEntries | undefined;
  readonly body: string;
}

const OPEN = /^\uFEFF?[ \t]*---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*(?:\r?\n|$)/;
const KEY_LINE = /^([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)[ \t]*:[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]+-[ \t]+(.*)$/;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Read the leading YAML block. Anything after the closing fence is the body. */
export function parseDraft(text: string): ParsedDraft {
  const open = OPEN.exec(text);
  if (open === null) return { frontmatter: undefined, body: text };
  const rest = text.slice(open[0].length);
  const lines = rest.split(/\r?\n/);
  const entries: [string, FrontmatterValue][] = [];
  let current: { key: string; list: string[] } | undefined;
  let consumed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (CLOSE.test(line)) {
      consumed = index + 1;
      break;
    }
    const key = KEY_LINE.exec(line);
    if (key !== null) {
      const name = key[1];
      if (name === undefined) continue;
      const raw = key[2] ?? '';
      if (raw.trim() === '') {
        current = { key: name, list: [] };
        entries.push([name, current.list]);
      } else {
        current = undefined;
        entries.push([name, stripQuotes(raw)]);
      }
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null && current !== undefined) {
      current.list.push(stripQuotes(item[1] ?? ''));
    }
  }
  if (consumed === 0) return { frontmatter: undefined, body: text };
  return { frontmatter: entries, body: lines.slice(consumed).join('\n') };
}

export function scalarOf(entries: FrontmatterEntries | undefined, key: string): string | undefined {
  if (entries === undefined) return undefined;
  for (const [name, value] of entries) {
    if (name.toLowerCase() !== key.toLowerCase()) continue;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

export function listOf(entries: FrontmatterEntries | undefined, key: string): readonly string[] {
  if (entries === undefined) return [];
  for (const [name, value] of entries) {
    if (name.toLowerCase() !== key.toLowerCase()) continue;
    return typeof value === 'string' ? (value === '' ? [] : [value]) : value;
  }
  return [];
}

function formatScalar(value: string): string {
  if (value === '' || /^[\s:#\-\[\]{}&*!|>'"%@`]|[:#]\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

/** Serialize entries back into a fenced block plus the body. */
export function serializeDraft(entries: FrontmatterEntries, body: string): string {
  const lines: string[] = ['---'];
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      lines.push(key + ':');
      for (const item of value) lines.push('  - ' + formatScalar(item));
      continue;
    }
    lines.push(key + ': ' + formatScalar(value));
  }
  lines.push('---', '');
  const trimmed = body.replace(/^\s*\n/, '').replace(/\s+$/, '');
  return lines.join('\n') + trimmed + (trimmed === '' ? '' : '\n');
}
