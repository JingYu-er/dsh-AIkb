/**
 * Per-vault memory ledger: conclusions (claims), open unknowns, preferences and
 * unresolved tensions, each backed by evidence that can be re-verified against
 * the current sources.
 *
 * The module is pure: no fs, no network, no model calls. Callers supply a
 * resolver that returns the current text of a source unit and a map of current
 * source hashes, so verification and consolidation are reproducible.
 */

export type MemoryKind = 'claim' | 'unknown' | 'preference' | 'tension';

export type EvidenceUnit = 'page' | 'section' | 'chunk';

export interface Evidence {
  path: string;
  unit: EvidenceUnit;
  locator: string;
  quote: string;
  sha: string;
}

export type MemoryStatus = 'verified' | 'derived' | 'disputed' | 'stale';

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  subject: string;
  statement: string;
  attribution?: string;
  scope?: Record<string, string>;
  evidence: Evidence[];
  status: MemoryStatus;
  confidence: number;
  importance: number;
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
  lineage?: string[];
}

export const MEMORY_DIR = '.wiki/memory';
export const ITEMS_PATH = '.wiki/memory/items.jsonl';
export const CONSOLIDATION_LOG = '.wiki/memory/consolidation.log';

/** Returns the current text of one source unit, or undefined when it is gone. */
export type EvidenceResolver = (path: string, unit: EvidenceUnit, locator: string) => string | undefined;

export interface EvidenceReport {
  ok: boolean;
  problems: string[];
}

export interface ValidateOptions {
  /** Allow a kind 'unknown' item to carry no evidence at all. Defaults to false. */
  allowUnknown?: boolean;
}

export interface AddItemOptions {
  /** Reject the incoming item unless its evidence verifies. Defaults to false. */
  requireValidEvidence?: boolean;
  resolve?: EvidenceResolver;
  currentShas?: Record<string, string>;
  /** Forwarded to validateItem when requireValidEvidence is set. Defaults to true. */
  allowUnknown?: boolean;
}

export interface SelectHotOptions {
  /** Token budget for the selected items. Defaults to 400. */
  budgetTokens?: number;
  now: string;
  minScore?: number;
}

export interface ForgetOptions {
  at?: string;
  reason?: string;
  /** Required to forget a preference or an unknown item. */
  force?: boolean;
}

export type ConsolidationActionKind = 'dedupe' | 'promote' | 'stale' | 'dispute';

export interface ConsolidationAction {
  kind: ConsolidationActionKind;
  /** Primary item this action applies to. */
  id: string;
  /** The other item involved, when the action compares or merges two items. */
  relatedId?: string;
  reason: string;
}

export interface ConsolidationContext {
  now: string;
  resolve: EvidenceResolver;
  currentShas: Record<string, string>;
  /** Ids the caller confirms; treated as confirmation for promotion. */
  usedIds?: readonly string[];
  /** Explicit confirmation ids; same effect as usedIds. */
  confirmedIds?: readonly string[];
}

export interface MemorySummary {
  total: number;
  byKind: Record<MemoryKind, number>;
  byStatus: Record<MemoryStatus, number>;
  recent: MemoryItem[];
}

const DAY_MS = 86_400_000;
const RECENT_LIMIT = 5;

const KINDS: readonly MemoryKind[] = ['claim', 'unknown', 'preference', 'tension'];
const STATUSES: readonly MemoryStatus[] = ['verified', 'derived', 'disputed', 'stale'];
const UNITS: readonly EvidenceUnit[] = ['page', 'section', 'chunk'];

const DECAY_TAU_DAYS: Record<MemoryKind, number> = {
  claim: 3650,
  tension: 120,
  preference: 180,
  unknown: 90,
};

const STATUS_ORDER: Record<MemoryStatus, number> = {
  verified: 3,
  derived: 2,
  disputed: 1,
  stale: 0,
};

const QUANTITY_PATTERN = /(-?\d+(?:\.\d+)?)\s*([A-Za-z%\u2030]+|[\u4e00-\u9fff]+)?/;

interface Quantity {
  value: number;
  unit: string;
  text: string;
}

function isKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

function isUnit(value: unknown): value is EvidenceUnit {
  return typeof value === 'string' && (UNITS as readonly string[]).includes(value);
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Normalised form used for de-duplication and grouping. */
function normalizeKey(value: string): string {
  return normalizeSpace(value).toLowerCase();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function betterStatus(a: MemoryStatus, b: MemoryStatus): MemoryStatus {
  return STATUS_ORDER[b] > STATUS_ORDER[a] ? b : a;
}

function evidenceKey(evidence: Evidence): string {
  return [evidence.path, evidence.unit, evidence.locator, evidence.sha].join('\u0000');
}

function unionEvidence(base: readonly Evidence[], extra: readonly Evidence[]): Evidence[] {
  const merged = [...base];
  const seen = new Set(base.map(evidenceKey));
  for (const entry of extra) {
    const key = evidenceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...entry });
  }
  return merged;
}

function cloneItem(item: MemoryItem): MemoryItem {
  const copy: MemoryItem = {
    ...item,
    evidence: item.evidence.map((entry) => ({ ...entry })),
  };
  if (item.scope !== undefined) copy.scope = { ...item.scope };
  if (item.lineage !== undefined) copy.lineage = [...item.lineage];
  return copy;
}

function coerceEvidence(raw: unknown): Evidence | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const path = record['path'];
  const unit = record['unit'];
  const locator = record['locator'];
  const quote = record['quote'];
  const sha = record['sha'];
  if (typeof path !== 'string' || path.length === 0) return undefined;
  if (!isUnit(unit)) return undefined;
  if (typeof locator !== 'string' || typeof quote !== 'string' || typeof sha !== 'string') return undefined;
  return { path, unit, locator, quote, sha };
}

function coerceItem(raw: unknown): MemoryItem | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = record['id'];
  const kind = record['kind'];
  const statement = record['statement'];
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (!isKind(kind) || typeof statement !== 'string') return undefined;

  const evidence: Evidence[] = [];
  const rawEvidence = record['evidence'];
  if (Array.isArray(rawEvidence)) {
    for (const entry of rawEvidence) {
      const parsed = coerceEvidence(entry);
      if (parsed !== undefined) evidence.push(parsed);
    }
  }

  const item: MemoryItem = {
    id,
    kind,
    subject: typeof record['subject'] === 'string' ? record['subject'] : '',
    statement,
    evidence,
    status: isStatus(record['status']) ? record['status'] : 'derived',
    confidence: clampNumber(record['confidence'], 0, 1, 0),
    importance: clampNumber(record['importance'], 0, 5, 0),
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
    lastUsedAt: typeof record['lastUsedAt'] === 'string' ? record['lastUsedAt'] : '',
    useCount: Math.floor(clampNumber(record['useCount'], 0, Number.MAX_SAFE_INTEGER, 0)),
  };
  if (item.lastUsedAt.length === 0) item.lastUsedAt = item.createdAt;
  if (typeof record['attribution'] === 'string' && record['attribution'].length > 0) {
    item.attribution = record['attribution'];
  }
  if (isStringMap(record['scope'])) item.scope = { ...record['scope'] };
  const rawLineage = record['lineage'];
  if (Array.isArray(rawLineage)) {
    const lineage = rawLineage.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (lineage.length > 0) item.lineage = lineage;
  }
  return item;
}

/**
 * Check one evidence entry against the resolver and the current hashes.
 * Whitespace runs are normalised; the quote comparison stays case-sensitive.
 */
export function verifyEvidence(
  evidence: Evidence,
  resolve: EvidenceResolver,
  currentShas: Record<string, string>,
): EvidenceReport {
  const problems: string[] = [];
  const currentSha = currentShas[evidence.path];
  if (typeof currentSha === 'string' && currentSha !== evidence.sha) problems.push('sha-mismatch');

  let source: string | undefined;
  try {
    source = resolve(evidence.path, evidence.unit, evidence.locator);
  } catch {
    source = undefined;
  }

  if (source === undefined) {
    problems.push('missing-source');
  } else {
    const haystack = normalizeSpace(source);
    const needle = normalizeSpace(evidence.quote);
    if (needle.length === 0 || !haystack.includes(needle)) problems.push('quote-not-found');
  }

  return { ok: problems.length === 0, problems };
}

