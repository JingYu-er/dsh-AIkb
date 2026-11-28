import { createHash } from 'node:crypto';
import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { NodeVaultWriter } from '../adapters/fs/node-vault-writer.js';
import {
  CONSOLIDATION_LOG,
  ITEMS_PATH,
  MEMORY_DIR,
  addItem,
  forgetItem,
  parseItems,
  planConsolidation,
  selectHot,
  serializeItems,
  summarizeMemory,
  touchItem,
  validateItem,
} from '../application/vault-memory.js';
import type {
  Evidence,
  EvidenceResolver,
  EvidenceUnit,
  MemoryItem,
  MemoryKind,
  MemoryStatus,
} from '../application/vault-memory.js';
import type { ConsolidationAction } from '../application/vault-memory.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

/**
 * The memory ledger is agent state, not a note: it lives under .wiki/memory and,
 * like the L1 map, is written regardless of the writes switch. Every claim it
 * accepts must resolve its quote against the current source text, so a memory
 * that no longer matches the vault is caught by consolidation instead of being
 * repeated as fact.
 */
const CATALOG_PATH = '.wiki/index/catalog.json';
const LINE_FEED = String.fromCharCode(10);
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const DEFAULT_BUDGET = 400;
const MAX_BUDGET = 4000;
const RECENT_LOG_DAYS = 7;

export type KbMemoryAction = 'add' | 'list' | 'hot' | 'disputes' | 'touch' | 'forget' | 'consolidate';

export interface MemoryEvidenceInput {
  readonly path?: string;
  readonly unit?: string;
  readonly locator?: string | number;
  readonly quote?: string;
  readonly sha?: string;
}

export interface KbMemoryArgs {
  readonly action?: KbMemoryAction;
  readonly id?: string;
  readonly ids?: readonly string[];
  readonly kind?: string;
  readonly subject?: string;
  readonly statement?: string;
  readonly attribution?: string;
  readonly scope?: Readonly<Record<string, unknown>>;
  readonly status?: string;
  readonly confidence?: number;
  readonly importance?: number;
  readonly evidence?: readonly MemoryEvidenceInput[];
  readonly query?: string;
  readonly limit?: number;
  readonly budgetTokens?: number;
  readonly force?: boolean;
  readonly reason?: string;
  readonly apply?: boolean;
  readonly vaultPath?: string;
}

export interface KbMemoryDeps {
  readonly resolveRoot: (explicit?: string) => string;
  readonly now?: () => Date;
}

export interface MemoryRow {
  readonly id: string;
  readonly kind: string;
  readonly subject: string;
  readonly statement: string;
  readonly status: string;
  readonly confidence: number;
  readonly importance: number;
  readonly useCount: number;
  readonly lastUsedAt: string;
  readonly sources: readonly string[];
}

export interface HotRow {
  readonly id: string;
  readonly kind: string;
  readonly subject: string;
  readonly statement: string;
}

export interface KbMemoryReport {
  readonly ok: boolean;
  readonly action: string;
  readonly vaultRoot: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly hint?: string;
  readonly total?: number;
  readonly byKind?: Readonly<Record<string, number>>;
  readonly byStatus?: Readonly<Record<string, number>>;
  readonly items?: readonly MemoryRow[];
  readonly hot?: readonly HotRow[];
  readonly tokens?: number;
  readonly audit?: string;
  readonly actions?: readonly ConsolidationAction[];
  readonly applied?: boolean;
  readonly mergedInto?: string;
  readonly added?: boolean;
  readonly note?: string;
  readonly summary?: string;
}

interface StoredChunk {
  readonly id: string;
  readonly page: number;
  readonly text: string;
  readonly section?: string;
}

