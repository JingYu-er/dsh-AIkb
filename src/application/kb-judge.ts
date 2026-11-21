/**
 * Second stage of the contradiction funnel: decide a machine-paired row without a human.
 * It answers only what the excerpts themselves prove — differing numbers, or one side
 * negating the other. Anything it cannot prove stays 待复核 for the agent stage.
 */
export type JudgeVerdict = '冲突' | '无关' | '细化' | '待复核';

export interface JudgeOutcome {
  readonly verdict: JudgeVerdict;
  readonly basis: string;
}

const NUMBER = /(-?\d+(?:\.\d+)?)\s*([a-zA-Z%μµΩ℃]{1,4})?/g;
const NEGATION = /(?:不|禁止|勿|非|无法|不能|勿用)/;
const MAX_EXCERPT = 400;

function clean(text: string): string {
  return text
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/[\x60*_~#>]/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EXCERPT);
}

interface Measure {
  readonly value: number;
  readonly unit: string;
}

function firstMeasure(text: string): Measure | undefined {
  NUMBER.lastIndex = 0;
  const match = NUMBER.exec(text);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return { value, unit: (match[2] ?? '').toLowerCase() };
}

function sameUnit(left: Measure, right: Measure): boolean {
  if (left.unit === '' || right.unit === '') return true;
  return left.unit === right.unit;
}

function shareTerms(left: string, right: string): boolean {
  // Both excerpts come from the same attribute, so their wording overlaps by bigrams.
  const runs = left.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const grams: string[] = [];
  for (const run of runs) for (let i = 0; i + 2 <= run.length; i += 1) grams.push(run.slice(i, i + 2));
  if (grams.length === 0) return true;
  let hits = 0;
  for (const gram of grams) if (right.includes(gram)) hits += 1;
  return hits >= 2;
}

/** Judge one paired row from its two excerpts. */
export function judgePair(oldText: string, newText: string): JudgeOutcome {
  const left = clean(oldText);
  const right = clean(newText);
  if (left === '' || right === '') return { verdict: '待复核', basis: '摘录为空，无法判定' };
  const a = firstMeasure(left);
  const b = firstMeasure(right);
  if (a !== undefined && b !== undefined && sameUnit(a, b)) {
    if (a.value === b.value) {
      return { verdict: '无关', basis: `两边都写作 ${a.value}，是同一说法` };
    }
    return { verdict: '冲突', basis: `数值不同：${a.value} ≠ ${b.value}，不能同时成立` };
  }
  const negA = NEGATION.test(left);
  const negB = NEGATION.test(right);
  if (negA !== negB && shareTerms(left, right)) {
    return { verdict: '冲突', basis: '一边否定、一边肯定同一件事，不能同时成立' };
  }
  if (negA === negB && a !== undefined && b !== undefined) {
    return { verdict: '待复核', basis: '单位不同，需要 agent 换算后判定' };
  }
  return { verdict: '待复核', basis: '摘录里没有可比较的数值或极性，留给 agent' };
}
