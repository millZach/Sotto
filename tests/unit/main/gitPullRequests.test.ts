// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubRateLimit } from '../../../src/main/agents/github'
import { githubRepositoryOf, GitPullRequestLimited, GitPullRequestRefusal, GitPullRequests, pullRequestKey } from '../../../src/main/agents/gitPullRequests'
import { runGitStatusCommand, type RunGitCommand } from '../../../src/main/agents/gitStatus'
import { parsePullRequestReference, type GitPullRequestAction } from '../../../src/shared/gitPullRequests'

const URL_74 = 'https://github.com/sotto-fixture/owned/pull/74'
interface Change {
  /** The pull request's own fields, in GitHub's spelling. */
  readonly pull?: Record<string, unknown>
  readonly behindBy?: number | null; readonly squash?: boolean; readonly canUpdate?: boolean; readonly autoMerge?: boolean; readonly reviews?: unknown[]
  /** Leave the repository's merge settings out, as a query that kept them leaves them out. */
  readonly withoutSettings?: boolean
}
/** GitHub's answer to the Pull request surface's one query, in its own spelling. */
function answerJson(change: Change = {}): string {
  return JSON.stringify({ data: {
    rateLimit: { limit: 5000, remaining: 4800, resetAt: '2099-01-01T00:00:00Z' }, viewer: { login: 'sotto-fixture' },
    repository: {
      ...change.withoutSettings ? {} : { autoMergeAllowed: change.autoMerge ?? false, mergeCommitAllowed: true, squashMergeAllowed: change.squash ?? true, rebaseMergeAllowed: false },
      pullRequest: {
        number: 74, title: 'Make the greeting friendlier', url: URL_74, body: 'Says hello.\n\n- One change', state: 'OPEN', isDraft: false,
        mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED', baseRefName: 'main', headRefName: 'feat/greeting', isCrossRepository: false,
        headRepositoryOwner: { login: 'sotto-fixture' }, autoMergeRequest: null, mergedAt: null, viewerCanUpdateBranch: change.canUpdate ?? true,
        baseRef: change.behindBy === null ? null : { compare: { behindBy: change.behindBy ?? 2 } }, latestOpinionatedReviews: { nodes: change.reviews ?? [] },
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
          { __typename: 'CheckRun', name: 'build', checkSuite: { workflowRun: { workflow: { name: 'CI' } } }, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/sotto-fixture/owned/actions/runs/1' },
          { __typename: 'CheckRun', name: 'lint', checkSuite: { workflowRun: { workflow: { name: 'CI' } } }, status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/sotto-fixture/owned/actions/runs/2' },
          { __typename: 'CheckRun', name: 'e2e', checkSuite: null, status: 'IN_PROGRESS', conclusion: null, detailsUrl: null },
          { __typename: 'StatusContext', context: 'deploy/preview', state: 'PENDING', targetUrl: 'https://preview.example/74', description: 'Deploying' },
        ] } } } }] },
        ...change.pull,
      },
    },
  } })
}

