# Architecture

## Why DDD here, and what it buys

The plugin answers questions about *someone else's* private corpus, writes into that corpus, and is
meant to be published. Three forces make an unstructured "tools + prompt" plugin fail:

1. **Data ownership.** The vault belongs to the user. Rules about what may be written where must hold
   regardless of which tool or model calls in, so they live in the domain, not in prompts.
2. **Replaceable providers.** Embeddings, rerankers, OCR, PDF parsing and the LLM are all swappable and
   all fail differently. Ports/adapters keep that churn out of the rules.
3. **Open source.** Other vaults have different folder names, languages, and layouts. Nothing may be
   hardcoded to one corpus. Generalisation is a design constraint, not a roadmap item.

## Layers (dependency direction: inward only)

```
interfaces (DSH tools, formatting)   →  application (use cases)  →  domain (entities, policies)
                                    ↘  ports (interfaces)  ←  infrastructure (fs, index, ocr, models)
```

- **domain/** — entities (`Vault`, `Note`, `SourceDocument`, `Chunk`) and policies (`judgeLink`).
  Pure: no fs, no network, no DSH import. Every invariant is unit-testable without a vault.
- **ports.ts** — the only contracts application code may depend on (`VaultReader`, `IndexStore`,
  `IngestLedger`, `EmbeddingModel`, `ChatModel`, `OcrEngine`, `PdfTextLayer`, `Hasher`, `Clock`).
- **application/** — one use case per exposed tool, orchestrating ports. Owns budgeting and ordering,
  not rules.
- **infrastructure/** — adapters: filesystem vault reader/writer, SQLite/JSON index, OCR, embeddings,
  PDF text layer. Each adapter is optional and degrades explicitly (a missing OCR engine is reported,
  never silently skipped).
- **interfaces/** — DSH registration, JSON shapes for tool results, config wiring. The only layer that
  may import DSH packages.

## Bounded contexts

| Context | Responsibility | Key types |
| --- | --- | --- |
| Vault & Scope | which vault, which directories, what is read-only | `VaultLayout`, `isWritableTarget` |
| Ingestion | turn a source into locatable chunks, incrementally | `SourceDocument`, `Chunk`, `IngestLedger` |
| Retrieval | hybrid search with provenance | `IndexStore` |
| Internalisation | note types, explicit mastery, contradiction reporting | `Note`, `NoteKind`, `Mastery` |
| Linking | decide whether a link is justified, never write it | `LinkProposal`, `judgeLink` |
| Compilation & promotion | inbox → review → formal area, with diffs | `VaultWriter` |
| Cost & storage | budgets, disk checks, cache eviction | `KbLimits`, `KbConfig` |
| Diagramming (later) | generate figures, verify them | — |

## Generalisation contract

- No hardcoded vault path, folder names, note titles or language. Everything comes from `KbConfig`.
- Vault discovery: explicit config → single upward `.obsidian` marker → otherwise **error**
  (`vault.ambiguous`). Guessing is a corruption vector.
- Note semantics come from explicit frontmatter markers (`kind`, `mastery`). Unknown markers stay
  `unknown`; the system never infers a type from prose.
- Providers are selected by config; a missing provider turns that capability off and says so.
- Chinese/English are both first-class: token estimation and link-why validation handle CJK and Latin.

## Storage rules

- **Sources are referenced, not stored.** Persist hash + locator + extracted chunk; never copy the PDF.
- **Derived data is disposable.** Index, OCR cache and chunks are rebuildable from `sha256` + source.
- **The vault stays the source of truth for notes.** No hidden database of note bodies.

## Repository split

`dsh-AIkb/` is its own git repository. The surrounding knowledge-base repository ignores `dsh-AIkb/` and
`temp/`; this repository ignores `node_modules/`, `dist/` and `temp/`. The vault repository is private
by necessity (it contains copyrighted books and personal notes); this repository is intended to be
public. Mixing them would either leak the vault or make the plugin unshareable.
