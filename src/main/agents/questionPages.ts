import { randomBytes } from 'node:crypto'
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_THREAD_EXCERPT_MAX, isVisualMessage, QUESTION_PAGES_MAX, type AgentHostSnapshot, type AgentMessage, type AgentRequest, type AgentThread, type QuestionPage } from '../../shared/agents'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import { replySource, requestSource } from './prototypeSources'
import { isSottoRequest } from './sottoRequests'

/**
 * What a question page's token opens (ADR-0085): an HTML file and the folder it sits in, read-only, or the loopback
 * address of a page the agent serves on this machine.
 */
export type QuestionPageTarget =
  /**
   * `folder`: the thread's folder, in the file system's own spelling, from which the page's folder is walked again on
   * every request, and `hidden`: which parts of the way from it refuse a file, as admission judged them (`refused` for a
   * thread file page, `git-only` for a question's). Without `folder`, the walk starts at the top of the page folder's drive.
   */
  | { readonly kind: 'file'; readonly root: string; readonly file: string; readonly folder?: string; readonly hidden?: 'refused' | 'git-only' }
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
/** How many times a question's pages are looked for, and how long apart, when a search finds none: the reply naming them
 * may reach the thread's store a moment after the question does. */
const QUESTION_PAGE_SEARCHES = 3
const QUESTION_PAGE_SEARCH_GAP_MS = 2_000
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

/** A network share or device path (`\\server\share`, `\\?\…`, `\\.\…`, `//server`): never looked at, whatever names it. */
export const onShareOrDevice = (value: string): boolean => /^[\\/]{2}/u.test(value)

/** How many links one path may pass through before it is given up on, so a loop of links ends. */
const LINK_HOPS_MAX = 32

/**
 * Where `target` really is, when it is inside `root` once its links are followed; undefined otherwise. `root` must be a
 * real path already. Each part of the way is looked at with `lstat` only after it is known to be inside the folder, and a
 * link's own words are judged before it is followed, so a link to a network share or outside the folder is refused
 * without the share, or anything else outside, ever being touched. `realpath` would open the link's target to find out.
 */
export async function resolveInside(root: string, target: string): Promise<string | undefined> {
  const walked = await walkInside(root, target, LINK_HOPS_MAX)
  return 'file' in walked ? walked.file : undefined
}

/** What a walk found: the file, and the identity the file system gave its last part, or why the walk stopped. */
export type Walked =
  | { readonly file: string; readonly identity?: { readonly dev: bigint; readonly ino: bigint } }
  | { readonly reason: 'outside' | 'missing' }

/** `resolveInside`, saying why it stopped: a part of the way that is not there, or a way that leaves the folder. */
export async function walkInside(root: string, target: string, hops = LINK_HOPS_MAX): Promise<Walked> {
  if (onShareOrDevice(target) || !path.isAbsolute(target) || !inside(root, target)) return { reason: 'outside' }
  let current = root
  let identity: { dev: bigint; ino: bigint } | undefined
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    // `current` is always a path inside the folder with no link on the way, so `next` names one entry of a folder inside it.
    const next = path.join(current, part)
    const info = await lstat(next, { bigint: true }).catch(() => undefined)
    if (!info) return { reason: 'missing' }
    if (!info.isSymbolicLink()) { current = next; identity = { dev: info.dev, ino: info.ino }; continue }
    if (hops <= 0) return { reason: 'missing' }
    // A Windows junction may read back with the `\\?\` prefix before its drive; anything else after `\\` is a share or device.
    const link = (await readlink(next).catch(() => undefined))?.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/u, '')
    if (link === undefined) return { reason: 'missing' }
    if (onShareOrDevice(link)) return { reason: 'outside' }
    const followed = await walkInside(root, path.resolve(current, link), hops - 1)
    if (!('file' in followed)) return followed
    current = followed.file
    identity = followed.identity
  }
  return identity ? { file: current, identity } : { file: current }
}

/**
 * `walkInside`, then the path as the file system itself spells it: its true case and long names, never a Windows 8.3
 * short name such as `WORKTR~1` for `.worktrees`. Every check of a part's name (hidden, `.git`) and every comparison of a
 * saved path reads this spelling, never the caller's. `realpath` runs only once the walk has proved every part of the way
 * inside the folder and found no link left on it, so it reads nothing outside. `root` must be in this spelling already,
 * as `realpath` gives it.
 */
