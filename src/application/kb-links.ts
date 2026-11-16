/** Link policy engine v1: suggest → queue in inbox/links → human fills why → apply with backup + diff. */

import { diffLines } from '../domain/diff.js';
import type { LineDiff } from '../domain/diff.js';
import { parseDraft, scalarOf, serializeDraft } from '../domain/frontmatter.js';
import type { SchemaNoteType } from '../domain/kb-schema.js';
import { appendLogSafe } from './kb-log.js';
import { normaliseLinkTarget, scanVault } from './kb-index.js';
import type { IndexFs, ScanResult } from './kb-index.js';
import { suggestLinks } from './kb-suggest-links.js';

export interface LinkFs extends IndexFs {
  exists(relPath: string): Promise<boolean>;
}

export const LINK_QUEUE_DIR = 'inbox/links';
export const MAX_CANDIDATES_PER_NOTE = 8;
export const MIN_CONFIDENCE = 0.25;
export const ASSOCIATION_HEADING = '关联';

const LINK = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const PREVIEW_LIMIT = 4000;

export interface QueueRow {
  readonly target: string;
  readonly confidence: number;
  readonly direction: string;
  readonly why: string;
  readonly applied: boolean;
}

export interface QueueFile {
  readonly path: string;
  readonly note: string;
  readonly generated: string;
  readonly rows: readonly QueueRow[];
}

export interface LinkCandidate {
  readonly from: string;
  readonly to: string;
  readonly toPath: string;
  readonly title: string;
  readonly confidence: number;
  readonly direction: string;
  readonly warning?: string;
  readonly why: string;
}

export interface DirectionVerdict {
  readonly allowed: boolean;
  readonly label: string;
  readonly warning?: string;
}

/** SCHEMA direction table. Unlisted pairs stay allowed but carry a warning for the reviewer. */
export function judgeDirection(from: SchemaNoteType, to: SchemaNoteType): DirectionVerdict {
  const label = from + '→' + to;
  if (from === 'draft') return { allowed: false, label, warning: 'draft 只存在于 inbox，提升为正式笔记后再建链' };
  if (from === 'source' && to === 'source') return { allowed: false, label, warning: 'SCHEMA 禁止 source→source' };
  if (from === 'reference' && to === 'reference') return { allowed: false, label, warning: 'SCHEMA 禁止 reference→reference（速查页之间不互链）' };
  if (from === 'moc' || from === 'link') return { allowed: true, label };
  if (from === 'thought' && to === 'thought') return { allowed: true, label, warning: 'thought→thought 是同层链接，需说明判断关系' };
  if (from === 'thought' && (to === 'concept' || to === 'source' || to === 'reference')) return { allowed: true, label };
  if (from === 'log' && to === 'log') return { allowed: true, label, warning: 'log→log 是时间线续接，确认确有关联' };
  if (from === 'log' && (to === 'concept' || to === 'source' || to === 'reference')) return { allowed: true, label };
  if (from === 'reference') return { allowed: true, label, warning: 'reference 是速查页，通常只作为链接目标' };
  if (from === 'concept' && to === 'concept') return { allowed: true, label, warning: 'concept→concept 需确认上下位关系' };
  if (from === 'source') return { allowed: true, label, warning: 'SCHEMA 只允许 thought/moc 作为链接起点，请确认' };
  return { allowed: true, label, warning: '方向未在 SCHEMA 中明确，需确认' };
}

/** inbox/links/<note-slug>.md — path-derived so two notes with the same basename never collide. */
export function queuePathFor(notePath: string): string {
  const stem = notePath.replace(/\\/g, '/').replace(/\.md$/i, '');
  const slug = stem.replace(/[^\w\u4e00-\u9fa5.-]+/g, '__').replace(/^_+|_+$/g, '');
  return LINK_QUEUE_DIR + '/' + slug + '.md';
}

function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function cleanWhy(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '｜').replace(/\s+/g, ' ').trim();
}

