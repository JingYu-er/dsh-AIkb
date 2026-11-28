import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { NodeVaultWriter } from '../adapters/fs/node-vault-writer.js';
import {
  FACTS_PATH,
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
  upsertFact,
} from '../application/vault-facts.js';
import type { FactEntry, FactsFile } from '../application/vault-facts.js';
import { findEntities } from '../application/vault-map.js';
import type { Evidence, EvidenceResolver, EvidenceUnit } from '../application/vault-memory.js';
import { DomainError } from '../shared/result.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';
import { MAP_MISSING_HINT, MAP_MISSING_MESSAGE, loadMap } from './kb-map.tool.js';

/** The catalog is the hash list: it says which chunk file belongs to which path. */
const CATALOG_PATH = '.wiki/index/catalog.json';
const LINE_FEED = String.fromCharCode(10);
const DEFAULT_EXTRACTOR = 'kb_facts';
const DEFAULT_CONFIDENCE = 0.6;
const DEFAULT_TABLE_MAX = 200;
const MAX_TABLE_MAX = 2000;
const EMPTY_TABLE_MESSAGE = '库里还没有可比较的事实，先 plan -> write';
const READ_ONLY_MESSAGE =
  'allowWrites is false: enable it on the KB settings page (Configuration tab) before writing facts（写入已关闭，先在设置页打开）';
const NEXT_STEP = '对每个 work 项先用 kb_query 读到含数值的页/节，然后把带 quote 的事实写回 kb_facts write';

export type KbFactsAction = 'plan' | 'write' | 'table';

export interface KbFactsEvidenceInput {
  readonly path: string;
  readonly unit?: EvidenceUnit;
  readonly locator: string;
  readonly quote: string;
}

export interface KbFactsFactInput {
  readonly entity: string;
  readonly field: string;
  readonly value: string;
  readonly unit?: string;
  readonly qualifiers?: Record<string, string>;
  readonly evidence: readonly KbFactsEvidenceInput[];
}

export interface KbFactsArgs {
  readonly action: KbFactsAction;
  readonly entities?: readonly string[];
  readonly fields?: readonly string[];
  readonly qualifiers?: Record<string, string>;
  readonly facts?: readonly KbFactsFactInput[];
  readonly extractor?: string;
  readonly max?: number;
  readonly vaultPath?: string;
}

export interface KbFactsDeps {
  readonly resolveRoot: (explicit?: string) => string;
  /** Writes are enabled only when this returns true; a bare boolean is accepted too. Absent means read-only. */
  readonly allowWrites?: (() => boolean) | boolean;
  /** Clock for timestamps; tests pin it. */
  readonly now?: () => Date;
}

export interface FactWorkRow {
  readonly entityId: string;
  readonly entityLabel: string;
  readonly field: string;
  readonly qualifiers?: Record<string, string>;
  readonly hint: string;
}

export interface FactWriteRow {
  readonly entity: string;
  readonly field: string;
  readonly value: string;
  readonly status: 'written' | 'rejected';
  readonly entityId?: string;
  readonly label?: string;
  readonly entryId?: string;
  readonly code?: string;
  readonly reason?: string;
}

export interface FactConflictRow {
  readonly field: string;
  readonly values: readonly string[];
}

export interface KbFactsReport {
  readonly ok: boolean;
  readonly action: string;
  readonly vaultRoot: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly hint?: string;
  readonly summary?: string;
  readonly work?: readonly FactWorkRow[];
  readonly reuseCount?: number;
  readonly rebuildCount?: number;
  readonly missingEntities?: readonly string[];
  readonly next?: string;
  readonly results?: readonly FactWriteRow[];
  readonly written?: number;
  readonly rejected?: number;
  readonly file?: string;
  readonly table?: string;
  readonly conflicts?: readonly FactConflictRow[];
  readonly entryCount?: number;
  readonly verifiedCount?: number;
  readonly staleDropped?: number;
  readonly notes?: readonly string[];
}

