import type { GitHubRateLimit } from './github'
import { DETAIL_QUERY, FINGERPRINT_PER_QUERY, fingerprintQuery, pullRequestObservation, readDetail, readFingerprint, type DetailAnswer, type PullRequestFingerprint } from './githubBabysitReads'
import { pullRequestAddress, pullRequestKey } from '../../shared/gitPullRequests'
import { runGitStatusCommand, type RunGitCommand } from './gitStatus'
import type { PullRequestObservation } from './watcherEvidence'
import { PULL_REQUEST_HOST, PULL_REQUEST_PASS_MS, askPullRequests, checksAfter, checksDue, isFailedRead, openPullRequestObservation, type ChecksRead } from './backgroundPullRequestReads'

/**
 * Watcher's own background reads of pull requests (ADR-0144). With Restart stopped threads on, babysitting and its
 * wake-ups are gone, and this reader takes its place for Watcher alone: every two minutes it reads the pull requests of
 * the threads Watcher watches, their linked ones and their branches' own, and hands each read to `observed`, which is
 * where babysitting's reads went (Watcher's news, the threads' links, Keep main up to date). Nothing it reads is a
 * thread's wake-up, and it keeps no record on disk.
 *
 * Babysitting's cost model holds: one fingerprint query per repository, 25 pull requests to a query, whatever number of
 * threads share one; checks only when the status moved, a check is still running or refused checks are due again; and
 * every read a background read under #820's reserve and pause. Remarks are never read in detail: Watcher hears that they
 * moved from the fingerprint alone. A pass's work grows with the pull requests asked for, never with a thread's history.
 */

/** Stable event names only: never a link, a number, a login or any text. */
export type WatchedPullRequestEvent = 'watched-pull-request-read-failed' | 'watched-pull-request-rate-limited' | 'watched-pull-request-unreachable'

export interface WatchedPullRequestReaderOptions {
  /** The pull requests to read now, by URL: each watched thread's open ones. Asked once at the start of every pass. */
  readonly pullRequests: () => Iterable<string>
  readonly observed: (read: PullRequestObservation) => void
  /** The process's one rate limit, shared with the status reader and the Pull request surface (#820). */
  readonly rateLimit: GitHubRateLimit
  readonly run?: RunGitCommand
  readonly now?: () => number
  readonly log?: (event: WatchedPullRequestEvent) => void
}

interface Target { readonly key: string; readonly url: string; readonly owner: string; readonly name: string; readonly number: number }
/** What the last read of a pull request saw, kept in memory: after a restart each is read whole once. */
interface LastRead extends ChecksRead { readonly observation: PullRequestObservation }

export class WatchedPullRequestReader {
  private readonly run: RunGitCommand
  private readonly now: () => number
  private readonly lastReads = new Map<string, LastRead>()
  /** Pull requests a read found merged or closed, not read again while they are asked for. In memory only. */
  private readonly ended = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private passing: Promise<void> | undefined
  private closed = false
  private limitLogged = false
  private unreachableLogged = false

  constructor(private readonly options: WatchedPullRequestReaderOptions) {
    this.run = options.run ?? runGitStatusCommand
    this.now = options.now ?? (() => Date.now())
  }

