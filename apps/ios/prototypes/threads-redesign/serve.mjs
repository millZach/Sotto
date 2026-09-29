// Local-only server for this throwaway prototype and Sotto's bundled font.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const base = '/apps/ios/prototypes/threads-redesign/';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const name = url.pathname === '/' ? base + 'index.html' : decodeURIComponent(url.pathname);
  if (!(name.startsWith(base) || name.startsWith('/src/renderer/src/assets/fonts/'))) { response.writeHead(404).end(); return; }
  const target = path.resolve(root, '.' + name);
  if (!target.startsWith(root + path.sep) && target !== root) { response.writeHead(404).end(); return; }
  try { const data = await readFile(target); response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(data); }
  catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}${base}index.html?variant=A`));
