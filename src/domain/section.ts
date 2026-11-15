/**
 * Books without a PDF outline carry no section on their chunks: 73 of 176 books here, and the
 * three OCR'd textbooks among them end up with a window of exactly one page. Page heads still
 * name the section ("447 9.4稳压管稳压电路"), so recover it from the first lines of the page.
 */
const HEADING = /^(?:\d{1,4}\s+)?(\d{1,2}(?:\.\d{1,3}){1,3})[\s、.．]*([\u4e00-\u9fa5][^\n]{0,27})$/u;
const TRAILING_NOISE = /[\s(（\[【·,，.。;；:：、-]+$/u;

/** Section heading recovered from page text, or undefined when the head looks like content. */
export function headingFromText(text: string): string | undefined {
  const lines = text.split(/\r?\n/).slice(0, 3);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.length > 42) continue;
    const match = HEADING.exec(line);
    if (match === null) continue;
    const title = (match[2] ?? '').replace(TRAILING_NOISE, '').trim();
    if (title.length < 2) continue;
    return (match[1] + ' ' + title).slice(0, 40);
  }
  return undefined;
}