function checkEvidenceShape(evidence: Evidence): boolean {
  return (
    typeof evidence.path === 'string' &&
    evidence.path.length > 0 &&
    isUnit(evidence.unit) &&
    typeof evidence.locator === 'string' &&
    typeof evidence.quote === 'string' &&
    typeof evidence.sha === 'string'
  );
}

/**
 * Validate an item as it would be stored: identity fields, numeric ranges and
 * evidence. A non-'unknown' item needs at least one fully valid evidence entry;
 * an 'unknown' item may omit evidence only when allowUnknown is set.
 */
export function validateItem(
  item: MemoryItem,
  resolve: EvidenceResolver,
  currentShas: Record<string, string>,
  options: ValidateOptions = {},
): EvidenceReport {
  const problems: string[] = [];
  if (normalizeSpace(item.subject).length === 0) problems.push('empty-subject');
  if (normalizeSpace(item.statement).length === 0) problems.push('empty-statement');
  if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    problems.push('bad-confidence');
  }
  if (!Number.isFinite(item.importance) || item.importance < 0 || item.importance > 5) {
    problems.push('bad-importance');
  }

  let valid = 0;
  for (const evidence of item.evidence) {
    if (!checkEvidenceShape(evidence)) {
      problems.push('invalid-evidence');
      continue;
    }
    const report = verifyEvidence(evidence, resolve, currentShas);
    if (report.ok) {
      valid += 1;
      continue;
    }
    for (const problem of report.problems) problems.push(problem);
  }

  const allowUnknown = options.allowUnknown === true;
  if (item.evidence.length === 0) {
    if (!(item.kind === 'unknown' && allowUnknown)) problems.push('evidence-required');
  } else if (valid === 0) {
    if (!(item.kind === 'unknown' && allowUnknown)) problems.push('no-valid-evidence');
  }

  return { ok: problems.length === 0, problems };
}

/** Parse a JSONL ledger; blank and malformed lines are skipped, never thrown. */
export function parseItems(text: string): MemoryItem[] {
  const items: MemoryItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const item = coerceItem(raw);
    if (item !== undefined) items.push(item);
  }
  return items;
}

function sortedScope(scope: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(scope).sort()) {
    const value = scope[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

function itemToJson(item: MemoryItem): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: item.id,
    kind: item.kind,
    subject: item.subject,
    statement: item.statement,
  };
  if (item.attribution !== undefined && item.attribution.length > 0) json['attribution'] = item.attribution;
  if (item.scope !== undefined) json['scope'] = sortedScope(item.scope);
  json['evidence'] = item.evidence.map((evidence) => ({
    path: evidence.path,
    unit: evidence.unit,
    locator: evidence.locator,
    quote: evidence.quote,
    sha: evidence.sha,
  }));
  json['status'] = item.status;
  json['confidence'] = item.confidence;
  json['importance'] = item.importance;
  json['createdAt'] = item.createdAt;
  json['lastUsedAt'] = item.lastUsedAt;
  json['useCount'] = item.useCount;
  if (item.lineage !== undefined && item.lineage.length > 0) json['lineage'] = [...item.lineage];
  return json;
}

/** Serialize deterministically: stable key order, sorted by id, trailing newline. */
export function serializeItems(items: readonly MemoryItem[]): string {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (sorted.length === 0) return '';
  return sorted.map((item) => JSON.stringify(itemToJson(item))).join('\n') + '\n';
}

function dedupeKey(item: MemoryItem): string {
  return [item.kind, normalizeKey(item.subject), normalizeKey(item.statement)].join('\u0000');
}

