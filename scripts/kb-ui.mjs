import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_VAULT = process.env.KB_VAULT ?? 'D:/JingYu/Desktop/ai-brain/MyObsidian';
const PORT = Number(process.env.KB_UI_PORT ?? 7317);
const page = readFileSync(fileURLToPath(new URL('./kb-ui.html', import.meta.url)), 'utf8');

/** One workspace, one vault: <workspace>/.dsh-kb.json {"vault": "..."} wins, then KB_VAULT. */
const vaultFor = (workspace) => {
  if (process.env.KB_VAULT) return process.env.KB_VAULT;
  if (workspace) {
    try {
      const config = JSON.parse(readFileSync(join(workspace, '.dsh-kb.json'), 'utf8'));
      if (typeof config.vault === 'string' && config.vault.trim() !== '') return join(workspace, config.vault);
    } catch {
      // no per-workspace binding: fall back to the default vault
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
      const fs = fsFor(vaultFor(url.searchParams.get('workspace') ?? ''));
      return send(200, 'application/json', JSON.stringify(await runQuery(fs, q, k, {})));
    }
    if (url.pathname === '/api/section') {
      const path = url.searchParams.get('path') ?? '';
      const fs = fsFor(vaultFor(url.searchParams.get('workspace') ?? ''));
      const result = await runQuery(fs, path.split('/').pop() ?? '', 1, { expand: 'section' });
      const hit = result.hits[0];
      return send(200, 'application/json', JSON.stringify({ ok: true, context: hit?.context ?? '（没有找到这一章）' }));
    }
    return send(404, 'text/plain', 'not found');
  } catch (error) {
    return send(500, 'application/json', JSON.stringify({ ok: false, error: String(error) }));
  }
}).listen(PORT, '127.0.0.1', () => console.log('kb-ui on http://127.0.0.1:' + PORT));
