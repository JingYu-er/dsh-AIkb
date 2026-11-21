/**
 * Per-vault convention sheet ("schema.md"): the page rules, directory purposes and distillation
 * pipeline a knowledge base follows. It lives inside the vault so it travels with a sync or a clone,
 * and it is plain Markdown so a reader without this plugin still gets the whole rule set.
 *
 * Reads are free; writes need allowWrites and stay inside <vault>/.dsh-aikb/.
 */

import fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';

export interface VaultSchemaReport {
  readonly path: string;
  readonly exists: boolean;
  readonly bytes: number;
  readonly text: string;
  /** Last modification time in milliseconds, 0 when absent. */
  readonly updatedAt: number;
}

export interface SchemaWriteResult {
  readonly ok: boolean;
  readonly path: string;
  readonly bytes: number;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Largest sheet accepted: a rule set, not an article. */
const MAX_BYTES = 64 * 1024;

export const SCHEMA_REL_PATH = '.dsh-aikb/schema.md';

export function vaultSchemaPath(vaultRoot: string): string {
  return nodePath.join(vaultRoot, SCHEMA_REL_PATH);
}

/**
 * Starting point for a vault that has no sheet yet. Deliberately short and filled with questions:
 * a template that pretends to know the vault would be copied unchanged and never corrected.
 */
export function schemaTemplate(vaultName: string): string {
  return [
    '# ' + vaultName + ' 知识库约定',
    '',
    '这份文件写给人与 AI 共用的规则：页面怎么写、目录放什么、素材怎么加工成笔记。',
    '不确定的条目留「待定」，不要用一句看起来正确的话把它填满。',
    '',
    '## 页面规范',
    '',
    '- 标题层级：一篇笔记只用一个 H1，章节用 H2，不再往下加层。',
    '- 来源：正文涉及事实的段落末尾写 `sources: 路径#页码`，没有来源的判断写「推测」。',
    '- 链接：只在正文里链到具体概念，不建索引式列表页。',
    '- 状态：frontmatter 写 `type`（thought / concept / source / moc）与 `status`。',
    '- 待定：',
    '',
    '## 目录用途',
    '',
    '- `学习/`：教材与手册的提炼，按主题分目录。',
    '- `inbox/`：草稿区，编译前允许杂乱。',
    '- `.wiki/`：索引、备份与日志，只由插件写入。',
    '- 待定：',
    '',
    '## 加工流程',
    '',
    '1. `kb_inventory` 登记素材，`kb_ingest` 切片建索引。',
    '2. 读原文写草稿到 `inbox/`，事实句带页码。',
    '3. `kb_compile` 规范化草稿，`kb_promote` 带 diff 推进正式目录。',
    '4. `kb_suggest_links` / `kb_link_review` / `kb_link_apply` 补链接。',
    '5. `kb_review` 找矛盾，判定后再改笔记。',
  ].join('\n');
}

export async function readVaultSchema(vaultRoot: string): Promise<VaultSchemaReport> {
  const path = vaultSchemaPath(vaultRoot);
  try {
    const stat = await fsPromises.stat(path);
    const text = await fsPromises.readFile(path, 'utf8');
    return { path, exists: true, bytes: Buffer.byteLength(text, 'utf8'), text, updatedAt: stat.mtimeMs };
  } catch {
    return { path, exists: false, bytes: 0, text: '', updatedAt: 0 };
  }
}

/** Write the sheet. Refuses when writes are off, when the text is empty or oversized, and never leaves a partial file. */
export async function writeVaultSchema(
  vaultRoot: string,
  text: string,
  options: { readonly allowWrites: boolean },
): Promise<SchemaWriteResult> {
  const path = vaultSchemaPath(vaultRoot);
  if (!options.allowWrites) {
    return {
      ok: false,
      path,
      bytes: 0,
      error: { code: 'kb.schema.read-only', message: 'Writes are disabled; enable allowWrites to edit the vault sheet.' },
    };
  }
  const body = String(text ?? '');
  if (body.trim() === '') {
    return { ok: false, path, bytes: 0, error: { code: 'kb.schema.empty', message: 'The sheet is empty; keep the template headings and fill them in.' } };
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BYTES) {
    return {
      ok: false,
      path,
      bytes,
      error: { code: 'kb.schema.too-large', message: 'The sheet is ' + bytes + ' bytes; the limit is ' + MAX_BYTES + '.' },
    };
  }
  const temp = path + '.tmp';
  try {
    await fsPromises.mkdir(nodePath.dirname(path), { recursive: true });
    await fsPromises.writeFile(temp, body, 'utf8');
    await fsPromises.rename(temp, path);
    return { ok: true, path, bytes };
  } catch (error) {
    await fsPromises.rm(temp, { force: true }).catch(() => undefined);
    return {
      ok: false,
      path,
      bytes: 0,
      error: { code: 'kb.schema.write-failed', message: error instanceof Error ? error.message : String(error) },
    };
  }
}
