/**
 * Claim-level contradiction detection.
 *
 * Embedding similarity answers "are these two notes about the same thing", which is not
 * what a contradiction queue needs: two tutorials about the same topic share plenty of
 * words and never disagree. A contradiction needs a shared attribute carrying two
 * incompatible values ("限值 3.3 V" vs "限值 5 V"), so this module extracts (key, value)
 * claims and only calls a conflict when the same key holds differing values in the same
 * unit family.
 *
 * Nothing here names a subject area: unit tables, aliases and extra stop keys arrive
 * through {@link ClaimProfile}. With the default (empty) profile an unrecognised unit
 * spelling only compares against itself, so a vault needs no configuration to work and
 * gains real conversions only when it declares them.
 */

export interface Claim {
  /** Normalized attribute name, e.g. "rated value". */
  readonly key: string;
  /** Attribute as written in the note. */
  readonly rawKey: string;
  /** Value as written, e.g. "3.3 V", "115200", "必须". */
  readonly value: string;
  /** The sentence (or table row) the claim was read from. */
  readonly sentence: string;
}

/** One unit spelling and how it converts into a comparison family. */
export interface ClaimUnit {
  /** Unit spelling as it appears in a note, lower-case (e.g. "hz", "ms"). */
  readonly spelling: string;
  /** Unit family; two values conflict only when their families match. */
  readonly family: string;
  /** Multiplier into the family's base unit. */
  readonly factor: number;
}

/**
 * Subject-matter knowledge a vault may inject. Every field is optional and the default
 * profile is empty on purpose: the module itself knows document structure only.
 */
export interface ClaimProfile {
  /** Unit spellings the vault wants converted, longest spelling first is not required. */
  readonly units?: readonly ClaimUnit[];
  /** Extra keys and values that name a column or field rather than assert a value. */
  readonly stopKeys?: readonly string[];
  /** Alternative spellings that mean the same attribute. */
  readonly aliases?: ReadonlyMap<string, string>;
  /** Trailing words that mark a column title rather than a parameter name. */
  readonly aliasSuffix?: RegExp;
}

/** The zero-knowledge profile: no units, no aliases, no extra stop keys. */
export const DEFAULT_CLAIM_PROFILE: ClaimProfile = Object.freeze({
  units: Object.freeze([]) as readonly ClaimUnit[],
  stopKeys: Object.freeze([]) as readonly string[],
  aliases: new Map<string, string>(),
});

/** A parameter name is words/digits, not LaTeX, code, markup or a table separator. */
const KEY_SHAPE = /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 _./\-]{1,23}$/;

/**
 * Document metadata and generic table column titles. These describe a file or a column
 * (frontmatter keys, "attribute | value" headers), never a claim about a subject, so they
 * stay in the module even with an empty profile.
 */
const DOCUMENT_KEYS = new Set([
  'title', '标题', 'tags', 'tag', 'type', 'date', 'created', 'updated',
  '创建时间', '修改时间', '来源', 'source', 'author', '作者', '链接', 'url', 'note', '备注',
  // Table column headers that name a column, not a parameter.
  '属性', '参数', '符号', '说明', '示例', '含义', '描述', '名称', '类型', '作用', '功能',
  '项目', '单位', '值', '方法', '条件', '用途', '定义',
]);

const KEY_MAX = 24;
const SENTENCE_MAX = 200;
/** Backtick, asterisk, underscore, tilde: markdown emphasis the claim value does not need. */
const STRIP_MARKUP = /[\x60*_~]/g;
const FENCE = /^\s*(\x60{3,}|~{3,})/;