interface KbFactsFs {
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
}

interface StoredChunk {
  readonly id: string;
  readonly page: number;
  readonly text: string;
  readonly section?: string;
}

interface Rejection {
  readonly code: string;
  readonly reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNames(raw: readonly string[] | undefined): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'kb.facts.bad-request';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string): string {
  return value.replace(/\r?\n/gu, ' ').trim();
}

function writesEnabled(deps: KbFactsDeps): boolean {
  const gate = deps.allowWrites;
  if (typeof gate === 'function') return gate() === true;
  return gate === true;
}

function writeRefusal(root: string, action: string): KbFactsReport {
  return {
    ok: false,
    action,
    vaultRoot: root,
    error: { code: 'kb.facts.read-only', message: READ_ONLY_MESSAGE },
    hint: '写入是索引维护之外的用户数据：需要 KB 设置页 Configuration 里的 allowWrites',
  };
}

function badRequest(root: string, action: string, message: string): KbFactsReport {
  return { ok: false, action, vaultRoot: root, error: { code: 'kb.facts.bad-request', message } };
}

function missingMapReport(
  root: string,
  action: string,
  load: { readonly reason: 'missing' | 'corrupt'; readonly detail: string },
): KbFactsReport {
  return {
    ok: false,
    action,
    vaultRoot: root,
    error: { code: 'kb.map.missing', message: MAP_MISSING_MESSAGE },
    hint: load.reason === 'missing' ? MAP_MISSING_HINT : 'map.json 无法解析，先重建：kb_map {action:"build"}（' + load.detail + '）',
  };
}

/** Tolerate a missing or partially written catalog: no hashes means no verifiable evidence. */
async function readCatalogShas(fs: KbFactsFs): Promise<Record<string, string>> {
  const shas: Record<string, string> = {};
  if (!(await fs.exists(CATALOG_PATH))) return shas;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readText(CATALOG_PATH));
  } catch {
    return shas;
  }
  if (!isRecord(parsed) || !isRecord(parsed.sources)) return shas;
  for (const [sha, raw] of Object.entries(parsed.sources)) {
    if (!isRecord(raw)) continue;
    const path = typeof raw.path === 'string' ? normalizePath(raw.path) : '';
    if (path === '' || sha === '') continue;
    shas[path] = sha;
  }
  return shas;
}

async function readChunks(fs: KbFactsFs, sha: string): Promise<StoredChunk[]> {
  const relPath = '.wiki/index/chunks/' + sha + '.jsonl';
  const out: StoredChunk[] = [];
  try {
    if (!(await fs.exists(relPath))) return out;
    const text = await fs.readText(relPath);
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      const page = parsed.page;
      const body = parsed.text;
      if (typeof page !== 'number' || !Number.isFinite(page) || page < 1) continue;
      if (typeof body !== 'string' || body.trim() === '') continue;
      const id = typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : sha + ':' + Math.trunc(page);
      const section = typeof parsed.section === 'string' ? parsed.section : undefined;
      out.push(section === undefined ? { id, page: Math.trunc(page), text: body } : { id, page: Math.trunc(page), text: body, section });
    }
  } catch {
    return out;
  }
  return out;
}

/** Preloaded chunk text so the resolver can stay synchronous, as verifyEvidence expects. */
class ChunkSources {
  private readonly cache = new Map<string, StoredChunk[]>();

  constructor(private readonly fs: KbFactsFs, private readonly shas: Record<string, string>) {}

  async preload(paths: readonly string[]): Promise<void> {
    const unique = [...new Set(paths)];
    await Promise.all(unique.map(async (path) => this.ensure(path)));
  }

  private async ensure(path: string): Promise<StoredChunk[]> {
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;
    const sha = this.shas[path];
    const chunks = sha === undefined ? [] : await readChunks(this.fs, sha);
    this.cache.set(path, chunks);
    return chunks;
  }

