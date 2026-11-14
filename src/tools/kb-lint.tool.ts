import { NodeVaultFs } from '../adapters/fs/node-vault-fs.js';
import { runLint } from '../application/kb-lint.js';
import type { LintFinding, LintReport } from '../application/kb-lint.js';
import { defineTool } from './definition.js';
import type { SchemaNode } from './definition.js';

export interface KbLintArgs {
  readonly vaultPath?: string;
}

export interface KbLintDeps {
  readonly resolveRoot: (explicit?: string) => string;
}

const LINE_FEED = String.fromCharCode(10);
const RULE_ORDER = ['link.broken', 'title.duplicate', 'concept.orphan', 'frontmatter.missing', 'frontmatter.type'];

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
    counts: { type: 'json', required: true },
    findings: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule: { type: 'string', required: true },
          severity: { type: 'string', required: true },
          path: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
    },
  },
};

function renderReport(report: LintReport): string {
  const lines = [
    'lint: ' + report.notes + ' notes in ' + report.vaultRoot + ' | ' + report.elapsedMs + ' ms',
  ];
  const rules = [...RULE_ORDER, ...Object.keys(report.counts).filter((key) => key !== 'notes' && !RULE_ORDER.includes(key))];
  for (const rule of rules) {
    const total = report.counts[rule] ?? 0;
    if (total === 0) continue;
    const shown = report.findings.filter((finding) => finding.rule === rule);
    lines.push('[' + rule + '] ' + total + (shown.length < total ? ' (first ' + shown.length + ')' : ''));
    for (const finding of shown) lines.push('  - ' + finding.path + ' — ' + finding.detail);
  }
  if (lines.length === 1) lines.push('no findings');
  return lines.join(LINE_FEED);
}

function failedReport(vaultRoot: string, error: unknown): LintReport & { error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'lint.failed';
  return { ok: true, vaultRoot, notes: 0, findings: [], counts: { notes: 0 }, elapsedMs: 0, error: { code, message } };
}

export function createKbLintTool(deps: KbLintDeps) {
  return defineTool<KbLintArgs, LintReport>({
    name: 'kb_lint',
    description:
      'Read-only hygiene report over the markdown notes: broken wikilinks, duplicate note titles, concept pages nobody links to, and notes missing YAML frontmatter or a type field. Never edits a file; use it before a kb_suggest_links pass to see where the graph is thin.',
    parameters: {
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
        return await runLint(new NodeVaultFs(root), root);
      } catch (error) {
        return failedReport(root, error);
      }
    },
  });
}

/** Exposed for tests: findings keyed by rule, in the order the report should print them. */
export function findingsByRule(findings: readonly LintFinding[]): Map<string, LintFinding[]> {
  const out = new Map<string, LintFinding[]>();
  for (const finding of findings) {
    const list = out.get(finding.rule);
    if (list === undefined) out.set(finding.rule, [finding]);
    else list.push(finding);
  }
  return out;
}
