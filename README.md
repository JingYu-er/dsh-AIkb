# dsh-AIkb

> The package id (npm name, plugin loader id, schema prefix) is the lowercase `dsh-aikb` — npm
> forbids uppercase names. Everything a reader sees — the repository [JingYu-er/dsh-AIkb](https://github.com/JingYu-er/dsh-AIkb),
> the docs and the panel title — is **dsh-AIkb**.

An Obsidian-native knowledge base plugin for DeepSeek Harness.

**It is a compiler, not a retriever.** A retriever answers and forgets; a
compiler turns sources into structured, interlinked pages that get better every
time you use them. The AI is an indexer, a first-pass filter and a cognitive
auditor — never the engineer who reads the textbook for you.

## Status

MVP read path and the compile loop are implemented and tested (149 unit tests):

| Tool | Purpose |
| --- | --- |
| `kb_doctor` | Vault discovery, layout and permission self-check; index health (cache age, chunk files vs catalog, vector coverage). |
| `kb_inventory` | Hash-index every binary source into `.wiki/books.jsonl`. |
| `kb_ingest` | Page-anchored chunking + incremental local index; also harvests bilingual term pairs into `.wiki/index/glossary.json`. |
| `kb_query` | BM25 retrieval with path / page / section provenance (CJK bigrams, domain glossary, device-name scoping, coverage weighting, chapter weighting, edition-family cap). Returns optional page windows and section context; hybrid vectors fill the tail slots. |
| `kb_embed` | Local e5-small vectors over the chunk index, incremental per book. `kb_ingest` runs it for the books it just wrote (`embedOnIngest: false` opts out). |
| `kb_lint` | Read-only note hygiene: broken wikilinks, duplicate titles, orphan concept pages, missing frontmatter/type. |
| `kb_compile` | Compile inbox drafts: resolve title/type, lift `sources:` and wikilinks, normalise H1 and blank lines; writes `inbox/_compiled/`, idempotent via `compiledHash`. |
| `kb_promote` | Promote compiled drafts into the configured `promoteDir` with a line diff; confirm-gated, never overwrites without `force`. |
| `kb_suggest_links` | Read-only link candidates between notes that share rare terms, with a reason and a confidence. |
| `kb_index` | Deterministic vault catalog: scan notes and wikilinks, then render `index.md` by type with per-type counts, recent changes, orphans, untyped notes and broken links. `write:true` rebuilds it and appends one `log.md` line. |
| `kb_link_review` | Turn similarity suggestions into SCHEMA-checked link candidates (direction, no duplicate, max 8, confidence ≥ 0.25) and write review queues under `inbox/links/`; never edits formal notes. |
| `kb_link_apply` | Apply queue rows whose `why` was filled in: show a diff, then append `- [[target]] — why` to `## 关联`, back up to `.wiki/backups/` and mark the row `[x]`. Confirm-gated. |
| `kb_review` | Deterministic contradiction candidates: take up to 3 similar older notes, extract conclusion-like paragraphs into `inbox/review/` queues with an empty `判定` column (冲突 / 细化 / 无关); preview by default, never edits notes. |

Writes are off by default and, when enabled, are confined to `inbox/`, `.wiki/`,
the generated `index.md`/`log.md`, and the `promoteDir` you configure for
`kb_promote` plus the notes `kb_link_apply` edits after a diff. Nothing else in
the vault is modified; `.obsidian/` is never touched.

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
   cd dsh-AIkb
   npm install --ignore-scripts
   npm run build
   ```

2. Register the plugin in your DSH profile (`~/.dsh/profiles/<profile>/package.json`):

   ```jsonc
   {
     "dependencies": { "dsh-aikb": "link:D:/path/to/dsh-AIkb" },
     "dsh": { "profile": { "bundles": [/* ..., */ "dsh-aikb"] } }
   }
   ```

3. `pnpm install` in the profile, then restart DSH.

Configure the machine-specific parts in the profile's `cordis.patch.yml`
(the vault path has no sane default, so it is never shipped):

```yaml
- id: dsh-aikb
  name: dsh-aikb
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
kb_index    { write: true }                # rebuild index.md + log.md
kb_link_review { write: true }             # queues in inbox/links/ (why empty = unapproved)
kb_link_apply  { confirm: true }           # apply rows with a why, diff first
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

Measured on the author's vault: 181 indexed books (5 of them OCR'd scans), 27,024
page-anchored chunks, 43 questions in four sets (26 original Chinese, 12 added
Chinese, 17 original English, 5 added English). Truth pages come from raw text
search over the stored chunks, never from the retrieval system itself. `topK = 8`,
warm in-process index. All sets live in `bench/sets/`; `npm run bench -- --set all`
reproduces the rows below, with `--multi`, `--rerank`, `--mode hybrid` and
`--expand` as switches.

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
| All + rerank | 15/26 (58%) | 18/26 | 21/26 | 16/26 | 26/26 | 0.29 |
| All + fused | 14/26 (54%) | 16/26 | 21/26 | 14/26 | 26/26 | 0.34 |

