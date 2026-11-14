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
```

## Usage

```text
kb_doctor                                  # is this vault readable?
kb_inventory { write: true }               # hash every PDF
kb_ingest   { limit: 3 }                   # first three books
kb_query    { query: "镜像电流源 原理" }     # hits with page + section
```

## Retrieval quality

Measured on the author's vault (10 indexed books, ~7.5k page-anchored chunks),
scoring the top-5 hits: a hit counts as a page hit when it lands within ±2 pages
of the independently located answer page. Truth pages come from raw PyMuPDF text
search, not from the retrieval system itself.

| Set | page hit (top-5) | correct book at #1 | in top-3 |
| --- | --- | --- | --- |
| Tuned (15 questions used during development) | 13/15 | 12/15 | 15/15 |
| Held-out (11 unseen questions, unseen pages) | 8/11 | 8/11 | 10/11 |

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

## License

MIT © 2026 JingYu
