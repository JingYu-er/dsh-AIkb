import { isGeneratedNote, isSpecialNote } from '../domain/kb-schema.js';
import { parseDraft, serializeDraft } from '../domain/frontmatter.js';
import { tokenize } from '../domain/text.js';
import { buildNoteCorpus, rankSimilar } from './kb-suggest-links.js';
import type { NoteCorpus, NoteVector } from './kb-suggest-links.js';

/**
 * Contradiction review queue: find the notes most similar to one note, pull the statements
 * most likely to carry a conclusion, and stack them into a review table under inbox/review/.
 * The verdict column is left empty for an agent or human; nothing here edits a formal note.
 */

export const REVIEW_QUEUE_DIR = 'inbox/review';
export const MAX_SIMILAR_NOTES = 3;
export const MAX_STATEMENTS = 3;
export const MAX_PAIRS_PER_NOTE = 3;
export const MIN_SIMILARITY = 0.15;
export const RECENT_NOTES = 5;
export const REVIEW_VERDICTS = ['冲突', '细化', '无关'] as const;

const JUDGEMENT = /必须|不能|等于|大于|小于|应当|因此|所以|结论|注意|错误|正确|公式|系数/g;
const MIN_STATEMENT_CHARS = 20;
const MAX_EXCERPT_CHARS = 160;
const FENCED = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const HEADING = /^#{1,6}\s/;
const TABLE_LINE = /^\|/;
const HTML_COMMENT = /^<!--/;
const EXCLUDED_PREFIX = /^(inbox|\.wiki|\.obsidian|\.trash|node_modules|\.git)\//i;
const TEMPLATE_NAME = /\.(eta|template)\.md$|^zotlit-/i;

export interface ReviewEntry {
  readonly relPath: string;
  readonly modifiedMs?: number;
}

export interface ReviewFs {
  listFiles(): Promise<readonly ReviewEntry[]>;
  readText(relPath: string): Promise<string>;
  writeText(relPath: string, content: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
}

export interface ReviewRow {
  readonly oldPath: string;
  readonly oldName: string;
  readonly score: number;
  readonly oldText: string;
  readonly newText: string;
  readonly verdict: string;
  readonly basis: string;
}

export interface ReviewCandidate {
  readonly path: string;
  readonly name: string;
  readonly score: number;
  readonly statements: number;
  readonly pairs: number;
}

export interface ReviewQueueReport {
  readonly path: string;
  readonly note: string;
  readonly candidates: readonly ReviewCandidate[];
  readonly rows: readonly ReviewRow[];
  readonly pending: number;
  readonly written: boolean;
  readonly merged: number;
  readonly added: number;
}

export interface ReviewOptions {
  readonly write?: boolean;
  readonly minScore?: number;
  readonly maxSimilar?: number;
  readonly now?: Date;
  readonly corpus?: NoteCorpus;
}

export interface ReviewRunReport {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly notes: number;
  readonly queues: readonly ReviewQueueReport[];
  readonly written: boolean;
  readonly pending: number;
  readonly warnings: readonly string[];
  readonly preview: string;
  readonly elapsedMs: number;
}

export interface ReviewRunOptions {
  readonly note?: string;
  readonly write?: boolean;
  readonly limit?: number;
  readonly now?: Date;
}

interface Statement {
  readonly text: string;
  readonly order: number;
  readonly score: number;
}

interface StatementPair {
  readonly oldText: string;
  readonly newText: string;
  readonly overlap: number;
}

function basenameOf(relPath: string): string {
  return (relPath.split('/').pop() ?? relPath).replace(/\.md$/i, '');
}

/** One queue per note; directory components stay in the slug so equal basenames never collide. */
export function reviewQueuePathFor(notePath: string): string {
  const stem = notePath.replace(/\\/g, '/').replace(/\.md$/i, '');
  const slug = stem.replace(/[^\w\u4e00-\u9fa5.-]+/g, '__').replace(/^_+|_+$/g, '');
  return REVIEW_QUEUE_DIR + '/' + slug + '.md';
}

/** Formal notes eligible as contradiction candidates: no inbox drafts, generated pages or templates. */
export function isReviewCandidate(relPath: string): boolean {
  if (!/\.md$/i.test(relPath)) return false;
  if (EXCLUDED_PREFIX.test(relPath)) return false;
  if (TEMPLATE_NAME.test(basenameOf(relPath))) return false;
  if (isSpecialNote(relPath)) return false;
  return !isGeneratedNote(relPath);
}

function cleanParagraph(raw: string): string {
  return raw
    .replace(/!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string): string {
  return text.length > MAX_EXCERPT_CHARS ? text.slice(0, MAX_EXCERPT_CHARS - 1) + '…' : text;
}

/** Paragraphs of the body, skipping code fences, headings, tables and HTML comments. */
function paragraphsOf(body: string): string[] {
  const source = body.replace(FENCED, '\n\n');
  const out: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = cleanParagraph(buffer.join(' '));
    buffer = [];
    if (text !== '') out.push(text);
  };
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || HEADING.test(trimmed) || TABLE_LINE.test(trimmed) || HTML_COMMENT.test(trimmed)) {
      flush();
      continue;
    }
    buffer.push(trimmed);
  }
  flush();
  return out;
}

