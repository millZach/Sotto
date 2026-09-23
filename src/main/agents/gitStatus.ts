import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { GitPullRequestSummary, GitStatus } from '../../shared/gitStatus'

export interface GitCommandOptions {
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  /** Each line the command prints as it prints it, for a commit whose hooks are worth watching. */
  readonly onLine?: (text: string, stream: 'stdout' | 'stderr') => void
}
const OUTPUT_MAX_BYTES = 8_000_000
/** Runs `git` or `gh` in a folder and resolves with stdout; rejects with stderr as the message. */
export type RunGitCommand = (cwd: string, command: 'git' | 'gh', args: readonly string[], options?: GitCommandOptions) => Promise<string>

/**
 * Prompts are never answered by a background read: Git and gh are told there is no terminal, no
 * askpass and no credential manager to ask, so a remote that needs a sign-in fails quietly and status
 * reads on from the last fetched refs.
 */
const QUIET_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1' }

const REDIRECTING_GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_EXTERNAL_DIFF', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER'] as const
/** Thrown when Git itself is missing: no status is published then, rather than a folder called "not a repository". */
export class GitUnavailableError extends Error {}

export const runGitStatusCommand: RunGitCommand = (cwd, command, args, options = {}) => new Promise((accept, reject) => {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GCM_INTERACTIVE: 'never', ...options.env }
  // Variables that would point Git at another repository or index are dropped; the ones that carry the
  // user's own transport and configuration (GIT_SSH_COMMAND, GIT_CONFIG_GLOBAL, proxies) stay, so a fetch
  // reaches the remote the way the user's own Git does.
  for (const key of REDIRECTING_GIT_VARIABLES) delete env[key]
  const child = spawn(command, command === 'git' ? ['--no-optional-locks', '-c', 'core.quotePath=false', ...args] : [...args], { cwd, windowsHide: true, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false, settled = false
  const partial = { stdout: '', stderr: '' }
  const feed = (stream: 'stdout' | 'stderr', chunk: string): void => {
    if (stream === 'stdout') { if (stdout.length < OUTPUT_MAX_BYTES) stdout += chunk } else if (stderr.length < OUTPUT_MAX_BYTES) stderr += chunk
    if (!options.onLine) return
    partial[stream] += chunk
    const lines = partial[stream].split(/\r?\n/u)
    partial[stream] = lines.pop() ?? ''
    for (const line of lines) options.onLine(line, stream)
  }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => feed('stdout', chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => feed('stderr', chunk))
  const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeoutMs ?? 30_000)
  const finish = (error: Error | null): void => {
    if (settled) return
    settled = true; clearTimeout(timer)
    if (error) reject(error); else accept(stdout)
  }
  child.on('error', error => finish((error as NodeJS.ErrnoException).code === 'ENOENT' ? new GitUnavailableError(`${command} is not installed or is not on PATH.`) : error))
  child.on('close', code => {
    if (options.onLine) for (const stream of ['stdout', 'stderr'] as const) if (partial[stream]) options.onLine(partial[stream], stream)
    if (timedOut) finish(Object.assign(new Error(`${command} did not finish in time.`), { code: 'ETIMEDOUT' }))
    else if (code !== 0) finish(Object.assign(new Error(stderr.trim() || `${command} exited with ${code ?? 'a signal'}.`), { code }))
    else finish(null)
  })
})

export interface GitStatusReaderOptions {
  readonly run?: RunGitCommand
  readonly now?: () => number
  /** Milliseconds between background fetches of a working copy's remote. Zero or less turns the fetch off. */
  readonly fetchIntervalMs: () => number
}

/** What the workspace asks of a status source; the reader is the production one and tests hand in a stub. */
export interface GitStatusSource {
  read(cwd: string, options: { readonly remote: boolean }): Promise<GitStatus>
  /** A Git action ran: the next remote read fetches again and asks GitHub again instead of trusting its caches. */
  invalidate(): void
}

const FETCH_TIMEOUT_MS = 5_000
/** A fetch that succeeded is not repeated for this long, however often status is asked for (T3's figure); the timer itself runs at the fetch interval. */
const FETCH_FRESH_MS = 15_000
const FETCH_BACKOFF_MS = 30_000
/** A pull request answer is kept this long before GitHub is asked again. */
const PULL_REQUEST_FRESH_MS = 60_000
const PULL_REQUEST_BACKOFF_MS = 20_000
const BACKOFF_CAP_MS = 15 * 60_000
const DEFAULT_BRANCH_FRESH_MS = 5 * 60_000
const backoff = (base: number, failures: number): number => Math.min(base * 2 ** Math.max(0, failures - 1), BACKOFF_CAP_MS)

const rawPullRequestSchema = z.array(z.object({
  number: z.number().int().positive(), title: z.string(), url: z.string(), state: z.string(), isDraft: z.boolean(),
  headRefName: z.string(), updatedAt: z.string().optional(),
}))