  resolver(): EvidenceResolver {
    return (path: string, unit: EvidenceUnit, locator: string): string | undefined => {
      if (this.shas[path] === undefined) return undefined;
      const chunks = this.cache.get(path);
      if (chunks === undefined || chunks.length === 0) return undefined;
      return locateChunkText(chunks, unit, locator);
    };
  }
}

function pageNumberOf(locator: string): number | undefined {
  const match = /^(?:p|page)?\s*(\d+)$/iu.exec(locator);
  if (match === null) return undefined;
  const page = Number(match[1]);
  return Number.isFinite(page) ? page : undefined;
}

function locateChunkText(chunks: readonly StoredChunk[], unit: EvidenceUnit, locator: string): string | undefined {
  const wanted = locator.trim();
  if (wanted === '') return undefined;
  if (unit === 'page') {
    const page = pageNumberOf(wanted);
    if (page === undefined) return undefined;
    const texts = chunks.filter((chunk) => chunk.page === page).map((chunk) => chunk.text);
    return texts.length === 0 ? undefined : texts.join(LINE_FEED);
  }
  if (unit === 'section') {
    const texts = chunks
      .filter((chunk) => (chunk.section ?? '').trim() === wanted)
      .map((chunk) => chunk.text);
    return texts.length === 0 ? undefined : texts.join(LINE_FEED);
  }
  const byId = chunks.find((chunk) => chunk.id === wanted);
  return byId === undefined ? undefined : byId.text;
}

async function readFactsFile(fs: KbFactsFs, now: Date): Promise<FactsFile> {
  if (!(await fs.exists(FACTS_PATH))) return createFactsFile({ builtAt: now });
  try {
    return parseFacts(await fs.readText(FACTS_PATH));
  } catch (error) {
    throw new DomainError('kb.facts.bad-request', 'facts.json 无法解析：' + oneLine(messageOf(error)) + '（可先删除它再 plan）');
  }
}

function evidenceUnit(raw: unknown): EvidenceUnit | undefined {
  return raw === 'page' || raw === 'section' || raw === 'chunk' ? raw : undefined;
}

async function runPlan(root: string, fs: KbFactsFs, args: KbFactsArgs, now: Date): Promise<KbFactsReport> {
  const names = normalizeNames(args.entities);
  const fields = normalizeNames(args.fields);
  if (names.length === 0) {
    return badRequest(root, 'plan', 'plan 需要 entities：至少 1 个实体名（先用 kb_map 的 entities 查）');
  }
  if (fields.length === 0) {
    return badRequest(root, 'plan', 'plan 需要 fields：至少 1 个字段名（例如 mass、output_voltage）');
  }
  const loaded = await loadMap(fs);
  if (!loaded.ok) return missingMapReport(root, 'plan', loaded);
  const file = await readFactsFile(fs, now);
  const currentShas = await readCatalogShas(fs);
  const plan = planFactWork(loaded.map, file, {
    entities: names,
    fields,
    qualifiers: args.qualifiers,
    currentShas,
  });
  const work: FactWorkRow[] = plan.work.map((item) => ({
    entityId: item.entityId,
    entityLabel: item.entityLabel,
    field: item.field,
    ...(item.qualifiers === undefined ? {} : { qualifiers: item.qualifiers }),
    hint: '用 kb_query 读含 ' + item.field + ' 数值的页/节，把原文 quote 写回 kb_facts write（实体 ' + item.entityLabel + '，id ' + item.entityId + '）',
  }));
  return {
    ok: true,
    action: 'plan',
    vaultRoot: root,
    summary:
      '计划：待抽取 ' + work.length + ' 项 · 可复用 ' + plan.reuse.length + ' 条 · 需重建 ' + plan.rebuild.length + ' 条 · 未知实体 ' + plan.missingEntities.length + ' 个',
    work,
    reuseCount: plan.reuse.length,
    rebuildCount: plan.rebuild.length,
    missingEntities: plan.missingEntities,
    next: NEXT_STEP,
    notes: plan.missingEntities.length === 0 ? [] : ['未知实体：' + plan.missingEntities.join('、')],
  };
}

