import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const distUrl = (rel) => new URL('../dist/' + rel, import.meta.url).href;
const { NodeInboxFs } = await import(distUrl('adapters/fs/inbox-fs.js'));
const { NodePromoteFs } = await import(distUrl('adapters/fs/promote-fs.js'));
const { runCompile } = await import(distUrl('application/kb-compile.js'));
const { runPromote } = await import(distUrl('application/kb-promote.js'));
const { compiledHashOf } = await import(distUrl('domain/compile.js'));
const { appendAssociation, applyLinks, backupPathFor, parseQueue, renderQueue, reviewLinks } = await import(distUrl('application/kb-links.js'));
const { suggestLinks } = await import(distUrl('application/kb-suggest-links.js'));
const { parseReviewQueue, reviewNotes } = await import(distUrl('application/kb-review.js'));
const { judgePair } = await import(distUrl('application/kb-judge.js'));

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** Paths arrive in two dialects: 'draft.md' (inbox-relative) and 'inbox/_compiled/…' (vault-relative). */
const inboxRelative = (rel) => (rel.startsWith('inbox/') ? rel.slice('inbox/'.length) : rel);
/** A draft whose compiled copy already matches its content is not waiting to be compiled again. */
const compiledUpToDate = async (inbox, draft) => {
  try {
    const output = '_compiled/' + draft;
    if (!(await inbox.exists(output))) return false;
    return compiledHashOf(await inbox.readText(output)) === sha256(await inbox.readText(draft));
  } catch {
    return false;
  }
};

/**
 * Promote is a one-shot decision, so it is remembered by the hash of the compiled text: the same
 * compiled copy never shows up again, while a draft edited afterwards gets a new hash and returns
 * to the review list.
 */
