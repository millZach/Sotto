import { z } from 'zod'
import {
  GITHUB_PULL_REQUEST_URL, parsePullRequestReference,
  type GitPullRequestAction, type GitPullRequestCheck, type GitPullRequestDetail, type GitPullRequestMergeMethod, type GitPullRequestReview,
} from '../../shared/gitPullRequests'
import { baseRepository, GitHubHosts, GitHubRateLimit, isRateLimitAnswer, RATE_LIMIT_SELECTION, rateLimitSchema, readGitHubRemotes, refusalReading, repositoryKey, retryWords, type GitHubRepository } from './github'
import { runGitStatusCommand, type RunGitCommand } from './gitStatus'

/** Said in T3's words: the thing that did not happen, then GitHub's or Git's own reason. */
export class GitPullRequestRefusal extends Error {}
/**
 * A read GitHub's rate limit held back (#820): GitHub refused it, or reported no points left on the sign-in's rate limit.
 * The message says so in plain words for a press; the Pull request surface says it with `retryAt` in its own clock.
 */
export class GitPullRequestLimited extends GitPullRequestRefusal {
  constructor(readonly retryAt: number, now: number) {
    super(`GitHub is limiting requests from your gh sign-in, so Sotto could not read the pull request. Nothing was lost. Try again ${retryWords(retryAt, now)}.`)
  }
}

/** A pull request as GitHub describes it, before the host says how it stands to the thread. */
export type GitPullRequestView = Omit<GitPullRequestDetail, 'linked' | 'branch'>

/** The repository's merge settings are read with a pull request at most this often (#820); they change rarely. */
const MERGE_SETTINGS_FRESH_MS = 15 * 60_000
/** A read made just after a press stands for the surface's own read that follows it, so a press costs one read, not two. */
const PRIMED_FRESH_MS = 15_000
const MERGE_SETTINGS = 'mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed'
/**
 * Everything the Pull request surface shows, in one GraphQL read (#820): the pull request, its checks and reviews that
 * took a side, how far its head is behind its base, the repository's merge methods when they are not kept already, and
 * GitHub's reading of the rate limit. `mergeStateStatus` says BEHIND only where the repository requires up-to-date
 * branches, so the commits are counted instead, the same number GitHub's own out-of-date banner shows; the head is
 * named by GitHub's own `refs/pull/<number>/head`, which the base repository has for a fork's pull request too.
 */
export function pullRequestQuery(withMergeSettings: boolean): string {
  return `query PullRequestDetail($owner: String!, $name: String!, $number: Int!, $pullRef: String!) {
  ${RATE_LIMIT_SELECTION}
  viewer { login }
  repository(owner: $owner, name: $name) {${withMergeSettings ? `\n    ${MERGE_SETTINGS}` : ''}
    pullRequest(number: $number) {
      number title url body state isDraft mergeable reviewDecision baseRefName headRefName isCrossRepository mergedAt
      headRepositoryOwner { login } autoMergeRequest { mergeMethod } viewerCanUpdateBranch
      baseRef { compare(headRef: $pullRef) { behindBy } }
      latestOpinionatedReviews(last: 50) { nodes { state url author { login } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl description }
      } } } } } }
    }
  }
}`
}

