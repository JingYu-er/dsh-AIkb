#!/usr/bin/env node
// Backfill .wiki/index/glossary.json from chunk files that are already ingested, so an existing
// vault gets bilingual query expansion without re-extracting a single PDF.
//
//   node scripts/build_glossary.mjs --vault D:/path/to/MyObsidian [--dry-run]
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { harvestTermPairs } from '../dist/domain/glossary-harvest.js';
import { GLOSSARY_PATH, loadGlossary, mergeGlossary, serializeGlossary } from '../dist/application/glossary-store.js';
import { chunkFileOf } from '../dist/application/kb-ingest.js';

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}

const vault = argOf('vault');
if (vault === undefined) {
  console.error('usage: node scripts/build_glossary.mjs --vault <vault path> [--dry-run]');
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');

const catalogPath = join(vault, '.wiki', 'index', 'catalog.json');
if (!existsSync(catalogPath)) {
  console.error('no catalog at ' + catalogPath + ' (run kb_ingest first)');
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const sources = Object.entries(catalog.sources ?? {});

const terms = [];
let books = 0;
let chunks = 0;
for (const [sha256, source] of sources) {
  const chunkPath = join(vault, chunkFileOf(sha256));
  if (!existsSync(chunkPath)) continue;
  books += 1;
  terms.push(...harvestTermPairs(source.path ?? sha256));
  for (const line of readFileSync(chunkPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    chunks += 1;
    if (typeof chunk.text === 'string') terms.push(...harvestTermPairs(chunk.text));
  }
}

const fsShim = {
  async exists(relPath) {
    return existsSync(join(vault, relPath));
  },
  async readText(relPath) {
    return readFileSync(join(vault, relPath), 'utf8');
  },
  async writeText(relPath, content) {
    const target = join(vault, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return content.length;
  },
};

const current = dryRun ? undefined : await loadGlossary(fsShim);
const merged = mergeGlossary(current, terms, '', new Date());
const payload = serializeGlossary(merged.file);
if (!dryRun) {
  await fsShim.writeText(GLOSSARY_PATH, payload);
}
const abbrev = merged.file.entries.filter((entry) => entry.kind === 'abbrev').length;
console.log(JSON.stringify({
  ok: true,
  vault,
  dryRun,
  books,
  chunks,
  pairs: terms.length,
  entries: merged.file.entries.length,
  added: merged.added,
  abbrev,
  bytes: payload.length,
  path: GLOSSARY_PATH,
}, null, 2));
