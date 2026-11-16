/** Append-only vault log shared by kb_compile, kb_promote, kb_index and kb_link_apply. */

export interface LogFs {
  readText(relPath: string): Promise<string>;
  writeText(relPath: string, content: string): Promise<void>;
}

export const LOG_FILE = 'log.md';

const HEADER = [
  '# 操作日志',
  '',
  '<!-- append-only：由 kb_compile / kb_promote / kb_index / kb_link_apply 追加，请勿手改 -->',
  '',
].join('\n');

/** A log line is pipe-delimited, so both path and summary must not carry pipes or newlines. */
export function sanitiseLogField(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

/** '- <ISO8601> | <action> | <path> | <summary>' — one line, newest last. */
export function logLine(action: string, path: string, summary: string, at: Date = new Date()): string {
  return '- ' + at.toISOString() + ' | ' + sanitiseLogField(action) + ' | ' + sanitiseLogField(path) + ' | ' + sanitiseLogField(summary);
}

/** Append one line, creating log.md with a header when it does not exist yet. Throws on write failure. */
export async function appendLog(fs: LogFs, action: string, path: string, summary: string, at: Date = new Date()): Promise<string> {
  const line = logLine(action, path, summary, at);
  let existing = '';
  try {
    existing = await fs.readText(LOG_FILE);
  } catch {
    existing = '';
  }
  const base = existing.trim() === '' ? HEADER.trim() : existing.replace(/\s+$/, '');
  await fs.writeText(LOG_FILE, base + '\n' + line + '\n');
  return line;
}

/** Logging must never break the operation that triggered it; returns a warning instead. */
export async function appendLogSafe(fs: LogFs, action: string, path: string, summary: string, at: Date = new Date()): Promise<string | undefined> {
  try {
    await appendLog(fs, action, path, summary, at);
    return undefined;
  } catch (error) {
    return 'log append failed: ' + (error instanceof Error ? error.message : String(error));
  }
}
