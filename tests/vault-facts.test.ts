import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FACTS_SCHEMA,
  MAX_ENTRIES,
  compareFacts,
  createFactsFile,
  factId,
  invalidateFacts,
  normalizeQualifiers,
  parseFacts,
  planFactWork,
  renderFactTable,
  selectFacts,
  serializeFacts,
  touchFacts,
  upsertFact,
} from '../src/application/vault-facts.js';
import type { FactEntry, FactStatus, FactsFile } from '../src/application/vault-facts.js';
import type { MapFile } from '../src/application/vault-map.js';
import type { Evidence } from '../src/application/vault-memory.js';
import { DomainError } from '../src/shared/result.js';

const AT = '2026-02-01T00:00:00.000Z';

function makeMap(): MapFile {
  return {
    schema: 'dsh-aikb/map@1',
    builtAt: '2026-01-01T00:00:00.000Z',
    docs: [],
    entities: [
      { id: 'A-100', label: 'A-100', aliases: ['a-100'], mentions: [] },
      { id: 'B-200', label: 'B-200', aliases: [], mentions: [] },
    ],
    coverage: {
      docs: 0,
      pages: 0,
      sections: 0,
      entities: 2,
      docsWithoutSections: 0,
      docsWithoutEntities: 0,
      unparsed: [],
    },
  };
}

const MAP = makeMap();

function evidenceFor(path: string, sha: string, quote: string, locator = 'p1'): Evidence {
  return { path, unit: 'page', locator, quote, sha };
}

interface FactOptions {
  path?: string;
  sha?: string;
  quote?: string;
  locator?: string;
  status?: FactStatus;
  confidence?: number;
  unit?: string;
  qualifiers?: Record<string, string>;
  at?: string;
  extraEvidence?: readonly Evidence[];
}

function makeFact(entityId: string, field: string, value: string, options: FactOptions = {}): FactEntry {
  const path = options.path ?? 'notes/' + entityId.toLowerCase() + '.md';
  const sha = options.sha ?? 'sha-one';
  const quote = options.quote ?? entityId + ' ' + field + ' ' + value;
  const at = options.at ?? AT;
  const evidence: Evidence[] = [
    evidenceFor(path, sha, quote, options.locator ?? 'p1'),
    ...(options.extraEvidence ?? []),
  ];
  const shaByPath: Record<string, string> = {};
  for (const item of evidence) shaByPath[item.path] = item.sha;
  const fact: FactEntry = {
    id: factId(entityId, field, options.qualifiers),
    entityId,
    entityLabel: entityId,
    field,
    value,
    evidence,
    sources: [...new Set(evidence.map((item) => item.path))].sort(),
    shaByPath,
    extractor: 'test',
    status: options.status ?? 'derived',
    confidence: options.confidence ?? 0.8,
    updatedAt: at,
    lastUsedAt: at,
    useCount: 0,
  };
  if (options.qualifiers !== undefined) fact.qualifiers = options.qualifiers;
  if (options.unit !== undefined) fact.unit = options.unit;
  return fact;
}

function fileWith(entries: readonly FactEntry[]): FactsFile {
  return { ...createFactsFile({ builtAt: AT }), entries: [...entries] };
}

function first<T>(items: readonly T[]): T {
  const head = items[0];
  if (head === undefined) throw new Error('expected at least one item');
  return head;
}

test('factId is readable and stable across qualifier order', () => {
  assert.equal(factId('A-100', 'mass'), 'A-100--mass');
  assert.equal(
    factId('A-100', 'mass', { q2: 'v2', q1: 'v1' }),
    factId('A-100', 'mass', { q1: 'v1', q2: 'v2' }),
  );
  assert.equal(factId('A-100', 'mass', { q1: 'v1', q2: 'v2' }), 'A-100--mass--q1=v1--q2=v2');
  assert.equal(factId('A-100', '质量'), 'A-100--质量');
});

test('normalizeQualifiers lowercases keys, trims values and drops empties', () => {
  assert.deepEqual(normalizeQualifiers({ ' Length ': ' 12 mm ', '': 'x', UNIT: '   ' }), {
    length: '12 mm',
  });
  assert.equal(normalizeQualifiers({}), undefined);
  assert.equal(normalizeQualifiers(undefined), undefined);
});