async function runWrite(
  root: string,
  fs: KbFactsFs,
  args: KbFactsArgs,
  deps: KbFactsDeps,
  now: Date,
): Promise<KbFactsReport> {
  if (!writesEnabled(deps)) return writeRefusal(root, 'write');
  const inputs = args.facts;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return badRequest(root, 'write', 'write 需要 facts：至少 1 条 {entity, field, value, evidence:[{path, unit, locator, quote}]}');
  }
  const loaded = await loadMap(fs);
  if (!loaded.ok) return missingMapReport(root, 'write', loaded);
  const shas = await readCatalogShas(fs);
  let file = await readFactsFile(fs, now);
  const chunks = new ChunkSources(fs, shas);
  const paths: string[] = [];
  for (const raw of inputs) {
    if (!isRecord(raw) || !Array.isArray(raw.evidence)) continue;
    for (const item of raw.evidence) {
      if (isRecord(item) && typeof item.path === 'string') paths.push(normalizePath(item.path));
    }
  }
  await chunks.preload(paths);
  const resolve = chunks.resolver();
  const extractor = (args.extractor ?? '').trim() === '' ? DEFAULT_EXTRACTOR : (args.extractor ?? '').trim();
  const results: FactWriteRow[] = [];

  for (const raw of inputs) {
    const record = isRecord(raw) ? raw : {};
    const entityName = textOf(record.entity);
    const field = textOf(record.field);
    const value = textOf(record.value);
    const base: FactWriteRow = { entity: entityName, field, value, status: 'rejected' };
    if (entityName === '' || field === '' || value === '') {
      results.push({ ...base, code: 'kb.facts.bad-request', reason: 'entity / field / value 都不能为空' });
      continue;
    }
    const entity = findEntities(loaded.map, entityName)[0];
    if (entity === undefined) {
      results.push({ ...base, code: 'kb.facts.no-entity', reason: '实体不在库地图里：' + entityName + '（先 kb_map 的 entities 查，必要时 build）' });
      continue;
    }
    const qualifiers = normalizeQualifiers(
      isRecord(record.qualifiers) ? (record.qualifiers as Record<string, string>) : undefined,
    );
    const entryId = factId(entity.id, field, qualifiers);
    const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];
    if (rawEvidence.length === 0) {
      results.push({ ...base, entityId: entity.id, label: entity.label, code: 'kb.facts.no-evidence', reason: '没有 evidence：至少 1 条 {path, unit, locator, quote}' });
      continue;
    }
    const evidence: Evidence[] = [];
    const shaByPath: Record<string, string> = {};
    let rejected: Rejection | undefined;
    for (const [index, item] of rawEvidence.entries()) {
      if (!isRecord(item)) {
        rejected = { code: 'kb.facts.bad-request', reason: 'evidence[' + index + '] 不是对象' };
        break;
      }
      const path = typeof item.path === 'string' ? normalizePath(item.path) : '';
      // Callers naturally pass a page number; accept both spellings.
      const locator = typeof item.locator === 'number' ? String(item.locator) : textOf(item.locator);
      const quote = textOf(item.quote);
      // An absent unit means page: the page is the default evidence granularity.
      const unit = item.unit === undefined ? 'page' : evidenceUnit(item.unit);
      if (path === '' || locator === '' || quote === '') {
        rejected = { code: 'kb.facts.no-evidence', reason: 'evidence[' + index + '] 缺 path / locator / quote' };
        break;
      }
      if (shas[path] === undefined) {
        rejected = { code: 'kb.facts.no-evidence', reason: '索引里没有这篇文档：' + path + '（先 kb_ingest）' };
        break;
      }
      if (unit === undefined) {
        rejected = { code: 'kb.facts.bad-request', reason: 'evidence[' + index + '].unit 只能是 page / section / chunk' };
        break;
      }
      const sha = shas[path];
      if (sha === undefined) {
        rejected = { code: 'kb.facts.no-evidence', reason: '索引里没有这篇文档：' + path };
        break;
      }
      shaByPath[path] = sha;
      evidence.push({ path, unit, locator, quote, sha });
    }
    if (rejected !== undefined) {
      results.push({ ...base, entityId: entity.id, label: entity.label, code: rejected.code, reason: rejected.reason });
      continue;
    }
    const at = now.toISOString();
    const fact: FactEntry = {
      id: entryId,
      entityId: entity.id,
      entityLabel: entity.label,
      field,
      ...(qualifiers === undefined ? {} : { qualifiers }),
      value,
      ...(textOf(record.unit) === '' ? {} : { unit: textOf(record.unit) }),
      evidence,
      sources: [],
      shaByPath,
      extractor,
      status: 'verified',
      confidence: DEFAULT_CONFIDENCE,
      updatedAt: at,
      lastUsedAt: at,
      useCount: 0,
    };
    try {
      file = upsertFact(file, fact, { now, resolve, currentShas: shas });
      results.push({ ...base, status: 'written', entityId: entity.id, label: entity.label, entryId: factId(entity.id, field, qualifiers) });
    } catch (error) {
      const code = codeOf(error);
      const mapped = code === 'facts.unverified-quote' ? 'kb.facts.no-evidence' : 'kb.facts.bad-request';
      results.push({ ...base, entityId: entity.id, label: entity.label, code: mapped, reason: oneLine(messageOf(error)) });
    }
  }

  const written = results.filter((row) => row.status === 'written').length;
  const rejectedCount = results.length - written;
  if (written > 0) await new NodeVaultWriter(root).writeText(FACTS_PATH, serializeFacts(file));
  const firstFailure = results.find((row) => row.status === 'rejected');
  return {
    ok: written > 0,
    action: 'write',
    vaultRoot: root,
    ...(written === 0
      ? {
          error: {
            code: firstFailure?.code ?? 'kb.facts.no-evidence',
            message: firstFailure?.reason ?? '没有写入任何事实',
          },
          hint: 'quote 必须是该页/节 chunk 原文（空白折叠后）的子串；实体名要能在库地图里找到',
        }
      : {}),
    summary: '写入事实：成功 ' + written + ' 条 · 拒绝 ' + rejectedCount + ' 条（共 ' + results.length + ' 条）',
    results,
    written,
    rejected: rejectedCount,
    file: FACTS_PATH,
  };
}

