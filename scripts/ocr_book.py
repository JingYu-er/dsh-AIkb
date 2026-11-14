#!/usr/bin/env python
"""OCR a scanned PDF into page-scoped text with RapidOCR.

Design notes:
- One process per worker; each worker owns its own RapidOCR engine (the engine is not
  fork-safe), pages are handed out by the parent, so N workers scale roughly linearly.
- Output is one JSON object per page, written in page order. The file doubles as the
  resume journal: pages already present are skipped on the next run.
- Reading order is reconstructed, not guessed: two-column pages are detected by the
  horizontal gap between text boxes, and lines inside a column are merged into
  paragraphs instead of being emitted one visual line at a time.
"""
import argparse
import json
import os
import sys

import fitz  # PyMuPDF
import numpy as np

_engine = None


def _init_worker():
    global _engine
    from rapidocr_onnxruntime import RapidOCR

    _engine = RapidOCR()


def _render(pdf_path, page_index, dpi):
    with fitz.open(pdf_path) as doc:
        page = doc.load_page(page_index)
        zoom = dpi / 72.0
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            image = image[:, :, :3]
        return image


def _boxes(result):
    boxes = []
    for item in result or []:
        box = item[0]
        text = (item[1] or '').strip()
        score = float(item[2]) if len(item) > 2 else 1.0
        if text == '' or score < 0.35:
            continue
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        boxes.append({
            'x0': min(xs), 'x1': max(xs), 'y0': min(ys), 'y1': max(ys),
            'text': text, 'score': score,
        })
    return boxes


def _column_split(boxes, width):
    """Return [left, right] when the page is clearly two columns, else [boxes]."""
    if len(boxes) < 12:
        return [boxes]
    left = [b for b in boxes if (b['x0'] + b['x1']) / 2 < width * 0.45]
    right = [b for b in boxes if (b['x0'] + b['x1']) / 2 > width * 0.55]
    if len(left) < len(boxes) * 0.3 or len(right) < len(boxes) * 0.3:
        return [boxes]
    # A real two-column page has a gutter: no box crosses the middle band.
    crossing = [b for b in boxes if b['x0'] < width * 0.45 and b['x1'] > width * 0.55]
    if len(crossing) > len(boxes) * 0.15:
        return [boxes]
    return [left, right]


def _merge_lines(boxes):
    """Merge OCR line boxes into paragraphs: same column, small vertical gap."""
    ordered = sorted(boxes, key=lambda b: (round(b['y0'], 1), b['x0']))
    paragraphs = []
    current = []
    last_y1 = None
    for box in ordered:
        height = max(1.0, box['y1'] - box['y0'])
        gap = None if last_y1 is None else box['y0'] - last_y1
        if current and gap is not None and gap > height * 0.9:
            paragraphs.append(current)
            current = []
        current.append(box['text'])
        last_y1 = max(last_y1, box['y1']) if last_y1 is not None and gap is not None and gap <= height * 0.9 else box['y1']
    if current:
        paragraphs.append(current)
    merged = []
    for paragraph in paragraphs:
        text = ''
        for line in paragraph:
            if text == '':
                text = line
            elif text.endswith('-') and len(text) > 1 and text[-2].isascii() and text[-2].isalpha():
                text = text[:-1] + line
            elif text[-1].isascii() and text[-1].isalnum() and line[:1].isascii() and line[:1].isalnum():
                text = text + ' ' + line
            else:
                text = text + line
        merged.append(text.strip())
    return [p for p in merged if p != '']


def _ocr_page(args):
    pdf_path, page_index, dpi = args
    image = _render(pdf_path, page_index, dpi)
    result, _elapse = _engine(image)
    boxes = _boxes(result)
    if not boxes:
        return page_index + 1, ''
    blocks = []
    for column in _column_split(boxes, image.shape[1]):
        blocks.extend(_merge_lines(column))
    return page_index + 1, '\n\n'.join(blocks)


def _load_done(out_path):
    done = {}
    if os.path.exists(out_path):
        with open(out_path, 'r', encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if line == '':
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record.get('page'), int):
                    done[record['page']] = record
    return done


def _write(out_path, records):
    tmp = out_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as handle:
        for page in sorted(records):
            handle.write(json.dumps(records[page], ensure_ascii=False) + '\n')
    os.replace(tmp, out_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--first', type=int, default=1)
    parser.add_argument('--last', type=int, default=0, help='0 = last page')
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--dpi', type=int, default=200)
    parser.add_argument('--progress-every', type=int, default=20)
    options = parser.parse_args()

    with fitz.open(options.pdf) as doc:
        total = doc.page_count
    first = max(1, options.first)
    last = total if options.last <= 0 else min(total, options.last)

    done = _load_done(options.out)
    pending = [page for page in range(first, last + 1) if page not in done]
    print(json.dumps({
        'event': 'start', 'pages': total, 'first': first, 'last': last,
        'todo': len(pending), 'resumed': len(done), 'workers': options.workers,
    }), flush=True)
    if not pending:
        print(json.dumps({'event': 'done', 'pages': last - first + 1, 'ocr': len(done)}), flush=True)
        return 0

    tasks = [(options.pdf, page - 1, options.dpi) for page in pending]
    written = 0
    if options.workers <= 1:
        _init_worker()
        results = map(_ocr_page, tasks)
    else:
        import multiprocessing as mp

        pool = mp.Pool(processes=options.workers, initializer=_init_worker)
        results = pool.imap_unordered(_ocr_page, tasks, chunksize=1)

    for page, text in results:
        done[page] = {'page': page, 'text': text, 'chars': len(text)}
        written += 1
        if written % max(1, options.progress_every) == 0:
            _write(options.out, done)
            print(json.dumps({'event': 'progress', 'done': written, 'todo': len(pending)}), flush=True)
    if options.workers > 1:
        pool.close()
        pool.join()
    _write(options.out, done)
    print(json.dumps({'event': 'done', 'pages': last - first + 1, 'ocr': len(done)}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
