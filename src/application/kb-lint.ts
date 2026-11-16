/** Read-only checks over the markdown notes of a vault. */

import type { SchemaNoteType } from '../domain/kb-schema.js';
import { isSpecialNote, normaliseSchemaType } from '../domain/kb-schema.js';

export interface LintEntry {
  readonly relPath: string;
}

export interface LintFs {
  listFiles(): Promise<readonly LintEntry[]>;
  readText(relPath: string): Promise<string>;
}

export type LintSeverity = 'error' | 'warn' | 'info';

export interface LintFinding {
  readonly rule: string;
  readonly severity: LintSeverity;
  readonly path: string;
  readonly detail: string;
}

export interface LintReport {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly notes: number;
  readonly findings: readonly LintFinding[];
  readonly counts: Record<string, number>;
  readonly elapsedMs: number;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const LINK = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const KEY_LINE = /^([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)\s*:\s*(.*)$/;
const ATTACHMENT = /\.(png|jpe?g|gif|webp|svg|pdf|mp4|canvas|excalidraw|base)$/i;
/** Plugin/skill folders that ship example markdown; they are not knowledge notes. */
const SKIP_PREFIX = /^(copilot|\.agents|\.claude|\.wiki|砖块)\//i;
/** Raw conversation records keep their original links; auditing them against today's rules is noise. */
const SKIP_FILES = new Set(['最初的会话.md']);
/** Compiled drafts in inbox are machine copies; their source draft is the note to lint. */
const COMPILED_PREFIX = /^inbox\/_compiled\//i;
/** Template folders hold Templater placeholders, not real notes. */
const TEMPLATE_PREFIX = /(^|\/)(ZtTemplates|Templater|Templates)\//i;
/** Generated artifacts and drawing sidecars are not notes. */
const GENERATED = /^(index|log)\.md$/i;
const DRAWING = /\.excalidraw\.md$/i;
/** Link queues are review scaffolding, not notes. */
const QUEUE_PREFIX = /^inbox\/links\//i;
const FENCED = /~~~[\s\S]*?~~~|```[\s\S]*?```/g;
const ASSOCIATION = /^##[ \t]+关联[ \t]*$/m;
const NEXT_HEADING = /^#{1,2}[ \t]+/m;
const ASSOCIATION_ITEM = /^\s*[-*]\s+.*\[\[/;
const HAS_WHY = /—\s*\S/;

const MAX_PER_RULE = 50;
const MAX_OUTLINKS = 30;

function basenameOf(relPath: string): string {
  const file = relPath.split('/').pop() ?? relPath;
  return file.replace(/\.md$/i, '');
}

function normalise(name: string): string {
  return name.trim().toLowerCase();
}

function frontmatterOf(text: string): Record<string, string> | undefined {
  const match = FRONTMATTER.exec(text);
  if (match === null) return undefined;
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const field = KEY_LINE.exec(line);
    if (field === null) continue;
    const key = field[1];
    if (key === undefined) continue;
    fields[key.toLowerCase()] = (field[2] ?? '').trim();
  }
  return fields;
}

function linksOf(text: string): string[] {
  const out: string[] = [];
  // Code blocks show wikilink syntax as examples (模板笔记、skill 文档), never as real links.
  for (const match of text.replace(FENCED, '').matchAll(LINK)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const target = (raw.replace(/^\.\//, '').split('/').pop() ?? raw).replace(/\.md$/i, '');
    if (ATTACHMENT.test(target)) continue;
    out.push(normalise(target));
  }
  return out;
}

/** The '## 关联' section body, or '' when the note has none. */
function associationSection(text: string): string {
  const normalised = text.replace(/\r\n/g, '\n');
  const match = ASSOCIATION.exec(normalised);
  if (match === null) return '';
  const start = (match.index ?? 0) + match[0].length;
  const rest = normalised.slice(start);
  const next = NEXT_HEADING.exec(rest);
  const end = next === null ? normalised.length : start + (next.index ?? 0);
  return normalised.slice(start, end);
}

function pushFinding(findings: LintFinding[], counted: Record<string, number>, finding: LintFinding): void {
  counted[finding.rule] = (counted[finding.rule] ?? 0) + 1;
  if ((counted[finding.rule] ?? 0) <= MAX_PER_RULE) findings.push(finding);
}

interface NoteRecord {
  readonly path: string;
  readonly text: string;
  readonly type: SchemaNoteType;
  readonly links: readonly string[];
}

export async function runLint(fs: LintFs, vaultRoot: string): Promise<LintReport> {
  const started = Date.now();
  const notes = (await fs.listFiles()).filter(
    (entry) =>
      /\.md$/i.test(entry.relPath) &&
      !SKIP_PREFIX.test(entry.relPath) &&
      !SKIP_FILES.has(entry.relPath) &&
      !COMPILED_PREFIX.test(entry.relPath) &&
      !QUEUE_PREFIX.test(entry.relPath) &&
      !TEMPLATE_PREFIX.test(entry.relPath) &&
      !GENERATED.test(entry.relPath) &&
      !DRAWING.test(entry.relPath),
  );
  const byName = new Map<string, string[]>();
  for (const note of notes) {
    const key = normalise(basenameOf(note.relPath));
    const list = byName.get(key);
    if (list === undefined) byName.set(key, [note.relPath]);
    else list.push(note.relPath);
  }
  const findings: LintFinding[] = [];
  const counts: Record<string, number> = { notes: notes.length };
  const inboundByName = new Map<string, number>();
  const inboundByPath = new Map<string, number>();
  const records: NoteRecord[] = [];
  for (const note of notes) {
    let text = '';
    try {
      text = await fs.readText(note.relPath);
    } catch {
      continue;
    }
    const fields = frontmatterOf(text);
    const rawType = fields?.type ?? fields?.['\u7c7b\u578b'] ?? '';
    const type = normaliseSchemaType(rawType);
    if (fields === undefined) {
      pushFinding(findings, counts, { rule: 'frontmatter.missing', severity: 'info', path: note.relPath, detail: 'no YAML frontmatter block' });
    } else if (rawType === '') {
      pushFinding(findings, counts, { rule: 'frontmatter.type', severity: 'info', path: note.relPath, detail: 'frontmatter has no type field' });
    }
    const links = linksOf(text);
    records.push({ path: note.relPath, text, type, links });
    for (const target of links) {
      inboundByName.set(target, (inboundByName.get(target) ?? 0) + 1);
      const hit = byName.get(target);
      if (hit === undefined) {
        pushFinding(findings, counts, { rule: 'link.broken', severity: 'warn', path: note.relPath, detail: 'no note named "' + target + '"' });
        continue;
      }
      for (const path of hit) inboundByPath.set(path, (inboundByPath.get(path) ?? 0) + 1);
    }
  }
  const typeByPath = new Map(records.map((record) => [record.path, record.type]));

  for (const [name, paths] of byName) {
    // An inbox draft intentionally mirrors the promoted note: same title is not a collision.
    const real = paths.filter((path) => !path.startsWith('inbox/'));
    if (real.length < 2) continue;
    for (const path of real.slice(1)) {
      pushFinding(findings, counts, { rule: 'title.duplicate', severity: 'warn', path, detail: 'another note is also named "' + name + '"' });
    }
  }
  for (const record of records) {
    if (record.type !== 'concept') continue;
    if ((inboundByName.get(normalise(basenameOf(record.path))) ?? 0) > 0) continue;
    pushFinding(findings, counts, { rule: 'concept.orphan', severity: 'warn', path: record.path, detail: 'concept page has no inbound wikilink' });
  }

  // Link discipline (SCHEMA): every link carries a reason and points in the allowed direction.
  for (const record of records) {
    if (record.links.length > MAX_OUTLINKS) {
      pushFinding(findings, counts, { rule: 'link-flood', severity: 'warn', path: record.path, detail: 'outlinks=' + record.links.length + ' (>' + MAX_OUTLINKS + ')' });
    }
    if (record.type === 'link') continue;
    for (const line of associationSection(record.text).split('\n')) {
      if (!ASSOCIATION_ITEM.test(line)) continue;
      if (HAS_WHY.test(line)) continue;
      const link = /\[\[([^\]|#]+)/.exec(line);
      pushFinding(findings, counts, {
        rule: 'link-missing-why',
        severity: 'warn',
        path: record.path,
        detail: '关联条目缺少 why：[[ ' + (link?.[1] ?? line.trim()) + ' ]]',
      });
    }
    const seen = new Set<string>();
    for (const target of record.links) {
      if (seen.has(target)) continue;
      seen.add(target);
      const toTypes = (byName.get(target) ?? []).map((path) => typeByPath.get(path) ?? 'unknown');
      for (const toType of toTypes) {
        if (record.type === 'source' && toType === 'source') {
          pushFinding(findings, counts, { rule: 'link-wrong-direction', severity: 'warn', path: record.path, detail: 'source→source 不允许：[[ ' + target + ' ]]' });
        } else if (record.type === 'thought' && toType === 'thought') {
          pushFinding(findings, counts, { rule: 'link-wrong-direction', severity: 'warn', path: record.path, detail: 'thought→thought 需说明判断关系：[[ ' + target + ' ]]' });
        }
      }
    }
    if (!isSpecialNote(record.path) && record.type !== 'moc' && !/^inbox\//i.test(record.path) && (inboundByPath.get(record.path) ?? 0) === 0) {
      pushFinding(findings, counts, { rule: 'orphan', severity: 'warn', path: record.path, detail: 'note has no inbound wikilink' });
    }
  }
  return { ok: true, vaultRoot, notes: notes.length, findings, counts, elapsedMs: Date.now() - started };
}
