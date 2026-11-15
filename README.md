# dsh-kb

An Obsidian-native knowledge base plugin for DeepSeek Harness.

**It is a compiler, not a retriever.** A retriever answers and forgets; a
compiler turns sources into structured, interlinked pages that get better every
time you use them. The AI is an indexer, a first-pass filter and a cognitive
auditor — never the engineer who reads the textbook for you.

## Status

MVP read path and the compile loop are implemented and tested (87 unit tests):

| Tool | Purpose |
| --- | --- |
| `kb_doctor` | Vault discovery, layout and permission self-check. |
| `kb_inventory` | Hash-index every binary source into `.wiki/books.jsonl`. |
| `kb_ingest` | Page-anchored chunking + incremental local index; also harvests bilingual term pairs into `.wiki/index/glossary.json`. |
| `kb_query` | BM25 retrieval with path / page / section provenance (CJK bigrams, domain glossary, device-name scoping, coverage weighting, chapter weighting, edition-family cap). Returns optional page windows and section context; hybrid vectors fill the tail slots. |
| `kb_embed` | Local e5-small vectors over the chunk index, incremental per book. |
| `kb_lint` | Read-only note hygiene: broken wikilinks, duplicate titles, orphan concept pages, missing frontmatter/type. |
| `kb_compile` | Compile inbox drafts: resolve title/type, lift `sources:` and wikilinks, normalise H1 and blank lines; writes `inbox/_compiled/`, idempotent via `compiledHash`. |
| `kb_promote` | Promote compiled drafts into the configured `promoteDir` with a line diff; confirm-gated, never overwrites without `force`. |
| `kb_suggest_links` | Read-only link candidates between notes that share rare terms, with a reason and a confidence. |

Writes are off by default and, when enabled, are confined to `inbox/`, `.wiki/`,
and the `promoteDir` you configure for `kb_promote`. Nothing else in the vault is
modified.

## Requirements

- Node >= 22
- A Python 3.9+ interpreter on `PATH` (only to create the private venv). You do
  **not** need to install PyMuPDF yourself: the first `kb_ingest` creates
  `<workspaceRoot>/.kb/venv` and installs PyMuPDF into it through a mirror, then
  reuses it. `kb_doctor` only probes, it never installs.
- Optional hybrid search: `kb_embed` creates the same kind of private environment
  on first use — it installs `tokenizers`/`onnxruntime` and downloads the
  multilingual-e5-small ONNX model (~130 MB) into
  `<workspaceRoot>/.kb/models/`. Everything runs locally; no model API, no tokens.
