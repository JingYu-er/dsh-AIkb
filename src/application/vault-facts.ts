/**
 * L2 fact cache: one row per (entity, field, qualifiers), answered from
 * .wiki/index/facts.json instead of re-reading the documents behind it.
 *
 * Documents stay the source of truth. A fact is disposable: it records the sha
 * of every source it was extracted from, so a changed document turns the fact
 * into a rebuild candidate (planFactWork) or drops it (invalidateFacts). The
 * module is pure - no fs, no network, no model - the caller supplies current
 * hashes and, when a quote check is wanted, an evidence resolver.
 */

import { DomainError } from '../shared/result.js';
import { verifyEvidence } from './vault-memory.js';
import type { Evidence, EvidenceResolver, EvidenceUnit } from './vault-memory.js';
import { findEntities } from './vault-map.js';
import type { MapFile } from './vault-map.js';

/** Facts live next to the other compiled artefacts and are safe to delete. */
export const FACTS_PATH = '.wiki/index/facts.json';
export const FACTS_SCHEMA = 'dsh-aikb/facts@1';
export const FACTS_VERSION = 1;
/** Upper bound on stored facts; beyond it the least recently used rows go. */
export const MAX_ENTRIES = 20000;
export const MAX_EVIDENCE_PER_FACT = 8;

/** Free-form slot such as { unit: 'kg' } or { phase: 'solid' }. */
export type FactQualifier = Record<string, string>;

export type FactStatus = 'derived' | 'verified' | 'disputed';

export interface FactEntry {
  /** Derived from (entityId, field, qualifiers); never hand-written. */
  id: string;
  entityId: string;
  entityLabel: string;
  field: string;
  qualifiers?: FactQualifier;
  value: string;
  unit?: string;
  /** Value parsed once at extraction time; readers fall back to the leading number. */
  numeric?: number;
  evidence: Evidence[];
  /** Vault-relative paths, sorted; the freshness check keys off these. */
  sources: string[];
  shaByPath: Record<string, string>;
  extractor: string;
  status: FactStatus;
  confidence: number;
  updatedAt: string;
  lastUsedAt: string;
  useCount: number;
}

export interface FactsFile {
  schema: typeof FACTS_SCHEMA;
  version: number;
  builtAt: string;
  entries: FactEntry[];
}

/** One unit of extraction work: an entity x field cell that has no usable fact yet. */
export interface FactWork {
  entityId: string;
  entityLabel: string;
  field: string;
  qualifiers?: FactQualifier;
}

export interface WorkPlan {
  /** Cells to extract for the first time. */
  work: FactWork[];
  /** Facts whose sources still hash the same; no extraction needed. */
  reuse: FactEntry[];
  /** Facts whose sources changed; they must be recomputed. */
  rebuild: FactEntry[];
  /** Requested entity names the map does not know. */
  missingEntities: string[];
}

export interface PlanFactRequest {
  /** Names to resolve through the map: ids, labels or aliases. */
  entities: readonly string[];
  fields: readonly string[];
  /** Applied to every planned cell. */
  qualifiers?: FactQualifier;
  currentShas: Record<string, string>;
  /** Accepted for callers that pass a clock; planning is time-independent. */
  now?: Date;
}

export interface UpsertFactOptions {
  now?: Date;
  /** false keeps an existing same-id entry untouched. Defaults to true. */
  replace?: boolean;
  /** When supplied, every evidence quote is re-checked against the source text. */
  resolve?: EvidenceResolver;
  currentShas?: Record<string, string>;
}

export interface InvalidateOptions {
  now?: Date;
}

export interface SelectFactsOptions {
  entityIds?: readonly string[];
  fields?: readonly string[];
  max?: number;
  /** Disputed facts are hidden unless this is set. */
  includeDisputed?: boolean;
}

export interface FactCompareRow {
  entityId: string;
  entityLabel: string;
  value: string;
  unit?: string;
  status: FactStatus;
  /** Number of evidence entries behind the row. */
  evidence: number;
  /** First evidence as path#locator, when the caller passed facts rather than rows. */
  source?: string;
}

export interface FactCompareGroup {
  field: string;
  rows: FactCompareRow[];
}

/** Two verified facts on the same cell that disagree numerically. */
export interface FactConflict {
  field: string;
  values: string[];
}

export interface FactComparison {
  groups: FactCompareGroup[];
  conflicts: FactConflict[];
}

