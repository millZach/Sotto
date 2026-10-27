import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveQuestionPage } from '../../host/questionPageRoute'
import { inside, type QuestionPageTarget } from '../agents/questionPages'

/** What opening a thread's file in Sotto's browser comes to: the address it is served at, or why it is not. */
export type ThreadFileOpening = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string }

const HTML = /\.html?$/iu
/** A written path up to its HTML file's name, and the query or fragment after it, which a prototype reads its variant from. */
const PATH_AND_ADDRESS = /^(.*?\.html?)([?#].*)?$/isu
/** A URL scheme at the start of what was written; a Windows drive letter (`C:\`, `C:/`) is a path, not a scheme. */
const SCHEME = /^(?![a-z]:[\\/])[a-z][a-z0-9+.-]*:/iu
/** How many files a session keeps open at once; the oldest closes first, and opening it again gives it a new token. */
const OPEN_FILES_MAX = 256

/**
 * A **thread file page** (ADR-0085, October 27, 2026 amendment): an HTML file inside a thread's folder that an agent opens in
 * Sotto's browser with `browser_open` or `iphone_open`. Sotto's browser opens no `file://` page, so the file is served
 * read-only on this computer's loopback under a token, by the same route and rules a question's file page is served by:
 * the file's own folder, GET and HEAD, the kinds of file a page is drawn from, no hidden files, links judged by where they
 * lead, the sandbox and no-store headers. The listener binds 127.0.0.1 alone, starts on the first file opened, and is not
 * phone access's, so nothing here reaches the tailnet, and it works with phone access off. A token lives until the thread is
 * gone or the browser shuts down, as browser tasks do.
 */
export class ThreadFilePages {
  private readonly targets = new Map<string, QuestionPageTarget & { readonly kind: 'file'; readonly threadId: string }>()
  private readonly tokens = new Map<string, string>()
  private server: Server | undefined
  private listening: Promise<number> | undefined
  private closed = false

  constructor(private readonly token: () => string = () => randomBytes(24).toString('base64url')) {}

  /**
   * Opens what an agent wrote as the page to open, when it names a file: a `file://` URL, or a path, absolute or relative to
   * the thread's folder, with any query or fragment kept. Undefined when it names no file at all, such as another scheme.
   * Nothing outside the folder is looked at, so a network path in what the agent wrote never reaches the network.
   */
  async open(written: string, threadId: string, folder: string): Promise<ThreadFileOpening | undefined> {
    const named = this.named(written.trim())
    if (!named) return undefined
    const shown = named.file
    const root = await realpath(folder).catch(() => undefined)
    if (!root) return { ok: false, message: 'This thread\'s folder is not on this computer right now, so none of its files can open. Nothing was opened.' }
    const outside = { ok: false, message: `Only HTML files inside this thread's folder can open in Sotto's browser. ${shown} is outside it. Nothing was opened. Copy the page into ${root}, or serve it and open its http address.` } as const
    const absolute = path.isAbsolute(named.file) ? path.resolve(named.file) : path.resolve(root, named.file)
    if (!inside(path.resolve(folder), absolute) && !inside(root, absolute)) return outside
    if (!HTML.test(absolute)) return { ok: false, message: `Only HTML files can open in Sotto's browser from this thread's folder, and ${shown} is not one. Nothing was opened. Open the .html or .htm page that uses it.` }
    const file = await realpath(absolute).catch(() => undefined)
    const isFile = file ? await stat(file).then(info => info.isFile(), () => false) : false
    if (!file || !isFile) return { ok: false, message: `${shown} is not in this thread's folder, so nothing was opened. Check the path: a relative path starts at ${root}.` }
    // A link is judged by what it leads to: `page.html` that leads out of the folder is outside it.
    if (!inside(root, file)) return outside
    if (!HTML.test(file)) return { ok: false, message: `${shown} leads to a file that is not an HTML page, so nothing was opened. Open the .html or .htm page itself.` }
    const parts = path.relative(root, file).split(path.sep)
    if (parts.some(part => part.toLowerCase() === '.git') || path.basename(file).startsWith('.')) {
      return { ok: false, message: `Sotto's browser does not open hidden files or anything in .git, so ${shown} was not opened. Copy the page somewhere else in the thread's folder.` }
    }
    const port = await this.listen()
    if (port === undefined) return { ok: false, message: 'Sotto could not start serving this thread\'s files on this computer. Nothing was opened. Try again, or serve the page and open its http address.' }
    const key = `${threadId}\n${file}`
    let token = this.tokens.get(key)
    if (!token || !this.targets.has(token)) {
      token = this.token()
      this.tokens.set(key, token)
      this.targets.set(token, { kind: 'file', root: path.dirname(file), file, threadId })
      this.trim()
    }
    return { ok: true, url: `http://127.0.0.1:${port}/page/${token}/${encodeURIComponent(path.basename(file))}${named.after}` }
  }

  /** A thread Sotto no longer lists takes its open files with it. */
  forget(threadId: string): void {
    for (const [token, target] of this.targets) if (target.threadId === threadId) this.targets.delete(token)
    for (const [key, token] of this.tokens) if (!this.targets.has(token)) this.tokens.delete(key)
  }

  /** Closes the listener and every token, when the browser shuts down. */
  dispose(): void {
    this.closed = true
    this.targets.clear(); this.tokens.clear()
    const server = this.server
    this.server = undefined; this.listening = undefined
    if (server) { server.closeAllConnections(); server.close() }
  }

  /** The file a written page names, and the query or fragment after it; undefined when it is not a file at all. */
  private named(written: string): { file: string; after: string } | undefined {
    if (/^file:/iu.test(written)) {
      let url: URL
      try { url = new URL(written) } catch { return undefined }
      const after = `${url.search}${url.hash}`
      url.search = ''; url.hash = ''
      try { return { file: fileURLToPath(url), after } } catch { return undefined }
    }
    if (written === '' || SCHEME.test(written)) return undefined
    const match = PATH_AND_ADDRESS.exec(written)
    return match ? { file: match[1]!, after: match[2] ?? '' } : { file: written, after: '' }
  }

  private trim(): void {
    while (this.targets.size > OPEN_FILES_MAX) {
      const oldest = this.targets.keys().next().value as string
      this.targets.delete(oldest)
      for (const [key, token] of this.tokens) if (token === oldest) this.tokens.delete(key)
    }
  }

  /** The loopback listener's port, started on first use; undefined once shut down or when it cannot listen. */
  private async listen(): Promise<number | undefined> {
    if (this.closed) return undefined
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        void serveQuestionPage(request, response, {
          target: token => this.targets.get(token),
          ownPort: () => (server.address() as AddressInfo | null)?.port,
          closed: { title: 'This page has closed', lines: ['Sotto restarted since the agent opened it, or the thread has gone. Nothing was lost.', 'Ask the agent to open the page again.'] },
        }).catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
      })
      // It never keeps Sotto running, and it is reachable from this computer alone.
      server.unref()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve((server.address() as AddressInfo).port) })
      this.server = server
    })
    try { return await this.listening } catch { this.listening = undefined; this.server = undefined; return undefined }
  }
}