export async function canonicalInside(root: string, target: string): Promise<Walked> {
  const walked = await walkInside(root, target)
  if (!('file' in walked)) return walked
  const canonical = await realpath(walked.file).catch(() => undefined)
  if (!canonical) return { reason: 'missing' }
  if (!inside(root, canonical)) return { reason: 'outside' }
  return walked.identity ? { file: canonical, identity: walked.identity } : { file: canonical }
}

/** Whether a path inside `folder`, in the file system's own spelling, passes on its way through `.git`, or through any hidden part when `hidden` is refused. */
export const hiddenOnTheWay = (folder: string, file: string, hidden: 'refused' | 'git-only'): boolean => {
  const parts = path.relative(folder, file).split(path.sep)
  return parts.some(part => part.toLowerCase() === '.git') || (hidden === 'refused' && parts.some(part => part.startsWith('.')))
}

/** Why a file is not admitted as a page: the reasons a thread file page tells its agent in words. */
export type PageFileRefusal = 'outside' | 'missing' | 'not-html' | 'hidden'

/**
 * Whether `candidate` is an HTML page Sotto may open from the folder `root` (a real path), and where it really is: an
 * `.html` or `.htm` file inside the folder once links are followed, by `resolveInside`, and outside `.git`. A question's
 * page may sit in another hidden folder, as `.superpowers/` prototypes do (ADR-0085); a thread file page may not, so
 * `hidden: 'refused'` refuses any hidden part of the way from the folder, and a hidden file.
 */
export async function admitPageFile(root: string, candidate: string, options: { readonly hidden: 'refused' | 'git-only' }): Promise<{ readonly ok: true; readonly file: string } | { readonly ok: false; readonly reason: PageFileRefusal }> {
  if (onShareOrDevice(candidate) || !inside(root, candidate)) return { ok: false, reason: 'outside' }
  if (!HTML.test(candidate)) return { ok: false, reason: 'not-html' }
  // The file's own spelling, not the caller's: `DOCS/` is saved as `docs/`, and `WORKTR~1/` is judged as `.worktrees/`.
  const walked = await canonicalInside(root, candidate)
  if (!('file' in walked)) return { ok: false, reason: walked.reason }
  const file = walked.file
  if (!HTML.test(file)) return { ok: false, reason: 'not-html' }
  if (hiddenOnTheWay(root, file, options.hidden)) return { ok: false, reason: 'hidden' }
  // Only now, with its real path known to be inside the folder, is the file itself looked at.
  if (!await stat(file).then(info => info.isFile(), () => false)) return { ok: false, reason: 'missing' }
  return { ok: true, file }
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
  const written = suffix.toLowerCase().split('/').filter(Boolean).reverse()
  const shared = (match: string): number => {
    const parts = match.replaceAll('\\', '/').toLowerCase().split('/').reverse()
    let count = 0
    while (count < written.length && parts[count] === written[count]) count++
    return count
  }
  // A file name written alone is that file when it is the only one. A path is that file only when the match shares a
  // folder with it, so `/elsewhere/index.html` is never taken for this folder's own `index.html`. Of several, the one
  // that shares the most folders, from the end, if only one does.
  if (written.length <= 1) return matches.length === 1 ? matches[0] : undefined
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
    // Admission (shared with a thread file page) follows links without leaving the folder, so a link to a share is not followed.
    const direct = await admitPageFile(root, named, { hidden: 'git-only' })
    let file: string | undefined
    if (direct.ok) file = direct.file
    else if (direct.reason === 'outside' || direct.reason === 'missing') {
      const found = await findByName(root, path.basename(written.replaceAll('\\', '/')), written.replaceAll('\\', '/').replace(/^\.?\/+/u, ''))
      const admitted = found ? await admitPageFile(root, found, { hidden: 'git-only' }) : undefined
      if (admitted?.ok) file = admitted.file
    }
    if (!file || files.has(file)) continue
    files.add(file)
    pages.push({ page: { kind: 'file', name: path.basename(file), start: encodeURIComponent(path.basename(file)) }, target: { kind: 'file', root: path.dirname(file), file, folder: root, hidden: 'git-only' } })
  }
  return pages
}