function mergeInto(target: MemoryItem, incoming: MemoryItem): void {
  target.evidence = unionEvidence(target.evidence, incoming.evidence);
  target.status = betterStatus(target.status, incoming.status);
  if (target.attribution === undefined && incoming.attribution !== undefined) {
    target.attribution = incoming.attribution;
  }
  if (incoming.scope !== undefined) {
    target.scope = { ...incoming.scope, ...(target.scope ?? {}) };
  }
  const latest = Date.parse(incoming.lastUsedAt);
  const current = Date.parse(target.lastUsedAt);
  if (Number.isFinite(latest) && (!Number.isFinite(current) || latest > current)) {
    target.lastUsedAt = incoming.lastUsedAt;
  }
  const lineage = unique([
    ...(target.lineage ?? []),
    ...(incoming.lineage ?? []),
    ...(incoming.id === target.id ? [] : [incoming.id]),
  ]);
  if (lineage.length > 0) target.lineage = lineage;
}

/**
 * Add an item, de-duplicating by (kind, subject, normalised statement). A
 * duplicate only unions evidence, keeps the better status and records lineage;
 * it never touches useCount.
 */
export function addItem(
  items: readonly MemoryItem[],
  item: MemoryItem,
  options: AddItemOptions = {},
): { items: MemoryItem[]; added: boolean; mergedInto?: string } {
  if (options.requireValidEvidence === true) {
    if (options.resolve === undefined) return { items: [...items], added: false };
    const report = validateItem(item, options.resolve, options.currentShas ?? {}, {
      allowUnknown: options.allowUnknown ?? true,
    });
    if (!report.ok) return { items: [...items], added: false };
  }

  const key = dedupeKey(item);
  const index = items.findIndex((existing) => dedupeKey(existing) === key);
  if (index >= 0) {
    const existing = items[index];
    if (existing === undefined) return { items: [...items], added: false };
    const merged = cloneItem(existing);
    mergeInto(merged, item);
    const next = [...items];
    next[index] = merged;
    return { items: next, added: false, mergedInto: existing.id };
  }
  return { items: [...items, cloneItem(item)], added: true };
}

/** Record one use of an item: increments useCount and sets lastUsedAt. */
export function touchItem(items: readonly MemoryItem[], id: string, at: string): MemoryItem[] {
  return items.map((item) =>
    item.id === id ? { ...item, useCount: item.useCount + 1, lastUsedAt: at } : item,
  );
}

/**
 * Forget one item by id, or the first item by subject. Preferences and unknown
 * items need force; the returned audit line always states the outcome.
 */
export function forgetItem(
  items: readonly MemoryItem[],
  idOrSubject: string,
  options: ForgetOptions = {},
): { items: MemoryItem[]; audit: string } {
  const at = options.at ?? new Date().toISOString();
  const reason = options.reason ?? 'unspecified';
  const index = items.findIndex(
    (item) => item.id === idOrSubject || normalizeSpace(item.subject) === normalizeSpace(idOrSubject),
  );
  const target = index >= 0 ? items[index] : undefined;
  if (target === undefined) {
    return { items: [...items], audit: `${at} forget target=${idOrSubject} result=not-found reason=${reason}` };
  }

  const guarded = target.kind === 'preference' || target.kind === 'unknown';
  if (guarded && options.force !== true) {
    return {
      items: [...items],
      audit: `${at} forget-refused item=${target.id} kind=${target.kind} subject="${target.subject}" reason=${reason} note=force-required`,
    };
  }

  const next = items.filter((_, position) => position !== index);
  const audit = `${at} forget item=${target.id} kind=${target.kind} subject="${target.subject}" reason=${reason}${options.force === true ? ' forced' : ''}`;
  return { items: next, audit };
}

