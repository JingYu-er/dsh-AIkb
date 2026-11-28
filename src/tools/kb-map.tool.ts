import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { NodeVaultWriter } from '../adapters/fs/node-vault-writer.js';
import {
  MAP_SCHEMA,
  buildMap,
  docFor,
  findEntities,
  mapCoverage,
  serializeMap,
} from '../application/vault-map.js';
import type { MapDoc, MapEntity, MapFile, MapMention, MapSection } from '../application/vault-map.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

/**
 * The L1 map lives beside the catalog and the chunk files. Building it is index
 * maintenance, not note editing, so it does not consult the writes switch: the
 * primary input is the compiled index and nothing outside .wiki/index is touched.
 */
export const MAP_FILE_PATH = '.wiki/index/map.json';
export const MAP_MISSING_MESSAGE = 'kb.map.missing: run kb_map {action:"build"} first';
export const MAP_MISSING_HINT = '还没有库地图，先运行 kb_map 的 build';

const LINE_FEED = String.fromCharCode(10);
const DEFAULT_ACTION = 'coverage';
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 500;
const MAX_SOURCES = 3;

export type KbMapAction = 'coverage' | 'docs' | 'entities' | 'sections' | 'build';

export interface KbMapArgs {
  readonly action?: KbMapAction;
  readonly query?: string;
  readonly path?: string;
  readonly limit?: number;
  readonly vaultPath?: string;
}

export interface KbMapDeps {
  readonly resolveRoot: (explicit?: string) => string;
  /** Clock for the rebuilt map; tests pin it so builtAt stays deterministic. */
  readonly now?: () => Date;
}

export interface MapCoverageView {
  readonly text: string;
  readonly docs: number;
  readonly pages: number;
  readonly sections: number;
  readonly entities: number;
  readonly docsWithoutSections: number;
  readonly docsWithoutEntities: number;
  readonly unparsed: readonly string[];
}

export interface MapDocRow {
  readonly path: string;
  readonly title: string;
  readonly pageCount: number;
  readonly sections: number;
}

export interface MapEntityRow {
  readonly id: string;
  readonly label: string;
  readonly mentions: number;
  readonly sources: readonly string[];
}

export interface MapSectionRow {
  readonly title: string;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly anchor: string;
}

export interface KbMapReport {
  readonly ok: boolean;
  readonly action: string;
  readonly vaultRoot: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly hint?: string;
  readonly builtAt?: string;
  readonly mapPath?: string;
  readonly written?: boolean;
  readonly incremental?: boolean;
  readonly coverage?: MapCoverageView;
  readonly docs?: readonly MapDocRow[];
  readonly docCount?: number;
  readonly limit?: number;
  readonly entities?: readonly MapEntityRow[];
  readonly entityCount?: number;
  readonly doc?: { readonly path: string; readonly title: string; readonly pageCount: number };
  readonly sections?: readonly MapSectionRow[];
  readonly note?: string;
  readonly summary?: string;
}

interface KbMapFs {
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
}

/** A corrupt map is reported like a missing one: both mean "rebuild it". */
export type MapLoad =
  | { readonly ok: true; readonly map: MapFile }
  | { readonly ok: false; readonly reason: 'missing' | 'corrupt'; readonly detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function pathOf(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\\/gu, '/').replace(/^\.\//u, '') : '';
}

function sectionOf(value: unknown): MapSection | undefined {
  if (!isRecord(value) || typeof value.title !== 'string' || value.title === '') return undefined;
  return { title: value.title, pageStart: countOf(value.pageStart), pageEnd: countOf(value.pageEnd) };
}

function mentionOf(value: unknown): MapMention | undefined {
  const path = isRecord(value) ? pathOf(value.path) : '';
  if (!isRecord(value) || path === '') return undefined;
  return { path, unit: 'page', locator: countOf(value.locator), count: countOf(value.count) };
}

function docOf(value: unknown): MapDoc | undefined {
  if (!isRecord(value)) return undefined;
  const path = pathOf(value.path);
  if (path === '') return undefined;
  const sections: MapSection[] = [];
  if (Array.isArray(value.sections)) {
    for (const raw of value.sections) {
      const section = sectionOf(raw);
      if (section !== undefined) sections.push(section);
    }
  }
  return {
    path,
    sha: textOf(value.sha, ''),
    title: textOf(value.title, path),
    pageCount: countOf(value.pageCount),
    firstLine: textOf(value.firstLine, ''),
    sections,
  };
}

function entityOf(value: unknown): MapEntity | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (id === '') return undefined;
  const aliases: string[] = [];
  if (Array.isArray(value.aliases)) {
    for (const raw of value.aliases) if (typeof raw === 'string' && raw !== '') aliases.push(raw);
  }
  const mentions: MapMention[] = [];
  if (Array.isArray(value.mentions)) {
    for (const raw of value.mentions) {
      const mention = mentionOf(raw);
      if (mention !== undefined) mentions.push(mention);
    }
  }
  return { id, label: textOf(value.label, id), aliases, mentions };
}

