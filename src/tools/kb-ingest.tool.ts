import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { NodeVaultWriter } from '../adapters/fs/node-vault-writer.js';
import { ocrJournalPath, ocrPdf } from '../adapters/pdf/ocr.js';
import type { OcrEnvReport } from '../adapters/pdf/ocr-env.js';
import { extractPdf } from '../adapters/pdf/pymupdf.js';
import type { PythonEnvReport } from '../adapters/pdf/python-env.js';
import { emptyIngestReport, runIngest } from '../application/kb-ingest.js';
import type { ExtractedBook, IngestEntry, IngestReport } from '../application/kb-ingest.js';
import { DomainError } from '../shared/result.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';

export interface KbIngestArgs {
  readonly vaultPath?: string;
  readonly limit?: number;
  readonly pathPrefix?: string;
  readonly paths?: readonly string[];
  readonly force?: boolean;
}

export interface KbIngestDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: boolean;
  /** Probes the interpreter and, when needed, creates the venv and installs PyMuPDF. */
  readonly preparePython: () => Promise<PythonEnvReport>;
  readonly pythonLibPath: string;
  /** Root that owns .kb/ and temp/ (the OCR journal); not the vault itself. */
  readonly workspaceRoot: string;
  /** Resolves RapidOCR (installing it on first use); absent turns the OCR fallback off. */
  readonly prepareOcr?: () => Promise<OcrEnvReport>;
  readonly ocrWorkers: number;
  /** Page cap per book for the first OCR experiment; absent means the whole book. */
  readonly ocrMaxPages?: number;
}

/** dist/tools/*.js -> plugin root (one level up per directory); ocr_book.py ships in scripts/. */
const OCR_SCRIPT_PATH = fileURLToPath(new URL('../../scripts/ocr_book.py', import.meta.url));

function nativePath(root: string, relPath: string): string {
  return join(root, relPath.split('/').join(process.platform === 'win32' ? String.fromCharCode(92) : '/'));
}

const LINE_FEED = String.fromCharCode(10);

const OUTPUT_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
    },
    vaultRoot: { type: 'string', required: true },
    python: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pythonPath: { type: 'string', required: true },
        source: { type: 'string', required: true },
        venvPath: { type: 'string', required: true },
        bootstrapped: { type: 'boolean', required: true },
      },
    },
    ocr: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        pythonPath: { type: 'string', required: true },
        rapidocrVersion: { type: 'string', required: true },
        installed: { type: 'boolean', required: true },
      },
    },
    books: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          sha256: { type: 'string', required: true },
          pages: { type: 'integer', required: true },
          chunks: { type: 'integer', required: true },
          tokens: { type: 'integer', required: true },
          skipped: { type: 'boolean', required: true },
          ocrUsed: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
    },
    totals: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        books: { type: 'integer', required: true },
        pages: { type: 'integer', required: true },
        chunks: { type: 'integer', required: true },
        tokens: { type: 'integer', required: true },
      },
    },
    elapsedMs: { type: 'integer', required: true },
  },
};

function renderReport(report: IngestReport): string {
  if (!report.ok) return 'kb_ingest FAILED ' + (report.error?.code ?? 'unknown') + ': ' + (report.error?.message ?? '');
  const lines: string[] = [];
  if (report.python !== undefined) {
    lines.push('python: ' + report.python.pythonPath + ' (' + report.python.source + (report.python.bootstrapped ? ', installed just now' : '') + ')');
  }
  if (report.ocr !== undefined) {
    lines.push('ocr: RapidOCR ' + report.ocr.rapidocrVersion + ' via ' + report.ocr.pythonPath + (report.ocr.installed ? ' (installed just now)' : ''));
  }
  lines.push('ingested ' + report.totals.books + ' book(s): ' + report.totals.pages + ' pages, ' + report.totals.chunks + ' chunks, ~' + report.totals.tokens + ' tokens');
  for (const book of report.books.slice(0, 10)) {
    if (book.error !== undefined) lines.push('FAILED ' + book.path + ': ' + book.error);
    else if (book.skipped) lines.push('skip (indexed) ' + book.path);
    else lines.push('ok ' + book.path + ' -> ' + book.pages + 'p/' + book.chunks + ' chunks' + (book.ocrUsed === true ? ' [OCR]' : ''));
  }
  if (report.books.length > 10) lines.push('... ' + (report.books.length - 10) + ' more');
  lines.push('elapsed: ' + report.elapsedMs + ' ms');
  return lines.join(LINE_FEED);
}

