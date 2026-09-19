// PROTOTYPE — throwaway. Serves the repo root on localhost so the prototype opens over http.
/* global console, URL */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
const root = resolve('.')
const types = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.mjs': 'text/javascript', '.png': 'image/png' }
createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const file = resolve(root, '.' + path)
  if (!file.startsWith(root)) { res.writeHead(403); return res.end() }
  let body
  try { body = await readFile(file) } catch { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
  res.end(body)
}).listen(4173, '127.0.0.1', () => console.log('serving on http://127.0.0.1:4173'))