const loose = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional()
const rawContextSchema = z.object({
  __typename: loose(z.string()), name: loose(z.string()), context: loose(z.string()), status: loose(z.string()), conclusion: loose(z.string()), state: loose(z.string()),
  detailsUrl: loose(z.string()), targetUrl: loose(z.string()), description: loose(z.string()),
  checkSuite: loose(z.object({ workflowRun: loose(z.object({ workflow: loose(z.object({ name: loose(z.string()) })) })) })),
})
const rawPullRequestSchema = z.object({
  number: z.number().int().positive(), title: z.string(), url: z.string(), body: loose(z.string()),
  state: z.string(), isDraft: loose(z.boolean()), mergeable: loose(z.string()), reviewDecision: loose(z.string()),
  baseRefName: loose(z.string()), headRefName: loose(z.string()), isCrossRepository: loose(z.boolean()), mergedAt: loose(z.string()),
  headRepositoryOwner: loose(z.object({ login: loose(z.string()) })), autoMergeRequest: loose(z.object({ mergeMethod: loose(z.string()) })),
  viewerCanUpdateBranch: loose(z.boolean()), baseRef: loose(z.object({ compare: loose(z.object({ behindBy: z.number().int().nonnegative() })) })),
  latestOpinionatedReviews: loose(z.object({ nodes: loose(z.array(loose(z.object({ state: loose(z.string()), url: loose(z.string()), author: loose(z.object({ login: loose(z.string()) })) })))) })),
  commits: loose(z.object({ nodes: loose(z.array(loose(z.object({ commit: loose(z.object({ statusCheckRollup: loose(z.object({ contexts: loose(z.object({ nodes: loose(z.array(loose(rawContextSchema))) })) })) })) })))) })),
})
const rawAnswerSchema = z.object({ data: z.object({
  rateLimit: rateLimitSchema, viewer: loose(z.object({ login: loose(z.string()) })),
  repository: z.object({
    mergeCommitAllowed: loose(z.boolean()), squashMergeAllowed: loose(z.boolean()), rebaseMergeAllowed: loose(z.boolean()), autoMergeAllowed: loose(z.boolean()),
    pullRequest: loose(rawPullRequestSchema),
  }).nullable(),
}) })
/** A check in the shape `gh pr view --json statusCheckRollup` gave it, which `checkOf` reads. */
type RawCheck = Omit<z.infer<typeof rawContextSchema>, 'checkSuite'> & { readonly workflowName?: string | null | undefined }
interface MergeSettings { readonly at: number; readonly mergeMethods: GitPullRequestMergeMethod[]; readonly autoMergeAllowed: boolean }

/** What each press did, said the way T3 says it once it has happened. */
export const PULL_REQUEST_ACTION_DONE: Record<GitPullRequestAction, string> = {
  merge: 'Pull request merged', ready: 'Marked ready for review', draft: 'Converted to draft', close: 'Pull request closed',
  reopen: 'Pull request reopened', 'update-branch': 'Branch updated with the base branch',
  'enable-auto-merge': 'Auto-merge turned on. It merges as soon as GitHub considers it ready, which may be now', 'disable-auto-merge': 'Auto-merge turned off',
}
/** Said as the thing that did not happen, rather than as the command that returned an error (T3's wording). */
const ACTION_FAILED: Record<GitPullRequestAction, string> = {
  merge: 'Could not merge this pull request.', ready: 'Could not mark this ready for review.', draft: 'Could not convert this to a draft.',
  close: 'Could not close this pull request.', reopen: 'Could not reopen this pull request.', 'update-branch': 'Could not update this branch.',
  'enable-auto-merge': 'Could not turn on auto-merge.', 'disable-auto-merge': 'Could not turn off auto-merge.',
}
/** What to try, for the times GitHub says only that it refused (T3's hints). */
const ACTION_HINT: Record<GitPullRequestAction, string> = {
  merge: 'GitHub refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.',
  ready: 'GitHub refused it. Check that you have write access to this repository.',
  draft: 'GitHub refused it. Check that you have write access to this repository.',
  close: 'GitHub refused it. Check that you have write access, or that you opened it.',
  reopen: 'GitHub refused it. Check that you have write access, and that the branch still exists.',
  'update-branch': 'GitHub refused it. Check that you have write access to the branch, and that it does not conflict with the base.',
  'enable-auto-merge': 'GitHub refused it. Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.',
  'disable-auto-merge': 'GitHub refused it. Check that you have write access, and that the merge has not already happened.',
}
const UPDATE_WITH_REBASE_HINT = 'GitHub refused it. A rebase stops at the first commit that does not apply cleanly; Update branch, with a merge commit, may still work.'

const VIEW_TIMEOUT_MS = 30_000
const ACTION_TIMEOUT_MS = 120_000
const FETCH_TIMEOUT_MS = 120_000
const BODY_MAX = 65_536

