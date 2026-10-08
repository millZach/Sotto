import { z } from 'zod'
import type { RunGitCommand } from './gitStatus'

/**
 * What Sotto asks GitHub through `gh` on the user's own sign-in (ADR-0027 decision 7), and how much of that sign-in's
 * GitHub allowance it lets itself spend (#820). Electron-free: the headless host uses it too.
 */

/** A repository on a GitHub host, as a remote URL names it. */
export interface GitHubRepository { readonly host: string; readonly owner: string; readonly name: string }

/**
 * The GitHub repository a remote URL names: HTTPS, `git@host:` or `ssh://`, on github.com or a host whose name says
 * GitHub (an Enterprise server). The host is the one gh is asked through (`gitHubApiHost`), so an SSH alias for
 * github.com is github.com. Null for any other remote, a local path among them, which gh cannot be asked about.
 */
export function parseGitHubRemote(url: string): GitHubRepository | null {
  const match = /^(?:https:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/|(?:[^@/\s]+@)?([^/:\s]+):(?!\/)|ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(url.trim())
  if (!match) return null
  const host = gitHubApiHost((match[1] ?? match[2] ?? match[3] ?? '').toLowerCase(), match[1] === undefined)
  return host ? { host, owner: match[4]!, name: match[5]! } : null
}
/**
 * The GitHub host gh is asked through for a remote on `host`, or null for a host that is not GitHub. github.com and any
 * name under it, `ssh.github.com` (GitHub's SSH over port 443) among them, are github.com, as gh itself takes them. Over
 * SSH, a name from `~/.ssh/config` that stands for GitHub, the usual way to keep two accounts apart (`github-work`,
 * `github.com-work`), names no API host of its own and is read through github.com (T3's `gitHubApiHostForRemote`).
 * Any other host whose name says GitHub is an Enterprise server, asked as itself.
 */
function gitHubApiHost(host: string, ssh: boolean): string | null {
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github.com'
  if (ssh && ((!host.includes('.') && host.includes('github')) || /^github\.com[-_]/u.test(host))) return 'github.com'
  return host.includes('github') ? host : null
}
export const sameRepository = (a: GitHubRepository, b: GitHubRepository): boolean =>
  a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
export const repositoryKey = (repository: GitHubRepository): string => `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase()

/** Each remote's URL as the user wrote it (before any `insteadOf`), and gh's own mark of the one it reads pull requests from. */
export async function readRemotes(run: RunGitCommand, cwd: string): Promise<Map<string, { url: string | null; ghResolved: string | null }>> {
  const remotes = new Map<string, { url: string | null; ghResolved: string | null }>()
  // Git answers 1 when no key matches, which is a repository with no remotes.
  const listing = await run(cwd, 'git', ['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$']).catch(() => '')
  for (const line of listing.split('\n')) {
    const match = /^remote\.(.+)\.(url|gh-resolved) (.*)$/u.exec(line.trim())
    if (!match) continue
    const entry = remotes.get(match[1]!) ?? { url: null, ghResolved: null }
    if (match[2] === 'url' && entry.url === null) entry.url = match[3]!
    else if (match[2] === 'gh-resolved') entry.ghResolved = match[3]!
    remotes.set(match[1]!, entry)
  }
  return remotes
}
/**
 * The repository gh reads pull requests from in this folder, picked the way gh picks it without a prompt (T3's
 * `selectGitHubBaseRepository`): gh orders the remotes `upstream`, `github`, `origin` (in any case), then the rest as
 * they are configured. The first remote `gh repo set-default` marked wins: `base` names that remote's own repository,
 * and `owner/name` another repository on the remote's host. With no mark, the first remote in that order. A fork whose
 * parent is `upstream` therefore reads the parent's pull requests, as `gh pr list` there does. Only remotes on GitHub count.
 */
export function baseRepository(remotes: ReadonlyMap<string, { url: string | null; ghResolved: string | null }>): GitHubRepository | null {
  const rank = (name: string): number => { const index = ['upstream', 'github', 'origin'].indexOf(name.toLowerCase()); return index === -1 ? 3 : index }
  const ordered = [...remotes].flatMap(([name, remote]) => {
    const repository = remote.url ? parseGitHubRemote(remote.url) : null
    return repository ? [{ name, repository, mark: remote.ghResolved?.trim() || null }] : []
  }).sort((a, b) => rank(a.name) - rank(b.name))
  const marked = ordered.find(remote => remote.mark !== null)
  if (marked?.mark === 'base') return marked.repository
  if (marked?.mark) {
    // gh writes `owner/name`, and reads `host/owner/name` too; either way the remote's own host is the one it asks.
    const parts = marked.mark.split('/')
    if ((parts.length === 2 || parts.length === 3) && parts.every(Boolean)) return { host: marked.repository.host, owner: parts.at(-2)!, name: parts.at(-1)! }
  }
  return ordered[0]?.repository ?? null
}

/** Asked by the timer, which may wait, or by the user (a refresh, a Git action, the Pull request surface), who should not. */
export type GitHubAsk = 'background' | 'user'

/** Asked inside every GraphQL query Sotto sends: GitHub's own reading of the allowance, at no extra cost. */
export const RATE_LIMIT_SELECTION = 'rateLimit { limit remaining resetAt }'
export const rateLimitSchema = z.object({ limit: z.number().int().nonnegative(), remaining: z.number().int(), resetAt: z.string() }).nullable().optional()
export type GitHubRateLimitReading = NonNullable<z.infer<typeof rateLimitSchema>>

/** A GitHub question not asked, or refused, for the rate limit; `retryAt` (epoch milliseconds) is when it may be asked again. */
export class GitHubRateLimited extends Error {
  constructor(readonly retryAt: number) { super('GitHub is limiting requests from this sign-in.') }
}

/**
 * Whether gh's words say GitHub refused for its rate limit, primary or secondary: "API rate limit exceeded", "You have
 * exceeded a secondary rate limit", GraphQL's `RATE_LIMITED`, HTTP 429, or the abuse detection wording. GitHub's own
 * phrases rather than the bare words, so an error that names a repository or branch called `rate-limit` is not one.
 */
export function isRateLimitAnswer(message: string): boolean {
  return /\bAPI rate limit\b|\bsecondary rate limit\b|\brate limit (?:already )?exceeded\b|\bRATE_LIMITED\b|abuse detection|\bHTTP 429\b|too many requests/iu.test(message)
}
const isPrimaryLimit = (message: string): boolean => /API rate limit (?:already )?exceeded|RATE_LIMITED/iu.test(message) && !/secondary/iu.test(message)

/** Background reads stop below this share of the allowance (T3's `RESERVE_RATIO`); the rest is the user's. */
const RESERVE_RATIO = 0.1
const PAUSE_BASE_MS = 30_000
const PAUSE_CAP_MS = 15 * 60_000

export type GitHubRateLimitEvent = 'github-rate-limited' | 'github-reserve-reached'
interface HostAllowance { login: string | null; reading: { limit: number; remaining: number; resetAt: number } | null; pauseUntil: number; failures: number; reserveLogged: number }

/**
 * The GitHub allowance of each host's sign-in, as GitHub last reported it, and the pause after it refused. One per
 * process, shared by the status reader and the Pull request surface, since both spend the same sign-in's points.
 *
 * - A background read is refused while less than 10% of the points remain, until GitHub's reset, and while a pause holds.
 * - A read the user asked for may spend the reserve and goes through a pause; only an allowance GitHub last reported
 *   empty refuses it, until the reset.
 * - A rate-limited answer pauses background reads until the reset GitHub gave, or, with none known, for 30 seconds
 *   doubling up to 15 minutes. Any answer GitHub gives ends the pause.
 */
export class GitHubRateLimit {
  private readonly hosts = new Map<string, HostAllowance>()
  private readonly now: () => number
  constructor(private readonly options: { readonly now?: () => number; readonly log?: (event: GitHubRateLimitEvent) => void } = {}) {
    this.now = options.now ?? (() => Date.now())
  }
  private entry(host: string): HostAllowance {
    let entry = this.hosts.get(host)
    if (!entry) { entry = { login: null, reading: null, pauseUntil: 0, failures: 0, reserveLogged: 0 }; this.hosts.set(host, entry) }
    return entry
  }
  /** When a question of this kind may be asked of `host`, or null when it may be asked now. */
  retryAt(host: string, ask: GitHubAsk): number | null {
    const entry = this.hosts.get(host)
    if (!entry) return null
    const now = this.now()
    const reading = entry.reading && entry.reading.resetAt > now ? entry.reading : null
    if (reading && reading.remaining <= 0) return reading.resetAt
    if (ask === 'user') return null
    if (entry.pauseUntil > now) return entry.pauseUntil
    if (reading && reading.remaining < reading.limit * RESERVE_RATIO) {
      if (entry.reserveLogged !== reading.resetAt) { entry.reserveLogged = reading.resetAt; this.options.log?.('github-reserve-reached') }
      return reading.resetAt
    }
    return null
  }
  /**
   * GitHub answered: the pause ends, and the reading it gave, if any, is kept. An answer from another sign-in on the same
   * host is another allowance, so what was known of the last one is dropped.
   */
  answered(host: string, reading: GitHubRateLimitReading | null | undefined, login?: string | null): void {
    const entry = this.entry(host)
    if (login && entry.login && login.toLowerCase() !== entry.login.toLowerCase()) entry.reading = null
    if (login) entry.login = login
    entry.pauseUntil = 0; entry.failures = 0
    const resetAt = reading ? Date.parse(reading.resetAt) : Number.NaN
    if (reading && Number.isFinite(resetAt)) entry.reading = { limit: reading.limit, remaining: reading.remaining, resetAt }
  }
  /** GitHub refused for its rate limit: background questions to `host` pause. Returns when the pause ends. */
  limited(host: string, message: string): number {
    const entry = this.entry(host)
    const now = this.now()
    entry.failures++
    let until = now + Math.min(PAUSE_BASE_MS * 2 ** (entry.failures - 1), PAUSE_CAP_MS)
    // A primary limit lasts until the reset GitHub last gave. A read the user asks for still goes through, and says so if it is refused.
    if (isPrimaryLimit(message) && entry.reading && entry.reading.resetAt > now) until = entry.reading.resetAt
    entry.pauseUntil = Math.max(entry.pauseUntil, until)
    this.options.log?.('github-rate-limited')
    return entry.pauseUntil
  }
}

/** When a refused question may be asked again, in words that need no clock: "in about 12 minutes". */
export function retryWords(retryAt: number, now: number): string {
  const minutes = Math.ceil((retryAt - now) / 60_000)
  if (minutes <= 1) return 'in a minute'
  if (minutes < 60) return `in about ${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours <= 1 ? 'in about an hour' : `in about ${hours} hours`
}