/** A scripted gh: each call is recorded, and answered by the handler or refused the way gh refuses. */
function scripted(handler: (args: readonly string[]) => string | Error, options: { rateLimit?: GitHubRateLimit; now?: () => number } = {}) {
  const calls: string[][] = []
  const run: RunGitCommand = async (_cwd, command, args) => {
    // The Git reads a read and a checkout make: the project's remotes, where pull requests are read from.
    if (command === 'git' && args.join(' ') === 'config --get remote.origin.url') return 'git@github.com:sotto-fixture/owned.git\n'
    if (command === 'git' && args[0] === 'config' && args[1] === '--get-regexp') return 'remote.origin.url git@github.com:sotto-fixture/owned.git\n'
    if (command !== 'gh') throw new Error('git is not scripted here')
    calls.push([...args])
    const answer = handler(args)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { service: new GitPullRequests({ run, ...options }), calls }
}
const reads = (answer: () => string) => (args: readonly string[]): string | Error | undefined => args[0] === 'api' && args[1] === 'graphql' ? answer() : undefined
const query = (call: readonly string[] | undefined) => call?.find(arg => arg.startsWith('query=')) ?? ''

describe('reading a pull request through gh, the way T3 reads it', () => {
  it('reads the description, each check, the review, the merge methods the repository allows and how far the branch is behind, in one query', async () => {
    const { service, calls } = scripted(args => reads(() => answerJson())(args) ?? new Error('unexpected'))
    const view = await service.view('C:/repo', '#74')
    expect(view).toMatchObject({ number: 74, url: URL_74, title: 'Make the greeting friendlier', body: 'Says hello.\n\n- One change', state: 'open', draft: false,
      baseBranch: 'main', headBranch: 'feat/greeting', crossRepository: false, reviewDecision: 'review_required', mergeable: 'mergeable',
      mergeMethods: ['merge', 'squash'], autoMergeAllowed: false, autoMerge: null, behindBy: 2, canUpdateBranch: true, reviews: [], mergedAt: null })
    expect(view.checks).toEqual([
      { name: 'CI / build', status: 'success', url: 'https://github.com/sotto-fixture/owned/actions/runs/1', description: null },
      { name: 'CI / lint', status: 'failure', url: 'https://github.com/sotto-fixture/owned/actions/runs/2', description: null },
      { name: 'e2e', status: 'pending', url: null, description: null },
      { name: 'deploy/preview', status: 'pending', url: 'https://preview.example/74', description: 'Deploying' },
    ])
    // One gh process, one GraphQL query: the pull request, its checks and reviews, the comparison and the merge settings.
    expect(calls).toHaveLength(1)
    // A number is read from the repository gh would read it from, the head named by GitHub's own pull request ref.
    expect(calls[0]).toEqual(expect.arrayContaining(['api', 'graphql', 'owner=sotto-fixture', 'name=owned', 'number=74', 'pullRef=refs/pull/74/head']))
    for (const field of ['statusCheckRollup', 'latestOpinionatedReviews', 'compare(headRef: $pullRef)', 'mergeCommitAllowed', 'rateLimit { limit remaining resetAt }']) expect(query(calls[0])).toContain(field)
  })
  it('reads a merged, a draft, an armed and a conflicting one, and leaves every method offered when GitHub will not say', async () => {
    const pull = { state: 'CLOSED', mergedAt: '2026-09-23T00:00:00Z', isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED', autoMergeRequest: { mergeMethod: 'SQUASH' }, isCrossRepository: true, headRepositoryOwner: { login: 'fork' }, viewerCanUpdateBranch: null }
    const { service } = scripted(args => reads(() => answerJson({ pull, behindBy: null, withoutSettings: true }))(args) ?? new Error('unexpected'))
    const view = await service.view('C:/repo', URL_74)
    expect(view).toMatchObject({ state: 'merged', draft: true, mergeable: 'conflicting', reviewDecision: 'changes_requested', autoMerge: { method: 'squash' }, crossRepository: true, autoMergeAllowed: true,
      mergeMethods: ['merge', 'squash', 'rebase'], behindBy: null, canUpdateBranch: false, reviews: [], mergedAt: '2026-09-23T00:00:00Z' })
  })
  it('shows what GitHub did answer when it refuses a part of the read, such as a comparison it cannot make', async () => {
    const partial = answerJson({ behindBy: null })
    const { service } = scripted(() => Object.defineProperty(new Error("gh: Could not resolve head ref 'refs/pull/74/head'."), 'stdout', { value: partial }))
    await expect(service.view('C:/repo', URL_74)).resolves.toMatchObject({ number: 74, behindBy: null, mergeMethods: ['merge', 'squash'] })
  })
  it('tells checks GitHub refused from no checks at all', async () => {
    const none = scripted(args => reads(() => answerJson({ pull: { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } } }))(args) ?? new Error('unexpected'))
    await expect(none.service.view('C:/repo', URL_74)).resolves.toMatchObject({ checks: [], checksUnknown: false })
    // GitHub answers the rest and names the part it refused; gh fails with that answer on its output.
    const body = JSON.parse(answerJson({ pull: { commits: null } })) as Record<string, unknown>
    const partial = JSON.stringify({ ...body, errors: [{ type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'commits'], message: 'Resource not accessible by integration' }] })
    const refused = scripted(() => Object.defineProperty(new Error('gh: Resource not accessible by integration'), 'stdout', { value: partial }))
    await expect(refused.service.view('C:/repo', URL_74)).resolves.toMatchObject({ number: 74, checks: [], checksUnknown: true })
    const rollup = JSON.parse(answerJson()) as { data: { repository: { pullRequest: { commits: { nodes: Array<{ commit: { statusCheckRollup: unknown } }> } } } } }
    rollup.data.repository.pullRequest.commits.nodes[0]!.commit.statusCheckRollup = null
    const deep = JSON.stringify({ ...rollup, errors: [{ path: ['repository', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'] }] })
    const refusedRollup = scripted(() => Object.defineProperty(new Error('gh: Resource not accessible by integration'), 'stdout', { value: deep }))
    await expect(refusedRollup.service.view('C:/repo', URL_74)).resolves.toMatchObject({ checks: [], checksUnknown: true })
  })
  it('keeps the checks GitHub returned when it refuses only a detail of one, or one check whole', async () => {
    type Rollup = { data: { repository: { pullRequest: { commits: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: Array<Record<string, unknown> | null> } } } }> } } } } }
    const nodes = 'repository pullRequest commits nodes 0 commit statusCheckRollup contexts nodes'.split(' ').map(part => part === '0' ? 0 : part)
    const refusing = (path: ReadonlyArray<string | number>, change: (rollup: Rollup) => void) => {
      const body = JSON.parse(answerJson()) as Rollup
      change(body)
      const stdout = JSON.stringify({ ...body, errors: [{ type: 'FORBIDDEN', path, message: 'Resource not accessible by integration' }] })
      return scripted(() => Object.defineProperty(new Error('gh: Resource not accessible by integration'), 'stdout', { value: stdout })).service
    }
    const contexts = (rollup: Rollup) => rollup.data.repository.pullRequest.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes
    // The failing lint check's workflow name refused: lint is still a failure, and nothing is unknown.
    const detail = refusing([...nodes, 1, 'checkSuite', 'workflowRun'], rollup => { contexts(rollup)[1]!.checkSuite = { workflowRun: null } })
    const view = await detail.view('C:/repo', URL_74)
    expect(view.checksUnknown).toBe(false)
    expect(view.checks).toContainEqual({ name: 'lint', status: 'failure', url: 'https://github.com/sotto-fixture/owned/actions/runs/2', description: null })
    expect(view.checks).toHaveLength(4)
    // One check refused whole: the others stand, the failure among them, and the checks are not all known.
    const whole = refusing([...nodes, 0], rollup => { contexts(rollup)[0] = null })
    const partly = await whole.view('C:/repo', URL_74)
    expect(partly.checksUnknown).toBe(true)
    expect(partly.checks.map(check => [check.name, check.status])).toEqual([['CI / lint', 'failure'], ['e2e', 'pending'], ['deploy/preview', 'pending']])
    // A refused part GitHub cannot leave empty (a check run's suite is never null) nulls the whole check, whatever the error's path says.
    const nulled = refusing([...nodes, 0, 'checkSuite'], rollup => { contexts(rollup)[0] = null })
    const gone = await nulled.view('C:/repo', URL_74)
    expect(gone.checksUnknown).toBe(true)
    expect(gone.checks).toHaveLength(3)
  })
  it('names who approved or asked for changes, with GitHub links only, and leaves out comments and reviewers GitHub no longer names', async () => {
    const reviews = [
      { state: 'APPROVED', url: 'https://github.com/sotto-fixture/owned/pull/74#pullrequestreview-1', author: { login: 'mira' } },
      { state: 'COMMENTED', url: 'https://github.com/sotto-fixture/owned/pull/74#pullrequestreview-2', author: { login: 'sam' } },
      { state: 'CHANGES_REQUESTED', url: 'https://elsewhere.example/review', author: { login: 'ola' } },
      { state: 'APPROVED', url: null, author: null },
    ]
    const { service } = scripted(args => reads(() => answerJson({ reviews }))(args) ?? new Error('unexpected'))
    const view = await service.view('C:/repo', '#74')
    expect(view.reviews).toEqual([
      { author: 'mira', state: 'approved', url: 'https://github.com/sotto-fixture/owned/pull/74#pullrequestreview-1' },
      { author: 'ola', state: 'changes_requested', url: null },
    ])
  })
  it('keeps the repository\'s merge settings fifteen minutes rather than asking for them with every read', async () => {
    let now = 1_000_000
    const { service, calls } = scripted(args => reads(() => answerJson({ withoutSettings: !query(args).includes('mergeCommitAllowed') }))(args) ?? new Error('unexpected'), { now: () => now })
    await service.view('C:/repo', URL_74)
    now += 60_000
    await expect(service.view('C:/repo', URL_74)).resolves.toMatchObject({ mergeMethods: ['merge', 'squash'], autoMergeAllowed: false })
    now += 15 * 60_000
    await service.view('C:/repo', URL_74)
    expect(calls.map(call => query(call).includes('mergeCommitAllowed'))).toEqual([true, false, true])
  })
  it('says in plain words when GitHub limits the sign-in, and does not ask while GitHub reports nothing left', async () => {
    const now = 1_000_000
    const rateLimit = new GitHubRateLimit({ now: () => now })
    const limited = scripted(() => new Error('gh: API rate limit exceeded for user ID 1. (HTTP 403)'), { rateLimit, now: () => now })
    const refusal = await limited.service.view('C:/repo', URL_74).then(() => new Error('it read'), (error: unknown) => error as Error)
    expect(refusal).toBeInstanceOf(GitPullRequestLimited)
    expect(refusal.message).toBe('GitHub is limiting requests from your gh sign-in, so Sotto could not read the pull request. Nothing was lost. Try again in a minute.')
    expect((refusal as GitPullRequestLimited).retryAt).toBe(now + 30_000)
    // A rate limit known to have no points left refuses before gh is started, until GitHub's reset.
    rateLimit.answered('github.com', rateLimit.asking(), { limit: 5000, remaining: 0, resetAt: new Date(now + 20 * 60_000).toISOString() }, 'sotto-fixture')
    const empty = scripted(() => new Error('unexpected'), { rateLimit, now: () => now })
    await expect(empty.service.view('C:/repo', URL_74)).rejects.toThrow('Try again in about 20 minutes.')
    expect(empty.calls).toEqual([])
  })
  it('says the time GitHub gave with its refusal, when it gave one', async () => {
    const now = 1_000_000
    const body = JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 0, resetAt: new Date(now + 12 * 60_000).toISOString() }, viewer: null, repository: null } })
    const { service } = scripted(() => Object.assign(new Error('gh: API rate limit exceeded for user ID 1. (HTTP 403)'), { stdout: body }), { now: () => now })
    const refusal = await service.view('C:/repo', URL_74).then(() => new Error('it read'), (error: unknown) => error as Error)
    expect(refusal).toBeInstanceOf(GitPullRequestLimited)
    expect((refusal as GitPullRequestLimited).retryAt).toBe(now + 12 * 60_000)
    expect(refusal.message).toContain('Try again in about 12 minutes.')
  })
  it('says what went wrong when gh cannot read it, and refuses a reference that is not a pull request', async () => {
    const { service } = scripted(() => new Error('To get started with GitHub CLI, please run:  gh auth login'))
    await expect(service.view('C:/repo', '#74')).rejects.toThrow('Could not read the pull request. To get started with GitHub CLI, please run:  gh auth login')
    await expect(service.view('C:/repo', 'feature/branch')).rejects.toThrow('Use a pull request URL, 123, or #123.')
    const outside = scripted(args => reads(() => answerJson({ pull: { url: 'https://git.example.com/o/r/pull/74' } }))(args) ?? '')
    await expect(outside.service.view('C:/repo', '74')).rejects.toThrow('Sotto shows pull requests from GitHub only.')
  })
  it('reads references the way T3 does', () => {
    expect(parsePullRequestReference('#42')).toBe('42')
    expect(parsePullRequestReference(' 42 ')).toBe('42')
    expect(parsePullRequestReference('gh pr checkout 42')).toBe('42')
    expect(parsePullRequestReference('https://github.com/o/r/pull/42/files')).toBe('https://github.com/o/r/pull/42/files')
    expect(parsePullRequestReference('https://gitlab.com/o/r/-/merge_requests/42')).toBeNull()
    expect(parsePullRequestReference('main')).toBeNull()
    expect(parsePullRequestReference('#0')).toBeNull()
    expect(pullRequestKey('https://github.com/O/R/pull/42/files')).toBe(pullRequestKey('https://github.com/o/r/pull/42'))
  })
})