const STATUS_TRUST: Record<FactStatus, number> = { verified: 3, derived: 2, disputed: 1 };
const STATUS_ORDER: Record<FactStatus, number> = { verified: 0, derived: 1, disputed: 2 };
const EVIDENCE_UNITS: readonly EvidenceUnit[] = ['page', 'section', 'chunk'];
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/;
const ID_UNSAFE = /[^\p{L}\p{N}._-]+/gu;
const NUMBER_TOLERANCE = 1e-9;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Readable, hash-free id: entity--field--key=value. Qualifiers are normalised
 * first, so the id does not depend on the order the caller wrote them in.
 * Characters outside letters, digits and ._- collapse to a single dash.
 */
export function factId(entityId: string, field: string, qualifiers?: FactQualifier): string {
  const parts = [slugSegment(entityId), slugSegment(field)];
  const normalized = normalizeQualifiers(qualifiers);
  if (normalized !== undefined) {
    for (const [key, value] of Object.entries(normalized)) {
      parts.push(slugSegment(key) + '=' + slugSegment(value));
    }
  }
  return parts.join('--');
}

function slugSegment(value: string): string {
  if (typeof value !== 'string') return '_';
  const slug = value
    .normalize('NFC')
    .trim()
    .replace(ID_UNSAFE, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug.length > 0 ? slug : '_';
}

/**
 * Lower-case keys, trim values, drop empties, sort by key. An empty set becomes
 * undefined so that "no qualifiers" and "{}" share one identity.
 */
export function normalizeQualifiers(qualifiers?: FactQualifier): FactQualifier | undefined {
  if (qualifiers === undefined || qualifiers === null) return undefined;
  const pairs: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(qualifiers)) {
    if (typeof rawValue !== 'string') continue;
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (key.length === 0 || value.length === 0) continue;
    pairs.push([key, value]);
  }
  if (pairs.length === 0) return undefined;
  pairs.sort((left, right) => compareText(left[0], right[0]) || compareText(left[1], right[1]));
  const normalized: FactQualifier = {};
  for (const [key, value] of pairs) normalized[key] = value;
  return normalized;
}

function qualifierPairs(qualifiers: FactQualifier | undefined): string[] {
  const normalized = normalizeQualifiers(qualifiers);
  if (normalized === undefined) return [];
  return Object.entries(normalized).map(([key, value]) => key + '=' + value);
}