export function scoreStatement(text: string): number {
  let score = text.match(JUDGEMENT)?.length ?? 0;
  if (/\d/.test(text)) score += 1;
  return score;
}

/** The statements most likely to hold a conclusion: judgement words first, then document order. */
export function extractStatements(body: string, max = MAX_STATEMENTS): Statement[] {
  const paragraphs = paragraphsOf(body)
    .filter((text) => text.length >= MIN_STATEMENT_CHARS)
    .map((text, order) => ({ text: truncate(text), order, score: scoreStatement(text) }));
  const seen = new Set<string>();
  return paragraphs
    .map((statement, index) => ({ statement, index }))
    .filter((entry) => {
      if (seen.has(entry.statement.text)) return false;
      seen.add(entry.statement.text);
      return true;
    })
    .sort((left, right) => right.statement.score - left.statement.score || left.index - right.index)
    .slice(0, Math.max(1, max))
    .map((entry) => entry.statement)
    .sort((left, right) => left.order - right.order);
}

/** Greedy token-overlap pairing; when the excerpts share no term, fall back to document order. */
function pairStatements(olds: readonly Statement[], news: readonly Statement[]): StatementPair[] {
  if (olds.length === 0 || news.length === 0) return [];
  const tokenSets = news.map((statement) => new Set(tokenize(statement.text)));
  const scored: { oldIndex: number; newIndex: number; overlap: number }[] = [];
  olds.forEach((oldText, oldIndex) => {
    const oldTokens = new Set(tokenize(oldText.text));
    tokenSets.forEach((newsTokens, newIndex) => {
      let overlap = 0;
      for (const token of oldTokens) if (newsTokens.has(token)) overlap += 1;
      scored.push({ oldIndex, newIndex, overlap });
    });
  });
  scored.sort((left, right) => right.overlap - left.overlap || left.oldIndex - right.oldIndex || left.newIndex - right.newIndex);
  const pairs: StatementPair[] = [];
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  for (const entry of scored) {
    if (pairs.length >= MAX_PAIRS_PER_NOTE) break;
    if (entry.overlap <= 0 || usedOld.has(entry.oldIndex) || usedNew.has(entry.newIndex)) continue;
    usedOld.add(entry.oldIndex);
    usedNew.add(entry.newIndex);
    const oldText = olds[entry.oldIndex];
    const newText = news[entry.newIndex];
    if (oldText === undefined || newText === undefined) continue;
    pairs.push({ oldText: oldText.text, newText: newText.text, overlap: entry.overlap });
  }
  if (pairs.length === 0) {
    const count = Math.min(2, olds.length, news.length);
    for (let index = 0; index < count; index += 1) {
      const oldText = olds[index];
      const newText = news[index];
      if (oldText === undefined || newText === undefined) continue;
      pairs.push({ oldText: oldText.text, newText: newText.text, overlap: 0 });
    }
  }
  return pairs;
}

