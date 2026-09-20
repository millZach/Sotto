// Throwaway, local-only preview. Run: node docs/prototypes/process-creature-prototype.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { stdout } from 'node:process'

const routes = new Map([
  ['/', ['./process-creature-prototype.html', 'text/html; charset=utf-8']],
  ['/reference', ['./effort-slider-prototype.html', 'text/html; charset=utf-8']],
  ['/reference.png', ['../../artifacts/design/app-review/baseline/threads-populated.png', 'image/png']],
  ['/src/renderer/src/assets/fonts/figtree-latin.woff2', ['../../src/renderer/src/assets/fonts/figtree-latin.woff2', 'font/woff2']],
])
createServer(async (req, res) => {
  const entry = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
  if (!entry) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' })
  res.end(await readFile(new URL(entry[0], import.meta.url)))
}).listen(4323, '127.0.0.1', () => stdout.write('http://127.0.0.1:4323/?variant=C\n'))