function referenceTime(item: MemoryItem): number {
  const used = Date.parse(item.lastUsedAt);
  if (Number.isFinite(used)) return used;
  const created = Date.parse(item.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/**
 * Time decay score: importance * exp(-days / tau) * (1 + log(1 + useCount)),
 * where tau depends on the kind. Future timestamps clamp the age to zero.
 */
export function decayScore(item: MemoryItem, now: string): number {
  const nowMs = Date.parse(now);
  const reference = referenceTime(item);
  let deltaDays = 0;
  if (Number.isFinite(nowMs)) {
    deltaDays = Math.max(0, (nowMs - reference) / DAY_MS);
  }
  const tau = DECAY_TAU_DAYS[item.kind] ?? DECAY_TAU_DAYS.claim;
  const uses = Math.max(0, item.useCount);
  return item.importance * Math.exp(-deltaDays / tau) * (1 + Math.log(1 + uses));
}

function estimateTokens(item: MemoryItem): number {
  const chars = item.statement.length + item.subject.length + (item.attribution?.length ?? 0);
  return Math.ceil(chars / 4);
}

/** Select the highest-scoring non-stale items that fit the token budget. */
export function selectHot(
  items: readonly MemoryItem[],
  options: SelectHotOptions,
): { hot: MemoryItem[]; tokens: number } {
  const budget = options.budgetTokens ?? 400;
  const minScore = options.minScore ?? 0;
  const scored = items
    .filter((item) => item.status !== 'stale')
    .map((item) => ({ item, score: decayScore(item, options.now) }))
    .filter((entry) => entry.score >= minScore);
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });

  const hot: MemoryItem[] = [];
  let tokens = 0;
  for (const entry of scored) {
    const cost = estimateTokens(entry.item);
    if (tokens + cost > budget) break;
    hot.push(entry.item);
    tokens += cost;
  }
  return { hot, tokens };
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function isNearDuplicate(a: string, b: string): boolean {
  const left = normalizeKey(a);
  const right = normalizeKey(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const longest = Math.max(left.length, right.length);
  return editDistance(left, right) <= longest * 0.1;
}

/** True when both statements carry a comparable quantity with different values. */
function quantitiesConflict(statementA: string, statementB: string): boolean {
  const left = firstQuantity(statementA);
  const right = firstQuantity(statementB);
  if (left === undefined || right === undefined) return false;
  if (!unitsComparable(left.unit, right.unit)) return false;
  return left.value !== right.value;
}

function compareByAge(a: MemoryItem, b: MemoryItem): number {
  const left = Date.parse(a.createdAt);
  const right = Date.parse(b.createdAt);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function firstQuantity(statement: string): Quantity | undefined {
  const match = QUANTITY_PATTERN.exec(statement);
  if (match === null) return undefined;
  const value = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(value)) return undefined;
  const token = match[2] ?? '';
  let unit = '';
  if (/^[A-Za-z%\u2030]+$/.test(token)) {
    if (token.length <= 8) unit = token.toLowerCase();
  } else if (/^[\u4e00-\u9fff]+$/.test(token)) {
    if (token.length <= 2) unit = token;
  }
  return { value, unit, text: token.length > 0 ? `${value} ${token}` : String(value) };
}

function unitsComparable(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a === b;
}

/**
 * Plan a consolidation pass. Never deletes a statement: duplicates are merged
 * into the oldest id, promoted items gain verified status, evidence that no
 * longer resolves marks the item stale (preferences and unknowns excluded), and
 * two conflicting verified claims are both marked disputed without resolution.
 */
export function planConsolidation(
  items: readonly MemoryItem[],
  context: ConsolidationContext,
): { actions: ConsolidationAction[]; items: MemoryItem[] } {
  const actions: ConsolidationAction[] = [];
  const working = items.map(cloneItem);
  const removed = new Set<string>();

  const groups = new Map<string, MemoryItem[]>();
  for (const item of working) {
    const key = `${item.kind}\u0000${normalizeKey(item.subject)}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [item]);
    else bucket.push(item);
  }

  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const ordered = [...bucket].sort(compareByAge);
    const kept: MemoryItem[] = [];
    for (const item of ordered) {
      const match = kept.find(
        (candidate) =>
          isNearDuplicate(candidate.statement, item.statement) &&
          !quantitiesConflict(candidate.statement, item.statement),
      );
      if (match === undefined) {
        kept.push(item);
        continue;
      }
      mergeInto(match, item);
      removed.add(item.id);
      actions.push({
        kind: 'dedupe',
        id: match.id,
        relatedId: item.id,
        reason: `near-identical statement under the same subject; merged ${item.id} into ${match.id}`,
      });
    }
  }

  const survivors = working.filter((item) => !removed.has(item.id));
  const confirmed = new Set<string>([...(context.usedIds ?? []), ...(context.confirmedIds ?? [])]);

  for (const item of survivors) {
    if (item.status !== 'derived') continue;
    const paths = new Set(item.evidence.map((entry) => entry.path).filter((path) => path.length > 0));
    if (paths.size >= 2) {
      item.status = 'verified';
      actions.push({ kind: 'promote', id: item.id, reason: `verified by ${paths.size} distinct evidence paths` });
    } else if (confirmed.has(item.id)) {
      item.status = 'verified';
      actions.push({ kind: 'promote', id: item.id, reason: 'explicitly confirmed by the caller' });
    }
  }

  for (const item of survivors) {
    if (item.kind === 'preference' || item.kind === 'unknown') continue;
    if (item.status === 'stale' || item.evidence.length === 0) continue;
    let valid = 0;
    const problems: string[] = [];
    for (const evidence of item.evidence) {
      const report = verifyEvidence(evidence, context.resolve, context.currentShas);
      if (report.ok) valid += 1;
      for (const problem of report.problems) {
        if (problem === 'sha-mismatch' || problem === 'missing-source') problems.push(problem);
      }
    }
    if (valid === 0 && problems.length > 0) {
      item.status = 'stale';
      actions.push({ kind: 'stale', id: item.id, reason: `no usable evidence (${unique(problems).join(', ')})` });
    }
  }

  const bySubject = new Map<string, MemoryItem[]>();
  for (const item of survivors) {
    if (item.kind !== 'claim' || item.status !== 'verified') continue;
    const key = normalizeKey(item.subject);
    const bucket = bySubject.get(key);
    if (bucket === undefined) bySubject.set(key, [item]);
    else bucket.push(item);
  }

  const partners = new Map<string, { otherId: string; reason: string }>();
  for (const bucket of bySubject.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      const left = bucket[i];
      if (left === undefined) continue;
      const leftQuantity = firstQuantity(left.statement);
      if (leftQuantity === undefined) continue;
      for (let j = i + 1; j < bucket.length; j += 1) {
        const right = bucket[j];
        if (right === undefined) continue;
        const rightQuantity = firstQuantity(right.statement);
        if (rightQuantity === undefined) continue;
        if (!unitsComparable(leftQuantity.unit, rightQuantity.unit)) continue;
        if (leftQuantity.value === rightQuantity.value) continue;
        left.status = 'disputed';
        right.status = 'disputed';
        const pairs: [MemoryItem, MemoryItem, Quantity, Quantity][] = [
          [left, right, leftQuantity, rightQuantity],
          [right, left, rightQuantity, leftQuantity],
        ];
        for (const [self, other, own, theirs] of pairs) {
          if (partners.has(self.id)) continue;
          partners.set(self.id, {
            otherId: other.id,
            reason: `contradicts ${other.id}: ${own.text} vs ${theirs.text}`,
          });
        }
      }
    }
  }
  for (const [id, info] of partners) {
    actions.push({ kind: 'dispute', id, relatedId: info.otherId, reason: info.reason });
  }

  return { actions, items: survivors };
}

/** Counts by kind/status plus the five most recently used items. */
export function summarizeMemory(items: readonly MemoryItem[]): MemorySummary {
  const byKind: Record<MemoryKind, number> = { claim: 0, unknown: 0, preference: 0, tension: 0 };
  const byStatus: Record<MemoryStatus, number> = { verified: 0, derived: 0, disputed: 0, stale: 0 };
  for (const item of items) {
    byKind[item.kind] += 1;
    byStatus[item.status] += 1;
  }
  const recent = [...items]
    .sort((a, b) => {
      const left = Date.parse(a.lastUsedAt);
      const right = Date.parse(b.lastUsedAt);
      if ((Number.isFinite(right) ? right : 0) !== (Number.isFinite(left) ? left : 0)) {
        return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, RECENT_LIMIT);
  return { total: items.length, byKind, byStatus, recent };
}
