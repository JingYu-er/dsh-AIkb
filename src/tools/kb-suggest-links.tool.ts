import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { suggestLinks } from '../application/kb-suggest-links.js';
import type { SuggestReport } from '../application/kb-suggest-links.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbSuggestLinksArgs {
  readonly note?: string;
  readonly limit?: number;
  readonly minScore?: number;
  readonly vaultPath?: string;
}

export interface KbSuggestLinksDeps {
  readonly resolveRoot: (explicit?: string) => string;
}

const LINE_FEED = String.fromCharCode(10);

const OUTPUT_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    vaultRoot: { type: 'string', required: true },
    notes: { type: 'integer', required: true },
    elapsedMs: { type: 'integer', required: true },
    suggestions: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          why: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
        },
      },
    },
  },
};

function renderReport(report: SuggestReport): string {
  const lines = ['suggest: ' + report.notes + ' notes scanned | ' + report.suggestions.length + ' candidates | ' + report.elapsedMs + ' ms'];
  for (const suggestion of report.suggestions) {
    lines.push('  ' + suggestion.from + ' -> [[' + suggestion.to + ']] (' + suggestion.confidence + ', shared: ' + suggestion.why + ')');
  }
  if (report.suggestions.length === 0) lines.push('no unlinked note pairs above the threshold');
  return lines.join(LINE_FEED);
}

function failedReport(vaultRoot: string, error: unknown): SuggestReport & { error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'suggest.failed';
  return { ok: true, vaultRoot, notes: 0, suggestions: [], elapsedMs: 0, error: { code, message } };
}

export function createKbSuggestLinksTool(deps: KbSuggestLinksDeps) {
  return defineTool<KbSuggestLinksArgs, SuggestReport>({
    name: 'kb_suggest_links',
    description:
      'Read-only link candidates: pairs of notes that talk about the same terms but are not linked yet. Each candidate carries the shared terms as a why and an idf-weighted cosine as confidence. It only suggests — nothing is written; add the links yourself after checking the pages.',
    parameters: {
      note: { type: 'string', description: 'Only suggest for this note (path or title); omit to scan the whole vault.' },
      limit: { type: 'integer', description: 'Maximum candidates to return (default 40).' },
      minScore: { type: 'number', description: 'Minimum cosine similarity (default 0.2).' },
      vaultPath: { type: 'string', description: 'Override the configured vault root.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, report) => [{ type: 'text', text: renderReport(report) }],
    },
    async execute(args) {
      let root = '(unresolved)';
      try {
        root = deps.resolveRoot(args.vaultPath);
        return await suggestLinks(new NodeVaultFs(root), root, {
          ...(args.note === undefined ? {} : { note: args.note }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.minScore === undefined ? {} : { minScore: args.minScore }),
        });
      } catch (error) {
        return failedReport(root, error);
      }
    },
  });
}
