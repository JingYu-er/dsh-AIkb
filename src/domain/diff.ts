/** Line diff for the promote review step. Deterministic, no dependencies. */

export interface DiffLine {
  readonly kind: ' ' | '-' | '+';
  readonly text: string;
}

export interface LineDiff {
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  readonly truncated: boolean;
}

const FALLBACK_CELLS = 4_000_000;

function split(text: string): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest common subsequence, then a flat script; long diffs keep both ends. */
export function diffLines(before: string, after: string, maxLines = 200): LineDiff {
  const a = split(before);
  const b = split(after);
  let added = 0;
  let removed = 0;
  const script: DiffLine[] = [];
  const cells = a.length * b.length;
  if (cells > FALLBACK_CELLS) {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix
      && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
    for (let index = 0; index < prefix; index += 1) script.push({ kind: ' ', text: a[index] ?? '' });
    for (let index = prefix; index < a.length - suffix; index += 1) {
      script.push({ kind: '-', text: a[index] ?? '' });
      removed += 1;
    }
    for (let index = prefix; index < b.length - suffix; index += 1) {
      script.push({ kind: '+', text: b[index] ?? '' });
      added += 1;
    }
    for (let index = a.length - suffix; index < a.length; index += 1) script.push({ kind: ' ', text: a[index] ?? '' });
    return cap(script, added, removed, maxLines);
  }

  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      script.push({ kind: ' ', text: a[i] ?? '' });
      i += 1;
      j += 1;
      continue;
    }
    if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      script.push({ kind: '-', text: a[i] ?? '' });
      removed += 1;
      i += 1;
      continue;
    }
    script.push({ kind: '+', text: b[j] ?? '' });
    added += 1;
    j += 1;
  }
  while (i < a.length) {
    script.push({ kind: '-', text: a[i] ?? '' });
    removed += 1;
    i += 1;
  }
  while (j < b.length) {
    script.push({ kind: '+', text: b[j] ?? '' });
    added += 1;
    j += 1;
  }
  return cap(script, added, removed, maxLines);
}

function cap(lines: DiffLine[], added: number, removed: number, maxLines: number): LineDiff {
  if (lines.length <= maxLines) return { lines, added, removed, truncated: false };
  const head = Math.floor(maxLines / 2);
  const tail = maxLines - head;
  return {
    lines: [
      ...lines.slice(0, head),
      { kind: ' ', text: '… ' + (lines.length - maxLines) + ' line(s) omitted …' },
      ...lines.slice(lines.length - tail),
    ],
    added,
    removed,
    truncated: true,
  };
}
