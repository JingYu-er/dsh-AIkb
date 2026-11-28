import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_POLICY,
  MAX_SOURCE_SHAS,
  POLICY_PATH,
  POLICY_SCHEMA,
  PROFILE_VERSION,
  SYNONYMS_PATH,
  SYNONYMS_SCHEMA,
  TAXONOMY_PATH,
  TAXONOMY_SCHEMA,
  classifySurface,
  emptyProfile,
  entryKey,
  extractSurfaceForms,
  harvestProfile,
  mergeProfile,
  parseProfile,
  policyValue,
  profileForQuery,
  profileReadiness,
  serializeProfile,
} from '../src/application/vault-profile.js';
import type { VaultProfile } from '../src/application/vault-profile.js';
import { DomainError } from '../src/shared/result.js';

const NOW = new Date('2024-01-02T03:04:05.000Z');

function chunk(path: string, text: string): { sourceId: string; path: string; text: string } {
  return { sourceId: 'id:' + path, path, text };
}

describe('vault profile documents', () => {
  it('names the three sidecar paths and schemas', () => {
    assert.equal(TAXONOMY_PATH, '.wiki/index/taxonomy.json');
    assert.equal(SYNONYMS_PATH, '.wiki/index/synonyms.json');
    assert.equal(POLICY_PATH, '.wiki/index/policy.json');
    assert.equal(TAXONOMY_SCHEMA, 'dsh-aikb/taxonomy@1');
    assert.equal(SYNONYMS_SCHEMA, 'dsh-aikb/synonyms@1');
    assert.equal(POLICY_SCHEMA, 'dsh-aikb/policy@1');
    assert.equal(PROFILE_VERSION, 1);
    assert.equal(MAX_SOURCE_SHAS, 5000);
  });

  it('starts empty with every section present', () => {
    const profile = emptyProfile();
    assert.equal(profile.taxonomy.schema, TAXONOMY_SCHEMA);
    assert.equal(profile.synonyms.schema, SYNONYMS_SCHEMA);
    assert.equal(profile.policy.schema, POLICY_SCHEMA);
    assert.deepEqual(profile.taxonomy.entries, []);
    assert.deepEqual(profile.synonyms.entries, []);
    assert.deepEqual(serializeProfile(profile).policy.includes('"schema": "dsh-aikb/policy@1"'), true);
  });
});

describe('shape classifier', () => {
  it('keeps a part number whole instead of splitting it into parts', () => {
    const forms = extractSurfaceForms('STM32F103C8T6 is the reference here.');
    const labels = forms.map((form) => form.form);
    assert.deepEqual(labels.includes('STM32F103C8T6'), true);
    assert.deepEqual(labels.includes('STM32'), false);
    assert.deepEqual(labels.includes('F103'), false);
    assert.deepEqual(labels.includes('C8T6'), false);
    assert.equal(forms.find((form) => form.form === 'STM32F103C8T6')?.class, 'identifier');
  });

  it('does not call every short ASCII word an identifier', () => {
    assert.equal(classifySurface('the'), undefined);
    assert.equal(classifySurface('main'), undefined);
    assert.equal(classifySurface('data'), undefined);
    assert.equal(classifySurface('v2'), undefined);
    assert.equal(classifySurface('example'), 'ascii-term');
    assert.equal(classifySurface('read-only'), 'ascii-term');
  });

  it('classifies the remaining shapes without knowing a subject', () => {
    assert.equal(classifySurface('仓库流程'), 'cjk-term');
    assert.equal(classifySurface('HTTP'), 'acronym');
    assert.equal(classifySurface('1200ms'), 'numeric-with-unit');
    assert.equal(classifySurface('3.3°C'), 'numeric-with-unit');
    assert.equal(classifySurface('《订单复核》'), 'quoted-phrase');
    assert.equal(classifySurface('"order review"'), 'quoted-phrase');
    assert.equal(classifySurface(''), undefined);
    assert.equal(classifySurface('   '), undefined);
  });

  it('normalises the merge key by casefolding', () => {
    assert.equal(entryKey('  Payment '), 'payment');
    assert.equal(entryKey('PAYMENT'), entryKey('payment'));
  });
});

