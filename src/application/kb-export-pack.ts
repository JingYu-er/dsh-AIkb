import { promises as fsPromises, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { DomainError } from '../shared/result.js';
import { chunkFileOf, INDEX_CATALOG_PATH } from './kb-ingest.js';

const LINE_FEED = String.fromCharCode(10);

/** Header of manifest.json; bump only when the pack layout changes incompatibly. */
export const PACK_SCHEMA = 'dsh-aikb/pack@1';
export const PACK_MANIFEST_NAME = 'manifest.json';
export const PACK_CHUNKS_NAME = 'chunks.jsonl';
export const PACK_SKILL_NAME = 'SKILL.md';
export const PACK_README_NAME = 'README.md';

/** Read view of the compiled index; NodeVaultFs already satisfies this. */
export interface PackIndexFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
}

/**
 * Write view of the destination. Paths are absolute on purpose: a pack lives outside the
 * vault, so the vault write guard neither applies nor should apply here.
 */
export interface PackWriter {
  mkdir(absoluteDir: string): Promise<void>;
  writeText(absolutePath: string, content: string): Promise<number>;
}

export const nodePackWriter: PackWriter = {
  async mkdir(absoluteDir: string): Promise<void> {
    await fsPromises.mkdir(absoluteDir, { recursive: true });
  },
  async writeText(absolutePath: string, content: string): Promise<number> {
    await fsPromises.writeFile(absolutePath, content, 'utf8');
    return Buffer.byteLength(content, 'utf8');
  },
};

export interface PackFile {
  readonly name: string;
  readonly bytes: number;
}

export interface PackCounts {
  readonly sources: number;
  readonly chunks: number;
}

export interface PackSuccess {
  readonly ok: true;
  readonly packDir: string;
  readonly files: PackFile[];
  readonly counts: PackCounts;
  readonly warnings: string[];
}

export interface PackRefusal {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export type PackReport = PackSuccess | PackRefusal;

export interface PackInput {
  readonly vaultRoot: string;
  readonly vaultName: string;
  readonly packName: string;
  /** Absolute destination directory. */
  readonly packDir: string;
  readonly generatedAt: Date;
  /** Override for tests; absent reads the plugin's own package.json. */
  readonly pluginVersion?: string;
}

interface CollectedChunk {
  readonly page: number;
  readonly section: string | null;
  readonly text: string;
  /** Position of the chunk on its page, so same-page rows keep ingest order. */
  readonly ordinal: number;
}

interface CollectedSource {
  readonly path: string;
  readonly sha256: string;
  readonly pages: number;
  readonly chunks: CollectedChunk[];
  readonly warnings: string[];
}

interface CollectedIndex {
  readonly sources: CollectedSource[];
  readonly orphanWarnings: string[];
}

interface CatalogShape {
  readonly sources: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  // Code-unit order, not locale order: the same index must sort the same on every machine.
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function ordinalOf(id: string): number {
  const marker = id.lastIndexOf(':');
  if (marker < 0) return 0;
  const ordinal = Number.parseInt(id.slice(marker + 1), 10);
  return Number.isNaN(ordinal) ? 0 : ordinal;
}

function pagesOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** `pack-YYYYMMDD-HHmmss` in local time; the caller may still pass an explicit name. */
export function defaultPackName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return 'pack-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
    + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
}

/**
 * Version comes from the plugin's own package.json. Walking up covers all three layouts this
 * file runs in: src/ in a checkout, dist/ after a build, .test-build/src/ under the tests.
 */
export function readPluginVersion(): string {
  let dir = nodePath.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(nodePath.join(dir, 'package.json'), 'utf8'));
      if (isRecord(parsed) && parsed.name === 'dsh-aikb' && typeof parsed.version === 'string' && parsed.version !== '') {
        return parsed.version;
      }
    } catch {
      // No package.json at this level: keep walking.
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

async function readCatalog(fs: PackIndexFs): Promise<CatalogShape> {
  if (!(await fs.exists(INDEX_CATALOG_PATH))) {
    throw new DomainError('kb.pack.empty-index', 'no compiled chunks: ' + INDEX_CATALOG_PATH + ' is missing; run kb_ingest first');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readText(INDEX_CATALOG_PATH));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DomainError('kb.pack.corrupt-index', 'catalog.json is not valid JSON (' + reason + '); run kb_ingest to rebuild the index');
  }
  if (!isRecord(parsed)) {
    throw new DomainError('kb.pack.corrupt-index', 'catalog.json is not an object; run kb_ingest to rebuild the index');
  }
  const sources = parsed.sources;
  if (!isRecord(sources)) {
    throw new DomainError('kb.pack.corrupt-index', 'catalog.json has no sources object; run kb_ingest to rebuild the index');
  }
  return { sources };
}

