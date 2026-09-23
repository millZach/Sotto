// Throwaway #206 fixture server. Only these static assets are served, on loopback.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { stdout } from 'node:process'
import { URL } from 'node:url'

const routes = new Map([
  ['/', [new URL('./hosts-add-prototype.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/src/renderer/src/styles/tokens.css', [new URL('../../src/renderer/src/styles/tokens.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/src/renderer/src/assets/fonts/figtree-latin.woff2', [new URL('../../src/renderer/src/assets/fonts/figtree-latin.woff2', import.meta.url), 'font/woff2']],
])
createServer(async (req, res) => {
  const route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
  if (!route) { res.writeHead(404); res.end(); return }
  try {
    const body = await readFile(route[0])
    res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' })
    res.end(body)
  } catch { res.writeHead(500); res.end('Could not read the prototype.') }
}).listen(4331, '127.0.0.1', () => stdout.write('Hosts prototype (#206): http://127.0.0.1:4331/?variant=A\n'))
