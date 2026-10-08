import { homedir } from 'node:os'
import { z } from 'zod'
import { BABYSITTING_PER_THREAD_MAX, type AgentBabysitting, type BabysitStarter } from '../../shared/babysitting'
import { isRateLimitAnswer, refusalReading, type GitHubRateLimit, type GitHubRateLimitReading } from './github'
import { DETAIL_QUERY, FINGERPRINT_PER_QUERY, fingerprintQuery, readDetail, readFingerprint, type DetailAnswer, type PullRequestFingerprint } from './githubBabysitReads'
import { pullRequestAddress, pullRequestKey } from './gitPullRequests'
import { runGitStatusCommand, type RunGitCommand } from './gitStatus'
import { FAILED_READ_LIMIT, findNews, printable, publishedBabysitting, toldAtStart, type BabysitEnding, type BabysitNews, type BabysitRecord, type BabysitTold } from './babysitNews'

/**
 * Babysitting on the thread's host (ADR-0061): the reader that finds, every two minutes, what changed on each pull
 * request a thread babysits, and hands the news to `deliver`. Electron-free beside the Git status reader, so the desktop
 * and the headless host both run it, and not tied to a window being in front: babysitting exists for when the user is away.
 *
 * - One fingerprint query per repository, 25 pull requests to a query at one point, whatever number of threads babysit
 *   each; checks are read only when the status moved or a check is still running, and remarks only when they moved, or
 *   every 30 minutes for a pull request with review threads, whose edits the fingerprint cannot see (decision 13).
 * - Every read is a background read under #820's reserve and pause. A paused or refused pass is skipped and is not a failure.
 * - What each thread was last told is on its record in the host's `workspace.json` (`BabysitStore`), recorded only once
 *   the news is handed over, so a crash between the two reports the news twice rather than never (decision 8).
 */

/** How often a pass runs (decision 13). */
export const BABYSIT_PASS_MS = 2 * 60_000
/** How long a pull request with review threads goes before its remarks are read anyway (decision 13). */
export const REMARKS_REREAD_MS = 30 * 60_000
/**
 * Refused checks are asked for again next pass, and after this many refusals in a row only when the status moves or
 * every REMARKS_REREAD_MS: a sign-in that may never read a pull request's checks, such as a fine-grained token without
 * checks access, would otherwise cost a checks read every pass for as long as babysitting lasts.
 */
export const REFUSED_CHECKS_BEFORE_BACK_OFF = 3
/** Sotto links pull requests from github.com only (ADR-0027), so that is the host every read asks. */
const HOST = 'github.com'
const READ_TIMEOUT_MS = 30_000

/** Why a stop was asked: the agent's tool, the user's control, or the Settings switch turned off (decisions 2, 3 and 12). */
export type BabysitStopReason = 'agent' | 'user' | 'switch'
/** Why babysitting a pull request ended, as its log says. */
export type BabysitEndReason = BabysitEnding | 'stopped-by-agent' | 'stopped-by-user' | 'switched-off' | 'settled' | 'archived' | 'unlinked' | 'forgotten'
/** Stable event names only (decision 16): never a title, a link, a number, a login, a check's name or any text. */
export type BabysitEvent = 'babysit-started' | `babysit-ended-${BabysitEndReason}` | 'babysit-read-failed' | 'babysit-rate-limited'
const STOPPED: Readonly<Record<BabysitStopReason, BabysitEndReason>> = { agent: 'stopped-by-agent', user: 'stopped-by-user', switch: 'switched-off' }