async function collectIndex(fs: PackIndexFs, catalog: CatalogShape): Promise<CollectedIndex> {
  const sources: CollectedSource[] = [];
  const orphanWarnings: string[] = [];
  for (const [sha256, raw] of Object.entries(catalog.sources)) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || raw.path === '') {
      orphanWarnings.push('source ' + sha256 + ': catalog entry has no path; skipped');
      continue;
    }
    const sourcePath = raw.path;
    const relPath = chunkFileOf(sha256);
    if (!(await fs.exists(relPath))) {
      sources.push({
        path: sourcePath,
        sha256,
        pages: pagesOf(raw.pages, 0),
        chunks: [],
        warnings: ['source ' + sourcePath + ': chunk file missing (' + relPath + '); no chunks exported for it'],
      });
      continue;
    }
    const warnings: string[] = [];
    const chunks: CollectedChunk[] = [];
    let lineNumber = 0;
    for (const line of (await fs.readText(relPath)).split(/\r?\n/)) {
      lineNumber += 1;
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        warnings.push('source ' + sourcePath + ': skipped unparsable chunk line ' + lineNumber);
        continue;
      }
      if (!isRecord(parsed) || typeof parsed.page !== 'number' || !Number.isFinite(parsed.page) || typeof parsed.text !== 'string') {
        warnings.push('source ' + sourcePath + ': skipped chunk line ' + lineNumber + ' (no page/text)');
        continue;
      }
      chunks.push({
        page: parsed.page,
        section: typeof parsed.section === 'string' ? parsed.section : null,
        text: parsed.text,
        ordinal: ordinalOf(typeof parsed.id === 'string' ? parsed.id : ''),
      });
    }
    chunks.sort((left, right) => left.page - right.page || left.ordinal - right.ordinal);
    const maxPage = chunks.reduce((max, chunk) => Math.max(max, chunk.page), 0);
    if (typeof raw.chunks === 'number' && raw.chunks !== chunks.length) {
      warnings.push('source ' + sourcePath + ': catalog lists ' + raw.chunks + ' chunk(s) but ' + chunks.length + ' were exported');
    }
    sources.push({ path: sourcePath, sha256, pages: pagesOf(raw.pages, maxPage), chunks, warnings });
  }
  sources.sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.sha256, right.sha256));
  orphanWarnings.sort(compareStrings);
  return { sources, orphanWarnings };
}

function renderSkill(packName: string): string {
  return [
    '# ' + packName + ' — knowledge pack',
    '',
    'A read-only export of a dsh-AIkb index. Treat it as evidence: search it, cite it, never copy it back into notes.',
    '',
    '## Files',
    '',
    '- `chunks.jsonl` — one JSON object per line: `{"path", "page", "section", "text"}`. `path` is vault-relative, `page` is 1-based, `section` is the outline heading or `null`.',
    '- `manifest.json` — pack name, generation time, plugin and vault provenance, and per-source counts.',
    '',
    '## Search it',
    '',
    '1. Exact identifiers first: `grep -n -F "ADA4505" chunks.jsonl`. Part numbers, error strings and function names are matched literally, so try the exact spelling before anything fuzzy.',
    '2. Then keywords: `grep -n -i "quiescent current" chunks.jsonl`, or grep several keywords and rank the lines yourself.',
    '3. Cite a hit as `path#page`, for example `books/analog.pdf#214`. Open the original source when the exact wording matters.',
    '',
    '## Limits',
    '',
    '- Text only: no figures, no tables rendered as images, no page layout.',
    '- `section` is the nearest outline heading, not a guarantee.',
    '- The pack is a snapshot of one index; a newer ingest may not match it.',
  ].join(LINE_FEED) + LINE_FEED;
}

/** Written only when the pack has gaps: that is the part SKILL.md does not cover. */
function renderReadme(packName: string, warnings: readonly string[]): string {
  return [
    '# ' + packName + ' — pack gaps',
    '',
    'This pack was written from an index that does not fully match its own catalog. `manifest.json` is authoritative.',
    '',
    ...warnings.map((warning) => '- ' + warning),
    '',
    'A source listed with `chunks: 0` contributes no text to `chunks.jsonl`. Re-run `kb_ingest` for it and export again if it matters.',
  ].join(LINE_FEED) + LINE_FEED;
}

/**
 * Export the compiled index as a deterministic, portable pack. Only manifest.generatedAt and
 * the caller-supplied name differ between two runs over the same index; sources and chunk rows
 * are sorted by path, then page, then ingest order.
 */
export async function runExportPack(fs: PackIndexFs, writer: PackWriter, input: PackInput): Promise<PackSuccess> {
  const catalog = await readCatalog(fs);
  const collected = await collectIndex(fs, catalog);
  const warnings: string[] = [];
  for (const source of collected.sources) warnings.push(...source.warnings);
  warnings.push(...collected.orphanWarnings);

  const rows = collected.sources.flatMap((source) => source.chunks.map((chunk) => ({
    path: source.path,
    page: chunk.page,
    section: chunk.section,
    text: chunk.text,
  })));
  if (rows.length === 0) {
    throw new DomainError('kb.pack.empty-index', 'the compiled index holds no chunks; run kb_ingest first');
  }

  const counts: PackCounts = { sources: collected.sources.length, chunks: rows.length };
  const manifest = {
    schema: PACK_SCHEMA,
    name: input.packName,
    generatedAt: input.generatedAt.toISOString(),
    plugin: { name: 'dsh-aikb', version: input.pluginVersion ?? readPluginVersion() },
    vault: { name: input.vaultName, path: input.vaultRoot },
    counts,
    sources: collected.sources.map((source) => ({
      path: source.path,
      sha256: source.sha256,
      pages: source.pages,
      chunks: source.chunks.length,
    })),
  };
  const chunksText = rows.map((row) => JSON.stringify(row)).join(LINE_FEED) + LINE_FEED;

  await writer.mkdir(input.packDir);
  const files: PackFile[] = [];
  const write = async (name: string, content: string): Promise<void> => {
    const bytes = await writer.writeText(nodePath.join(input.packDir, name), content);
    files.push({ name, bytes });
  };
  await write(PACK_MANIFEST_NAME, JSON.stringify(manifest, null, 2) + LINE_FEED);
  await write(PACK_CHUNKS_NAME, chunksText);
  await write(PACK_SKILL_NAME, renderSkill(input.packName));
  if (warnings.length > 0) await write(PACK_README_NAME, renderReadme(input.packName, warnings));

  return { ok: true, packDir: input.packDir, files, counts, warnings };
}
