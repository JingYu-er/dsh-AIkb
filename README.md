# dsh-kb

An Obsidian-native knowledge base for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

**Thesis: a compiler, not a retriever.** Generic AI knows the world but not *your* material.
Ordinary RAG explains a passage and forgets it; this plugin ingests material once and compiles it
into structured, interlinked, self-updating pages, then answers from that compiled structure with
a verifiable pointer (path + page + modality + excerpt) back to the source.

> Status: **architecture scaffold**. Domain model, ports and tool contracts are in place; the DSH
> tool adapter and the ingest/retrieval pipeline are not implemented yet. Nothing here writes to a
> vault today — the write path is opt-in and unimplemented.

## Hard boundaries (non-negotiable)

- The AI **never** infers what you have mastered. Only explicit markers (`mastery: solid`), an
  accepted link proposal, or a passed quiz count.
- The AI **never** inserts wikilinks on its own. It proposes a link plus a one-sentence *why*; you accept.
- The AI **never** edits the formal area of the vault. Output goes to `inbox/`; promotion is a
  separate, explicit step.
- `.obsidian/` is out of scope entirely. No exceptions.
- Formula semantics, circuit topology and OCR text are **unverified** unless a check proves them.

## Layout

```
dsh-kb/
├── src/
│   ├── domain/        entities + invariants (no framework, no fs, no DSH)
│   ├── application/   use cases, one per tool (kb_doctor, kb_query, ...)
│   ├── infrastructure/ adapters: filesystem vault, index, OCR, embeddings
│   ├── interfaces/    DSH tool registration, formatting, config wiring
│   ├── ports.ts       the contracts the domain/application layers depend on
│   ├── config.ts      vault resolution + budgets + guards
│   └── shared/        Result, ids
├── tests/             pure unit tests (no vault required)
└── docs/              ARCHITECTURE.md, TOOLS.md
```

## Repository split

This folder is its **own git repository**, intentionally excluded from the knowledge-base repository
that surrounds it (`../` ignores `dsh-kb/` and `temp/`). The vault is data; this is source code.
They are versioned, backed up and published separately — the vault repository must stay private,
this one is meant to be open sourced.

## Development

```bash
npm install
npm run typecheck
npm test
```

Scratch work (sample PDFs, generated indexes, throwaway vaults) goes in `../temp/`, which both
repositories ignore.

## License

MIT.
