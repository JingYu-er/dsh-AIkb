import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';
import { test } from 'node:test';
import { readVaultSchema, schemaTemplate, vaultSchemaPath, writeVaultSchema } from '../src/application/vault-schema.js';

async function tempVault(name: string): Promise<string> {
  const root = nodePath.resolve(process.cwd(), '..', 'temp', name + '-' + Date.now().toString(36));
  await fsPromises.mkdir(root, { recursive: true });
  return root;
}

test('a vault without a sheet reads as absent instead of failing', async () => {
  const root = await tempVault('schema-none');
  try {
    const report = await readVaultSchema(root);
    assert.equal(report.exists, false);
    assert.equal(report.bytes, 0);
    assert.equal(report.text, '');
    assert.equal(report.path, vaultSchemaPath(root));
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('writing the sheet needs allowWrites', async () => {
  const root = await tempVault('schema-ro');
  try {
    const result = await writeVaultSchema(root, '# 规则', { allowWrites: false });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'kb.schema.read-only');
    assert.equal((await readVaultSchema(root)).exists, false);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('a written sheet round-trips and lands under .dsh-aikb', async () => {
  const root = await tempVault('schema-ok');
  try {
    const body = schemaTemplate('测试库');
    const result = await writeVaultSchema(root, body, { allowWrites: true });
    assert.equal(result.ok, true);
    assert.equal(result.bytes, Buffer.byteLength(body, 'utf8'));
    assert.ok(result.path.endsWith(nodePath.join('.dsh-aikb', 'schema.md')));
    const report = await readVaultSchema(root);
    assert.equal(report.exists, true);
    assert.equal(report.text, body);
    assert.ok(report.updatedAt > 0);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('empty and oversized sheets are refused before touching the file', async () => {
  const root = await tempVault('schema-bad');
  try {
    const empty = await writeVaultSchema(root, '   ', { allowWrites: true });
    assert.equal(empty.ok, false);
    assert.equal(empty.error?.code, 'kb.schema.empty');
    const big = await writeVaultSchema(root, 'x'.repeat(64 * 1024 + 1), { allowWrites: true });
    assert.equal(big.ok, false);
    assert.equal(big.error?.code, 'kb.schema.too-large');
    assert.equal((await readVaultSchema(root)).exists, false);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('the template names the three sections the sheet must answer', () => {
  const body = schemaTemplate('库名');
  assert.ok(body.includes('## 页面规范'));
  assert.ok(body.includes('## 目录用途'));
  assert.ok(body.includes('## 加工流程'));
  assert.ok(body.includes('待定'), 'keeps the questions open instead of inventing rules');
});
