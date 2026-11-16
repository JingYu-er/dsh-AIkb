import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const distUrl = (rel) => new URL('../dist/' + rel, import.meta.url).href;
const { NodeInboxFs } = await import(distUrl('adapters/fs/inbox-fs.js'));
const { NodePromoteFs } = await import(distUrl('adapters/fs/promote-fs.js'));
const { runCompile } = await import(distUrl('application/kb-compile.js'));
const { runPromote } = await import(distUrl('application/kb-promote.js'));

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
      const drafts = (await inbox.listDrafts()).filter((p) => !p.startsWith('_compiled/'));
      let compiled = [];
      if (PROMOTE_DIR !== '') {
        try {
          compiled = [...(await new NodePromoteFs(vault, PROMOTE_DIR).listCompiled())];
        } catch {
          compiled = [];
        }
      }
      return send(200, 'application/json', JSON.stringify({ ok: true, drafts, compiled, promoteDir: PROMOTE_DIR }));
    }
    if (url.pathname === '/api/draft') {
      const vault = vaultFor(url.searchParams.get('address') || '');
      const rel = url.searchParams.get('path') ?? '';
      try {
        return send(200, 'application/json', JSON.stringify({ ok: true, path: rel, text: await new NodeInboxFs(vault).readText(rel) }));
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