function rowLine(row: QueueRow): string {
  return '| ' + (row.applied ? '[x]' : '[ ]') + ' | [[' + row.target + ']] | ' + row.confidence.toFixed(2)
    + ' | ' + row.direction + ' | ' + escapeCell(row.why) + ' |';
}

export function renderQueue(queue: { readonly note: string; readonly generated: string; readonly rows: readonly QueueRow[] }): string {
  const title = (queue.note.split('/').pop() ?? queue.note).replace(/\.md$/i, '');
  const body: string[] = [];
  body.push('# 链接候选 · ' + title);
  body.push('');
  body.push('<!-- why 留空 = 未批准。填写 why（支撑了什么判断 / 修正了什么 / 新用在哪里）后运行 kb_link_apply {confirm:true}。 -->');
  body.push('');
  body.push('| 状态 | 目标 | 置信度 | 方向 | why（待填） |');
  body.push('| --- | --- | --- | --- | --- |');
  for (const row of queue.rows) body.push(rowLine(row));
  const entries: [string, string][] = [['type', 'link-queue'], ['note', queue.note], ['generated', queue.generated]];
  return serializeDraft(entries, body.join('\n'));
}

function splitCells(line: string): string[] {
  const inner = line.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

export function parseQueue(path: string, text: string): QueueFile {
  const draft = parseDraft(text);
  const note = (scalarOf(draft.frontmatter, 'note') ?? '').trim();
  const generated = (scalarOf(draft.frontmatter, 'generated') ?? '').trim();
  const rows: QueueRow[] = [];
  for (const line of draft.body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = splitCells(trimmed);
    if (cells.length < 4) continue;
    const state = cells[0] ?? '';
    if (state === '状态') continue;
    if (/^:?-{3,}/.test(state)) continue;
    const targetCell = cells[1] ?? '';
    const link = /\[\[([^\]]+)\]\]/.exec(targetCell);
    const target = (link === null ? targetCell : (link[1] ?? targetCell)).trim();
    if (target === '') continue;
    const confidence = Number(cells[2] ?? '0');
    const direction = cells[3] ?? '';
    const why = cells.slice(4).join(' | ');
    rows.push({
      target,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      direction,
      why,
      applied: /\[x\]/i.test(state),
    });
  }
  return { path, note, generated, rows };
}

function resolveNotePath(scan: ScanResult, name: string): string | undefined {
  const normalised = name.replace(/\\/g, '/');
  const direct = scan.notes.find((note) => note.path === normalised);
  if (direct !== undefined) return direct.path;
  const key = normalised.replace(/\.md$/i, '').split('/').pop() ?? normalised;
  const hits = scan.byName.get(key.toLowerCase());
  if (hits === undefined || hits.length !== 1) return undefined;
  return hits[0]?.path;
}

export interface ReviewOptions {
  readonly note?: string;
  readonly write?: boolean;
  readonly limit?: number;
  readonly minScore?: number;
  readonly now?: Date;
}

export interface QueueReport {
  readonly path: string;
  readonly note: string;
  readonly rows: readonly QueueRow[];
  readonly candidates: readonly LinkCandidate[];
  readonly written: boolean;
  readonly merged: number;
}

export interface ReviewReport {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly notes: number;
  readonly candidates: number;
  readonly rejected: number;
  readonly written: boolean;
  readonly queues: readonly QueueReport[];
  readonly preview: string;
  readonly warnings: readonly string[];
  readonly elapsedMs: number;
}

function reviewPreview(queues: readonly QueueReport[], notes: number, candidates: number, written: boolean, elapsedMs: number): string {
  const lines = ['link-review: ' + candidates + ' candidate(s) in ' + queues.length + ' queue(s) from ' + notes + ' note(s)'
    + (written ? ' (written)' : ' (dry run)') + ' | ' + elapsedMs + ' ms'];
  for (const queue of queues) {
    lines.push('  ' + queue.note + ' -> ' + queue.path);
    for (const candidate of queue.candidates) {
      lines.push('    -> ' + candidate.to + ' (' + candidate.confidence.toFixed(2) + ', ' + candidate.direction + ')'
        + (candidate.why === '' ? '' : ' · ' + candidate.why));
      if (candidate.warning !== undefined) lines.push('      ! ' + candidate.warning);
    }
  }
  const text = lines.join('\n');
  return text.length <= PREVIEW_LIMIT ? text : text.slice(0, PREVIEW_LIMIT) + '\n…（已截断）';
}