interface KbMemoryFs {
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function evidenceUnit(raw: unknown): EvidenceUnit | undefined {
  return raw === 'page' || raw === 'section' || raw === 'chunk' ? raw : undefined;
}

function kindOf(raw: unknown): MemoryKind | undefined {
  return raw === 'claim' || raw === 'unknown' || raw === 'preference' || raw === 'tension' ? raw : undefined;
}

function statusOf(raw: unknown): MemoryStatus | undefined {
  return raw === 'verified' || raw === 'derived' || raw === 'disputed' || raw === 'stale' ? raw : undefined;
}

/** Read .wiki/index/catalog.json: path -> sha. A missing catalog means no verifiable PDF evidence. */
async function readCatalogShas(fs: KbMemoryFs): Promise<Record<string, string>> {
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

async function readChunks(fs: KbMemoryFs, sha: string): Promise<StoredChunk[]> {
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

/** Markdown heading section: from the matching heading up to the next heading of the same or higher level. */
function noteSection(text: string, heading: string): string | undefined {
  const lines = text.split(/\r?\n/u);
  const wanted = heading.replace(/^#+\s*/u, '').trim();
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (match === null) continue;
    if (start < 0) {
      if ((match[2] ?? '').trim() === wanted) {
        start = index + 1;
        level = (match[1] ?? '#').length;
      }
      continue;
    }
    if ((match[1] ?? '#').length <= level) {
      return lines.slice(start, index).join(LINE_FEED).trim();
    }
  }
  if (start < 0) return undefined;
  return lines.slice(start).join(LINE_FEED).trim();
}

/**
 * Resolve evidence text synchronously: catalog sources through their chunk file,
 * markdown notes through the note body itself (section unit only; notes have no
 * pages, so a page locator on a note is refused rather than invented).
 */
class MemorySources {
  private readonly chunks = new Map<string, readonly StoredChunk[]>();
  private readonly notes = new Map<string, string | undefined>();

  constructor(private readonly fs: KbMemoryFs, private readonly shas: Record<string, string>) {}

  async preload(paths: readonly string[]): Promise<void> {
    await Promise.all([...new Set(paths)].map(async (path) => this.ensure(path)));
  }

  private async ensure(path: string): Promise<void> {
    if (this.chunks.has(path) || this.notes.has(path)) return;
    const sha = this.shas[path];
    if (sha !== undefined) {
      this.chunks.set(path, await readChunks(this.fs, sha));
      return;
    }
    let text: string | undefined;
    try {
      text = (await this.fs.exists(path)) ? await this.fs.readText(path) : undefined;
    } catch {
      text = undefined;
    }
    this.notes.set(path, text);
  }

  resolver(): EvidenceResolver {
    return (path: string, unit: EvidenceUnit, locator: string): string | undefined => {
      const chunks = this.chunks.get(path);
      if (chunks !== undefined) return locateChunkText(chunks, unit, locator);
      const note = this.notes.get(path);
      if (note === undefined) return undefined;
      if (unit !== 'section') return undefined;
      return noteSection(note, locator);
    };
  }
}

async function readItems(fs: KbMemoryFs): Promise<MemoryItem[]> {
  if (!(await fs.exists(ITEMS_PATH))) return [];
  try {
    return parseItems(await fs.readText(ITEMS_PATH));
  } catch {
    return [];
  }
}

async function appendLog(fs: KbMemoryFs, writer: NodeVaultWriter, lines: readonly string[]): Promise<boolean> {
  if (lines.length === 0) return false;
  let previous = '';
  if (await fs.exists(CONSOLIDATION_LOG)) {
    try {
      previous = await fs.readText(CONSOLIDATION_LOG);
    } catch {
      previous = '';
    }
  }
  const body = previous === '' || previous.endsWith(LINE_FEED) ? previous : previous + LINE_FEED;
  await writer.writeText(CONSOLIDATION_LOG, body + lines.join(LINE_FEED) + LINE_FEED);
  return true;
}

function memoryId(item: MemoryItem): string {
  const digest = createHash('sha256')
    .update([item.kind, item.subject, item.statement, item.createdAt].join('\u0000'))
    .digest('hex')
    .slice(0, 10);
  return 'm-' + digest;
}

function toEvidence(input: MemoryEvidenceInput): Evidence | undefined {
  const path = normalizePath(textOf(input.path));
  const unit = evidenceUnit(input.unit ?? 'page');
  const locator = typeof input.locator === 'number' ? String(input.locator) : textOf(input.locator);
  const quote = typeof input.quote === 'string' ? input.quote.trim() : '';
  if (path === '' || unit === undefined || locator === '' || quote === '') return undefined;
  const sha = textOf(input.sha);
  return sha === '' ? { path, unit, locator, quote, sha: '' } : { path, unit, locator, quote, sha };
}

function scopeOf(raw: Readonly<Record<string, unknown>> | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const scope: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (key.trim() !== '' && text !== '') scope[key.trim()] = text;
  }
  return Object.keys(scope).length === 0 ? undefined : scope;
}

function rowOf(item: MemoryItem): MemoryRow {
  return {
    id: item.id,
    kind: item.kind,
    subject: item.subject,
    statement: item.statement,
    status: item.status,
    confidence: item.confidence,
    importance: item.importance,
    useCount: item.useCount,
    lastUsedAt: item.lastUsedAt,
    sources: [...new Set(item.evidence.map((entry) => entry.path + '#' + entry.locator))].sort(),
  };
}

function hotRow(item: MemoryItem): HotRow {
  return { id: item.id, kind: item.kind, subject: item.subject, statement: item.statement };
}

function limitOf(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw)));
}

