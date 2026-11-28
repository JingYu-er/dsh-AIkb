import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addItem,
  decayScore,
  forgetItem,
  parseItems,
  planConsolidation,
  selectHot,
  serializeItems,
  summarizeMemory,
  touchItem,
  validateItem,
  verifyEvidence,
} from '../src/application/vault-memory.js';
import type { Evidence, EvidenceResolver, MemoryItem } from '../src/application/vault-memory.js';

const corpus: Record<string, string> = {
  'docs/a.md': 'Alpha beta gamma.\nSecond line with 120 件.',
  'docs/b.md': 'Gamma delta epsilon.',
  'docs/c.md': '库存为 120 件，待复核。',
  'docs/d.md': '库存为 150 件，待复核。',
};

const resolve: EvidenceResolver = (path) => corpus[path];
const shas: Record<string, string> = {
  'docs/a.md': 'sha-a',
  'docs/b.md': 'sha-b',
  'docs/c.md': 'sha-c',
  'docs/d.md': 'sha-d',
};
const NOW = '2026-06-01T00:00:00.000Z';

let counter = 0;

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    path: 'docs/a.md',
    unit: 'section',
    locator: 's1',
    quote: 'Alpha beta',
    sha: 'sha-a',
    ...overrides,
  };
}

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  counter += 1;
  return {
    id: `m-${String(counter).padStart(3, '0')}`,
    kind: 'claim',
    subject: '项目状态',
    statement: '当前进度为 42 件',
    evidence: [evidence()],
    status: 'derived',
    confidence: 0.7,
    importance: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    useCount: 0,
    ...overrides,
  };
}

describe('verifyEvidence', () => {
  it('matches a quote after normalising whitespace, case-sensitively', () => {
    const normalised = verifyEvidence(
      { path: 'docs/a.md', unit: 'page', locator: 'p1', quote: 'Alpha   beta\n gamma', sha: 'sha-a' },
      resolve,
      shas,
    );
    assert.deepEqual(normalised, { ok: true, problems: [] });

    const cased = verifyEvidence(
      { path: 'docs/a.md', unit: 'page', locator: 'p1', quote: 'alpha beta', sha: 'sha-a' },
      resolve,
      shas,
    );
    assert.equal(cased.ok, false);
    assert.ok(cased.problems.includes('quote-not-found'));
  });

  it('reports a sha mismatch against the current source hash', () => {
    const report = verifyEvidence(evidence(), resolve, { 'docs/a.md': 'sha-changed' });
    assert.equal(report.ok, false);
    assert.ok(report.problems.includes('sha-mismatch'));
  });

  it('reports a missing source', () => {
    const report = verifyEvidence(evidence({ path: 'docs/missing.md' }), resolve, shas);
    assert.deepEqual(report.problems, ['missing-source']);
    assert.equal(report.ok, false);
  });
});

describe('validateItem', () => {
  it('lets an unknown item carry no evidence only when allowUnknown is set', () => {
    const unknownItem = makeItem({ kind: 'unknown', evidence: [], statement: '尚未确认交付批次' });
    const strict = validateItem(unknownItem, resolve, shas);
    assert.equal(strict.ok, false);
    assert.ok(strict.problems.includes('evidence-required'));
    assert.equal(validateItem(unknownItem, resolve, shas, { allowUnknown: true }).ok, true);
  });

  it('rejects a claim without evidence', () => {
    const claim = makeItem({ evidence: [] });
    const report = validateItem(claim, resolve, shas);
    assert.equal(report.ok, false);
    assert.ok(report.problems.includes('evidence-required'));
  });

  it('rejects an item whose only evidence fails verification', () => {
    const item = makeItem({ id: 'bad-1', status: 'verified' });
    const report = validateItem(item, resolve, { 'docs/a.md': 'sha-changed' });
    assert.equal(report.ok, false);
    assert.ok(report.problems.includes('sha-mismatch'));
    assert.ok(report.problems.includes('no-valid-evidence'));
  });
});