test('planFactWork plans every entity x field cell when nothing is cached', () => {
  const plan = planFactWork(MAP, undefined, {
    entities: ['A-100', 'B-200'],
    fields: ['mass', 'length'],
    currentShas: {},
  });
  assert.equal(plan.work.length, 4);
  assert.deepEqual(plan.reuse, []);
  assert.deepEqual(plan.rebuild, []);
  assert.deepEqual(plan.missingEntities, []);
  assert.deepEqual(plan.work[0], { entityId: 'A-100', entityLabel: 'A-100', field: 'mass' });
});

test('planFactWork reuses a fact whose sources still hash the same', () => {
  const fact = makeFact('A-100', 'mass', '12', { sha: 'sha-one' });
  const plan = planFactWork(MAP, fileWith([fact]), {
    entities: ['A-100'],
    fields: ['mass'],
    currentShas: { 'notes/a-100.md': 'sha-one' },
  });
  assert.equal(plan.reuse.length, 1);
  assert.equal(plan.rebuild.length, 0);
  assert.equal(plan.work.length, 0);
  assert.equal(first(plan.reuse).id, fact.id);
});

test('planFactWork flags a changed source sha as rebuild', () => {
  const fact = makeFact('A-100', 'mass', '12', { sha: 'sha-one' });
  const plan = planFactWork(MAP, fileWith([fact]), {
    entities: ['A-100'],
    fields: ['mass'],
    currentShas: { 'notes/a-100.md': 'sha-two' },
  });
  assert.equal(plan.rebuild.length, 1);
  assert.equal(plan.reuse.length, 0);
  assert.equal(plan.work.length, 0);
});

test('planFactWork resolves names case-insensitively and reports unknown entities', () => {
  const plan = planFactWork(MAP, undefined, {
    entities: ['a-100', 'ZZ-9'],
    fields: ['mass'],
    currentShas: {},
  });
  assert.deepEqual(plan.missingEntities, ['ZZ-9']);
  assert.equal(plan.work.length, 1);
  assert.equal(plan.work[0]?.entityId, 'A-100');
});

test('planFactWork keys cached facts by qualifiers', () => {
  const fact = makeFact('A-100', 'mass', '12', { qualifiers: { phase: 'solid' } });
  const plan = planFactWork(MAP, fileWith([fact]), {
    entities: ['A-100'],
    fields: ['mass'],
    currentShas: { 'notes/a-100.md': 'sha-one' },
  });
  assert.equal(plan.reuse.length, 0);
  assert.equal(plan.work.length, 1);
  assert.equal(plan.work[0]?.qualifiers, undefined);
});

test('upsertFact rejects evidence with an empty quote', () => {
  const fact = makeFact('A-100', 'mass', '12');
  fact.evidence = [{ path: 'notes/a-100.md', unit: 'page', locator: 'p1', quote: '   ', sha: 'sha-one' }];
  assert.throws(
    () => upsertFact(createFactsFile({ builtAt: AT }), fact),
    (error: unknown) => error instanceof DomainError && error.code === 'facts.invalid-fact',
  );
});

test('upsertFact rejects a shaByPath that does not cover the evidence', () => {
  const fact = makeFact('A-100', 'mass', '12');
  fact.shaByPath = {};
  assert.throws(
    () => upsertFact(createFactsFile({ builtAt: AT }), fact),
    (error: unknown) => error instanceof DomainError && error.code === 'facts.invalid-fact',
  );
});

test('upsertFact replaces a same-id entry and keeps the verified status', () => {
  const start = upsertFact(
    createFactsFile({ builtAt: AT }),
    makeFact('A-100', 'mass', '12', { status: 'derived' }),
  );
  assert.equal(start.entries.length, 1);
  const next = upsertFact(start, makeFact('A-100', 'mass', '13', { status: 'verified', at: '2026-03-01T00:00:00.000Z' }), {
    now: new Date('2026-03-02T00:00:00.000Z'),
  });
  assert.equal(next.entries.length, 1);
  const entry = first(next.entries);
  assert.equal(entry.value, '13');
  assert.equal(entry.status, 'verified');
  assert.equal(entry.updatedAt, '2026-03-02T00:00:00.000Z');
  assert.equal(entry.lastUsedAt, '2026-03-01T00:00:00.000Z');
});