describe('harvestProfile', () => {
  it('counts shapes per class and keeps each class sorted', () => {
    const harvested = harvestProfile([
      chunk('notes/a.md', '仓库 warehouse 仓库 invoice 发票 仓库'),
      chunk('notes/b.md', 'warehouse again'),
    ]);
    for (const cls of ['cjk-term', 'ascii-term', 'identifier', 'acronym', 'numeric-with-unit', 'quoted-phrase']) {
      const group = harvested.taxonomy.filter((entry) => entry.class === cls);
      for (let index = 1; index < group.length; index += 1) {
        const previous = group[index - 1];
        const current = group[index];
        assert.equal(
          (previous?.count ?? 0) > (current?.count ?? 0)
            || ((previous?.count ?? 0) === (current?.count ?? 0) && String(previous?.label) < String(current?.label)),
          true,
        );
      }
    }
    const warehouse = harvested.taxonomy.find((entry) => entry.label === 'warehouse');
    assert.equal(warehouse?.class, 'ascii-term');
    assert.equal(warehouse?.count, 2);
    assert.deepEqual(warehouse?.sources, ['notes/a.md', 'notes/b.md']);
    assert.equal(warehouse?.origin, 'harvest');
  });

  it('learns synonyms only from stated pairs with different scripts', () => {
    const harvested = harvestProfile([
      chunk('notes/pair.md', '仓库（warehouse） 与 Payment (付款) 是同一件事'),
      chunk('notes/definition.md', 'Advanced RISC Machine (ARM) is a definition, not a pair'),
      chunk('notes/same.md', 'Example (example) repeats itself'),
    ]);
    const pairs = harvested.synonyms.map((entry) => entry.a + '=>' + entry.b);
    assert.deepEqual([...pairs].sort(), ['仓库=>warehouse', 'Payment=>付款'].sort());
  });

  it('takes glossary pairs as stated equivalences', () => {
    const harvested = harvestProfile([], [{ a: '订单', b: 'order' }]);
    assert.equal(harvested.synonyms.length, 1);
    assert.equal(harvested.synonyms[0]?.a, '订单');
    assert.equal(harvested.synonyms[0]?.b, 'order');
    const labels = harvested.taxonomy.map((entry) => entry.label);
    assert.deepEqual(labels, ['订单', 'order']);
  });

  it('is deterministic for the same chunks', () => {
    const chunks = [chunk('a.md', '仓库 warehouse'), chunk('b.md', 'warehouse')];
    assert.deepEqual(harvestProfile(chunks), harvestProfile(chunks));
  });
});