  /** Starts the two-minute passes, the first at once. */
  begin(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => { void this.pass() }, PULL_REQUEST_PASS_MS)
    this.timer.unref?.()
    void this.pass()
  }

  /** Stops the passes, and waits for one under way to finish. */
  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.passing
  }

  /** One pass over every watched pull request. A pass under way is shared rather than run twice. */
  pass(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.passing ??= this.runPass().catch(() => undefined).finally(() => { this.passing = undefined })
    return this.passing
  }

  private async runPass(): Promise<void> {
    this.limitLogged = false
    this.unreachableLogged = false
    const targets = new Map<string, Target>()
    for (const url of this.options.pullRequests()) {
      const key = pullRequestKey(url), address = pullRequestAddress(url)
      if (!key || !address || targets.has(key)) continue
      targets.set(key, { key, url, owner: address.owner, name: address.name, number: address.number })
    }
    // What is no longer asked for is forgotten, so memory follows the watched threads rather than everything they ever linked.
    for (const key of this.lastReads.keys()) if (!targets.has(key)) this.lastReads.delete(key)
    for (const key of this.ended) if (!targets.has(key)) this.ended.delete(key)
    const repositories = new Map<string, Target[]>()
    for (const target of targets.values()) {
      if (this.ended.has(target.key)) continue
      const repository = `${target.owner}/${target.name}`.toLowerCase()
      const members = repositories.get(repository)
      if (members) members.push(target); else repositories.set(repository, [target])
    }
    for (const members of repositories.values()) {
      for (let start = 0; start < members.length; start += FINGERPRINT_PER_QUERY) {
        if (this.closed) return
        await this.readChunk(members.slice(start, start + FINGERPRINT_PER_QUERY))
      }
    }
  }

  private asker() {
    return { run: this.run, rateLimit: this.options.rateLimit, limited: () => this.rateLimited(), unreachable: () => this.unreachable() }
  }
  /** May a background read go now? A pause or the reserve says no, and the pass skips it. */
  private mayRead(): boolean {
    if (this.options.rateLimit.retryAt(PULL_REQUEST_HOST, 'background') === null) return true
    this.rateLimited()
    return false
  }
  private rateLimited(): void {
    if (!this.limitLogged) this.options.log?.('watched-pull-request-rate-limited')
    this.limitLogged = true
  }
  private unreachable(): void {
    if (!this.unreachableLogged) this.options.log?.('watched-pull-request-unreachable')
    this.unreachableLogged = true
  }

  /** One fingerprint for up to 25 pull requests of one repository, then the checks of each that needs them. */
  private async readChunk(targets: readonly Target[]): Promise<void> {
    if (!this.mayRead()) return
    const numbers = targets.map(target => target.number)
    const first = targets[0]!
    const answer = await askPullRequests(this.asker(), ['-f', `query=${fingerprintQuery(numbers.length)}`, '-f', `owner=${first.owner}`, '-f', `name=${first.name}`,
      ...numbers.flatMap((number, index) => ['-F', `p${index}=${number}`])], text => readFingerprint(text, numbers), fingerprint => fingerprint.viewer)
    if (answer === 'limited' || answer === 'unreachable') { for (const target of targets) this.unavailable(target, answer === 'limited' ? 'rate-limited' : 'read-failed'); return }
    if (isFailedRead(answer)) { this.failed(targets); return }
    for (const target of targets) {
      if (this.closed) return
      const fingerprint = answer.pullRequests.get(target.number)
      // A pull request GitHub answered nothing for is gone, or not visible to the sign-in: a failed read like any other.
      if (!fingerprint) this.failed([target])
      else await this.readOne(target, fingerprint)
    }
  }

  private async readOne(target: Target, fingerprint: PullRequestFingerprint): Promise<void> {
    const now = this.now()
    if (fingerprint.state !== 'open') {
      // Merged or closed is in the fingerprint itself, and is told once: the pull request is not read again while it is asked for.
      this.options.observed(pullRequestObservation(fingerprint, null, new Date(now).toISOString()))
      this.lastReads.delete(target.key)
      this.ended.add(target.key)
      return
    }
    const last = this.lastReads.get(target.key)
    const checks = checksDue(last, last === undefined, fingerprint, now)
    let detail: DetailAnswer | null = null
    if (checks) {
      if (!this.mayRead()) return
      const read = await askPullRequests(this.asker(), ['-f', `query=${DETAIL_QUERY}`, '-f', `owner=${target.owner}`, '-f', `name=${target.name}`,
        '-F', `number=${target.number}`, '-F', 'checks=true', '-F', 'remarks=false'], text => readDetail(text, { checks: true, remarks: false }))
      if (read === 'limited') { this.unavailable(target, 'rate-limited'); return }
      if (read === 'unreachable') { this.unavailable(target, 'read-failed'); return }
      if (isFailedRead(read)) { this.lastReads.delete(target.key); this.failed([target]); return }
      detail = read
    }
    const observation = openPullRequestObservation(fingerprint, detail, now, last?.observation, checks)
    this.options.observed(observation)
    this.lastReads.set(target.key, { observation, ...checksAfter(last, checks, detail, fingerprint, now) })
  }

  /** A pass that could not read the pull request: Watcher hears it is unavailable, keeping the head it last knew. */
  private unavailable(target: Target, reason: 'read-failed' | 'rate-limited'): void {
    this.options.observed({ url: target.url, head: this.lastReads.get(target.key)?.observation.head ?? null, availability: 'unavailable', reason, observedAt: new Date(this.now()).toISOString() })
  }
  private failed(targets: readonly Target[]): void {
    this.options.log?.('watched-pull-request-read-failed')
    for (const target of targets) this.unavailable(target, 'read-failed')
  }
}