async function runTable(
  root: string,
  fs: KbFactsFs,
  args: KbFactsArgs,
  deps: KbFactsDeps,
  now: Date,
): Promise<KbFactsReport> {
  const notes: string[] = [];
  const names = normalizeNames(args.entities);
  const fields = normalizeNames(args.fields);
  let entityIds: string[] | undefined;
  if (names.length > 0) {
    const loaded = await loadMap(fs);
    if (!loaded.ok) return missingMapReport(root, 'table', loaded);
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      const entity = findEntities(loaded.map, name)[0];
      if (entity === undefined) {
        if (!unknown.includes(name)) unknown.push(name);
      } else if (!ids.includes(entity.id)) {
        ids.push(entity.id);
      }
    }
    if (ids.length === 0) {
      return {
        ok: false,
        action: 'table',
        vaultRoot: root,
        error: { code: 'kb.facts.no-entity', message: '实体不在库地图里：' + unknown.join('、') },
        hint: '先用 kb_map 的 entities 查实体名，必要时 kb_map 的 build',
      };
    }
    entityIds = ids;
    if (unknown.length > 0) notes.push('未在库地图里找到：' + unknown.join('、'));
  }
  if (!(await fs.exists(FACTS_PATH))) {
    return {
      ok: false,
      action: 'table',
      vaultRoot: root,
      error: { code: 'kb.facts.bad-request', message: EMPTY_TABLE_MESSAGE },
      hint: '事实表为空：先用 kb_facts plan 列出待抽取单元，再用 write 写入带 quote 的事实',
      staleDropped: 0,
      entryCount: 0,
      verifiedCount: 0,
      conflicts: [],
      ...(notes.length === 0 ? {} : { notes }),
    };
  }
  const file = await readFactsFile(fs, now);
  const currentShas = await readCatalogShas(fs);
  const sweep = invalidateFacts(file, currentShas, { now });
  let changed = sweep.dropped > 0;
  if (!changed) {
    const before = new Map(file.entries.map((entry) => [entry.id, entry.evidence.length]));
    changed = sweep.file.entries.some((entry) => before.get(entry.id) !== entry.evidence.length);
  }
  if (changed) {
    if (writesEnabled(deps)) {
      await new NodeVaultWriter(root).writeText(FACTS_PATH, serializeFacts(sweep.file));
      notes.push('已清理 ' + sweep.dropped + ' 条失效事实并写回 ' + FACTS_PATH);
    } else {
      notes.push('有 ' + sweep.dropped + ' 条失效事实（只读，未写回）');
    }
  }
  const max =
    typeof args.max === 'number' && Number.isFinite(args.max) && args.max > 0
      ? Math.min(MAX_TABLE_MAX, Math.floor(args.max))
      : DEFAULT_TABLE_MAX;
  const entries = selectFacts(sweep.file, {
    ...(entityIds === undefined ? {} : { entityIds }),
    ...(fields.length === 0 ? {} : { fields }),
    max,
  });
  const comparison = compareFacts(entries);
  const table = renderFactTable(comparison.groups);
  const verifiedCount = entries.filter((entry) => entry.status === 'verified').length;
  if (entries.length === 0) {
    return {
      ok: false,
      action: 'table',
      vaultRoot: root,
      error: { code: 'kb.facts.bad-request', message: EMPTY_TABLE_MESSAGE },
      hint: '库里没有符合条件的事实：先 kb_facts plan，再 write',
      staleDropped: sweep.dropped,
      entryCount: 0,
      verifiedCount: 0,
      conflicts: [],
      ...(notes.length === 0 ? {} : { notes }),
    };
  }
  return {
    ok: true,
    action: 'table',
    vaultRoot: root,
    summary:
      '事实 ' + entries.length + ' 条（verified ' + verifiedCount + ' 条）· 冲突 ' + comparison.conflicts.length + ' 组 · 失效清理 ' + sweep.dropped + ' 条',
    table,
    conflicts: comparison.conflicts.map((conflict) => ({ field: conflict.field, values: [...conflict.values] })),
    entryCount: entries.length,
    verifiedCount,
    staleDropped: sweep.dropped,
    file: FACTS_PATH,
    ...(notes.length === 0 ? {} : { notes }),
  };
}

