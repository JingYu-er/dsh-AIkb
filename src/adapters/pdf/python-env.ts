import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';

/** Where the interpreter that can import PyMuPDF came from. */
export type PythonEnvSource = 'configured' | 'venv' | 'system' | 'bootstrapped' | 'none';

export interface PythonEnvOptions {
  /** Directory that holds the plugin runtime state; the default venv lives in <workspaceRoot>/.kb/venv. */
  readonly workspaceRoot: string;
  /** Explicit interpreter from the plugin config; wins when it can import PyMuPDF. */
  readonly pythonPath?: string;
  /** Override the venv location. */
  readonly venvPath?: string;
  /** pip index used for the bootstrap install; defaults to a mainland China mirror. */
  readonly mirrorUrl?: string;
  /** Create the venv and install PyMuPDF when no interpreter works. Off for read-only checks. */
  readonly bootstrap?: boolean;
  readonly probeTimeoutMs?: number;
  readonly installTimeoutMs?: number;
}

export interface PythonEnvReport {
  readonly ok: boolean;
  readonly pythonPath: string;
  readonly source: PythonEnvSource;
  readonly venvPath: string;
  readonly pymupdfVersion: string;
  readonly bootstrapped: boolean;
  /** Human-readable log of what the probe/bootstrap did, in order. */
  readonly actions: readonly string[];
  readonly errors: readonly string[];
}

export interface CommandOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
) => Promise<CommandOutcome>;

const DEFAULT_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
const PROBE_CODE = 'import pymupdf,sys;sys.stdout.write(getattr(pymupdf,"__version__","unknown"))';

function truncate(value: string, limit = 600): string {
  return value.length <= limit ? value : value.slice(-limit);
}

