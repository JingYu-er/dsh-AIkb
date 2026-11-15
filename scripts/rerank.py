#!/usr/bin/env python3
"""Cross-encoder reranking with a local ONNX model (bge-reranker-base).

The retrieval stage picks candidates with BM25/vectors; this stage scores each
(query, passage) pair with a classifier head, which is what makes neighbouring
pages of the right chapter separate from pages that merely share vocabulary.

No model API is involved: one ONNX run per batch, all on this machine.

Two modes:
  --serve                      long-lived worker: one JSON request per stdin line,
                               one JSON response per stdout line (keeps the model warm)
  --model-dir --input req.json one-shot call, prints one JSON line

Request:  {"query": "...", "documents": ["passage", ...]}
Response: {"ok": true, "count": 12, "seconds": 1.4, "scores": [0.9, ...]}
"""

import argparse
import json
import os
import sys
import threading
import time

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MAX_LEN = 512
MODEL_FILE = "model_quantized.onnx"
TOKENIZER_FILE = "tokenizer.json"


def parent_alive(pid):
    """True while the host process that spawned this worker is still running."""
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return False
        try:
            return kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def watch_parent(pid, interval=3.0):
    """Exit with the host: a killed CLI must not leave a 700 MB model process behind."""
    while True:
        time.sleep(interval)
        if not parent_alive(pid):
            os._exit(0)


def load_session(model_dir, threads):
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, threads)
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    path = os.path.join(model_dir, MODEL_FILE)
    return ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])


def load_tokenizer(model_dir, max_len):
    tokenizer = Tokenizer.from_file(os.path.join(model_dir, TOKENIZER_FILE))
    tokenizer.enable_truncation(max_length=max_len)
    tokenizer.enable_padding(pad_id=1, pad_token="<pad>", pad_type_id=0)
    return tokenizer


def sigmoid(values):
    return 1.0 / (1.0 + np.exp(-values))


def score_pairs(session, tokenizer, query, documents, batch_size):
    wanted = {item.name for item in session.get_inputs()}
    scores = []
    for start in range(0, len(documents), batch_size):
        chunk = documents[start:start + batch_size]
        encodings = tokenizer.encode_batch([(query, text) for text in chunk])
        ids = np.array([enc.ids for enc in encodings], dtype=np.int64)
        mask = np.array([enc.attention_mask for enc in encodings], dtype=np.int64)
        types = np.array([enc.type_ids for enc in encodings], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in wanted:
            feed["token_type_ids"] = types
        logits = session.run(None, feed)[0]
        flat = np.asarray(logits).reshape(len(chunk), -1)[:, 0]
        scores.extend(sigmoid(flat).astype(float).tolist())
    return scores


def documents_of(payload):
    raw = payload.get("documents") or []
    return [item.get("text", "") if isinstance(item, dict) else str(item) for item in raw]


def answer(session, tokenizer, payload, batch_size):
    query = payload.get("query") or ""
    documents = documents_of(payload)
    started = time.time()
    if not documents:
        return {"ok": True, "count": 0, "seconds": 0.0, "scores": []}
    try:
        scores = score_pairs(session, tokenizer, query, documents, batch_size)
    except Exception as error:  # noqa: BLE001 - the caller parses one JSON line
        return {"ok": False, "error": str(error)[:800], "count": 0, "seconds": round(time.time() - started, 3), "scores": []}
    return {"ok": True, "count": len(scores), "seconds": round(time.time() - started, 3), "scores": scores}


def serve(args):
    if args.parent_pid:
        threading.Thread(target=watch_parent, args=(args.parent_pid,), daemon=True).start()
    tokenizer = load_tokenizer(args.model_dir, args.max_len)
    session = load_session(args.model_dir, args.threads)
    batch = max(1, args.batch)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as error:
            sys.stdout.write(json.dumps({"ok": False, "error": "bad request: " + str(error), "scores": []}) + "\n")
            sys.stdout.flush()
            continue
        sys.stdout.write(json.dumps(answer(session, tokenizer, payload, batch)) + "\n")
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--input")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--threads", type=int, default=12)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--max-len", type=int, default=MAX_LEN)
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()

    if args.serve:
        serve(args)
        return
    if not args.input:
        parser.error("--input is required unless --serve is given")
    with open(args.input, encoding="utf-8") as handle:
        payload = json.load(handle)
    tokenizer = load_tokenizer(args.model_dir, args.max_len)
    session = load_session(args.model_dir, args.threads)
    sys.stdout.write(json.dumps(answer(session, tokenizer, payload, max(1, args.batch))))


if __name__ == "__main__":
    main()
