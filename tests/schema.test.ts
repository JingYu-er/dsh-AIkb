import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toRawSchema, toRegisteredTool } from '../src/tools/definition.js';

test('parameters compile into a raw object schema the model can consume', () => {
  const tool = toRegisteredTool({
    name: 'demo',
    description: 'demo tool',
    parameters: { query: { type: 'string', required: true }, topK: { type: 'integer' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [],
    },
    execute: async () => ({ ok: true }),
  });
  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: { query: { type: 'string' }, topK: { type: 'integer' } },
    required: ['query'],
    additionalProperties: false,
  });
});

test('nested objects collect required flags into their own array', () => {
  const schema = toRawSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      rows: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string', required: true } } },
      },
    },
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      rows: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      },
    },
    required: ['ok'],
    additionalProperties: false,
  });
});

test('no boolean required survives compilation', () => {
  const text = JSON.stringify(toRawSchema({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string', required: true } } } } }));
  assert.equal(text.includes('"required":true'), false);
  assert.equal(text.includes('"required":["b"]'), true);
});