function budgetOf(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_BUDGET;
  return Math.min(MAX_BUDGET, Math.max(100, Math.trunc(raw)));
}

function compareRows(left: MemoryItem, right: MemoryItem): number {
  const order: Record<string, number> = { preference: 0, unknown: 1, tension: 2, claim: 3 };
  const rank = (order[left.kind] ?? 9) - (order[right.kind] ?? 9);
  if (rank !== 0) return rank;
  return left.lastUsedAt < right.lastUsedAt ? 1 : left.lastUsedAt > right.lastUsedAt ? -1 : left.id < right.id ? -1 : 1;
}

function summarize(items: readonly MemoryItem[]): string {
  const counts = summarizeMemory(items);
  return (
    '记忆 ' +
    counts.total +
    ' 条（结论 ' +
    counts.byKind.claim +
    ' · 缺口 ' +
    counts.byKind.unknown +
    ' · 偏好 ' +
    counts.byKind.preference +
    ' · 张 ' +
    counts.byKind.tension +
    '）· verified ' +
    counts.byStatus.verified +
    ' · stale ' +
    counts.byStatus.stale
  );
}

/** Render the report as plain text: deterministic, no markdown tables in the tool channel. */
function renderReport(report: KbMemoryReport): string {
  const lines: string[] = [];
  if (report.ok !== true) {
    if (report.error !== undefined) lines.push(report.error.code + ': ' + report.error.message);
    else lines.push('kb_memory failed');
    if (report.hint !== undefined) lines.push(report.hint);
    return lines.join(LINE_FEED);
  }
  if (report.summary !== undefined) lines.push(report.summary);
  for (const row of report.items ?? []) {
    lines.push('  [' + row.kind + '] ' + row.subject + ' — ' + row.statement + ' · ' + row.status + ' · 用 ' + row.useCount + ' 次');
  }
  for (const row of report.hot ?? []) {
    lines.push('  [' + row.kind + '] ' + row.subject + ' — ' + row.statement);
  }
  if (report.tokens !== undefined) lines.push('预算内 ' + report.tokens + ' token');
  if (report.audit !== undefined) lines.push(report.audit);
  for (const action of report.actions ?? []) {
    lines.push('  ' + action.kind + ' ' + action.id + (action.relatedId === undefined ? '' : ' ↔ ' + action.relatedId) + ' · ' + action.reason);
  }
  if (report.note !== undefined) lines.push(report.note);
  return lines.join(LINE_FEED);
}

