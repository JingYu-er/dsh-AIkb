"""Extract page text + outline from a PDF as JSON (stdout). Requires PyMuPDF."""
import json
import os
import sys

import fitz


def join_block(text: str) -> str:
    out = []
    for index, char in enumerate(text):
        if char != "\n":
            out.append(char)
            continue
        before = text[index - 1] if index > 0 else " "
        after = text[index + 1] if index + 1 < len(text) else " "
        out.append("" if is_cjk(before) or is_cjk(after) else " ")
    return "".join(out).strip()


def is_cjk(char: str) -> bool:
    code = ord(char)
    return 0x3400 <= code <= 0x9FFF


TABLE_MARK = "\u27e6TABLE\u27e7"
FORMULA_MARK = "\u27e6FORMULA\u27e7"
MATH_CHARS = set("∫∑√≤≥±×÷∂∆πΩμθλω→∞∈∉⊂⊃∪∩∅")


def table_blocks(page) -> list[str]:
    """Rows of a real table become one marked block so the chunker can keep it whole."""
    out: list[str] = []
    try:
        finder = page.find_tables()
    except Exception:
        return out
    for table in finder.tables:
        try:
            rows = table.extract()
        except Exception:
            continue
        lines = []
        for row in rows:
            cells = [join_block(str(cell)) if cell else "" for cell in row]
            if any(cells):
                lines.append(" | ".join(cells))
        text = "\n".join(lines).strip()
        if len(text) >= 24:
            out.append(TABLE_MARK + text)
    return out


def formula_blocks(page) -> list[str]:
    """Formula-looking lines are kept separate; no LaTeX reconstruction, only a clean searchable line."""
    out: list[str] = []
    for line in page.get_text("text").split("\n"):
        line = line.strip()
        if len(line) < 4 or len(line) > 160:
            continue
        math = sum(1 for char in line if char in MATH_CHARS)
        if math >= 2 and math / len(line) >= 0.08:
            out.append(FORMULA_MARK + line)
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: extract_pdf.py <pdf> [maxPages]", file=sys.stderr)
        return 2
    path = sys.argv[1]
    max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    document = fitz.open(path)
    # find_tables() costs ~0.2 s per page; a 1000-page manual would blow the extractor timeout, so
    # only books small enough to be datasheets get table extraction (override with the env var).
    table_pages = document.page_count <= int(os.environ.get("DSH_PDF_TABLE_MAX_PAGES", "400"))
    toc = [[level, title, page] for (level, title, page) in document.get_toc(simple=True)]
    pages = []
    for index, page in enumerate(document):
        if max_pages and index >= max_pages:
            break
        rect = page.rect
        blocks = []
        for block in page.get_text("blocks"):
            if len(block) < 7 or block[6] != 0:
                continue
            text = join_block(str(block[4]))
            if not text:
                continue
            if block[3] > rect.height * 0.94 and text.isdigit():
                continue
            blocks.append(text)
        if table_pages:
            blocks.extend(table_blocks(page))
        blocks.extend(formula_blocks(page))
        pages.append({"page": index + 1, "width": rect.width, "height": rect.height, "blocks": blocks})
    text_chars = sum(len(block) for page in pages for block in page["blocks"])
    json.dump(
        {"pages": pages, "toc": toc, "pageCount": document.page_count, "textChars": text_chars},
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