The rerank row is `rerank: true` on top of plain BM25 and keeps 30% of the
lexical rank in the final score (`rerankBlend: 0.3`, the default): `page@5`
11/26 → 15/26, `page@8` 12/26 → 16/26, MRR 0.20 → 0.29 (`page@1` 4/26). A pure
cross-encoder sort (blend 0) scored 13/26 and MRR 0.30: mixing the two buys two
page hits because the cross-encoder otherwise collapses a multi-page discussion
onto the single page it likes best. On the 38 Chinese questions the same setting
keeps 23/38 at `page@5`, versus 21/38 for a pure sort and 20/38 without rerank.
It costs ~2.4 s per warm query, which is why it stays off by default. Reranking
hybrid results is worse than reranking BM25 alone (MRR 0.19 vs 0.30), and
truncating pairs at 512 instead of 128 took 31 s/query for MRR 0.16 — both
variants are disabled on purpose.

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

### Expanded sets: the fusion gain is not general

The first 26 questions were written while fusion was being tuned, so s1 added 12
more Chinese questions from five books the original set never touched (*新概念模拟
电路* detail pages, 童诗白, 康华光, *晶体管电路设计(上)*, *高速数字设计*) and 5
English ones (mesh current, inductive reactance, JFET, CMOS inverter, magnetic
flux). Pages were found by exact phrase search over the stored chunks and verified
by reading the page text afterwards. The new sets also score `term@5`: does the
answer vocabulary ("巴特沃斯", "地弹", "噪声增益"…) appear on one of the top-5 pages.

| Set | page@1 | page@5 | term@5 | MRR |
| --- | --- | --- | --- | --- |
| zh2 BM25 (12) | 6/12 | 9/12 | 11/12 | 0.58 |
| zh2 fused (12) | 4/12 | 7/12 | 11/12 | 0.44 |
| en2 BM25 (5) | 2/5 | 3/5 | 3/5 | 0.44 |
| en2 fused (5) | 3/5 | 3/5 | 3/5 | 0.60 |

Combined over all 38 Chinese questions, fusion moves page@5 from 20/38 (53%) to
21/38 (55%) — it gains 3 on the original 26 and loses 2 on the new 12. Plain BM25
already lands zh2 at 75% page@5 because those questions reuse the textbook's exact
wording; the English translation then pulls in English books and neighbouring
chapters. Treat `queries` as a tool for vocabulary drift, not a default: enable it
when the question's terms do not literally occur in the books (synonyms, translated
product names, a Chinese question about an English chapter). English questions
lose 3 page@5 hits with fusion for the same reason.

### Two variants that did not survive the bench