/** The words of a question a page may be named in: its text, each question's prompt, header and choices. */
export function requestWords(request: AgentRequest): string[] {
  return [request.text, ...request.options.map(option => option.label),
    ...(request.questions ?? []).flatMap(question => [question.question, question.header ?? '', ...question.options.flatMap(option => [option.label, option.description ?? ''])])]
}

const PROTOTYPE_WORDS = /\b(?:prototypes?|mock[-‐‑ ]?ups?)\b/iu

/** Whether words say prototype or mock-up (ADR-0108): what makes a question about a prototype. */
export const saysPrototype = (words: string): boolean => PROTOTYPE_WORDS.test(words)

/** The agent's newest words a thread holds: its last reply that is not a visual. */
export function newestReply(messages: readonly AgentMessage[] | undefined): string | undefined {
  return messages?.findLast(message => message.role === 'assistant' && !isVisualMessage(message))?.text
}

/** How long a loopback page has to answer before it counts as not working (ADR-0108). */
export const PAGE_ANSWER_TIMEOUT_MS = 1_500

/**
 * Whether a loopback page answers (ADR-0108): one GET to its address, a redirect not followed, that comes back within a
 * moment with a status below 400. Its body is not read.
 */
export async function pageAnswers(url: string, timeoutMs = PAGE_ANSWER_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal })
    void response.body?.cancel().catch(() => undefined)
    return response.status > 0 && response.status < 400
  } catch { return false } finally { clearTimeout(timer) }
}

/**
 * A reply whose pages are looked for (ADR-0108): its message ID and its words, or, when the snapshot carries only the
 * thread's summary, the summary's excerpt of them. An excerpt cut at its limit is read whole from the thread's store, and
 * so is a reply named by its ID alone that the thread's messages do not hold.
 */
export interface ReplyToSearch { readonly id: string; readonly text?: string; readonly summary?: string }

/**
 * Where a search stands (ADR-0108). `finished` once it has found pages or will not look again; `pages` are every page it
 * found, as a question carries them; `working` are the ones that opened when Sotto looked, with the same tokens.
 * `aboutPrototype` once any of the words it read say prototype or mock-up: a question's own, and the whole reply before it
 * from the thread's store when the snapshot carries only its cut summary.
 */
export interface PageSearch { readonly finished: boolean; readonly pages: readonly QuestionPage[]; readonly working: readonly QuestionPage[]; readonly aboutPrototype: boolean }

/** A search is kept by its thread and its source: `request:<request ID>` for a question, `reply:<message ID>` for a reply. */
const keyOf = (threadId: string, source: string): string => `${threadId}\n${source}`

interface Entry {
  readonly threadId: string
  readonly source: string
  /** How many times it is looked for while nothing is found: a question's reply may reach the store late; a reply's words do not. */
  readonly tries: number
  /** Undefined while a search runs; empty when the searches so far found none. */
  pages: QuestionPage[] | undefined
  /** The pages among them that work, with the same tokens: what a published mark shares, never changed once settled. */
  working: readonly QuestionPage[]
  /** Whether the words any of its searches read say prototype or mock-up. */
  aboutPrototype: boolean
  searches: number
  searchedAt: number
  /** When the question left its thread, or the reply stopped being looked for; its pages close a while after. */
  goneAt?: number
}

const NO_PAGES: readonly QuestionPage[] = []

export interface QuestionPagesOptions {
  /** The thread's stored messages, when its snapshot carries none. */
  readonly messages?: (threadId: string) => Promise<readonly AgentMessage[] | undefined> | readonly AgentMessage[] | undefined
  /** Called when a question's pages are found, so the host publishes them. */
  readonly changed: () => void
  readonly now?: () => number
  readonly token?: () => string
  /** Whether a loopback page answers; `pageAnswers` unless a test stands in for the network. */
  readonly live?: (url: string) => Promise<boolean>
}

/**
 * The pages of every question the host holds (ADR-0085), and of the replies the coordinator asks about (ADR-0108). The
 * first snapshot a question appears in starts the search: its words and the agent's newest reply in that thread at that
 * moment, so a reply the agent writes after asking does not move them. A reply's search reads that reply alone, once.
 * Each page found gets an unguessable token that the host's page route serves, while the question waits or the reply is
 * looked for, and for an hour after. Every snapshot then carries the pages on its questions; a provider never supplies
 * them. A loopback page is asked once whether it answers, so the coordinator knows which pages work.
 */