const PROMOTIONS = '.wiki/promoted.json';
const promotionPath = (vault) => join(vault, PROMOTIONS);
const readPromotions = (vault) => {
  try {
    const parsed = JSON.parse(readFileSync(promotionPath(vault), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.source === 'string' && typeof e.hash === 'string') : [];
  } catch {
    return [];
  }
};
const promotedAlready = (promotions, source, hash) => promotions.some((e) => e.source === source && e.hash === hash);
const rememberPromotion = (vault, source, target, hash) => {
  const promotions = readPromotions(vault).filter((e) => e.source !== source);
  promotions.push({ source, target, hash, at: new Date().toISOString() });
  mkdirSync(dirname(promotionPath(vault)), { recursive: true });
  writeFileSync(promotionPath(vault), JSON.stringify(promotions, null, 2));
};
/** Compiled copies are listed vault-relative ('inbox/_compiled/…') or inbox-relative. */
const vaultFile = (vault, rel) => join(vault, rel.startsWith('inbox/') ? rel : join('inbox', rel));
const compiledHashAt = (vault, rel) => {
  try {
    return compiledHashOf(readFileSync(vaultFile(vault, rel), 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * The queue engines need a plain vault filesystem: they write queue files under inbox/ and,
 * when a link is approved, append to the source note itself (they keep their own backups).
 */
const queueFs = (vault) => ({
  listFiles: async () => {
    const out = [];
    const walk = (dir, prefix, depth) => {
      if (depth > 8 || out.length >= 6000) return;
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= 6000) return;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
        if (entry.isDirectory()) {
          walk(full, rel, depth + 1);
        } else if (entry.name.toLowerCase().endsWith('.md')) {
          let stat = { mtimeMs: 0 };
          try {
            stat = statSync(full);
          } catch {
            // unreadable file: still listed so the engine can skip it
          }
          out.push({ relPath: rel, modifiedMs: stat.mtimeMs });
        }
      }
    };
    walk(vault, '', 0);
    return out;
  },
  readText: async (rel) => readFileSync(join(vault, rel), 'utf8'),
  writeText: async (rel, content) => {
    const full = join(vault, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  },
  exists: async (rel) => existsSync(join(vault, rel)),
  remove: async (rel) => {
    try {
      unlinkSync(join(vault, rel));
    } catch {
      // already gone
    }
  },
});

const QUEUE_DIRS = { links: 'inbox/links', review: 'inbox/review' };
const ARCHIVE_DIR = '.wiki/queue-archive';
const escapeQueueCell = (value) => String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
const noteOfQueue = (text) => {
  const match = /^note:\s*(.+)$/m.exec(text);
  return match === null ? '' : match[1].trim().replace(/^['"]|['"]$/g, '');
};
/** One queue file as the UI needs it: the source note, its rows, and how many still wait for a human. */
const readQueueFile = (vault, kind, rel) => {
  const text = readFileSync(join(vault, rel), 'utf8');
  if (kind === 'links') {
    const queue = parseQueue(rel, text);
    return {
      kind,
      path: rel,
      note: queue.note,
      generated: queue.generated,
      rows: queue.rows.map((row) => ({
        target: row.target,
        confidence: row.confidence,
        direction: row.direction,
        why: row.why,
        applied: row.applied,
      })),
      pending: queue.rows.filter((row) => !row.applied && row.why.trim() === '').length,
    };
  }
  const rows = parseReviewQueue(text);
  return {
    kind,
    path: rel,
    note: noteOfQueue(text),
    generated: '',
    rows: rows.map((row) => ({
      oldPath: row.oldPath,
      oldName: row.oldName,
      score: row.score,
      oldText: row.oldText,
      newText: row.newText,
      verdict: row.verdict,
      basis: row.basis,
    })),
    pending: rows.filter((row) => {
      const verdict = row.verdict.trim();
      return verdict === '' || verdict === '待复核';
    }).length,
    conflicts: rows.filter((row) => row.verdict.trim() === '冲突').length,
    nli: rows.filter((row) => row.verdict.trim() === '待复核').length,
  };
};
const listQueues = (vault, kind) => {
  const dir = QUEUE_DIRS[kind];
  if (dir === undefined) return [];
  const base = join(vault, dir);
  if (!existsSync(base)) return [];
  const out = [];
  for (const name of readdirSync(base)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    try {
      out.push(readQueueFile(vault, kind, dir + '/' + name));
    } catch {
      // unreadable queue: leave it out instead of failing the whole list
    }
  }
  return out
    .filter((queue) => queue.rows.length > 0)
    .sort((left, right) => right.pending - left.pending || left.path.localeCompare(right.path));
};
/** Rewrite one review row's 判定/依据 cells in place, leaving every other byte of the table alone. */
const patchReviewRow = (text, index, verdict, basis) => {
  const lines = text.split(/\r?\n/);
  let seen = 0;
  for (let line = 0; line < lines.length; line += 1) {
    const trimmed = (lines[line] ?? '').trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
    if (cells.length < 6) continue;
    if ((cells[0] ?? '').includes('旧笔记')) continue;
    if (/^-+$/.test((cells[0] ?? '').replace(/\s/g, ''))) continue;
    if (seen === index) {
      const next = [cells[0], cells[1], cells[2], cells[3], escapeQueueCell(verdict), escapeQueueCell(basis)].concat(cells.slice(6));
      lines[line] = '| ' + next.join(' | ') + ' |';
      return lines.join('\n');
    }
    seen += 1;
  }
  return undefined;
};

const readBody = async (req) => {
  let body = '';
  for await (const part of req) body += part;
  return body;
};

let DEFAULT_VAULT = process.env.KB_VAULT ?? 'D:/JingYu/Desktop/ai-brain/MyObsidian';
let PROMOTE_DIR = process.env.KB_PROMOTE_DIR ?? '';
const PORT = Number(process.env.KB_UI_PORT ?? 7341);
const pageFile = fileURLToPath(new URL('./kb-ui.html', import.meta.url));
const page = () => readFileSync(pageFile, 'utf8');

/**
 * One workspace, one vault: the nearest .dsh-kb.json above the open file (or the workspace
 * directory) wins; KB_VAULT is the explicit override; otherwise the default vault.
 */
const bindingAt = (dir) => {
  try {
    const config = JSON.parse(readFileSync(join(dir, '.dsh-kb.json'), 'utf8'));
    if (typeof config.vault === 'string' && config.vault.trim() !== '') return join(dir, config.vault);
  } catch {
    // no binding at this level
  }
  return undefined;
};
const vaultFor = (start) => {
  if (process.env.KB_VAULT) return process.env.KB_VAULT;
  if (start) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      const bound = bindingAt(dir);
      if (bound !== undefined) return bound;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return DEFAULT_VAULT;
};
const fsFor = (vault) => ({
  root: vault,
  exists: async (rel) => existsSync(join(vault, rel)),
  readText: async (rel) => readFileSync(join(vault, rel), 'utf8'),
  // The notes layer lists markdown at query time; it needs bytes/mtime only as a cache key.
  listFiles: async () => {
    const out = [];
    const walk = (dir, prefix, depth) => {
      if (depth > 8 || out.length >= 6000) return;
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= 6000) return;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
        if (entry.isDirectory()) {
          walk(full, rel, depth + 1);
        } else if (entry.name.toLowerCase().endsWith('.md')) {
          let stat = { size: 0, mtimeMs: 0 };
          try {
            stat = statSync(full);
          } catch {
            // unreadable file: still list it so the layer can skip it
          }
          out.push({ relPath: rel, bytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() });
        }
      }
    };
    walk(vault, '', 0);
    return out;
  },
});

/** Markdown notes under the vault, skipping dot-directories and the index itself. */
const listNotes = (vault, limit = 3000) => {
  const notes = [];
  const walk = (dir, depth) => {
    if (depth > 8 || notes.length >= limit) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (notes.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full, depth + 1);
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        notes.push(full.slice(vault.length).replace(/^[\\/]/, '').split('\\').join('/'));
      }
    }
  };
  walk(vault, 0);
  notes.sort();
  return notes;
};

/** Resolve a vault-relative path and refuse anything that escapes the vault. */
/** Wikilinks ([[Target]], [[Target|alias]], [[Target#heading]]) in note order. */
const wikiLinks = (text) => [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim()).filter((s) => s !== '');

const stemOf = (name) => name.replace(/\.[^.]+$/, '');

const noteIndex = (notes, files) => {
  const byPath = new Set(notes);
  const noteByStem = new Map();
  for (const p of notes) {
    const stem = stemOf(p.split('/').pop());
    if (!noteByStem.has(stem)) noteByStem.set(stem, p);
  }
  const fileByPath = new Set(files);
  const fileByName = new Map();
  for (const f of files) {
    const base = f.split('/').pop();
    if (!fileByName.has(base)) fileByName.set(base, f);
  }
  return { byPath, noteByStem, fileByPath, fileByName };
};

/**
 * Resolve a wikilink the way Obsidian does: a note path, an attachment ([[x.pdf]]),
 * or an extension-less link that matches a note or attachment stem.
 */
const resolveLink = (index, raw) => {
  if (index.byPath.has(raw)) return { path: raw, kind: 'note' };
  if (index.fileByPath.has(raw)) {
    // [[x.pdf]] next to x.md is Obsidian's note+attachment pattern: treat it as the note.
    const fileStem = stemOf(raw.split('/').pop());
    if (index.noteByStem.has(fileStem)) return { path: index.noteByStem.get(fileStem), kind: 'note' };
    return { path: raw, kind: 'file' };
  }
  const base = raw.split('/').pop();
  const hasExt = /\.[^.]+$/.test(base);
  const stem = stemOf(base);
  if (index.noteByStem.has(stem)) return { path: index.noteByStem.get(stem), kind: 'note' };
  if (hasExt && index.fileByName.has(base)) return { path: index.fileByName.get(base), kind: 'file' };
  if (index.fileByName.has(stem)) return { path: index.fileByName.get(stem), kind: 'file' };
  return null;
};

/** Vault-relative paths of every file (attachments included), skipping dot dirs. */
const listFiles = (vault, limit = 5000) => {
  const out = [];
  const walk = (dir, prefix, depth) => {
    if (depth > 8 || out.length >= limit) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel, depth + 1);
      else out.push(rel);
    }
  };
  walk(vault, '', 0);
  return out.sort();
};

