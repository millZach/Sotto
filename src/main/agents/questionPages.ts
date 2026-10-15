import { randomBytes } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isVisualMessage, QUESTION_PAGES_MAX, type AgentHostSnapshot, type AgentMessage, type AgentRequest, type AgentThread, type QuestionPage } from '../../shared/agents'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import { isSottoRequest } from './sottoRequests'

/**
 * What a question page's token opens (ADR-0084): an HTML file and the folder it sits in, read-only, or the loopback
 * address of a page the agent serves on this machine.
 */
export type QuestionPageTarget =
  | { readonly kind: 'file'; readonly root: string; readonly file: string }
  | { readonly kind: 'server'; readonly origin: string }

/** A page named in a question's words or the message before it, before Sotto has checked that it is there. */
export type PageMention = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'server'; readonly url: URL }

/** A page Sotto found and checked: what the question carries, and what its token opens. */
export interface FoundPage { readonly page: Omit<QuestionPage, 'token'>; readonly target: QuestionPageTarget }

const HTML = /\.html?$/iu
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
/** What ends a sentence or a Markdown emphasis around an address, never part of it. */
const trailing = (value: string): string => value.replace(/[.,;:!?*_]+$/u, '')
/** How long a page stays open after its question is answered or withdrawn, for a page still loading on a phone. */
export const QUESTION_PAGE_LINGER_MS = 60 * 60_000
/** The most folders a search for a bare file name reads, so a large checkout cannot hold a question up. */
const SEARCH_FOLDERS_MAX = 4_000
const SEARCH_DEPTH_MAX = 8
const SKIPPED_FOLDERS = new Set(['node_modules', 'bower_components', 'target', 'dist-electron'])

/**
 * Every page a text names, once each, in the order written: a loopback web address (`http://localhost:8075/`), a
 * `file://` link to an HTML file, or the path of one, written bare, in backticks or as a Markdown link's target. A
 * path may be relative to the thread's folder, absolute, or a file name alone; whether it is there is checked later.
 */
