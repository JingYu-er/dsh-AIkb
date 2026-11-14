import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { ensurePythonEnv } from './adapters/pdf/python-env.js';
import type { PythonEnvReport } from './adapters/pdf/python-env.js';
import { createKbDoctorTool } from './tools/kb-doctor.tool.js';
import { createKbIngestTool } from './tools/kb-ingest.tool.js';
import { createKbInventoryTool } from './tools/kb-inventory.tool.js';
import { createKbQueryTool } from './tools/kb-query.tool.js';

/** Stable cordis plugin identity. */
export const name = 'dsh-kb';

/**
 * Cordis services this plugin needs before apply() runs. Declaring "tools" is what
 * makes ctx.tools exist: a plugin that reads it without injecting it is applied too
 * early and throws, and the whole bundle silently disappears from the tool list.
 */
export const inject = ['tools'];

export interface KbPluginConfig {
  /** Absolute path of the Obsidian vault. Unset: discover from the working directory. */
  readonly vaultPath?: string;
  /** Off by default; enabling it only allows inbox/ and .wiki/ to change. */
  readonly allowWrites?: boolean;
  /** Base interpreter used to create the private venv (must exist). Default "python". */
  readonly pythonPath?: string;
  /** Extra directory on PYTHONPATH when PyMuPDF is installed outside the interpreter. */
  readonly pythonLibPath?: string;
  /** Private venv the plugin prepares for itself. Default <workspaceRoot>/.kb/venv. */
  readonly venvPath?: string;
  /** Directory the venv is anchored to; defaults to the host working directory. */
  readonly workspaceRoot?: string;
  /** pip index for the one-time PyMuPDF install. Default: Tsinghua mirror. */
  readonly pythonMirror?: string;
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
  if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
    throw new Error('dsh-kb: the tools service is unavailable; declare inject = ["tools"] (see src/index.ts)');
  }
  const allowWrites = config.allowWrites === true;
  const resolveRoot = (explicit?: string): string => resolveVaultRoot(config, explicit);
  const workspaceRoot = config.workspaceRoot !== undefined && config.workspaceRoot.trim() !== ''
    ? nodePath.resolve(config.workspaceRoot.trim())
    : process.cwd();
  /** One bootstrap per process: probing is cheap, installing is not. */
  let pythonEnvOnce: Promise<PythonEnvReport> | undefined;
  const pythonEnv = (bootstrap: boolean): Promise<PythonEnvReport> => {
    if (bootstrap && pythonEnvOnce !== undefined) return pythonEnvOnce;
    const options = {
      workspaceRoot,
      pythonPath: config.pythonPath ?? '',
      venvPath: config.venvPath ?? '',
      mirrorUrl: config.pythonMirror ?? '',
      bootstrap,
    };
    const pending = ensurePythonEnv(options);
    if (bootstrap) pythonEnvOnce = pending;
    return pending;
  };

  ctx.tools.register(createKbDoctorTool({ allowWrites, resolveRoot, inspectPython: () => pythonEnv(false) }));
  ctx.tools.register(createKbInventoryTool({ allowWrites, resolveRoot }));
  ctx.tools.register(
    createKbIngestTool({
      allowWrites,
      resolveRoot,
      preparePython: () => pythonEnv(true),
      pythonLibPath: config.pythonLibPath ?? '',
    }),
  );
  ctx.tools.register(createKbQueryTool({ resolveRoot }));
}