describe('mergeProfile', () => {
  it('never rewrites a manual entry across merges', () => {
    const first = mergeProfile(undefined, {
      taxonomy: [{ label: '仓库', class: 'cjk-term', count: 1, sources: ['a.md'] }],
      synonyms: [],
    }, { manual: true, now: NOW });
    assert.equal(first.profile.taxonomy.entries[0]?.origin, 'manual');

    const second = mergeProfile(first.profile, {
      taxonomy: [{ label: 'warehouse', class: 'ascii-term', count: 2, sources: ['b.md'] }],
      synonyms: [],
    }, { now: NOW });
    const kept = second.profile.taxonomy.entries.find((entry) => entry.label === '仓库');
    assert.equal(kept?.origin, 'manual');
    assert.equal(kept?.count, 1);
    assert.deepEqual(kept?.sources, ['a.md']);
    const added = second.profile.taxonomy.entries.find((entry) => entry.label === 'warehouse');
    assert.equal(added?.origin, 'harvest');
    assert.equal(added?.count, 2);
    assert.deepEqual(second.conflicts, []);
  });

  it('keeps manual and records a conflict when harvest disagrees on the same key', () => {
    const manual = mergeProfile(undefined, {
      taxonomy: [{ label: 'Warehouse', class: 'ascii-term', count: 1, sources: [] }],
      synonyms: [],
    }, { manual: true, now: NOW });

    const merged = mergeProfile(manual.profile, {
      taxonomy: [{ label: 'warehouse', class: 'ascii-term', count: 4, sources: ['a.md'] }],
      synonyms: [],
    }, { now: NOW });

    assert.equal(merged.profile.taxonomy.entries.length, 1);
    const entry = merged.profile.taxonomy.entries[0];
    assert.equal(entry?.label, 'Warehouse');
    assert.equal(entry?.origin, 'manual');
    assert.equal(merged.conflicts.length, 1);
    assert.equal(merged.conflicts[0]?.reason, 'manual-wins');
    assert.equal(merged.conflicts[0]?.key, 'warehouse');
    assert.equal(merged.conflicts[0]?.keptOrigin, 'manual');
    assert.equal(merged.conflicts[0]?.droppedOrigin, 'harvest');
  });

  it('records a conflict when two manual decisions collide on one key', () => {
    const manual = mergeProfile(undefined, {
      taxonomy: [{ label: 'Warehouse', class: 'ascii-term', count: 1, sources: [] }],
      synonyms: [],
    }, { manual: true, now: NOW });
    const merged = mergeProfile(manual.profile, {
      taxonomy: [{ label: 'warehouse', class: 'ascii-term', count: 1, sources: [] }],
      synonyms: [],
    }, { manual: true, now: NOW });
    assert.equal(merged.profile.taxonomy.entries.length, 1);
    assert.equal(merged.profile.taxonomy.entries[0]?.label, 'Warehouse');
    assert.equal(merged.conflicts[0]?.reason, 'manual-conflict');
    assert.equal(merged.conflicts[0]?.droppedOrigin, 'manual');
  });

  it('protects a manual synonym pair from a harvest pair of the same key', () => {
    const manual = mergeProfile(undefined, {
      taxonomy: [],
      synonyms: [{ a: '订单', b: 'order', count: 1, sources: [] }],
    }, { manual: true, now: NOW });
    const merged = mergeProfile(manual.profile, {
      taxonomy: [],
      synonyms: [{ a: '订单', b: 'order', count: 9, sources: ['a.md'] }],
    }, { now: NOW });
    assert.equal(merged.profile.synonyms.entries.length, 1);
    assert.equal(merged.profile.synonyms.entries[0]?.origin, 'manual');
    assert.equal(merged.profile.synonyms.entries[0]?.count, 1);
    assert.equal(merged.conflicts[0]?.section, 'synonyms');
    assert.equal(merged.conflicts[0]?.reason, 'manual-wins');
  });

  it('adds counts for harvest entries with the same key', () => {
    const first = mergeProfile(undefined, {
      taxonomy: [{ label: 'warehouse', class: 'ascii-term', count: 2, sources: ['a.md'] }],
      synonyms: [],
    }, { now: NOW });
    const second = mergeProfile(first.profile, {
      taxonomy: [{ label: 'Warehouse', class: 'ascii-term', count: 3, sources: ['b.md'] }],
      synonyms: [],
    }, { now: NOW });
    assert.equal(second.profile.taxonomy.entries[0]?.count, 5);
    assert.equal(second.added.taxonomy, 0);
  });

  it('marks entries stale when their sources are gone, and prunes only on request', () => {
    const first = mergeProfile(undefined, {
      taxonomy: [{ label: 'warehouse', class: 'ascii-term', count: 2, sources: ['gone.md'] }],
      synonyms: [],
    }, { now: NOW, sourceShas: { 'gone.md': 'sha-gone' } });
    assert.equal(first.profile.taxonomy.entries[0]?.stale, undefined);

    const kept = mergeProfile(first.profile, { taxonomy: [], synonyms: [] }, {
      now: NOW,
      sourceShas: { 'other.md': 'sha-other' },
    });
    assert.equal(kept.profile.taxonomy.entries[0]?.stale, true);

    const pruned = mergeProfile(kept.profile, { taxonomy: [], synonyms: [] }, {
      now: NOW,
      sourceShas: { 'other.md': 'sha-other' },
      pruneSources: true,
    });
    assert.deepEqual(pruned.profile.taxonomy.entries, []);
  });

  it('does not mark stale without an inventory to compare against', () => {
    const first = mergeProfile(undefined, {
      taxonomy: [{ label: 'warehouse', class: 'ascii-term', count: 2, sources: ['gone.md'] }],
      synonyms: [],
    }, { now: NOW });
    const second = mergeProfile(first.profile, { taxonomy: [], synonyms: [] }, { now: NOW });
    assert.equal(second.profile.taxonomy.entries[0]?.stale, undefined);
  });

  it('caps sourceShas to the most recent 5000', () => {
    const shas: Record<string, string> = {};
    for (let index = 0; index <= MAX_SOURCE_SHAS; index += 1) shas['p' + index + '.md'] = 'sha-' + index;
    const merged = mergeProfile(undefined, { taxonomy: [], synonyms: [] }, { now: NOW, sourceShas: shas });
    const keys = Object.keys(merged.profile.taxonomy.sourceShas);
    assert.equal(keys.length, MAX_SOURCE_SHAS);
    assert.equal(keys.includes('p5000.md'), false);
  });
});