function renderReport(report: KbFactsReport): string {
  const lines: string[] = [];
  if (report.ok !== true && report.error !== undefined) {
    lines.push(report.error.code + ': ' + report.error.message);
    if (report.hint !== undefined) lines.push(report.hint);
  }
  if (report.summary !== undefined) lines.push(report.summary);
  for (const item of report.work ?? []) {
    lines.push('  · ' + item.entityLabel + '（' + item.entityId + '）· ' + item.field + ' — ' + item.hint);
  }
  for (const row of report.results ?? []) {
    const head = row.status === 'written' ? '  ✓ ' : '  ✗ ';
    const body = row.entity + ' · ' + row.field + ' = ' + row.value;
    if (row.status === 'written') {
      lines.push(head + body);
    } else {
      lines.push(head + body + ' — ' + (row.code ?? 'kb.facts.bad-request') + ': ' + (row.reason ?? ''));
    }
  }
  if (report.table !== undefined && report.table !== '') lines.push(report.table);
  for (const conflict of report.conflicts ?? []) {
    lines.push('  冲突 ' + conflict.field + '：' + conflict.values.join(' / '));
  }
  for (const note of report.notes ?? []) lines.push('  ! ' + note);
  if (report.action === 'plan' && report.next !== undefined) lines.push('下一步：' + report.next);
  return lines.length === 0 ? '(no output)' : lines.join(LINE_FEED);
}