/** Identity used for planning and conflict detection; not persisted. */
function factKey(entityId: string, field: string, qualifiers?: FactQualifier): string {
  return [entityId, field, ...qualifierPairs(qualifiers)].join('\u0000');
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Decide which cells to extract, reuse or rebuild. Reuse is decided purely from
 * the shas recorded on the fact, so planning never touches the filesystem.
 */
export function planFactWork(
  map: MapFile,
  existing: FactsFile | undefined,
  request: PlanFactRequest,
): WorkPlan {
  const qualifiers = normalizeQualifiers(request.qualifiers);
  const known = new Map<string, FactEntry>();
  for (const entry of existing?.entries ?? []) {
    const key = factKey(entry.entityId, entry.field, entry.qualifiers);
    if (!known.has(key)) known.set(key, entry);
  }

  const fields: string[] = [];
  for (const raw of request.fields) {
    if (typeof raw !== 'string') continue;
    const field = raw.trim();
    if (field.length > 0 && !fields.includes(field)) fields.push(field);
  }

  const work: FactWork[] = [];
  const reuse: FactEntry[] = [];
  const rebuild: FactEntry[] = [];
  const missingEntities: string[] = [];
  const seenWork = new Set<string>();
  const seenEntries = new Set<string>();

  for (const name of request.entities) {
    if (typeof name !== 'string') continue;
    const entity = findEntities(map, name)[0];
    if (entity === undefined) {
      const label = name.trim();
      if (label.length > 0 && !missingEntities.includes(label)) missingEntities.push(label);
      continue;
    }
    for (const field of fields) {
      const key = factKey(entity.id, field, qualifiers);
      const found = known.get(key);
      if (found !== undefined) {
        if (seenEntries.has(found.id)) continue;
        seenEntries.add(found.id);
        if (sourcesFresh(found, request.currentShas)) reuse.push(found);
        else rebuild.push(found);
        continue;
      }
      if (seenWork.has(key)) continue;
      seenWork.add(key);
      const cell: FactWork = { entityId: entity.id, entityLabel: entity.label, field };
      if (qualifiers !== undefined) cell.qualifiers = qualifiers;
      work.push(cell);
    }
  }

  return { work, reuse, rebuild, missingEntities };
}

/** True when every recorded source path still hashes to the recorded value. */
function sourcesFresh(entry: FactEntry, currentShas: Record<string, string>): boolean {
  const paths = new Set<string>([...Object.keys(entry.shaByPath), ...entry.sources]);
  if (paths.size === 0) return false;
  for (const path of paths) {
    const current = currentShas[path];
    if (typeof current !== 'string' || current !== entry.shaByPath[path]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Validate and store one fact. Identity fields are re-derived so a caller can
 * never store an id that disagrees with (entity, field, qualifiers). A same-id
 * entry is replaced, keeping the stronger status; the file is trimmed back to
 * MAX_ENTRIES by dropping the least recently used rows.
 */
export function upsertFact(
  file: FactsFile,
  fact: FactEntry,
  options: UpsertFactOptions = {},
): FactsFile {
  const at = toIso(options.now) ?? normalizeIso(fact.updatedAt) ?? normalizeIso(file.builtAt) ?? '';
  const entry = prepareFact(fact, at, options);
  const index = file.entries.findIndex((existing) => existing.id === entry.id);
  if (index >= 0 && options.replace === false) return file;

  let entries: FactEntry[];
  if (index >= 0) {
    const previous = file.entries[index];
    entries = [...file.entries];
    entries[index] = previous === undefined ? entry : mergeFact(previous, entry, at);
  } else {
    entries = [...file.entries, entry];
  }

  return { ...file, entries: evict(entries, entry.id) };
}

function prepareFact(fact: FactEntry, at: string, options: UpsertFactOptions): FactEntry {
  if (!isRecord(fact)) throw new DomainError('facts.invalid-fact', 'fact is not an object');
  const entityId = normalizeIso(fact.entityId);
  if (entityId === undefined) throw new DomainError('facts.invalid-fact', 'fact entityId is empty');
  const field = normalizeIso(fact.field);
  if (field === undefined) throw new DomainError('facts.invalid-fact', 'fact field is empty');
  const value = normalizeIso(fact.value);
  if (value === undefined) throw new DomainError('facts.invalid-fact', 'fact value is empty');
  if (!isFactStatus(fact.status)) {
    throw new DomainError('facts.invalid-fact', 'fact status must be derived, verified or disputed');
  }

  const qualifiers = normalizeQualifiers(fact.qualifiers);
  const evidence = collectEvidence(fact.evidence);
  if (evidence.length === 0) {
    throw new DomainError('facts.invalid-fact', 'fact needs at least one evidence entry');
  }

  const shaByPath: Record<string, string> = {};
  const sources: string[] = [];
  for (const item of evidence) {
    const recorded = fact.shaByPath?.[item.path];
    if (typeof recorded !== 'string' || recorded.trim().length === 0) {
      throw new DomainError('facts.invalid-fact', 'shaByPath does not cover ' + item.path);
    }
    shaByPath[item.path] = recorded;
    if (!sources.includes(item.path)) sources.push(item.path);
  }
  sources.sort(compareText);

  const resolve = options.resolve;
  if (resolve !== undefined) {
    const currentShas = options.currentShas ?? {};
    for (const item of evidence) {
      const report = verifyEvidence(item, resolve, currentShas);
      if (!report.ok) {
        throw new DomainError(
          'facts.unverified-quote',
          'evidence does not verify at ' + item.path + '#' + item.locator + ': ' + report.problems.join(', '),
        );
      }
    }
  }

  const entry: FactEntry = {
    id: factId(entityId, field, qualifiers),
    entityId,
    entityLabel: normalizeIso(fact.entityLabel) ?? entityId,
    field,
    value,
    evidence,
    sources,
    shaByPath,
    extractor: normalizeIso(fact.extractor) ?? 'unknown',
    status: fact.status,
    confidence: clamp01(typeof fact.confidence === 'number' ? fact.confidence : 0),
    updatedAt: at,
    lastUsedAt: normalizeIso(fact.lastUsedAt) ?? at,
    useCount: Number.isFinite(fact.useCount) ? Math.max(0, Math.floor(fact.useCount)) : 0,
  };
  if (qualifiers !== undefined) entry.qualifiers = qualifiers;
  const unit = normalizeIso(fact.unit);
  if (unit !== undefined) entry.unit = unit;
  if (typeof fact.numeric === 'number' && Number.isFinite(fact.numeric)) entry.numeric = fact.numeric;
  return entry;
}

function collectEvidence(input: readonly Evidence[] | undefined): Evidence[] {
  if (input === undefined || input === null) return [];
  const collected: Evidence[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!isRecord(item)) throw new DomainError('facts.invalid-fact', 'evidence entry is not an object');
    const path = normalizeIso(item.path);
    if (path === undefined) throw new DomainError('facts.invalid-fact', 'evidence path is empty');
    const quote = normalizeIso(item.quote);
    if (quote === undefined) throw new DomainError('facts.invalid-fact', 'evidence quote is empty');
    const unit: EvidenceUnit = isEvidenceUnit(item.unit) ? item.unit : 'page';
    const locator = typeof item.locator === 'string' ? item.locator.trim() : '';
    const sha = typeof item.sha === 'string' ? item.sha : '';
    const key = [path, unit, locator, sha, quote].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push({ path, unit, locator, quote, sha });
    if (collected.length >= MAX_EVIDENCE_PER_FACT) break;
  }
  return collected;
}

/** Keep the stronger status; an incoming derived fact never demotes a verified one. */
function mergeFact(previous: FactEntry, incoming: FactEntry, at: string): FactEntry {
  const keepPrevious = STATUS_TRUST[previous.status] > STATUS_TRUST[incoming.status];
  const merged: FactEntry = {
    ...incoming,
    status: keepPrevious ? previous.status : incoming.status,
    confidence: keepPrevious
      ? clamp01(Math.max(previous.confidence, incoming.confidence))
      : incoming.confidence,
    updatedAt: at,
    lastUsedAt: laterIso(previous.lastUsedAt, incoming.lastUsedAt),
    useCount: Math.max(previous.useCount, incoming.useCount),
  };
  return merged;
}

/** Drop the least recently used rows until the file fits; never drops the new row. */
function evict(entries: FactEntry[], protectedId: string): FactEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;
  const excess = entries.length - MAX_ENTRIES;
  const candidates = entries
    .filter((entry) => entry.id !== protectedId)
    .sort((left, right) => compareText(left.lastUsedAt, right.lastUsedAt) || compareText(left.id, right.id));
  const dropped = new Set(candidates.slice(0, excess).map((entry) => entry.id));
  const kept = entries.filter((entry) => !dropped.has(entry.id));
  if (kept.length <= MAX_ENTRIES) return kept;
  return kept.slice(kept.length - MAX_ENTRIES);
}

/**
 * Freshness sweep: a fact whose sources all moved is returned as a rebuild
 * candidate and dropped from the file; a fact that lost only some sources keeps
 * the surviving evidence and is downgraded to derived.
 */
export function invalidateFacts(
  file: FactsFile,
  currentShas: Record<string, string>,
  options: InvalidateOptions = {},
): { file: FactsFile; stale: FactEntry[]; dropped: number } {
  const at = toIso(options.now);
  const entries: FactEntry[] = [];
  const stale: FactEntry[] = [];

  for (const entry of file.entries) {
    const kept: Evidence[] = [];
    for (const item of entry.evidence) {
      const expected = entry.shaByPath?.[item.path] ?? item.sha;
      const current = currentShas[item.path];
      if (typeof current === 'string' && current === expected) kept.push(item);
    }
    if (kept.length === 0) {
      stale.push(entry);
      continue;
    }
    if (kept.length === entry.evidence.length) {
      entries.push(entry);
      continue;
    }
    entries.push(trimEntry(entry, kept, at));
  }

  return { file: { ...file, entries }, stale, dropped: stale.length };
}

function trimEntry(entry: FactEntry, kept: readonly Evidence[], at: string | undefined): FactEntry {
  const shaByPath: Record<string, string> = {};
  const sources: string[] = [];
  for (const item of kept) {
    const recorded = entry.shaByPath?.[item.path] ?? item.sha;
    if (typeof recorded === 'string' && recorded.length > 0) shaByPath[item.path] = recorded;
    if (!sources.includes(item.path)) sources.push(item.path);
  }
  sources.sort(compareText);

  const total = entry.evidence.length;
  const ratio = total === 0 ? 0 : kept.length / total;
  const trimmed: FactEntry = {
    ...entry,
    evidence: [...kept],
    sources,
    shaByPath,
    confidence: clamp01(Math.round(entry.confidence * ratio * 1000) / 1000),
  };
  // A dispute is a judgement about the value, not about provenance; losing a
  // source must not silently resolve it.
  if (entry.status !== 'disputed') trimmed.status = 'derived';
  if (at !== undefined) trimmed.updatedAt = at;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Verified facts first, then confidence, then entity/field. Disputed facts are
 * hidden unless the caller asks for them.
 */
export function selectFacts(file: FactsFile, options: SelectFactsOptions = {}): FactEntry[] {
  const entityIds = options.entityIds === undefined ? undefined : new Set(options.entityIds);
  const fields =
    options.fields === undefined
      ? undefined
      : new Set(options.fields.map((field) => field.trim()).filter((field) => field.length > 0));
  const includeDisputed = options.includeDisputed === true;

  const selected = file.entries.filter((entry) => {
    if (!includeDisputed && entry.status === 'disputed') return false;
    if (entityIds !== undefined && !entityIds.has(entry.entityId)) return false;
    if (fields !== undefined && !fields.has(entry.field)) return false;
    return true;
  });
  selected.sort(compareEntries);

  const max = options.max;
  if (max !== undefined && Number.isFinite(max) && max >= 0) {
    return selected.slice(0, Math.floor(max));
  }
  return selected;
}

function compareEntries(left: FactEntry, right: FactEntry): number {
  const rank = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  if (rank !== 0) return rank;
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  const entity = compareText(left.entityId, right.entityId);
  if (entity !== 0) return entity;
  const field = compareText(left.field, right.field);
  if (field !== 0) return field;
  const qualifiers = compareText(
    qualifierPairs(left.qualifiers).join('|'),
    qualifierPairs(right.qualifiers).join('|'),
  );
  if (qualifiers !== 0) return qualifiers;
  return compareText(left.id, right.id);
}

/** Record one use of each fact: increments useCount and moves lastUsedAt. */
export function touchFacts(file: FactsFile, ids: readonly string[], at: string): FactsFile {
  if (ids.length === 0) return file;
  const wanted = new Set(ids);
  return {
    ...file,
    entries: file.entries.map((entry) =>
      wanted.has(entry.id)
        ? {
            ...entry,
            lastUsedAt: at,
            useCount: (Number.isFinite(entry.useCount) ? entry.useCount : 0) + 1,
          }
        : entry,
    ),
  };
}

/** Group facts by field for a comparison view; conflicting verified values are reported, never resolved. */
export function compareFacts(entries: readonly FactEntry[]): FactComparison {
  const byField = new Map<string, FactEntry[]>();
  for (const entry of entries) {
    const bucket = byField.get(entry.field);
    if (bucket === undefined) byField.set(entry.field, [entry]);
    else bucket.push(entry);
  }

  const groups: FactCompareGroup[] = [...byField.keys()].sort(compareText).map((field) => {
    const bucket = [...(byField.get(field) ?? [])].sort(compareEntries);
    return { field, rows: bucket.map(toCompareRow) };
  });

  return { groups, conflicts: findConflicts(entries) };
}

function toCompareRow(entry: FactEntry): FactCompareRow {
  const row: FactCompareRow = {
    entityId: entry.entityId,
    entityLabel: entry.entityLabel,
    value: entry.value,
    status: entry.status,
    evidence: entry.evidence.length,
  };
  if (entry.unit !== undefined) row.unit = entry.unit;
  const first = entry.evidence[0];
  if (first !== undefined) row.source = first.path + '#' + first.locator;
  return row;
}

function findConflicts(entries: readonly FactEntry[]): FactConflict[] {
  const buckets = new Map<string, FactEntry[]>();
  for (const entry of entries) {
    if (entry.status !== 'verified') continue;
    // Two entities differing is the point of the table; only one cell disagreeing with itself is a conflict.
    const key = [entry.entityId, entry.field, ...qualifierPairs(entry.qualifiers)].join('\u0000');
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]);
    else bucket.push(entry);
  }

  const conflicts: FactConflict[] = [];
  for (const key of [...buckets.keys()].sort(compareText)) {
    const bucket = [...(buckets.get(key) ?? [])].sort(compareEntries);
    const values = new Set<string>();
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i];
        const right = bucket[j];
        if (left === undefined || right === undefined) continue;
        if (!unitsCompatible(left.unit, right.unit)) continue;
        const leftNumber = numericOf(left);
        const rightNumber = numericOf(right);
        if (leftNumber === undefined || rightNumber === undefined) continue;
        if (Math.abs(leftNumber - rightNumber) <= NUMBER_TOLERANCE) continue;
        values.add(left.value);
        values.add(right.value);
      }
    }
    const first = bucket[0];
    if (first === undefined || values.size === 0) continue;
    conflicts.push({ field: first.field, values: [...values].sort(compareText) });
  }
  return conflicts;
}

