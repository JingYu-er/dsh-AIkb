# Development notes

Running log of what was tried, what it cost, and what it taught us. README's
"Known gaps" keeps the standing conclusions; this file keeps the path to them
(including the dead ends) so the same experiment is not repeated.

Conventions: newest first. Each entry says what changed, the measured numbers,
the decision, and how to reproduce. Benchmarks come from `bench/run.mjs`
(BM25 unless a flag says otherwise); `page@5` is a hit within ±2 pages.

---

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