/** One thread as babysitting sees it. */
export interface BabysitThread {
  readonly id: string
  /** Why the thread cannot be babysat for now: settled or archived ends babysitting quietly (decision 9). */
  readonly closed: 'settled' | 'archived' | null
  /**
   * Whether the thread knows the pull request: its branch's own, or one linked to it (decision 5). Asked when babysitting
   * starts and when a link is removed, never on a pass: the branch's own pull request is unknown after a restart until
   * the host asks GitHub again, which may not be for a long while with no window in front, and that is not an unlink.
   */
  readonly knows: (url: string) => boolean
  readonly records: readonly BabysitRecord[]
}
/** Where the records live: each thread's record in the host's workspace (`WorkspaceHost`). */
export interface BabysitStore {
  babysitThread(threadId: string): BabysitThread | null
  /** Every thread that babysits at least one pull request. */
  babysatThreads(): readonly BabysitThread[]
  /**
   * Replaces a thread's records with what `change` makes of the records it has now, and resolves once that is saved.
   * `change` runs at once, against the records as they stand, so a stop that lands during a read is never undone.
   * A thread that is gone changes nothing.
   */
  changeBabysitting(threadId: string, change: (records: readonly BabysitRecord[]) => readonly BabysitRecord[]): Promise<void>
  /**
   * Calls `listener` after a link is removed from a thread, the user's Unlink (decision 9), resolving once it is done.
   * Returns the function that stops it.
   */
  onPullRequestUnlinked?(listener: (threadId: string, url: string) => Promise<void>): () => void
  /**
   * Calls `listener` when a thread that babysits is settled or archived, so babysitting ends then rather than at the
   * next pass (decision 9). Returns the function that stops it.
   */
  onBabysatThreadClosed?(listener: () => void): () => void
}
/**
 * Hands one thread its news about one pull request, resolving once it is sent or durably queued; a rejection leaves it
 * untold, to be found again. #824 sends it through the thread's own send path as a wake-up.
 */
export type BabysitDeliver = (threadId: string, news: BabysitNews) => Promise<void>

export type BabysitStart =
  | { readonly started: true; readonly babysitting: AgentBabysitting }
  /** `already`: it babysits this one, unchanged. The others started nothing. */
  | { readonly started: false; readonly reason: 'already'; readonly babysitting: AgentBabysitting }
  /** `switched-off`: the agent's start, refused because Let agents babysit pull requests was turned off before it landed (decision 12). */
  | { readonly started: false; readonly reason: 'not-github' | 'unknown-thread' | 'closed-thread' | 'unknown-pull-request' | 'limit' | 'switched-off' }
/** Why nothing was started, in the words the user's control and the agent's tool both answer with (decision 5). */
export const BABYSIT_REFUSALS: Readonly<Record<Exclude<Extract<BabysitStart, { started: false }>['reason'], 'already'>, string>> = {
  'not-github': 'Sotto babysits pull requests on GitHub only. Nothing was started.',
  'unknown-thread': 'This thread is not on this host any more. Nothing was started.',
  'closed-thread': 'This thread is settled or archived. Restore it to babysit its pull request. Nothing was started.',
  'unknown-pull-request': 'Link this pull request to the thread first. Nothing was started.',
  limit: `This thread already babysits ${BABYSITTING_PER_THREAD_MAX} pull requests, the most one thread can. Stop one first. Nothing was started.`,
  'switched-off': 'Let agents babysit pull requests is turned off in Sotto\'s Settings. Nothing was started.',
}
/** One pull request a thread babysits, as `list` gives it. */
export interface BabysitListing extends AgentBabysitting { readonly threadId: string }

export interface BabysitterOptions {
  readonly store: BabysitStore
  readonly deliver: BabysitDeliver
  /** The process's one rate limit, shared with the status reader and the Pull request surface (#820). */
  readonly rateLimit: GitHubRateLimit
  readonly run?: RunGitCommand
  readonly now?: () => number
  readonly log?: (event: BabysitEvent) => void
  /**
   * Told when babysitting a pull request ended, with why, once it is saved. A quiet ending (a stop, a settle, an
   * unlink, the switch) takes back that pull request's part of a wake-up still waiting; one that ended with news has
   * just handed its last wake-up over. The ending waits for what it returns, so a stop has taken back its wake-up when it resolves.
   */
  readonly ended?: (threadId: string, url: string, reason: BabysitEndReason) => void | Promise<void>
}

