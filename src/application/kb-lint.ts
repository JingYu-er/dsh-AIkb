/** Read-only checks over the markdown notes of a vault. */

export interface LintEntry {
  readonly relPath: string;
}

export interface LintFs {
  listFiles(): Promise<readonly LintEntry[]>;
  readText(relPath: string): Promise<string>;
}

export type LintSeverity = 'error' | 'warn' | 'info';

export interface LintFinding {
  readonly rule: string;
  readonly severity: LintSeverity;
  readonly path: string;
  readonly detail: string;
}

export interface LintReport {
  readonly ok: true;
  readonly vaultRoot: string;
  readonly notes: number;
  readonly findings: readonly LintFinding[];
  readonly counts: Record<string, number>;
  readonly elapsedMs: number;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const LINK = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const KEY_LINE = /^([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)\s*:\s*(.*)$/;
const ATTACHMENT = /\.(png|jpe?g|gif|webp|svg|pdf|mp4|canvas|excalidraw|base)$/i;
/** Plugin/skill folders that ship example markdown; they are not knowledge notes. */
const SKIP_PREFIX = /^(copilot|\.agents|\.claude|\.wiki)\//i;
const FENCED = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;

const MAX_PER_RULE = 50;

function basenameOf(relPath: string): string {
  const file = relPath.split('/').pop() ?? relPath;
  return file.replace(/\.md$/i, '');
}

function normalise(name: string): string {
  return name.trim().toLowerCase();
}

function frontmatterOf(text: string): Record<string, string> | undefined {
  const match = FRONTMATTER.exec(text);
  if (match === null) return undefined;
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const field = KEY_LINE.exec(line);
    if (field === null) continue;
    const key = field[1];
    if (key === undefined) continue;
    fields[key.toLowerCase()] = (field[2] ?? '').trim();
  }
  return fields;
}

function linksOf(text: string): string[] {
  const out: string[] = [];
  // Code blocks show wikilink syntax as examples (模板笔记、skill 文档), never as real links.
  for (const match of text.replace(FENCED, '').matchAll(LINK)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const target = raw.replace(/^\.\//, '').split('/').pop() ?? raw;
    if (ATTACHMENT.test(target)) continue;
    out.push(normalise(target));
  }
  return out;
}

function pushFinding(findings: LintFinding[], counted: Record<string, number>, finding: LintFinding): void {
  counted[finding.rule] = (counted[finding.rule] ?? 0) + 1;
  if ((counted[finding.rule] ?? 0) <= MAX_PER_RULE) findings.push(finding);
}

export async function runLint(fs: LintFs, vaultRoot: string): Promise<LintReport> {
  const started = Date.now();
  const notes = (await fs.listFiles()).filter((entry) => /\.md$/i.test(entry.relPath) && !SKIP_PREFIX.test(entry.relPath));
  const byName = new Map<string, string[]>();
  for (const note of notes) {
    const key = normalise(basenameOf(note.relPath));
    const list = byName.get(key);
    if (list === undefined) byName.set(key, [note.relPath]);
    else list.push(note.relPath);
  }
  const findings: LintFinding[] = [];
  const counts: Record<string, number> = { notes: notes.length };
  const inbound = new Map<string, number>();
  const concept: string[] = [];
  for (const note of notes) {
    let text = '';
    try {
      text = await fs.readText(note.relPath);
    } catch {
      continue;
    }
    const fields = frontmatterOf(text);
    const type = (fields?.type ?? fields?.['\u7c7b\u578b'] ?? '').toLowerCase();
    if (fields === undefined) {
      pushFinding(findings, counts, { rule: 'frontmatter.missing', severity: 'info', path: note.relPath, detail: 'no YAML frontmatter block' });
    } else if ((fields.type ?? fields['\u7c7b\u578b'] ?? '') === '') {
      pushFinding(findings, counts, { rule: 'frontmatter.type', severity: 'info', path: note.relPath, detail: 'frontmatter has no type field' });
    }
    if (type === 'concept' || type === '\u6982\u5ff5') concept.push(note.relPath);
    for (const target of linksOf(text)) {
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
      if (!byName.has(target)) {
        pushFinding(findings, counts, { rule: 'link.broken', severity: 'warn', path: note.relPath, detail: 'no note named "' + target + '"' });
      }
    }
  }
  for (const [name, paths] of byName) {
    if (paths.length < 2) continue;
    for (const path of paths.slice(1)) {
      pushFinding(findings, counts, { rule: 'title.duplicate', severity: 'warn', path, detail: 'another note is also named "' + name + '"' });
    }
  }
  for (const path of concept) {
    const name = normalise(basenameOf(path));
    if ((inbound.get(name) ?? 0) > 0) continue;
    pushFinding(findings, counts, { rule: 'concept.orphan', severity: 'warn', path, detail: 'concept page has no inbound wikilink' });
  }
  return { ok: true, vaultRoot, notes: notes.length, findings, counts, elapsedMs: Date.now() - started };
}
