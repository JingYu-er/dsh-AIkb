import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_VAULT = process.env.KB_VAULT ?? 'D:/JingYu/Desktop/ai-brain/MyObsidian';
const PORT = Number(process.env.KB_UI_PORT ?? 7317);
const page = readFileSync(fileURLToPath(new URL('./kb-ui.html', import.meta.url)), 'utf8');

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
const { runQuery } = await import('../dist/application/kb-query.js');

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  try {
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', page);
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
    return send(404, 'text/plain', 'not found');
  } catch (error) {
    return send(500, 'application/json', JSON.stringify({ ok: false, error: String(error) }));
  }
}).listen(PORT, '127.0.0.1', () => console.log('kb-ui on http://127.0.0.1:' + PORT));