**Chapter pooling.** Each chunk was multiplied by its chapter's aggregate score
(sum of the chapter's three best chunk scores, normalised to the best chapter).
At strength 0.3 the 26-question set moved page@1 from 2 to 3 and MRR from 0.20 to
0.22, but page@5 stayed 11/26 and zh2 fell from 9/12 to 7/12 (MRR 0.58 to 0.53);
0.8 and 1.5 cost more. Reverted: the chapter is already counted twice, in the
document weight and in the returned window, so a third copy over-rewards long
chapters.

**Coverage gate.** `coverage` is the IDF-weighted share of the question's tokens
that occur anywhere in the index. Fusing only when coverage < 0.85 scores 21/38
page@5 — identical to always fusing — while running the extra searches on 12 of
38 questions; coverage < 0.7 gives 20/38. It is a cost knob, not a quality win, so
it is not an automatic switch. The number is reported so the caller can retry with
the books' terms when it is low.

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
| BM25 + rerank | 12/17 | 15/17 | 16/17 | 17/17 | 0.78 |

English textbook prose repeats the query terms, so lexical retrieval already lands
the right page; the cross-encoder then collapses a discussion that spans several
pages onto the single page it scores highest (Norton → the next section,
common-emitter → feedback) and loses page hits. Rank fusion loses for the same
reason: the English keyword-style second phrasing pulls the list toward pages
that merely list the terms (page@5 16/17 → 13/17). The 30% lexical mix softens
reranking (8/17 → 12/17 at `page@1`) but still ends below plain BM25
(page@5 15/17 vs 16/17, MRR 0.78 vs 0.85). Keep `rerank: true` and
`queries: [...]` for Chinese questions with vocabulary drift, not for English
ones: at 512 tokens rerank also lost page hits, so this is not a truncation
artifact.

### Performance and memory

- Cold start: a fresh process loads the on-disk index cache
  (`.wiki/index/search-cache.bin`, ~49 MB, a v8-serialized inverted index plus
  chunk metadata) in ~0.9 s for 27,024 chunks (181 books); ~0.2 s of that is
  re-hashing each source's chunk text, which is how a re-extraction that keeps
  the same chunk ids is noticed. After an ingest that
  only appends books, the next query reuses the cached prefix and tokenizes just
  the new chunks — 0.49 s versus 2.79 s for a full rebuild on a 60-book probe
  corpus with one new book — then rewrites the cache. A catalog that reorders or
  drops sources, or a cache that fails validation (catalog hash, chunk ids,
  postings size), falls back to a full rebuild (~6 s for 181 books). A cache file
  that fails validation is ignored rather than trusted, so a half-written file
  only costs one rebuild. Warm queries are ~0.3 s. Four concurrent queries in one
  process serialize to ~1.1 s total (the scan runs on the event loop, not a
  thread pool); four separate processes each load the cache (~0.9 s) instead of
  rebuilding.
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
  right chapter, the page is 5–30 off. The contract is therefore **book +
  chapter + page range**: `section` is the chapter title even on continuation
  pages, `pageStart`/`pageEnd` bound it, and `page` is just the entry page. Cite
  `p.N–M` and open the page when the exact wording matters; section windows
  (`expand: "section"`) exist for that. Headings are recovered from page text for
  the 73 books without a PDF outline (the three OCR'd textbooks among them).
- Harvested bilingual pairs (`.wiki/index/glossary.json`) are **not** used to
  widen queries by default. On this 26-question set, expanding with all 4,000
  pairs lost five page hits (11/26 → 7/26): datasheet tables teach wrong pairs
  ("通用定时器 → TIM3"). Frequency-gated pairs were neutral (11/26). Set
  `glossaryExpansion: true` only for a library that mixes Chinese questions with
  English books.
- The three scanned books' text comes from local OCR at 200 dpi (1,434 pages,
  636–732 chars/page). Raising the render DPI is **not** the lever: at 300 dpi
  the recogniser reads 放太/性熊 correctly, but the truth pages already
  contained every answer term, and replacing them in a variant index moved zh2
  page@5 from 9/12 to 8/12 (MRR 0.58 → 0.57); a full re-OCR also costs hours
  (~20–50 s/page). Swapping in **PP-OCRv4**'s recogniser at the same 200 dpi
  does read the scans better — 放太→放大, 性熊→性能, 王程→工程 — while retrieval
  stays flat (zh2 page@5 9/12, MRR 0.575), so v4 is now the default graph: one
  10.8 MB ONNX file fetched on first OCR use, with RapidOCR's bundled v3 graph
  as the fallback when that download fails. The full re-OCR of all 1,434 pages
  (3.6 h at 4 workers x 4 ORT threads; `--threads` caps each session so the
  workers stop fighting over cores) ended with the same numbers — the gain is
  accurate citation text, not a different rank order.
- Figure captions as their own chunks do **not** help. Injecting 1,308
  captions (55.9 K tokens) into a variant index left the figure bench
  unchanged (page@1 5/10, page@3 8/10, MRR 0.613 → 0.617) and zh2 untouched:
  the captions already sit in the page text, so the duplicate chunk only adds
  index size.
- Rerank earns its latency on the larger set: bge-reranker-base takes the
  26-question zh set from page@5 11/26 to 15/26 and MRR 0.20 → 0.30 (+1.2 s per
  query), while zh2 moves page@1 6 → 7 but page@5 9 → 8 and MRR 0.57 → 0.60
  (+1.3 s). The shipped local config enables it; the code default stays off so
  other deployments opt in.
- Fusing an alternative phrasing (`queries: [...]`) hurt here: zh2 MRR
  0.57 → 0.43, because the paraphrases in the set are weaker than the original.
  Use it per call for known-good synonyms, never as a default.
- Indexing the headings recovered from page tops (the 73 books without a PDF
  outline) into the searchable text is **neutral**: zh book@5 20/26 → 19/26,
  zh2 book@5 11/12 → 12/12, every page metric unchanged. Reverted — the chapter
  index already picks those headings up through `sectionOf`, so the remaining
  lever is choosing the right page *inside* the right chapter, not adding
  headings to the text.
- A heavier layout extractor (MinerU / Docling) is **not** worth its footprint:
  on the 12-question set's answer pages, 11/12 chunks already contain every
  answer term, and BM25 is insensitive to formula and table layout — the
  scanned books' text comes from the OCR fallback anyway (a separate gap). A
  modern extractor mainly improves formula/table fidelity for downstream
  reading, not page retrieval, so PyMuPDF stays the only extraction dependency.
- The index has 7,894 chapters but 69% are one page (outline headings reach
  "6.2.3"), so `expand: "section"` is a page for most books. Re-cutting chapters
  by heading depth is neutral-to-negative (depth 2: zh page@5 11→9, MRR 0.20→0.18;
  depth 3: no change), and a rerank blend sweep only traded zh2 against zh. Page
  drift is not a grouping problem.
- Re-aiming a hit at the page inside its chapter with the best query-term
  coverage moves pages (6 of 12 zh2 queries, always 1–5 pages) but changes no
  metric: zh 2/11/12 MRR 0.20 and zh2 6/9/9 MRR 0.57, with and without rerank.
  Reverted — the drift that matters crosses section boundaries, so the lever is
  section detection, not intra-section page choice.
- A question whose answer spans a whole chapter still needs `expand: "section"`
  (or reading the neighbouring pages): the index ranks pages, not chapters.

## Design

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the DDD layering, the
bounded contexts and the generalization contract,
[docs/TOOLS.md](docs/TOOLS.md) for the tool contracts and error codes, and
[docs/NOTES.md](docs/NOTES.md) for the development log — what was tried, what it
measured, and why it was kept, changed or reverted.

Hard boundaries, enforced in code rather than in prompts:

- No inference of what you have mastered — only explicit markers.
- Links are proposed with a `why`, never written automatically.
- Sources are referenced (sha256 + locator), never copied into the vault.
- Formula semantics, circuit topology and OCR output are never claimed correct.
- Scanned books are read locally (RapidOCR, no tokens) only when the text layer is
  too thin; OCR text is approximate and must be checked against the page image.

## License

[Apache License 2.0](LICENSE) © 2026 JingYu
