import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One queue for page feedback, inside the inbox the rest of the pipeline already watches. */
export const FEEDBACK_REL_PATH = 'inbox/feedback.md';

const HEADER = '# 页面反馈' + LF() + LF() + '对某一页有意见就记在这里（谁写都行，人写或面板按钮写入）。每条是 `- [ ] 时间 · [[路径]] — 说明`；处理完把 `[ ]` 改成 `[x]`。' + LF() + LF();
const MAX_TEXT_BYTES = 2000;

function LF(): string {
  return String.fromCharCode(10);
}

export interface FeedbackRow {
  readonly index: number;
  readonly done: boolean;
  readonly at: string;
  readonly note: string;
  readonly text: string;
}

export interface FeedbackReport {
  readonly path: string;
  readonly exists: boolean;
  readonly rows: readonly FeedbackRow[];
}

export interface FeedbackWriteResult {
  readonly ok: boolean;
  readonly path: string;
  readonly bytes?: number;
  readonly index?: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export function feedbackPath(vaultRoot: string): string {
  return join(vaultRoot, 'inbox', 'feedback.md');
}

const ROW = /^- \[( |x|X)\] (\S+) · \[\[([^\]]+)\]\] — (.*)$/;

/** Parses rows in file order; the index is what markFeedbackDone expects. */
export function parseFeedback(text: string): readonly FeedbackRow[] {
  const rows: FeedbackRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = ROW.exec(line.trim());
    if (match === null) continue;
    rows.push({
      index: rows.length,
      done: (match[1] ?? '').toLowerCase() === 'x',
      at: match[2] ?? '',
      note: match[3] ?? '',
      text: match[4] ?? '',
    });
  }
  return rows;
}

export async function readFeedback(vaultRoot: string): Promise<FeedbackReport> {
  const path = feedbackPath(vaultRoot);
  if (!existsSync(path)) return { path, exists: false, rows: [] };
  try {
    return { path, exists: true, rows: parseFeedback(readFileSync(path, 'utf8')) };
  } catch {
    return { path, exists: false, rows: [] };
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // The tmp file is not load-bearing; the failure below is what matters.
    }
    throw error;
  }
}

export async function appendFeedback(
  vaultRoot: string,
  entry: { readonly note: string; readonly text: string; readonly now?: Date },
  options: { readonly allowWrites: boolean },
): Promise<FeedbackWriteResult> {
  const path = feedbackPath(vaultRoot);
  if (!options.allowWrites) {
    return { ok: false, path, error: { code: 'kb.feedback.read-only', message: 'Writes are disabled; enable allowWrites in the KB settings page.' } };
  }
  const note = entry.note.trim();
  const text = entry.text.trim().replace(/\s+/g, ' ');
  if (note === '' || text === '') {
    return { ok: false, path, error: { code: 'kb.feedback.empty', message: 'A feedback row needs a note path and some text.' } };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    return { ok: false, path, error: { code: 'kb.feedback.too-large', message: 'Feedback is limited to ' + MAX_TEXT_BYTES + ' bytes.' } };
  }
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : HEADER;
  const prefix = existing === '' || existing.endsWith(LF()) ? existing : existing + LF();
  const at = (entry.now ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const row = '- [ ] ' + at + ' · [[' + note + ']] — ' + text;
  const next = prefix + row + LF();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, next);
  } catch (error) {
    return { ok: false, path, error: { code: 'kb.feedback.write-failed', message: String(error instanceof Error ? error.message : error) } };
  }
  const rows = parseFeedback(next);
  return { ok: true, path, bytes: Buffer.byteLength(next, 'utf8'), index: rows.length - 1 };
}

export async function markFeedbackDone(
  vaultRoot: string,
  index: number,
  options: { readonly allowWrites: boolean },
): Promise<FeedbackWriteResult> {
  const path = feedbackPath(vaultRoot);
  if (!options.allowWrites) {
    return { ok: false, path, error: { code: 'kb.feedback.read-only', message: 'Writes are disabled; enable allowWrites in the KB settings page.' } };
  }
  if (!existsSync(path)) {
    return { ok: false, path, error: { code: 'kb.feedback.missing-index', message: 'No feedback file exists yet.' } };
  }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  let seen = 0;
  let flipped = false;
  const next = lines.map((line) => {
    if (!ROW.test(line.trim())) return line;
    const current = seen;
    seen += 1;
    if (current !== index || flipped) return line;
    flipped = true;
    return line.replace(/^- \[ \]/, '- [x]');
  });
  if (!flipped) {
    return { ok: false, path, error: { code: 'kb.feedback.missing-index', message: 'No feedback row with index ' + String(index) + '.' } };
  }
  const text = next.join(LF());
  try {
    writeAtomic(path, text);
  } catch (error) {
    return { ok: false, path, error: { code: 'kb.feedback.write-failed', message: String(error instanceof Error ? error.message : error) } };
  }
  return { ok: true, path, bytes: statSync(path).size, index };
}