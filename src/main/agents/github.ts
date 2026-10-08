import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { z } from 'zod'
import type { RunGitCommand } from './gitStatus'

/**
 * What Sotto asks GitHub through `gh` on the user's own sign-in (ADR-0027 decision 7), and how much of that sign-in's
 * GitHub allowance it lets itself spend (#820). Electron-free: the headless host uses it too.
 */

/** A repository on a GitHub host, as a remote URL names it. */
export interface GitHubRepository { readonly host: string; readonly owner: string; readonly name: string }

/** A remote URL's parts: HTTPS, `git@host:` or `ssh://`, the host lowercased. Null for anything else, a local path among them. */
function parseRemoteUrl(url: string): { host: string; ssh: boolean; owner: string; name: string } | null {
  const match = /^(?:https:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/|(?:[^@/\s]+@)?([^/:\s]+):(?!\/)|ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(url.trim())
  if (!match) return null
  return { host: (match[1] ?? match[2] ?? match[3] ?? '').toLowerCase(), ssh: match[1] === undefined, owner: match[4]!, name: match[5]! }
}

/**
 * The GitHub repository a remote URL names, judged by its host's name alone: github.com, or a host whose name says
 * GitHub (an Enterprise server). The host is the one gh is asked through (`gitHubApiHost`), so an SSH alias for
 * github.com is github.com. Null for any other remote. `GitHubHosts` also knows the hosts gh is signed in to and the
 * SSH aliases `~/.ssh/config` names, which a name alone cannot say.
 */
export function parseGitHubRemote(url: string): GitHubRepository | null {
  const remote = parseRemoteUrl(url)
  const host = remote ? gitHubApiHost(remote.host, remote.ssh) : null
  return remote && host ? { host, owner: remote.owner, name: remote.name } : null
}
const isGitHubDotCom = (host: string): boolean => host === 'github.com' || host.endsWith('.github.com')
/**
 * The GitHub host gh is asked through for a remote on `host`, or null for a host whose name does not say GitHub.
 * github.com and any name under it, `ssh.github.com` (GitHub's SSH over port 443) among them, are github.com, as gh
 * itself takes them. Over SSH, a name from `~/.ssh/config` that stands for GitHub, the usual way to keep two accounts
 * apart (`github-work`, `github.com-work`), names no API host of its own and is read through github.com (T3's
 * `gitHubApiHostForRemote`). Any other host whose name says GitHub is an Enterprise server, asked as itself.
 */
function gitHubApiHost(host: string, ssh: boolean): string | null {
  if (isGitHubDotCom(host)) return 'github.com'
  if (ssh && ((!host.includes('.') && host.includes('github')) || /^github\.com[-_]/u.test(host))) return 'github.com'
  return host.includes('github') ? host : null
}
export const sameRepository = (a: GitHubRepository, b: GitHubRepository): boolean =>
  a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
export const repositoryKey = (repository: GitHubRepository): string => `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase()

/** How long what gh and SSH said about hosts is kept: a new sign-in or an `~/.ssh/config` edit is seen within this. */
const HOSTS_FRESH_MS = 10 * 60_000
/** A host name SSH may be asked about: nothing it could take for an option. */
const SSH_ALIAS = /^[a-z0-9_][a-z0-9._-]*$/iu

/** The host name `ssh -G` gives for an alias, read from `~/.ssh/config` with no connection made; null when SSH cannot say. */
export function readSshHostName(alias: string): Promise<string | null> {
  if (!SSH_ALIAS.test(alias)) return Promise.resolve(null)
  return new Promise(resolve => {
    execFile('ssh', ['-G', alias], { windowsHide: true, timeout: 5_000, encoding: 'utf8', maxBuffer: 1_000_000 }, (error, stdout) => {
      resolve(error ? null : /^hostname\s+(\S+)\s*$/imu.exec(stdout)?.[1]?.toLowerCase() ?? null)
    })
  })
}

/**
 * Which hosts gh asks as GitHub, the way gh itself decides it. gh reads a remote on any host it is signed in to, GitHub
 * Enterprise Server on its own domain and a GHE.com host among them, and reads an SSH remote's host through
 * `~/.ssh/config`, so `git@work:me/repo` behind `Host work` with `HostName github.com` is github.com. An SSH host other
 * than github.com is looked up with `ssh -G`, which connects to nothing. A host whose name then says GitHub is taken
 * without asking more; any other counts only when gh is signed in to it (`gh auth status`, host names only, no token
 * read). Both answers are kept ten minutes, so a repository on GitLab costs one `gh auth status` that often at most, and
 * a local path costs nothing. One per process, shared by the status reader, the Pull request surface and the Git actions.
 */
export class GitHubHosts {
  private signedIn: { readonly at: number; readonly hosts: Promise<ReadonlySet<string>> } | null = null
  private readonly aliases = new Map<string, { readonly at: number; readonly hostname: Promise<string | null> }>()
  private readonly now: () => number
  constructor(private readonly options: { readonly run: RunGitCommand; readonly sshHostName?: (alias: string) => Promise<string | null>; readonly now?: () => number }) {
    this.now = options.now ?? (() => Date.now())
  }

  /** The GitHub repository a remote URL names, as gh would read it; null for a remote gh would not ask about. */
  async repository(url: string): Promise<GitHubRepository | null> {
    const remote = parseRemoteUrl(url)
    if (!remote) return null
    const host = remote.ssh && !isGitHubDotCom(remote.host) ? await this.sshHostName(remote.host) ?? remote.host : remote.host
    const named = gitHubApiHost(host, remote.ssh)
    if (named) return { host: named, owner: remote.owner, name: remote.name }
    return (await this.signedInHosts()).has(host) ? { host, owner: remote.owner, name: remote.name } : null
  }

  private sshHostName(alias: string): Promise<string | null> {
    const kept = this.aliases.get(alias)
    if (kept && this.now() - kept.at < HOSTS_FRESH_MS) return kept.hostname
    const hostname = (this.options.sshHostName ?? readSshHostName)(alias).catch(() => null)
    this.aliases.set(alias, { at: this.now(), hostname })
    return hostname
  }

  private signedInHosts(): Promise<ReadonlySet<string>> {
    if (this.signedIn && this.now() - this.signedIn.at < HOSTS_FRESH_MS) return this.signedIn.hosts
    const hosts = this.listSignedIn()
    this.signedIn = { at: this.now(), hosts }
    return hosts
  }

  /**
   * The hosts gh is signed in to. A gh with `auth status --json` lists them, filtered by gh to the names alone; an older
   * one words its status for a person, on either stream, and only the host each "Logged in to" line names is read. gh
   * missing, or signed in nowhere, is no hosts. Run from the home folder: the answer is the same in every folder, and
   * a folder being removed is never held by it.
   */
  private async listSignedIn(): Promise<ReadonlySet<string>> {
    const options = { timeoutMs: 15_000 }
    try {
      const listed = await this.options.run(homedir(), 'gh', ['auth', 'status', '--json', 'hosts', '--jq', '.hosts | keys[]'], options)
      return new Set(listed.split(/\r?\n/u).map(line => line.trim().toLowerCase()).filter(Boolean))
    } catch { /* An older gh, or none: its words are read below. */ }
    const text = await this.options.run(homedir(), 'gh', ['auth', 'status'], options).catch((error: unknown) =>
      error instanceof Error ? `${String((error as { stdout?: unknown }).stdout ?? '')}\n${error.message}` : '')
    return new Set([...text.matchAll(/Logged in to (\S+)/gu)].map(match => match[1]!.toLowerCase()))
  }
}

/** A remote of the folder: the GitHub repository it names, if any, and gh's own mark of the one it reads pull requests from. */
export interface GitHubRemote { readonly repository: GitHubRepository | null; readonly ghResolved: string | null }
/** Each remote, by name, with the GitHub repository its URL as the user wrote it (before any `insteadOf`) names, as gh would read it. */
export async function readGitHubRemotes(run: RunGitCommand, cwd: string, hosts: GitHubHosts): Promise<Map<string, GitHubRemote>> {
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
  const resolved = new Map<string, GitHubRemote>()
  for (const [name, remote] of remotes) resolved.set(name, { repository: remote.url ? await hosts.repository(remote.url) : null, ghResolved: remote.ghResolved })
  return resolved
}
/**
 * The repository gh reads pull requests from in this folder, picked the way gh picks it without a prompt (T3's
 * `selectGitHubBaseRepository`): gh orders the remotes `upstream`, `github`, `origin` (in any case), then the rest as
 * they are configured. The first remote `gh repo set-default` marked wins: `base` names that remote's own repository,
 * and `owner/name` another repository on the remote's host. With no mark, the first remote in that order. A fork whose
 * parent is `upstream` therefore reads the parent's pull requests, as `gh pr list` there does. Only remotes on GitHub count.
 */
export function baseRepository(remotes: ReadonlyMap<string, GitHubRemote>): GitHubRepository | null {
  const rank = (name: string): number => { const index = ['upstream', 'github', 'origin'].indexOf(name.toLowerCase()); return index === -1 ? 3 : index }
  const ordered = [...remotes].flatMap(([name, remote]) => remote.repository ? [{ name, repository: remote.repository, mark: remote.ghResolved?.trim() || null }] : [])
    .sort((a, b) => rank(a.name) - rank(b.name))
  const marked = ordered.find(remote => remote.mark !== null)
  if (marked?.mark === 'base') return marked.repository
  if (marked?.mark) {
    // gh writes `owner/name`, and reads `host/owner/name` too; either way the remote's own host is the one it asks.
    const parts = marked.mark.split('/')
    if ((parts.length === 2 || parts.length === 3) && parts.every(Boolean)) return { host: marked.repository.host, owner: parts.at(-2)!, name: parts.at(-1)! }
  }
  return ordered[0]?.repository ?? null
}

/** Asked by the timer or the window on its own, which may wait, or by the user (Refresh, a Git action, the Pull request surface), who should not. */
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
