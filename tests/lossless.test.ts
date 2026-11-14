import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toRegisteredTool } from '../src/tools/definition.js';

test('registered execute omits undefined optional fields', async () => {
  const tool = toRegisteredTool({
    name: 'demo',
    description: 'demo',
    parameters: { q: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' } },
      },
      render: () => [],
    },
    execute: async () => ({ ok: true, note: undefined, rows: [{ a: 1, b: undefined }], list: [1, undefined] }),
  });
  assert.deepEqual(await tool.execute({ q: 'x' }, {}), { ok: true, rows: [{ a: 1 }], list: [1, null] });
});
