# Tools

All tools are registered by `dsh-kb` into the DSH tool registry. Every tool is
read-only unless explicitly stated, and none of them ever writes outside
`inbox/` and `.wiki/`.

Write scope guard: `NodeVaultWriter` + `openVault().isWritableTarget` reject any
other path with `vault.write-denied`. `allowWrites` defaults to `false` in the
bundled `cordis.patch.yml`.

## kb_doctor

Environment and vault self-check. Safe to call on an unfamiliar vault.

Input: `{ vaultPath?: string }`

Output: `ok`, `error` (code + message), `checks[]` (`.obsidian`, `notes`,
`sources`, `versioning`, `manifest`, `python.pymupdf`), `counts` (notes, sources,
attachments), `byExtension`, `layout` (inbox / .wiki / books.jsonl presence),
`booksManifest` (entries, bytes), `python` (`ok`, `pythonPath`, `source`
configured|venv|system, `venvPath`, `pymupdfVersion`, `errors`), `writesEnabled`,
`versionControl`, `nextActions`.

The Python section is a **probe only**: a missing interpreter is reported as a
warning with the venv path the first `kb_ingest` will prepare; `kb_doctor` never
installs anything.

Never throws: filesystem failures come back as `ok: false` with a stable code.

## kb_inventory

Scan the vault for binary source documents (pdf / epub / djvu) and compute a
content hash for each. This is the ingest ledger; it is what makes ingest
incremental.

Input: `{ vaultPath?: string, write?: boolean, limit?: number }`

Output: `ok`, `sources[]` (`path`, `format`, `bytes`, `sha256`, `modifiedAt`),
`totals` (`sources`, `bytes`, `skipped`), `byFormat`, `manifestPath`,
`written`, `elapsedMs`.

`write: true` requires `allowWrites` and writes `.wiki/books.jsonl`
(`schema: dsh-kb/books@1`, one JSON object per line, sorted by path).

Notes (`.md`) are deliberately excluded: they are already text and are read
directly, not chunked.

## kb_ingest

Parse each inventoried source into page-anchored chunks and build the local
index. Incremental by content hash: a book whose `<sha256>.jsonl` already
exists is skipped unless `force` is set.

Input: `{ vaultPath?: string, limit?: number, pathPrefix?: string, paths?: string[], force?: boolean }`

`paths` names exact inventory entries (relative to the vault) and wins over
`pathPrefix`; `limit` still caps the batch. A source is rejected as `pdf.no-text-layer` instead of writing an empty chunk
file when it has fewer than 200 extractable characters **or** fewer than 15
characters per page (a scan often carries page numbers only, so total characters
alone would let it through). A rejected source also has its previously indexed
chunks removed, so a stale entry cannot keep haunting queries.

Scanned books fall back to local OCR: when the text layer fails that density
gate, the source is rendered at 200 dpi and read by RapidOCR (ONNX, on this
machine), which costs CPU time but no tokens. Paragraphs are rebuilt in reading
order, including a two-column check; pages are journaled per content hash in
`<workspaceRoot>/temp/ocr/<sha256>.jsonl`, so an interrupted run resumes instead
of restarting. `ocrMaxPages` (plugin config) caps a first experiment, and
`ocrWorkers` sets the process count. OCR text is approximate: formulas and
subscripts degrade, so a hit from a scanned book is cited the same way but
should be verified against the page image.

Output: `ok`, `books[]` (`path`, `sha256`, `pages`, `chunks`, `tokens`,
`status`, `ocrUsed?`, `error?`), `totals`, `indexPath`, `elapsedMs`, `python`
(`pythonPath`, `source`, `venvPath`, `bootstrapped`), when OCR was resolved
`ocr` (`pythonPath`, `rapidocrVersion`, `installed`), and `glossary`
(`entries`, `added`). The glossary is a per-vault by-product: bilingual pairs
harvested from the page text ("静态工作点 (quiescent operating point)") are merged
into `.wiki/index/glossary.json`, capped at 4,000 entries and ranked by how many
books use them. Queries do **not** consume it unless `glossaryExpansion` is
enabled (see kb_query).

On first use it prepares its own environment: probes an explicit `pythonPath`, the
private venv, then `python`; if none can import PyMuPDF it creates
`<workspaceRoot>/.kb/venv` and installs PyMuPDF (mirror first, then pypi.org).

Writes only `.wiki/index/chunks/<sha256>.jsonl` and `.wiki/index/catalog.json`
(`schema: dsh-kb/index@1`). A failing book does not abort the batch; the error
is recorded per book.

## kb_query

Search over the local chunk index, returning provenance for every hit. Lexical
(BM25) by default; when `kb_embed` has built vectors, the query is embedded with
the same model and the vector hits fill the tail of the list.

Retrieval is lexical-first, not rank-fused. Reciprocal rank fusion was tried and
rejected: the gaps between adjacent RRF ranks are tiny (1/61 vs 1/62), so a page
that is mediocre in BM25 *and* mediocre in vector space beats the best lexical
page — on this vault that replaced a correct datasheet page with an unrelated
chapter. Instead BM25 fills all but the last `floor(topK × 0.25)` slots (never
taking any of the top five), and vector-only hits fill those tail slots, best
cosine first. So the top of the list is always the exact lexical match, and
paraphrased questions still get semantically close pages at positions 7–8.