export class QuestionPages {
  private readonly entries = new Map<string, Entry>()
  /** Each thread's searches by key, so a snapshot holding only the threads that changed sweeps only theirs (#925). */
  private readonly byThread = new Map<string, Set<string>>()
  /** The searches whose question or reply has gone and whose pages are closing, which a prune reads rather than every search. */
  private readonly lingering = new Set<string>()
  /** The question searches that found none and will look again on a later snapshot. */
  private readonly retrying = new Set<string>()
  private readonly targets = new Map<string, { target: QuestionPageTarget; key: string }>()
  private readonly now: () => number
  private readonly token: () => string
  private readonly live: (url: string) => Promise<boolean>
  /** Reply searches run one at a time, so a start that finds many replies naming pages does not walk every folder at once. */
  private replySearches: Promise<void> = Promise.resolve()

  constructor(private readonly options: QuestionPagesOptions) {
    this.now = options.now ?? Date.now
    this.token = options.token ?? (() => randomBytes(24).toString('base64url'))
    this.live = options.live ?? (url => pageAnswers(url))
  }

  /** How many searches are kept, for tests that hold the count to the replies and questions still looked for. */
  get searchCount(): number { return this.entries.size }

  /** What a token opens, while its question waits or lingers. */
  target(token: string): QuestionPageTarget | undefined {
    this.prune()
    return this.targets.get(token)?.target
  }

  /** The thread and source a token's page was found for, while it is served. */
  source(token: string): { readonly threadId: string; readonly source: string } | undefined {
    this.prune()
    const key = this.targets.get(token)?.key
    const entry = key === undefined ? undefined : this.entries.get(key)
    return entry && { threadId: entry.threadId, source: entry.source }
  }

  /**
   * The threads with a question whose search found none and is due to look again, which the next snapshot naming them
   * does. A snapshot holding only the threads that changed names these too (#925), as every snapshot once named every thread.
   */
  retriesDue(): string[] {
    if (!this.retrying.size) return []
    const now = this.now(), due: string[] = []
    for (const key of this.retrying) {
      const entry = this.entries.get(key)
      if (entry && entry.goneAt === undefined && entry.pages?.length === 0 && entry.searches < entry.tries && now - entry.searchedAt >= QUESTION_PAGE_SEARCH_GAP_MS) due.push(entry.threadId)
    }
    return due
  }

  /** Where the search for a thread's question (`request:<ID>`) or reply (`reply:<ID>`) stands; undefined when there is none. */
  searched(threadId: string, source: string): PageSearch | undefined {
    const entry = this.entries.get(keyOf(threadId, source))
    if (!entry) return undefined
    return { finished: entry.pages !== undefined && (entry.pages.length > 0 || entry.searches >= entry.tries), pages: entry.pages ?? NO_PAGES, working: entry.working, aboutPrototype: entry.aboutPrototype }
  }

  /**
   * The snapshot with each question's pages on it. Threads with nothing to change keep their own object. `replyOf` names
   * the replies of a thread whose pages are wanted, each looked for once and kept while it is named.
   *
   * With `gone`, the snapshot holds only the threads that changed (#925), and `gone` names the threads that went: only the
   * searches of those threads are read for what is still asked or looked for. Every other thread's are as the last
   * snapshot left them, which is what reading it again would leave them.
   */
  decorate(snapshot: AgentHostSnapshot, replyOf?: (thread: AgentThread) => ReplyToSearch | readonly ReplyToSearch[] | undefined, gone?: ReadonlySet<string>): AgentHostSnapshot {
    const present = new Set<string>()
    let changed = false
    const look = (thread: AgentThread, reply: ReplyToSearch): void => {
      const key = keyOf(thread.id, replySource(reply.id))
      present.add(key)
      if (!this.entries.has(key)) this.searchReply(key, thread, snapshot, reply)
    }
    const threads = snapshot.threads.map(thread => {
      const named = replyOf?.(thread)
      if (Array.isArray(named)) for (const reply of named as readonly ReplyToSearch[]) look(thread, reply)
      else if (named) look(thread, named as ReplyToSearch)
      const paged = this.paged(thread, { snapshot, present })
      if (paged !== thread) changed = true
      return paged
    })
    const now = this.now()
    if (!gone) for (const [key, entry] of this.entries) this.sweep(key, entry, present, now)
    else {
      for (const ids of [snapshot.threads.map(thread => thread.id), gone]) for (const id of ids) {
        const keys = this.byThread.get(id)
        if (keys) for (const key of [...keys]) this.sweep(key, this.entries.get(key)!, present, now)
      }
    }
    this.prune()
    return changed ? { ...snapshot, threads } : snapshot
  }