export function createKbFactsTool(deps: KbFactsDeps) {
  return defineTool<KbFactsArgs, KbFactsReport>({
    name: 'kb_facts',
    description:
      'The L2 answering path: a verified fact table at .wiki/index/facts.json, keyed by entity and field, where every row carries a source quote. action:"plan" lists (entity, field) cells that still need extraction and separates reusable from stale facts against the current source hashes; action:"write" stores facts whose evidence quote is found verbatim (whitespace-normalised) in the stored chunk text of an indexed path, rejecting unknown entities and unverifiable quotes; action:"table" invalidates stale rows, then renders a per-field markdown comparison table plus cross-entity value conflicts. write needs the writes switch; plan and table only read. Facts are derived from pages, never invented.',
    parameters: {
      action: { type: 'string', required: true, enum: ['plan', 'write', 'table'], description: 'plan | write | table.' },
      entities: { type: 'array', items: { type: 'string' }, description: 'plan: entity names, exact or case-insensitive. table: optional filter, labels or ids accepted.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Field names to plan or to filter the table (e.g. mass, output_voltage).' },
      qualifiers: { type: 'json', description: 'Optional qualifier map applied to every planned/written cell (e.g. {"temp":"25C"}).' },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entity: { type: 'string', required: true },
            field: { type: 'string', required: true },
            value: { type: 'string', required: true },
            unit: { type: 'string' },
            qualifiers: { type: 'json' },
            evidence: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  unit: { type: 'string', enum: ['page', 'section', 'chunk'] },
                  locator: { type: 'string', required: true },
                  quote: { type: 'string', required: true },
                },
              },
            },
          },
        },
        description: 'write: facts to store. evidence.quote must appear in the chunk text at path#locator.',
      },
      extractor: { type: 'string', description: 'write: label recorded on the fact, default kb_facts.' },
      max: { type: 'integer', description: 'table: max rows after ordering, default 200, max 2000.' },
      vaultPath: { type: 'string', description: 'Override the configured vault root.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          vaultRoot: { type: 'string', required: true },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
          hint: { type: 'string' },
          summary: { type: 'string' },
          work: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                entityId: { type: 'string', required: true },
                entityLabel: { type: 'string', required: true },
                field: { type: 'string', required: true },
                qualifiers: { type: 'json' },
                hint: { type: 'string', required: true },
              },
            },
          },
          reuseCount: { type: 'integer' },
          rebuildCount: { type: 'integer' },
          missingEntities: { type: 'array', items: { type: 'string' } },
          next: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                entity: { type: 'string', required: true },
                field: { type: 'string', required: true },
                value: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['written', 'rejected'] },
                entityId: { type: 'string' },
                label: { type: 'string' },
                entryId: { type: 'string' },
                code: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
          written: { type: 'integer' },
          rejected: { type: 'integer' },
          file: { type: 'string' },
          table: { type: 'string' },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                field: { type: 'string', required: true },
                values: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          entryCount: { type: 'integer' },
          verifiedCount: { type: 'integer' },
          staleDropped: { type: 'integer' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        const fs = new NodeVaultFs(root);
        const now = deps.now?.() ?? new Date();
        if (args.action === 'plan') return await runPlan(root, fs, args, now);
        if (args.action === 'write') return await runWrite(root, fs, args, deps, now);
        if (args.action === 'table') return await runTable(root, fs, args, deps, now);
        return badRequest(root, String(args.action), 'action 只能是 plan / write / table');
      } catch (error) {
        return {
          ok: false,
          action: String(args.action),
          vaultRoot: root,
          error: { code: codeOf(error), message: oneLine(messageOf(error)) },
        };
      }
    },
  });
}
