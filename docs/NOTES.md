# Development notes

Running log of what was tried, what it cost, and what it taught us. README's
"Known gaps" keeps the standing conclusions; this file keeps the path to them
(including the dead ends) so the same experiment is not repeated.

Conventions: newest first. Each entry says what changed, the measured numbers,
the decision, and how to reproduce. Benchmarks come from `bench/run.mjs`
(BM25 unless a flag says otherwise); `page@5` is a hit within ±2 pages.

---

## 2026-11-16 — notes retrieval quality: field weighting, hub penalty, vectors, rerank

**Problem.** The query-time notes layer (`a680f0e`) put the right note in the top five for 9 of 11
`bench/questions-notes.jsonl` questions (MRR 0.35), but the two misses were systematic: "Obsidian
命令行工具…" landed on `TypeScript.md`, "Templater 的笔记属性模板…" on the 54 KB root note. Both
target notes carry their value in the title/frontmatter and a short body, and both were outranked by
notes that merely repeat the query terms. Flat BM25 over ~600-character blocks cannot tell a title
from a paragraph, and a sprawling note wins on term frequency alone.

**Changes.** Four switches, all inside the notes layer; every one is visible in `kb_query`'s schema,
its rendered header and its JSON `notes` object (`notesWeight`, `notesHubPenalty`, `notesEmbed`,
`notesRerank`, `notesRerankBlend`; bench: `--notes-weight`/`--no-notes-weight`, `--notes-hub`,
`--notes-embed`, `--notes-rerank`).

1. **Field-weighted BM25** (`notesWeight`, default on). Each block is scored as three fields — title
   (filename plus frontmatter `title`/`标题`/`aliases`/`tags`/`name`) ×3, ATX heading ×2, body ×1 —
   by summing the weighted term frequencies into one BM25 formula whose length normalisation uses the
   same weighted length. A literal title-token hit multiplies the block score by 1.1. No token
   repetition, so a long note is not inflated. Frontmatter-only notes (e.g. `Templater-笔记属性.md`)
   now get a placeholder block and become findable; before, they were dropped for having no body.
2. **Hub penalty** (`notesHubPenalty`, default 0.5; `0` disables). A note with more than 20,000 body
   characters or more than 40 wikilinks has its block score multiplied by 0.5 after BM25. Demoted,
   never excluded: a big note can still win on a genuinely specific match.
3. **Note vectors** (`notesEmbed`, default off). `src/application/notes-vectors.ts` embeds the 2,996
   note blocks with the provisioned multilingual-e5-small through the existing `embedChunkFiles` job
   adapter and caches `.wiki/index/notes-vectors.{json,vec}` (4.4 MB) under a corpus hash; a note edit
   changes the hash and rebuilds. The dense signal reorders the lexical candidates as
   `0.6 × BM25/best + 0.4 × cosine`.
4. **Rerank** (`notesRerank`, default off). The top 20 note candidates go through the existing
   `rerankPassages` (bge-reranker-base) with the same blend shape as the book path (`0.3` lexical by
   default).

**Numbers.** `node bench/run.mjs --set notes` (11 questions). `ms` is `runQuery` elapsed after the
first query: the first query pays ~6 s of note-index build, and `--notes-embed` pays another ~30 s
once to build the matrix. The bench-side query embedding (~2.0 s per query, a fresh Python process)
is **not** in that column; the tool pays it inside `kb_query`.

| configuration | hit@5 | MRR | ms/query |
| --- | --- | --- | --- |
| books only (notes layer off) | 0/11 | 0 | — |
| flat notes, control (HEAD) | 9/11 | 0.355 | 72 |
| field weighting only | 9/11 | 0.364 | 68 |
| hub penalty only | 9/11 | 0.355 | 89 |
| field + hub (new default) | 9/11 | 0.364 | 72 |
| vectors only | 9/11 | 0.355 | 92 |
| field + hub + vectors | 10/11 | 0.382 | 127 |
| rerank only | 9/11 | 0.386 | 1256 |
| field + hub + rerank | 10/11 | 0.367 | 1153 |
| field + hub + vectors + rerank | 10/11 | 0.409 | 907 |
| field + hub + vectors, limit 8 | 10/11 | 0.382 | 81 |