function normalizeKey(raw: string, profile: ClaimProfile): string {
  const base = raw
    .replace(/^[\s>*\-#|]+/, '')
    .replace(STRIP_MARKUP, '')
    .replace(/[（(].*?[)）]$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const suffix = profile.aliasSuffix;
  const trimmed = suffix === undefined ? base : base.replace(suffix, '').trim();
  return profile.aliases?.get(trimmed) ?? trimmed;
}

function sentenceOf(line: string): string {
  const trimmed = line.replace(/^[\s>*\-#|]+/, '').trim();
  return trimmed.length <= SENTENCE_MAX ? trimmed : trimmed.slice(0, SENTENCE_MAX);
}

/** Longest spellings first so "ms" never wins over "m" for a given note spelling. */
function sortUnits(units: readonly ClaimUnit[]): readonly ClaimUnit[] {
  return [...units].sort((left, right) => right.spelling.length - left.spelling.length);
}

/**
 * Split a numeric value such as "3.3 V" or "1000Hz" into base units. A spelling the
 * profile does not declare still compares, but only against the same spelling: guessing
 * a conversion the vault never supplied would be worse than reporting nothing.
 */
function numericValue(value: string, units: readonly ClaimUnit[]): { family: string; base: number } | undefined {
  const match = /^(-?\d+(?:\.\d+)?)\s*([a-zA-ZωΩ℃%°µ]+)?$/.exec(value.trim());
  if (match === null) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return undefined;
  const unit = (match[2] ?? '').toLowerCase().replace(/µ/g, 'u');
  if (unit === '') return { family: '', base: number };
  for (const entry of units) {
    if (unit === entry.spelling.toLowerCase()) {
      return { family: entry.family, base: number * entry.factor };
    }
  }
  return { family: 'spelling:' + unit, base: number };
}

function stopKeySet(profile: ClaimProfile): ReadonlySet<string> {
  if (profile.stopKeys === undefined || profile.stopKeys.length === 0) return DOCUMENT_KEYS;
  const merged = new Set(DOCUMENT_KEYS);
  for (const key of profile.stopKeys) merged.add(key.toLowerCase());
  return merged;
}

function pushClaim(
  out: Claim[],
  rawKey: string,
  rawValue: string,
  sentence: string,
  profile: ClaimProfile,
  stopKeys: ReadonlySet<string>,
): void {
  const key = normalizeKey(rawKey, profile);
  const value = rawValue.replace(STRIP_MARKUP, '').trim().replace(/\s+/g, ' ');
  if (key.length < 2 || key.length > KEY_MAX) return;
  if (!KEY_SHAPE.test(key)) return;
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(key)) return;
  if (stopKeys.has(key)) return;
  if (value === '' || value.length > 40) return;
  // A row like "attribute | description" names its columns rather than asserting a value.
  if (stopKeys.has(value.trim().toLowerCase())) return;
  if (!/[0-9]/.test(value) && value.length > 24) return;
  out.push({ key, rawKey: rawKey.trim(), value, sentence: sentenceOf(sentence) });
}

/** key: value / key = value / key：value (single line, short value). */
function extractAssignments(line: string, out: Claim[], profile: ClaimProfile, stopKeys: ReadonlySet<string>): void {
  const match = /^([^:：=]{2,24}?)\s*[:：=]\s*(\S.{0,38})$/.exec(line.trim());
  if (match === null) return;
  const value = (match[2] ?? '').trim().replace(/[，。；;,]$/, '');
  if (value === '' || /^https?:/i.test(value)) return;
  const interesting = /[0-9]/.test(value) || /^(\d+(?:\.\d+)?\s*[a-zA-ZωΩ℃%°µ]+)$/.test(value) ||
    /^(是|否|支持|不支持|能|不能|可以|不要|禁止|必须)/.test(value);
  if (!interesting) return;
  pushClaim(out, match[1] ?? '', value, line, profile, stopKeys);
}

/** Markdown table row: | 参数 | 值 | */
function extractTableRow(line: string, out: Claim[], profile: ClaimProfile, stopKeys: ReadonlySet<string>): void {
  if (!line.trim().startsWith('|')) return;
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 2 || cells.length > 4) return;
  if (cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, '')))) return;
  const [key, value] = cells;
  if ((value ?? '') === '' || (value ?? '').length > 40) return;
  pushClaim(out, key ?? '', value ?? '', cells.join(' | '), profile, stopKeys);
}

/** Attribute X 为/取/设为 3.3 V */
function extractCopula(line: string, out: Claim[], profile: ClaimProfile, stopKeys: ReadonlySet<string>): void {
  const pattern = /([\u4e00-\u9fa5A-Za-z0-9_+#.\-]{1,18})\s*(?:为|是|取|等于|设为|设置为)\s*(-?\d+(?:\.\d+)?\s*(?:[a-zA-ZωΩ℃%°µ]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    pushClaim(out, match[1] ?? '', match[2] ?? '', line, profile, stopKeys);
  }
}

/** Read every claim a note body asserts. */
export function extractClaims(body: string, profile: ClaimProfile = DEFAULT_CLAIM_PROFILE): Claim[] {
  const out: Claim[] = [];
  const stopKeys = stopKeySet(profile);
  const lines = body.split(/\r?\n/);
  // A table's header row names the columns; its values live in the rows below the separator.
  const isSeparator = (text: string): boolean => {
    if (!text.trim().startsWith('|')) return false;
    const cells = text.split('|').slice(1, -1).map((cell) => cell.trim()).filter((cell) => cell !== '');
    return cells.length >= 2 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
  };
  let fence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    if (FENCE.test(rawLine)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('!') || line.startsWith('>')) continue;
    if (isSeparator(line) || isSeparator(lines[index + 1] ?? '')) continue;
    extractTableRow(line, out, profile, stopKeys);
    extractAssignments(line, out, profile, stopKeys);
    extractCopula(line, out, profile, stopKeys);
  }
  return out;
}

/**
 * Explain why two claims about the same attribute cannot both hold, or return
 * undefined when they are compatible (equal, convertible, or one refines the other).
 */
export function claimConflict(left: Claim, right: Claim, profile: ClaimProfile = DEFAULT_CLAIM_PROFILE): string | undefined {
  if (left.key !== right.key) return undefined;
  const units = profile.units === undefined ? [] : sortUnits(profile.units);
  const numA = numericValue(left.value, units);
  const numB = numericValue(right.value, units);
  if (numA !== undefined && numB !== undefined) {
    if (numA.family !== numB.family) return undefined;
    const scale = Math.max(1, Math.abs(numA.base), Math.abs(numB.base));
    if (Math.abs(numA.base - numB.base) <= 1e-9 * scale) return undefined;
    return '同一个参数「' + left.rawKey.trim() + '」两边取值不同：' + left.value + ' vs ' + right.value;
  }
  const lv = left.value.trim().toLowerCase();
  const rv = right.value.trim().toLowerCase();
  if (lv === rv) return undefined;
  for (const prefix of ['不', '禁止', '勿', '非']) {
    if (lv === prefix + rv || rv === prefix + lv) {
      return '「' + left.rawKey.trim() + '」一边是「' + left.value + '」，一边是「' + right.value + '」';
    }
  }
  // Free-text values are paraphrases far more often than contradictions ("描述" vs "说明"),
  // so without a negation flip or two numbers there is nothing honest to report here.
  return undefined;
}

/** Group claims by key so only same-attribute claims are ever compared. */
export function claimsByKey<T extends Claim>(claims: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const claim of claims) {
    const bucket = index.get(claim.key);
    if (bucket === undefined) index.set(claim.key, [claim]);
    else bucket.push(claim);
  }
  return index;
}
