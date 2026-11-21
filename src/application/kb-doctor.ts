import { DomainError } from '../shared/result.js';

export interface DoctorEntry {
  readonly relPath: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

/** Read-only view of the vault tree. The adapter owns recursion and exclusions. */
export interface DoctorVaultFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  listFiles(): Promise<readonly DoctorEntry[]>;
  readText(relPath: string): Promise<string>;
  /** Where version control lives for this vault: the vault itself, an ancestor, or nowhere. */
  versionControl?(): Promise<'vault' | 'ancestor' | undefined>;
  /** Direct files of one directory, including dot-directories (the index lives under .wiki/). */
  listDir?(relDir: string): Promise<readonly DoctorEntry[]>;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorCounts {
  readonly markdown: number;
  readonly sources: number;
  readonly sourceBytes: number;
  readonly images: number;
  readonly attachments: number;
}

export interface DoctorError {
  readonly code: string;
  readonly message: string;
}

export interface DoctorReport {
  /** False only when the environment could not be inspected at all; failures never throw. */
  readonly ok: boolean;
  readonly error?: DoctorError;
  readonly vaultRoot: string;
  readonly vaultName: string;
  readonly checks: readonly DoctorCheck[];
  readonly counts: DoctorCounts;
  readonly byExtension: Readonly<Record<string, number>>;
  readonly layout: { readonly inbox: boolean; readonly wiki: boolean; readonly git: boolean };
  readonly booksManifest: { readonly path: string; readonly present: boolean; readonly entries: number };
  /** Python/PyMuPDF readiness; absent only when inspection never ran. */
  readonly python?: {
    readonly ok: boolean;
    readonly pythonPath: string;
    readonly source: string;
    readonly venvPath: string;
    readonly pymupdfVersion: string;
    readonly bootstrapped: boolean;
    readonly errors: readonly string[];
  };
  /** Index health: cache file, chunk files vs catalog, vector sidecars. Absent before the first ingest. */
  readonly index?: DoctorIndex;
  readonly writesEnabled: boolean;
  readonly nextActions: readonly string[];
}

export interface DoctorIndex {
  readonly cacheBytes: number;
  readonly cacheModifiedAt: string;
  readonly catalogSources: number;
  readonly catalogChunks: number;
  readonly chunkFiles: number;
  /** Chunk files on disk that the catalog no longer lists. */
  readonly orphanChunkFiles: number;
  /** Catalog sources with no chunk file (an interrupted ingest). */
  readonly missingChunkFiles: number;
  /** Catalog sources whose chunk count is zero. */
  readonly emptySources: number;
  readonly vectorFiles: number;
  readonly missingVectors: number;
  /** Vector sidecars whose chunk count no longer matches the catalog. */
  readonly staleVectors: number;
}

export interface DoctorOptions {
  readonly allowWrites: boolean;
  readonly inboxDir?: string;
  readonly wikiDir?: string;
  readonly booksManifest?: string;
}

const SOURCE_EXTENSIONS = new Set(['pdf', 'epub', 'djvu']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const LINE_FEED = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

function lastSeparator(value: string): number {
  return Math.max(value.lastIndexOf('/'), value.lastIndexOf(BACKSLASH));
}

function extensionOf(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  return dot > relPath.lastIndexOf('/') ? relPath.slice(dot + 1).toLowerCase() : '';
}

function baseName(value: string): string {
  return value.slice(lastSeparator(value) + 1);
}

function isAbsolutePath(value: string): boolean {
  if (value.startsWith('/')) return true;
  return value.length > 2 && value[1] === ':' && (value[2] === '/' || value[2] === BACKSLASH);
}

const EMPTY_COUNTS: DoctorCounts = { markdown: 0, sources: 0, sourceBytes: 0, images: 0, attachments: 0 };

/** A broken environment is a report, never an exception across the tool boundary. */
export function failedDoctorReport(root: string, error: unknown): DoctorReport {
  const domain = error instanceof DomainError ? error : undefined;
  const code = domain !== undefined ? domain.code : 'vault.inspect-failed';
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: { code, message },
    vaultRoot: root,
    vaultName: baseName(root),
    checks: [{ id: 'vault.resolve', status: 'fail', detail: code + ': ' + message }],
    counts: EMPTY_COUNTS,
    byExtension: {},
    layout: { inbox: false, wiki: false, git: false },
    booksManifest: { path: '.wiki/books.jsonl', present: false, entries: 0 },
    writesEnabled: false,
    nextActions: ['Set vaultPath in the dsh-AIkb plugin config, or pass vaultPath explicitly.'],
  };
}

export async function runDoctor(vaultFs: DoctorVaultFs, options: DoctorOptions): Promise<DoctorReport> {
  const root = vaultFs.root;
  if (!isAbsolutePath(root)) {
    throw new DomainError('vault.root.relative', 'vault root must be absolute: ' + root);
  }

  const files = await vaultFs.listFiles();
  const checks: DoctorCheck[] = [];
  const nextActions: string[] = [];

  const marker = await vaultFs.exists('.obsidian');
  checks.push({
    id: 'vault.marker',
    status: marker ? 'pass' : 'fail',
    detail: marker ? '.obsidian found' : 'no .obsidian directory: this folder is not an Obsidian vault root',
  });
  if (!marker) nextActions.push('Point vaultPath at the folder that contains .obsidian.');

  let markdown = 0;
  let sources = 0;
  let sourceBytes = 0;
  let images = 0;
  let attachments = 0;
  const byExtension: Record<string, number> = {};

  for (const file of files) {
    const ext = extensionOf(file.relPath);
    if (ext !== '') byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    if (ext === 'md') markdown += 1;
    if (SOURCE_EXTENSIONS.has(ext)) {
      sources += 1;
      sourceBytes += file.bytes;
    }
    if (IMAGE_EXTENSIONS.has(ext)) images += 1;
    if (file.relPath.startsWith('attachments/')) attachments += 1;
  }

  checks.push({ id: 'vault.notes', status: markdown > 0 ? 'pass' : 'fail', detail: markdown + ' markdown notes' });
  checks.push({
    id: 'vault.sources',
    status: sources > 0 ? 'pass' : 'warn',
    detail: sources + ' source documents (' + Math.round(sourceBytes / 1048576) + ' MiB)',
  });

  const inboxRel = options.inboxDir ?? 'inbox';
  const wikiRel = options.wikiDir ?? '.wiki';
  const inbox = await vaultFs.exists(inboxRel);
  const wiki = await vaultFs.exists(wikiRel);
  checks.push({
    id: 'layout.inbox',
    status: inbox ? 'pass' : 'warn',
    detail: inbox ? inboxRel + '/ present' : inboxRel + '/ missing: approved drafts have nowhere to land',
  });
  checks.push({
    id: 'layout.wiki',
    status: wiki ? 'pass' : 'warn',
    detail: wiki ? wikiRel + '/ present' : wikiRel + '/ missing: compiled artefacts will be created on first compile',
  });
  if (!inbox) nextActions.push('Create ' + inboxRel + '/ (human-reviewed drafts) before enabling writes.');

  const versionControl = vaultFs.versionControl === undefined ? (await vaultFs.exists('.git') ? 'vault' as const : undefined) : await vaultFs.versionControl();
  const git = versionControl !== undefined;
  checks.push({
    id: 'layout.versioning',
    status: git ? 'pass' : 'warn',
    detail: git
      ? versionControl === 'vault'
        ? 'git metadata at the vault root: text changes can be diffed and rolled back'
        : 'git metadata in an ancestor directory: the vault is versioned together with its parent'
      : 'no git metadata: enable it before the compiler writes anything',
  });

  const manifestPath = options.booksManifest ?? wikiRel + '/books.jsonl';
  const manifestPresent = await vaultFs.exists(manifestPath);
  let manifestEntries = 0;
  if (manifestPresent) {
    const text = await vaultFs.readText(manifestPath);
    manifestEntries = text.split(LINE_FEED).filter((line) => line.trim() !== '').length;
  }
  checks.push({
    id: 'inventory.books',
    status: manifestPresent ? 'pass' : 'warn',
    detail: manifestPresent ? manifestPath + ' with ' + manifestEntries + ' entries' : manifestPath + ' missing: sources are not inventoried yet',
  });
  if (!manifestPresent) nextActions.push('Build the book inventory at ' + manifestPath + ' before ingesting sources.');

  const indexRel = wikiRel + '/index';
  let index: DoctorIndex | undefined;
  if (vaultFs.listDir !== undefined && (await vaultFs.exists(indexRel + '/catalog.json'))) {
    const catalog = JSON.parse(await vaultFs.readText(indexRel + '/catalog.json')) as { sources?: Record<string, { chunks?: number }> };
    const sources = catalog.sources ?? {};
    const shas = Object.keys(sources);
    const chunkEntries = await vaultFs.listDir(indexRel + '/chunks');
    const vectorEntries = await vaultFs.listDir(indexRel + '/vectors');
    const indexEntries = await vaultFs.listDir(indexRel);
    const baseNameOf = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1);
    const chunkShas = new Set(chunkEntries.filter((file) => file.relPath.endsWith('.jsonl')).map((file) => baseNameOf(file.relPath).replace(/\.jsonl$/, '')));
    const vectorShas = new Set(vectorEntries.filter((file) => file.relPath.endsWith('.json')).map((file) => baseNameOf(file.relPath).replace(/\.json$/, '')));
    const cache = indexEntries.find((file) => file.relPath.endsWith('/search-cache.bin'));
    const cacheBytes = cache?.bytes ?? 0;
    const cacheModifiedAt = cache?.modifiedAt ?? '';
    let catalogChunks = 0;
    let missingChunkFiles = 0;
    let emptySources = 0;
    let missingVectors = 0;
    let staleVectors = 0;
    for (const sha of shas) {
      const chunks = sources[sha]?.chunks ?? 0;
      catalogChunks += chunks;
      if (!chunkShas.has(sha)) missingChunkFiles += 1;
      if (chunks === 0) emptySources += 1;
      if (!vectorShas.has(sha)) {
        missingVectors += 1;
        continue;
      }
      try {
        const meta = JSON.parse(await vaultFs.readText(indexRel + '/vectors/' + sha + '.json')) as { count?: number };
        if (typeof meta.count === 'number' && meta.count !== chunks) staleVectors += 1;
      } catch {
        staleVectors += 1;
      }
    }
    const orphanChunkFiles = [...chunkShas].filter((sha) => !(sha in sources)).length;
    index = {
      cacheBytes, cacheModifiedAt, catalogSources: shas.length, catalogChunks,
      chunkFiles: chunkShas.size,
      orphanChunkFiles,
      missingChunkFiles, emptySources,
      vectorFiles: vectorShas.size, missingVectors, staleVectors,
    };
    checks.push({
      id: 'index.cache',
      status: cacheBytes > 0 ? 'pass' : 'warn',
      detail: cacheBytes > 0
        ? Math.round(cacheBytes / 1048576) + ' MiB search cache, last written ' + cacheModifiedAt
        : 'no search cache yet: the first query rebuilds the index from chunk files',
    });
    checks.push({
      id: 'index.vectors',
      status: missingVectors === 0 && staleVectors === 0 ? 'pass' : 'warn',
      detail: missingVectors === 0 && staleVectors === 0
        ? vectorShas.size + ' books embedded'
        : missingVectors + ' book(s) without vectors, ' + staleVectors + ' stale; run kb_embed to catch up',
    });
    if (missingChunkFiles > 0 || orphanChunkFiles > 0) {
      checks.push({
        id: 'index.chunks',
        status: 'warn',
        detail: missingChunkFiles + ' catalog source(s) without a chunk file, ' + orphanChunkFiles + ' orphan chunk file(s)',
      });
    }
    if (missingVectors > 0) nextActions.push('Run kb_embed to embed ' + missingVectors + ' book(s) so hybrid search can use them.');
  }

  checks.push({
    id: 'guards.writes',
    status: options.allowWrites ? 'warn' : 'pass',
    detail: options.allowWrites
      ? 'writes enabled: only inbox/ and .wiki/ may change, never a user note'
      : 'read-only mode: no tool can modify the vault',
  });

  return {
    ok: true,
    vaultRoot: root,
    vaultName: baseName(root),
    checks,
    counts: { markdown, sources, sourceBytes, images, attachments },
    byExtension,
    layout: { inbox, wiki, git },
    booksManifest: { path: manifestPath, present: manifestPresent, entries: manifestEntries },
    ...(index !== undefined ? { index } : {}),
    writesEnabled: options.allowWrites,
    nextActions,
  };
}