- Optional reranking: `kb_query` can reorder its candidates with a local
  bge-reranker-base cross-encoder (279 MB quantized, same private venv, downloaded
  on the first reranked query). Off by default: it costs ~1.5–2 s per warm query
  (the first one also loads the model) and it helps Chinese questions far more
  than English ones — see [Retrieval quality](#retrieval-quality).
- A vault: a directory containing `.obsidian/`

(EPUB/DJVU parsers are not wired yet; `kb_ingest` reports them as errors.)

## Install (local, development)

1. Build:

   ```bash
   cd dsh-kb
   npm install --ignore-scripts
   npm run build
   ```

2. Register the plugin in your DSH profile (`~/.dsh/profiles/<profile>/package.json`):

   ```jsonc
   {
     "dependencies": { "dsh-kb": "link:D:/path/to/dsh-kb" },
     "dsh": { "profile": { "bundles": [/* ..., */ "dsh-kb"] } }
   }
   ```

3. `pnpm install` in the profile, then restart DSH.

Configure the machine-specific parts in the profile's `cordis.patch.yml`
(the vault path has no sane default, so it is never shipped):

```yaml
- id: dsh-kb
  name: dsh-kb
  config:
    vaultPath: D:/path/to/MyObsidian
    workspaceRoot: D:/path/to/workspace   # venv lives in <workspaceRoot>/.kb/venv
    allowWrites: true                     # required for kb_ingest / inventory / compile / promote
    # optional:
    pythonPath: python                    # base interpreter used to create the venv
    venvPath: D:/path/to/venv             # override the venv location
    pythonMirror: https://pypi.tuna.tsinghua.edu.cn/simple
    pythonLibPath: D:/path/to/pylib       # extra PYTHONPATH for a system PyMuPDF
    ocrEnabled: true                      # local OCR for scans (default on)
    ocrWorkers: 4                         # OCR processes; 4 beat 8 on a 16-core box
    ocrMaxPages: 40                       # first experiment: only the first N pages
    embedEnabled: true                    # hybrid search (default on)
    embedModelDir: D:/path/to/e5-small    # default <workspaceRoot>/.kb/models/multilingual-e5-small
    embedModelUrl: https://hf-mirror.com/Xenova/multilingual-e5-small/resolve/main
    glossaryExpansion: false              # widen queries with harvested pairs (measured neutral; off)
    rerankEnabled: false                  # cross-encoder rerank every query (default off)
    rerankModelDir: D:/path/to/bge-reranker-base   # default <workspaceRoot>/.kb/models/bge-reranker-base
    rerankModelUrl: https://hf-mirror.com/Xenova/bge-reranker-base/resolve/main
    promoteDir: 学习/笔记/收件箱            # kb_promote destination (vault-relative); unset = off
```

## Usage

```text
kb_doctor                                  # is this vault readable?
kb_inventory { write: true }               # hash every PDF
kb_ingest   { limit: 3 }                   # first three books
kb_embed    { limit: 5 }                   # local vectors over the index (incremental)
kb_query    { query: "镜像电流源 原理" }     # hits with page + section
kb_query    { query: "…", expand: "section" }  # + page window and whole-section context
kb_query    { query: "…", rerank: true }        # + cross-encoder reorder (slower, fixes page drift)
kb_lint                                    # broken links / orphans / frontmatter
kb_compile  { dryRun: true }               # preview inbox drafts -> inbox/_compiled/
kb_promote  { limit: 3 }                   # diff preview; add confirm:true to write
kb_suggest_links { note: "学习/硬件/笔记/结电容.md" }   # candidate [[links]] (read-only)
```

## Agent skill

The plugin ships one agent skill, `kb-search`, under
[`skills/kb-search/SKILL.md`](skills/kb-search/SKILL.md). It is loaded by the
skill filesystem provider declared in `cordis.patch.yml`, so it appears in the
agent's skill catalog as `kb-search` after DSH restarts.

The skill does not change retrieval — it changes how the agent asks. It says to
decompose a question into 3–8 high-signal terms and pass the alternative
phrasings of one question (English translation, another name, an abbreviation)
as `queries: [...]` in a single call, where the lists are fused by rank; one
long mixed-language sentence still dilutes the BM25 coverage factor. It then
merges hits by `path` + `page`, widens only one or two hits with
`expand: "section"`, drops index pages and near-empty pages, and always cites
`path p.N` (or `p.N–M`). It also states the measured baseline (topic 26/26,
right book 20/26, exact page 11/26) so the agent knows that the book and chapter
are reliable while the page number may drift.

## Retrieval quality

Measured on the author's vault: 176 indexed books (3 of them OCR'd scans), 23,655
page-anchored chunks, 26 questions (15 tuned, 11 held out). Truth pages come from
raw PyMuPDF text search, never from the retrieval system itself. `topK = 8`, warm
in-process index. Both question sets live in `bench/sets/`; `npm run bench --
--set all` reproduces the rows below, with `--multi`, `--rerank`, `--mode hybrid`
and `--expand` as switches.

- **page@5** — a top-5 hit lands in the truth book within ±2 pages.
- **near@5** — within ±10 pages (the answer is on the neighbouring spread).
- **book@5** — the right book even when the page drifted.
- **window@5** — the truth page falls inside the returned section window
  (`page`…`pageEnd`).
- **topic@8** — any hit from the right book family.

| Set | page@5 | near@5 | book@5 | window@5 | topic@8 | MRR |
| --- | --- | --- | --- | --- | --- | --- |
| Tuned (15) | 6/15 | 7/15 | 12/15 | 7/15 | 15/15 | 0.20 |
| Held out (11) | 5/11 | 6/11 | 8/11 | 5/11 | 11/11 | 0.21 |
| All (26) | 11/26 (42%) | 13/26 | 20/26 (77%) | 12/26 | 26/26 | 0.20 |
| All + rerank | 12/26 (46%) | 14/26 | 19/26 | 14/26 | 26/26 | 0.30 |
| All + fused | 14/26 (54%) | 16/26 | 21/26 | 14/26 | 26/26 | 0.34 |

The rerank row is `rerank: true` on top of plain BM25 (`page@1` goes 2/26 →
5/26 and `page@8` 12/26 → 14/26; it also beats hybrid without rerank). It costs
~2.4 s per warm query, which is why it stays off by default. Reranking hybrid
results is worse than reranking BM25 alone (MRR 0.19 vs 0.30), and truncating
pairs at 512 instead of 128 took 31 s/query for MRR 0.16 — both variants are
disabled on purpose.

