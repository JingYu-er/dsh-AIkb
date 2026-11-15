import { tokenize } from './text.js';

/** A book as seen by the family detector: name, size and a text sample. */
export interface FamilyInput {
  readonly sha256: string;
  readonly path: string;
  readonly pages: number;
  readonly sample: string;
}

/** Same work, different edition/translation/volume: they share one hit quota. */
export interface FamilyInfo {
  readonly id: string;
  readonly titleKey: string;
  readonly label: string;
}

export interface FamilyAssignment {
  readonly bySha: ReadonlyMap<string, FamilyInfo>;
  readonly families: number;
}

const EDITION_RULES: readonly RegExp[] = [
  /第\s*[一二三四五六七八九十百0-9]+\s*版/g,
  /\b[0-9]+\s*(?:st|nd|rd|th)\s*(?:edition|ed\.?)\b/gi,
  /\b(?:edition|ed\.)\b/gi,
  /\b(?:vol(?:ume)?|part)\s*[0-9ivx]+\b/gi,
  /影印版?|英文版?|中文版?|修订版?|增补版?|扫描版?/g,
  /[（(]\s*(?:上|中|下)\s*册?\s*[)）]/g,
  /[-_ ]\s*(?:上|中|下)\s*册?$/g,
];

/** File name without extension; titles live in the name, not in the PDF metadata. */
export function fileStem(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.(?:pdf|djvu|epub|md)$/i, '');
}

/**
 * Name normalised for family matching: edition markers, volume suffixes and a leading
 * numbering ("12-") are dropped, author names in brackets are kept (two books titled
 * "电路" by different authors are different works).
 */
export function titleKeyOf(path: string): string {
  let key = fileStem(path);
  key = key.replace(/^\s*\d{1,3}\s*[-_、.]\s*/, '');
  for (const rule of EDITION_RULES) key = key.replace(rule, ' ');
  key = key.replace(/[（(][^（）()]{0,40}[)）]/g, (match) =>
    /(?:上|中|下)|版|英文|中文|扫描/.test(match) ? ' ' : match,
  );
  return key
    .toLowerCase()
    .replace(/[\s\-_.·,，、:：;；'"“”‘’\[\]【】/\\]/g, '');
}

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 64-bit SimHash over CJK bigrams / Latin words. Near-duplicate editions of the same book
 * produce a small Hamming distance even when page numbers and layout differ.
 * Returns an empty string when the sample is too small to be meaningful.
 */
export function simhash64(text: string): string {
  const tokens = tokenize(text);
  if (tokens.length < 40) return '';
  const bits = new Int32Array(64);
  for (const token of tokens) {
    const low = fnv1a(token, 0x811c9dc5);
    const high = fnv1a(token + '|', 0x811c9dc5);
    for (let bit = 0; bit < 32; bit += 1) {
      const lowBit = (bits[bit] ?? 0) + (((low >>> bit) & 1) === 1 ? 1 : -1);
      const highBit = (bits[bit + 32] ?? 0) + (((high >>> bit) & 1) === 1 ? 1 : -1);
      bits[bit] = lowBit;
      bits[bit + 32] = highBit;
    }
  }
  let low = 0;
  let high = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if ((bits[bit] as number) > 0) low = (low | (1 << bit)) >>> 0;
    if ((bits[bit + 32] as number) > 0) high = (high | (1 << bit)) >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

function popcount32(value: number): number {
  let v = value >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Hamming distance of two 16-hex-digit simhashes; 64 when either side is empty. */
export function hamming64(left: string, right: string): number {
  if (left.length !== 16 || right.length !== 16) return 64;
  const leftHigh = parseInt(left.slice(0, 8), 16);
  const leftLow = parseInt(left.slice(8), 16);
  const rightHigh = parseInt(right.slice(0, 8), 16);
  const rightLow = parseInt(right.slice(8), 16);
  return popcount32(leftHigh ^ rightHigh) + popcount32(leftLow ^ rightLow);
}

function pagesCompatible(left: number, right: number): boolean {
  if (left <= 0 || right <= 0) return true;
  const ratio = left / right;
  return ratio >= 0.65 && ratio <= 1.55;
}

interface FamilyRep {
  readonly info: FamilyInfo;
  readonly pages: number;
  readonly hash: string;
  readonly titleKey: string;
}

/**
 * Group books into works. A match needs either the same normalised title plus similar
 * content (editions), or a very close content hash (renamed/translated files).
 */
export function assignFamilies(books: readonly FamilyInput[]): FamilyAssignment {
  const bySha = new Map<string, FamilyInfo>();
  const reps: FamilyRep[] = [];
  for (const book of books) {
    const titleKey = titleKeyOf(book.path);
    const hash = simhash64(book.sample);
    let match: FamilyRep | undefined;
    for (const rep of reps) {
      const distance = hamming64(rep.hash, hash);
      if (!pagesCompatible(rep.pages, book.pages)) continue;
      if (rep.titleKey !== '' && rep.titleKey === titleKey && distance <= 24) {
        match = rep;
        break;
      }
      if (distance <= 6) {
        match = rep;
        break;
      }
    }
    if (match !== undefined) {
      bySha.set(book.sha256, match.info);
      continue;
    }
    const info: FamilyInfo = {
      id: 'fam-' + book.sha256.slice(0, 12),
      titleKey,
      label: fileStem(book.path),
    };
    reps.push({ info, pages: book.pages, hash, titleKey });
    bySha.set(book.sha256, info);
  }
  return { bySha, families: reps.length };
}
