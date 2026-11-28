import * as nodePath from 'node:path';
import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { NodeVaultWriter } from '../adapters/fs/node-vault-writer.js';
import { loadConfig, saveConfig } from '../application/config-store.js';
import type { KbConfigOverrides } from '../application/config-store.js';
import { createVault, parseTemplate, planRegistration } from '../application/kb-init.js';
import { runBootstrap } from '../application/vault-bootstrap.js';
import type { BootstrapReport } from '../application/vault-bootstrap.js';
import type { InitVaultResult, VaultTemplate } from '../application/kb-init.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbInitArgs {
  readonly action?: 'create' | 'bootstrap';
  readonly dir?: string;
  readonly name?: string;
  readonly template?: VaultTemplate;
  readonly activate?: boolean;
}

export interface KbInitDeps {
  /** Config layer overrides (plugin patch), so the tool reads the same document the tools do. */
  readonly overrides: () => KbConfigOverrides;
  /** Resolve a vault address (empty = active vault) to a root directory. */
  readonly resolveRoot: (address: string) => string;
}

export interface KbInitReport {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly message: string };
  readonly vault?: { readonly name: string; readonly dir: string; readonly template: string; readonly created: string[] };
  readonly registered?: { readonly id: string; readonly name: string; readonly active: boolean; readonly alreadyRegistered: boolean };
  readonly configRevision?: string;
  readonly bootstrap?: BootstrapReport;
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
    vault: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', required: true },
        dir: { type: 'string', required: true },
        template: { type: 'string', required: true },
        created: { type: 'array', items: { type: 'string' }, required: true },
      },
    },
    registered: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        active: { type: 'boolean', required: true },
        alreadyRegistered: { type: 'boolean', required: true },
      },
    },
    configRevision: { type: 'string' },
    bootstrap: { type: 'json' },
  },
};

function renderReport(report: KbInitReport): string {
  if (!report.ok) return 'kb_init refused [' + (report.error?.code ?? 'kb.init.failed') + '] ' + (report.error?.message ?? '');
  if (report.bootstrap !== undefined) {
    const result = report.bootstrap;
    if (!result.ok) return 'bootstrap refused [' + (result.error?.code ?? 'kb.bootstrap.failed') + '] ' + (result.error?.message ?? '');
    const lines = [
      'map: ' + (result.map?.docs ?? 0) + ' docs · ' + (result.map?.pages ?? 0) + ' pages · '
        + (result.map?.sections ?? 0) + ' sections · ' + (result.map?.entities ?? 0) + ' entities',
    ];
    if (result.profile !== undefined) {
      lines.push('profile: ' + result.profile.taxonomy + ' taxonomy · ' + result.profile.synonyms + ' synonyms · ' + result.profile.policy + ' policy');
    }
    if ((result.missingSources ?? []).length > 0) {
      lines.push('index and disk disagree on ' + result.missingSources.length + ' source(s): ' + result.missingSources.slice(0, 5).join(', '));
    }
    if ((result.map?.unparsed ?? []).length > 0) {
      lines.push('unparsed documents: ' + result.map?.unparsed.length + ' (rerun kb_ingest if that is unexpected)');
    }
    lines.push('next: kb_query for a question, kb_map for enumeration, kb_facts for comparisons');
    return lines.join(LINE_FEED);
  }
  const vault = report.vault!;
  const lines = ['vault: ' + vault.dir + ' | ' + vault.template + ' | ' + vault.created.length + ' item(s) created'];
  for (const item of vault.created) lines.push('  ' + item);
  if (report.registered !== undefined) {
    lines.push(report.registered.alreadyRegistered
      ? 'registered: ' + report.registered.id + ' (already in the config)'
      : 'registered: ' + report.registered.id + (report.registered.active ? ' (now the active vault)' : ''));
  }
  if (report.configRevision !== undefined) lines.push('config revision: ' + report.configRevision);
  return lines.join(LINE_FEED);
}

export function createKbInitTool(deps: KbInitDeps) {
  return defineTool<KbInitArgs, KbInitReport>({
    name: 'kb_init',
    description:
      'Create a new knowledge base (Obsidian marker, template folders, vault sheet, README/index, config registration), or with action:"bootstrap" rebuild the L1 map and the learned taxonomy/synonyms/policy for a vault that has already been ingested, then report coverage. create refuses a non-empty directory, a relative path, or disabled writes; bootstrap writes only index sidecars and never deletes anything.',
    parameters: {
      action: {
        type: 'string',
        enum: ['create', 'bootstrap'],
        description: 'create (default) makes a new vault; bootstrap rebuilds the map and the learned profile for an already-ingested vault.',
      },
      dir: { type: 'string', description: 'create: absolute path of the new vault directory (may not exist yet; if it does it must be empty). bootstrap: optional vault directory, default the active vault.' },
      name: { type: 'string', description: 'Display name; defaults to the directory name and is also the base of the vault id.' },
      template: {
        type: 'string',
        enum: ['notes', 'books', 'both', 'blank'],
        description: 'Folder layout: notes (notes + sources), books (books + sources), both, or blank. Default notes. The vault sheet is written in every case.',
      },
      activate: { type: 'boolean', description: 'Make the new vault the active one. Default true.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      if ((args.action ?? 'create') === 'bootstrap') {
        let root = '(unresolved)';
        try {
          root = deps.resolveRoot(args.dir === undefined ? '' : String(args.dir));
          const result = await runBootstrap(new NodeVaultFs(root), new NodeVaultWriter(root));
          return { ok: result.ok, bootstrap: result, ...(result.ok ? {} : { error: result.error }) };
        } catch (error) {
          return {
            ok: false,
            error: { code: 'kb.bootstrap.failed', message: error instanceof Error ? error.message : String(error) },
          };
        }
      }
      const overrides = deps.overrides();
      const loaded = loadConfig(overrides);
      const created: InitVaultResult = createVault({
        dir: String(args.dir ?? ''),
        name: args.name,
        template: parseTemplate(args.template as string | undefined),
        allowWrites: loaded.config.allowWrites,
      });
      if (!created.ok || created.vault === undefined) {
        return { ok: false, error: created.error! };
      }
      const vault = created.vault;
      const plan = planRegistration(loaded, { dir: vault.dir, name: vault.name, activate: args.activate !== false });
      if (!plan.alreadyRegistered || plan.patch.activeVault !== loaded.config.activeVault) {
        const saved = await saveConfig(plan.patch, { expectRevision: plan.revision, overrides });
        if (!saved.ok) {
          return {
            ok: false,
            vault,
            error: {
              code: 'kb.init.register-failed',
              message: 'The vault was created at ' + vault.dir + ' but could not be registered: '
                + (saved.error ?? JSON.stringify(saved.problems)),
            },
          };
        }
        return {
          ok: true,
          vault,
          registered: { id: plan.entry.id, name: plan.entry.name, active: plan.patch.activeVault === plan.entry.id, alreadyRegistered: false },
          configRevision: saved.revision,
        };
      }
      return {
        ok: true,
        vault,
        registered: { id: plan.entry.id, name: plan.entry.name, active: plan.entry.id === loaded.config.activeVault, alreadyRegistered: true },
        configRevision: plan.revision,
      };
    },
  });
}