interface Target { readonly threadId: string; readonly record: BabysitRecord }
interface Group { readonly key: string; readonly owner: string; readonly name: string; readonly number: number; readonly targets: Target[] }
/** What the last successful read of a pull request saw, kept in memory: after a restart each is read whole once. */
interface LastRead {
  /** The fingerprint's status its checks were read against; empty when the checks still need reading. */
  readonly status: string
  /** The fingerprint's remarks the remarks were read against; empty when they still need reading. */
  readonly remarks: string
  readonly remarksAt: number
  /** Checks reads in a row GitHub refused, and when refused checks are next asked for once they are backed off. */
  readonly refusedChecks: number
  readonly checksDueAt: number | null
  /** The records it was evaluated for: one started since takes its first look with everything read. */
  readonly records: ReadonlySet<string>
}

const recordKey = (threadId: string, record: BabysitRecord): string => `${threadId}\0${pullRequestKey(record.url) ?? record.url}\0${record.startedAt}`
const sameRecord = (left: BabysitRecord, right: BabysitRecord): boolean => left.startedAt === right.startedAt && pullRequestKey(left.url) === pullRequestKey(right.url)
const sameTold = (left: BabysitTold, right: BabysitTold): boolean => JSON.stringify(left) === JSON.stringify(right)

/** What gh printed before it failed, read as an answer when it is one; null otherwise. */
function partialAnswer<T>(error: unknown, read: (text: string) => T): T | null {
  const stdout = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
  if (!stdout.trim()) return null
  try { return read(stdout) } catch { return null }
}

