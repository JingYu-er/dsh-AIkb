import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_VAULT = process.env.KB_VAULT ?? 'D:/JingYu/Desktop/ai-brain/MyObsidian';
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
  if (index.fileByPath.has(raw)) return { path: raw, kind: 'file' };
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

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  try {
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', page());
    if (url.pathname === '/api/query') {
      const q = url.searchParams.get('q') ?? '';
      const k = Math.min(20, Math.max(1, Number(url.searchParams.get('k') ?? 8)));
      const fs = fsFor(vaultFor(url.searchParams.get('address') || url.searchParams.get('workspace') || ''));
      return send(200, 'application/json', JSON.stringify(await runQuery(fs, q, k, {})));
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
}).listen(PORT, '127.0.0.1', () => console.log('kb-ui on http://127.0.0.1:' + PORT));
