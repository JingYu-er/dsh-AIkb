import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { evaluate, formatSummary, summarize } from './metrics.mjs';

const DIST = new URL('../dist/', import.meta.url);
const distFile = (path) => new URL(path, DIST).href;
if (!existsSync(new URL('application/kb-query.js', DIST))) {
  console.error('bench: dist/ is missing - run "npm run build" first');
  process.exit(1);
}
const { runQuery } = await import(distFile('application/kb-query.js'));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const value = (name, fallback) => {
  const at = argv.indexOf('--' + name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};

const ROOT = process.env.KB_VAULT ?? 'D:/JingYu/Desktop/ai-brain/MyObsidian';
const WORKSPACE = process.env.KB_WORKSPACE ?? 'D:/JingYu/Desktop/ai-brain';
const setNames = value('set', 'all') === 'all' ? ['zh', 'zh2', 'en', 'en2'] : [value('set', 'zh')];
const mode = value('mode', 'bm25');
const useMulti = flag('multi');
const useRerank = flag('rerank');
const useExpand = value('expand', 'none');
const rerankBlend = Number(value('rerank-blend', '0')) || undefined;
const rerankPool = Number(value('rerank-pool', '0')) || undefined;
const hybridWeight = Number(value('hybrid-weight', '0')) || undefined;
const topK = Number(value('topk', '8'));
const useNotesLayer = flag('notes-layer');
const notesLimit = Number(value('notes-limit', '5')) || 5;
/** Field weighting is on by default; --no-notes-weight is the control run for the old flat BM25. */
const notesWeight = flag('no-notes-weight') ? false : (flag('notes-weight') ? true : undefined);
const notesHub = value('notes-hub', '') === '' ? undefined : Number(value('notes-hub', ''));
const useNotesEmbed = flag('notes-embed');
const useNotesRerank = flag('notes-rerank');
const outPath = value('json', '');
const verbose = flag('verbose');
/** Widen queries with the vault glossary (mirrors the plugin default-on path). */
const useGlossary = flag('glossary');
/** Also load the learned synonyms sidecar (the profile's stated pairs). */
const useSynonyms = flag('synonyms');

/**
 * The notes layer lists the vault at query time. Bench-side walker: skip dot directories and
 * node_modules, and carry an mtime so the layer's cache key can notice edits.
 */
function walkVault(rel = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(ROOT, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const next = rel === '' ? entry.name : rel + '/' + entry.name;
    if (entry.isDirectory()) {
      out.push(...walkVault(next));
      continue;
    }
    let modifiedAt = '';
    try {
      modifiedAt = statSync(join(ROOT, next)).mtime.toISOString();
    } catch { /* a file removed mid-walk is not worth failing over */ }
    out.push({ relPath: next, bytes: 0, modifiedAt });
  }
  return out;
}

const fs = {
  root: ROOT,
  exists: async (rel) => existsSync(join(ROOT, rel)),
  readText: async (rel) => readFileSync(join(ROOT, rel), 'utf8'),
  listFiles: async () => walkVault(),
};

/** Page lookup for the term@5 metric: catalog path -> source id -> page text. */
const INDEX = join(ROOT, '.wiki/index');
const catalog = JSON.parse(readFileSync(join(INDEX, 'catalog.json'), 'utf8'));
const sourceIdByPath = new Map(Object.entries(catalog.sources).map(([id, meta]) => [meta.path, id]));
const pageCache = new Map();
function pageTextOf(hit) {
  const sourceId = sourceIdByPath.get(hit.path);
  if (sourceId === undefined) return '';
  let pages = pageCache.get(sourceId);
  if (pages === undefined) {
    pages = new Map();
    const file = join(INDEX, 'chunks', sourceId + '.jsonl');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        const chunk = JSON.parse(line);
        pages.set(chunk.page, (pages.get(chunk.page) ?? '') + '\n' + chunk.text);
      }
    }
    pageCache.set(sourceId, pages);
  }
  return pages.get(hit.page) ?? '';
}