function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function splitCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

const TABLE_HEADER = '| 旧笔记 | 相似度 | 旧说法（摘录） | 新说法（摘录） | 判定（待填） | 依据（待填） |';
const TABLE_RULE = '| --- | --- | --- | --- | --- | --- |';

function rowKey(row: ReviewRow): string {
  return [row.oldPath, row.oldText, row.newText].join('\u0000');
}

function renderQueueBody(note: string, notePath: string, rows: readonly ReviewRow[], generatedAt: Date): string {
  const lines: string[] = [
    '# 矛盾候选 · ' + note,
    '',
    '目标笔记：`' + notePath + '`',
    '',
    '候选对由相似度自动挑出，判定列留空待填：**冲突**（两说不能同时成立）/ **细化**（新说法是旧说法的补充）/ **无关**（相似度误报）。本文件只供审阅，不自动改动任何正式笔记。',
    '',
    TABLE_HEADER,
    TABLE_RULE,
  ];
  for (const row of rows) {
    const oldNote = '[[' + escapeCell(row.oldName) + ']]<br>`' + escapeCell(row.oldPath) + '`';
    lines.push(
      '| ' +
        [
          oldNote,
          row.score.toFixed(3),
          escapeCell(row.oldText),
          escapeCell(row.newText),
          escapeCell(row.verdict),
          escapeCell(row.basis),
        ].join(' | ') +
        ' |',
    );
  }
  return lines.join('\n') + '\n';
}

