import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensurePythonEnv, defaultVenvPath, venvPythonPath } from '../src/adapters/pdf/python-env.js';
import type { CommandOutcome, CommandRunner } from '../src/adapters/pdf/python-env.js';

const okOutcome = (stdout: string, stderr = ''): CommandOutcome => ({ code: 0, stdout, stderr });
const failOutcome = (stderr: string): CommandOutcome => ({ code: 1, stdout: '', stderr });

function fakeRuntime(initial: { installed: boolean; venvExists: boolean }) {
  const state = { ...initial };
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push(command + ' ' + args.join(' '));
    if (args[0] === '-V') return okOutcome('Python 3.13.1');
    if (args[0] === '-c' && args[1]?.includes('import pymupdf')) {
      if (command.includes('venv') || command.endsWith('python')) return state.installed ? okOutcome('2.1.0') : failOutcome('ModuleNotFoundError: No module named pymupdf');
      return failOutcome('ModuleNotFoundError');
    }
    if (args[0] === '-m' && args[1] === 'venv') {
      state.venvExists = true;
      return okOutcome('');
    }
    if (args[0] === '-m' && args[1] === 'pip') {
      if (args.some((arg) => arg.includes('tuna'))) return failOutcome('mirror unreachable');
      state.installed = true;
      return okOutcome('');
    }
    return failOutcome('unexpected ' + command);
  };
  return { run, calls, state };
}

test('probe finds an existing working venv without installing', async () => {
  const venv = defaultVenvPath('C:/ws');
  const python = venvPythonPath(venv);
  const run: CommandRunner = async (command, args) => {
    if (args[0] === '-c' && args[1]?.includes('import pymupdf') && command === python) return okOutcome('2.1.0');
    return failOutcome('ModuleNotFoundError');
  };
  const report = await ensurePythonEnv({ workspaceRoot: 'C:/ws' }, run);
  assert.equal(report.ok, true);
  assert.equal(report.source, 'venv');
  assert.equal(report.pymupdfVersion, '2.1.0');
  assert.equal(report.bootstrapped, false);
});

test('read-only mode never installs', async () => {
  const runtime = fakeRuntime({ installed: false, venvExists: false });
  const report = await ensurePythonEnv({ workspaceRoot: 'C:/ws' }, runtime.run);
  assert.equal(report.ok, false);
  assert.equal(report.source, 'none');
  assert.equal(runtime.calls.some((call) => call.includes('pip install')), false);
});

test('bootstrap creates a venv and falls back to pypi when the mirror fails', async () => {
  const runtime = fakeRuntime({ installed: false, venvExists: false });
  const report = await ensurePythonEnv({ workspaceRoot: 'C:/ws', bootstrap: true }, runtime.run);
  assert.equal(report.ok, true);
  assert.equal(report.source, 'bootstrapped');
  assert.equal(report.bootstrapped, true);
  assert.equal(runtime.state.venvExists, true);
  assert.equal(runtime.calls.filter((call) => call.includes('pip install')).length, 2);
  assert.match(report.actions.join('\n'), /created venv/);
});

test('bootstrap reports a missing system interpreter', async () => {
  const run: CommandRunner = async (_command, args) => (args[0] === '-V' ? failOutcome('spawn python ENOENT') : failOutcome('spawn ENOENT'));
  const report = await ensurePythonEnv({ workspaceRoot: 'C:/ws', bootstrap: true }, run);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /no bootstrap interpreter/);
});

test('default venv lives under .kb in the workspace', () => {
  assert.equal(defaultVenvPath('C:/ws').replace(/\\/g, '/'), 'C:/ws/.kb/venv');
});