describe('acting on a pull request, one press at a time', () => {
  const cases: Array<[GitPullRequestAction, 'merge' | 'squash' | 'rebase' | undefined, string[], Record<string, unknown>]> = [
    ['merge', 'squash', ['pr', 'merge', URL_74, '--squash'], { state: 'MERGED', mergedAt: '2026-09-23T00:00:00Z' }],
    ['enable-auto-merge', 'merge', ['pr', 'merge', URL_74, '--auto', '--merge'], { autoMergeRequest: { mergeMethod: 'MERGE' } }],
    ['disable-auto-merge', undefined, ['pr', 'merge', URL_74, '--disable-auto'], { autoMergeRequest: null }],
    ['update-branch', undefined, ['pr', 'update-branch', URL_74], {}],
    ['update-branch', 'rebase', ['pr', 'update-branch', URL_74, '--rebase'], {}],
    ['ready', undefined, ['pr', 'ready', URL_74], { isDraft: false }],
    ['draft', undefined, ['pr', 'ready', URL_74, '--undo'], { isDraft: true }],
    ['close', undefined, ['pr', 'close', URL_74], { state: 'CLOSED' }],
    ['reopen', undefined, ['pr', 'reopen', URL_74], { state: 'OPEN' }],
  ]
  for (const [action, method, expected, after] of cases) {
    it(`${action}${method ? ` (${method})` : ''} runs ${expected.slice(1, 2).join(' ')} and reads the pull request back`, async () => {
      let acted = false
      const { service, calls } = scripted(args => {
        if (args[0] === 'pr') { acted = true; return '' }
        return reads(() => answerJson({ pull: acted ? after : {} }))(args) ?? new Error('unexpected')
      })
      const view = await service.act('C:/repo', URL_74, action, method)
      expect(calls.filter(call => call[0] !== 'api')).toEqual([expected])
      expect(view?.number).toBe(74)
    })
    it(`${action}${method ? ` (${method})` : ''} is refused in T3's words when GitHub refuses it`, async () => {
      const { service, calls } = scripted(args => {
        if (args[0] === 'pr') return new Error('GraphQL: Pull request is not mergeable (mergePullRequest)')
        return reads(() => answerJson({ pull: { isDraft: action === 'ready', state: action === 'reopen' ? 'CLOSED' : 'OPEN', autoMergeRequest: action === 'disable-auto-merge' ? { mergeMethod: 'SQUASH' } : null }, behindBy: 3 }))(args) ?? new Error('unexpected')
      })
      const refusal = await service.act('C:/repo', URL_74, action, method).then(() => new Error('it acted'), (error: unknown) => error as Error)
      expect(refusal).toBeInstanceOf(GitPullRequestRefusal)
      expect(refusal.message).toMatch(/^Could not /u)
      expect(refusal.message).toContain('Pull request is not mergeable')
      // Nothing is pressed twice: one action, then the read that settles it.
      expect(calls.filter(call => call[0] !== 'api')).toHaveLength(1)
    })
  }
  it('reads GitHub once after a press: the surface\'s own read that follows is answered by it', async () => {
    let now = 1_000_000
    let merged = false
    const { service, calls } = scripted(args => {
      if (args[0] === 'pr') { merged = true; return '' }
      return reads(() => answerJson({ pull: merged ? { state: 'MERGED', mergedAt: '2026-09-23T00:00:00Z' } : {} }))(args) ?? new Error('unexpected')
    }, { now: () => now })
    await service.act('C:/repo', URL_74, 'merge', 'squash')
    await expect(service.view('C:/repo', URL_74)).resolves.toMatchObject({ state: 'merged' })
    expect(calls.map(call => call[0])).toEqual(['pr', 'api'])
    // A Refresh after that asks GitHub, as does a read that comes too long after the press.
    await service.view('C:/repo', URL_74)
    expect(calls.map(call => call[0])).toEqual(['pr', 'api', 'api'])
    await service.act('C:/repo', URL_74, 'close')
    now += 60_000
    await service.view('C:/repo', URL_74)
    expect(calls.map(call => call[0])).toEqual(['pr', 'api', 'api', 'pr', 'api', 'api'])
  })
  it('reads GitHub once after a press the rate limit refused to settle: the surface\'s read that follows shows that refusal', async () => {
    let now = 1_000_000
    const { service, calls } = scripted(args => args[0] === 'pr' ? '' : new Error('gh: You have exceeded a secondary rate limit. (HTTP 403)'), { now: () => now })
    await expect(service.act('C:/repo', URL_74, 'merge', 'squash')).resolves.toBeNull()
    const refusal = await service.view('C:/repo', URL_74).then(() => new Error('it read'), (error: unknown) => error as Error)
    expect(refusal).toBeInstanceOf(GitPullRequestLimited)
    expect((refusal as GitPullRequestLimited).retryAt).toBe(now + 30_000)
    expect(calls.map(call => call[0])).toEqual(['pr', 'api'])
    // It stands once: a Refresh after it asks GitHub again.
    now += 1_000
    await expect(service.view('C:/repo', URL_74)).rejects.toBeInstanceOf(GitPullRequestLimited)
    expect(calls.map(call => call[0])).toEqual(['pr', 'api', 'api'])
  })
  it('settles a lost reply by reading the pull request again: merged is merged, whatever gh said', async () => {
    let merged = false
    const { service, calls } = scripted(args => {
      if (args[1] === 'merge') { merged = true; return new Error('gh did not finish in time.') }
      return reads(() => answerJson({ pull: merged ? { state: 'MERGED', mergedAt: '2026-09-23T00:00:00Z' } : {} }))(args) ?? new Error('unexpected')
    })
    await expect(service.act('C:/repo', URL_74, 'merge', 'merge')).resolves.toMatchObject({ state: 'merged' })
    expect(calls.filter(call => call[1] === 'merge')).toHaveLength(1)
  })
  it('gives T3\'s hint when GitHub gives no reason, and the rebase hint for Update with rebase', async () => {
    const { service } = scripted(args => args[1] === 'update-branch' ? new Error('') : reads(() => answerJson())(args) ?? new Error('unexpected'))
    await expect(service.act('C:/repo', URL_74, 'update-branch', 'rebase')).rejects.toThrow('Could not update this branch. GitHub refused it. A rebase stops at the first commit that does not apply cleanly')
    await expect(service.act('C:/repo', URL_74, 'update-branch')).rejects.toThrow('Could not update this branch. GitHub refused it. Check that you have write access to the branch')
  })
  it('refuses before asking GitHub: a merge with no method, a squash update, a pull request outside GitHub', async () => {
    const { service, calls } = scripted(() => '')
    await expect(service.act('C:/repo', URL_74, 'merge')).rejects.toThrow('Choose a merge method first.')
    await expect(service.act('C:/repo', URL_74, 'enable-auto-merge')).rejects.toThrow('Choose a merge method first.')
    await expect(service.act('C:/repo', URL_74, 'update-branch', 'squash')).rejects.toThrow('Update the branch with a merge commit or a rebase.')
    await expect(service.act('C:/repo', 'https://git.example.com/o/r/pull/1', 'close')).rejects.toThrow('Sotto acts on pull requests from GitHub only.')
    expect(calls).toEqual([])
  })
})

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', ...args], { cwd, windowsHide: true, encoding: 'utf8' }).trim()
/** A clone of an owned bare remote that has a pull request's branch and GitHub's pull request ref. */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-pull-requests-')); roots.push(root)
  const remote = join(root, 'remote.git'), author = join(root, 'author'), repo = join(root, 'repo')
  git(root, 'init', '--bare', '-q', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main', author); git(author, 'remote', 'add', 'origin', remote)
  await writeFile(join(author, 'a.txt'), 'a\n'); git(author, 'add', '.'); git(author, 'commit', '-qm', 'First'); git(author, 'push', '-q', 'origin', 'HEAD:main')
  git(author, 'checkout', '-q', '-b', 'feat/greeting'); await writeFile(join(author, 'a.txt'), 'b\n'); git(author, 'commit', '-qam', 'Greet')
  git(author, 'push', '-q', 'origin', 'feat/greeting', 'HEAD:refs/pull/74/head')
  const head = git(author, 'rev-parse', 'HEAD')
  git(root, 'clone', '-q', remote, repo)
  // The clone's origin is written as GitHub's URL, and Git rewrites it to the owned remote, so the pull requests match it.
  git(repo, 'config', `url.${remote}.insteadOf`, 'https://github.com/sotto-fixture/owned')
  git(repo, 'remote', 'set-url', 'origin', 'https://github.com/sotto-fixture/owned')
  return { root, repo, head }
}
const gitOnly: RunGitCommand = (cwd, command, args, options) => command === 'git' ? runGitStatusCommand(cwd, command, args, options) : Promise.reject(new Error('gh is not used here'))

