# dsh-kb

An Obsidian-native knowledge base plugin for DeepSeek Harness.

**It is a compiler, not a retriever.** A retriever answers and forgets; a
compiler turns sources into structured, interlinked pages that get better every
time you use them. The AI is an indexer, a first-pass filter and a cognitive
auditor — never the engineer who reads the textbook for you.

## Status

MVP read path is implemented and tested (34 unit tests):

| Tool | Purpose |
| --- | --- |
| `kb_doctor` | Vault discovery, layout and permission self-check. |
| `kb_inventory` | Hash-index every binary source into `.wiki/books.jsonl`. |
| `kb_ingest` | Page-anchored chunking + incremental local index. |
| `kb_query` | BM25 retrieval with path / page / section provenance (CJK bigrams, domain glossary, device-name scoping, coverage weighting). |

Writes are off by default and, when enabled, are confined to `inbox/` and
`.wiki/`. `vault/` is never modified by this plugin.

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
    allowWrites: true                     # required for kb_ingest / kb_inventory write
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
```

## Usage

```text
kb_doctor                                  # is this vault readable?
kb_inventory { write: true }               # hash every PDF
kb_ingest   { limit: 3 }                   # first three books
kb_embed    { limit: 5 }                   # local vectors over the index (incremental)
kb_query    { query: "镜像电流源 原理" }     # hits with page + section
```

## Retrieval quality

Measured on the author's vault (173 indexed books, 22k page-anchored chunks,
18.8k pages). Truth pages come from raw PyMuPDF text search, not from the
retrieval system itself. Two numbers matter:

- **exact page** — a top-5 hit lands in the truth book within ±2 pages of the
  answer page. This is the citation-grade bar.
- **topic** — a top-5 hit comes from the right book *family* (STM32 manuals,
  MSP430 manuals, analog-electronics textbooks). Duplicated manuals answer the
  question just as well, so this is the honest "can it answer" bar.

| Corpus | Set | exact page (top-5) | topic (top-5) |
| --- | --- | --- | --- |
| 10 books | Tuned (15 questions) | 13/15 | 15/15 |
| 10 books | Held-out (11 questions) | 8/11 | 11/11 |
| 173 books | Tuned | 6/15 | 15/15 |
| 173 books | Held-out | 4/11 | 11/11 |

Growing the corpus from 10 to 173 books costs exact-page precision (near-duplicate
manuals and textbooks compete) but never loses the topic: every question still
surfaces the right book family in its top 5. Hits are capped at two per book so a
single manual cannot fill the list.

What moves the number, in order of impact: the Chinese↔English glossary
(6/15 → 12/15 on the tuned set — Chinese questions barely share surface tokens
with English manuals), CJK bigram tokenization with question-filler filtering,
IDF-weighted query coverage, and scoping a query to the book whose device name it
contains ("ADA4505" → that datasheet).

Known gaps: questions whose answer spans a whole chapter rather than a page
(FPE has no TOC, so no heading boost), and Chinese questions against English
manuals outside the glossary. Local multilingual embeddings are the next lever;
they are not wired yet.

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
