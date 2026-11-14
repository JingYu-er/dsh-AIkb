import { spawn } from 'node:child_process';
import * as nodePath from 'node:path';
import {
  defaultCommandRunner,
  ensurePythonEnv,
  pythonEnvOf,
  type CommandRunner,
  type PythonEnvOptions,
} from './python-env.js';

/** Result of making a Python environment that can run the OCR script. */
export interface OcrEnvReport {
  readonly ok: boolean;
  readonly pythonPath: string;
  readonly rapidocrVersion: string;
  readonly installed: boolean;
  readonly actions: readonly string[];
  readonly errors: readonly string[];
}

export interface OcrEnvOptions {
  readonly workspaceRoot: string;
  readonly pythonPath?: string;
  readonly venvPath?: string;
  readonly mirrorUrl?: string;
  /** Install RapidOCR when it is missing. Off for read-only checks. */
  readonly bootstrap?: boolean;
}

const OCR_PROBE =
  'import sys,importlib.metadata as m;m.version("rapidocr-onnxruntime");sys.stdout.write(m.version("rapidocr-onnxruntime"))';
const OCR_PACKAGE = 'rapidocr-onnxruntime';
const DEFAULT_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';

interface ProbeResult {
  readonly ok: boolean;
  readonly version: string;
  readonly error: string;
}

async function probeOcr(run: CommandRunner, pythonPath: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProbeResult> {
  try {
    const outcome = await run(pythonPath, ['-c', OCR_PROBE], { env, timeoutMs });
    if (outcome.code === 0) {
      const version = outcome.stdout.trim();
      return { ok: true, version: version === '' ? 'unknown' : version, error: '' };
    }
    return { ok: false, version: '', error: (outcome.stderr || outcome.stdout || 'exit ' + outcome.code).slice(-800) };
  } catch (error) {
    return { ok: false, version: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve an interpreter that can import RapidOCR.
 *
 * PyMuPDF is resolved first (the OCR script renders pages with it), then RapidOCR.
 * The plugin never asks the user to pip install anything by hand: with bootstrap on,
 * the missing package goes into the same private venv the PDF extractor uses.
 */
export async function ensureOcrEnv(options: OcrEnvOptions, run: CommandRunner = defaultCommandRunner): Promise<OcrEnvReport> {
  const workspaceRoot = nodePath.resolve(options.workspaceRoot);
  const env = pythonEnvOf(workspaceRoot);
  const actions: string[] = [];
  const errors: string[] = [];
  const pythonOptions: PythonEnvOptions = {
    workspaceRoot,
    bootstrap: options.bootstrap,
    ...(options.pythonPath !== undefined ? { pythonPath: options.pythonPath } : {}),
    ...(options.venvPath !== undefined ? { venvPath: options.venvPath } : {}),
    ...(options.mirrorUrl !== undefined ? { mirrorUrl: options.mirrorUrl } : {}),
  };
  const base = await ensurePythonEnv(pythonOptions, run);
  for (const action of base.actions) actions.push(action);
  if (!base.ok) {
    for (const error of base.errors) errors.push(error);
    return { ok: false, pythonPath: '', rapidocrVersion: '', installed: false, actions, errors };
  }

  const first = await probeOcr(run, base.pythonPath, env, 20000);
  if (first.ok) {
    actions.push('probe ' + base.pythonPath + ' -> RapidOCR ' + first.version);
    return { ok: true, pythonPath: base.pythonPath, rapidocrVersion: first.version, installed: false, actions, errors };
  }
  actions.push('probe ' + base.pythonPath + ' -> no RapidOCR (' + first.error + ')');
  if (options.bootstrap !== true) {
    errors.push(base.pythonPath + ': ' + first.error);
    return { ok: false, pythonPath: '', rapidocrVersion: '', installed: false, actions, errors };
  }

  const mirror = options.mirrorUrl !== undefined && options.mirrorUrl.trim() !== '' ? options.mirrorUrl.trim() : DEFAULT_MIRROR;
  const attempts: { label: string; args: string[] }[] = [
    { label: mirror, args: ['-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', '-i', mirror, OCR_PACKAGE] },
    { label: 'pypi.org', args: ['-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', OCR_PACKAGE] },
  ];
  for (const attempt of attempts) {
    const installed = await run(base.pythonPath, attempt.args, { env, timeoutMs: 600000 });
    if (installed.code !== 0) {
      errors.push('pip via ' + attempt.label + ' failed: ' + (installed.stderr || 'exit ' + installed.code).slice(-800));
      actions.push('pip via ' + attempt.label + ' failed');
      continue;
    }
    actions.push('installed ' + OCR_PACKAGE + ' from ' + attempt.label);
    const second = await probeOcr(run, base.pythonPath, env, 20000);
    if (second.ok) {
      return { ok: true, pythonPath: base.pythonPath, rapidocrVersion: second.version, installed: true, actions, errors };
    }
    errors.push('post-install probe failed: ' + second.error);
  }
  return { ok: false, pythonPath: '', rapidocrVersion: '', installed: false, actions, errors };
}

void spawn;
