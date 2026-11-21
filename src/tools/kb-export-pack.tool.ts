import * as nodePath from 'node:path';
import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { defaultPackName, nodePackWriter, runExportPack } from '../application/kb-export-pack.js';
import type { PackRefusal, PackReport } from '../application/kb-export-pack.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbExportPackArgs {
  readonly vaultPath?: string;
  readonly name?: string;
  readonly outDir?: string;
}

export interface KbExportPackDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly allowWrites: boolean;
  /** Configured pack directory; empty disables the default destination. */
  readonly packDir: () => string;
}

const LINE_FEED = String.fromCharCode(10);

const OUTPUT_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    // The two shapes are exclusive: a refusal carries only ok/error, a pack carries the rest.
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    packDir: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sources: { type: 'integer', required: true },
        chunks: { type: 'integer', required: true },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

function renderReport(report: PackReport): string {
  if (!report.ok) return 'kb_export_pack refused [' + report.error.code + '] ' + report.error.message;
  const lines = [
    'pack: ' + report.packDir + ' | ' + report.counts.sources + ' source(s), '
      + report.counts.chunks + ' chunk(s) -> ' + report.files.length + ' file(s)',
  ];
  for (const file of report.files) lines.push('  ' + file.name + ' (' + file.bytes + ' B)');
  for (const warning of report.warnings) lines.push('! ' + warning);
  return lines.join(LINE_FEED);
}

function refusal(code: string, message: string): PackRefusal {
  return { ok: false, error: { code, message } };
}

function refusalOf(error: unknown, fallback: string): PackRefusal {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : fallback;
  return { ok: false, error: { code, message } };
}

function isPackName(name: string): boolean {
  return name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes(':');
}

export function createKbExportPackTool(deps: KbExportPackDeps) {
  return defineTool<KbExportPackArgs, PackReport>({
    name: 'kb_export_pack',
    description:
      'Export the already-compiled index as a portable knowledge pack that a reader or another agent can use without this plugin: manifest.json (pack name, generation time, plugin version, vault provenance, per-source counts), chunks.jsonl (one JSON line per chunk: path, page, section, text) and SKILL.md (how to grep it). Deterministic for the same index: sources and chunks are sorted by path then page, and only manifest.generatedAt varies between runs. Writes nowhere but the resolved pack directory; refuses when writes are disabled, no pack directory is configured, or the index has no chunks.',
    parameters: {
      vaultPath: {
        type: 'string',
        description: 'Absolute vault path. Defaults to the plugin config, then the nearest ancestor directory containing .obsidian.',
      },
      name: {
        type: 'string',
        description: "Pack name, also the default directory name. Default pack-YYYYMMDD-HHmmss (local time).",
      },
      outDir: {
        type: 'string',
        description: 'Destination directory: absolute, or relative to the configured pack directory. Default <packDir>/<name>.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      const generatedAt = new Date();
      let root: string;
      try {
        root = deps.resolveRoot(args.vaultPath);
      } catch (error) {
        return refusalOf(error, 'kb.pack.failed');
      }
      if (!deps.allowWrites) {
        return refusal('kb.pack.read-only', 'allowWrites is false: enable it on the KB settings page (Configuration tab) before exporting a pack');
      }
      const configuredPackDir = deps.packDir();
      const outDir = args.outDir === undefined ? '' : args.outDir.trim();
      const name = args.name === undefined ? '' : args.name.trim();
      if (name !== '' && !isPackName(name)) {
        return refusal('kb.pack.invalid-name', 'name must be a single directory name without /, \\ or : (got "' + name + '")');
      }
      const noPackDir = (): PackRefusal => refusal(
        'kb.pack.no-pack-dir',
        'packDir is not configured: open the KB settings page (Configuration tab) and set the pack directory, or pass an absolute outDir',
      );

      let packDir: string;
      if (outDir !== '') {
        if (nodePath.isAbsolute(outDir)) packDir = nodePath.resolve(outDir);
        else if (configuredPackDir === '') return noPackDir();
        else packDir = nodePath.resolve(configuredPackDir, outDir);
      } else if (configuredPackDir === '') {
        return noPackDir();
      } else {
        packDir = nodePath.resolve(configuredPackDir, name !== '' ? name : defaultPackName(generatedAt));
      }

      try {
        return await runExportPack(new NodeVaultFs(root), nodePackWriter, {
          vaultRoot: root,
          vaultName: nodePath.basename(root) === '' ? root : nodePath.basename(root),
          packName: name !== '' ? name : nodePath.basename(packDir),
          packDir,
          generatedAt,
        });
      } catch (error) {
        return refusalOf(error, 'kb.pack.failed');
      }
    },
  });
}