/** Spawn without a shell; a missing interpreter is an outcome, not an exception. */
export const defaultCommandRunner: CommandRunner = (command, args, options) =>
  new Promise<CommandOutcome>((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], { env: options.env, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr: truncate(stderr + ' [timeout after ' + options.timeoutMs + ' ms]') });
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-200_000);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: truncate(error.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

export function venvPythonPath(venvPath: string): string {
  return process.platform === 'win32'
    ? nodePath.join(venvPath, 'Scripts', 'python.exe')
    : nodePath.join(venvPath, 'bin', 'python');
}

export function defaultVenvPath(workspaceRoot: string): string {
  return nodePath.join(nodePath.resolve(workspaceRoot), '.kb', 'venv');
}

/**
 * Build the child environment. pip needs a writable TEMP: inside a restricted host the
 * default one is denied, so the workspace temp directory is preferred when it exists.
 */
export function pythonEnvOf(workspaceRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
  const localTemp = nodePath.join(nodePath.resolve(workspaceRoot), 'temp');
  if (existsSync(localTemp)) {
    env.TEMP = localTemp;
    env.TMP = localTemp;
  }
  return env;
}

interface ProbeResult {
  readonly ok: boolean;
  readonly version: string;
  readonly error: string;
}

async function probe(run: CommandRunner, pythonPath: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProbeResult> {
  try {
    const outcome = await run(pythonPath, ['-c', PROBE_CODE], { env, timeoutMs });
    if (outcome.code === 0) {
      const version = outcome.stdout.trim();
      return { ok: true, version: version === '' ? 'unknown' : version, error: '' };
    }
    return { ok: false, version: '', error: truncate(outcome.stderr || outcome.stdout || 'exit ' + outcome.code) };
  } catch (error) {
    return { ok: false, version: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Find a Python that imports PyMuPDF, optionally preparing one.
 *
 * The plugin must not ask the user to pip install anything: on first use it creates a
 * private venv under the workspace and installs PyMuPDF into it. Probing is always
 * non-destructive; only bootstrap=true writes.
 */
export async function ensurePythonEnv(options: PythonEnvOptions, run: CommandRunner = defaultCommandRunner): Promise<PythonEnvReport> {
  const workspaceRoot = nodePath.resolve(options.workspaceRoot);
  const venvPath = options.venvPath !== undefined && options.venvPath.trim() !== ''
    ? nodePath.resolve(options.venvPath.trim())
    : defaultVenvPath(workspaceRoot);
  const venvPython = venvPythonPath(venvPath);
  const configured = options.pythonPath?.trim() ?? '';
  const env = pythonEnvOf(workspaceRoot);
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const actions: string[] = [];
  const errors: string[] = [];

  const candidates: { path: string; source: PythonEnvSource }[] = [];
  if (configured !== '' && configured !== venvPython && configured !== 'python') candidates.push({ path: configured, source: 'configured' });
  candidates.push({ path: venvPython, source: 'venv' });
  if (configured !== '') candidates.push({ path: configured, source: 'configured' });
  candidates.push({ path: 'python', source: 'system' });

  for (const candidate of candidates) {
    const result = await probe(run, candidate.path, env, probeTimeoutMs);
    if (result.ok) {
      actions.push('probe ' + candidate.path + ' -> PyMuPDF ' + result.version);
      return { ok: true, pythonPath: candidate.path, source: candidate.source, venvPath, pymupdfVersion: result.version, bootstrapped: false, actions, errors };
    }
    actions.push('probe ' + candidate.path + ' -> unusable (' + result.error + ')');
    errors.push(candidate.path + ': ' + result.error);
  }

  if (options.bootstrap !== true) {
    return { ok: false, pythonPath: '', source: 'none', venvPath, pymupdfVersion: '', bootstrapped: false, actions, errors };
  }

  const base = configured !== '' ? configured : 'python';
  const baseCheck = await run(base, ['-V'], { env, timeoutMs: probeTimeoutMs });
  if (baseCheck.code !== 0) {
    errors.push('no bootstrap interpreter: ' + base + ' -> ' + truncate(baseCheck.stderr || 'exit ' + baseCheck.code));
    return { ok: false, pythonPath: '', source: 'none', venvPath, pymupdfVersion: '', bootstrapped: false, actions, errors };
  }
  actions.push('bootstrap interpreter: ' + base + ' (' + (baseCheck.stdout || baseCheck.stderr).trim() + ')');

  if (!existsSync(venvPython)) {
    const created = await run(base, ['-m', 'venv', venvPath], { env, timeoutMs: installTimeoutMs });
    if (created.code !== 0) {
      errors.push('venv create failed: ' + truncate(created.stderr || 'exit ' + created.code));
      return { ok: false, pythonPath: '', source: 'none', venvPath, pymupdfVersion: '', bootstrapped: false, actions, errors };
    }
    actions.push('created venv ' + venvPath);
  }

  const mirror = options.mirrorUrl !== undefined && options.mirrorUrl.trim() !== '' ? options.mirrorUrl.trim() : DEFAULT_MIRROR;
  const attempts: { label: string; args: string[] }[] = [
    { label: mirror, args: ['-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', '-i', mirror, 'pymupdf'] },
    { label: 'pypi.org', args: ['-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', 'pymupdf'] },
  ];
  for (const attempt of attempts) {
    const installed = await run(venvPython, attempt.args, { env, timeoutMs: installTimeoutMs });
    if (installed.code === 0) {
      actions.push('installed pymupdf from ' + attempt.label);
      const result = await probe(run, venvPython, env, probeTimeoutMs);
      if (result.ok) {
        return { ok: true, pythonPath: venvPython, source: 'bootstrapped', venvPath, pymupdfVersion: result.version, bootstrapped: true, actions, errors };
      }
      errors.push('post-install probe failed: ' + result.error);
    } else {
      errors.push('pip via ' + attempt.label + ' failed: ' + truncate(installed.stderr || 'exit ' + installed.code));
      actions.push('pip via ' + attempt.label + ' failed');
    }
  }

  return { ok: false, pythonPath: '', source: 'none', venvPath, pymupdfVersion: '', bootstrapped: false, actions, errors };
}
