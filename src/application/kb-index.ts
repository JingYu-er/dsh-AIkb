/** Deterministic vault catalog: scan notes, count inbound/outbound links, render index.md. */

import { listOf, parseDraft, scalarOf } from '../domain/frontmatter.js';
import type { SchemaNoteType } from '../domain/kb-schema.js';
import { SCHEMA_TYPES, SCHEMA_TYPE_LABEL, isSpecialNote, normaliseSchemaType } from '../domain/kb-schema.js';
import { appendLogSafe } from './kb-log.js';

export interface IndexEntry {
  readonly relPath: string;
  /** mtime in ms; 0 when the backend does not expose it. */
  readonly modifiedMs?: number;
}

export interface IndexFs {
  listFiles(): Promise<readonly IndexEntry[]>;
  readText(relPath: string): Promise<string>;
  writeText(relPath: string, content: string): Promise<void>;
}

export interface IndexNote {
  readonly path: string;
  readonly title: string;
  /** SCHEMA bucket; notes under inbox/ are always draft. */
  readonly type: SchemaNoteType;
  readonly declaredType: string;
  readonly tags: readonly string[];
  readonly status: string;
  readonly inbound: number;
  readonly outbound: number;
  readonly outLinks: readonly string[];
  readonly modifiedMs: number;
  readonly inbox: boolean;
  /** No usable type field (inbox drafts are not counted). */
  readonly untyped: boolean;
  readonly orphan: boolean;
}

export interface BrokenLink {
  readonly from: string;
  readonly target: string;
}

export interface IndexStats {
  readonly notes: number;
  readonly byType: Readonly<Record<SchemaNoteType, number>>;
  readonly orphans: number;
  readonly brokenLinks: number;
  readonly untyped: number;
  readonly inbox: number;
}

export interface ScanResult {
  readonly notes: readonly IndexNote[];
  readonly broken: readonly BrokenLink[];
  readonly stats: IndexStats;
  readonly byName: ReadonlyMap<string, readonly IndexNote[]>;
}

export interface IndexReport {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly written: boolean;
  readonly index: string;
  readonly stats: IndexStats;
  /** First PREVIEW_LIMIT characters of the index; the file gets the full text. */
  readonly preview: string;
  readonly warnings: readonly string[];
  readonly elapsedMs: number;
}

export const INDEX_FILE = 'index.md';
const PREVIEW_LIMIT = 4000;
const MAX_BROKEN_LISTED = 20;

