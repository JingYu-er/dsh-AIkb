import { mkdirSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { defaultCommandRunner, pythonEnvOf, type CommandRunner } from './python-env.js';

/** One OCR'd page, split into reading-order paragraphs. */
export interface OcrPage {
  readonly page: number;
  readonly blocks: readonly string[];
}

export interface OcrBookResult {
  readonly pages: readonly OcrPage[];
  readonly textChars: number;
  /** Pages the journal already carried before this run (resume). */
  readonly journalPages: number;
}

export interface OcrBookOptions {
  readonly pythonPath: string;
  readonly workspaceRoot: string;
  /** Absolute path to ocr_book.py, shipped with the plugin. */
  readonly scriptPath: string;
  /** Absolute path of the PDF to read. */
  readonly pdfPath: string;
  /** Page journal (JSONL); derived data that lives outside the notes tree. */
  readonly journalPath: string;
  readonly workers?: number;
  /** 1-based, inclusive. lastPage 0 means "to the end". */
  readonly firstPage?: number;
  readonly lastPage?: number;
  readonly dpi?: number;
  readonly timeoutMs?: number;
}

export interface OcrFailure {
  readonly ok: false;
  readonly error: string;
  readonly stderr: string;
}

export type OcrOutcome = { readonly ok: true; readonly result: OcrBookResult } | OcrFailure;

interface JournalLine {
  readonly page?: number;
  readonly text?: string;
}

function parseJournal(path: string): OcrPage[] {
  const pages: OcrPage[] = [];
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return pages;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const record = JSON.parse(trimmed) as JournalLine;
      if (typeof record.page !== 'number') continue;
      const text = typeof record.text === 'string' ? record.text : '';
      const blocks = text
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter((block) => block !== '');
      pages.push({ page: record.page, blocks });
    } catch {
      continue;
    }
  }
  pages.sort((left, right) => left.page - right.page);
  return pages;
}

/**
 * OCR a scanned PDF.
 *
 * Python owns rendering, detection and reading-order reconstruction; this adapter only
 * builds the command line and turns the page journal back into blocks. Re-running is
 * safe because the script skips pages already present in the journal.
 */
export async function ocrPdf(options: OcrBookOptions, run: CommandRunner = defaultCommandRunner): Promise<OcrOutcome> {
  // The script appends page-by-page; the directory must exist before the first page lands.
  mkdirSync(nodePath.dirname(options.journalPath), { recursive: true });
  const args = [
    options.scriptPath,
    '--pdf', options.pdfPath,
    '--out', options.journalPath,
    '--first', String(options.firstPage ?? 1),
    '--last', String(options.lastPage ?? 0),
    '--workers', String(options.workers ?? 4),
    '--dpi', String(options.dpi ?? 200),
  ];
  const outcome = await run(options.pythonPath, args, {
    env: pythonEnvOf(options.workspaceRoot),
    timeoutMs: options.timeoutMs ?? 6 * 60 * 60 * 1000,
  });
  const pages = parseJournal(options.journalPath);
  if (outcome.code !== 0) {
    return {
      ok: false,
      error: 'ocr process exited ' + outcome.code + (pages.length > 0 ? ' after writing ' + pages.length + ' pages' : ''),
      stderr: (outcome.stderr || outcome.stdout).slice(-4000),
    };
  }
  if (pages.length === 0) {
    return { ok: false, error: 'ocr produced no pages', stderr: (outcome.stderr || '').slice(-4000) };
  }
  const textChars = pages.reduce((sum, page) => sum + page.blocks.reduce((n, block) => n + block.length, 0), 0);
  return { ok: true, result: { pages, textChars, journalPages: pages.length } };
}

/** Journal location for one source; keyed by content hash so a changed file re-OCRs. */
export function ocrJournalPath(workspaceRoot: string, sha256: string): string {
  return nodePath.join(nodePath.resolve(workspaceRoot), 'temp', 'ocr', sha256 + '.jsonl');
}