/** The GitHub CLI's own words for why it stopped, without a token-bearing remote and without its usage text. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : ''
  return text.replace(/((?:https?|ssh):\/\/)[^\s/@]+@/giu, '$1').split('\n').map(line => line.trim()).filter(Boolean).slice(-2).join(' ').slice(0, 600)
}
const cut = (text: string, max: number): string => text.length > max ? text.slice(0, max) : text
/** What gh printed before it failed, when that is GitHub's answer with the pull request in it. */
function partialAnswer(error: unknown): z.infer<typeof rawAnswerSchema> | null {
  const stdout = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
  if (!stdout.trim()) return null
  try {
    const parsed = rawAnswerSchema.safeParse(JSON.parse(stdout))
    return parsed.success && parsed.data.data.repository?.pullRequest ? parsed.data : null
  } catch { return null }
}

/** A check as GraphQL names it, in the shape `gh pr view --json statusCheckRollup` gave it. */
function rawCheckOf(node: z.infer<typeof rawContextSchema>): RawCheck {
  return { __typename: node.__typename, name: node.name, context: node.context, status: node.status, conclusion: node.conclusion, state: node.state,
    detailsUrl: node.detailsUrl, targetUrl: node.targetUrl, description: node.description, workflowName: node.checkSuite?.workflowRun?.workflow?.name }
}
function checkOf(raw: RawCheck): GitPullRequestCheck {
  const upper = (value: string | null | undefined) => value?.trim().toUpperCase() ?? ''
  const isStatus = raw.__typename === 'StatusContext' || (raw.context != null && raw.name == null)
  let status: GitPullRequestCheck['status']
  if (isStatus) {
    const state = upper(raw.state)
    status = state === 'SUCCESS' ? 'success' : state === 'FAILURE' || state === 'ERROR' ? 'failure' : 'pending'
  } else if (upper(raw.status) !== 'COMPLETED' && raw.status != null) status = upper(raw.status) === 'WAITING' ? 'action-required' : 'pending'
  else {
    const conclusion = upper(raw.conclusion)
    status = conclusion === 'SUCCESS' ? 'success' : conclusion === 'CANCELLED' ? 'cancelled' : conclusion === 'SKIPPED' ? 'skipped'
      : conclusion === 'NEUTRAL' || conclusion === 'STALE' ? 'neutral' : conclusion === 'ACTION_REQUIRED' ? 'action-required'
        : conclusion === '' ? 'pending' : 'failure'
  }
  const own = (isStatus ? raw.context : raw.name)?.trim() || 'Check'
  const name = !isStatus && raw.workflowName?.trim() && raw.workflowName.trim() !== own ? `${raw.workflowName.trim()} / ${own}` : own
  const url = (isStatus ? raw.targetUrl : raw.detailsUrl) ?? null
  return { name: cut(name, 500), status, url: url && /^https:\/\//iu.test(url) ? cut(url, 2_048) : null, description: raw.description ? cut(raw.description, 2_000) : null }
}
/** The reviews that took a side, with a GitHub link only; a reviewer GitHub no longer names (a deleted account) is left out. */
function reviewsOf(nodes: ReadonlyArray<{ state?: string | null | undefined; url?: string | null | undefined; author?: { login?: string | null | undefined } | null | undefined } | null | undefined>): GitPullRequestReview[] {
  return nodes.flatMap((node): GitPullRequestReview[] => {
    const state = node?.state?.toUpperCase(), author = node?.author?.login?.trim()
    if (!author || (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED')) return []
    const url = node?.url && /^https:\/\/github\.com\//iu.test(node.url) ? cut(node.url, 2_048) : null
    return [{ author: cut(author, 100), state: state === 'APPROVED' ? 'approved' : 'changes_requested', url }]
  }).slice(-50)
}
const methodOf = (value: string | null | undefined): GitPullRequestMergeMethod | null => {
  const upper = value?.trim().toUpperCase()
  return upper === 'MERGE' ? 'merge' : upper === 'SQUASH' ? 'squash' : upper === 'REBASE' ? 'rebase' : null
}

/** Where a GitHub pull request URL points: its owner, repository and number. */
export function pullRequestAddress(url: string): { readonly owner: string; readonly name: string; readonly number: number } | null {
  const match = GITHUB_PULL_REQUEST_URL.exec(url.trim())
  return match ? { owner: match[1]!, name: match[2]!, number: Number(match[3]) } : null
}
/** The one spelling two URLs of the same pull request share, whatever their case or trailing path. */
export function pullRequestKey(url: string): string | null {
  const address = pullRequestAddress(url)
  return address ? `${address.owner}/${address.name}#${address.number}`.toLowerCase() : null
}

/** `owner/name` of a GitHub remote URL (HTTPS, `git@github.com:` or `ssh://`), lowercased; null for any other remote. */
export function githubRepositoryOf(remote: string): string | null {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(remote.trim())
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

/** T3's fragment for a branch name taken from another repository's head: lowercase, anything odd a dash. */
function branchFragment(head: string): string {
  return head.toLowerCase().replace(/[^a-z0-9/_-]+/gu, '-').replace(/-{2,}/gu, '-').replace(/^[-/]+|[-/]+$/gu, '').slice(0, 48).replace(/[-/]+$/u, '') || 'head'
}

/**
 * The pull request side of T3's Git model (ADR-0027), on the host: read one pull request with its checks,
 * review decision, mergeability, merge methods and distance from its base; act on it with the presses the
 * Pull request surface offers; and check one out, into the thread's folder or onto a branch a new worktree
 * will take. Everything goes through `gh` on the user's own sign-in, or through Git for the checkout. It never
 * forces a branch, and a press whose reply was lost is settled by reading the pull request again rather than
 * pressing twice. A read is one GraphQL query that spends the sign-in's points (#820): it may use the reserve the
 * timer keeps back and goes through a pause, and is refused only when GitHub refuses it or last reported nothing left.
 */
export class GitPullRequests {
  private readonly run: RunGitCommand
  private readonly rateLimit: GitHubRateLimit
  private readonly now: () => number
  /** Each repository's merge methods, kept fifteen minutes, by `repositoryKey`. */
  private readonly mergeSettings = new Map<string, MergeSettings>()
  /** The read a press made, by `pullRequestKey`, waiting to stand for the surface's read that follows it. */
  private readonly primed = new Map<string, { readonly at: number; readonly view: GitPullRequestView }>()
  private readonly hosts: GitHubHosts
  constructor(dependencies: { readonly run?: RunGitCommand; readonly rateLimit?: GitHubRateLimit; readonly hosts?: GitHubHosts; readonly now?: () => number } = {}) {
    this.run = dependencies.run ?? runGitStatusCommand
    this.now = dependencies.now ?? (() => Date.now())
    this.rateLimit = dependencies.rateLimit ?? new GitHubRateLimit({ now: this.now })
    this.hosts = dependencies.hosts ?? new GitHubHosts({ run: this.run, now: this.now })
  }
  private gh(cwd: string, args: readonly string[], timeoutMs = VIEW_TIMEOUT_MS): Promise<string> { return this.run(cwd, 'gh', args, { timeoutMs }) }
  private git(cwd: string, args: readonly string[], timeoutMs = 30_000): Promise<string> { return this.run(cwd, 'git', args, { timeoutMs }) }

  /**
   * One pull request, by URL or number, with what the Pull request surface shows. The read a press just made stands for
   * this one once, so the surface's read after a press asks GitHub nothing.
   */
  async view(cwd: string, reference: string): Promise<GitPullRequestView> {
    const key = pullRequestKey(reference)
    const primed = key ? this.primed.get(key) : undefined
    if (key && primed) {
      this.primed.delete(key)
      if (this.now() - primed.at < PRIMED_FRESH_MS) return primed.view
    }
    return this.read(cwd, reference)
  }

  private async read(cwd: string, reference: string): Promise<GitPullRequestView> {
    const selector = parsePullRequestReference(reference)
    if (!selector) throw new GitPullRequestRefusal('Use a pull request URL, 123, or #123.')
    const address = await this.addressOf(cwd, selector)
    const repository: GitHubRepository = { host: address.host, owner: address.owner, name: address.name }
    const retryAt = this.rateLimit.retryAt(repository.host, 'user')
    if (retryAt !== null) throw new GitPullRequestLimited(retryAt, this.now())
    const settingsKey = repositoryKey(repository)
    const kept = this.mergeSettings.get(settingsKey)
    const settings = kept && this.now() - kept.at < MERGE_SETTINGS_FRESH_MS ? kept : undefined
    const args = ['api', 'graphql', ...repository.host === 'github.com' ? [] : ['--hostname', repository.host], '-f', `query=${pullRequestQuery(!settings)}`,
      '-f', `owner=${repository.owner}`, '-f', `name=${repository.name}`, '-F', `number=${address.number}`, '-f', `pullRef=refs/pull/${address.number}/head`]
    let answer: z.infer<typeof rawAnswerSchema>
    const asked = this.rateLimit.asking()
    try { answer = rawAnswerSchema.parse(JSON.parse(await this.gh(cwd, args))) }
    catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new GitPullRequestRefusal('GitHub answered in a form Sotto could not read. Refresh to try again.')
      const message = error instanceof Error ? error.message : ''
      if (isRateLimitAnswer(message)) throw new GitPullRequestLimited(this.rateLimit.limited(repository.host, message, refusalReading(error)), this.now())
      // GitHub can answer the pull request and refuse a part of it (a comparison it cannot make, reviews a token may not
      // read); gh then fails with what it did read on its output, and the rest is shown as unknown.
      const partial = partialAnswer(error)
      if (!partial) throw new GitPullRequestRefusal(`Could not read the pull request. ${reasonOf(error) || 'Check gh authentication and network access.'}`.trim())
      answer = partial
    }
    this.rateLimit.answered(repository.host, asked, answer.data.rateLimit, answer.data.viewer?.login ?? null)
    const raw = answer.data.repository?.pullRequest
    if (!answer.data.repository || !raw) throw new GitPullRequestRefusal(`Could not read the pull request. GitHub has no pull request #${address.number} in ${repository.owner}/${repository.name} that your gh sign-in can see.`)
    const methods = settings ?? this.keepMergeSettings(settingsKey, answer.data.repository)
    if (!pullRequestAddress(raw.url)) throw new GitPullRequestRefusal('Sotto shows pull requests from GitHub only.')
    const state = raw.mergedAt || raw.state.toUpperCase() === 'MERGED' ? 'merged' : raw.state.toUpperCase() === 'CLOSED' ? 'closed' : 'open'
    const review = raw.reviewDecision?.toUpperCase()
    const mergeable = raw.mergeable?.toUpperCase()
    const contexts = raw.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.contexts?.nodes ?? []
    return {
      number: raw.number, url: raw.url, title: cut(raw.title, 500), body: cut(raw.body ?? '', BODY_MAX), state, draft: raw.isDraft === true,
      baseBranch: raw.baseRefName ?? '', headBranch: raw.headRefName ?? '', crossRepository: raw.isCrossRepository === true,
      reviewDecision: review === 'APPROVED' ? 'approved' : review === 'CHANGES_REQUESTED' ? 'changes_requested' : review === 'REVIEW_REQUIRED' ? 'review_required' : null,
      mergeable: mergeable === 'MERGEABLE' ? 'mergeable' : mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
      checks: contexts.flatMap(node => node ? [checkOf(rawCheckOf(node))] : []).slice(0, 200),
      reviews: reviewsOf(raw.latestOpinionatedReviews?.nodes ?? []),
      mergeMethods: methods.mergeMethods, autoMergeAllowed: methods.autoMergeAllowed,
      autoMerge: raw.autoMergeRequest ? { method: methodOf(raw.autoMergeRequest.mergeMethod) } : null,
      mergedAt: raw.mergedAt ? cut(raw.mergedAt, 64) : null,
      behindBy: raw.baseRef?.compare?.behindBy ?? null, canUpdateBranch: raw.viewerCanUpdateBranch === true,
    }
  }

  /** Where a reference points: a URL names its repository; a number is the one gh reads pull requests from in this folder. */
  private async addressOf(cwd: string, selector: string): Promise<{ host: string; owner: string; name: string; number: number }> {
    const fromUrl = pullRequestAddress(selector)
    if (fromUrl) return { host: 'github.com', ...fromUrl }
    const repository = baseRepository(await readGitHubRemotes(this.run, cwd, this.hosts))
    if (!repository) throw new GitPullRequestRefusal('This project has no GitHub remote to read the pull request from. Use its full GitHub URL.')
    return { ...repository, number: Number(selector) }
  }

  /** The merge methods a repository allows, as GitHub just said; every method, and auto-merge, when it did not say. */
  private keepMergeSettings(key: string, repository: { mergeCommitAllowed?: boolean | null | undefined; squashMergeAllowed?: boolean | null | undefined; rebaseMergeAllowed?: boolean | null | undefined; autoMergeAllowed?: boolean | null | undefined }): MergeSettings {
    const mergeMethods: GitPullRequestMergeMethod[] = []
    if (repository.mergeCommitAllowed !== false) mergeMethods.push('merge')
    if (repository.squashMergeAllowed !== false) mergeMethods.push('squash')
    if (repository.rebaseMergeAllowed !== false) mergeMethods.push('rebase')
    const settings = { at: this.now(), mergeMethods, autoMergeAllowed: repository.autoMergeAllowed !== false }
    // Only an answer that named them is kept; one GitHub withheld is asked again with the next read.
    if (typeof repository.mergeCommitAllowed === 'boolean') this.mergeSettings.set(key, settings)
    return settings
  }

  /**
   * One press on the Pull request surface, as T3 runs it: `gh pr merge --squash`, `--auto`, `--disable-auto`,
   * `gh pr update-branch [--rebase]`, `gh pr ready [--undo]`, `gh pr close`, `gh pr reopen`. A reply that never
   * came back is settled by reading the pull request again: done when it shows the press happened, the refusal
   * otherwise. Nothing is pressed twice.
   */
  async act(cwd: string, url: string, action: GitPullRequestAction, method?: GitPullRequestMergeMethod): Promise<GitPullRequestView | null> {
    if (!pullRequestAddress(url)) throw new GitPullRequestRefusal('Sotto acts on pull requests from GitHub only.')
    if ((action === 'merge' || action === 'enable-auto-merge') && !method) throw new GitPullRequestRefusal('Choose a merge method first.')
    if (action === 'update-branch' && method === 'squash') throw new GitPullRequestRefusal('Update the branch with a merge commit or a rebase.')
    const args: string[] = ['pr']
    switch (action) {
      case 'merge': args.push('merge', url, `--${method}`); break
      // `--auto` arms the same command instead of running it, and still needs the strategy: GitHub keeps it with the instruction.
      case 'enable-auto-merge': args.push('merge', url, '--auto', `--${method}`); break
      case 'disable-auto-merge': args.push('merge', url, '--disable-auto'); break
      case 'update-branch': args.push('update-branch', url, ...(method === 'rebase' ? ['--rebase'] : [])); break
      case 'ready': args.push('ready', url); break
      case 'draft': args.push('ready', url, '--undo'); break
      case 'close': args.push('close', url); break
      case 'reopen': args.push('reopen', url); break
    }
    let failed = false, failure: unknown
    try { await this.gh(cwd, args, ACTION_TIMEOUT_MS) } catch (error) { failed = true; failure = error }
    const after = await this.read(cwd, url).catch(() => null)
    // The surface reads again once the press is over; this read answers it, so the press costs one read (#820).
    const key = pullRequestKey(url)
    if (after && key) this.primed.set(key, { at: this.now(), view: after })
    if (!failed) return after
    if (after && settled(action, after)) return after
    const hint = action === 'update-branch' && method === 'rebase' ? UPDATE_WITH_REBASE_HINT : ACTION_HINT[action]
    throw new GitPullRequestRefusal(`${ACTION_FAILED[action]} ${reasonOf(failure) || hint}`.trim())
  }

  /**
   * Both checkouts take the pull request from the project's `origin`, by its number, so a pull request of
   * another repository is refused rather than answered with this repository's pull request of the same number.
   * `origin` is read as configured, before any `insteadOf` rewrite, the way the user wrote it.
   */
  private async assertSameRepository(cwd: string, url: string): Promise<void> {
    const address = pullRequestAddress(url)
    const origin = (await this.git(cwd, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim()
    const repository = githubRepositoryOf(origin)
    if (!address) throw new GitPullRequestRefusal('Sotto checks out pull requests from GitHub only.')
    if (!origin) throw new GitPullRequestRefusal('This project has no origin remote to check the pull request out from.')
    if (!repository || repository !== `${address.owner}/${address.name}`.toLowerCase()) throw new GitPullRequestRefusal('This pull request is in another repository. Check it out from a clone of that repository.')
  }

  /** T3's Local: `gh pr checkout` in the thread's folder. Without `--force`, so Git refuses rather than lose a local branch's commits. */
  async checkoutLocal(cwd: string, url: string): Promise<void> {
    await this.assertSameRepository(cwd, url)
    const selector = parsePullRequestReference(url)
    if (!selector) throw new GitPullRequestRefusal('Use a pull request URL, 123, or #123.')
    try { await this.gh(cwd, ['pr', 'checkout', selector], FETCH_TIMEOUT_MS) }
    catch (error) { throw new GitPullRequestRefusal(`Could not check out the pull request. ${reasonOf(error)}`.trim()) }
  }

  /**
   * T3's Worktree, the half that happens now: the pull request's head as a local branch a new worktree will
   * check out on first send. A pull request from this repository gets its own head branch, tracking it; one
   * from a fork gets `sotto/pr-<number>/<head>` from GitHub's pull request ref. A branch that exists already
   * is used as it stands, a branch another worktree has is answered with that worktree, and a branch the
   * project's own checkout has is refused, since two folders cannot hold one branch.
   */
  async prepareWorktreeBranch(cwd: string, pullRequest: Pick<GitPullRequestView, 'number' | 'url' | 'headBranch' | 'crossRepository'>): Promise<{ branch: string; worktreePath: string | null }> {
    await this.assertSameRepository(cwd, pullRequest.url)
    const branch = pullRequest.crossRepository || !pullRequest.headBranch ? `sotto/pr-${pullRequest.number}/${branchFragment(pullRequest.headBranch)}` : pullRequest.headBranch
    await this.git(cwd, ['check-ref-format', '--branch', branch]).catch(() => { throw new GitPullRequestRefusal(`The pull request's branch name ${branch} is not one Git accepts.`) })
    const checkouts = await this.checkouts(cwd)
    const exists = await this.git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
    if (exists) {
      const holder = checkouts.find(entry => entry.branch === branch)
      if (holder?.main) throw new GitPullRequestRefusal('This pull request\'s branch is already checked out in the project folder. Use Local, or switch the project folder off that branch before choosing Worktree.')
      return { branch, worktreePath: holder?.path ?? null }
    }
    const fetchPullRef = () => this.git(cwd, ['fetch', '--no-tags', 'origin', `refs/pull/${pullRequest.number}/head:refs/heads/${branch}`], FETCH_TIMEOUT_MS)
    try {
      if (pullRequest.crossRepository || !pullRequest.headBranch) await fetchPullRef()
      else {
        try {
          await this.git(cwd, ['fetch', '--no-tags', 'origin', `+refs/heads/${pullRequest.headBranch}:refs/remotes/origin/${pullRequest.headBranch}`], FETCH_TIMEOUT_MS)
          await this.git(cwd, ['branch', '--track', branch, `refs/remotes/origin/${pullRequest.headBranch}`])
        } catch { await fetchPullRef() } // A head branch that is gone from origin still has GitHub's pull request ref.
      }
    } catch (error) { throw new GitPullRequestRefusal(`Could not fetch the pull request's branch. ${reasonOf(error)}`.trim()) }
    return { branch, worktreePath: null }
  }

  private async checkouts(cwd: string): Promise<Array<{ path: string; branch: string | null; main: boolean }>> {
    const listing = await this.git(cwd, ['worktree', 'list', '--porcelain', '-z']).catch(() => '')
    return listing.split('\0\0').filter(Boolean).map((record, index) => {
      const fields = record.split('\0')
      return { path: fields.find(field => field.startsWith('worktree '))?.slice(9) ?? '', branch: fields.find(field => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null, main: index === 0 }
    }).filter(entry => entry.path)
  }
}

/** Whether a pull request read after a lost reply shows that the press happened. */
function settled(action: GitPullRequestAction, after: GitPullRequestView): boolean {
  switch (action) {
    case 'merge': return after.state === 'merged'
    case 'close': return after.state === 'closed'
    case 'reopen': return after.state === 'open'
    case 'ready': return !after.draft
    case 'draft': return after.draft
    case 'enable-auto-merge': return after.autoMerge !== null || after.state === 'merged'
    case 'disable-auto-merge': return after.autoMerge === null
    case 'update-branch': return after.behindBy === 0
  }
}