**Decision.** Field weighting and the hub penalty are the new defaults: no extra process, +0.01 MRR,
and they fix the Templater question. Be honest about the trade: pure field weighting also pushes the
康华光 差模 question out of the top five (rank 4 → outside), which the vector layer puts back at rank 4
— that is why the two cheap defaults score 9/11 while field + vectors scores 10/11. The hub limb
changes nothing measurable on this vault (only 3 notes exceed 20k characters and no note exceeds 40
wikilinks) but it is the guard for the 54 KB root note, so it stays at 0.5.

Vectors and rerank stay **off by default**, and by the stated bar they are **not worth it**: +1
question and +0.03–0.05 MRR for ~1–2 s per query, nowhere near the 0.35 → 0.5+ that would justify
turning them on for every page query. The best measured combination (field + hub + vectors + rerank,
10/11, MRR 0.41, ~3.1 s added) is kept as an opt-in for callers that can afford it.

**The two misses.** Templater is fixed (the frontmatter-only note now ranks 3rd). The Obsidian CLI
question is still a miss in every configuration, and the diagnosis is worth keeping: the target
`copilot/skills/obsidian-cli/SKILL.md` has an English body and a frontmatter `name: obsidian-cli`,
and the Chinese question shares exactly one token (`obsidian`) with it. It never enters the lexical
top 20 — so it is not even a rerank candidate — and a full-corpus cosine puts it at rank 191 (0.849
against 0.90 for `Obsidian文档.md`). The lever is cross-lingual query expansion (命令行 → command
line) or a stronger embedder, not more ranking on the same candidates.

**Control.** With `notesWeight: false, notesHubPenalty: 0` the notes layer reproduces HEAD's hit list
byte for byte (path, page, section, score, excerpt; compared by dumping `runQuery` output from a
worktree at HEAD). The only new output is the `notes` summary object in `kb_query`'s report, which
says which switches were active. Books are unchanged: `--set zh` page@5 11/26, MRR 0.18; `--set zh2`
page@5 9/12, MRR 0.57.

**Reproduce.**
```bash
node bench/run.mjs --set notes --notes-layer --no-notes-weight --notes-hub 0   # flat control
node bench/run.mjs --set notes --notes-layer                                   # defaults: field + hub
node bench/run.mjs --set notes --notes-layer --notes-embed                     # + vectors (builds cache once)
node bench/run.mjs --set notes --notes-layer --notes-embed --notes-rerank       # best measured
node bench/run.mjs --set zh ; node bench/run.mjs --set zh2                      # books must not move
```

---

## 2026-11-16 — vault notes in retrieval: ingest vs a query-time layer

**Problem.** `kb_query` only searched the 181 indexed PDFs (27,073 chunks). The
vault's 539 notes were invisible even though the notes are often the fastest
answer (a derivation, a decision, a summary of a paper). Two ways to fix it:
make markdown source documents, or search notes at query time and merge them
into the hits.

**Method.** New `bench/questions-notes.jsonl`: 11 natural Chinese questions whose
answer is a real note (I2C START/STOP, capacitor dielectrics, Sallen-Key, a
paper note, convolution, Templater, a journal entry, a book note, LTspice power
planes, a textbook note), spanning 学习/ 论文/ copilot/ 砖块/ 随记/ 读书/ 项目/.
`bench/run.mjs --set notes` asks with `topK: 5` and scores hit@5 / MRR by note
path (`path` equals or ends with the expected path).

**Approach 1 — markdown as sources (reverted).** Add `'md'` to
`SOURCE_EXTENSIONS` (skip `inbox/`), a `src/adapters/md/markdown.ts` that turns
each ATX heading section into a "page", and an extractor dispatch in
`kb-ingest.tool.ts`; notes bypass the scan heuristic. 539 notes → 2,003 chunks
(266 K tokens, no embedding). Notes: **hit@5 8/11, MRR 0.64**. The note chunks
join the same BM25 corpus, and the books pay for it:

| set | before (PDF-only index) | after (539 notes ingested) |
| --- | --- | --- |
| zh BM25 | page@5 11/26, MRR 0.18 | page@5 10/26, MRR 0.16 |
| zh rerank | page@5 15/26, MRR 0.28 | page@5 14/26, MRR 0.25 |
| zh2 BM25 | page@1 6, page@5 9/12, MRR 0.57 | page@1 5, page@5 8/12, MRR 0.53 |
| zh2 rerank | page@5 8/12, MRR 0.60 | page@5 7/12, MRR 0.51 |