describe('serializeProfile', () => {
  const build = (): VaultProfile => mergeProfile(undefined, {
    taxonomy: [
      { label: 'warehouse', class: 'ascii-term', count: 2, sources: ['b.md', 'a.md'] },
      { label: '仓库', class: 'cjk-term', count: 1, sources: ['a.md'] },
    ],
    synonyms: [{ a: '订单', b: 'order', count: 3, sources: ['a.md'] }],
  }, { now: NOW, sourceShas: { 'b.md': 'sha-b', 'a.md': 'sha-a' } }).profile;

  it('produces byte-identical output for the same profile', () => {
    const first = serializeProfile(build());
    const second = serializeProfile(build());
    assert.equal(first.taxonomy, second.taxonomy);
    assert.equal(first.synonyms, second.synonyms);
    assert.equal(first.policy, second.policy);
  });

  it('ignores entry insertion order and normalises provenance order', () => {
    const base = build();
    const reversed: VaultProfile = {
      taxonomy: { ...base.taxonomy, entries: [...base.taxonomy.entries].reverse() },
      synonyms: base.synonyms,
      policy: base.policy,
    };
    assert.equal(serializeProfile(reversed).taxonomy, serializeProfile(base).taxonomy);
  });

  it('keeps only the builtAt it was given', () => {
    const text = serializeProfile(build()).taxonomy;
    assert.equal(text.includes('"builtAt": "2024-01-02T03:04:05.000Z"'), true);
    assert.equal(text.includes('2026'), false);
    assert.equal(text.endsWith('\n'), true);
  });

  it('writes the harvest provenance it was given', () => {
    const profile = build();
    const parsed = parseProfile({ taxonomy: serializeProfile(profile).taxonomy });
    assert.deepEqual(parsed.taxonomy.entries.map((entry) => entry.label), ['仓库', 'warehouse']);
    assert.deepEqual(parsed.taxonomy.sourceShas, { 'a.md': 'sha-a', 'b.md': 'sha-b' });
  });
});

describe('parseProfile', () => {
  it('tolerates missing fields', () => {
    const profile = parseProfile('{"entries": []}');
    assert.equal(profile.taxonomy.entries.length, 0);
    assert.equal(profile.synonyms.entries.length, 0);
    assert.equal(profile.policy.entries.length, 0);
  });

  it('round-trips a serialized bundle', () => {
    const original = mergeProfile(undefined, {
      taxonomy: [{ label: '仓库', class: 'cjk-term', count: 1, sources: ['a.md'] }],
      synonyms: [{ a: '仓库', b: 'warehouse', count: 1, sources: ['a.md'] }],
    }, { now: NOW }).profile;
    const files = serializeProfile(original);
    const parsed = parseProfile({ taxonomy: files.taxonomy, synonyms: files.synonyms, policy: files.policy });
    assert.deepEqual(serializeProfile(parsed), files);
  });

  it('refuses corrupt JSON instead of pretending it is empty', () => {
    assert.throws(
      () => parseProfile('{'),
      (error: unknown) => error instanceof DomainError && error.code === 'profile.invalid-json',
    );
  });
});