/** Scan candidates, filter by SCHEMA rules, and (write:true) maintain inbox/links queues. Never edits notes. */
export async function reviewLinks(fs: LinkFs, vaultRoot: string, options: ReviewOptions = {}): Promise<ReviewReport> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const minConfidence = options.minScore ?? MIN_CONFIDENCE;
  const scan = await scanVault(fs, vaultRoot);
  const byPath = new Map(scan.notes.map((note) => [note.path, note]));
  const requested = options.note?.trim();
  const noteArg = requested === undefined || requested === '' ? undefined : requested;
  const suggestion = await suggestLinks(fs, vaultRoot, {
    limit: 5000,
    perNote: MAX_CANDIDATES_PER_NOTE,
    minScore: minConfidence,
    ...(noteArg === undefined ? {} : { note: noteArg }),
  });

  const warnings: string[] = [];
  const groups = new Map<string, LinkCandidate[]>();
  let rejected = 0;
  let candidates = 0;
  for (const item of suggestion.suggestions) {
    const first = byPath.get(item.from);
    if (first === undefined) continue;
    if (item.confidence < minConfidence) continue;
    let sourceNote = first;
    const target = scan.byName.get(item.to.trim().toLowerCase())?.[0];
    if (target === undefined || target.path === sourceNote.path) continue;
    let targetNote = target;
    // Similarity is direction-blind; orient the pair along the SCHEMA (clean direction first).
    let verdict = judgeDirection(sourceNote.type, targetNote.type);
    if (!verdict.allowed || verdict.warning !== undefined) {
      const reverse = judgeDirection(targetNote.type, sourceNote.type);
      const clean = verdict.allowed && verdict.warning === undefined;
      if (!clean && reverse.allowed) {
        const swap = sourceNote;
        sourceNote = targetNote;
        targetNote = swap;
        verdict = reverse;
      }
    }
    if (!verdict.allowed) {
      rejected += 1;
      continue;
    }
    const targetName = (targetNote.path.split('/').pop() ?? targetNote.path).replace(/\.md$/i, '');
    if (sourceNote.outLinks.includes(targetName.toLowerCase())) continue;
    const group = groups.get(sourceNote.path) ?? [];
    if (group.length >= MAX_CANDIDATES_PER_NOTE) continue;
    if (group.some((candidate) => candidate.toPath === targetNote.path)) continue;
    group.push({
      from: sourceNote.path,
      to: targetName,
      toPath: targetNote.path,
      title: targetNote.title,
      confidence: item.confidence,
      direction: verdict.label,
      ...(verdict.warning === undefined ? {} : { warning: verdict.warning }),
      why: item.why,
    });
    groups.set(sourceNote.path, group);
    candidates += 1;
  }

  const ordered = [...groups.entries()]
    .map(([path, list]) => ({ path, list: [...list].sort((left, right) => right.confidence - left.confidence) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const limited = options.limit !== undefined && options.limit > 0 ? ordered.slice(0, options.limit) : ordered;

  const queues: QueueReport[] = [];
  for (const entry of limited) {
    const queuePath = queuePathFor(entry.path);
    let existing: QueueFile | undefined;
    try {
      if (await fs.exists(queuePath)) existing = parseQueue(queuePath, await fs.readText(queuePath));
    } catch (error) {
      warnings.push('queue read failed (' + queuePath + '): ' + (error instanceof Error ? error.message : String(error)));
    }
    const rows: QueueRow[] = [...(existing?.rows ?? [])];
    const seen = new Set(rows.map((row) => row.target.toLowerCase()));
    for (const candidate of entry.list) {
      if (rows.length >= MAX_CANDIDATES_PER_NOTE) break;
      const key = candidate.to.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ target: candidate.to, confidence: candidate.confidence, direction: candidate.direction, why: '', applied: false });
    }
    let written = false;
    if (options.write === true) {
      try {
        await fs.writeText(queuePath, renderQueue({ note: entry.path, generated: now.toISOString(), rows }));
        written = true;
      } catch (error) {
        warnings.push('queue write failed (' + queuePath + '): ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    queues.push({ path: queuePath, note: entry.path, rows, candidates: entry.list, written, merged: rows.length - (existing?.rows.length ?? 0) });
  }

  const elapsedMs = Date.now() - started;
  return {
    ok: true,
    vaultRoot,
    notes: scan.stats.notes,
    candidates,
    rejected,
    written: queues.some((queue) => queue.written),
    queues,
    preview: reviewPreview(queues, scan.stats.notes, candidates, options.write === true, elapsedMs),
    warnings,
    elapsedMs,
  };
}

export interface ApplyOptions {
  readonly queue?: string;
  readonly note?: string;
  readonly confirm?: boolean;
  readonly now?: Date;
}

export interface ApplyRowReport {
  readonly queue: string;
  readonly note: string;
  readonly target: string;
  readonly why: string;
  readonly written: boolean;
  readonly backup?: string;
  readonly skipped?: string;
  readonly diff: LineDiff;
}

export interface ApplyReport {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly confirm: boolean;
  readonly applied: number;
  readonly skipped: number;
  readonly pending: number;
  readonly rows: readonly ApplyRowReport[];
  readonly warnings: readonly string[];
  readonly elapsedMs: number;
}

function hasLink(text: string, target: string): boolean {
  const wanted = normaliseLinkTarget(target);
  for (const match of text.matchAll(LINK)) {
    if (normaliseLinkTarget(match[1] ?? '') === wanted) return true;
  }
  return false;
}

/** Append '- [[target]] — why' at the end of the '## 关联' section, creating it when missing. */
export function appendAssociation(text: string, target: string, why: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalised = text.replace(/\r\n/g, '\n');
  const entry = '- [[' + target + ']] — ' + cleanWhy(why);
  const heading = /^##[ \t]+关联[ \t]*$/m.exec(normalised);
  let next: string;
  if (heading === null) {
    next = normalised.replace(/\s+$/, '') + '\n\n## 关联\n\n' + entry + '\n';
  } else {
    const start = (heading.index ?? 0) + heading[0].length;
    const rest = normalised.slice(start);
    const following = /^#{1,2}[ \t]+/m.exec(rest);
    const end = following === null ? normalised.length : start + (following.index ?? 0);
    const section = normalised.slice(start, end).replace(/\s+$/, '');
    const tail = normalised.slice(end);
    const head = normalised.slice(0, start);
    const body = section === '' ? head + '\n\n' + entry : head + section + '\n' + entry;
    next = tail === '' ? body + '\n' : body + '\n\n' + tail;
  }
  return eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next;
}

export function backupPathFor(now: Date, notePath: string): string {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const flat = notePath.replace(/\.md$/i, '').replace(/[/\\]+/g, '__');
  return '.wiki/backups/' + iso + '-' + flat + '.md';
}

async function resolveQueuePaths(fs: LinkFs, scan: ScanResult, options: ApplyOptions): Promise<string[]> {
  const explicit = options.queue?.trim();
  if (explicit !== undefined && explicit !== '') {
    const normalised = explicit.replace(/\\/g, '/');
    if (normalised.startsWith(LINK_QUEUE_DIR + '/')) return [normalised];
    const notePath = resolveNotePath(scan, normalised);
    return [notePath === undefined ? normalised : queuePathFor(notePath)];
  }
  const noteArg = options.note?.trim();
  if (noteArg !== undefined && noteArg !== '') {
    const notePath = resolveNotePath(scan, noteArg);
    return notePath === undefined ? [] : [queuePathFor(notePath)];
  }
  const entries = await fs.listFiles();
  return entries
    .map((entry) => entry.relPath.replace(/\\/g, '/'))
    .filter((rel) => rel.startsWith(LINK_QUEUE_DIR + '/') && /\.md$/i.test(rel))
    .sort();
}

/** Apply only rows whose why is filled to the queue's source note; confirm:false previews diffs and writes nothing. */
export async function applyLinks(fs: LinkFs, vaultRoot: string, options: ApplyOptions = {}): Promise<ApplyReport> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const confirm = options.confirm === true;
  const scan = await scanVault(fs, vaultRoot);
  const paths = await resolveQueuePaths(fs, scan, options);
  const warnings: string[] = [];
  const reports: ApplyRowReport[] = [];
  let pending = 0;

  for (const queuePath of paths) {
    let text = '';
    try {
      text = await fs.readText(queuePath);
    } catch (error) {
      warnings.push('queue not readable (' + queuePath + '): ' + (error instanceof Error ? error.message : String(error)));
      continue;
    }
    const queue = parseQueue(queuePath, text);
    // A queue belongs to the link SOURCE note: the approved link is appended there.
    const sourcePath = resolveNotePath(scan, queue.note);
    if (sourcePath === undefined) {
      warnings.push('queue note not found in vault (' + queue.note + '); skipped ' + queuePath);
      continue;
    }
    const rows = [...queue.rows];
    let changed = false;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined || row.applied) continue;
      const why = row.why.trim();
      if (why === '') {
        pending += 1;
        continue;
      }
      const targets = scan.byName.get(row.target.trim().toLowerCase()) ?? [];
      const targetNote = targets[0];
      if (targetNote === undefined) {
        reports.push({
          queue: queuePath,
          note: sourcePath,
          target: row.target,
          why,
          written: false,
          skipped: 'target-not-found',
          diff: { lines: [], added: 0, removed: 0, truncated: false },
        });
        continue;
      }
      let before = '';
      try {
        before = await fs.readText(sourcePath);
      } catch (error) {
        reports.push({
          queue: queuePath,
          note: sourcePath,
          target: row.target,
          why,
          written: false,
          skipped: 'read-failed: ' + (error instanceof Error ? error.message : String(error)),
          diff: { lines: [], added: 0, removed: 0, truncated: false },
        });
        continue;
      }
      if (hasLink(before, row.target) || hasLink(before, targetNote.path)) {
        reports.push({
          queue: queuePath,
          note: sourcePath,
          target: row.target,
          why,
          written: false,
          skipped: 'already-linked',
          diff: { lines: [], added: 0, removed: 0, truncated: false },
        });
        continue;
      }
      const after = appendAssociation(before, row.target, why);
      const diff = diffLines(before, after);
      if (!confirm) {
        reports.push({ queue: queuePath, note: sourcePath, target: row.target, why, written: false, diff });
        continue;
      }
      const backup = backupPathFor(now, sourcePath);
      try {
        await fs.writeText(backup, before);
        await fs.writeText(sourcePath, after);
      } catch (error) {
        reports.push({
          queue: queuePath,
          note: sourcePath,
          target: row.target,
          why,
          written: false,
          skipped: 'write-failed: ' + (error instanceof Error ? error.message : String(error)),
          diff,
        });
        continue;
      }
      rows[index] = { ...row, applied: true };
      changed = true;
      reports.push({ queue: queuePath, note: sourcePath, target: row.target, why, written: true, backup, diff });
      const warning = await appendLogSafe(fs, 'link', sourcePath, '+' + row.target + ' ← ' + queuePath + ' — ' + why, now);
      if (warning !== undefined) warnings.push(warning);
    }
    if (confirm && changed) {
      try {
        await fs.writeText(queuePath, renderQueue({ note: queue.note, generated: queue.generated === '' ? now.toISOString() : queue.generated, rows }));
      } catch (error) {
        warnings.push('queue update failed (' + queuePath + '): ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  return {
    ok: true,
    vaultRoot,
    confirm,
    applied: reports.filter((row) => row.written).length,
    skipped: reports.filter((row) => row.written === false && row.skipped !== undefined).length,
    pending,
    rows: reports,
    warnings,
    elapsedMs: Date.now() - started,
  };
}