function loadVectors() {
  const dir = join(ROOT, '.wiki/index/vectors');
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  const ids = [];
  const parts = [];
  let dims = 0;
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const buffer = readFileSync(join(dir, name.replace(/\.json$/, '.vec')));
      if (!meta.count || !meta.dims || buffer.byteLength !== meta.count * meta.dims * 4) continue;
      if (dims === 0) dims = meta.dims;
      if (meta.dims !== dims) continue;
      const copy = new Float32Array(meta.count * meta.dims);
      new Uint8Array(copy.buffer).set(buffer);
      ids.push(...meta.ids.slice(0, meta.count));
      parts.push(copy);
    } catch { /* skip a broken pair */ }
  }
  const data = new Float32Array(ids.length * dims);
  let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  return { ids, data, dims };
}

let vectors;
let embedQuery;
const pythonPath = join(WORKSPACE, '.kb/venv/Scripts/python.exe');
const embeddingModel = join(WORKSPACE, '.kb/models/multilingual-e5-small');
if (mode === 'hybrid') {
  vectors = loadVectors();
  if (vectors === undefined || vectors.ids.length === 0) {
    console.error('bench: no vectors under .wiki/index/vectors - run kb_embed first');
    process.exit(1);
  }
  ({ embedQuery } = await import(distFile('adapters/embeddings/embedding.js')));
  console.log('vectors:', vectors.ids.length, 'chunks,', vectors.dims, 'dims');
}

let glossary;
if (useGlossary) {
  const { parseGlossary, expansionEntries } = await import(distFile('application/glossary-store.js'));
  glossary = expansionEntries(parseGlossary(readFileSync(join(ROOT, '.wiki/index/glossary.json'), 'utf8')));
  console.log('glossary pairs:', glossary.length);
}
if (useSynonyms) {
  const { parseProfile } = await import(distFile('application/vault-profile.js'));
  const { isExpandablePair } = await import(distFile('domain/glossary.js'));
  const profile = parseProfile(readFileSync(join(ROOT, '.wiki/index/synonyms.json'), 'utf8'));
  const extra = profile.synonyms.entries
    .filter((entry) => entry.stale !== true)
    .map((entry) => ({ a: entry.a, b: entry.b }))
    .filter((entry) => isExpandablePair(entry));
  glossary = [...(glossary ?? []), ...extra];
  console.log('synonym pairs:', extra.length);
}

const config = { set: setNames, mode, multi: useMulti, rerank: useRerank, expand: useExpand, topK, notesLayer: useNotesLayer, notesLimit, notesWeight, notesHub, notesEmbed: useNotesEmbed, notesRerank: useNotesRerank };
console.log(JSON.stringify(config));