interface FetchRecord { failures: number; nextAt: number; fetchedAt: number | null; inFlight?: Promise<void> }
interface PullRequestRecord { epoch: number; failures: number; nextAt: number; value: GitPullRequestSummary | null }

const EMPTY: Omit<GitStatus, 'readAt'> = { isRepository: false, branch: null, upstream: null, hasRemote: false, defaultBranch: null, isDefaultBranch: false, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null }

/**
 * Reads a working copy's Git status the way T3 Code does. The local half (`status --porcelain=2
 * --branch`, `diff --numstat`, the default branch) runs on every read. The remote half runs only when
 * asked: a `git fetch` of `origin` when the last one is older than the fetch interval allows, then the
 * branch's pull request through `gh`, each cached and backed off on failure so a remote that is down or
 * wants a sign-in costs one quiet attempt per window rather than one per read.
 */
export class GitStatusReader implements GitStatusSource {
  private readonly run: RunGitCommand
  private readonly now: () => number
  private readonly fetches = new Map<string, FetchRecord>()
  private readonly pullRequests = new Map<string, PullRequestRecord>()
  private readonly defaults = new Map<string, { at: number; value: string | null }>()
  private readonly reads = new Map<string, Promise<GitStatus>>()
  private epoch = 0
  constructor(private readonly options: GitStatusReaderOptions) {
    this.run = options.run ?? runGitStatusCommand
    this.now = options.now ?? (() => Date.now())
  }
  private git(cwd: string, args: readonly string[], options?: GitCommandOptions): Promise<string> { return this.run(cwd, 'git', args, options) }

  invalidate(): void {
    this.epoch++
    for (const record of this.fetches.values()) record.nextAt = 0
    this.defaults.clear()
  }

  /** One read per folder at a time: two threads sharing a checkout share the answer. */
  read(cwd: string, options: { readonly remote: boolean }): Promise<GitStatus> {
    const key = `${cwd}\0${options.remote}`
    const pending = this.reads.get(key)
    if (pending) return pending
    const task = this.readNow(cwd, options).finally(() => { if (this.reads.get(key) === task) this.reads.delete(key) })
    this.reads.set(key, task)
    return task
  }