export function pageMentions(texts: readonly string[]): PageMention[] {
  const found: PageMention[] = []
  const seen = new Set<string>()
  const add = (mention: PageMention): void => {
    const key = mention.kind === 'file' ? `file:${mention.path}` : `server:${mention.url.href}`
    if (seen.has(key)) return
    seen.add(key)
    found.push(mention)
  }
  for (const text of texts) {
    const here: { at: number; mention: PageMention }[] = []
    // An IPv6 address keeps its brackets; a bracket anywhere else ends the address, as Markdown's do.
    for (const match of text.matchAll(/https?:\/\/(?:\[[0-9a-f:.]+\])?[^\s<>"'`()[\]]*/giu)) {
      let url: URL
      try { url = new URL(trailing(match[0])) } catch { continue }
      if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password) here.push({ at: match.index, mention: { kind: 'server', url } })
    }
    for (const match of text.matchAll(/file:\/\/[^\s<>"'`()[\]]+/giu)) {
      try {
        const file = fileURLToPath(trailing(match[0]))
        if (HTML.test(file)) here.push({ at: match.index, mention: { kind: 'file', path: file } })
      } catch { /* Not a path on this system. */ }
    }
    // A span in backticks and a Markdown link's target may hold spaces; a bare path ends at the first one. Spans are
    // blanked out, keeping their length, before bare paths are read, so each is read once and in place.
    const paths = [...text.matchAll(/`([^`\n]+)`/gu), ...text.matchAll(/\]\(<?([^)>\n]+?)>?\)/gu)].map(match => ({ at: match.index, value: match[1]! }))
    const blanked = text.replace(/`[^`\n]*`/gu, span => ' '.repeat(span.length))
    paths.push(...[...blanked.matchAll(/[^\s<>"'`()[\]*|]+/gu)].map(match => ({ at: match.index, value: match[0] })))
    for (const { at, value: candidate } of paths) {
      const value = trailing(candidate.trim())
      if (!HTML.test(value) || value.includes('://') || /^[a-z][a-z0-9+.-]*:(?![\\/])/iu.test(value)) continue
      here.push({ at, mention: { kind: 'file', path: value } })
    }
    for (const { mention } of here.sort((left, right) => left.at - right.at)) add(mention)
  }
  return found
}

/** Whether `target` is `root` or inside it, by their paths alone. */
export const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** The one file under `root` with this name, read breadth first and without hidden or dependency folders. */
async function findByName(root: string, name: string, suffix: string): Promise<string | undefined> {
  const matches: string[] = []
  let queue = [root], read = 0
  for (let depth = 0; depth <= SEARCH_DEPTH_MAX && queue.length > 0 && read < SEARCH_FOLDERS_MAX; depth++) {
    const next: string[] = []
    for (const folder of queue) {
      if (read++ >= SEARCH_FOLDERS_MAX) break
      let entries
      try { entries = await readdir(folder, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (entry.isDirectory()) { if (!entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name)) next.push(path.join(folder, entry.name)) }
        else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) matches.push(path.join(folder, entry.name))
      }
    }
    queue = next
  }
  if (matches.length === 1) return matches[0]
  // Several of that name: the one that shares the most folders, from the end, with the path as written, if only one does.
  const written = suffix.toLowerCase().split('/').filter(Boolean).reverse()
  const shared = (match: string): number => {
    const parts = match.replaceAll('\\', '/').toLowerCase().split('/').reverse()
    let count = 0
    while (count < written.length && parts[count] === written[count]) count++
    return count
  }
  const scores = matches.map(shared)
  const best = Math.max(0, ...scores)
  return best > 1 && scores.filter(score => score === best).length === 1 ? matches[scores.indexOf(best)] : undefined
}

/**
 * The pages among the mentions that are there: each HTML file inside the thread's folder, after links are followed,
 * and outside `.git`, and each loopback address. A file that is not where the mention says is looked for by name in
 * the folder. Nothing outside the folder is ever offered.
 */
export async function foundPages(mentions: readonly PageMention[], folder: string | undefined): Promise<FoundPage[]> {
  const pages: FoundPage[] = []
  const files = new Set<string>(), origins = new Set<string>()
  const root = folder ? await realpath(folder).catch(() => undefined) : undefined
  for (const mention of mentions) {
    if (pages.length >= QUESTION_PAGES_MAX) break
    if (mention.kind === 'server') {
      const origin = mention.url.origin
      // The fragment stays: a prototype that tells its variants apart by one opens at the variant named.
      const start = `${mention.url.pathname.replace(/^\/+/u, '')}${mention.url.search}${mention.url.hash}`
      const key = `${origin}/${start}`
      if (origins.has(key)) continue
      origins.add(key)
      pages.push({ page: { kind: 'server', name: mention.url.host, start }, target: { kind: 'server', origin } })
      continue
    }
    if (!root) continue
    const written = mention.path.replace(/^~(?=[\\/])/u, '')
    const named = path.isAbsolute(written) ? written : path.resolve(root, written)
    // Nothing outside the folder is looked at, so a network path in what the agent wrote never reaches the network; a
    // path elsewhere is looked for by its name inside the folder instead, as one that is not there is.
    let candidate: string | undefined = inside(root, named) && await stat(named).then(info => info.isFile(), () => false) ? named : undefined
    candidate ??= await findByName(root, path.basename(written.replaceAll('\\', '/')), written.replaceAll('\\', '/').replace(/^\.?\/+/u, ''))
    if (!candidate) continue
    const file = await realpath(candidate).catch(() => undefined)
    if (!file || !HTML.test(file) || !inside(root, file) || files.has(file)) continue
    if (path.relative(root, file).split(path.sep).some(part => part.toLowerCase() === '.git')) continue
    files.add(file)
    pages.push({ page: { kind: 'file', name: path.basename(file), start: encodeURIComponent(path.basename(file)) }, target: { kind: 'file', root: path.dirname(file), file } })
  }
  return pages
}

/** The words of a question a page may be named in: its text, each question's prompt, header and choices. */
export function requestWords(request: AgentRequest): string[] {
  return [request.text, ...request.options.map(option => option.label),
    ...(request.questions ?? []).flatMap(question => [question.question, question.header ?? '', ...question.options.flatMap(option => [option.label, option.description ?? ''])])]
}

/** The agent's newest words a thread holds: its last reply that is not a visual. */
export function newestReply(messages: readonly AgentMessage[] | undefined): string | undefined {
  return messages?.findLast(message => message.role === 'assistant' && !isVisualMessage(message))?.text
}

interface Entry {
  readonly threadId: string
  pages: QuestionPage[] | undefined
  /** When the question left its thread; its pages close a while after. */
  goneAt?: number
}

export interface QuestionPagesOptions {
  /** The thread's stored messages, when its snapshot carries none. */
  readonly messages?: (threadId: string) => Promise<readonly AgentMessage[] | undefined> | readonly AgentMessage[] | undefined
  /** Called when a question's pages are found, so the host publishes them. */
  readonly changed: () => void
  readonly now?: () => number
  readonly token?: () => string
}

/**
 * The pages of every question the host holds (ADR-0084). The first snapshot a question appears in starts the search:
 * its words and the agent's newest reply in that thread at that moment, so a reply the agent writes after asking does not
 * move them. Each page found gets an unguessable token that the host's page route serves, while the question waits and
 * for an hour after. Every snapshot then carries the pages on its questions; a provider never supplies them.
 */
export class QuestionPages {
  private readonly entries = new Map<string, Entry>()
  private readonly targets = new Map<string, { target: QuestionPageTarget; key: string }>()
  private readonly now: () => number
  private readonly token: () => string

  constructor(private readonly options: QuestionPagesOptions) {
    this.now = options.now ?? Date.now
    this.token = options.token ?? (() => randomBytes(24).toString('base64url'))
  }

  /** What a token opens, while its question waits or lingers. */
  target(token: string): QuestionPageTarget | undefined {
    this.prune()
    return this.targets.get(token)?.target
  }

  /** The snapshot with each question's pages on it. Threads with nothing to change keep their own object. */
  decorate(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    const present = new Set<string>()
    let changed = false
    const threads = snapshot.threads.map(thread => {
      let threadChanged = false
      const requests = thread.requests.map(request => {
        const asked = request.kind === 'question' && !isSottoRequest(request.id)
        const key = `${thread.id}\n${request.id}`
        if (asked) {
          present.add(key)
          if (!this.entries.has(key)) this.start(key, thread, snapshot, request)
        }
        const pages = asked ? this.entries.get(key)?.pages : undefined
        const carried = request.pages
        if (pages?.length ? JSON.stringify(carried) === JSON.stringify(pages) : carried === undefined) return request
        threadChanged = true
        const { pages: _carried, ...rest } = request
        void _carried
        return pages?.length ? { ...rest, pages: structuredClone(pages) } : rest
      })
      if (!threadChanged) return thread
      changed = true
      return { ...thread, requests }
    })
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (present.has(key)) delete entry.goneAt
      else entry.goneAt ??= now
    }
    this.prune()
    return changed ? { ...snapshot, threads } : snapshot
  }

  private start(key: string, thread: AgentThread, snapshot: AgentHostSnapshot, request: AgentRequest): void {
    const entry: Entry = { threadId: thread.id, pages: undefined }
    this.entries.set(key, entry)
    let folder: string | undefined
    try { folder = resolveThreadWorkingDirectory(thread, snapshot.projects.find(project => project.id === thread.projectId)) } catch { folder = undefined }
    const summary = thread.summary?.lastAssistant?.text
    void (async () => {
      const stored = thread.messages.length ? undefined : await this.options.messages?.(thread.id)
      const reply = newestReply(thread.messages.length ? thread.messages : stored)
      const found = await foundPages(pageMentions([...requestWords(request), reply ?? '', summary ?? '']), folder)
      if (this.entries.get(key) !== entry) return
      entry.pages = found.map(({ page, target }) => {
        const token = this.token()
        this.targets.set(token, { target, key })
        return { ...page, token }
      })
      if (entry.pages.length) this.options.changed()
    })().catch(() => {
      // A page that cannot be read is a question without pages; the question itself is unaffected.
      if (this.entries.get(key) === entry) entry.pages = []
    })
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.goneAt === undefined || now - entry.goneAt < QUESTION_PAGE_LINGER_MS) continue
      this.entries.delete(key)
      for (const [token, item] of this.targets) if (item.key === key) this.targets.delete(token)
    }
  }
}
