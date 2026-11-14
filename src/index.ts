import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { createKbDoctorTool } from './tools/kb-doctor.tool.js';
import { createKbIngestTool } from './tools/kb-ingest.tool.js';
import { createKbInventoryTool } from './tools/kb-inventory.tool.js';
import { createKbQueryTool } from './tools/kb-query.tool.js';

/** Stable cordis plugin identity. */
export const name = 'dsh-kb';

export interface KbPluginConfig {
  /** Absolute path of the Obsidian vault. Unset: discover from the working directory. */
  readonly vaultPath?: string;
  /** Off by default; enabling it only allows inbox/ and .wiki/ to change. */
  readonly allowWrites?: boolean;
  /** Python interpreter that can import PyMuPDF (default "python"). */
  readonly pythonPath?: string;
  /** Extra directory on PYTHONPATH when PyMuPDF is installed outside the interpreter. */
  readonly pythonLibPath?: string;
}

interface ToolsRegistry {
  register(definition: unknown): void;
}

interface PluginContext {
  readonly tools: ToolsRegistry;
}

function nearestVault(start: string, maxDepth = 6): string | undefined {
  let current = nodePath.resolve(start);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (existsSync(nodePath.join(current, '.obsidian'))) return current;
    const parent = nodePath.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

export function resolveVaultRoot(config: KbPluginConfig, explicit?: string, cwd: string = process.cwd()): string {
  const fromArgs = explicit !== undefined && explicit.trim() !== '' ? explicit.trim() : undefined;
  const fromConfig = typeof config.vaultPath === 'string' && config.vaultPath.trim() !== '' ? config.vaultPath.trim() : undefined;
  const root = fromArgs ?? fromConfig ?? nearestVault(cwd);
  if (root === undefined) {
    throw new Error('kb.vault.not-found: set vaultPath in the dsh-kb plugin config, pass vaultPath, or start DSH inside an Obsidian vault.');
  }
  return nodePath.resolve(root);
}

export function apply(ctx: PluginContext, config: KbPluginConfig = {}): void {
  const allowWrites = config.allowWrites === true;
  const resolveRoot = (explicit?: string): string => resolveVaultRoot(config, explicit);
  ctx.tools.register(createKbDoctorTool({ allowWrites, resolveRoot }));
  ctx.tools.register(createKbInventoryTool({ allowWrites, resolveRoot }));
  ctx.tools.register(
    createKbIngestTool({
      allowWrites,
      resolveRoot,
      pythonPath: config.pythonPath ?? 'python',
      pythonLibPath: config.pythonLibPath ?? '',
    }),
  );
  ctx.tools.register(createKbQueryTool({ resolveRoot }));
}
