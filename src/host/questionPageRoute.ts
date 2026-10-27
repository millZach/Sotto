import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { canonicalInside, folderIdentity, hiddenOnTheWay, inside, type QuestionPageTarget } from '../main/agents/questionPages'

/** A page route's path: the token and whatever follows it. */
export const QUESTION_PAGE_PATH = /^\/page\/([A-Za-z0-9_-]{32})(\/[^?#]*)?$/u

/**
 * What a page's folder may serve: the kinds of file a web page is drawn from. Data, notes, source maps, source, keys and
 * anything else in the folder stay where they are even though the token opens the folder: configuration lives in JSON and
 * text files, and a source map carries the source.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm',
}

/**
 * Every page answer's headers. The sandbox gives the page an origin of its own, so its script cannot act as the host's
 * listener; it keeps scripts, forms, popups and downloads, as a prototype in a browser has. Anything may read the answer,
 * because the sandboxed page itself is a different origin, and the token is what keeps it private.
 */
const PAGE_HEADERS = {
  'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
  'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
} as const

const lowerPageHeaders: Readonly<Record<string, true>> = Object.fromEntries(Object.keys(PAGE_HEADERS).map(name => [name.toLowerCase(), true as const]))

/** Headers a browser sends that a page's own server may use; cookies and everything Tailscale adds stay here. */
const FORWARDED_HEADERS = ['accept', 'accept-language', 'range', 'if-none-match', 'if-modified-since', 'user-agent', 'cache-control']
/** Headers of the page's server that do not pass: the connection's own, and cookies the phone would keep for the host. */
const DROPPED_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'access-control-allow-origin', 'strict-transport-security', 'alt-svc'])
/** How long the page's own server has to start answering; once it has, a slow answer is not cut. */
const PROXY_TIMEOUT_MS = 15_000
/**
 * The kinds of answer a loopback page's server may pass on: what a page is drawn from, as a file page serves. A JSON API,
 * a socket's handshake or anything else a loopback port answers with is refused, so naming a service's port does not put
 * the service on the tailnet.
 */
const PAGE_MEDIA = /^(?:text\/(?:html|css|javascript)|application\/(?:javascript|x-javascript|ecmascript|wasm)|image\/|font\/|audio\/|video\/)/u

/** Why a file in a page's folder is refused, for a question's page and a thread file page alike. */
const REFUSED_LINE = 'A page Sotto serves from a folder opens the files a web page is made of, such as pages, styles, scripts, images and fonts, from the page’s own folder, and nothing else.'

const escape = (value: string): string => value.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`)

/** A page that says what happened in plain words, with nothing loaded from anywhere. */
function explain(response: ServerResponse, status: number, title: string, lines: readonly string[]): void {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title>`
    + '<style>body{margin:0;padding:40px 24px;font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:36em}h1{font-size:20px;margin:0 0 10px}p{margin:0 0 10px}</style></head>'
    + `<body><h1>${escape(title)}</h1>${lines.map(line => `<p>${escape(line)}</p>`).join('')}</body></html>`
  if (response.headersSent) { response.destroy(); return }
  response.writeHead(status, { ...PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

const finished = (response: ServerResponse): Promise<void> => new Promise(resolve => {
  if (response.writableFinished || response.destroyed) { resolve(); return }
  response.once('close', resolve)
})

/** A web file in the folder, as it is after links are followed: no hidden part on the way to it, and a kind a page is made of. */
const servable = (root: string, file: string): boolean => file !== root && inside(root, file)
  && !path.relative(root, file).split(path.sep).some(part => part.startsWith('.')) && CONTENT_TYPES[path.extname(file).toLowerCase()] !== undefined
/** How many page requests a minute one listener answers, all pages together (ADR-0085): a page loads many files. */
export const PAGE_REQUESTS_PER_MINUTE = 1200

/** The answer to a page request past the listener's budget, in words. */
export function refuseBusyPage(response: ServerResponse): void {
  explain(response, 429, 'Too many requests for this page', ['Sotto answers at most 1,200 page requests a minute here, and this minute’s are spent. Nothing was lost.',
    'Wait a minute, then reload the page.'])
}

/**
 * Answers one request on a question page's route (ADR-0085): `/page/<token>/<path>`. A file page serves its folder
 * read-only, without hidden files and only the kinds of file a page is made of; a server page passes GET and HEAD on to
 * the loopback address the agent named, never to this listener's own port. A GET that the page answers, before its body
 * goes, tells `opened` the token, which clears the prototype-ready mark the page belongs to (ADR-0108).
 */
export async function serveQuestionPage(request: IncomingMessage, response: ServerResponse, options: {
  target: (token: string) => QuestionPageTarget | undefined
  ownPort: () => number | undefined
  opened?: (token: string) => void
  /** What a token nobody holds says, when the listener serves pages other than a question's (a thread file page). */
  closed?: { readonly title: string; readonly lines: readonly string[] }
}): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://page.invalid')
  const match = QUESTION_PAGE_PATH.exec(url.pathname)
  const target = match ? options.target(match[1]!) : undefined
  if (!match || !target) {
    if (options.closed) explain(response, 404, options.closed.title, options.closed.lines)
    else explain(response, 404, 'This page has closed', ['The question it belonged to was answered over an hour ago, or Sotto restarted since it was asked. Nothing was lost.',
      'Open the page again from the question, or ask the agent for it.'])
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { ...PAGE_HEADERS, Allow: 'GET, HEAD' }); response.end(); return
  }
  const base = `/page/${match[1]!}/`
  const rest = match[2]
  if (rest === undefined) { response.writeHead(308, { ...PAGE_HEADERS, Location: `${base}${url.search}` }); response.end(); return }
  const answered = (): void => { if (request.method === 'GET') options.opened?.(match[1]!) }
  if (target.kind === 'file') await serveFile(request, response, target, base, rest.slice(1), answered)
  else await proxy(request, response, target.origin, base, rest + url.search, options.ownPort(), answered)
}

