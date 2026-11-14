# dsh-kb

An Obsidian-native knowledge base plugin for DeepSeek Harness.

**It is a compiler, not a retriever.** A retriever answers and forgets; a
compiler turns sources into structured, interlinked pages that get better every
time you use them. The AI is an indexer, a first-pass filter and a cognitive
auditor — never the engineer who reads the textbook for you.

## Status

MVP read path is implemented and tested (20 unit tests):

| Tool | Purpose |
| --- | --- |
| `kb_doctor` | Vault discovery, layout and permission self-check. |
| `kb_inventory` | Hash-index every binary source into `.wiki/books.jsonl`. |
| `kb_ingest` | Page-anchored chunking + incremental local index. |
| `kb_query` | BM25 retrieval with path / page / section provenance. |

Writes are off by default and, when enabled, are confined to `inbox/` and
`.wiki/`. `vault/` is never modified by this plugin.

## Requirements

- Node >= 22
- Python 3.9+ with PyMuPDF (`pip install pymupdf`) for PDF ingest
  (EPUB/DJVU parsers are not wired yet; `kb_ingest` reports them as errors)
- A vault: a directory containing `.obsidian/`

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

If PyMuPDF lives in a non-default location, point the plugin at it via
`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-kb
      name: dsh-kb
      config:
        allowWrites: false
        pythonPath: python
        pythonLibPath: D:/path/to/pylib
```

## Usage

```text
kb_doctor                                  # is this vault readable?
kb_inventory { write: true }               # hash every PDF
kb_ingest   { limit: 3 }                   # first three books
kb_query    { query: "镜像电流源 原理" }     # hits with page + section
```

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