function unparsedOf(value: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(value) || !Array.isArray(value.unparsed)) return out;
  for (const raw of value.unparsed) {
    const path = pathOf(raw);
    if (path !== '' && !out.includes(path)) out.push(path);
  }
  return out.sort(compareText);
}

/** Read .wiki/index/map.json, keeping only the fields the tools render. */
export async function loadMap(fs: KbMapFs): Promise<MapLoad> {
  if (!(await fs.exists(MAP_FILE_PATH))) {
    return { ok: false, reason: 'missing', detail: MAP_FILE_PATH + ' not found' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readText(MAP_FILE_PATH));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'corrupt', detail: MAP_FILE_PATH + ' is not valid JSON (' + reason + ')' };
  }
  if (!isRecord(parsed) || parsed.schema !== MAP_SCHEMA) {
    return { ok: false, reason: 'corrupt', detail: MAP_FILE_PATH + ' has no schema ' + MAP_SCHEMA };
  }
  if (!Array.isArray(parsed.docs) || !Array.isArray(parsed.entities)) {
    return { ok: false, reason: 'corrupt', detail: MAP_FILE_PATH + ' has no docs/entities arrays' };
  }
  const docs: MapDoc[] = [];
  for (const raw of parsed.docs) {
    const doc = docOf(raw);
    if (doc !== undefined) docs.push(doc);
  }
  const entities: MapEntity[] = [];
  for (const raw of parsed.entities) {
    const entity = entityOf(raw);
    if (entity !== undefined) entities.push(entity);
  }
  docs.sort((left, right) => compareText(left.path, right.path));
  const mentioned = new Set<string>();
  for (const entity of entities) for (const mention of entity.mentions) mentioned.add(mention.path);
  const map: MapFile = {
    schema: MAP_SCHEMA,
    builtAt: textOf(parsed.builtAt, ''),
    docs,
    entities,
    coverage: {
      docs: docs.length,
      pages: docs.reduce((sum, doc) => sum + doc.pageCount, 0),
      sections: docs.reduce((sum, doc) => sum + doc.sections.length, 0),
      entities: entities.length,
      docsWithoutSections: docs.filter((doc) => doc.sections.length === 0).length,
      docsWithoutEntities: docs.filter((doc) => !mentioned.has(doc.path)).length,
      unparsed: unparsedOf(parsed.coverage),
    },
  };
  return { ok: true, map };
}

function coverageView(map: MapFile): MapCoverageView {
  const mentioned = new Set<string>();
  for (const entity of map.entities) for (const mention of entity.mentions) mentioned.add(mention.path);
  return {
    text: mapCoverage(map),
    docs: map.docs.length,
    pages: map.docs.reduce((sum, doc) => sum + doc.pageCount, 0),
    sections: map.docs.reduce((sum, doc) => sum + doc.sections.length, 0),
    entities: map.entities.length,
    docsWithoutSections: map.docs.filter((doc) => doc.sections.length === 0).length,
    docsWithoutEntities: map.docs.filter((doc) => !mentioned.has(doc.path)).length,
    unparsed: [...map.coverage.unparsed],
  };
}

function coverageJson(view: MapCoverageView): string {
  return JSON.stringify({
    docs: view.docs,
    pages: view.pages,
    sections: view.sections,
    entities: view.entities,
    docsWithoutSections: view.docsWithoutSections,
    docsWithoutEntities: view.docsWithoutEntities,
    unparsed: view.unparsed.length,
  });
}

function docRow(doc: MapDoc): MapDocRow {
  return { path: doc.path, title: doc.title, pageCount: doc.pageCount, sections: doc.sections.length };
}

function entityRow(entity: MapEntity): MapEntityRow {
  const sources: string[] = [];
  let mentions = 0;
  for (const mention of entity.mentions) {
    mentions += mention.count;
    if (!sources.includes(mention.path)) sources.push(mention.path);
  }
  return { id: entity.id, label: entity.label, mentions, sources: sources.slice(0, MAX_SOURCES) };
}

function entityRows(map: MapFile, query: string): readonly MapEntityRow[] {
  const matches = query === '' ? [...map.entities] : [...findEntities(map, query)];
  return matches
    .map((entity) => entityRow(entity))
    .sort((left, right) => right.mentions - left.mentions || compareText(left.label, right.label) || compareText(left.id, right.id));
}

function docLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw)));
}

