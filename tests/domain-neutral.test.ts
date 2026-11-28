/**
 * Regression guard: src ships to every vault, so it must not carry subject-area
 * vocabulary. Domain knowledge belongs in a per-vault profile (see ClaimProfile) or in
 * docs / skills / bench, which this test deliberately does not scan.
 *
 * The scan is plain file reading: no vault, no configuration, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CLAIM_PROFILE, claimConflict, claimsByKey, extractClaims } from '../src/application/kb-claims.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));

/** Words that only make sense inside one subject area, so they cannot ship in src. */
const DOMAIN_WORDS: readonly string[] = [
  // The pairs the plugin used to hardcode, kept as the minimum guard.
  '运放', '引脚', '波特率', 'op-amp', 'baud', 'voltage-gain',
  // Further subject vocabularies; any of these would bias a general-purpose vault.
  '波特', '电压', '齐纳', 'zener', '共模', '差模', '阻抗', 'impedance',
  '晶振', '示波器', '三极管', '数据手册', '串口', '时序', '增益', '容值', '电感',
  'voltage',
];

/**
 * A literal array pairing a Chinese term with its English equivalent is exactly the
 * "alias table" shape that used to live in kb-claims. Both orders are suspicious.
 */
const PAIR_SOURCES: readonly string[] = [
  String.raw`\[\s*(['"])[^'"]*[\u4e00-\u9fff][^'"]*\1\s*,\s*(['"])[A-Za-z][A-Za-z0-9 ._/-]{1,29}\2\s*\]`,
  String.raw`\[\s*(['"])[A-Za-z][A-Za-z0-9 ._/-]{1,29}\1\s*,\s*(['"])[^'"]*[\u4e00-\u9fff][^'"]*\2\s*\]`,
];

const ASCII_WORD = /^[A-Za-z][A-Za-z0-9-]*$/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files.sort();
}

function displayPath(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordOccurrences(text: string, word: string): number[] {
  const lines = text.split(/\r?\n/);
  // "pin" and "gain" are ordinary English words; only ASCII terms get boundaries.
  const bounded = ASCII_WORD.test(word)
    ? new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(word)}([^A-Za-z0-9_-]|$)`, 'i')
    : undefined;
  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (bounded === undefined ? line.includes(word) : bounded.test(line)) hits.push(index + 1);
  });
  return hits;
}

function pairOccurrences(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    found.push(`line ${line}: ${match[0].replace(/\s+/g, ' ')}`);
  }
  return found;
}

describe('src stays subject-neutral', () => {
  it('ships no field-specific vocabulary', () => {
    const files = sourceFiles(SRC_ROOT);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const word of DOMAIN_WORDS) {
        for (const line of wordOccurrences(text, word)) hits.push(`${displayPath(file)}:${line} contains "${word}"`);
      }
    }
    assert.deepEqual(hits, [], [
      'src must not name a subject area; move the vocabulary into a vault profile or docs:',
      ...hits,
    ].join('\n'));
  });

  it('declares no hardcoded zh/en term pairs', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const source of PAIR_SOURCES) {
        for (const match of pairOccurrences(text, new RegExp(source, 'g'))) {
          hits.push(`${displayPath(file)} ${match}`);
        }
      }
    }
    assert.deepEqual(hits, [], [
      'a literal [中文, english] alias table belongs in a per-vault profile, not src:',
      ...hits,
    ].join('\n'));
  });

  it('actually scans the tree and detects the shapes it claims to', () => {
    const files = sourceFiles(SRC_ROOT);
    assert.ok(files.length >= 10, 'src scan must cover the real tree');
    assert.ok(files.some((file) => file.endsWith('kb-claims.ts')), 'the scan must reach application modules');

    for (const word of ['运放', '引脚', '波特率', 'op-amp', 'baud', 'voltage-gain']) {
      assert.ok(DOMAIN_WORDS.includes(word), `required guard word missing: ${word}`);
    }

    // Sanity-check both detectors against constructed samples, so the scan can never
    // pass merely because nothing matched.
    const zhEn = "['" + '\u8fd0\u653e' + "', '" + 'op-amp' + "']";
    const enZh = "['" + 'baud' + "', '" + '\u6ce2\u7279\u7387' + "']";
    assert.equal(pairOccurrences(zhEn, new RegExp(PAIR_SOURCES[0] ?? '', 'g')).length, 1);
    assert.equal(pairOccurrences(enZh, new RegExp(PAIR_SOURCES[1] ?? '', 'g')).length, 1);
    assert.deepEqual(wordOccurrences('const a = 1; // 运放', '运放'), [1]);
    assert.deepEqual(wordOccurrences('export const pinCount = 3;', 'pin'), []);
  });
});

describe('ClaimProfile injection', () => {
  it('defaults to an empty profile', () => {
    const body = '| 属性甲 | 3 V |\n属性甲 为 5 V';
    assert.deepEqual(extractClaims(body), extractClaims(body, DEFAULT_CLAIM_PROFILE));
  });

  it('converts values only through units the profile supplies', () => {
    const units = [
      { spelling: 'khz', family: 'frequency', factor: 1000 },
      { spelling: 'hz', family: 'frequency', factor: 1 },
    ];
    const left = extractClaims('| 属性甲 | 0.8 kHz |', { units })[0];
    const right = extractClaims('| 属性甲 | 900 Hz |', { units })[0];
    assert.ok(left !== undefined && right !== undefined);
    assert.equal(claimConflict(left, right), undefined, 'without a unit table spellings stay incomparable');
    assert.ok(claimConflict(left, right, { units })?.includes('属性甲'), 'with a unit table 800 Hz and 900 Hz conflict');
  });

  it('merges keys through an injected alias map and honours extra stop keys', () => {
    const aliases = new Map([['属性乙', '属性甲']]);
    const merged = claimsByKey(extractClaims('| 属性甲 | 3 V |\n| 属性乙 | 5 V |', { aliases }));
    assert.equal(merged.size, 1);
    const [first, second] = merged.get('属性甲') ?? [];
    assert.ok(first !== undefined && second !== undefined);
    assert.ok(claimConflict(first, second, { aliases })?.includes('属性甲'));

    const kept = extractClaims('| 工艺 | 3 nm |\n| 属性甲 | 3 V |', { stopKeys: ['工艺'] });
    assert.deepEqual(kept.map((claim) => claim.key), ['属性甲']);
  });
});
