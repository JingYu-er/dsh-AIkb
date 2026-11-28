import { buildMap, serializeMap } from './vault-map.js';
import type { MapFile } from './vault-map.js';
import { GLOSSARY_PATH, parseGlossary } from './glossary-store.js';
import {
  POLICY_PATH,
  SYNONYMS_PATH,
  TAXONOMY_PATH,
  harvestProfile,
  mergeProfile,
  parseProfile,
  serializeProfile,
} from './vault-profile.js';

/**
 * One pass over an already-ingested vault: rebuild the L1 map, learn the vault
 * profile again from the chunks that are on disk, and report what the pair can
 * answer. Ingest stays a separate tool, so a first run still looks like
 * kb_ingest -> kb_init {action:"bootstrap"} -> kb_query.
 */
export const BOOTSTRAP_CATALOG_PATH = '.wiki/index/catalog.json';
export const BOOTSTRAP_MAP_PATH = '.wiki/index/map.json';

export interface BootstrapFs {
  readonly root: string;
  exists(relPath: string): Promise<boolean>;
  readText(relPath: string): Promise<string>;
}

/** Write half of the vault adapter; kept separate so read-only usage stays read-only. */
export interface BootstrapWriter {
  writeText(relPath: string, text: string): Promise<unknown>;
}

export interface BootstrapReport {
  readonly ok: boolean;
  readonly vaultRoot: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly map?: {
    readonly path: string;
    readonly docs: number;
    readonly pages: number;
    readonly sections: number;
    readonly entities: number;
    readonly unparsed: readonly string[];
  };
  readonly profile?: {
    readonly taxonomy: number;
    readonly synonyms: number;
    readonly policy: number;
    readonly written: readonly string[];
  };
  /** Catalog paths whose chunk file is missing, i.e. the index and the catalog disagree. */
  readonly missingSources: readonly string[];
  readonly elapsedMs: number;
}

interface CatalogSource {
  readonly path: string;
  readonly pages?: number;
}

interface CatalogFile {
  readonly sources?: Record<string, CatalogSource>;
}

function chunkFileOf(sha: string): string {
  return '.wiki/index/chunks/' + sha + '.jsonl';
}

async function loadChunks(fs: BootstrapFs, catalog: CatalogFile): Promise<{ sourceId: string; path: string; text: string }[]> {
  const chunks: { sourceId: string; path: string; text: string }[] = [];
  for (const [sha, source] of Object.entries(catalog.sources ?? {})) {
    let text: string;
    try {
      text = await fs.readText(chunkFileOf(sha));
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try {
        const chunk = JSON.parse(line) as { text?: unknown };
        if (typeof chunk.text === 'string') chunks.push({ sourceId: sha, path: source.path, text: chunk.text });
      } catch {
        // One malformed line is a lost excerpt, not a failed bootstrap.
      }
    }
  }
  return chunks;
}

async function loadProfileInputs(fs: BootstrapFs): Promise<{ taxonomy?: string; synonyms?: string; policy?: string }> {
  const inputs: { taxonomy?: string; synonyms?: string; policy?: string } = {};
  if (await fs.exists(TAXONOMY_PATH)) inputs.taxonomy = await fs.readText(TAXONOMY_PATH);
  if (await fs.exists(SYNONYMS_PATH)) inputs.synonyms = await fs.readText(SYNONYMS_PATH);
  if (await fs.exists(POLICY_PATH)) inputs.policy = await fs.readText(POLICY_PATH);
  return inputs;
}

async function loadPreviousMap(fs: BootstrapFs): Promise<MapFile | undefined> {
  if (!(await fs.exists(BOOTSTRAP_MAP_PATH))) return undefined;
  try {
    return JSON.parse(await fs.readText(BOOTSTRAP_MAP_PATH)) as MapFile;
  } catch {
    return undefined;
  }
}

async function glossaryPairs(fs: BootstrapFs): Promise<{ a: string; b: string }[]> {
  if (!(await fs.exists(GLOSSARY_PATH))) return [];
  try {
    const file = parseGlossary(await fs.readText(GLOSSARY_PATH));
    return file.entries.map((entry) => ({ a: entry.a, b: entry.b }));
  } catch {
    return [];
  }
}

export async function runBootstrap(fs: BootstrapFs, writer: BootstrapWriter, now: Date = new Date()): Promise<BootstrapReport> {
  const started = Date.now();
  const report = (partial: Omit<BootstrapReport, 'elapsedMs' | 'vaultRoot'>): BootstrapReport => ({
    ...partial,
    vaultRoot: fs.root,
    elapsedMs: Date.now() - started,
  });

  if (!(await fs.exists(BOOTSTRAP_CATALOG_PATH))) {
    return report({
      ok: false,
      missingSources: [],
      error: {
        code: 'kb.bootstrap.no-index',
        message: 'This vault has no compiled index yet; run kb_ingest first, then bootstrap.',
      },
    });
  }
  let catalog: CatalogFile;
  try {
    catalog = JSON.parse(await fs.readText(BOOTSTRAP_CATALOG_PATH)) as CatalogFile;
  } catch {
    return report({
      ok: false,
      missingSources: [],
      error: {
        code: 'kb.bootstrap.bad-index',
        message: 'catalog.json is not readable JSON; rerun kb_ingest to rebuild the index.',
      },
    });
  }
  const sources = catalog.sources ?? {};
  if (Object.keys(sources).length === 0) {
    return report({
      ok: false,
      missingSources: [],
      error: {
        code: 'kb.bootstrap.empty-index',
        message: 'The index lists no sources; add documents and run kb_ingest before bootstrap.',
      },
    });
  }

  const missingSources: string[] = [];
  for (const [sha, source] of Object.entries(sources)) {
    if (!(await fs.exists(chunkFileOf(sha)))) missingSources.push(source.path);
  }

  const map = await buildMap(fs, { now, previous: await loadPreviousMap(fs) });
  await writer.writeText(BOOTSTRAP_MAP_PATH, serializeMap(map));

  const profileInputs = await loadProfileInputs(fs);
  let current: ReturnType<typeof parseProfile> | undefined;
  if (Object.keys(profileInputs).length > 0) {
    try {
      current = parseProfile(profileInputs);
    } catch {
      current = undefined;
    }
  }
  const chunks = await loadChunks(fs, catalog);
  let profile: BootstrapReport['profile'];
  const written: string[] = [];
  if (chunks.length > 0) {
    const harvested = harvestProfile(chunks, await glossaryPairs(fs));
    const sourceShas: Record<string, string> = {};
    for (const [sha, source] of Object.entries(sources)) sourceShas[source.path] = sha;
    const merged = mergeProfile(current, harvested, { sourceShas, now });
    const files = serializeProfile(merged.profile);
    await writer.writeText(TAXONOMY_PATH, files.taxonomy);
    await writer.writeText(SYNONYMS_PATH, files.synonyms);
    await writer.writeText(POLICY_PATH, files.policy);
    written.push(TAXONOMY_PATH, SYNONYMS_PATH, POLICY_PATH);
    profile = {
      taxonomy: merged.profile.taxonomy.entries.length,
      synonyms: merged.profile.synonyms.entries.length,
      policy: merged.profile.policy.entries.length,
      written,
    };
  }

  return report({
    ok: true,
    map: {
      path: BOOTSTRAP_MAP_PATH,
      docs: map.coverage.docs,
      pages: map.coverage.pages,
      sections: map.coverage.sections,
      entities: map.coverage.entities,
      unparsed: map.coverage.unparsed,
    },
    ...(profile === undefined ? {} : { profile }),
    missingSources,
  });
}