const LINK = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const FENCED = /~~~[\s\S]*?~~~|```[\s\S]*?```/g;
const ATTACHMENT = /\.(png|jpe?g|gif|webp|svg|pdf|mp4|canvas|excalidraw|base)$/i;
const DRAWING = /\.excalidraw\.md$/i;
const SKIP_PREFIXES = [/^inbox\/_compiled\//i, /^inbox\/links\//i, /^inbox\/review\//i, /^(copilot|\.agents|\.claude|\.wiki)\//i];
const TEMPLATE_PREFIX = /(^|\/)(ZtTemplates|Templater|Templates)\//i;
const KNOWN_EXTRAS = new Set(['index', 'log', 'schema']);

/** [[folder/Note#anchor|alias]] -> "note"; attachments and anchors are handled by callers. */
export function normaliseLinkTarget(raw: string): string {
  const withoutAlias = raw.split('|')[0] ?? raw;
  const withoutAnchor = (withoutAlias.split('#')[0] ?? withoutAlias).replace(/^\.\//, '').trim();
  const last = withoutAnchor.split('/').pop() ?? withoutAnchor;
  return last.replace(/\.md$/i, '').trim().toLowerCase();
}

/** SCHEMA orphan rule: no inbound link, and not index/log/SCHEMA/moc. Drafts are pre-link. */
export function isOrphanEligible(note: Pick<IndexNote, 'path' | 'type' | 'inbox'>): boolean {
  if (note.inbox) return false;
  if (note.type === 'moc') return false;
  return !isSpecialNote(note.path);
}

function baseNameOf(relPath: string): string {
  return (relPath.split('/').pop() ?? relPath).replace(/\.md$/i, '').toLowerCase();
}

function safeAlias(title: string): string {
  const cleaned = title.replace(/\|/g, '／').replace(/[\[\]]/g, '').trim();
  return cleaned === '' ? 'untitled' : cleaned;
}

function wikilink(note: IndexNote): string {
  return '[[' + note.path + '|' + safeAlias(note.title) + ']]';
}

function stamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function byInbound(notes: readonly IndexNote[]): IndexNote[] {
  return [...notes].sort((left, right) => right.inbound - left.inbound || left.path.localeCompare(right.path));
}

interface RawNote {
  readonly path: string;
  readonly title: string;
  readonly type: SchemaNoteType;
  readonly declaredType: string;
  readonly tags: readonly string[];
  readonly status: string;
  readonly modifiedMs: number;
  readonly inbox: boolean;
  readonly untyped: boolean;
  readonly links: readonly string[];
}

/** Read every markdown note worth indexing once and derive the graph. */
export async function scanVault(fs: IndexFs, vaultRoot: string): Promise<ScanResult> {
  const entries = (await fs.listFiles()).filter((entry) => {
    const rel = entry.relPath.replace(/\\/g, '/');
    if (!/\.md$/i.test(rel)) return false;
    if (isSpecialNote(rel)) return false;
    if (DRAWING.test(rel)) return false;
    if (SKIP_PREFIXES.some((prefix) => prefix.test(rel))) return false;
    if (TEMPLATE_PREFIX.test(rel)) return false;
    return !rel.split('/').some((segment) => segment.startsWith('.'));
  });

  const raw: RawNote[] = [];
  for (const entry of entries) {
    const rel = entry.relPath.replace(/\\/g, '/');
    let text = '';
    try {
      text = await fs.readText(entry.relPath);
    } catch {
      continue;
    }
    const draft = parseDraft(text);
    const declaredType = (scalarOf(draft.frontmatter, 'type') ?? scalarOf(draft.frontmatter, '类型') ?? '').trim().toLowerCase();
    const inbox = /^inbox\//i.test(rel);
    const type: SchemaNoteType = inbox ? 'draft' : normaliseSchemaType(declaredType);
    const title = (scalarOf(draft.frontmatter, 'title') ?? scalarOf(draft.frontmatter, '标题') ?? '').trim()
      || (rel.split('/').pop() ?? rel).replace(/\.md$/i, '');
    const tags = listOf(draft.frontmatter, 'tags');
    const status = (scalarOf(draft.frontmatter, 'status') ?? '').trim();
    const links: string[] = [];
    for (const match of draft.body.replace(FENCED, '').matchAll(LINK)) {
      const inner = (match[1] ?? '').trim();
      if (inner === '') continue;
      const last = inner.split('/').pop() ?? inner;
      if (ATTACHMENT.test(last)) continue;
      links.push(normaliseLinkTarget(inner));
    }
    raw.push({ path: rel, title, type, declaredType, tags, status, modifiedMs: entry.modifiedMs ?? 0, inbox, untyped: !inbox && declaredType === '', links });
  }

  const byName = new Map<string, RawNote[]>();
  for (const note of raw) {
    const key = baseNameOf(note.path);
    const list = byName.get(key);
    if (list === undefined) byName.set(key, [note]);
    else list.push(note);
  }

  const inbound = new Map<string, number>();
  const broken: BrokenLink[] = [];
  const seenBroken = new Set<string>();
  for (const note of raw) {
    for (const target of note.links) {
      const targets = byName.get(target);
      if (targets === undefined) {
        if (KNOWN_EXTRAS.has(target)) continue;
        const key = note.path + '\u0000' + target;
        if (seenBroken.has(key)) continue;
        seenBroken.add(key);
        broken.push({ from: note.path, target });
        continue;
      }
      for (const hit of targets) inbound.set(hit.path, (inbound.get(hit.path) ?? 0) + 1);
    }
  }

  const notes: IndexNote[] = raw.map((note) => {
    const count = inbound.get(note.path) ?? 0;
    const eligible = isOrphanEligible({ path: note.path, type: note.type, inbox: note.inbox });
    return {
      path: note.path,
      title: note.title,
      type: note.type,
      declaredType: note.declaredType,
      tags: note.tags,
      status: note.status,
      inbound: count,
      outbound: note.links.length,
      outLinks: note.links,
      modifiedMs: note.modifiedMs,
      inbox: note.inbox,
      untyped: note.untyped,
      orphan: eligible && count === 0,
    };
  });
  notes.sort((left, right) => left.path.localeCompare(right.path));

  const graph = new Map<string, IndexNote[]>();
  for (const note of notes) {
    const key = baseNameOf(note.path);
    const list = graph.get(key);
    if (list === undefined) graph.set(key, [note]);
    else list.push(note);
  }

  const byType: Record<SchemaNoteType, number> = { concept: 0, thought: 0, source: 0, reference: 0, log: 0, link: 0, moc: 0, draft: 0, unknown: 0 };
  for (const note of notes) byType[note.type] += 1;
  const stats: IndexStats = {
    notes: notes.length,
    byType,
    orphans: notes.filter((note) => note.orphan).length,
    brokenLinks: broken.length,
    untyped: notes.filter((note) => note.untyped).length,
    inbox: notes.filter((note) => note.inbox).length,
  };
  return { notes, broken, stats, byName: graph };
}

/** The full index.md body: stats, recent changes, orphans, untyped notes, then one section per type. */
export function renderIndexMarkdown(scan: ScanResult, now: Date = new Date()): string {
  const { notes, broken, stats } = scan;
  const lines: string[] = [];
  lines.push('# 知识库索引', '');
  lines.push('<!-- generated by kb_index — 请勿手改；运行 kb_index {write:true} 重建 -->', '');
  lines.push('- 生成时间：' + stamp(now));
  lines.push('- 笔记：' + stats.notes + ' · ' + SCHEMA_TYPES.map((type) => type + ' ' + (stats.byType[type] ?? 0)).join(' · ') + ' · inbox ' + stats.inbox);
  lines.push('- 孤儿页：' + stats.orphans + ' · 断链：' + stats.brokenLinks + ' · 待整理（缺 type）：' + stats.untyped);

  lines.push('', '## 统计', '', '| type | 数量 | 说明 |', '| --- | --- | --- |');
  for (const type of SCHEMA_TYPES) lines.push('| ' + type + ' | ' + (stats.byType[type] ?? 0) + ' | ' + SCHEMA_TYPE_LABEL[type] + ' |');

  const recent = notes
    .filter((note) => note.modifiedMs > 0)
    .sort((left, right) => right.modifiedMs - left.modifiedMs)
    .slice(0, 10);
  lines.push('', '## 最近修改', '');
  if (recent.length === 0) lines.push('（没有 mtime 信息）');
  for (const note of recent) lines.push('- ' + stamp(new Date(note.modifiedMs)) + ' · ' + wikilink(note));

  lines.push('', '## 孤儿页（无入链）', '');
  const orphans = notes.filter((note) => note.orphan).sort((left, right) => left.path.localeCompare(right.path));
  if (orphans.length === 0) lines.push('（无）');
  for (const note of orphans) lines.push('- ' + wikilink(note) + ' · ' + note.type);

  lines.push('', '## 待整理（缺 type）', '');
  const untyped = notes.filter((note) => note.untyped).sort((left, right) => left.path.localeCompare(right.path));
  if (untyped.length === 0) lines.push('（无）');
  for (const note of untyped) lines.push('- ' + wikilink(note));

  lines.push('', '## 断链（前 ' + MAX_BROKEN_LISTED + ' 条，共 ' + broken.length + '）', '');
  if (broken.length === 0) lines.push('（无）');
  for (const link of broken.slice(0, MAX_BROKEN_LISTED)) lines.push('- ' + link.from + ' → [[' + link.target + ']]（无此笔记）');

  for (const type of SCHEMA_TYPES) {
    const group = byInbound(notes.filter((note) => note.type === type));
    if (group.length === 0) continue;
    lines.push('', '## ' + type + ' (' + group.length + ')', '');
    for (const note of group) lines.push('- ' + wikilink(note) + ' · 入链 ' + note.inbound);
  }
  return lines.join('\n') + '\n';
}

export interface IndexOptions {
  /** Write index.md (and one log line). Default false: scan and preview only. */
  readonly write?: boolean;
  readonly now?: Date;
}

/** Scan, render, optionally write; the preview is capped so tool output stays readable. */
export async function runIndex(fs: IndexFs, vaultRoot: string, options: IndexOptions = {}): Promise<IndexReport> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const scan = await scanVault(fs, vaultRoot);
  const content = renderIndexMarkdown(scan, now);
  const warnings: string[] = [];
  let written = false;
  if (options.write === true) {
    await fs.writeText(INDEX_FILE, content);
    written = true;
    const warning = await appendLogSafe(
      fs,
      'index',
      INDEX_FILE,
      scan.stats.notes + ' notes, ' + scan.stats.orphans + ' orphans, ' + scan.stats.brokenLinks + ' broken links',
      now,
    );
    if (warning !== undefined) warnings.push(warning);
  }
  const preview = content.length <= PREVIEW_LIMIT
    ? content
    : content.slice(0, PREVIEW_LIMIT) + '\n…（预览已截断；write:true 会写入完整 index.md）';
  return {
    ok: true,
    vaultRoot,
    written,
    index: INDEX_FILE,
    stats: scan.stats,
    preview,
    warnings,
    elapsedMs: Date.now() - started,
  };
}