export function createKbIngestTool(deps: KbIngestDeps) {
  return defineTool<KbIngestArgs, IngestReport>({
    name: 'kb_ingest',
    description:
      'Compile selected PDF sources into the search index: prepare the private Python environment (create .kb/venv and install PyMuPDF on first use), extract page text, cut page-scoped chunks (never crossing a page), and write .wiki/index/<sha256>.jsonl plus the catalog. Scanned books fall back to local OCR (RapidOCR, no tokens, installed on first use) when the text layer is too thin. Incremental by content hash; requires writes enabled. Sources are cited by path + page, never copied into notes.',
    parameters: {
      vaultPath: { type: 'string', description: 'Absolute vault path. Defaults to the plugin config, then vault discovery.' },
      limit: { type: 'integer', description: 'Ingest at most this many sources from the manifest.' },
      pathPrefix: { type: 'string', description: 'Only sources whose vault-relative path starts with this prefix.' },
      paths: { type: 'array', description: 'Exact vault-relative source paths to ingest.', items: { type: 'string' } },
      force: { type: 'boolean', description: 'Re-extract even when a chunk file for the same content hash exists.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, report) => [{ type: 'text', text: renderReport(report) }] },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        if (!deps.allowWrites) throw new DomainError('kb.writes-disabled', 'enable allowWrites in the plugin config to write the index');
        const python = await deps.preparePython();
        if (!python.ok) {
          throw new DomainError(
            'pdf.python-missing',
            'no Python with PyMuPDF and the automatic setup failed: ' + (python.errors.join(' | ') || 'unknown reason'),
          );
        }
        let ocrInfo: IngestReport['ocr'];
        let ocr: ((entry: IngestEntry) => Promise<ExtractedBook | undefined>) | undefined;
        if (deps.prepareOcr !== undefined) {
          const ocrEnv = await deps.prepareOcr();
          ocrInfo = {
            ok: ocrEnv.ok,
            pythonPath: ocrEnv.pythonPath,
            rapidocrVersion: ocrEnv.rapidocrVersion,
            installed: ocrEnv.installed,
          };
          if (!ocrEnv.ok) {
            throw new DomainError('pdf.ocr-unavailable', 'RapidOCR is unavailable and the automatic setup failed: ' + (ocrEnv.errors.join(' | ') || 'unknown reason'));
          }
          const pythonPath = ocrEnv.pythonPath;
          const workers = deps.ocrWorkers;
          const maxPages = deps.ocrMaxPages;
          ocr = async (entry: IngestEntry): Promise<ExtractedBook> => {
            const outcome = await ocrPdf({
              pythonPath,
              workspaceRoot: deps.workspaceRoot,
              scriptPath: OCR_SCRIPT_PATH,
              pdfPath: nativePath(root, entry.path),
              journalPath: ocrJournalPath(deps.workspaceRoot, entry.sha256),
              workers,
              ...(maxPages !== undefined && maxPages > 0 ? { lastPage: maxPages } : {}),
            });
            if (!outcome.ok) throw new DomainError('pdf.ocr-failed', entry.path + ': ' + outcome.error + ' | ' + outcome.stderr.slice(-500));
            return {
              pages: outcome.result.pages.map((page) => ({ page: page.page, width: 0, height: 0, blocks: page.blocks })),
              toc: [],
              textChars: outcome.result.textChars,
            };
          };
        }
        const vaultFs = new NodeVaultFs(root);
        const writer = new NodeVaultWriter(root);
        const fs = {
          root,
          exists: (relPath: string) => vaultFs.exists(relPath),
          readText: (relPath: string) => vaultFs.readText(relPath),
          writeText: (relPath: string, content: string) => writer.writeText(relPath, content),
          remove: async (relPath: string) => {
            if (!relPath.startsWith('.wiki/index/')) throw new DomainError('vault.write-denied', 'refusing to remove outside .wiki/index: ' + relPath);
            await rm(nativePath(root, relPath), { force: true });
          },
        };
        const report = await runIngest(
          fs,
          (entry) => extractPdf(nativePath(root, entry.path), {
            pythonPath: python.pythonPath,
            pythonLibPath: deps.pythonLibPath,
          }),
          {
            limit: args.limit,
            pathPrefix: args.pathPrefix,
            paths: args.paths,
            force: args.force,
            ...(ocr !== undefined ? { ocr } : {}),
          },
        );
        return {
          ...report,
          python: { pythonPath: python.pythonPath, source: python.source, venvPath: python.venvPath, bootstrapped: python.bootstrapped },
          ...(ocrInfo !== undefined ? { ocr: ocrInfo } : {}),
        };
      } catch (error) {
        return emptyIngestReport(root, error);
      }
    },
  });
}
