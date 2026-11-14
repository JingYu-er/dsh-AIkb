"""Embed page chunks with multilingual-e5-small (ONNX, CPU only).

Two modes:
  --jobs jobs.json   batch: [{"chunks": path, "out": path, "meta": path, "prefix": "passage: "}]
  --query TEXT       print {"vector": [...]} for one query (prefix "query: ")

Only numpy / onnxruntime / tokenizers are required: no torch, no network at run time.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MAX_LEN = 512
BATCH = 32


def load(model_dir, threads=12):
    tok_path = os.path.join(model_dir, 'tokenizer.json')
    model_path = os.path.join(model_dir, 'model_quantized.onnx')
    if not os.path.exists(tok_path) or not os.path.exists(model_path):
        raise SystemExit('embedding model missing in ' + model_dir)
    tokenizer = Tokenizer.from_file(tok_path)
    tokenizer.enable_truncation(max_length=MAX_LEN)
    tokenizer.enable_padding(pad_id=1, pad_token='<pad>')
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    session = ort.InferenceSession(model_path, sess_options=options, providers=['CPUExecutionProvider'])
    return tokenizer, session


def encode(tokenizer, session, texts, prefix):
    inputs = [i.name for i in session.get_inputs()]
    vectors = []
    for start in range(0, len(texts), BATCH):
        batch = [prefix + t for t in texts[start:start + BATCH]]
        encodings = tokenizer.encode_batch(batch)
        ids = np.asarray([e.ids for e in encodings], dtype=np.int64)
        mask = np.asarray([e.attention_mask for e in encodings], dtype=np.int64)
        feed = {'input_ids': ids, 'attention_mask': mask}
        if 'token_type_ids' in inputs:
            feed['token_type_ids'] = np.zeros_like(ids)
        hidden = session.run(None, feed)[0]
        masked = hidden * mask[:, :, None]
        pooled = masked.sum(axis=1) / np.clip(mask.sum(axis=1, keepdims=True), 1e-9, None)
        pooled /= np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-9, None)
        vectors.append(pooled.astype(np.float32))
    return np.concatenate(vectors, axis=0)


def job_report(entry, tokenizer, session):
    rows = []
    with open(entry['chunks'], 'r', encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if line == '':
                continue
            rows.append(json.loads(line))
    if not rows:
        return {'ok': False, 'error': 'no chunks', 'chunks': entry['chunks']}
    started = time.time()
    vectors = encode(tokenizer, session, [r.get('text', '') for r in rows], entry.get('prefix', 'passage: '))
    np.asarray(vectors, dtype=np.float32).tofile(entry['out'])
    meta = {
        'model': 'multilingual-e5-small',
        'dims': int(vectors.shape[1]),
        'count': int(vectors.shape[0]),
        'ids': [r.get('id', '') for r in rows],
        'embeddedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    with open(entry['meta'], 'w', encoding='utf-8') as handle:
        json.dump(meta, handle, ensure_ascii=False)
    return {'ok': True, 'count': int(vectors.shape[0]), 'dims': int(vectors.shape[1]),
            'seconds': round(time.time() - started, 2), 'meta': entry['meta'],
            'chunks': entry['chunks']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--jobs')
    parser.add_argument('--query')
    parser.add_argument('--threads', type=int, default=12)
    args = parser.parse_args()
    tokenizer, session = load(args.model_dir, args.threads)
    if args.query is not None:
        vector = encode(tokenizer, session, [args.query], 'query: ')[0]
        print(json.dumps({'vector': [float(x) for x in vector]}))
        return
    if args.jobs is None:
        raise SystemExit('either --jobs or --query is required')
    with open(args.jobs, 'r', encoding='utf-8') as handle:
        jobs = json.load(handle)
    for entry in jobs:
        try:
            report = job_report(entry, tokenizer, session)
        except Exception as error:  # one bad book must not kill the batch
            report = {'ok': False, 'error': str(error), 'chunks': entry.get('chunks', '')}
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