const report = { config, sets: {} };
for (const setName of setNames) {
  if (setName === 'notes') {
    // Notes set: each question's answer lives in one vault note; a hit is that note's path in the
    // returned pages. Baseline (books only) scores 0 because .md files are not in the index.
    const lines = readFileSync(new URL('./questions-notes.jsonl', import.meta.url), 'utf8')
      .split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const items = lines.map((line) => JSON.parse(line));
    const rows = [];
    const detail = [];
    // The note corpus is small enough to build its matrix on the first run; later runs hit the
    // cache in .wiki/index/notes-vectors.* unless a note changed.
    let notesVectors;
    let notesEmbedQuery;
    let notesRerankFn;
    if (useNotesEmbed) {
      const { ensureNoteVectors, loadNoteVectors } = await import(distFile('application/notes-vectors.js'));
      notesVectors = loadNoteVectors(ROOT) ?? (await ensureNoteVectors(fs, { pythonPath, workspaceRoot: WORKSPACE, modelDir: embeddingModel }));
      if (notesVectors === undefined) console.error('bench: note vectors unavailable - staying lexical');
      ({ embedQuery: notesEmbedQuery } = await import(distFile('adapters/embeddings/embedding.js')));
    }
    if (useNotesRerank) {
      const { rerankPassages } = await import(distFile('adapters/embeddings/rerank.js'));
      notesRerankFn = async (query, documents) => {
        const result = await rerankPassages({ pythonPath, workspaceRoot: WORKSPACE, modelDir: join(WORKSPACE, '.kb/models/bge-reranker-base'), query, documents });
        return result.ok ? result.scores : undefined;
      };
    }
    const startedAt = Date.now();
    for (const item of items) {
      const options = {};
      if (useNotesLayer) {
        options.notesLayer = true;
        options.notesLimit = notesLimit;
        if (notesWeight !== undefined) options.notesWeight = notesWeight;
        if (notesHub !== undefined && Number.isFinite(notesHub)) options.notesHubPenalty = notesHub;
        if (notesRerankFn !== undefined) options.notesRerank = (documents) => notesRerankFn(item.q, documents);
        if (notesVectors !== undefined) {
          options.notesVectors = notesVectors;
          const vector = await notesEmbedQuery({ pythonPath, workspaceRoot: WORKSPACE, modelDir: embeddingModel, text: item.q });
          if (vector !== undefined) options.notesQueryVector = vector;
        }
      }
      if (rerankBlend !== undefined) options.rerankBlend = rerankBlend;
      const result = await runQuery(fs, item.q, 5, options);
      const rank = result.hits.findIndex((hit) => hit.path === item.path || hit.path.endsWith('/' + item.path));
      rows.push({ rr: rank >= 0 ? 1 / (rank + 1) : 0, hit5: rank >= 0 && rank < 5 ? 1 : 0, rank });
      const top = result.hits.slice(0, 3).map((hit) => (hit.path.split('/').pop() ?? '') + ' p.' + hit.page + (hit.kind === 'note' ? ' [note]' : ''));
      detail.push({ query: item.q, path: item.path, rank, ok: rank >= 0 && rank < 5, ranks: top, ms: result.elapsedMs });
      if (verbose) console.log(' ', rank >= 0 && rank < 5 ? 'Y' : 'n', item.q, '->', top.join(' | '));
    }
    const n = rows.length;
    const hit5 = rows.reduce((sum, row) => sum + row.hit5, 0);
    const mrr = n === 0 ? 0 : rows.reduce((sum, row) => sum + row.rr, 0) / n;
    const summary = { label: 'notes', n, hit5, mrr: Number(mrr.toFixed(3)), avgMs: n === 0 ? 0 : Math.round((Date.now() - startedAt) / n) };
    console.log('notes (n=' + n + ') hit@5 ' + hit5 + '/' + n + ' mrr ' + summary.mrr.toFixed(2) + ' avg ' + summary.avgMs + 'ms');
    report.sets[setName] = { summary, items: detail };
    continue;
  }
  const { items } = await import('./sets/' + setName + '.mjs');
  const rows = [];
  const detail = [];
  const startedAt = Date.now();
  for (const [query, path, truth, topic, alt, terms] of items) {
    const options = {};
    if (vectors !== undefined) options.vectors = vectors;
    if (useMulti && typeof alt === 'string' && alt.trim() !== '') options.queries = [alt];
    if (useRerank) {
      const { rerankPassages } = await import(distFile('adapters/embeddings/rerank.js'));
      options.rerank = async (documents) => {
        const result = await rerankPassages({ pythonPath, workspaceRoot: WORKSPACE, modelDir: join(WORKSPACE, '.kb/models/bge-reranker-base'), query, documents });
        return result.ok ? result.scores : undefined;
      };
    }
    if (useExpand !== 'none') options.expand = useExpand;
    if (glossary !== undefined) options.glossary = glossary;
  if (rerankBlend !== undefined) options.rerankBlend = rerankBlend;
  if (rerankPool !== undefined) options.rerankPool = rerankPool;
  if (hybridWeight !== undefined) options.hybridWeight = hybridWeight;
  if (useNotesLayer) { options.notesLayer = true; options.notesLimit = notesLimit; }
  if (mode === 'hybrid') {
      const vector = await embedQuery({ pythonPath, workspaceRoot: WORKSPACE, modelDir: embeddingModel, text: query, threads: 8 });
      if (vector !== undefined) options.queryVector = vector;
    }
    const result = await runQuery(fs, query, topK, options);
    const item = { query, path, truth, topic, alt, terms };
    const scores = evaluate(item, result.hits, pageTextOf);
    rows.push(scores);
    const top = result.hits.slice(0, 3).map((hit) => (hit.path.split('/').pop() ?? '') + ' p.' + hit.page + (hit.pageEnd ? '-' + hit.pageEnd : ''));
    detail.push({ query, ok: scores.page5 === 1, ranks: top, firstPage: scores.firstPage, ms: result.elapsedMs, reranked: result.reranked === true });
    if (verbose) console.log(' ', scores.page5 ? 'Y' : 'n', query, '->', top.join(' | '));
  }
  const elapsed = Date.now() - startedAt;
  const summary = summarize(setName, rows, elapsed);
  console.log(formatSummary(summary));
  report.sets[setName] = { summary, items: detail };
}
if (outPath !== '') {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log('wrote', outPath);
}
