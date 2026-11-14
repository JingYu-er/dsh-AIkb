# Tool contracts

Six tools, in dependency order. Every result is JSON, and every claim carries provenance.
Nothing in this list writes to the formal area of the vault.

## kb_doctor

Diagnose the environment before anything else runs.

- Input: `{}`
- Output: detected vault root and how it was resolved, layout dirs, read-only guards, index/ledger
  presence and size, provider availability (OCR, embeddings), git availability, budget settings,
  and a list of blocking problems with fixes.
- Never throws: a broken environment is a report, not an exception.

## kb_query

Answer a question from the compiled structure.

- Input: `{ query: string, limit?: number, scope?: string[], includeSources?: boolean }`
- Output: ranked snippets, each with `notePath` / `sourcePath` + locator (`page`, optional `bbox`,
  `modality`) + excerpt + score; plus a short "what I could not find" section.
- Budget: `KbLimits.maxSnippets` / `maxAnswerTokens`. Over budget means fewer snippets, never silent truncation.
- MVP acceptance: asking about a topic returns a note fragment, a book page reference, and candidate
  links — with the formal area untouched.

## kb_compile

Compile a source (or a note) into chunks and a readable draft.

- Input: `{ sourcePath: string, mode?: 'auto'|'text-only'|'force-ocr', dryRun?: boolean, pageRange?: [number, number] }`
- Output: per-page plan (text / figure / table / equation), chunk count, estimated token and disk cost,
  writes summary (draft path in `inbox/`), and any page flagged `needs-review`.
- Incremental: if `sha256` is unchanged in the ledger, the source is skipped and reported as cached.
- OCR is opt-in per page budget; a scan exceeding `ocrPageBudget` stops and asks.

## kb_suggest_links

Propose links, each with a reason and a why. Never insert them.

- Input: `{ notePath: string, maxProposals?: number }`
- Output: proposals `{ fromPath, toPath, reason, why, verdict }`, where `reason` is one of
  `first-occurrence | refinement | new-application`, plus rejected candidates so the user can see why.
- Enforced by `judgeLink` in the domain; filler whys ("相关", "参考") are rejected with a code.

## kb_promote

Move an approved draft into the formal area.

- Input: `{ draftPath: string, targetPath: string, mode: 'dry-run'|'apply' }`
- Output: unified diff, collision report, git commit id when a repo is present, and a rollback handle.
- Requires `guards.allowWrites`; `targetPath` must not touch `.obsidian/` or overwrite a modified note
  without an explicit force flag. Every write is snapshot-first.

## kb_lint

Check the knowledge base itself.

- Input: `{ scope?: string[], checks?: ('orphans'|'broken-links'|'stale'|'missing-provenance'|'filler-why')[] }`
- Output: findings with `file`, `line`, `rule`, `severity` and a suggested fix.
- Read-only. It reports; it does not rewrite.

## Errors

All tools return `{ ok: false, code, message, hint }` on failure rather than throwing across the tool
boundary. Codes are stable (`vault.not-found`, `vault.ambiguous`, `link.why-empty`,
`ingest.ocr-unavailable`, `promote.conflict`, ...) so scripts and the user can react to them.