  /**
   * The snapshot's threads with each question's pages on it, as `decorate` gives them, without looking at anything: no
   * search starts or is tried again, and nothing is read for what is still asked or let go. For a thread whose searches
   * stand as the last snapshot left them (#925).
   */
  view(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    let changed = false
    const threads = snapshot.threads.map(thread => { const paged = this.paged(thread); if (paged !== thread) changed = true; return paged })
    return changed ? { ...snapshot, threads } : snapshot
  }

  /**
   * A thread with each question's pages on it. With `looking`, each question is noted as still asked, and its search
   * starts, or is tried again when it is due.
   */
  private paged(thread: AgentThread, looking?: { readonly snapshot: AgentHostSnapshot; readonly present: Set<string> }): AgentThread {
    // Most threads ask nothing: they are read without making anything, on every snapshot.
    if (!thread.requests.length) return thread
    let threadChanged = false
    const requests = thread.requests.map(request => {
      const asked = request.kind === 'question' && !isSottoRequest(request.id)
      const key = keyOf(thread.id, requestSource(request.id))
      if (asked && looking) {
        looking.present.add(key)
        const entry = this.entries.get(key)
        if (!entry) this.search(key, thread, looking.snapshot, request)
        else if (entry.pages?.length === 0 && entry.searches < entry.tries && this.now() - entry.searchedAt >= QUESTION_PAGE_SEARCH_GAP_MS) {
          this.search(key, thread, looking.snapshot, request, entry)
        }
      }
      const pages = asked ? this.entries.get(key)?.pages : undefined
      const carried = request.pages
      if (pages?.length ? JSON.stringify(carried) === JSON.stringify(pages) : carried === undefined) return request
      threadChanged = true
      const { pages: _carried, ...rest } = request
      void _carried
      return pages?.length ? { ...rest, pages: structuredClone(pages) } : rest
    })
    return threadChanged ? { ...thread, requests } : thread
  }

  /** One search read against what the snapshot still asks or looks for. */
  private sweep(key: string, entry: Entry, present: ReadonlySet<string>, now: number): void {
    if (present.has(key)) { delete entry.goneAt; this.lingering.delete(key) }
    // A reply no longer looked for that gave no page a token has nothing to serve: it goes at once, so the replies that
    // named nothing, most of them, leave nothing behind. One with pages lingers like a question's (ADR-0085).
    else if (entry.tries === 1 && !entry.pages?.length) this.forget(key)
    else { entry.goneAt ??= now; this.lingering.add(key) }
  }

  private put(key: string, entry: Entry): void {
    this.entries.set(key, entry)
    let keys = this.byThread.get(entry.threadId)
    if (!keys) this.byThread.set(entry.threadId, keys = new Set())
    keys.add(key)
  }

  private forget(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.lingering.delete(key)
    this.retrying.delete(key)
    const keys = this.byThread.get(entry.threadId)
    keys?.delete(key)
    if (keys?.size === 0) this.byThread.delete(entry.threadId)
  }

  /**
   * Looks for a question's pages. A search that finds none is tried again on a later snapshot, at most three times in
   * all, two seconds apart; a timer brings that snapshot when no other does. Once found, a question's pages stay as they are.
   */
  private search(key: string, thread: AgentThread, snapshot: AgentHostSnapshot, request: AgentRequest, previous?: Entry): void {
    const entry = this.begin(key, thread.id, requestSource(request.id), QUESTION_PAGE_SEARCHES, previous)
    const summary = thread.summary?.lastAssistant?.text
    this.find(key, entry, thread, snapshot, async () => {
      const stored = thread.messages.length ? undefined : await this.options.messages?.(thread.id)
      const reply = newestReply(thread.messages.length ? thread.messages : stored)
      return [...requestWords(request), reply ?? '', summary ?? '']
    })
  }