The note itself is a small document: it raises the corpus size and shifts IDF,
and per-book caps let two chunks of the same note fill top slots (e.g.
`电容分类.md p.4` twice). Reverted the inventory/doctor/ingest/adapter changes
and restored the index from `.wiki/index.bak-before-notes`; the 8/11 result is
what the old index would have given.

**Approach 2 — query-time note layer (kept, off by default).**
`src/application/notes-layer.ts` chunks every vault `.md` (skipping dot dirs,
`node_modules`, `inbox/`, `templates`) by heading into ~600-character pieces,
scores them with the existing BM25 (`src/domain/bm25.ts`, k1 1.5 / b 0.75),
keeps the best chunk per note and normalises scores to the best note. `kb_query`
gains `notesLayer` and `notesLimit` (default 5); with the flag on, note hits are
merged into the book hits by normalised score, each carrying `kind: 'note'`.
Notes can therefore outrank a vague book page, but book order among themselves
and the `page` field never change. Without the flag the code path is untouched.

| notes set (11) | hit@5 | MRR | avg |
| --- | --- | --- | --- |
| no notes at all | 0/11 | 0.00 | 421 ms |
| approach 1 (ingest) | 8/11 | 0.64 | 519 ms |
| approach 2, limit 3 | 8/11 | 0.34 | 486 ms |
| approach 2, limit 5 | 9/11 | 0.35 | 486 ms |

Approach 2 misses the same two hard cases as approach 1: the Obsidian-CLI
question returns `TypeScript.md` (BM25 has no idea the question is about a
skill file under `copilot/`), and the Templater question returns the 54 KB
root note that mentions every tool. With the layer on, books are displaced
from the top-K (note hits occupy slots near the front):

| books, layer ON (limit 5) | before | after |
| --- | --- | --- |
| zh BM25 | page@5 11/26, MRR 0.18 | page@5 6/26, MRR 0.12 |
| zh rerank | page@5 15/26, MRR 0.28 | page@5 9/26, MRR 0.20 |
| zh2 BM25 | page@5 9/12, MRR 0.57 | page@5 7/12, MRR 0.54 |
| zh2 rerank | page@5 8/12, MRR 0.60 | page@5 7/12, MRR 0.60 |

**Decision.** Keep approach 2 only; `notesLayer` stays **off by default** and
`notesLimit` defaults to **5**. Ingesting notes trades ~1 book page hit and
0.02–0.09 MRR permanently, and finds fewer notes than the layer (8 vs 9 of 11).
The layer costs nothing when off, finds 9/11 when a caller asks for notes, and
its `kind` field lets a caller keep book and note hits apart. Turning it on is
a deliberate trade: note recall at the cost of book page@5 (zh 11→6, rerank
15→9), because normalised note scores place strong note matches near the front.
Both at once is not worth it — approach 1 is reverted, and with it the note
corpus no longer competes inside the book index.

**Reproduce.**
```sh
node bench/run.mjs --set notes                                  # 0/11
node bench/run.mjs --set notes --notes-layer --notes-limit 5    # 9/11, MRR 0.35
node bench/run.mjs --set notes --notes-layer --notes-limit 3    # 8/11, MRR 0.34
node bench/run.mjs --set zh  --notes-layer --notes-limit 5      # book displacement
node bench/run.mjs --set zh2 --notes-layer --notes-limit 5
```
The index backup used to undo approach 1 stays at
`.wiki/index.bak-before-notes` (137 MB); `.wiki/books.jsonl` was regenerated
from the PDF-only inventory (207 entries, 181 ingested).

## 2026-11-16 — where the drift actually lives (section audit)

**Audit.** 181 books, 22,573 pages. PDF-outline headings cover 16,537 pages; the
page-head recovery covers only 374 of the 5,813 pages in the 73 books without an
outline. Chapters (runs of an equal heading) number **7,894, of which 5,435 (69%)
are one page** — outline entries go as deep as "6.2.3", so every heading change
starts a "chapter" and `expand: "section"` returns a single page for most books.
Reproduce: `node temp/section-audit.mjs`.