async function serveFile(request: IncomingMessage, response: ServerResponse, target: Extract<QuestionPageTarget, { kind: 'file' }>, base: string, rest: string, answered: () => void): Promise<void> {
  if (rest === '') { response.writeHead(307, { ...PAGE_HEADERS, Location: base + encodeURIComponent(path.basename(target.file)) }); response.end(); answered(); return }
  let parts: string[]
  try { parts = rest.split('/').map(part => decodeURIComponent(part)) } catch { parts = [] }
  // Each part is checked after it is decoded, so an escaped slash or dot cannot name a hidden file or step out of the folder.
  const refused = parts.length === 0 || parts.some(part => part === '' || part.startsWith('.') || /[\0/\\:]/u.test(part))
  const extension = path.extname(parts.at(-1) ?? '').toLowerCase()
  const type = CONTENT_TYPES[extension]
  if (refused || !type) {
    explain(response, 403, 'Sotto does not serve this file', [REFUSED_LINE])
    return
  }
  // The folder is the one found when the page was admitted. It is walked again from the thread's folder on every request,
  // each link judged before it is followed, before the folder itself is looked at: if it has since become a link to
  // somewhere else, outside or on a share, nothing there is touched, and if it now leads anywhere but where it was
  // admitted, it is not that folder any more and nothing in it is served.
  // The thread's folder is the walk's anchor, so it is checked first, with `lstat` alone: still a folder, not a link or
  // junction put in its place, and the very folder admission found. A page directly in it has no other part to walk.
  const anchor = target.folder === undefined ? undefined : await folderIdentity(target.folder)
  const anchored = target.folder === undefined
    || (!!anchor && !!target.folderIdentity && anchor.dev === target.folderIdentity.dev && anchor.ino === target.folderIdentity.ino)
  const again = anchored ? await canonicalInside(target.folder ?? path.parse(target.root).root, target.root) : undefined
  const root = again && 'file' in again && again.file === target.root ? target.root : undefined
  // A link in the folder is followed before it is judged, so `look.css` that leads to `.env` is refused as `.env` would be.
  // It is followed without leaving the folder: a link to a share or outside is refused before anything there is touched.
  // The file is judged by the file system's own spelling of it, so `WORKTR~1` is judged as `.worktrees`.
  const walked = root ? await canonicalInside(root, path.join(root, ...parts)) : undefined
  const file = walked && 'file' in walked ? walked : undefined
  const hidden = file !== undefined && target.folder !== undefined && hiddenOnTheWay(target.folder, file.file, target.hidden ?? 'git-only')
  if ((walked && 'reason' in walked && walked.reason === 'outside') || (file && root && (!servable(root, file.file) || hidden))) {
    explain(response, 403, 'Sotto does not serve this file', [REFUSED_LINE])
    return
  }
  // The file is opened, then checked to be the one the walk found: a folder on the way swapped for a link between the walk
  // and the open would open another file, and that file is not served.
  // Only a plain file is opened, as the walk saw it, so a pipe or device named `look.css` is never opened; and it is opened
  // without waiting where the system can, so one swapped in after the walk cannot hold the open, then refused below.
  const handle = file?.identity?.regular ? await open(file.file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(() => undefined) : undefined
  const info = handle ? await handle.stat({ bigint: true }).catch(() => undefined) : undefined
  const same = !!info && !!file?.identity && info.dev === file.identity.dev && info.ino === file.identity.ino
  if (!handle || !info?.isFile() || !same) {
    await handle?.close().catch(() => undefined)
    const missingPage = path.join(target.root, ...parts) === target.file
    explain(response, 404, missingPage ? 'The prototype file was moved or deleted' : 'This file is not in the page’s folder',
      missingPage ? ['Nothing else changed. Ask the agent where the page is now.'] : ['The page asked for a file that is not there. The rest of the page may still work.'])
    return
  }
  response.writeHead(200, { ...PAGE_HEADERS, 'Content-Type': CONTENT_TYPES[path.extname(file!.file).toLowerCase()] ?? type, 'Content-Length': Number(info.size) })
  answered()
  if (request.method === 'HEAD') { await handle.close().catch(() => undefined); response.end(); return }
  // The file is closed when the browser goes away part way, which a plain pipe would not do on its own.
  const stream = handle.createReadStream()
  response.once('close', () => stream.destroy())
  stream.on('error', () => response.destroy())
  stream.pipe(response)
  await finished(response)
}

async function proxy(request: IncomingMessage, response: ServerResponse, origin: string, base: string, rest: string, ownPort: number | undefined, answered: () => void): Promise<void> {
  const upstream = new URL(origin)
  const port = Number(upstream.port || 80)
  const host = upstream.hostname.replace(/^\[|\]$/gu, '')
  const stopped = (): void => explain(response, 502, 'The page’s server has stopped', [
    `The agent served this page from ${upstream.host} on the computer that runs the thread, and nothing answers there now. Nothing was lost.`,
    'Ask the agent to start the page again, then open it from the question.'])
  if (port === ownPort && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) { stopped(); return }
  const headers: Record<string, string> = { host: upstream.host }
  for (const name of FORWARDED_HEADERS) { const value = request.headers[name]; if (typeof value === 'string') headers[name] = value }
  await new Promise<void>(resolve => {
    const outgoing = httpRequest({ host, port, path: rest, method: request.method, headers, timeout: PROXY_TIMEOUT_MS }, incoming => {
      outgoing.setTimeout(0)
      const media = (incoming.headers['content-type'] ?? '').toLowerCase()
      // A redirect, a 204 and a 304 have no body to judge; anything else must be what a page is drawn from.
      const status = incoming.statusCode ?? 0
      const bodiless = (status >= 300 && status < 400) || status === 204
      if (!bodiless && !PAGE_MEDIA.test(media)) {
        incoming.resume()
        explain(response, 403, 'Sotto does not pass this on', [`The address ${upstream.host} answered with something other than a web page, so Sotto did not pass it on. Nothing was sent anywhere.`,
          'Ask the agent to serve the prototype as a page.'])
        resolve()
        return
      }
      const passed: Record<string, string | string[]> = { ...PAGE_HEADERS }
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined || DROPPED_HEADERS.has(name) || name in lowerPageHeaders) continue
        passed[name] = value
      }
      const location = incoming.headers.location
      if (typeof location === 'string') {
        // A redirect within the page's server stays on the page's route.
        try {
          const moved = new URL(location, `${origin}${rest}`)
          if (moved.origin === upstream.origin) passed.location = base + moved.pathname.replace(/^\/+/u, '') + moved.search
        } catch { delete passed.location }
      }
      response.writeHead(incoming.statusCode ?? 502, passed)
      if (status > 0 && status < 400) answered()
      incoming.pipe(response)
      incoming.on('error', () => response.destroy())
      void finished(response).then(resolve)
    })
    outgoing.on('timeout', () => outgoing.destroy(new Error('timeout')))
    outgoing.on('error', () => { stopped(); resolve() })
    response.on('close', () => outgoing.destroy())
    outgoing.end()
  })
}

