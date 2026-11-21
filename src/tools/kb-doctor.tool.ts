import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { configSnapshot } from '../application/config-store.js';
import { failedDoctorReport, runDoctor } from '../application/kb-doctor.js';
import type { DoctorReport } from '../application/kb-doctor.js';
import type { PythonEnvReport } from '../adapters/pdf/python-env.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';

export interface KbDoctorArgs {
  readonly vaultPath?: string;
}

export interface KbDoctorDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: boolean;
  /** Probe only: kb_doctor never installs anything. */
  readonly inspectPython?: () => Promise<PythonEnvReport>;
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
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    vaultRoot: { type: 'string', required: true },
    vaultName: { type: 'string', required: true },
    counts: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        markdown: { type: 'integer', required: true },
        sources: { type: 'integer', required: true },
        sourceBytes: { type: 'integer', required: true },
        images: { type: 'integer', required: true },
        attachments: { type: 'integer', required: true },
      },
    },
    layout: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        inbox: { type: 'boolean', required: true },
        wiki: { type: 'boolean', required: true },
        git: { type: 'boolean', required: true },
      },
    },
    booksManifest: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        present: { type: 'boolean', required: true },
        entries: { type: 'integer', required: true },
      },
    },
    byExtension: {
      type: 'object',
      required: true,
      additionalProperties: true,
      properties: {},
      description: 'File counts keyed by lower-case extension (md, pdf, png, ...).',
    },
    index: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cacheBytes: { type: 'integer', required: true },
        cacheModifiedAt: { type: 'string', required: true },
        catalogSources: { type: 'integer', required: true },
        catalogChunks: { type: 'integer', required: true },
        chunkFiles: { type: 'integer', required: true },
        orphanChunkFiles: { type: 'integer', required: true },
        missingChunkFiles: { type: 'integer', required: true },
        emptySources: { type: 'integer', required: true },
        vectorFiles: { type: 'integer', required: true },
        missingVectors: { type: 'integer', required: true },
        staleVectors: { type: 'integer', required: true },
      },
    },
    python: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        pythonPath: { type: 'string', required: true },
        source: { type: 'string', required: true },
        venvPath: { type: 'string', required: true },
        pymupdfVersion: { type: 'string', required: true },
        bootstrapped: { type: 'boolean', required: true },
        errors: { type: 'array', items: { type: 'string' } },
      },
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        exists: { type: 'boolean', required: true },
        bytes: { type: 'number', required: true },
        updatedAt: { type: 'number', required: true },
      },
    },
    checks: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['pass', 'warn', 'fail'] },
          detail: { type: 'string', required: true },
        },
      },
    },
    config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        revision: { type: 'string', required: true },
        configComplete: { type: 'boolean', required: true },
        missing: { type: 'array', required: true, items: { type: 'string' } },
        warnings: { type: 'array', required: true, items: { type: 'string' } },
        sources: { type: 'array', required: true, items: { type: 'string' } },
        activeVault: { type: 'string', required: true },
        vaults: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
              dir: { type: 'string', required: true },
              exists: { type: 'boolean', required: true },
              active: { type: 'boolean', required: true },
            },
          },
        },
        toolchain: {
          type: 'object',
          additionalProperties: false,
          properties: {
            root: { type: 'string', required: true },
            venv: { type: 'string', required: true },
            models: { type: 'string', required: true },
            ocr: { type: 'string', required: true },
            embed: { type: 'string', required: true },
            rerank: { type: 'string', required: true },
            logs: { type: 'string', required: true },
          },
        },
      },
    },
    writesEnabled: { type: 'boolean', required: true },
    nextActions: { type: 'array', required: true, items: { type: 'string' } },
  },
};