**Experiment 1 — chapter depth.** Start a new chapter only when the heading depth
is at most N, so "6.2.3 …" stays inside "6.2 …". Depth 2: zh page@5 11→9,
MRR 0.20→0.18 (worse); zh2 unchanged but book@5 11→12. Depth 3: identical to
baseline everywhere. Reverted — chapter weighting shifts through the broader
titles, the page never moves.

**Experiment 2 — rerank blend sweep.** blend 0.2: zh page@5 14/26, MRR 0.29
(worse than 0.3). blend 0.5: zh book@5 21→22 and ndcg 0.374→0.380, but zh2
page@1 7→5 and MRR 0.60→0.52. Keep 0.3.

**Conclusion.** Page drift is not a grouping problem: the chapter structure
already exists, and re-cutting it changes ranking without moving pages. The only
lever that moved page metrics is the cross-encoder, which is already on. Remaining
options, cheapest first: (a) answer at chapter level and read with
`expand: "section"`; (b) improve per-page text (layout-aware block order in OCR)
— expensive, needs an A/B; (c) learn a page selector from labelled queries —
overfits the 38 questions available today.

## 2026-11-16 — intra-chapter page picking: implementable, but inert

**Question.** Page drift (right chapter, page off by 5–30) is the dominant error.
If a hit's chapter is known, could we re-aim it at the page inside that chapter
that covers the most query terms?

**What was tried.** After ranking, for every selected hit with a chapter, score
each page of `chapters[i].start..end` by how many distinct query tokens it
contains (tie → the page closer to the original), and report that page/excerpt.
Chapters longer than 40 pages were skipped. Exposed as `chapterPick: true` plus
`bench/run.mjs --pick`, measured with and without rerank.

**Measured.** zh: 2/11/12, MRR 0.20 (identical to baseline). zh2: 6/9/9,
MRR 0.57 (identical). With rerank: zh 4/15/16 MRR 0.30, zh2 7/8/8 MRR 0.60 —
again identical. Instrumenting the zh2 set showed the pass *does* fire: 6 of 12
queries had pages shifted, always by 1–5 pages (e.g. KCMR 352→351, 303→302).

**Decision.** Revert. The shifts are real but stay inside the ±2 tolerance, so
the metric cannot see them; drift of 5–30 pages therefore crosses section
boundaries, not pages within one section. The lever is chapter/section
boundaries (or rerank), not intra-chapter selection.

**Reproduce.** `node bench/run.mjs --set zh2 --pick` (before the revert) or
`temp/pick-diff.mjs`, which diffs pages with and without the option.

---

## 2026-11-16 — auto-embed on ingest, and index health in kb_doctor

**What changed.** `kb_ingest` now runs the incremental vector pass for the books
it just wrote (shared code in `src/tools/embed-runner.ts`, used by `kb_embed`
too), reported as `embed`. `kb_doctor` gained an `index` section: cache size
and mtime, catalog vs chunk files, orphan/missing chunk files, empty sources, and
vector sidecars vs chunk counts.

**Measured.** One 299-chunk book: 70.7 s (≈0.24 s/chunk); a no-op pass is 38 ms.
First run of the old all-pending pass took 350 s for 3 books, which is why the
auto pass is restricted to this ingest's shas. `kb_doctor` on this vault:
181 sources / 27,022 chunks / 181 chunk files / 181 vector files, 0 missing,
0 stale.

**Gotcha.** `NodeVaultFs.listFiles()` walks with `entry.name.startsWith('.')`
skipped, so `.wiki/` never appears in it; the doctor needed a real
`listDir()` to see the index.

---

## 2026-11-16 — recovered page-head headings in the searchable text: neutral

**What changed.** For the 73 books without a PDF outline, `sectionOf()` already
recovers a heading from the page top for windowing, but `documentTextOf` only
repeated `chunk.section` (outline only). The experiment repeated the recovered
heading as well, so chapter titles became searchable for those books.

**Measured.** zh: book@5 20/26 → 19/26; zh2: book@5 11/12 → 12/12; every page
metric and MRR unchanged; en/en2 unchanged.

**Decision.** Revert. A wash, and it made one metric worse. Lesson recorded:
the chapter index already exists via `sectionOf`; the gap is not "no chapter
signal".

---

## 2026-11-16 — PP-OCRv4, and the full re-OCR of the three scans

**Why.** v3 read 放太/性熊/王程 where the page says 放大/性能/工程. A higher
render DPI fixed the characters but hurt retrieval (zh2 page@5 9→8, MRR 0.58 →
0.57) and cost 20–50 s/page, so the recogniser was the lever, not the DPI.

