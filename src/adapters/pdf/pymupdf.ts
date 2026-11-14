import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PageText, TocEntry } from '../../domain/chunking.js';
import { DomainError } from '../../shared/result.js';

export interface PdfExtraction {
  readonly pages: readonly PageText[];
  readonly toc: readonly TocEntry[];
  readonly pageCount: number;
}

export interface PdfExtractOptions {
  readonly pythonPath: string;
  readonly pythonLibPath?: string;
  readonly timeoutMs?: number;
  readonly maxPages?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_SCRIPT = fileURLToPath(new URL('../../../scripts/extract_pdf.py', import.meta.url));

interface RawExtraction {
  readonly pages: readonly { page: number; width: number; height: number; blocks: readonly string[] }[];
  readonly toc: readonly (readonly [number, string, number])[];
  readonly pageCount: number;
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env, windowsHide: true });
    const stdout: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new DomainError('pdf.extract-timeout', 'PDF extraction exceeded ' + timeoutMs + ' ms'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new DomainError('pdf.python-missing', 'cannot start ' + command + ': ' + error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

/** Extract text and outline through PyMuPDF, one process per document. */
export async function extractPdf(pdfPath: string, options: PdfExtractOptions): Promise<PdfExtraction> {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  if (options.pythonLibPath !== undefined && options.pythonLibPath.trim() !== '') {
    const separator = process.platform === 'win32' ? ';' : ':';
    env.PYTHONPATH = options.pythonLibPath + (env.PYTHONPATH ? separator + env.PYTHONPATH : '');
  }
  const args = [DEFAULT_SCRIPT, pdfPath];
  if (options.maxPages !== undefined && options.maxPages > 0) args.push(String(options.maxPages));
  const result = await run(options.pythonPath, args, env, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new DomainError('pdf.extract-failed', 'python exited ' + result.code + ': ' + (result.stderr || result.stdout.toString('utf8').slice(-800)));
  }
  let raw: RawExtraction;
  try {
    raw = JSON.parse(result.stdout.toString('utf8')) as RawExtraction;
  } catch {
    throw new DomainError('pdf.extract-invalid-json', 'extractor did not return JSON: ' + result.stdout.toString('utf8').slice(0, 300));
  }
  const toc: TocEntry[] = raw.toc.map((entry) => ({ level: entry[0], title: entry[1], page: entry[2] }));
  return { pages: raw.pages, toc, pageCount: raw.pageCount };
}