function renderReport(report: DoctorReport): string {
  const lines: string[] = [];
  if (!report.ok) {
    lines.push('kb_doctor FAILED ' + (report.error?.code ?? 'unknown') + ': ' + (report.error?.message ?? ''));
    for (const action of report.nextActions) lines.push('next: ' + action);
    return lines.join(LINE_FEED);
  }
  lines.push('vault: ' + report.vaultRoot + ' (' + report.vaultName + ')');
  lines.push(
    'notes: ' + report.counts.markdown +
    ' | sources: ' + report.counts.sources + ' (' + Math.round(report.counts.sourceBytes / 1048576) + ' MiB)' +
    ' | images: ' + report.counts.images,
  );
  lines.push('writes: ' + (report.writesEnabled ? 'enabled (inbox/, .wiki/)' : 'read-only'));
  if (report.config !== undefined) {
    const config = report.config;
    const vault = config.vaults.find((entry) => entry.active);
    lines.push(
      'config: ' + config.path + ' | ' + (config.configComplete ? 'complete' : 'missing ' + config.missing.join(', ')) +
      ' | vault: ' + (vault === undefined ? 'none' : vault.name + ' -> ' + vault.dir + (vault.exists ? '' : ' (missing)')) +
      ' | toolchain: ' + config.toolchain.root,
    );
    for (const warning of config.warnings) lines.push('config warning: ' + warning);
  }
  if (report.schema !== undefined) {
    lines.push('sheet: ' + report.schema.path + ' | ' + (report.schema.exists ? report.schema.bytes + ' bytes' : 'absent (add page rules in the KB settings page)'));
  }
  lines.push('books manifest: ' + (report.booksManifest.present ? report.booksManifest.entries + ' entries' : 'missing'));
  if (report.python !== undefined) {
    const python = report.python;
    lines.push(
      'python: ' + (python.ok
        ? python.source + ' -> ' + python.pythonPath + ' (PyMuPDF ' + python.pymupdfVersion + ')'
        : 'not ready (kb_ingest will create ' + python.venvPath + ' and install PyMuPDF)'),
    );
  }
  for (const check of report.checks) {
    lines.push('[' + check.status + '] ' + check.id + ': ' + check.detail);
  }
  if (report.nextActions.length > 0) {
    lines.push('next:');
    for (const action of report.nextActions) lines.push('- ' + action);
  }
  return lines.join(LINE_FEED);
}

export function createKbDoctorTool(deps: KbDoctorDeps) {
  return defineTool<KbDoctorArgs, DoctorReport>({
    name: 'kb_doctor',
    description:
      'Diagnose the Obsidian knowledge base before any indexing: checks the vault root and the .obsidian marker, counts notes and source documents, verifies the inbox/ and .wiki/ write targets, and reports whether the book inventory exists. Read-only; it never modifies the vault, and a broken environment is returned as a report rather than thrown.',
    parameters: {
      vaultPath: {
        type: 'string',
        description: 'Absolute vault path. Defaults to the plugin config, then the nearest ancestor directory containing .obsidian.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        const vaultFs = new NodeVaultFs(root);
        const report = await runDoctor(vaultFs, { allowWrites: deps.allowWrites });
        const config = configSnapshot();
        const withConfig = config === undefined ? report : { ...report, config };
        if (deps.inspectPython === undefined) return withConfig;
        const python = await deps.inspectPython();
        const checks = [
          ...report.checks,
          {
            id: 'python.pymupdf',
            status: python.ok ? ('pass' as const) : ('warn' as const),
            detail: python.ok
              ? python.source + ': ' + python.pythonPath + ' (PyMuPDF ' + python.pymupdfVersion + ')'
              : 'no interpreter with PyMuPDF yet; first kb_ingest creates ' + python.venvPath + ' and installs it',
          },
        ];
        const nextActions = [...report.nextActions];
        if (!python.ok) nextActions.push('run kb_ingest once to prepare Python (venv at ' + python.venvPath + ')');
        return {
          ...withConfig,
          checks,
          nextActions,
          python: {
            ok: python.ok,
            pythonPath: python.pythonPath,
            source: python.source,
            venvPath: python.venvPath,
            pymupdfVersion: python.pymupdfVersion,
            bootstrapped: python.bootstrapped,
            errors: python.errors,
          },
        };
      } catch (error) {
        return failedDoctorReport(root, error);
      }
    },
  });
}