**What changed.** `ensureOcrModel()` fetches `ch_PP-OCRv4_rec_infer.onnx`
(10.8 MB, hf-mirror) into `<workspace>/.kb/models/ocr` on first use; the OCR
script takes `--rec-model`; `kb_ingest` reports `ocr.model`. Falls back to the
bundled v3 graph when the download fails.

**Measured (200 dpi).** p1 王程 2→0, 工程 0→2; p284 放太 1→0, 性熊 1→0,
放大 4→5, 性能 0→1. Retrieval: zh2 page@5 9/12, MRR 0.575 — flat, as expected
(the truth pages already contained the answer terms).

**Full re-OCR.** 1,434 pages in 3.6 h at `--workers 4 --threads 4`; re-ingest
reuses the journal (5.0/8.0/1.6 s per book). Cache invalidation worked because
of `sourceTextHash` (cold rebuild 6.4 s, then ~0.5 s).

**Threading gotcha.** ONNX Runtime gives every session all physical cores, so
four workers each grabbed the whole machine and the first full run wrote zero
pages in 13 minutes. `--threads` replaces
`rapidocr_onnxruntime.utils.SessionOptions` with a subclass that sets
`intra_op_num_threads`; measured on 10 pages: 4×4 = 130 s, 2×6 = 140 s,
1×0 = 170 s.

**Path gotcha.** The journal must live in `<workspaceRoot>/temp/ocr/<sha>.jsonl`.
A first run wrote it under the vault and then "resumed" from the old v3 journal,
finishing in seconds with the wrong text — always delete/back up a journal when
switching recognisers.

---

## 2026-11-15 — cache invalidation by content, not by hash

**Problem.** Re-OCR changes the text but not the source sha256 or the chunk ids,
so the on-disk cache validated the old postings as current and the index
silently kept stale text.

**Fix.** `FORMAT_VERSION` 1→2; every cached source records
`sourceTextHash(chunks)` = sha256 over `id|text|` in build order; both the exact
cache hit and `seedFromCache` compare it. Cost: ~0.2 s of hashing per cold
start (0.7 s → 0.9 s).

---

## 2026-11-15 — figure captions as chunks: rejected

1,308 captions from the three scans (regex `图 X.Y` + following lines),
injected as extra chunks: page@1 5/10 → 5/10, page@3 8/10, MRR 0.613 → 0.617,
zh2 unchanged. The captions already sit in the page text; a duplicate chunk only
adds index size (55.9 K tokens).

---

## 2026-11-14 — retrieval baseline and the rerank trade-off

- zh (26 questions): page@1 2, page@5 11, MRR 0.20; zh2 (12): 6/9/9, MRR 0.57.
- rerank (bge-reranker-base, blend 0.3): zh page@5 11→15, MRR 0.20→0.30; zh2
  page@1 6→7, page@5 9→8, MRR 0.57→0.60; +1.3–1.9 s per query. Enabled in the
  local config (`rerankEnabled: true`); the code default stays off.
- `queries: [...]` fusion (alternative phrasings): zh2 MRR 0.57 → 0.43. Do not
  default it; pass it only when the synonyms are known to be good.
- glossary expansion: 26-question page hits 11 → 7 (datasheet tables teach wrong
  pairs). Off by default.

---

## Pitfalls that cost time (quick list)

- **The plugin process runs the dist it loaded at boot.** After `npm run build`,
  a running DSH keeps calling the old code; restart it, or drive the tools
  through `temp/tool-cli.mjs` / `temp/ingest-cli.mjs`.
- **`kb_ingest` with a journal present skips OCR.** That is the resume feature;
  it also means "finished in 2 s" usually means "it did not OCR anything".
- **`git commit -m` with backticks** lets the shell run the quoted word
  (``embed`` became an empty string). Use `git commit -F <file>`.
- **Force re-ingesting all 181 books is not a quick experiment** (~1 min/book
  even with text layers; scans reuse journals but still re-extract).
- **`listFiles()` skips dot-directories**, so anything under `.wiki/` is
  invisible to the doctor unless it uses `listDir()`.
- **Bench numbers are CPU-sensitive**: rerank latency roughly doubles while a
  background OCR job is running; compare like with like.