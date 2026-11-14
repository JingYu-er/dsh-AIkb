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
`sources`, `versioning`, `manifest`), `counts` (notes, sources, attachments),
`byExtension`, `layout` (inbox / .wiki / books.jsonl presence),
`booksManifest` (entries, bytes), `writesEnabled`, `versionControl`, `nextActions`.

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

Input: `{ vaultPath?: string, limit?: number, pathPrefix?: string, force?: boolean }`

Output: `ok`, `books[]` (`path`, `sha256`, `pages`, `chunks`, `tokens`,
`status`, `error?`), `totals`, `indexPath`, `elapsedMs`.

Writes only `.wiki/index/chunks/<sha256>.jsonl` and `.wiki/index/catalog.json`
(`schema: dsh-kb/index@1`). A failing book does not abort the batch; the error
is recorded per book.

## kb_query

BM25 search over the local chunk index, returning provenance for every hit.

Input: `{ query: string, topK?: number, vaultPath?: string }`

Output: `hits[]` (`path`, `page`, `section`, `score`, `excerpt`),
`searched` (`sources`, `chunks`), `indexPresent`.

Every hit carries the note/book path, the 1-based page, and the TOC section.
Answers must be built from these hits; the tool never invents a citation.

## Error codes

| Code | Meaning |
| --- | --- |
| `vault.not-found` | No `.obsidian` above the working directory and no explicit path. |
| `vault.ambiguous` | More than one vault found; pass `vaultPath` explicitly. |
| `vault.invalid-root` | Root is not an absolute path. |
| `vault.write-denied` | Target is outside `inbox/` and `.wiki/`. |
| `kb.writes-disabled` | Write requested while `allowWrites` is false. |
| `ingest.manifest-missing` | `.wiki/books.jsonl` absent; run `kb_inventory` with `write` first. |
| `query.index-missing` | No catalog; run `kb_ingest` first. |
| `pdf.python-missing` | PyMuPDF-backed extractor cannot find the interpreter. |
| `pdf.extract-failed` | Extractor exited non-zero or produced invalid JSON. |

## Planned (not implemented)

`kb_compile` (inbox drafts), `kb_suggest_links` (why-carrying link proposals),
`kb_promote` (reviewed diff into `vault/`), `kb_lint` (link and frontmatter
discipline). They are specified in `docs/ARCHITECTURE.md` and land after the
read path is proven on a real vault.