Expect vector hits to be semantically right but page-imprecise: e5-small maps a
section to the right topic yet can land ~20 pages away, and long Chinese
technical text produces a compressed cosine range (0.85–0.93 even for unrelated
chunks). Verify a vector-only hit on the original page before quoting it.

The index is language-mixed (Chinese notes next to English manuals), so the
tokenizer emits CJK bigrams plus lowercased Latin words and drops question
filler ("什么", "原理", "工作"). A small domain glossary expands Chinese terms
into their English equivalents before scoring ("波特率" adds "baud rate"), the
BM25 score is scaled by IDF-weighted query coverage (missing a rare word costs
more than missing a common one), the TOC section is weighted above body text,
and a query naming a device ("ADA4505", "MG996R") is scoped to the book whose
file name carries that token.

Two more signals come from the same index, no re-ingest needed. **Chapters**: a
run of consecutive pages under one heading is indexed as a unit, and a hit inside
a chapter whose title matches the query is weighted up (×1 + 0.5 × chapter score).
Headings come from the PDF outline; for the 73 books without one (mostly scans)
the heading is recovered from the page head ("447 9.4稳压管稳压电路" → "9.4 稳压管稳压电路").
Recovered headings drive windows and chapter weighting but are **not** added to
the searchable text, where they proved too noisy. **Edition families**: books with
the same title key and a near-identical SimHash form a family, and no more than
three hits per family are returned, so three editions of one textbook cannot
crowd out the rest. The built index is cached per vault in the process keyed by
the catalog bytes, which took a query from 3.6 s to ~0.45 s (the first query in a
fresh process still pays the build).

`expand: "section"` returns the whole contiguous chapter as `context` (broken at
`maxContextChars`, 3,000 by default) plus `pageEnd` when the chapter spans
several pages; `expand: "page"` returns every chunk of the hit page. Queries do
not use the harvested glossary unless the plugin config sets
`glossaryExpansion: true`; on the 26-question set the full harvested list cost
five page hits, frequency-gated pairs were neutral.

Input: `{ query: string, topK?: number, expand?: "none" | "page" | "section", maxContextChars?: number, vaultPath?: string }`

Output: `hits[]` (`path`, `page`, `pageEnd?`, `section?`, `score`, `excerpt`,
`context?`), `searched` (`sources`, `chunks`, `vectors` when hybrid, `families`
when edition families were detected), `retrieval` (`"bm25"` or `"hybrid"`). If
the model or vectors are unavailable the query silently falls back to BM25
instead of failing.

Every hit carries the note/book path, the 1-based page, and the TOC section.
Answers must be built from these hits; the tool never invents a citation.

## kb_lint

Read-only hygiene pass over the markdown notes. It never edits a file, never
creates one, and takes a fraction of a second on a 500-note vault.

Checks (each finding carries rule, severity, path and detail):

- `link.broken` (warn) — a `[[wikilink]]` whose target matches no note
  filename. Attachment embeds (`![[x.png]]`) are ignored, and links inside fenced
  code blocks are skipped, because template and skill notes show the syntax as an
  example rather than as a real link.
- `title.duplicate` (warn) — two notes share a basename, so Obsidian's
  `[[name]]` resolution is ambiguous.
- `concept.orphan` (warn) — a note with `type: concept` has no inbound
  wikilink; either it belongs in an index or it is a dead end.
- `frontmatter.missing` (info) — no YAML block at all.
- `frontmatter.type` (info) — frontmatter without a `type` field.

Plugin and skill folders (`copilot/`, `.agents/`, `.claude/`) are not linted: they
ship example markdown that is not knowledge. At most 50 findings per rule are
returned, while `counts` always carries the full totals.

Input: `{ vaultPath?: string }`

Output: `notes`, `elapsedMs`, `counts` (per rule plus `notes`),
`findings[]` (`rule`, `severity`, `path`, `detail`).

## kb_compile

Turns raw inbox drafts into reviewable notes. This is the first half of the
compile pipeline: it never touches `vault/`, and it writes beside the source so
the original draft stays intact.

For each draft (`inbox/**/*.md`; hidden folders and `inbox/_compiled/` are
skipped):