describe('profileForQuery', () => {
  const profile = mergeProfile(undefined, {
    taxonomy: [{ label: '仓库', class: 'cjk-term', count: 1, sources: [], origin: 'harvest' }],
    synonyms: [{ a: '订单', b: 'order', count: 1, sources: [] }],
  }, { now: NOW }).profile;

  it('answers from a stated synonym in both directions', () => {
    assert.deepEqual(profileForQuery(profile, '订单'), ['order']);
    assert.deepEqual(profileForQuery(profile, 'Order'), ['订单']);
  });

  it('answers from a manual alias', () => {
    const withAlias = mergeProfile(undefined, {
      taxonomy: [{ label: '仓库', class: 'cjk-term', count: 1, sources: [], origin: 'manual' }],
      synonyms: [],
    }, { now: NOW, manual: true }).profile;
    const aliased: VaultProfile = {
      ...withAlias,
      taxonomy: {
        ...withAlias.taxonomy,
        entries: withAlias.taxonomy.entries.map((entry) => ({ ...entry, aliases: ['库房'] })),
      },
    };
    assert.deepEqual(profileForQuery(aliased, '库房'), ['仓库']);
    assert.deepEqual(profileForQuery(aliased, '仓库'), ['库房']);
  });

  it('degrades to nothing for an unknown term or an empty profile', () => {
    assert.deepEqual(profileForQuery(profile, 'unknown-term'), []);
    assert.deepEqual(profileForQuery(profile, ''), []);
    assert.deepEqual(profileForQuery(emptyProfile(), '订单'), []);
    assert.deepEqual(profileForQuery(undefined, '订单'), []);
  });
});

describe('profileReadiness', () => {
  it('reports gaps for an empty profile instead of throwing', () => {
    const readiness = profileReadiness(emptyProfile());
    assert.equal(readiness.ok, false);
    assert.deepEqual(readiness.counts, { taxonomy: 0, synonyms: 0 });
    assert.deepEqual(readiness.gaps.includes('profile.empty'), true);
  });

  it('reports what is missing when only one section has entries', () => {
    const profile = mergeProfile(undefined, {
      taxonomy: [{ label: '仓库', class: 'cjk-term', count: 1, sources: ['a.md'] }],
      synonyms: [],
    }, { now: NOW, sourceShas: { 'a.md': 'sha-a' } }).profile;
    const readiness = profileReadiness(profile);
    assert.equal(readiness.ok, false);
    assert.equal(readiness.counts.taxonomy, 1);
    assert.deepEqual(readiness.gaps.includes('synonyms.empty'), true);
    assert.deepEqual(readiness.gaps.includes('profile.no-source-shas'), false);
  });

  it('is ready once both sections and provenance exist', () => {
    const profile = mergeProfile(undefined, {
      taxonomy: [{ label: '仓库', class: 'cjk-term', count: 1, sources: ['a.md'] }],
      synonyms: [{ a: '仓库', b: 'warehouse', count: 1, sources: ['a.md'] }],
    }, { now: NOW, sourceShas: { 'a.md': 'sha-a' } }).profile;
    assert.deepEqual(profileReadiness(profile), { ok: true, counts: { taxonomy: 1, synonyms: 1 }, gaps: [] });
  });
});

describe('policyValue', () => {
  it('falls back to the built-in defaults', () => {
    assert.equal(policyValue(undefined, 'expandOnQuery'), DEFAULT_POLICY.expandOnQuery);
    assert.equal(policyValue(emptyProfile(), 'expandOnQuery'), 'true');
    assert.equal(policyValue(emptyProfile(), 'missing'), undefined);
  });

  it('lets the vault override a default', () => {
    const profile = mergeProfile(undefined, {
      taxonomy: [],
      synonyms: [],
    }, { now: NOW, manual: true }).profile;
    const withPolicy: VaultProfile = {
      ...profile,
      policy: {
        ...profile.policy,
        entries: [{ key: 'expandOnQuery', value: 'false', origin: 'manual' }],
      },
    };
    assert.equal(policyValue(withPolicy, 'expandOnQuery'), 'false');
  });
});