export function createKbMemoryTool(deps: KbMemoryDeps) {
  return defineTool<KbMemoryArgs, KbMemoryReport>({
    name: 'kb_memory',
    description:
      'Per-vault long-term memory: conclusions (kind "claim"), open gaps ("unknown"), user preferences ("preference") and unresolved tensions ("tension"). action:"add" stores one item and verifies every quote against the current source text (page/section/chunk of an indexed document, or a markdown note section); "list" reads items, "hot" returns the faded top items, "disputes" lists every unresolved tension and every claim two sources contradict that fit a token budget, "touch" records reuse, "forget" removes one item (preferences and gaps need force), "consolidate" plans or applies dedupe/promote/stale/dispute without ever deleting a statement. Items decay by importance, age and use; the ledger lives in .wiki/memory/items.jsonl and is written regardless of the writes switch, like the index.',
    parameters: {
      action: {
        type: 'string',
        enum: ['add', 'list', 'hot', 'disputes', 'touch', 'forget', 'consolidate'],
        description: 'Default list.',
      },
      id: { type: 'string', description: 'add: optional explicit id. touch/forget: target item id (forget also accepts a subject).' },
      ids: { type: 'array', items: { type: 'string' }, description: 'touch: item ids to record as reused.' },
      kind: { type: 'string', enum: ['claim', 'unknown', 'preference', 'tension'], description: 'add: item kind, default claim. list: filter.' },
      subject: { type: 'string', description: 'add: short topic. forget: subject fallback.' },
      statement: { type: 'string', description: 'add: the conclusion or gap itself, one sentence.' },
      attribution: { type: 'string', description: 'add: who asserts it (authority, standard, commenter, or the plugin itself).' },
      scope: { type: 'json', description: 'add: scope keys such as jurisdiction, population, version, test conditions.' },
      status: { type: 'string', enum: ['verified', 'derived', 'disputed', 'stale'], description: 'add: default verified when evidence verifies, derived otherwise. list: filter.' },
      confidence: { type: 'number', description: 'add: 0..1, default 0.6.' },
      importance: { type: 'number', description: 'add: 0..5, default 1.' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            unit: { type: 'string', enum: ['page', 'section', 'chunk'] },
            locator: { type: 'json', required: true },
            quote: { type: 'string', required: true },
            sha: { type: 'string' },
          },
        },
        description: 'add: source units backing the statement; each quote must appear in the current text.',
      },
      query: { type: 'string', description: 'list: filter subject/statement.' },
      limit: { type: 'integer', description: 'list: rows, default 40, max 200.' },
      budgetTokens: { type: 'integer', description: 'hot: token budget, default 400.' },
      force: { type: 'boolean', description: 'forget: required for preference and unknown items.' },
      reason: { type: 'string', description: 'forget: audit reason.' },
      apply: { type: 'boolean', description: 'consolidate: write the planned changes; default false (plan only).' },
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
            properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
          },
          hint: { type: 'string' },
          total: { type: 'integer' },
          byKind: { type: 'json' },
          byStatus: { type: 'json' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                statement: { type: 'string', required: true },
                status: { type: 'string', required: true },
                confidence: { type: 'number', required: true },
                importance: { type: 'number', required: true },
                useCount: { type: 'integer', required: true },
                lastUsedAt: { type: 'string', required: true },
                sources: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          hot: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                statement: { type: 'string', required: true },
              },
            },
          },
          tokens: { type: 'integer' },
          audit: { type: 'string' },
          actions: { type: 'json' },
          applied: { type: 'boolean' },
          mergedInto: { type: 'string' },
          added: { type: 'boolean' },
          note: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      const action = args.action ?? 'list';
      let root = '(unresolved)';
      const nowDate = deps.now?.() ?? new Date();
      const now = nowDate.toISOString();
      try {
        root = deps.resolveRoot(args.vaultPath);
        const fs = new NodeVaultFs(root);
        const writer = new NodeVaultWriter(root);
        const items = await readItems(fs);
        const shas = await readCatalogShas(fs);
        const summaryOf = (list: readonly MemoryItem[]): Partial<KbMemoryReport> => {
          const counts = summarizeMemory(list);
          return {
            total: counts.total,
            byKind: counts.byKind,
            byStatus: counts.byStatus,
            summary: summarize(list),
          };
        };

        if (action === 'list') {
          const wanted = textOf(args.query).toLowerCase();
          const kind = kindOf(args.kind);
          const status = statusOf(args.status);
          const filtered = items.filter((item) => {
            if (wanted !== '') {
              const haystack = (item.subject + ' ' + item.statement).toLowerCase();
              if (!haystack.includes(wanted)) return false;
            }
            if (kind !== undefined && item.kind !== kind) return false;
            return status === undefined || item.status === status;
          });
          return {
            ok: true,
            action,
            vaultRoot: root,
            ...summaryOf(items),
            items: [...filtered].sort(compareRows).slice(0, limitOf(args.limit)).map(rowOf),
            note: filtered.length > limitOf(args.limit) ? '只显示前 ' + limitOf(args.limit) + ' 条，共 ' + filtered.length + ' 条' : undefined,
          };
        }

        if (action === 'disputes') {
          const contested = items.filter((item) => item.status === 'disputed' || item.kind === 'tension');
          return {
            ok: true,
            action,
            vaultRoot: root,
            ...summaryOf(items),
            items: contested.sort(compareRows).slice(0, limitOf(args.limit)).map(rowOf),
            note:
              contested.length === 0
                ? '没有未决争议：结论之间没有出现互相矛盾或多种解读'
                : '有 ' + contested.length + ' 条未决争议：两个说法都要列出出处，不要替用户裁决；数值矛盾可用 kb_facts 核对',
          };
        }

        if (action === 'hot') {
          const selected = selectHot(items, { budgetTokens: budgetOf(args.budgetTokens), now });
          return {
            ok: true,
            action,
            vaultRoot: root,
            ...summaryOf(items),
            hot: selected.hot.map(hotRow),
            tokens: selected.tokens,
            note: selected.hot.length === 0 ? '还没有可注入的记忆：先用 kb_memory 的 add 记录结论、缺口或偏好' : undefined,
          };
        }

        if (action === 'add') {
          const kind = kindOf(args.kind ?? 'claim');
          const subject = textOf(args.subject);
          const statement = textOf(args.statement);
          if (kind === undefined || subject === '' || statement === '') {
            return {
              ok: false,
              action,
              vaultRoot: root,
              error: { code: 'kb.memory.bad-request', message: 'add 需要 kind（claim|unknown|preference|tension）、subject 与 statement' },
            };
          }
          const evidence: Evidence[] = [];
          for (const raw of args.evidence ?? []) {
            const entry = toEvidence(raw);
            if (entry === undefined) {
              return {
                ok: false,
                action,
                vaultRoot: root,
                error: { code: 'kb.memory.no-evidence', message: '每条证据都需要 path、locator 与 quote' },
                hint: 'PDF 用 {unit:"page", locator:12}；笔记小节用 {unit:"section", locator:"标题"}',
              };
            }
            if (entry.sha === '' && shas[entry.path] !== undefined) entry.sha = shas[entry.path] ?? '';
            evidence.push(entry);
          }
          const confidence = typeof args.confidence === 'number' && Number.isFinite(args.confidence) ? args.confidence : 0.6;
          const importance = typeof args.importance === 'number' && Number.isFinite(args.importance) ? args.importance : 1;
          const item: MemoryItem = {
            id: textOf(args.id) === '' ? '' : textOf(args.id),
            kind,
            subject,
            statement,
            ...(textOf(args.attribution) === '' ? {} : { attribution: textOf(args.attribution) }),
            ...(scopeOf(args.scope) === undefined ? {} : { scope: scopeOf(args.scope) }),
            evidence,
            status: statusOf(args.status) ?? (evidence.length === 0 ? 'derived' : 'verified'),
            confidence,
            importance,
            createdAt: now,
            lastUsedAt: now,
            useCount: 0,
          };
          item.id = item.id === '' ? memoryId(item) : item.id;

          const sources = new MemorySources(fs, shas);
          await sources.preload(evidence.map((entry) => entry.path));
          const needsEvidence =
            evidence.length > 0 || kind === 'tension' || (kind === 'claim' && statusOf(args.status) !== 'derived');
          if (needsEvidence) {
            const report = validateItem(item, sources.resolver(), shas, { allowUnknown: true });
            if (!report.ok) {
              return {
                ok: false,
                action,
                vaultRoot: root,
                error: {
                  code: 'kb.memory.no-evidence',
                  message: '证据核不过：' + (report.problems.length === 0 ? 'unknown' : report.problems.join(', ')),
                },
                hint: 'quote 必须是该页/该节的原文；先 kb_query 或 kb_map 拿到准确原文再记录。偏好与缺口可以不带证据，未核实的推断请把 status 设为 derived。',
              };
            }
          }
          const result = addItem(items, item);
          await writer.writeText(ITEMS_PATH, serializeItems(result.items));
          let applied = false;
          let actions: ConsolidationAction[] = [];
          // Writing is not confirmation: a fresh preference stays derived until it is reused or the user confirms it.
          const plan = planConsolidation(result.items, {
            now,
            resolve: sources.resolver(),
            currentShas: shas,
          });
          actions = plan.actions;
          if (actions.length > 0) {
            await writer.writeText(ITEMS_PATH, serializeItems(plan.items));
            applied = true;
            await appendLog(fs, writer, actions.map((entry) => now + ' ' + entry.kind + ' ' + entry.id + (entry.relatedId === undefined ? '' : ' related=' + entry.relatedId) + ' reason=' + entry.reason));
          }
          return {
            ok: true,
            action,
            vaultRoot: root,
            ...summaryOf(applied ? plan.items : result.items),
            added: result.added,
            ...(result.mergedInto === undefined ? {} : { mergedInto: result.mergedInto }),
            applied,
            actions,
            note: result.added ? '已记录；下次问答可先用 kb_memory 的 hot 取回' : '同一 subject 已有条目，已合并证据与时间',
          };
        }

        if (action === 'touch') {
          const ids = (args.ids ?? []).map((value) => textOf(value)).filter((value) => value !== '');
          if (ids.length === 0) {
            return { ok: false, action, vaultRoot: root, error: { code: 'kb.memory.bad-request', message: 'touch 需要 ids' } };
          }
          let next = items;
          for (const id of ids) next = touchItem(next, id, now);
          await writer.writeText(ITEMS_PATH, serializeItems(next));
          return { ok: true, action, vaultRoot: root, ...summaryOf(next), note: '已记录 ' + ids.length + ' 次复用' };
        }

        if (action === 'forget') {
          const target = textOf(args.id) === '' ? textOf(args.subject) : textOf(args.id);
          if (target === '') {
            return { ok: false, action, vaultRoot: root, error: { code: 'kb.memory.bad-request', message: 'forget 需要 id 或 subject' } };
          }
          const result = forgetItem(items, target, { at: now, reason: textOf(args.reason) === '' ? undefined : textOf(args.reason), force: args.force === true });
          const changed = result.items.length !== items.length;
          if (changed) await writer.writeText(ITEMS_PATH, serializeItems(result.items));
          await appendLog(fs, writer, [result.audit]);
          return {
            ok: true,
            action,
            vaultRoot: root,
            ...summaryOf(result.items),
            audit: result.audit,
            note: changed ? '已遗忘' : '未删除：条目不存在，或偏好/缺口需要 force:true',
          };
        }

        // consolidate
        const sources = new MemorySources(fs, shas);
        const paths = [...new Set(items.flatMap((item) => item.evidence.map((entry) => entry.path)))];
        await sources.preload(paths);
        const plan = planConsolidation(items, { now, resolve: sources.resolver(), currentShas: shas });
        const apply = args.apply === true;
        if (apply) {
          await writer.writeText(ITEMS_PATH, serializeItems(plan.items));
          await appendLog(fs, writer, plan.actions.map((entry) => now + ' ' + entry.kind + ' ' + entry.id + (entry.relatedId === undefined ? '' : ' related=' + entry.relatedId) + ' reason=' + entry.reason));
        }
        return {
          ok: true,
          action,
          vaultRoot: root,
          ...summaryOf(apply ? plan.items : items),
          actions: plan.actions,
          applied: apply,
          note: apply ? '已应用整理计划（只合并与标记，不删除断言）' : '只是计划；确认后传 apply:true 写入',
        };
      } catch (error) {
        return {
          ok: false,
          action,
          vaultRoot: root,
          error: { code: 'kb.memory.failed', message: messageOf(error) },
          hint: '检查知识点目录是否可写：' + MEMORY_DIR,
        };
      }
    },
  });
}