test('upsertFact never demotes a verified fact to derived', () => {
  const verified = upsertFact(
    createFactsFile({ builtAt: AT }),
    makeFact('A-100', 'mass', '12', { status: 'verified', confidence: 0.9 }),
  );
  const next = upsertFact(verified, makeFact('A-100', 'mass', '12', { status: 'derived', confidence: 0.4 }));
  assert.equal(next.entries.length, 1);
  assert.equal(first(next.entries).status, 'verified');
  assert.equal(first(next.entries).confidence, 0.9);
});

test('upsertFact with replace false leaves an existing entry untouched', () => {
  const start = upsertFact(createFactsFile({ builtAt: AT }), makeFact('A-100', 'mass', '12'));
  const next = upsertFact(start, makeFact('A-100', 'mass', '99'), { replace: false });
  assert.equal(next, start);
  assert.equal(first(next.entries).value, '12');
});

test('upsertFact re-checks the quote only when a resolver is supplied', () => {
  const fact = makeFact('A-100', 'mass', '12', { quote: 'A-100 mass 12' });
  const file = createFactsFile({ builtAt: AT });
  const found = (path: string): string | undefined =>
    path === 'notes/a-100.md' ? 'prefix A-100   mass 12 suffix' : undefined;
  const accepted = upsertFact(file, fact, {
    resolve: found,
    currentShas: { 'notes/a-100.md': 'sha-one' },
  });
  assert.equal(accepted.entries.length, 1);

  assert.throws(
    () => upsertFact(file, fact, { resolve: () => 'nothing to see here' }),
    (error: unknown) => error instanceof DomainError && error.code === 'facts.unverified-quote',
  );

  const unverified = upsertFact(file, fact);
  assert.equal(unverified.entries.length, 1);
});

test('upsertFact evicts the least recently used facts beyond MAX_ENTRIES', () => {
  const entries: FactEntry[] = [];
  for (let index = 0; index < MAX_ENTRIES; index += 1) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    entries.push(makeFact('E-' + index, 'mass', String(index), { at, path: 'notes/e-' + index + '.md' }));
  }
  const full = fileWith(entries);
  const oldest = first(entries);
  const next = upsertFact(
    full,
    makeFact('NEW-1', 'mass', '1', { at: '2026-05-01T00:00:00.000Z', path: 'notes/new.md' }),
  );
  assert.equal(next.entries.length, MAX_ENTRIES);
  assert.equal(next.entries.some((entry) => entry.id === oldest.id), false);
  assert.equal(next.entries.some((entry) => entry.entityId === 'NEW-1'), true);
});

test('invalidateFacts drops facts whose every source changed or vanished', () => {
  const fact = makeFact('A-100', 'mass', '12');
  const file = fileWith([fact]);
  const changed = invalidateFacts(file, { 'notes/a-100.md': 'sha-two' });
  assert.equal(changed.dropped, 1);
  assert.equal(changed.stale.length, 1);
  assert.equal(first(changed.stale).id, fact.id);
  assert.deepEqual(changed.file.entries, []);

  const vanished = invalidateFacts(file, {});
  assert.equal(vanished.dropped, 1);
  assert.deepEqual(vanished.file.entries, []);

  const kept = invalidateFacts(file, { 'notes/a-100.md': 'sha-one' });
  assert.equal(kept.dropped, 0);
  assert.equal(kept.file.entries.length, 1);
});