function unitsCompatible(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return true;
  return left === right;
}

function numericOf(entry: FactEntry): number | undefined {
  if (typeof entry.numeric === 'number' && Number.isFinite(entry.numeric)) return entry.numeric;
  const match = NUMBER_PATTERN.exec(entry.value);
  if (match === null) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Markdown, one table per field, with the first evidence of each row as its source. */
export function renderFactTable(groups: readonly FactCompareGroup[]): string {
  if (groups.length === 0) return '';
  const blocks: string[] = [];
  for (const group of groups) {
    const lines = ['### ' + group.field, '', '| 实体 | 值 | 状态 | 出处 |', '| --- | --- | --- | --- |'];
    for (const row of group.rows) {
      const value = row.unit === undefined ? row.value : row.value + ' ' + row.unit;
      lines.push(
        '| ' +
          tableCell(row.entityLabel) +
          ' | ' +
          tableCell(value) +
          ' | ' +
          row.status +
          ' | ' +
          tableCell(row.source ?? '-') +
          ' |',
      );
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function tableCell(value: string): string {
  return value.replace(/\r?\n/gu, ' ').replace(/\|/gu, '\\|').trim();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Empty file for a first build; builtAt is supplied so tests stay deterministic. */
export function createFactsFile(options: { builtAt?: string | Date } = {}): FactsFile {
  const raw = options.builtAt;
  const builtAt = raw instanceof Date ? (toIso(raw) ?? '') : (normalizeIso(raw) ?? '');
  return { schema: FACTS_SCHEMA, version: FACTS_VERSION, builtAt, entries: [] };
}

/**
 * Tolerant reader: unknown fields are ignored and unusable entries are skipped,
 * but the envelope must be this schema. A corrupt file is not silently usable.
 */
export function parseFacts(text: string): FactsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new DomainError('facts.invalid-shape', 'facts file is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new DomainError('facts.invalid-shape', 'facts file must be a JSON object');
  }
  const schema = parsed['schema'];
  if (schema !== FACTS_SCHEMA) {
    throw new DomainError(
      'facts.invalid-shape',
      'facts schema is ' + String(schema) + ', expected ' + FACTS_SCHEMA,
    );
  }

  const version = parsed['version'];
  const builtAt = parsed['builtAt'];
  const rawEntries = parsed['entries'];
  const entries: FactEntry[] = [];
  if (Array.isArray(rawEntries)) {
    for (const item of rawEntries) {
      const entry = readEntry(item);
      if (entry !== undefined) entries.push(entry);
    }
  }

  return {
    schema: FACTS_SCHEMA,
    version: typeof version === 'number' && Number.isFinite(version) ? version : FACTS_VERSION,
    builtAt: typeof builtAt === 'string' ? builtAt : '',
    entries,
  };
}

function readEntry(value: unknown): FactEntry | undefined {
  if (!isRecord(value)) return undefined;
  const entityId = normalizeIso(value['entityId']);
  const field = normalizeIso(value['field']);
  const rawValue = value['value'];
  if (entityId === undefined || field === undefined || typeof rawValue !== 'string') return undefined;
  const value_ = rawValue.trim();
  if (value_.length === 0) return undefined;

  const qualifiers = readQualifiers(value['qualifiers']);
  const evidence = readEvidence(value['evidence']);
  const sources = readTextList(value['sources']);
  const shaByPath = readShaMap(value['shaByPath']);
  const status = isFactStatus(value['status']) ? value['status'] : 'derived';
  const id = normalizeIso(value['id']) ?? factId(entityId, field, qualifiers);

  const entry: FactEntry = {
    id,
    entityId,
    entityLabel: normalizeIso(value['entityLabel']) ?? entityId,
    field,
    value: value_,
    evidence,
    sources: sources.length > 0 ? sources : [...new Set(evidence.map((item) => item.path))].sort(compareText),
    shaByPath,
    extractor: normalizeIso(value['extractor']) ?? 'unknown',
    status,
    confidence: clamp01(typeof value['confidence'] === 'number' ? value['confidence'] : 0.5),
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : '',
    lastUsedAt: typeof value['lastUsedAt'] === 'string' ? value['lastUsedAt'] : '',
    useCount:
      typeof value['useCount'] === 'number' && Number.isFinite(value['useCount'])
        ? Math.max(0, Math.floor(value['useCount']))
        : 0,
  };
  if (qualifiers !== undefined) entry.qualifiers = qualifiers;
  const unit = normalizeIso(value['unit']);
  if (unit !== undefined) entry.unit = unit;
  const numeric = value['numeric'];
  if (typeof numeric === 'number' && Number.isFinite(numeric)) entry.numeric = numeric;
  return entry;
}

function readQualifiers(value: unknown): FactQualifier | undefined {
  if (!isRecord(value)) return undefined;
  const collected: FactQualifier = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    collected[key] = raw;
  }
  return normalizeQualifiers(collected);
}

function readEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return [];
  const evidence: Evidence[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = normalizeIso(item['path']);
    const quote = normalizeIso(item['quote']);
    if (path === undefined || quote === undefined) continue;
    const unit: EvidenceUnit = isEvidenceUnit(item['unit']) ? item['unit'] : 'page';
    evidence.push({
      path,
      unit,
      locator: typeof item['locator'] === 'string' ? item['locator'].trim() : '',
      quote,
      sha: typeof item['sha'] === 'string' ? item['sha'] : '',
    });
    if (evidence.length >= MAX_EVIDENCE_PER_FACT) break;
  }
  return evidence;
}

function readTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = normalizeIso(item);
    if (text !== undefined && !out.includes(text)) out.push(text);
  }
  out.sort(compareText);
  return out;
}

function readShaMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const sha = raw.trim();
    if (sha.length === 0) continue;
    out[key] = sha;
  }
  return out;
}

/** Deterministic JSON: sorted entries, fixed key order, trailing newline. */
export function serializeFacts(file: FactsFile): string {
  const entries = [...file.entries].sort(
    (left, right) => compareText(left.id, right.id) || compareText(left.entityId, right.entityId),
  );
  const document = {
    schema: FACTS_SCHEMA,
    version: Number.isFinite(file.version) ? file.version : FACTS_VERSION,
    builtAt: file.builtAt,
    entries: entries.map(entryToJson),
  };
  return JSON.stringify(document, null, 2) + '\n';
}

function entryToJson(entry: FactEntry): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: entry.id,
    entityId: entry.entityId,
    entityLabel: entry.entityLabel,
    field: entry.field,
  };
  const qualifiers = normalizeQualifiers(entry.qualifiers);
  if (qualifiers !== undefined) json['qualifiers'] = qualifiers;
  json['value'] = entry.value;
  if (entry.unit !== undefined) json['unit'] = entry.unit;
  if (typeof entry.numeric === 'number' && Number.isFinite(entry.numeric)) json['numeric'] = entry.numeric;
  json['evidence'] = entry.evidence.map((item) => ({
    path: item.path,
    unit: item.unit,
    locator: item.locator,
    quote: item.quote,
    sha: item.sha,
  }));
  json['sources'] = [...entry.sources].sort(compareText);
  json['shaByPath'] = sortRecord(entry.shaByPath);
  json['extractor'] = entry.extractor;
  json['status'] = entry.status;
  json['confidence'] = entry.confidence;
  json['updatedAt'] = entry.updatedAt;
  json['lastUsedAt'] = entry.lastUsedAt;
  json['useCount'] = entry.useCount;
  return json;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort(compareText)) {
    const value = record[key];
    if (typeof value === 'string') sorted[key] = value;
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toIso(at: Date | undefined): string | undefined {
  if (at === undefined) return undefined;
  const time = at.getTime();
  return Number.isFinite(time) ? at.toISOString() : undefined;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function laterIso(left: string, right: string): string {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime > leftTime ? right : left;
  if (Number.isFinite(rightTime)) return right;
  return left;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFactStatus(value: unknown): value is FactStatus {
  return value === 'derived' || value === 'verified' || value === 'disputed';
}

function isEvidenceUnit(value: unknown): value is EvidenceUnit {
  return typeof value === 'string' && (EVIDENCE_UNITS as readonly string[]).includes(value);
}
