/** Note taxonomy from the vault SCHEMA (SCHEMA.md); the compile layer speaks these names. */

export type SchemaNoteType = 'concept' | 'thought' | 'source' | 'moc' | 'draft' | 'unknown';

/** Display order used by index.md and by the link engine. */
export const SCHEMA_TYPES: readonly SchemaNoteType[] = ['concept', 'thought', 'source', 'moc', 'draft', 'unknown'];

export const SCHEMA_TYPE_LABEL: Readonly<Record<SchemaNoteType, string>> = {
  concept: '概念 / concept',
  thought: '想法 / thought',
  source: '来源 / source',
  moc: '地图 / moc',
  draft: '草稿 / draft',
  unknown: '未分类 / unknown',
};

const ALIASES: Readonly<Record<string, SchemaNoteType>> = {
  concept: 'concept',
  '概念': 'concept',
  thought: 'thought',
  '想法': 'thought',
  '思考': 'thought',
  source: 'source',
  '来源': 'source',
  '资料': 'source',
  'source-note': 'source',
  moc: 'moc',
  map: 'moc',
  '地图': 'moc',
  '总览': 'moc',
  draft: 'draft',
  '草稿': 'draft',
};

/** Map a raw frontmatter type (English, Chinese alias, or unknown) onto the six buckets. */
export function normaliseSchemaType(raw: string | undefined): SchemaNoteType {
  const key = (raw ?? '').trim().toLowerCase();
  if (key === '') return 'unknown';
  return ALIASES[key] ?? 'unknown';
}

function baseName(relPath: string): string {
  return (relPath.split('/').pop() ?? relPath).toLowerCase();
}

/** index.md and log.md are generated catalogs, not notes: never scanned or linked. */
export function isGeneratedNote(relPath: string): boolean {
  const base = baseName(relPath);
  return base === 'index.md' || base === 'log.md';
}

/** SCHEMA.md is a machine-readable rulebook; it is listed in the index but never an orphan. */
export function isSchemaNote(relPath: string): boolean {
  return baseName(relPath) === 'schema.md';
}

export function isSpecialNote(relPath: string): boolean {
  return isGeneratedNote(relPath) || isSchemaNote(relPath);
}