test('invalidateFacts trims a partially valid fact and lowers its confidence', () => {
  const base = makeFact('A-100', 'mass', '12', { status: 'verified', confidence: 0.9 });
  const second = evidenceFor('notes/b-200.md', 'sha-two', 'B-200 mass 12', 'p3');
  const fact: FactEntry = {
    ...base,
    evidence: [...base.evidence, second],
    sources: ['notes/a-100.md', 'notes/b-200.md'],
    shaByPath: { 'notes/a-100.md': 'sha-one', 'notes/b-200.md': 'sha-two' },
  };
  const file = fileWith([fact]);
  const result = invalidateFacts(file, {
    'notes/a-100.md': 'sha-one',
    'notes/b-200.md': 'sha-CHANGED',
  });
  assert.equal(result.dropped, 0);
  const trimmed = first(result.file.entries);
  assert.equal(trimmed.evidence.length, 1);
  assert.deepEqual(trimmed.sources, ['notes/a-100.md']);
  assert.deepEqual(trimmed.shaByPath, { 'notes/a-100.md': 'sha-one' });
  assert.equal(trimmed.status, 'derived');
  assert.ok(trimmed.confidence < 0.9);
  assert.equal(trimmed.updatedAt, AT);

  const stamped = invalidateFacts(
    file,
    { 'notes/a-100.md': 'sha-one' },
    { now: new Date('2026-04-01T00:00:00.000Z') },
  );
  assert.equal(first(stamped.file.entries).updatedAt, '2026-04-01T00:00:00.000Z');
});

test('invalidateFacts leaves a disputed fact disputed when it loses one source', () => {
  const base = makeFact('A-100', 'mass', '12', { status: 'disputed' });
  const second = evidenceFor('notes/b-200.md', 'sha-two', 'B-200 mass 12', 'p3');
  const fact: FactEntry = {
    ...base,
    evidence: [...base.evidence, second],
    sources: ['notes/a-100.md', 'notes/b-200.md'],
    shaByPath: { 'notes/a-100.md': 'sha-one', 'notes/b-200.md': 'sha-two' },
  };
  const result = invalidateFacts(fileWith([fact]), {
    'notes/a-100.md': 'sha-one',
    'notes/b-200.md': 'sha-CHANGED',
  });
  assert.equal(first(result.file.entries).status, 'disputed');
});

test('selectFacts orders verified first, then by confidence, and hides disputed', () => {
  const file = fileWith([
    makeFact('B-200', 'mass', '1', { status: 'derived', confidence: 0.9, path: 'notes/b-200.md' }),
    makeFact('A-100', 'mass', '2', { status: 'verified', confidence: 0.4 }),
    makeFact('B-200', 'length', '3', { status: 'derived', confidence: 0.2, path: 'notes/b-200.md' }),
    makeFact('A-100', 'length', '4', { status: 'disputed', confidence: 0.99 }),
  ]);
  assert.deepEqual(selectFacts(file).map((entry) => entry.id), [
    factId('A-100', 'mass'),
    factId('B-200', 'mass'),
    factId('B-200', 'length'),
  ]);

  const withDisputed = selectFacts(file, { includeDisputed: true });
  assert.equal(withDisputed.length, 4);
  assert.equal(withDisputed[3]?.id, factId('A-100', 'length'));

  assert.deepEqual(
    selectFacts(file, { entityIds: ['B-200'], fields: ['mass'] }).map((entry) => entry.id),
    [factId('B-200', 'mass')],
  );
  assert.equal(selectFacts(file, { max: 1 }).length, 1);
  assert.equal(selectFacts(file, { max: 0 }).length, 0);
});

test('touchFacts bumps useCount and lastUsedAt for the given ids only', () => {
  const a = makeFact('A-100', 'mass', '12');
  const b = makeFact('B-200', 'mass', '20', { path: 'notes/b-200.md' });
  const file = fileWith([a, b]);
  const touched = touchFacts(file, [a.id], '2026-06-01T00:00:00.000Z');
  assert.equal(first(touched.entries).useCount, 1);
  assert.equal(first(touched.entries).lastUsedAt, '2026-06-01T00:00:00.000Z');
  assert.equal(touched.entries[1]?.useCount, 0);
  assert.equal(touched.entries[1]?.lastUsedAt, AT);
  assert.equal(touchFacts(file, [], '2026-06-01T00:00:00.000Z'), file);
});

