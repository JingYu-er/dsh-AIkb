/** Metric definitions shared by the benchmark runner. A page hit tolerates ±2 pages. */
export function hitsOf(hit, item) {
  const sameBook = hit.path === item.path;
  const near = (n) => item.truth.some((t) => Math.abs(hit.page - t) <= n);
  return {
    page: sameBook && near(2),
    near: sameBook && near(10),
    book: sameBook,
    window: sameBook && item.truth.some((t) => t >= hit.page - 2 && t <= (hit.pageEnd ?? hit.page) + 2),
    topic: item.topic ? item.topic(hit.path.split('/').pop() ?? '') : false,
  };
}

/** One item -> counters. topK is the list length the caller asked for. */
export function evaluate(item, hits, pageTextOf) {
  const flags = hits.map((hit) => hitsOf(hit, item));
  const firstPage = flags.findIndex((flag) => flag.page);
  const terms = Array.isArray(item.terms) && item.terms.length > 0 ? item.terms : undefined;
  let term5 = null;
  if (terms !== undefined && typeof pageTextOf === 'function') {
    term5 = hits.slice(0, 5).some((hit) => {
      const text = (pageTextOf(hit) ?? '').toLowerCase();
      return text !== '' && terms.some((term) => text.includes(String(term).toLowerCase()));
    }) ? 1 : 0;
  }
  return {
    page1: flags[0]?.page === true ? 1 : 0,
    page5: flags.slice(0, 5).some((flag) => flag.page) ? 1 : 0,
    page8: flags.slice(0, 8).some((flag) => flag.page) ? 1 : 0,
    near5: flags.slice(0, 5).some((flag) => flag.near) ? 1 : 0,
    book5: flags.slice(0, 5).some((flag) => flag.book) ? 1 : 0,
    window5: flags.slice(0, 8).some((flag) => flag.window) ? 1 : 0,
    topic8: flags.slice(0, 8).some((flag) => flag.topic) ? 1 : 0,
    term5,
    rr: firstPage >= 0 ? 1 / (firstPage + 1) : 0,
    ndcg10: firstPage >= 0 ? 1 / Math.log2(firstPage + 2) : 0,
    firstPage,
  };
}

const FIELDS = ['page1', 'page5', 'page8', 'near5', 'book5', 'window5', 'topic8'];

export function summarize(label, rows, elapsedMs) {
  const n = rows.length;
  const sums = Object.fromEntries(FIELDS.map((field) => [field, rows.reduce((sum, row) => sum + row[field], 0)]));
  const scored = rows.filter((row) => row.term5 !== null && row.term5 !== undefined);
  const term5 = scored.reduce((sum, row) => sum + row.term5, 0);
  const mrr = n === 0 ? 0 : rows.reduce((sum, row) => sum + row.rr, 0) / n;
  const ndcg = n === 0 ? 0 : rows.reduce((sum, row) => sum + row.ndcg10, 0) / n;
  return {
    label, n, ...sums, term5, termN: scored.length, mrr: Number(mrr.toFixed(3)), ndcg10: Number(ndcg.toFixed(3)),
    avgMs: n === 0 ? 0 : Math.round(elapsedMs / n),
  };
}

export function formatSummary(summary) {
  const parts = FIELDS.map((field) => field + ' ' + summary[field] + '/' + summary.n);
  if (summary.termN > 0) parts.push('term@5 ' + summary.term5 + '/' + summary.termN);
  return summary.label + ' ' + parts.join(' ') + ' mrr ' + summary.mrr.toFixed(2) + ' ndcg ' + summary.ndcg10.toFixed(3) + ' avg ' + summary.avgMs + 'ms';
}