function normalizeQuery(raw: string | undefined): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'kb.map.failed';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingMapReport(root: string, action: string, load: { readonly reason: 'missing' | 'corrupt'; readonly detail: string }): KbMapReport {
  return {
    ok: false,
    action,
    vaultRoot: root,
    error: { code: 'kb.map.missing', message: MAP_MISSING_MESSAGE },
    hint: load.reason === 'missing' ? MAP_MISSING_HINT : 'map.json 无法解析，先重建：kb_map {action:"build"}（' + load.detail + '）',
  };
}

async function runBuild(root: string, deps: KbMapDeps): Promise<KbMapReport> {
  try {
    const fs = new NodeVaultFs(root);
    const loaded = await loadMap(fs);
    const now = deps.now?.() ?? new Date();
    const previous = loaded.ok ? loaded.map : undefined;
    const map = previous === undefined ? await buildMap(fs, { now }) : await buildMap(fs, { now, previous });
    await new NodeVaultWriter(root).writeText(MAP_FILE_PATH, serializeMap(map));
    const coverage = coverageView(map);
    return {
      ok: true,
      action: 'build',
      vaultRoot: root,
      mapPath: MAP_FILE_PATH,
      written: true,
      incremental: previous !== undefined,
      builtAt: map.builtAt,
      coverage,
      docCount: map.docs.length,
      entityCount: map.entities.length,
      summary:
        '库地图已重建：' +
        map.docs.length +
        ' 篇文档 · ' +
        coverage.sections +
        ' 个小节 · ' +
        map.entities.length +
        ' 个实体' +
        (previous === undefined ? '' : '（增量）'),
    };
  } catch (error) {
    const code = codeOf(error);
    if (code.startsWith('map.')) {
      return {
        ok: false,
        action: 'build',
        vaultRoot: root,
        error: { code: 'kb.map.missing', message: messageOf(error) },
        hint: '先运行 kb_ingest 生成 catalog.json 与 chunks，再 kb_map 的 build',
      };
    }
    return {
      ok: false,
      action: 'build',
      vaultRoot: root,
      error: { code: 'kb.map.failed', message: messageOf(error) },
      hint: '写 .wiki/index/map.json 失败',
    };
  }
}

/** Render the report as plain Chinese text: one block, deterministic order. */
function renderReport(report: KbMapReport): string {
  const lines: string[] = [];
  if (report.ok !== true) {
    if (report.error !== undefined) lines.push(report.error.code + ': ' + report.error.message);
    else lines.push('kb_map failed');
    if (report.hint !== undefined) lines.push(report.hint);
    return lines.join(LINE_FEED);
  }
  if (report.action === 'build') {
    lines.push(
      'kb_map build: 写入 ' +
        (report.mapPath ?? MAP_FILE_PATH) +
        ' · builtAt ' +
        (report.builtAt ?? '-') +
        (report.incremental === true ? ' · 增量' : ''),
    );
  } else if (report.action === 'docs') {
    lines.push('文档 ' + (report.docCount ?? 0) + ' 篇（显示 ' + (report.docs?.length ?? 0) + '/' + (report.limit ?? DEFAULT_LIMIT) + '）');
  } else if (report.action === 'entities') {
    lines.push('实体 ' + (report.entityCount ?? 0) + ' 个（显示 ' + (report.entities?.length ?? 0) + '）');
  } else if (report.action === 'sections') {
    const doc = report.doc;
    lines.push(
      (doc === undefined ? '-' : doc.path + '（' + doc.title + '，' + doc.pageCount + ' 页）') +
        ' · ' +
        (report.sections?.length ?? 0) +
        ' 个小节',
    );
  } else {
    lines.push('库地图覆盖（builtAt ' + (report.builtAt ?? '-') + '）');
  }
  if (report.summary !== undefined && report.action !== 'build') lines.push(report.summary);
  const coverage = report.coverage;
  if (coverage !== undefined) {
    lines.push(coverage.text);
    lines.push(coverageJson(coverage));
  }
  for (const row of report.docs ?? []) {
    lines.push('  ' + row.path + ' — ' + row.title + ' · ' + row.pageCount + ' 页 · ' + row.sections + ' 节');
  }
  for (const row of report.entities ?? []) {
    const sources = row.sources.length === 0 ? '-' : row.sources.join('、');
    lines.push('  ' + row.label + '（' + row.id + '）· 提及 ' + row.mentions + ' 次 · 出处 ' + sources);
  }
  for (const row of report.sections ?? []) {
    lines.push('    · ' + row.title + ' [p' + row.pageStart + '–p' + row.pageEnd + '] ' + row.anchor);
  }
  if (report.note !== undefined) lines.push(report.note);
  return lines.join(LINE_FEED);
}