The fused row is the same query plus its English translation passed as
`queries: [...]` (2–6 phrasings, one BM25 ranking each, fused by reciprocal
rank): `page@1` 2/26 → 5/26, `page@8` 12/26 → 14/26, and it costs ~0.4–0.7 s
because every phrasing runs its own search. Fusion also fills every slot, so
vector hits are skipped entirely. Combining fusion with rerank is worse than
either alone (13/26, MRR 0.27): the cross-encoder re-imposes the single-page
preference that the phrasings had just widened. English questions lose instead of
gain (page@1 13/17 → 10/17, page@5 16/17 → 13/17, MRR 0.85 → 0.67), because an
English restatement adds vocabulary the textbook already uses — use one English
query there.

Hybrid retrieval (BM25 + e5-small) adds one page@8 and one window hit and nothing
above: vector hits occupy at most the last `floor(topK × 0.25)` slots. The index
is cached per vault in the process, which took a query from 3.6 s to ~0.45 s warm
(the first query in a fresh process still pays the build).

### English books

The same harness over five open-licensed English textbooks (*Lessons in Electric
Circuits* vols 1–4, *OpenStax University Physics* vol 2): 2,987 pages, 3,369
chunks, 17 questions whose truth pages were verified against the PDF text layer.

| Set | page@1 | page@5 | near@5 | book@5 | MRR |
| --- | --- | --- | --- | --- | --- |
| BM25 (17) | 13/17 | 16/17 | 17/17 | 17/17 | 0.85 |
| BM25 + rerank | 8/17 | 13/17 | 15/17 | 17/17 | 0.60 |

English textbook prose repeats the query terms, so lexical retrieval already lands
the right page; the cross-encoder then collapses a discussion that spans several
pages onto the single page it scores highest (Norton → the next section,
common-emitter → feedback) and loses page hits. Rank fusion loses for the same
reason: the English keyword-style second phrasing pulls the list toward pages
that merely list the terms (page@5 16/17 → 13/17). Keep `rerank: true` and
`queries: [...]` for Chinese questions with vocabulary drift, not for English
ones: at 512 tokens rerank also lost page hits, so this is not a truncation
artifact.

### Performance and memory

- Cold start: the first query in a fresh process builds the index in ~6 s for
  27,024 chunks (181 books); warm queries are ~0.4 s. Four concurrent queries in
  one process serialize to ~1.1 s total (the scan runs on the event loop, not a
  thread pool); four separate processes each pay the cold build (~8.7 s under CPU
  contention).
- Memory: the in-process index and vectors are ~600 MB RSS; four parallel CLI
  processes are ~2.4 GB.
- A warm rerank adds 1.2–2.2 s per query (the first reranked query in a process
  also loads the 279 MB model, ~5–8 s). The Python worker exits with its host,
  including a hard kill, through a parent-pid watchdog — it cannot leave a 600 MB
  process behind.

Growing the corpus to 176 books costs exact-page precision (near-duplicate
textbooks and manuals compete) but never loses the topic. Hits are capped at two
per book and three per edition family, so one book or one edition cannot fill the
list. Chapter weighting (a hit inside a section whose title matches the query
scores higher) and edition-family detection both derive from the existing index,
so old corpora get them without re-ingesting a single PDF.

Known gaps and measured negative results:

- Page drift inside the right book is the dominant error: the content is in the
  right chapter, the page is 5–30 off. Section windows (`expand: "section"`) exist
  for this; headings are recovered from page text for the 73 books without a PDF
  outline (the three OCR'd textbooks among them).
- Harvested bilingual pairs (`.wiki/index/glossary.json`) are **not** used to
  widen queries by default. On this 26-question set, expanding with all 4,000
  pairs lost five page hits (11/26 → 7/26): datasheet tables teach wrong pairs
  ("通用定时器 → TIM3"). Frequency-gated pairs were neutral (11/26). Set
  `glossaryExpansion: true` only for a library that mixes Chinese questions with
  English books.
- A question whose answer spans a whole chapter still needs `expand: "section"`
  (or reading the neighbouring pages): the index ranks pages, not chapters.

## Design

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the DDD layering, the
bounded contexts and the generalization contract, and
[docs/TOOLS.md](docs/TOOLS.md) for the tool contracts and error codes.

Hard boundaries, enforced in code rather than in prompts:

- No inference of what you have mastered — only explicit markers.
- Links are proposed with a `why`, never written automatically.
- Sources are referenced (sha256 + locator), never copied into the vault.
- Formula semantics, circuit topology and OCR output are never claimed correct.
- Scanned books are read locally (RapidOCR, no tokens) only when the text layer is
  too thin; OCR text is approximate and must be checked against the page image.

## License

MIT © 2026 JingYu