/** Parse a queue file back into rows; only table data lines are read. */
export function parseReviewQueue(text: string): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitCells(line);
    if (cells.length < 6) continue;
    if ((cells[0] ?? '').includes('旧笔记')) continue;
    if (/^-+$/.test((cells[0] ?? '').replace(/\s/g, ''))) continue;
    const first = cells[0] ?? '';
    const linkMatch = /\[\[([^\]]+)\]\]/.exec(first);
    const pathMatch = /`([^`]+)`/.exec(first);
    const score = Number(cells[1]);
    rows.push({
      oldName: linkMatch?.[1]?.trim() ?? '',
      oldPath: pathMatch?.[1]?.trim() ?? '',
      score: Number.isFinite(score) ? score : 0,
      oldText: cells[2] ?? '',
      newText: cells[3] ?? '',
      verdict: cells[4] ?? '',
      basis: cells.slice(5).join(' | '),
    });
  }
  return rows;
}

/** Number of rows whose 判定 column is still empty — used by kb_lint. */
export function countPendingReviewRows(text: string): number {
  return parseReviewQueue(text).filter((row) => row.verdict.trim() === '').length;
}

/** Build one note's review queue. Reads formal notes, writes only inbox/review/. */
export async function reviewNote(fs: ReviewFs, notePath: string, options: ReviewOptions = {}): Promise<ReviewQueueReport> {
  const corpus = options.corpus ?? (await buildNoteCorpus(fs));
  const doc = corpus.docs.find((entry) => entry.path === notePath) ?? corpus.docs.find((entry) => entry.name === notePath);
  if (doc === undefined) {
    throw new Error('note not found in corpus: ' + notePath);
  }
  const noteText = await fs.readText(doc.path);
  const news = extractStatements(parseDraft(noteText).body);

  const queuePath = reviewQueuePathFor(doc.path);
  const existingText = (await fs.exists(queuePath)) ? await fs.readText(queuePath) : undefined;
  const existing = existingText === undefined ? [] : parseReviewQueue(existingText);
  const seen = new Set(existing.map(rowKey));
  const rows: ReviewRow[] = [...existing];

  const ranked = rankSimilar(corpus, doc.path, {
    topK: Math.max(1, options.maxSimilar ?? MAX_SIMILAR_NOTES),
    minScore: options.minScore ?? MIN_SIMILARITY,
    accept: (candidate: NoteVector) => isReviewCandidate(candidate.path),
  });

  const candidates: ReviewCandidate[] = [];
  let added = 0;
  for (const similar of ranked) {
    const oldText = await fs.readText(similar.path);
    const olds = extractStatements(parseDraft(oldText).body);
    const pairs = pairStatements(olds, news);
    let fresh = 0;
    for (const pair of pairs) {
      const row: ReviewRow = {
        oldPath: similar.path,
        oldName: similar.name,
        score: similar.score,
        oldText: pair.oldText,
        newText: pair.newText,
        verdict: '',
        basis: '',
      };
      const key = rowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      added += 1;
      fresh += 1;
    }
    candidates.push({ path: similar.path, name: similar.name, score: similar.score, statements: olds.length, pairs: fresh });
  }

  const generatedAt = options.now ?? new Date();
  const body = renderQueueBody(doc.name, doc.path, rows, generatedAt);
  const text = serializeDraft(
    [
      ['type', 'review-queue'],
      ['note', doc.path],
      ['generated', generatedAt.toISOString()],
    ],
    body,
  );
  const written = options.write === true;
  if (written) await fs.writeText(queuePath, text);
  return {
    path: queuePath,
    note: doc.path,
    candidates,
    rows,
    pending: rows.filter((row) => row.verdict.trim() === '').length,
    written,
    merged: existing.length,
    added,
  };
}

function previewOf(queues: readonly ReviewQueueReport[]): string {
  const lines: string[] = [];
  for (const queue of queues) {
    lines.push(queue.path + '  ← ' + queue.note);
    lines.push('  候选旧笔记 ' + queue.candidates.length + ' 篇，表格行 ' + queue.rows.length + ' 条，待判定 ' + queue.pending + ' 条');
    for (const candidate of queue.candidates) {
      lines.push('  · ' + candidate.name + '  ' + candidate.score.toFixed(3) + '  （新对 ' + candidate.pairs + ' 条）');
    }
  }
  return lines.join('\n').slice(0, 4000);
}

/** Generate queues for one note or the most recently modified formal notes. */
export async function reviewNotes(fs: ReviewFs, vaultRoot: string, options: ReviewRunOptions = {}): Promise<ReviewRunReport> {
  const started = Date.now();
  const warnings: string[] = [];
  const corpus = await buildNoteCorpus(fs);
  const modified = new Map<string, number>();
  for (const entry of await fs.listFiles()) modified.set(entry.relPath, entry.modifiedMs ?? 0);

  let targets: NoteVector[];
  if (options.note !== undefined) {
    const wanted = options.note.replace(/\\/g, '/');
    targets = corpus.docs.filter((entry) => entry.path === wanted || entry.name.toLowerCase() === wanted.toLowerCase());
    if (targets.length === 0) warnings.push('note not found: ' + wanted);
  } else {
    targets = corpus.docs
      .filter((entry) => isReviewCandidate(entry.path))
      .sort((left, right) => (modified.get(right.path) ?? 0) - (modified.get(left.path) ?? 0) || left.path.localeCompare(right.path))
      .slice(0, Math.max(1, options.limit ?? RECENT_NOTES));
  }

  const queues: ReviewQueueReport[] = [];
  for (const target of targets) {
    try {
      queues.push(await reviewNote(fs, target.path, { write: options.write, now: options.now, corpus }));
    } catch (error) {
      warnings.push(target.path + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  return {
    ok: true,
    vaultRoot,
    notes: queues.length,
    queues,
    written: options.write === true,
    pending: queues.reduce((sum, queue) => sum + queue.pending, 0),
    warnings,
    preview: previewOf(queues),
    elapsedMs: Date.now() - started,
  };
}