  private async readNow(cwd: string, options: { readonly remote: boolean }): Promise<GitStatus> {
    const readAt = new Date(this.now()).toISOString()
    let common: string
    try { common = (await this.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() }
    catch (error) { if (error instanceof GitUnavailableError) throw error; return { ...EMPTY, readAt } }
    const remotes = (await this.git(cwd, ['remote']).catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean)
    const hasRemote = remotes.includes('origin')
    if (options.remote && hasRemote) await this.fetchIfStale(cwd, common)
    const fetchedAt = this.fetches.get(common)?.fetchedAt ?? null
    const porcelain = await this.git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'])
    const parsed = parsePorcelain(porcelain)
    const counts = await this.counts(cwd, parsed.unborn)
    const defaultBranch = await this.defaultBranch(cwd, common, hasRemote)
    const branch = parsed.branch
    const isDefaultBranch = branch !== null && branch === defaultBranch
    let aheadOfDefault: number | null = null
    if (branch && defaultBranch && !isDefaultBranch) aheadOfDefault = await this.aheadOf(cwd, defaultBranch, hasRemote)
    // With no upstream there is nothing to be behind; the distance from the default branch stands in for ahead (T3's rule).
    const ahead = parsed.upstream ? parsed.ahead : aheadOfDefault ?? 0
    const behind = parsed.upstream ? parsed.behind : 0
    const pullRequest = branch && hasRemote ? await this.pullRequest(cwd, common, branch, parsed.upstream, isDefaultBranch, options.remote) : null
    return {
      isRepository: true, branch, upstream: parsed.upstream, hasRemote, defaultBranch, isDefaultBranch,
      dirty: parsed.changedFiles > 0, changedFiles: parsed.changedFiles, insertions: counts.insertions, deletions: counts.deletions,
      ahead, behind, aheadOfDefault, pullRequest, fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(), readAt,
    }
  }

  private async counts(cwd: string, unborn: boolean): Promise<{ insertions: number; deletions: number }> {
    const outputs = unborn
      ? [await this.git(cwd, ['diff', '--numstat']).catch(() => ''), await this.git(cwd, ['diff', '--cached', '--numstat']).catch(() => '')]
      : [await this.git(cwd, ['diff', '--numstat', 'HEAD', '--']).catch(() => '')]
    let insertions = 0, deletions = 0
    for (const line of outputs.join('\n').split('\n')) {
      const [added, removed] = line.split('\t')
      insertions += Number.parseInt(added ?? '', 10) || 0
      deletions += Number.parseInt(removed ?? '', 10) || 0
    }
    return { insertions, deletions }
  }

  private async defaultBranch(cwd: string, common: string, hasRemote: boolean): Promise<string | null> {
    const cached = this.defaults.get(common)
    if (cached && this.now() - cached.at < DEFAULT_BRANCH_FRESH_MS) return cached.value
    let value: string | null = null
    if (hasRemote) {
      const head = (await this.git(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).catch(() => '')).trim()
      if (head.startsWith('origin/')) value = head.slice('origin/'.length)
    }
    if (!value) for (const candidate of ['main', 'master']) {
      if (await this.git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${candidate}`]).then(() => true, () => false)) { value = candidate; break }
    }
    this.defaults.set(common, { at: this.now(), value })
    return value
  }

  private async aheadOf(cwd: string, defaultBranch: string, hasRemote: boolean): Promise<number | null> {
    const candidates = [...(hasRemote ? [`refs/remotes/origin/${defaultBranch}`] : []), `refs/heads/${defaultBranch}`]
    for (const base of candidates) {
      if (!await this.git(cwd, ['rev-parse', '--verify', '-q', `${base}^{commit}`]).then(() => true, () => false)) continue
      const count = (await this.git(cwd, ['rev-list', '--count', `${base}..HEAD`]).catch(() => '')).trim()
      return /^\d+$/.test(count) ? Number(count) : null
    }
    return null
  }

  private fetchIfStale(cwd: string, common: string): Promise<void> {
    if (this.options.fetchIntervalMs() <= 0) return Promise.resolve()
    const record = this.fetches.get(common) ?? { failures: 0, nextAt: 0, fetchedAt: null }
    this.fetches.set(common, record)
    if (record.inFlight) return record.inFlight
    if (this.now() < record.nextAt) return Promise.resolve()
    record.inFlight = this.git(cwd, ['fetch', '--quiet', '--no-tags', 'origin'], { timeoutMs: FETCH_TIMEOUT_MS, env: QUIET_ENV })
      .then(() => { record.failures = 0; record.fetchedAt = this.now(); record.nextAt = this.now() + FETCH_FRESH_MS },
        () => { record.failures++; record.nextAt = this.now() + backoff(FETCH_BACKOFF_MS, record.failures) })
      .finally(() => { delete record.inFlight })
    return record.inFlight
  }

  private async pullRequest(cwd: string, common: string, branch: string, upstream: string | null, isDefaultBranch: boolean, refresh: boolean): Promise<GitPullRequestSummary | null> {
    const key = `${common}\0${branch}`
    const record = this.pullRequests.get(key)
    const stale = !record || record.epoch !== this.epoch || this.now() >= record.nextAt
    if (!refresh || !stale) return record?.value ?? null
    // A branch nobody has pushed has no pull request, and GitHub is not asked about it. That is checked on
    // every remote read, so a push made in a terminal is seen as soon as the fetch has brought its ref.
    if (!upstream) {
      const published = (await this.git(cwd, ['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/*/${branch}`]).catch(() => '')).trim()
      if (!published) return null
    }
    try {
      const raw = await this.run(cwd, 'gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '20', '--json', 'number,title,url,state,isDraft,headRefName,updatedAt'], { env: QUIET_ENV })
      const candidates = rawPullRequestSchema.parse(JSON.parse(raw)).filter(item => item.headRefName === branch)
        .map(item => ({ ...item, state: item.state.toLowerCase() })).filter((item): item is typeof item & { state: 'open' | 'closed' | 'merged' } => ['open', 'closed', 'merged'].includes(item.state))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      const chosen = candidates.find(item => item.state === 'open') ?? (isDefaultBranch ? undefined : candidates[0])
      const value = chosen ? { number: chosen.number, title: chosen.title, url: chosen.url, state: chosen.state, draft: chosen.isDraft } : null
      this.pullRequests.set(key, { epoch: this.epoch, failures: 0, nextAt: this.now() + PULL_REQUEST_FRESH_MS, value })
      return value
    } catch {
      const failures = (record?.failures ?? 0) + 1
      // The last answer stands while GitHub cannot be asked; a failure is retried later, not on the next read.
      this.pullRequests.set(key, { epoch: this.epoch, failures, nextAt: this.now() + backoff(PULL_REQUEST_BACKOFF_MS, failures), value: record?.value ?? null })
      return record?.value ?? null
    }
  }
}

interface Porcelain { branch: string | null; upstream: string | null; ahead: number; behind: number; changedFiles: number; unborn: boolean }
/** `status --porcelain=v2 --branch -z`: headers first, then one NUL-terminated record per changed path (two for a rename). */
export function parsePorcelain(output: string): Porcelain {
  const result: Porcelain = { branch: null, upstream: null, ahead: 0, behind: 0, changedFiles: 0, unborn: false }
  const records = output.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    if (!record) continue
    if (record.startsWith('# ')) {
      const [name, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      if (name === 'branch.oid') result.unborn = value === '(initial)'
      else if (name === 'branch.head') result.branch = value === '(detached)' || value === '' ? null : value
      else if (name === 'branch.upstream') result.upstream = value || null
      else if (name === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]) }
      }
      continue
    }
    const kind = record[0]
    if (kind === '1' || kind === 'u' || kind === '?') result.changedFiles++
    else if (kind === '2') { result.changedFiles++; index++ } // the original path follows as its own record
  }
  return result
}