describe('JSONL ledger', () => {
  it('round-trips through serializeItems and parseItems', () => {
    const a = makeItem({ id: 'a-1', subject: '仓库盘点', statement: '盘点已完成' });
    const b = makeItem({ id: 'b-2', kind: 'preference', subject: '输出格式', statement: '偏好表格', evidence: [] });
    assert.deepEqual(parseItems(serializeItems([b, a])), [a, b]);
  });

  it('skips blank and malformed lines without throwing', () => {
    const good = JSON.stringify({
      id: 'good',
      kind: 'claim',
      subject: 's',
      statement: 't',
      evidence: [],
      status: 'derived',
      confidence: 0.5,
      importance: 1,
      createdAt: NOW,
      lastUsedAt: NOW,
      useCount: 0,
    });
    const text = ['', '{not json', '{"id":1}', '{"id":"x","kind":"bogus","statement":"s"}', good].join('\n');
    const parsed = parseItems(text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, 'good');
  });

  it('serializes deterministically with a trailing newline', () => {
    const a = makeItem({ id: 'a' });
    const b = makeItem({ id: 'b' });
    assert.equal(serializeItems([a, b]), serializeItems([b, a]));
    assert.ok(serializeItems([a]).endsWith('\n'));
    assert.equal(serializeItems([]), '');
  });
});

describe('addItem', () => {
  it('appends a new item', () => {
    const result = addItem([], makeItem({ id: 'n-1' }));
    assert.equal(result.added, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.id, 'n-1');
  });

  it('merges a duplicate into the oldest id and unions evidence', () => {
    const existing = makeItem({ id: 'm-old', createdAt: '2025-01-01T00:00:00.000Z' });
    const incoming = makeItem({
      id: 'm-new',
      statement: '当前进度为  42  件',
      evidence: [evidence({ path: 'docs/b.md', locator: 's2', quote: 'Gamma delta', sha: 'sha-b' })],
      status: 'verified',
    });
    const result = addItem([existing], incoming);
    assert.equal(result.added, false);
    assert.equal(result.mergedInto, 'm-old');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.id, 'm-old');
    assert.equal(result.items[0]?.evidence.length, 2);
    assert.equal(result.items[0]?.status, 'verified');
    assert.equal(result.items[0]?.useCount, 0);
    assert.ok(result.items[0]?.lineage?.includes('m-new'));
  });

  it('keeps the better status when merging', () => {
    const verified = makeItem({ id: 'v-1', status: 'verified' });
    const derived = makeItem({ id: 'd-1', status: 'derived' });
    assert.equal(addItem([derived], verified).items[0]?.status, 'verified');
    assert.equal(addItem([verified], derived).items[0]?.status, 'verified');
  });
});

describe('touchItem and forgetItem', () => {
  it('increments useCount and sets lastUsedAt', () => {
    const item = makeItem({ id: 't-1' });
    const at = '2026-05-05T00:00:00.000Z';
    const touched = touchItem([item], 't-1', at);
    assert.equal(touched[0]?.useCount, 1);
    assert.equal(touched[0]?.lastUsedAt, at);
    assert.equal(touchItem([item], 'unknown-id', at)[0]?.useCount, 0);
  });

  it('removes an item and returns an audit line', () => {
    const item = makeItem({ id: 'f-1' });
    const result = forgetItem([item], 'f-1', { at: NOW, reason: '用户要求删除' });
    assert.equal(result.items.length, 0);
    assert.ok(result.audit.startsWith(NOW));
    assert.ok(result.audit.includes('f-1'));
    assert.ok(result.audit.includes('用户要求删除'));
  });

  it('requires force to forget a preference', () => {
    const pref = makeItem({ id: 'p-1', kind: 'preference', subject: '输出偏好', statement: '偏好简洁', evidence: [] });
    const refused = forgetItem([pref], 'p-1', { at: NOW, reason: '清理' });
    assert.equal(refused.items.length, 1);
    assert.ok(refused.audit.includes('force-required'));

    const forced = forgetItem([pref], 'p-1', { at: NOW, reason: '清理', force: true });
    assert.equal(forced.items.length, 0);
    assert.ok(forced.audit.includes('p-1'));
  });

  it('finds an item by subject when it is not an id', () => {
    const item = makeItem({ id: 's-1', subject: '待确认项' });
    const result = forgetItem([item], '待确认项', { at: NOW, reason: '过时' });
    assert.equal(result.items.length, 0);
    assert.ok(result.audit.includes('s-1'));
  });
});

