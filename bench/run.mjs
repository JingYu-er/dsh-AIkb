import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
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
const topK = Number(value('topk', '8'));
const outPath = value('json', '');
const verbose = flag('verbose');

const fs = { root: ROOT, exists: async (rel) => existsSync(join(ROOT, rel)), readText: async (rel) => readFileSync(join(ROOT, rel), 'utf8') };

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

const config = { set: setNames, mode, multi: useMulti, rerank: useRerank, expand: useExpand, topK };
console.log(JSON.stringify(config));

const report = { config, sets: {} };
for (const setName of setNames) {
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
  if (rerankBlend !== undefined) options.rerankBlend = rerankBlend;
  if (rerankPool !== undefined) options.rerankPool = rerankPool;
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