  /** Looks for a reply's pages, once, after the reply searches asked before it: a reply's words do not change. */
  private searchReply(key: string, thread: AgentThread, snapshot: AgentHostSnapshot, reply: ReplyToSearch): void {
    const entry = this.begin(key, thread.id, replySource(reply.id), 1)
    const known = reply.text ?? (reply.summary !== undefined && reply.summary.length < AGENT_THREAD_EXCERPT_MAX ? reply.summary : undefined)
    // A reply that names no page settles at once, without waiting its turn: most replies name none.
    if (known !== undefined && pageMentions([known]).length === 0) { this.settle(key, entry, [], []); return }
    this.replySearches = this.replySearches.then(() => new Promise<void>(resolve => {
      if (this.entries.get(key) !== entry) { resolve(); return }
      this.find(key, entry, thread, snapshot, async () => {
        if (known !== undefined) return [known]
        const carried = thread.messages.find(message => message.id === reply.id)?.text
        const stored = carried ?? (await this.options.messages?.(thread.id))?.find(message => message.id === reply.id)?.text
        return [stored ?? reply.summary ?? '']
      }, resolve)
    }))
  }

  private begin(key: string, threadId: string, source: string, tries: number, previous?: Entry): Entry {
    const entry: Entry = previous ?? { threadId, source, tries, pages: undefined, working: NO_PAGES, aboutPrototype: false, searches: 0, searchedAt: 0 }
    entry.pages = undefined
    entry.searches++
    entry.searchedAt = this.now()
    this.retrying.delete(key)
    this.put(key, entry)
    return entry
  }

  /** Finds the pages the words name, asks each loopback page once whether it answers, and gives each page a token. */
  private find(key: string, entry: Entry, thread: AgentThread, snapshot: AgentHostSnapshot, words: () => Promise<string[]>, done?: () => void): void {
    let folder: string | undefined
    try { folder = resolveThreadWorkingDirectory(thread, snapshot.projects.find(project => project.id === thread.projectId)) } catch { folder = undefined }
    void (async () => {
      const read = await words()
      if (this.entries.get(key) !== entry) return
      if (read.some(saysPrototype)) entry.aboutPrototype = true
      const found = await foundPages(pageMentions(read), folder)
      if (this.entries.get(key) !== entry) return
      const answers = await Promise.all(found.map(({ page, target }) => target.kind === 'file' ? true : this.live(`${target.origin}/${page.start}`).catch(() => false)))
      if (this.entries.get(key) !== entry) return
      const pages = found.map(({ page, target }) => {
        const token = this.token()
        this.targets.set(token, { target, key })
        return { ...page, token }
      })
      this.settle(key, entry, pages, pages.filter((_page, index) => answers[index]))
    })().catch(() => {
      // A page that cannot be read is a question without pages for now; the question itself is unaffected.
      if (this.entries.get(key) === entry) this.settle(key, entry, [], [])
    }).finally(() => done?.())
  }

  private settle(key: string, entry: Entry, pages: QuestionPage[], working: readonly QuestionPage[]): void {
    entry.pages = pages
    entry.working = working.length ? working : NO_PAGES
    if (!pages.length && entry.searches < entry.tries) this.retrying.add(key)
    if (pages.length) this.options.changed()
    else if (entry.searches < entry.tries) setTimeout(() => { if (this.entries.get(key) === entry) this.options.changed() }, QUESTION_PAGE_SEARCH_GAP_MS).unref?.()
    // A question's last search that finds none is news as well: a prototype question held for it waits on nothing else
    // (ADR-0108). A reply is searched once, and one that names no page needs no snapshot.
    else if (entry.tries > 1) this.options.changed()
  }

  private prune(): void {
    if (!this.lingering.size) return
    const now = this.now()
    for (const key of [...this.lingering]) {
      const entry = this.entries.get(key)
      if (entry?.goneAt === undefined) { this.lingering.delete(key); continue }
      if (now - entry.goneAt < QUESTION_PAGE_LINGER_MS) continue
      this.forget(key)
      for (const [token, item] of this.targets) if (item.key === key) this.targets.delete(token)
    }
  }
}