describe('decayScore', () => {
  it('scores older items lower', () => {
    const recent = makeItem({ id: 'r', lastUsedAt: '2026-05-01T00:00:00.000Z' });
    const old = makeItem({ id: 'o', lastUsedAt: '2025-05-01T00:00:00.000Z' });
    assert.ok(decayScore(recent, NOW) > decayScore(old, NOW));
  });

  it('clamps future timestamps to zero age', () => {
    const future = makeItem({ id: 'f', lastUsedAt: '2027-01-01T00:00:00.000Z' });
    const current = makeItem({ id: 'c', lastUsedAt: NOW });
    assert.equal(decayScore(future, NOW), decayScore(current, NOW));
  });

  it('uses a shorter half-life for unknown items than for claims', () => {
    const ago = '2025-09-01T00:00:00.000Z';
    const unknownItem = makeItem({ kind: 'unknown', lastUsedAt: ago, evidence: [] });
    const claim = makeItem({ kind: 'claim', lastUsedAt: ago });
    assert.ok(decayScore(unknownItem, NOW) < decayScore(claim, NOW));
  });
});

describe('selectHot', () => {
  it('stops at the token budget and never selects stale items', () => {
    const long = 'x'.repeat(36);
    const stale = makeItem({ id: 'a-stale', status: 'stale', importance: 5, statement: long, subject: '' });
    const top = makeItem({ id: 'b-top', importance: 4, statement: long, subject: '' });
    const mid = makeItem({ id: 'c-mid', importance: 3, statement: long, subject: '' });
    const low = makeItem({ id: 'd-low', importance: 2, statement: long, subject: '' });
    const disputed = makeItem({ id: 'e-disputed', status: 'disputed', importance: 5, statement: long, subject: '' });
    const picked = selectHot([stale, disputed, top, mid, low], { budgetTokens: 20, now: NOW });
    assert.deepEqual(picked.hot.map((item) => item.id), ['b-top', 'c-mid']);
    assert.equal(picked.tokens, 18);
    assert.ok(picked.hot.every((item) => item.status !== 'stale'));
    assert.ok(picked.hot.every((item) => item.status !== 'disputed'), 'a contested claim must not be injected as background');
  });
});

