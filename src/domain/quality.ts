const HEADER_LINE = /^(?:www\.|https?:|[A-Z]{2,}\d{2,}|RM\d{4}|Rev\.?\s|[0-9]{1,3})$/;

/**
 * How useful a chunk is as evidence, as a multiplier around 1.
 *
 * Low-density pages (running headers, index/TOC pages made of numbers and short lines) are
 * what "page drift" actually looks like in a textbook: the terms appear on a page that lists
 * them rather than explains them. Examples and figure captions are what readers usually want,
 * so they get a small bonus.
 */
export function chunkQuality(text: string): number {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return 0.6;
  let short = 0;
  let header = 0;
  let digits = 0;
  let visible = 0;
  for (const line of lines) {
    if (line.length < 25) short += 1;
    if (HEADER_LINE.test(line)) header += 1;
    for (const char of line) {
      if (char >= '0' && char <= '9') digits += 1;
      if (char !== ' ') visible += 1;
    }
  }
  let factor = 1;
  if (header / lines.length > 0.35) factor = 0.45;
  else if (short / lines.length > 0.75 && visible > 0 && digits / visible > 0.12) factor = 0.4;
  if (/(?:^|\n)\s*(?:例|例题|示例|Example)\s*[0-9]/.test(text)) factor *= 1.15;
  if (/(?:^|\n)\s*图\s*[0-9]+[-.][0-9]/.test(text)) factor *= 1.1;
  return Math.min(1.25, Math.max(0.35, factor));
}