export class Babysitter {
  private readonly run: RunGitCommand
  private readonly now: () => number
  private readonly lastReads = new Map<string, LastRead>()
  /** Records the last pass saw, so one whose thread was forgotten since is logged as ended. */
  private seen = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private passing: Promise<void> | undefined
  private closed = false
  /** Whether this pass already logged a rate limit, so a paused pass logs it once. */
  private limitLogged = false
  private readonly stopListening: (() => void) | undefined
  private readonly stopClosedListening: (() => void) | undefined
  /** Ending what settled or archived threads babysat, and whether another thread closed while it ran. */
  private endingClosed: Promise<void> | undefined
  private closedAgain = false
  /** Starts and stops, one at a time in the order asked, so a start never lands after a stop that should have ended it. */
  private changes: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: BabysitterOptions) {
    this.run = options.run ?? runGitStatusCommand
    this.now = options.now ?? (() => Date.now())
    this.stopListening = options.store.onPullRequestUnlinked?.((threadId, url) => this.unlinked(threadId, url))
    this.stopClosedListening = options.store.onBabysatThreadClosed?.(() => { void this.endClosed() })
  }

  /** Starts the two-minute passes, the first at once, so what changed while the host was not reading is told now. */
  begin(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => { void this.pass() }, BABYSIT_PASS_MS)
    this.timer.unref?.()
    void this.pass()
  }

  /** Stops the passes, and waits for one under way to finish what it is doing. */
  async close(): Promise<void> {
    this.closed = true
    this.stopListening?.()
    this.stopClosedListening?.()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.passing
  }

  /**
   * Starts babysitting a pull request the thread knows, for whoever asked. Asks nobody (decision 4) and reads nothing
   * now: the next pass takes its first look, telling what stands then (failing checks, a pass, a conflict) and the
   * remarks written after this moment. `allowed` is asked once it is this start's turn among starts and stops, so a
   * start it refuses never lands after the switch's sweep (decision 12).
   */
  start(threadId: string, url: string, startedBy: BabysitStarter, options: { readonly allowed?: () => boolean } = {}): Promise<BabysitStart> {
    return this.oneAtATime(() => {
      if (options.allowed && !options.allowed()) return Promise.resolve<BabysitStart>({ started: false, reason: 'switched-off' })
      return this.startNow(threadId, url, startedBy)
    })
  }
  private oneAtATime<T>(change: () => Promise<T>): Promise<T> {
    const task = this.changes.then(change)
    this.changes = task.catch(() => undefined)
    return task
  }
  private async startNow(threadId: string, url: string, startedBy: BabysitStarter): Promise<BabysitStart> {
    const address = pullRequestAddress(url)
    const key = pullRequestKey(url)
    if (!address || !key) return { started: false, reason: 'not-github' }
    const thread = this.options.store.babysitThread(threadId)
    if (!thread) return { started: false, reason: 'unknown-thread' }
    if (thread.closed) return { started: false, reason: 'closed-thread' }
    if (!thread.knows(url)) return { started: false, reason: 'unknown-pull-request' }
    const startedAt = new Date(this.now()).toISOString()
    const record: BabysitRecord = { url: `https://github.com/${address.owner}/${address.name}/pull/${address.number}`, number: address.number, startedBy, startedAt, told: toldAtStart(startedAt) }
    let outcome: BabysitStart = { started: false, reason: 'unknown-thread' }
    await this.options.store.changeBabysitting(threadId, records => {
      const existing = records.find(item => pullRequestKey(item.url) === key)
      if (existing) { outcome = { started: false, reason: 'already', babysitting: publishedBabysitting(existing) }; return records }
      if (records.length >= BABYSITTING_PER_THREAD_MAX) { outcome = { started: false, reason: 'limit' }; return records }
      outcome = { started: true, babysitting: publishedBabysitting(record) }
      return [...records, record]
    })
    if (outcome.started) this.options.log?.('babysit-started')
    return outcome
  }

  /**
   * Stops babysitting what the selector names: one pull request of a thread, all of a thread's, or, with no thread,
   * every thread's (the switch, with `startedBy: 'agent'`). Sends the thread nothing (decision 9). Resolves with how many stopped.
   */
  stop(selector: { readonly threadId?: string; readonly url?: string; readonly startedBy?: BabysitStarter }, reason: BabysitStopReason): Promise<number> {
    return this.oneAtATime(() => this.stopNow(selector, reason))
  }
  private async stopNow(selector: { readonly threadId?: string; readonly url?: string; readonly startedBy?: BabysitStarter }, reason: BabysitStopReason): Promise<number> {
    const key = selector.url === undefined ? undefined : pullRequestKey(selector.url)
    if (key === null) return 0
    const threads = selector.threadId === undefined ? this.options.store.babysatThreads() : [this.options.store.babysitThread(selector.threadId)].flatMap(thread => thread ? [thread] : [])
    let stopped = 0
    for (const thread of threads) {
      const matches = (record: BabysitRecord): boolean => (key === undefined || pullRequestKey(record.url) === key) && (selector.startedBy === undefined || record.startedBy === selector.startedBy)
      let removed: BabysitRecord[] = []
      await this.options.store.changeBabysitting(thread.id, records => { removed = records.filter(matches); return removed.length ? records.filter(record => !matches(record)) : records })
      for (const record of removed) { this.seen.delete(recordKey(thread.id, record)); await this.tellEnded(thread.id, record.url, STOPPED[reason]) }
      stopped += removed.length
    }
    return stopped
  }

  /**
   * A link removed from the thread ends babysitting that pull request quietly (decision 9), unless the thread still
   * knows it as its branch's own.
   */
  private async unlinked(threadId: string, url: string): Promise<void> {
    const key = pullRequestKey(url)
    const thread = this.options.store.babysitThread(threadId)
    if (!key || !thread || thread.knows(url)) return
    for (const record of thread.records) if (pullRequestKey(record.url) === key) await this.endQuietly({ threadId, record }, 'unlinked')
  }

  /**
   * Ends, quietly and at once, what every settled or archived thread babysits (decision 9): settling or archiving a
   * thread sends it nothing, and takes back a wake-up still waiting for it. A pass would end them too; this is sooner.
   */
  endClosed(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.endingClosed) { this.closedAgain = true; return this.endingClosed }
    this.endingClosed = (async () => {
      do {
        this.closedAgain = false
        for (const thread of this.options.store.babysatThreads()) {
          if (!thread.closed) continue
          for (const record of thread.records) await this.endQuietly({ threadId: thread.id, record }, thread.closed)
        }
      } while (this.closedAgain && !this.closed)
    })().catch(() => undefined).finally(() => { this.endingClosed = undefined })
    return this.endingClosed
  }

  /** The pull requests babysat, by one thread or by every thread: which, who started each and since when. */
  list(threadId?: string): BabysitListing[] {
    const threads = threadId === undefined ? this.options.store.babysatThreads() : [this.options.store.babysitThread(threadId)].flatMap(thread => thread ? [thread] : [])
    return threads.flatMap(thread => thread.records.map(record => ({ threadId: thread.id, ...publishedBabysitting(record) })))
  }

  /** One pass over every babysat pull request. A pass under way is shared rather than run twice. */
  pass(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.passing ??= this.runPass().catch(() => undefined).finally(() => { this.passing = undefined })
    return this.passing
  }

  private async runPass(): Promise<void> {
    this.limitLogged = false
    const store = this.options.store
    const groups = new Map<string, Group>()
    const seen = new Map<string, string>()
    for (const thread of store.babysatThreads()) {
      for (const record of thread.records) {
        if (thread.closed) { await this.endQuietly({ threadId: thread.id, record }, thread.closed); continue }
        const address = pullRequestAddress(record.url), key = pullRequestKey(record.url)
        if (!address || !key) continue
        seen.set(recordKey(thread.id, record), thread.id)
        const group = groups.get(key) ?? { key, owner: address.owner, name: address.name, number: address.number, targets: [] }
        group.targets.push({ threadId: thread.id, record })
        groups.set(key, group)
      }
    }
    // A record that went with its thread was forgotten, which ends it with nothing to tell.
    for (const [key, threadId] of this.seen) if (!seen.has(key) && !store.babysitThread(threadId)) this.options.log?.('babysit-ended-forgotten')
    this.seen = seen
    for (const key of this.lastReads.keys()) if (!groups.has(key)) this.lastReads.delete(key)
    const repositories = new Map<string, Group[]>()
    for (const group of groups.values()) {
      const repository = `${group.owner}/${group.name}`.toLowerCase()
      repositories.set(repository, [...repositories.get(repository) ?? [], group])
    }
    for (const members of repositories.values()) {
      for (let start = 0; start < members.length; start += FINGERPRINT_PER_QUERY) {
        if (this.closed) return
        await this.readChunk(members.slice(start, start + FINGERPRINT_PER_QUERY))
      }
    }
  }

  /** May a background read go now? A pause or the reserve says no, and the pass skips it without counting a failure. */
  private mayRead(): boolean {
    if (this.options.rateLimit.retryAt(HOST, 'background') === null) return true
    this.rateLimited()
    return false
  }
  private rateLimited(): void {
    if (!this.limitLogged) this.options.log?.('babysit-rate-limited')
    this.limitLogged = true
  }

  /**
   * gh's answer, or what it was: a rate-limit refusal pauses the host and is `limited`, anything else is a failed read.
   * Only gh's own error is read for the rate limit: an answer that failed to parse names its fields, `rateLimit` among
   * them. GitHub can answer a query and refuse a part of it, one pull request it cannot find among 25 say; gh then fails
   * with what it did read on its output, and that answer stands, so one pull request gone does not fail the rest.
   */
  private async ask<T extends { readonly rateLimit?: GitHubRateLimitReading | null | undefined }>(args: readonly string[], read: (text: string) => T, viewer?: (answer: T) => string | null): Promise<T | 'limited' | 'failed'> {
    const asked = this.options.rateLimit.asking()
    let answer: T
    try { answer = read(await this.run(homedir(), 'gh', ['api', 'graphql', ...args], { timeoutMs: READ_TIMEOUT_MS })) }
    catch (error) {
      const message = error instanceof Error && !(error instanceof z.ZodError) && !(error instanceof SyntaxError) ? error.message : ''
      if (isRateLimitAnswer(message)) {
        this.options.rateLimit.limited(HOST, message, refusalReading(error))
        this.rateLimited()
        return 'limited'
      }
      const partial = partialAnswer(error, read)
      if (!partial) return 'failed'
      answer = partial
    }
    this.options.rateLimit.answered(HOST, asked, answer.rateLimit, viewer?.(answer) ?? null)
    return answer
  }

  /** One fingerprint for up to 25 pull requests of one repository, then what each needs read. */
  private async readChunk(groups: readonly Group[]): Promise<void> {
    if (!this.mayRead()) return
    const numbers = groups.map(group => group.number)
    const first = groups[0]!
    const answer = await this.ask(['-f', `query=${fingerprintQuery(numbers.length)}`, '-f', `owner=${first.owner}`, '-f', `name=${first.name}`,
      ...numbers.flatMap((number, index) => ['-F', `p${index}=${number}`])], text => readFingerprint(text, numbers), fingerprint => fingerprint.viewer)
    if (answer === 'limited') return
    for (const group of groups) {
      if (this.closed) return
      const fingerprint = answer === 'failed' ? undefined : answer.pullRequests.get(group.number)
      // A pull request GitHub answered nothing for is gone, or not visible to the sign-in: a failed read like any other.
      if (!fingerprint || answer === 'failed') await this.failedRead(group)
      else await this.readGroup(group, fingerprint, answer.viewer)
    }
  }

  private async readGroup(group: Group, fingerprint: PullRequestFingerprint, viewer: string | null): Promise<void> {
    if (fingerprint.state !== 'open') {
      // Merged or closed is in the fingerprint itself: no more to read, and babysitting ends with the news.
      this.lastReads.delete(group.key)
      for (const target of group.targets) {
        const news: BabysitNews = { pullRequest: this.pullRequestOf(target, fingerprint), startedBy: target.record.startedBy, head: fingerprint.head, changes: [], ended: fingerprint.state }
        await this.tellAndEnd(target, news, fingerprint.state)
      }
      return
    }
    const now = this.now()
    const last = this.lastReads.get(group.key)
    const firstLook = !last || group.targets.some(target => !last.records.has(recordKey(target.threadId, target.record)))
    // A running check is read every pass, except while refused checks are backed off: then a status move or the
    // half-hourly retry reads them, so a check that runs for hours behind a refusal costs no more than a finished one.
    const backedOff = !firstLook && last.refusedChecks >= REFUSED_CHECKS_BEFORE_BACK_OFF
    const checks = firstLook || last.status !== fingerprint.status || (fingerprint.checksRunning && !backedOff) || (last.checksDueAt !== null && now >= last.checksDueAt)
    const remarks = firstLook || last.remarks !== fingerprint.remarks || (fingerprint.reviewThreads > 0 && now - last.remarksAt >= REMARKS_REREAD_MS)
    let detail: DetailAnswer | null = null
    if (checks || remarks) {
      if (!this.mayRead()) return
      const answer = await this.ask(['-f', `query=${DETAIL_QUERY}`, '-f', `owner=${group.owner}`, '-f', `name=${group.name}`,
        '-F', `number=${group.number}`, '-F', `checks=${checks}`, '-F', `remarks=${remarks}`], text => readDetail(text, { checks, remarks }))
      if (answer === 'limited') return
      if (answer === 'failed') { this.lastReads.delete(group.key); await this.failedRead(group); return }
      detail = answer
    }
    // Checks asked for and not read (a check refused, or the head moved under the read) are asked again next pass, and
    // once refused REFUSED_CHECKS_BEFORE_BACK_OFF times in a row, when the status moves or every REMARKS_REREAD_MS.
    const checksRead = checks ? detail?.checks != null : true
    const refusedChecks = !checks ? last?.refusedChecks ?? 0 : checksRead ? 0 : (last?.refusedChecks ?? 0) + 1
    const backOff = !checksRead && refusedChecks >= REFUSED_CHECKS_BEFORE_BACK_OFF
    this.lastReads.set(group.key, {
      status: checksRead || backOff ? fingerprint.status : '',
      refusedChecks,
      checksDueAt: !checks ? last?.checksDueAt ?? null : backOff ? now + REMARKS_REREAD_MS : null,
      remarks: remarks ? fingerprint.remarks : last?.remarks ?? '',
      remarksAt: remarks ? now : last?.remarksAt ?? now,
      records: new Set(group.targets.map(target => recordKey(target.threadId, target.record))),
    })
    let landed = true
    for (const target of group.targets) {
      const finding = findNews(target.record.told, { fingerprint, head: detail?.head ?? null, checks: detail?.checks ?? null, remarks: detail?.remarks ?? null, viewer })
      if (finding.changes.length === 0) {
        if (!sameTold(finding.told, target.record.told)) landed = await this.record(target, finding.told) && landed
        continue
      }
      const news: BabysitNews = { pullRequest: this.pullRequestOf(target, fingerprint), startedBy: target.record.startedBy, head: finding.told.head,
        changes: finding.changes, ended: finding.exhausted ? 'comment-limit' : null }
      landed = (finding.exhausted ? await this.tellAndEnd(target, news, 'comment-limit') : await this.tell(target, news, finding.told)) && landed
    }
    // A thread that did not get its news must not wait for the fingerprint to move again.
    if (!landed) this.lastReads.delete(group.key)
  }

  /** A pass that could not read the pull request, for a reason other than a rate limit. The eighth in a row ends it. */
  private async failedRead(group: Group): Promise<void> {
    this.options.log?.('babysit-read-failed')
    for (const target of group.targets) {
      const failedReads = target.record.told.failedReads + 1
      if (failedReads < FAILED_READ_LIMIT) { await this.record(target, { ...target.record.told, failedReads }); continue }
      const news: BabysitNews = { pullRequest: { url: target.record.url, number: target.record.number, title: null }, startedBy: target.record.startedBy, head: target.record.told.head, changes: [], ended: 'unreadable' }
      // A wake-up that could not be handed over still counts the failure, so the next failed pass tries again.
      if (!await this.tellAndEnd(target, news, 'unreadable')) await this.record(target, { ...target.record.told, failedReads })
    }
  }

  private pullRequestOf(target: Target, fingerprint: PullRequestFingerprint): BabysitNews['pullRequest'] {
    return { url: target.record.url, number: target.record.number, title: printable(fingerprint.title, 500) }
  }

  /** Whether the record a read was made for is still babysat: one stopped while GitHub was read is told nothing. */
  private stillBabysat(target: Target): boolean {
    return this.options.store.babysitThread(target.threadId)?.records.some(record => sameRecord(record, target.record)) === true
  }
  /** Hands the news over, then records what the thread was told. False when either did not happen. */
  private async tell(target: Target, news: BabysitNews, told: BabysitTold): Promise<boolean> {
    if (!this.stillBabysat(target)) return true
    try { await this.options.deliver(target.threadId, news) } catch { return false }
    return this.record(target, told)
  }
  /** Hands over the wake-up that ends babysitting, then ends it. False when either did not happen. */
  private async tellAndEnd(target: Target, news: BabysitNews, reason: BabysitEnding): Promise<boolean> {
    if (!this.stillBabysat(target)) return true
    try { await this.options.deliver(target.threadId, news) } catch { return false }
    return this.endQuietly(target, reason)
  }
  /** Ends babysitting with nothing sent: the news, if any, has gone already. */
  private async endQuietly(target: Target, reason: BabysitEndReason): Promise<boolean> {
    let removed = false
    try {
      await this.options.store.changeBabysitting(target.threadId, records => {
        const kept = records.filter(record => !sameRecord(record, target.record))
        removed = kept.length !== records.length
        return removed ? kept : records
      })
    } catch { return false }
    this.seen.delete(recordKey(target.threadId, target.record))
    if (removed) await this.tellEnded(target.threadId, target.record.url, reason)
    return true
  }
  /** Logs an ending and tells `ended`, waiting for it; what it does cannot undo the ending. */
  private async tellEnded(threadId: string, url: string, reason: BabysitEndReason): Promise<void> {
    this.options.log?.(`babysit-ended-${reason}`)
    try { await this.options.ended?.(threadId, url, reason) } catch { /* Ended all the same. */ }
  }
  /** Records what the thread was told, on the record it was found for: a record stopped or started again since is left alone. */
  private async record(target: Target, told: BabysitTold): Promise<boolean> {
    try {
      await this.options.store.changeBabysitting(target.threadId, records =>
        records.some(record => sameRecord(record, target.record)) ? records.map(record => sameRecord(record, target.record) ? { ...record, told } : record) : records)
      return true
    } catch { return false }
  }
}