const notePath = (vault, relative) => {
  const root = resolve(vault);
  const full = resolve(root, relative);
  if (!full.startsWith(root + sep) || !full.toLowerCase().endsWith('.md')) return undefined;
  return full;
};
const { runQuery } = await import('../dist/application/kb-query.js');

const createUiServer = () => createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  try {
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', page());
    if (url.pathname === '/api/query') {
      const q = url.searchParams.get('q') ?? '';
      const k = Math.min(20, Math.max(1, Number(url.searchParams.get('k') ?? 8)));
      const fs = fsFor(vaultFor(url.searchParams.get('address') || url.searchParams.get('workspace') || ''));
      const notes = url.searchParams.get('notes') === '1';
      const notesLimit = Math.min(10, Math.max(1, Number(url.searchParams.get('notesLimit') ?? 5)));
      return send(200, 'application/json', JSON.stringify(await runQuery(fs, q, k, { notesLayer: notes, notesLimit })));
    }
    if (url.pathname === '/api/section') {
      const path = url.searchParams.get('path') ?? '';
      const fs = fsFor(vaultFor(url.searchParams.get('address') || url.searchParams.get('workspace') || ''));
      const result = await runQuery(fs, path.split('/').pop() ?? '', 1, { expand: 'section' });
      const hit = result.hits[0];
      return send(200, 'application/json', JSON.stringify({ ok: true, context: hit?.context ?? '（没有找到这一章）' }));
    }
    if (url.pathname === '/api/notes') {
      const vault = vaultFor(url.searchParams.get('address') || '');
      return send(200, 'application/json', JSON.stringify({ ok: true, vault, notes: listNotes(vault) }));
    }
    if (url.pathname === '/api/drafts') {
      const vault = vaultFor(url.searchParams.get('address') || '');
      const inbox = new NodeInboxFs(vault);
      const listed = (await inbox.listDrafts()).filter((p) => !p.startsWith('_compiled/'));
      const drafts = [];
      for (const draft of listed) {
        if (!(await compiledUpToDate(inbox, draft))) drafts.push(draft);
      }
      let compiled = [];
      if (PROMOTE_DIR !== '') {
        try {
          compiled = [...(await new NodePromoteFs(vault, PROMOTE_DIR).listCompiled())];
        } catch {
          compiled = [];
        }
      }
      const promotions = readPromotions(vault);
      compiled = compiled.filter((rel) => {
        const hash = compiledHashAt(vault, rel);
        return hash === undefined || !promotedAlready(promotions, rel, hash);
      });
      return send(200, 'application/json', JSON.stringify({ ok: true, drafts, compiled, promoteDir: PROMOTE_DIR }));
    }
    if (url.pathname === '/api/queues') {
      const vault = vaultFor(url.searchParams.get('address') || '');
      const kind = url.searchParams.get('kind') ?? '';
      if (kind === 'links' || kind === 'review') {
        return send(200, 'application/json', JSON.stringify({ ok: true, kind, queues: listQueues(vault, kind) }));
      }
      return send(200, 'application/json', JSON.stringify({
        ok: true,
        links: listQueues(vault, 'links'),
        review: listQueues(vault, 'review'),
      }));
    }
    if (url.pathname === '/api/queue/link/why' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const rel = String(parsed.path ?? '');
      if (!rel.startsWith(QUEUE_DIRS.links + '/')) {
        return send(400, 'application/json', JSON.stringify({ ok: false, error: 'not a link queue' }));
      }
      const index = Number(parsed.index ?? -1);
      try {
        const queue = parseQueue(rel, readFileSync(join(vault, rel), 'utf8'));
        if (!Number.isInteger(index) || index < 0 || index >= queue.rows.length) {
          return send(400, 'application/json', JSON.stringify({ ok: false, error: 'row index out of range' }));
        }
        const why = String(parsed.why ?? '').trim();
        const rows = queue.rows.map((row, at) => (at === index ? { ...row, why } : row));
        writeFileSync(join(vault, rel), renderQueue({ note: queue.note, generated: queue.generated, rows }));
        return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, index, why }));
      } catch (error) {
        return send(500, 'application/json', JSON.stringify({ ok: false, error: String(error.message).slice(0, 160) }));
      }
    }
    if (url.pathname === '/api/queue/link/apply' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const rel = String(parsed.path ?? '');
      if (rel !== '' && !rel.startsWith(QUEUE_DIRS.links + '/')) {
        return send(400, 'application/json', JSON.stringify({ ok: false, error: 'not a link queue' }));
      }
      const report = await applyLinks(queueFs(vault), vault, {
        ...(rel === '' ? {} : { queue: rel }),
        confirm: parsed.confirm !== false,
      });
      return send(200, 'application/json', JSON.stringify(report));
    }
    if (url.pathname === '/api/queue/review/verdict' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const rel = String(parsed.path ?? '');
      if (!rel.startsWith(QUEUE_DIRS.review + '/')) {
        return send(400, 'application/json', JSON.stringify({ ok: false, error: 'not a review queue' }));
      }
      const index = Number(parsed.index ?? -1);
      try {
        const text = readFileSync(join(vault, rel), 'utf8');
        const next = patchReviewRow(text, index, String(parsed.verdict ?? ''), String(parsed.basis ?? ''));
        if (next === undefined) {
          return send(400, 'application/json', JSON.stringify({ ok: false, error: 'row index out of range' }));
        }
        writeFileSync(join(vault, rel), next);
        return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, index }));
      } catch (error) {
        return send(500, 'application/json', JSON.stringify({ ok: false, error: String(error.message).slice(0, 160) }));
      }
    }
    if (url.pathname === '/api/queue/scan' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const kind = String(parsed.kind ?? 'links');
      // Claim scans read the whole corpus cheaply; link scans stay bounded.
      const cap = kind === 'links' ? 50 : 2000;
      const limit = Math.min(cap, Math.max(1, Number(parsed.limit ?? 5)));
      const note = typeof parsed.note === 'string' && parsed.note.trim() !== '' ? parsed.note.trim() : undefined;
      if (kind === 'links') {
        const report = await reviewLinks(queueFs(vault), vault, {
          write: true,
          limit,
          ...(note === undefined ? {} : { note }),
        });
        return send(200, 'application/json', JSON.stringify({
          ok: true,
          kind,
          notes: report.notes,
          candidates: report.candidates,
          rejected: report.rejected,
          queues: report.queues.length,
          warnings: report.warnings,
        }));
      }
      const claimMode = parsed.mode === 'similar' ? 'similar' : 'claims';
      const report = await reviewNotes(queueFs(vault), vault, {
        write: true,
        limit,
        claimMode,
        ...(note === undefined ? {} : { note }),
      });
      const touched = new Set(report.queues.map((queue) => queue.path));
      const items = listQueues(vault, 'review').filter((queue) => touched.has(queue.path));
      return send(200, 'application/json', JSON.stringify({
        ok: true,
        kind: 'review',
        mode: claimMode,
        notes: report.notes,
        pending: items.reduce((total, queue) => total + queue.pending, 0),
        rows: items.reduce((total, queue) => total + queue.rows.length, 0),
        nli: items.reduce((total, queue) => total + queue.nli, 0),
        queues: items.length,
        empty: report.queues.filter((queue) => queue.rows.length === 0).length,
        items,
        warnings: report.warnings,
      }));
    }
    if (url.pathname === '/api/queue/judge' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const only = String(parsed.path ?? '');
      const dir = join(vault, QUEUE_DIRS.review);
      const targets = only !== ''
        ? (only.startsWith(QUEUE_DIRS.review + '/') ? [only] : [])
        : (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => QUEUE_DIRS.review + '/' + name) : []);
      const counts = { judged: 0, conflicts: 0, irrelevant: 0, refined: 0, pending: 0 };
      let touched = 0;
      for (const rel of targets) {
        try {
          const file = readQueueFile(vault, 'review', rel);
          let text = readFileSync(join(vault, rel), 'utf8');
          let changed = false;
          file.rows.forEach((row, index) => {
            const verdict = row.verdict.trim();
            if (verdict !== '' && verdict !== '待复核') return;
            const outcome = judgePair(row.oldText, row.newText);
            counts.judged += 1;
            if (outcome.verdict === '冲突') counts.conflicts += 1;
            else if (outcome.verdict === '无关') counts.irrelevant += 1;
            else if (outcome.verdict === '细化') counts.refined += 1;
            else { counts.pending += 1; return; }
            const next = patchReviewRow(text, index, outcome.verdict, outcome.basis);
            if (next !== undefined) { text = next; changed = true; }
          });
          if (changed) { writeFileSync(join(vault, rel), text); touched += 1; }
        } catch { /* a broken queue must not stop the rest */ }
      }
      return send(200, 'application/json', JSON.stringify({
        ok: true,
        queues: touched,
        ...counts,
        items: listQueues(vault, 'review'),
      }));
    }
    if (url.pathname === '/api/queue/pending') {
      const vault = vaultFor(url.searchParams.get('address') || '');
      const cap = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 40)));
      const queues = [];
      let total = 0;
      for (const queue of listQueues(vault, 'review')) {
        const rows = [];
        queue.rows.forEach((row, index) => {
          const verdict = row.verdict.trim();
          if (verdict !== '' && verdict !== '待复核') return;
          total += 1;
          if (rows.length >= cap) return;
          rows.push({
            index,
            oldName: row.oldName,
            oldText: String(row.oldText).slice(0, 400),
            newText: String(row.newText).slice(0, 400),
          });
        });
        if (rows.length > 0) queues.push({ path: queue.path, note: queue.note, rows });
      }
      return send(200, 'application/json', JSON.stringify({
        ok: true,
        total,
        queued: queues.reduce((count, queue) => count + queue.rows.length, 0),
        queues,
      }));
    }
    // The model stage: an attached agent posts its verdicts here in one batch, so a
    // whole queue is settled with one round trip instead of one write per row.
    if (url.pathname === '/api/queue/judge/agent' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const allowed = new Set(['冲突', '细化', '无关']);
      const byPath = new Map();
      for (const item of Array.isArray(parsed.verdicts) ? parsed.verdicts : []) {
        const rel = String(item.path ?? '');
        if (!rel.startsWith(QUEUE_DIRS.review + '/')) continue;
        const verdict = String(item.verdict ?? '').trim();
        if (!allowed.has(verdict)) continue;
        const index = Number(item.index ?? -1);
        if (!Number.isInteger(index) || index < 0) continue;
        if (!byPath.has(rel)) byPath.set(rel, []);
        byPath.get(rel).push({ index, verdict, basis: String(item.basis ?? '').trim().slice(0, 300) });
      }
      let applied = 0;
      const failed = [];
      for (const [rel, items] of byPath) {
        try {
          let text = readFileSync(join(vault, rel), 'utf8');
          for (const item of items.sort((left, right) => left.index - right.index)) {
            const next = patchReviewRow(text, item.index, item.verdict, item.basis);
            if (next === undefined) { failed.push(rel + '#' + item.index); continue; }
            text = next;
            applied += 1;
          }
          writeFileSync(join(vault, rel), text);
        } catch (error) {
          failed.push(rel + ': ' + String(error.message).slice(0, 80));
        }
      }
      return send(200, 'application/json', JSON.stringify({ ok: true, applied, failed, items: listQueues(vault, 'review') }));
    }
    if (url.pathname === '/api/queue/archive' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const kind = String(parsed.kind ?? '');
      const rel = String(parsed.path ?? '');
      const dir = QUEUE_DIRS[kind];
      if (dir === undefined || !rel.startsWith(dir + '/')) {
        return send(400, 'application/json', JSON.stringify({ ok: false, error: 'not a queue path' }));
      }
      try {
        const file = readQueueFile(vault, kind, rel);
        if (file.pending > 0 && parsed.force !== true) {
          return send(409, 'application/json', JSON.stringify({ ok: false, error: '还有 ' + file.pending + ' 条待处理；全部填完或传 force 才能归档', pending: file.pending }));
        }
        const name = rel.slice(dir.length + 1);
        const target = ARCHIVE_DIR + '/' + kind + '/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + name;
        mkdirSync(dirname(join(vault, target)), { recursive: true });
        renameSync(join(vault, rel), join(vault, target));
        return send(200, 'application/json', JSON.stringify({ ok: true, from: rel, to: target }));
      } catch (error) {
        return send(500, 'application/json', JSON.stringify({ ok: false, error: String(error.message).slice(0, 160) }));
      }
    }
    if (url.pathname === '/api/possible') {
      const vault = vaultFor(url.searchParams.get('address') || '');
      const rel = (url.searchParams.get('path') ?? '').trim();
      if (rel === '') return send(400, 'application/json', JSON.stringify({ ok: false, error: 'path required' }));
      try {
        const qfs = queueFs(vault);
        if (!(await qfs.exists(rel))) return send(404, 'application/json', JSON.stringify({ ok: false, error: 'note not found: ' + rel }));
        const started = Date.now();
        const raw = await qfs.readText(rel);
        const prose = raw
          .replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
          .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
          .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
          .replace(/!\[\[[^\]]*\]\]/g, ' ')
          .replace(/https?:\/\/\S+/gi, ' ')
          .trim();
        if (prose.length < 30) return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, rows: [], reason: '这篇笔记几乎没有正文（只有代码或图片），没有可比较的内容，算不出候选。', elapsedMs: Date.now() - started }));
        const suggestion = await suggestLinks(qfs, vault, { note: rel, limit: 5000, minScore: 0.25, perNote: 12 });
        const byName = new Map();
        for (const entry of await qfs.listFiles()) {
          if (!/\.md$/i.test(entry.relPath)) continue;
          const name = (entry.relPath.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase();
          if (name !== '' && !byName.has(name)) byName.set(name, entry.relPath);
        }
        const currentName = (rel.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase();
        const rows = [];
        for (const item of suggestion.suggestions) {
          if (item.from !== rel) continue;
          if (rows.length >= 12) break;
          const name = item.to.trim().toLowerCase();
          const targetPath = byName.get(name);
          if (targetPath === undefined || targetPath === rel) continue;
          if (name === currentName) continue;
          if (/^inbox\//i.test(targetPath) || /^(copilot|\.agents|\.claude|\.wiki)\//i.test(targetPath)) continue;
          const stem = (targetPath.split('/').pop() ?? '').replace(/\.md$/i, '');
          rows.push({ target: stem, path: targetPath, title: item.to, confidence: Math.round(item.confidence * 1000) / 1000, why: item.why, direction: '', warning: '' });
        }
        return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, rows, warnings: [], elapsedMs: Date.now() - started }));
      } catch (error) {
        return send(500, 'application/json', JSON.stringify({ ok: false, error: String(error.message).slice(0, 160) }));
      }
    }
    if (url.pathname === '/api/possible/apply' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const rel = String(parsed.path ?? '').trim();
      const target = String(parsed.target ?? '').trim();
      const why = String(parsed.why ?? '').trim();
      if (rel === '' || target === '') return send(400, 'application/json', JSON.stringify({ ok: false, error: 'path and target required' }));
      if (why === '') return send(400, 'application/json', JSON.stringify({ ok: false, error: 'why required' }));
      try {
        const fs = queueFs(vault);
        const text = await fs.readText(rel);
        const next = appendAssociation(text, target, why);
        if (next === text) return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, target, why, unchanged: true }));
        const backup = backupPathFor(new Date(), rel);
        await fs.writeText(backup, text);
        await fs.writeText(rel, next);
        return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, target, why, backup, unchanged: false }));
      } catch (error) {
        return send(500, 'application/json', JSON.stringify({ ok: false, error: String(error.message).slice(0, 160) }));
      }
    }
    if (url.pathname === '/api/draft') {
      const vault = vaultFor(url.searchParams.get('address') || '');
      const rel = url.searchParams.get('path') ?? '';
      try {
        return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, text: await new NodeInboxFs(vault).readText(inboxRelative(rel)) }));
      } catch (error) {
        return send(404, 'application/json', JSON.stringify({ ok: false, error: String(error.message).slice(0, 120) }));
      }
    }
    if (url.pathname === '/api/compile' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const report = await runCompile(new NodeInboxFs(vault), vault, { paths: parsed.paths, dryRun: parsed.dryRun === true, force: parsed.force === true });
      return send(200, 'application/json', JSON.stringify(report));
    }
    if (url.pathname === '/api/promote' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      const vault = vaultFor(url.searchParams.get('address') || '');
      const promoteDir = PROMOTE_DIR;
      if (promoteDir === '') {
        return send(400, 'application/json', JSON.stringify({ ok: false, error: 'KB_PROMOTE_DIR is not configured (promoteDir)' }));
      }
      const report = await runPromote(new NodePromoteFs(vault, promoteDir), vault, promoteDir, {
        source: parsed.source,
        confirm: parsed.confirm === true,
        force: parsed.force === true,
      });
      if (parsed.confirm === true) {
        for (const note of report.notes ?? []) {
          if (note.error || !['create', 'update', 'unchanged'].includes(note.status)) continue;
          const hash = compiledHashAt(vault, note.source);
          if (hash !== undefined) rememberPromotion(vault, note.source, note.target, hash);
        }
      }
      return send(200, 'application/json', JSON.stringify(report));
    }
    if (url.pathname === '/api/links') {
      const vault = vaultFor(url.searchParams.get('address') || '');
      const rel = url.searchParams.get('path') ?? '';
      const full = notePath(vault, rel);
      if (full === undefined || !existsSync(full)) {
        return send(404, 'application/json', JSON.stringify({ ok: false, error: 'note not found' }));
      }
      const notes = listNotes(vault);
      const index = noteIndex(notes, listFiles(vault));
      const stem = stemOf(rel.split('/').pop());
      const out = wikiLinks(readFileSync(full, 'utf8')).map((raw) => {
        const hit = resolveLink(index, raw);
        return { raw, path: hit?.path ?? null, kind: hit?.kind ?? 'broken' };
      });
      const broken = out.filter((link) => link.path === null).map((link) => link.raw);
      const back = [];
      for (const other of notes) {
        if (other === rel) continue;
        try {
          const links = wikiLinks(readFileSync(join(vault, other), 'utf8'));
          const hit = links.map((raw) => resolveLink(index, raw)).some((resolved) => {
            if (resolved === null) return false;
            if (resolved.kind === 'note') return resolved.path === rel;
            // A link to an attachment of the same name counts as a link to the note.
            return stemOf(resolved.path.split('/').pop()) === stem;
          });
          if (hit) back.push(other);
        } catch {
          // unreadable note: skip
        }
      }
      return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, out, back, broken }));
    }
    if (url.pathname === '/api/note') {
      const vault = vaultFor(url.searchParams.get('address') || '');
      const rel = url.searchParams.get('path') ?? '';
      const full = notePath(vault, rel);
      if (full === undefined || !existsSync(full)) {
        return send(404, 'application/json', JSON.stringify({ ok: false, error: 'note not found' }));
      }
      return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, text: readFileSync(full, 'utf8'), mtime: statSync(full).mtimeMs }));
    }
    if (url.pathname === '/api/save' && req.method === 'POST') {
      let body = '';
      for await (const part of req) body += part;
      const parsed = JSON.parse(body);
      const vault = vaultFor(url.searchParams.get('address') || '');
      const full = notePath(vault, String(parsed.path ?? ''));
      if (full === undefined) {
        return send(400, 'application/json', JSON.stringify({ ok: false, error: 'invalid path' }));
      }
      // Someone (Obsidian, another editor) may have written the file since it was opened.
      if (typeof parsed.mtime === 'number' && existsSync(full) && Math.abs(statSync(full).mtimeMs - parsed.mtime) > 1) {
        return send(409, 'application/json', JSON.stringify({ ok: false, code: 'conflict', path: parsed.path, text: readFileSync(full, 'utf8'), mtime: statSync(full).mtimeMs }));
      }
      // Keep a copy before overwriting: .wiki/backups/<time>-<flattened path>.md
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = join(vault, '.wiki/backups', stamp + '-' + String(parsed.path).split('/').join('__'));
      mkdirSync(dirname(backup), { recursive: true });
      if (existsSync(full)) writeFileSync(backup, readFileSync(full));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, String(parsed.text ?? ''), 'utf8');
      return send(200, 'application/json', JSON.stringify({ ok: true, path: parsed.path, mtime: statSync(full).mtimeMs, backup }));
    }
    return send(404, 'text/plain', 'not found');
  } catch (error) {
    return send(500, 'application/json', JSON.stringify({ ok: false, error: String(error) }));
  }
});

/**
 * Start the UI server inside the caller's process (the plugin host), so it lives exactly
 * as long as DSH does instead of leaving a detached process behind.
 */
export function startUiServer(options = {}) {
  if (options.vault) DEFAULT_VAULT = resolve(String(options.vault));
  if (options.promoteDir !== undefined) PROMOTE_DIR = String(options.promoteDir);
  const port = Number(options.port ?? PORT);
  const server = createUiServer();
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const bound = server.address();
      const actual = typeof bound === 'object' && bound !== null ? bound.port : port;
      console.log('kb-ui on http://127.0.0.1:' + actual);
      resolvePromise(server);
    });
  });
}

// Direct run: node scripts/kb-ui.mjs
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startUiServer().catch((error) => {
    console.error('kb-ui failed:', error);
    process.exitCode = 1;
  });
}