describe('Checkout pull request into a worktree', () => {
  it('makes the head branch of a pull request from this repository, tracking it, and uses it as it stands the next time', async () => {
    const f = await repository()
    const service = new GitPullRequests({ run: gitOnly })
    await expect(service.prepareWorktreeBranch(f.repo, { number: 74, url: URL_74, headBranch: 'feat/greeting', crossRepository: false })).resolves.toEqual({ branch: 'feat/greeting', worktreePath: null })
    expect(git(f.repo, 'rev-parse', 'refs/heads/feat/greeting')).toBe(f.head)
    expect(git(f.repo, 'rev-parse', '--abbrev-ref', 'feat/greeting@{upstream}')).toBe('origin/feat/greeting')
    await expect(service.prepareWorktreeBranch(f.repo, { number: 74, url: URL_74, headBranch: 'feat/greeting', crossRepository: false })).resolves.toEqual({ branch: 'feat/greeting', worktreePath: null })
  }, 30_000)
  it('takes a fork\'s head from GitHub\'s pull request ref under its own name', async () => {
    const f = await repository()
    const service = new GitPullRequests({ run: gitOnly })
    await expect(service.prepareWorktreeBranch(f.repo, { number: 74, url: URL_74, headBranch: 'Main', crossRepository: true })).resolves.toEqual({ branch: 'sotto/pr-74/main', worktreePath: null })
    expect(git(f.repo, 'rev-parse', 'refs/heads/sotto/pr-74/main')).toBe(f.head)
  }, 30_000)
  it('answers with the worktree that has the branch, and refuses the branch the project folder has', async () => {
    const f = await repository()
    const service = new GitPullRequests({ run: gitOnly })
    const other = join(f.root, 'other')
    git(f.repo, 'worktree', 'add', '-q', '-b', 'feat/greeting', other, 'origin/feat/greeting')
    const answered = await service.prepareWorktreeBranch(f.repo, { number: 74, url: URL_74, headBranch: 'feat/greeting', crossRepository: false })
    expect(answered.branch).toBe('feat/greeting')
    expect(answered.worktreePath?.replace(/\\/gu, '/').toLowerCase()).toBe(other.replace(/\\/gu, '/').toLowerCase())
    git(f.repo, 'worktree', 'remove', other)
    git(f.repo, 'checkout', '-q', 'feat/greeting')
    await expect(service.prepareWorktreeBranch(f.repo, { number: 74, url: URL_74, headBranch: 'feat/greeting', crossRepository: false })).rejects.toThrow('already checked out in the project folder. Use Local')
  }, 30_000)
  it('says so when the pull request cannot be fetched', async () => {
    const f = await repository()
    const service = new GitPullRequests({ run: gitOnly })
    await expect(service.prepareWorktreeBranch(f.repo, { number: 99, url: 'https://github.com/sotto-fixture/owned/pull/99', headBranch: 'gone', crossRepository: false })).rejects.toThrow('Could not fetch the pull request\'s branch.')
  }, 30_000)
})

