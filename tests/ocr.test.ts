import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { closeSync, openSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { test } from 'node:test';
import { ensureOcrModel, DEFAULT_OCR_REC_FILE } from '../src/adapters/pdf/ocr-model.js';
import { ocrPdf } from '../src/adapters/pdf/ocr.js';
import type { CommandRunner } from '../src/adapters/pdf/python-env.js';

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(nodePath.join(tmpdir(), prefix));
}

function sparseFile(path: string, bytes: number): void {
  closeSync(openSync(path, 'w'));
  truncateSync(path, bytes);
}

test('ensureOcrModel reuses an existing graph without downloading', async () => {
  const root = await tempRoot('dsh-aikb-ocr-model-');
  const modelDir = nodePath.join(root, 'models');
  await mkdir(modelDir, { recursive: true });
  const target = nodePath.join(modelDir, DEFAULT_OCR_REC_FILE);
  sparseFile(target, 8_000_100);
  const report = await ensureOcrModel({ workspaceRoot: root, modelDir, bootstrap: true });
  assert.equal(report.ok, true);
  assert.equal(report.path, target);
  assert.equal(report.downloaded, false);
});

test('ensureOcrModel reports a missing graph when bootstrap is off', async () => {
  const root = await tempRoot('dsh-aikb-ocr-model-missing-');
  const report = await ensureOcrModel({ workspaceRoot: root, bootstrap: false });
  assert.equal(report.ok, false);
  assert.equal(report.path, '');
  assert.match(report.errors[0] ?? '', /ocr model missing/);
});

test('ocrPdf forwards the recognizer path and splits journal blocks', async () => {
  const root = await tempRoot('dsh-aikb-ocr-run-');
  const journal = nodePath.join(root, 'journal.jsonl');
  const calls: (readonly string[])[] = [];
  const run: CommandRunner = async (_python, args) => {
    calls.push(args);
    const out = args[args.indexOf('--out') + 1] as string;
    writeFileSync(out, JSON.stringify({ page: 1, text: 'first paragraph\n\nsecond paragraph', chars: 32 }) + '\n');
    return { code: 0, stdout: '', stderr: '' };
  };
  const outcome = await ocrPdf(
    {
      pythonPath: 'python',
      workspaceRoot: root,
      scriptPath: 'ocr_book.py',
      pdfPath: 'book.pdf',
      journalPath: journal,
      recModelPath: 'C:/models/ch_PP-OCRv4_rec_infer.onnx',
    },
    run,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.pages.length, 1);
  assert.deepEqual(outcome.result.pages[0]?.blocks, ['first paragraph', 'second paragraph']);
  const args = calls[0] ?? [];
  assert.equal(args[args.indexOf('--rec-model') + 1], 'C:/models/ch_PP-OCRv4_rec_infer.onnx');
  assert.equal(args.includes('--det-model'), false);
});
