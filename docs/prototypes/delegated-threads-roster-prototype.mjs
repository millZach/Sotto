// PROTOTYPE, throwaway: answers how delegated threads sit in Tools › Agents.
// Local fixture-only preview. No application data, provider bridge or external requests.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { stdout } from 'node:process'
import { URL } from 'node:url'

const PORT = Number(process.env.PORT ?? 4331)
const routes = new Map([
  ['/', [new URL('./delegated-threads-roster-prototype.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/src/renderer/src/styles/tokens.css', [new URL('../../src/renderer/src/styles/tokens.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/src/shared/fonts/figtree-latin.woff2', [new URL('../../src/shared/fonts/figtree-latin.woff2', import.meta.url), 'font/woff2']],
  ['/src/shared/fonts/figtree-latin-ext.woff2', [new URL('../../src/shared/fonts/figtree-latin-ext.woff2', import.meta.url), 'font/woff2']],
])
createServer(async (req, res) => {
  const route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
  if (!route) { res.writeHead(404); res.end(); return }
  try {
    const body = await readFile(route[0])
    res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' })
    res.end(body)
  } catch { res.writeHead(500); res.end('Could not read the prototype.') }
}).listen(PORT, '127.0.0.1', () => stdout.write(`Delegated threads mock-up: http://127.0.0.1:${PORT}/\n`))
