import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { failedDoctorReport, runDoctor } from '../application/kb-doctor.js';
import type { DoctorReport } from '../application/kb-doctor.js';
import type { SchemaNode } from './definition.js';
import { defineTool } from './definition.js';

export interface KbDoctorArgs {
  readonly vaultPath?: string;
}

export interface KbDoctorDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: boolean;
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
  lines.push('books manifest: ' + (report.booksManifest.present ? report.booksManifest.entries + ' entries' : 'missing'));
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
        return await runDoctor(vaultFs, { allowWrites: deps.allowWrites });
      } catch (error) {
        return failedDoctorReport(root, error);
      }
    },
  });
}
