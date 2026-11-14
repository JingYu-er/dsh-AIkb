"""Extract page text + outline from a PDF as JSON (stdout). Requires PyMuPDF."""
import json
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


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: extract_pdf.py <pdf> [maxPages]", file=sys.stderr)
        return 2
    path = sys.argv[1]
    max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    document = fitz.open(path)
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
        pages.append({"page": index + 1, "width": rect.width, "height": rect.height, "blocks": blocks})
    json.dump({"pages": pages, "toc": toc, "pageCount": document.page_count}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