describe('planConsolidation', () => {
  it('promotes a derived item with two distinct evidence paths', () => {
    const item = makeItem({
      id: 'promote-1',
      status: 'derived',
      evidence: [
        evidence(),
        evidence({ path: 'docs/b.md', locator: 's2', quote: 'Gamma delta', sha: 'sha-b' }),
      ],
    });
    const result = planConsolidation([item], { now: NOW, resolve, currentShas: shas });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.status, 'verified');
    assert.ok(result.actions.some((action) => action.kind === 'promote' && action.id === 'promote-1'));
  });

  it('promotes a single-path item only when the caller confirms it', () => {
    const item = makeItem({ id: 'promote-2', status: 'derived' });
    const unconfirmed = planConsolidation([item], { now: NOW, resolve, currentShas: shas });
    assert.equal(unconfirmed.items[0]?.status, 'derived');

    const confirmed = planConsolidation([item], {
      now: NOW,
      resolve,
      currentShas: shas,
      usedIds: ['promote-2'],
    });
    assert.equal(confirmed.items[0]?.status, 'verified');
    assert.ok(confirmed.actions.some((action) => action.kind === 'promote' && action.id === 'promote-2'));
  });

  it('marks an item stale when no evidence still resolves, but never preferences', () => {
    const gone = makeItem({ id: 'stale-1', status: 'verified', evidence: [evidence({ sha: 'old-sha' })] });
    const pref = makeItem({
      id: 'stale-2',
      kind: 'preference',
      status: 'verified',
      evidence: [evidence({ sha: 'old-sha' })],
    });
    const result = planConsolidation([gone, pref], { now: NOW, resolve, currentShas: shas });
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0]?.status, 'stale');
    assert.equal(result.items[1]?.status, 'verified');
    assert.ok(result.actions.some((action) => action.kind === 'stale' && action.id === 'stale-1'));
  });

  it('marks both sides of a numeric contradiction disputed', () => {
    const left = makeItem({
      id: 'dispute-1',
      status: 'verified',
      subject: '库存数量',
      statement: '库存为 120 件',
      evidence: [evidence({ path: 'docs/c.md', quote: '库存为 120 件', sha: 'sha-c' })],
    });
    const right = makeItem({
      id: 'dispute-2',
      status: 'verified',
      subject: '库存数量',
      statement: '库存为 150 件',
      evidence: [evidence({ path: 'docs/d.md', quote: '库存为 150 件', sha: 'sha-d' })],
    });
    const result = planConsolidation([left, right], { now: NOW, resolve, currentShas: shas });
    assert.equal(result.items[0]?.status, 'disputed');
    assert.equal(result.items[1]?.status, 'disputed');
    const disputes = result.actions.filter((action) => action.kind === 'dispute');
    assert.equal(disputes.length, 2);
    assert.ok(disputes.some((action) => action.id === 'dispute-1' && action.relatedId === 'dispute-2'));
  });

  it('merges near-identical statements into the oldest id and keeps lineage', () => {
    const older = makeItem({
      id: 'old-1',
      subject: '摘要质量',
      statement: '摘要缺少来源说明',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    const newer = makeItem({
      id: 'new-1',
      subject: '摘要质量',
      statement: '摘要缺少来源说明。',
      createdAt: '2026-01-01T00:00:00.000Z',
      evidence: [evidence({ path: 'docs/b.md', locator: 's2', quote: 'Gamma delta', sha: 'sha-b' })],
    });
    const result = planConsolidation([older, newer], { now: NOW, resolve, currentShas: shas });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.id, 'old-1');
    assert.deepEqual(result.items[0]?.lineage, ['new-1']);
    assert.equal(result.items[0]?.evidence.length, 2);
    assert.ok(
      result.actions.some(
        (action) => action.kind === 'dedupe' && action.id === 'old-1' && action.relatedId === 'new-1',
      ),
    );
  });

  it('never deletes items while repairing statuses', () => {
    const missing = makeItem({ id: 'm-miss', status: 'verified', evidence: [evidence({ path: 'docs/gone.md' })] });
    const pref = makeItem({
      id: 'p-miss',
      kind: 'preference',
      status: 'verified',
      evidence: [evidence({ path: 'docs/gone.md' })],
    });
    const result = planConsolidation([missing, pref], { now: NOW, resolve, currentShas: shas });
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every((item) => item.statement.length > 0));
    assert.equal(result.items[0]?.status, 'stale');
    assert.equal(result.items[1]?.status, 'verified');
  });
});

describe('summarizeMemory', () => {
  it('counts kinds and statuses and returns the five most recently used', () => {
    const items = [
      makeItem({ id: 'a', kind: 'claim', status: 'verified', lastUsedAt: '2026-05-01T00:00:00.000Z' }),
      makeItem({ id: 'b', kind: 'unknown', status: 'derived', lastUsedAt: '2026-05-02T00:00:00.000Z', evidence: [] }),
      makeItem({ id: 'c', kind: 'preference', status: 'verified', lastUsedAt: '2026-05-03T00:00:00.000Z', evidence: [] }),
      makeItem({ id: 'd', kind: 'tension', status: 'disputed', lastUsedAt: '2026-05-04T00:00:00.000Z' }),
      makeItem({ id: 'e', kind: 'claim', status: 'stale', lastUsedAt: '2026-05-05T00:00:00.000Z' }),
      makeItem({ id: 'f', kind: 'claim', status: 'derived', lastUsedAt: '2026-05-06T00:00:00.000Z' }),
    ];
    const summary = summarizeMemory(items);
    assert.equal(summary.total, 6);
    assert.equal(summary.byKind.claim, 3);
    assert.equal(summary.byKind.unknown, 1);
    assert.equal(summary.byKind.preference, 1);
    assert.equal(summary.byKind.tension, 1);
    assert.equal(summary.byStatus.verified, 2);
    assert.equal(summary.byStatus.derived, 2);
    assert.equal(summary.byStatus.disputed, 1);
    assert.equal(summary.byStatus.stale, 1);
    assert.deepEqual(summary.recent.map((item) => item.id), ['f', 'e', 'd', 'c', 'b']);
  });
});