test('compareFacts groups rows by field with evidence counts', () => {
  const entries = [
    makeFact('A-100', 'mass', '12'),
    makeFact('B-200', 'mass', '20', { path: 'notes/b-200.md' }),
    makeFact('A-100', 'length', '3'),
  ];
  const comparison = compareFacts(entries);
  assert.deepEqual(comparison.groups.map((group) => group.field), ['length', 'mass']);
  const mass = comparison.groups[1];
  assert.ok(mass !== undefined);
  assert.equal(mass.rows.length, 2);
  assert.equal(mass.rows[0]?.evidence, 1);
  assert.equal(mass.rows[0]?.source, 'notes/a-100.md#p1');
  assert.deepEqual(comparison.conflicts, []);
});

test('compareFacts reports a numeric conflict between verified facts', () => {
  const conflicting = compareFacts([
    makeFact('A-100', 'mass', '12 kg', { status: 'verified', unit: 'kg' }),
    makeFact('B-200', 'mass', '14 kg', { status: 'verified', unit: 'kg', path: 'notes/b-200.md' }),
  ]);
  assert.deepEqual(conflicting.conflicts, [{ field: 'mass', values: ['12 kg', '14 kg'] }]);

  const differentUnits = compareFacts([
    makeFact('A-100', 'mass', '12 kg', { status: 'verified', unit: 'kg' }),
    makeFact('B-200', 'mass', '14 cm', { status: 'verified', unit: 'cm', path: 'notes/b-200.md' }),
  ]);
  assert.deepEqual(differentUnits.conflicts, []);

  const agreeing = compareFacts([
    makeFact('A-100', 'mass', '12 kg', { status: 'verified', unit: 'kg' }),
    makeFact('B-200', 'mass', '12.0 kg', { status: 'verified', unit: 'kg', path: 'notes/b-200.md' }),
  ]);
  assert.deepEqual(agreeing.conflicts, []);
});

test('renderFactTable emits one markdown table per field with a path#locator source', () => {
  const comparison = compareFacts([makeFact('A-100', 'mass', '12', { unit: 'kg' })]);
  const text = renderFactTable(comparison.groups);
  assert.ok(text.includes('### mass'));
  assert.ok(text.includes('| 实体 | 值 | 状态 | 出处 |'));
  assert.ok(text.includes('notes/a-100.md#p1'));
  assert.ok(text.includes('12 kg'));
  assert.equal(text.split('### ').length, 2);
  assert.equal(renderFactTable([]), '');
});

test('parseFacts and serializeFacts round-trip and tolerate unknown fields', () => {
  const file = upsertFact(
    createFactsFile({ builtAt: AT }),
    makeFact('A-100', 'mass', '12', { unit: 'kg', status: 'verified' }),
  );
  const text = serializeFacts(file);
  assert.ok(text.endsWith('\n'));
  const parsed = parseFacts(text);
  assert.equal(parsed.schema, FACTS_SCHEMA);
  assert.equal(serializeFacts(parsed), text);

  const tolerant = parseFacts(
    JSON.stringify({
      schema: FACTS_SCHEMA,
      extra: true,
      entries: [{ entityId: 'A-100', field: 'mass', value: '12', note: 'ignored' }],
    }),
  );
  assert.equal(tolerant.entries.length, 1);
  assert.equal(first(tolerant.entries).entityLabel, 'A-100');
  assert.deepEqual(parseFacts(JSON.stringify({ schema: FACTS_SCHEMA })).entries, []);
});

test('parseFacts rejects non-JSON and a foreign schema', () => {
  const isShape = (error: unknown): boolean =>
    error instanceof DomainError && error.code === 'facts.invalid-shape';
  assert.throws(() => parseFacts('not json'), isShape);
  assert.throws(() => parseFacts(JSON.stringify({ schema: 'dsh-aikb/memory@1' })), isShape);
  assert.throws(() => parseFacts('[]'), isShape);
});

test('serializeFacts is deterministic regardless of entry order', () => {
  const a = makeFact('A-100', 'mass', '12');
  const b = makeFact('B-200', 'length', '3', { path: 'notes/b-200.md' });
  const left = serializeFacts(fileWith([a, b]));
  const right = serializeFacts(fileWith([b, a]));
  assert.equal(left, right);
  assert.equal(serializeFacts(fileWith([a, b])), left);
  assert.ok(left.indexOf(factId('A-100', 'mass')) < left.indexOf(factId('B-200', 'length')));
});