describe('a checkout from another repository', () => {
  it('is refused before anything is fetched, Worktree and Local alike', async () => {
    const f = await repository()
    const calls: string[] = []
    const service = new GitPullRequests({ run: (cwd, command, args, options) => { calls.push(`${command} ${args.join(' ')}`); return gitOnly(cwd, command, args, options) } })
    const other = { number: 74, url: 'https://github.com/someone/else/pull/74', headBranch: 'feat/greeting', crossRepository: false }
    await expect(service.prepareWorktreeBranch(f.repo, other)).rejects.toThrow('This pull request is in another repository. Check it out from a clone of that repository.')
    await expect(service.checkoutLocal(f.repo, other.url)).rejects.toThrow('This pull request is in another repository.')
    expect(calls.some(call => call.includes('fetch') || call.startsWith('gh'))).toBe(false)
    expect(git(f.repo, 'show-ref', '--heads').includes('feat/greeting')).toBe(false)
  }, 30_000)
  it('reads the repository of a GitHub remote in each of its spellings', () => {
    expect(githubRepositoryOf('https://github.com/Owner/Repo.git')).toBe('owner/repo')
    expect(githubRepositoryOf('git@github.com:owner/repo.git')).toBe('owner/repo')
    expect(githubRepositoryOf('ssh://git@github.com/owner/repo')).toBe('owner/repo')
    expect(githubRepositoryOf('https://git.example.com/owner/repo.git')).toBeNull()
    expect(githubRepositoryOf('C:/remotes/owned.git')).toBeNull()
  })
})

describe('Checkout pull request, Local', () => {
  it('runs gh pr checkout without forcing, and says why when it cannot', async () => {
    const ok = scripted(() => '')
    await ok.service.checkoutLocal('C:/repo', URL_74)
    expect(ok.calls).toEqual([['pr', 'checkout', URL_74]])
    const refused = scripted(() => new Error('error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt'))
    await expect(refused.service.checkoutLocal('C:/repo', URL_74)).rejects.toThrow('Could not check out the pull request. error: Your local changes to the following files would be overwritten by checkout: a.txt')
    await expect(refused.service.checkoutLocal('C:/repo', 'nope')).rejects.toThrow('Sotto checks out pull requests from GitHub only.')
  })
})