export function createKbMapTool(deps: KbMapDeps) {
  return defineTool<KbMapArgs, KbMapReport>({
    name: 'kb_map',
    description:
      'Read the deterministic L1 map of the vault: which documents were indexed, their sections and pages, and which entities (part numbers, device models, glossary terms) appear where. action:"coverage" reports totals and gaps, "docs" lists documents, "entities" lists or looks up entities, "sections" lists one document\'s sections, and "build" rebuilds .wiki/index/map.json from the compiled index. Read actions never build: a missing map returns kb.map.missing and asks you to run build. build writes only .wiki/index/map.json (index maintenance, allowed regardless of the writes switch).',
    parameters: {
      action: {
        type: 'string',
        enum: ['coverage', 'docs', 'entities', 'sections', 'build'],
        description: 'Default coverage. build rewrites .wiki/index/map.json from catalog.json and chunks/.',
      },
      query: { type: 'string', description: 'docs: filter on path or title. entities: exact or case-insensitive name lookup.' },
      path: { type: 'string', description: 'sections: document path as listed by action:"docs".' },
      limit: { type: 'integer', description: 'docs/entities: rows to return, default 40, max 500.' },
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
          builtAt: { type: 'string' },
          mapPath: { type: 'string' },
          written: { type: 'boolean' },
          incremental: { type: 'boolean' },
          coverage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              docs: { type: 'integer', required: true },
              pages: { type: 'integer', required: true },
              sections: { type: 'integer', required: true },
              entities: { type: 'integer', required: true },
              docsWithoutSections: { type: 'integer', required: true },
              docsWithoutEntities: { type: 'integer', required: true },
              unparsed: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          docs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                title: { type: 'string', required: true },
                pageCount: { type: 'integer', required: true },
                sections: { type: 'integer', required: true },
              },
            },
          },
          docCount: { type: 'integer' },
          limit: { type: 'integer' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                mentions: { type: 'integer', required: true },
                sources: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          entityCount: { type: 'integer' },
          doc: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              title: { type: 'string', required: true },
              pageCount: { type: 'integer', required: true },
            },
          },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                pageStart: { type: 'integer', required: true },
                pageEnd: { type: 'integer', required: true },
                anchor: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      const action = args.action ?? DEFAULT_ACTION;
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        if (action === 'build') return await runBuild(root, deps);
        const loaded = await loadMap(new NodeVaultFs(root));
        if (!loaded.ok) return missingMapReport(root, action, loaded);
        const map = loaded.map;

        if (action === 'docs') {
          const limit = docLimit(args.limit);
          const query = normalizeQuery(args.query).toLowerCase();
          const matched = map.docs.filter(
            (doc) => query === '' || doc.path.toLowerCase().includes(query) || doc.title.toLowerCase().includes(query),
          );
          return {
            ok: true,
            action,
            vaultRoot: root,
            builtAt: map.builtAt,
            coverage: coverageView(map),
            docs: matched.slice(0, limit).map((doc) => docRow(doc)),
            docCount: matched.length,
            limit,
          };
        }

        if (action === 'entities') {
          const limit = docLimit(args.limit);
          const rows = entityRows(map, normalizeQuery(args.query));
          return {
            ok: true,
            action,
            vaultRoot: root,
            builtAt: map.builtAt,
            coverage: coverageView(map),
            entities: rows.slice(0, limit),
            entityCount: rows.length,
            limit,
          };
        }

        if (action === 'sections') {
          const wanted = normalizeQuery(args.path);
          if (wanted === '') {
            return {
              ok: false,
              action,
              vaultRoot: root,
              error: { code: 'kb.map.missing', message: 'sections 需要 path：先运行 kb_map 的 docs 拿到文档路径' },
              hint: '例如 kb_map {action:"sections", path:"manual.pdf"}',
            };
          }
          const doc = docFor(map, wanted);
          if (doc === undefined) {
            return {
              ok: false,
              action,
              vaultRoot: root,
              error: { code: 'kb.map.missing', message: '库里没有这篇文档：' + wanted },
              hint: '先运行 kb_map 的 docs 看可用路径',
            };
          }
          return {
            ok: true,
            action,
            vaultRoot: root,
            builtAt: map.builtAt,
            doc: { path: doc.path, title: doc.title, pageCount: doc.pageCount },
            sections: doc.sections.map((section) => ({
              title: section.title,
              pageStart: section.pageStart,
              pageEnd: section.pageEnd,
              anchor: doc.path + '#' + section.title,
            })),
            note: '节锚点用 path#title：Markdown 没有页码，pageStart/pageEnd 只是索引 chunk 所在的页；引用小节时写 path#title 最稳。',
          };
        }

        return {
          ok: true,
          action: 'coverage',
          vaultRoot: root,
          builtAt: map.builtAt,
          coverage: coverageView(map),
          summary: '覆盖统计见下；缺文档/缺小节/缺实体都列在 coverage 里',
        };
      } catch (error) {
        return {
          ok: false,
          action,
          vaultRoot: root,
          error: { code: codeOf(error), message: messageOf(error) },
        };
      }
    },
  });
}