1. resolve `title` — existing frontmatter, else the first `# heading`, else the
   filename (a leading `~` from Obsidian's sync-conflict suffix is dropped);
2. ensure `type` — an existing valid `type`/`kind` is kept; otherwise it writes
   `type: thought` and reports `typeInferred: true`, because a note must declare
   its type (kind is never inferred from prose) before lint or promotion accepts
   it;
3. lift provenance — `来源: path#12`, `source: path p.12` and
   `[x](y.pdf#page=7)` become a deduplicated `sources:` list; `[[wikilinks]]`
   are collected into the report only, this tool never adds links;
4. normalise the body — one H1 at the top, blank-line runs collapsed outside
   fenced code, unknown frontmatter keys preserved in place.

Output goes to `inbox/_compiled/<same relative path>`; `inPlace: true` overwrites
the draft instead. A `compiledHash` (SHA-256 of the source) makes the pass
idempotent: an unchanged draft is skipped unless `force` is set. All writes stay
inside `inbox/`; anything else is `vault.write-denied`.

Input: `{ vaultPath?, paths?, limit?, inPlace?, force?, dryRun? }`

Output: `notes[]` (`path`, `output`, `title`, `type`, `typeInferred`, `sources`,
`links`, `changes`, `skipped`, `written`, `error`), `totals` (`scanned`,
`compiled`, `skipped`, `failed`), `dryRun`, `elapsedMs`.

## kb_suggest_links

Read-only candidate links. Given two notes, it scores how much rare vocabulary
they share and proposes the pairs worth a `[[link]]`; nothing is written, and it
never modifies frontmatter or links.

Algorithm: strip frontmatter, fenced code, markdown images, `![[embeds]]` and
URLs, then tokenise (same CJK bigram + word tokeniser as `kb_query`). Each note
becomes an idf-weighted term vector (`(1 + ln tf) * idf`); notes are compared by
cosine over shared terms only (an inverted index keeps it ~300 ms for 500 notes).

A candidate survives when all of these hold:

- cosine >= `minScore` (default `0.2`);
- the target is not already linked from the source (a `[[name]]` in the body);
- at least one shared term is rare (df <= max(3, 1.2% of notes)) - datasheet
  notes that share only section headings like 引脚/单位/说明 are dropped, unless
  the cosine is >= 0.85 (near-duplicate notes);
- at most two suggestions per note, one per unordered pair, then the top
  `limit` (default 40) by confidence.

`why` is built from the strongest shared terms, CJK bigrams merged into words
(稳 + 压管 -> 稳压管), so it reads like a reason rather than a token dump.

Plugin and template trees are skipped (`copilot/`, `.agents/`, `.claude/`,
`.wiki/`, `ZtTemplates/`, `Templater/`, `Templates/`, `.trash/`, `zotlit-*`,
`*.eta.md`), and notes with less than 30 characters of body after stripping are
ignored (image-only notes have nothing to compare).

Input: `{ note?: string, limit?: number, minScore?: number, vaultPath?: string }`

Output: `notes` (scanned), `suggestions[]` (`from`, `to`, `why`, `confidence`),
`elapsedMs`.

## kb_embed

Builds the local vector index that turns `kb_query` into hybrid search. Everything
runs on this machine: the `multilingual-e5-small` ONNX export (384 dims) is
downloaded once to `<workspaceRoot>/.kb/models/`, and chunks are embedded with
numpy + onnxruntime. No model API, no tokens.

Incremental by design: a book is re-embedded only when its sidecar count no
longer matches the catalog's chunk count (re-ingesting changes the count), or
when `force` is set. One Python process loads the model once and streams one
JSON line per book, so a failure on one book leaves the others committed.

Vectors live in `.wiki/index/vectors/<sha256>.vec` (raw float32, L2-normalised)
with a `<sha256>.json` sidecar (`model`, `dims`, `count`, `ids`, `embeddedAt`).
Writes only inside `.wiki/index/vectors/`; the venv interpreter is denied writes
inside the vault, so Python stages into `<workspaceRoot>/temp/embed/staging` and
the plugin moves the finished files in.

Cost on a 16-core box: ~7 chunks/s on 12 threads, so a 23k-chunk vault takes
about an hour once; query embedding adds ~1–2 s (model load) to a search.

Input: `{ vaultPath?: string, limit?: number, force?: boolean }`

Output: `books[]` (`path`, `sha256`, `chunks`, `seconds`, `error`),
`totals` (`books`, `chunks`, `upToDate`), `model`.

## Error codes

| Code | Meaning |
| --- | --- |
| `vault.not-found` | No `.obsidian` above the working directory and no explicit path. |
| `vault.ambiguous` | More than one vault found; pass `vaultPath` explicitly. |
| `vault.invalid-root` | Root is not an absolute path. |
| `vault.write-denied` | Target is outside `inbox/` and `.wiki/`. |
| `kb.writes-disabled` | Write requested while `allowWrites` is false. |
| `compile.failed` | Draft compilation crashed; the per-note `error` carries the cause. |
| `ingest.manifest-missing` | `.wiki/books.jsonl` absent; run `kb_inventory` with `write` first. |
| `query.index-missing` | No catalog; run `kb_ingest` first. |
| `embed.index-missing` | No catalog; run `kb_ingest` first. |
| `embed.model-missing` | tokenizers/onnxruntime or the ONNX model could not be prepared. |
| `embed.failed` | Embedding run failed; the message carries the cause. |
| `pdf.python-missing` | No interpreter with PyMuPDF and the automatic venv bootstrap failed; the message carries the probe/install errors. |
| `pdf.extract-failed` | Extractor exited non-zero or produced invalid JSON. |

## Planned (not implemented)

`kb_promote` (reviewed diff into `vault/`): it takes a compiled draft from
`inbox/_compiled/`, shows the diff against the target note (or proposes a new
path), and only writes after an explicit confirmation.
