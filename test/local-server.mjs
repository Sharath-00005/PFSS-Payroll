// Run the same API locally without Netlify, backed by a SQLite file. Needs Node 22.13+.
//   npm run local            -> http://localhost:8888  (data in ./local-data/payroll.db)
// SETUP_KEY defaults to "local-setup" here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../netlify/lib/core.mjs';
import { createStore } from '../netlify/lib/store.mjs';
import { sqliteAdapter } from '../netlify/lib/sqlite-adapter.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'public');
const PORT = Number(process.env.PORT) || 8888;
const dataDir = process.env.DATA_DIR || path.join(root, 'local-data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.SETUP_KEY = process.env.SETUP_KEY || 'local-setup';

const handle = createApi({ store: createStore(sqliteAdapter(path.join(dataDir, 'payroll.db'))) });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), { ip: req.socket.remoteAddress });
    const headers = {};
    r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (setCookie.length) headers['set-cookie'] = setCookie;
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`PFSS Payroll (local test mode) on http://localhost:${PORT}  setup key: ${process.env.SETUP_KEY}`));
