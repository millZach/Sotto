// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubRepositoryOf, GitPullRequestRefusal, GitPullRequests, pullRequestKey } from '../../../src/main/agents/gitPullRequests'
import { runGitStatusCommand, type RunGitCommand } from '../../../src/main/agents/gitStatus'
import { parsePullRequestReference, type GitPullRequestAction } from '../../../src/shared/gitPullRequests'

const URL_74 = 'https://github.com/sotto-fixture/owned/pull/74'
/** What `gh pr view --json` prints for a pull request, in GitHub's own spelling. */
function viewJson(change: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 74, title: 'Make the greeting friendlier', url: URL_74, body: 'Says hello.\n\n- One change', state: 'OPEN', isDraft: false,
    mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED', baseRefName: 'main', headRefName: 'feat/greeting', isCrossRepository: false,
    headRepositoryOwner: { login: 'sotto-fixture' }, autoMergeRequest: null, mergedAt: null,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/sotto-fixture/owned/actions/runs/1' },
      { __typename: 'CheckRun', name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/sotto-fixture/owned/actions/runs/2' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null, detailsUrl: null },
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'PENDING', targetUrl: 'https://preview.example/74', description: 'Deploying' },
    ],
    ...change,
  })
}
const comparisonJson = (change: { behindBy?: number; squash?: boolean; canUpdate?: boolean; autoMerge?: boolean } = {}) => JSON.stringify({ data: { repository: {
  autoMergeAllowed: change.autoMerge ?? false, mergeCommitAllowed: true, squashMergeAllowed: change.squash ?? true, rebaseMergeAllowed: false,
  pullRequest: { viewerCanUpdateBranch: change.canUpdate ?? true, baseRef: { compare: { behindBy: change.behindBy ?? 2 } } },
} } })

/** A scripted gh: each call is recorded, and answered by the handler or refused the way gh refuses. */
function scripted(handler: (args: readonly string[]) => string | Error) {
  const calls: string[][] = []
  const run: RunGitCommand = async (_cwd, command, args) => {
    // The one Git read a checkout makes: the project's origin, the repository the pull requests are in.
    if (command === 'git' && args.join(' ') === 'config --get remote.origin.url') return 'git@github.com:sotto-fixture/owned.git\n'
    if (command !== 'gh') throw new Error('git is not scripted here')
    calls.push([...args])
    const answer = handler(args)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { service: new GitPullRequests({ run }), calls }
}
const reads = (view: () => string, comparison = comparisonJson) => (args: readonly string[]): string | Error | undefined => {
  if (args[0] === 'pr' && args[1] === 'view') return view()
  if (args[0] === 'api' && args[1] === 'graphql') return comparison()
  return undefined
}

describe('reading a pull request through gh, the way T3 reads it', () => {
  it('reads the description, each check, the review, the merge methods the repository allows and how far the branch is behind', async () => {
    const { service, calls } = scripted(args => reads(() => viewJson())(args) ?? new Error('unexpected'))
    const view = await service.view('C:/repo', '#74')
    expect(view).toMatchObject({ number: 74, url: URL_74, title: 'Make the greeting friendlier', body: 'Says hello.\n\n- One change', state: 'open', draft: false,
      baseBranch: 'main', headBranch: 'feat/greeting', crossRepository: false, reviewDecision: 'review_required', mergeable: 'mergeable',
      mergeMethods: ['merge', 'squash'], autoMergeAllowed: false, autoMerge: null, behindBy: 2, canUpdateBranch: true })
    expect(view.checks).toEqual([
      { name: 'CI / build', status: 'success', url: 'https://github.com/sotto-fixture/owned/actions/runs/1', description: null },
      { name: 'CI / lint', status: 'failure', url: 'https://github.com/sotto-fixture/owned/actions/runs/2', description: null },
      { name: 'e2e', status: 'pending', url: null, description: null },
      { name: 'deploy/preview', status: 'pending', url: 'https://preview.example/74', description: 'Deploying' },
    ])
    expect(calls[0]).toEqual(['pr', 'view', '74', '--json', expect.stringContaining('statusCheckRollup')])
    // The comparison is asked of the repository the URL names, for the head the pull request has.
    expect(calls[1]).toEqual(expect.arrayContaining(['api', 'graphql', 'owner=sotto-fixture', 'name=owned', 'number=74', 'headRef=feat/greeting']))
  })
  it('reads a merged, a draft, an armed and a conflicting one, and leaves every method offered when GitHub will not compare', async () => {
    const { service } = scripted(args => reads(() => viewJson({ state: 'CLOSED', mergedAt: '2026-09-23T00:00:00Z', isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED', autoMergeRequest: { mergeMethod: 'SQUASH' }, isCrossRepository: true, headRepositoryOwner: { login: 'fork' } }), () => new Error('HTTP 403') as never)(args) ?? new Error('HTTP 403'))
    const view = await service.view('C:/repo', URL_74)
    expect(view).toMatchObject({ state: 'merged', draft: true, mergeable: 'conflicting', reviewDecision: 'changes_requested', autoMerge: { method: 'squash' }, crossRepository: true, autoMergeAllowed: true,
      mergeMethods: ['merge', 'squash', 'rebase'], behindBy: null, canUpdateBranch: false })
  })
  it('says what went wrong when gh cannot read it, and refuses a reference that is not a pull request', async () => {
    const { service } = scripted(() => new Error('To get started with GitHub CLI, please run:  gh auth login'))
    await expect(service.view('C:/repo', '#74')).rejects.toThrow('Could not read the pull request. To get started with GitHub CLI, please run:  gh auth login')
    await expect(service.view('C:/repo', 'feature/branch')).rejects.toThrow('Use a pull request URL, 123, or #123.')
    const outside = scripted(args => reads(() => viewJson({ url: 'https://git.example.com/o/r/pull/74' }))(args) ?? '')
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
        if (args[0] === 'pr' && args[1] !== 'view') { acted = true; return '' }
        return reads(() => viewJson(acted ? after : {}))(args) ?? new Error('unexpected')
      })
      const view = await service.act('C:/repo', URL_74, action, method)
      expect(calls.filter(call => call[1] !== 'view' && call[0] !== 'api')).toEqual([expected])
      expect(view?.number).toBe(74)
    })
    it(`${action}${method ? ` (${method})` : ''} is refused in T3's words when GitHub refuses it`, async () => {
      const { service, calls } = scripted(args => {
        if (args[0] === 'pr' && args[1] !== 'view') return new Error('GraphQL: Pull request is not mergeable (mergePullRequest)')
        return reads(() => viewJson({ isDraft: action === 'ready', state: action === 'reopen' ? 'CLOSED' : 'OPEN', autoMergeRequest: action === 'disable-auto-merge' ? { mergeMethod: 'SQUASH' } : null }), () => comparisonJson({ behindBy: 3 }))(args) ?? new Error('unexpected')
      })
      const refusal = await service.act('C:/repo', URL_74, action, method).then(() => new Error('it acted'), (error: unknown) => error as Error)
      expect(refusal).toBeInstanceOf(GitPullRequestRefusal)
      expect(refusal.message).toMatch(/^Could not /u)
      expect(refusal.message).toContain('Pull request is not mergeable')
      // Nothing is pressed twice: one action, then the read that settles it.
      expect(calls.filter(call => call[1] !== 'view' && call[0] !== 'api')).toHaveLength(1)
    })
  }
  it('settles a lost reply by reading the pull request again: merged is merged, whatever gh said', async () => {
    let merged = false
    const { service, calls } = scripted(args => {
      if (args[1] === 'merge') { merged = true; return new Error('gh did not finish in time.') }
      return reads(() => viewJson(merged ? { state: 'MERGED', mergedAt: '2026-09-23T00:00:00Z' } : {}))(args) ?? new Error('unexpected')
    })
    await expect(service.act('C:/repo', URL_74, 'merge', 'merge')).resolves.toMatchObject({ state: 'merged' })
    expect(calls.filter(call => call[1] === 'merge')).toHaveLength(1)
  })
  it('gives T3\'s hint when GitHub gives no reason, and the rebase hint for Update with rebase', async () => {
    const { service } = scripted(args => args[1] === 'update-branch' ? new Error('') : reads(() => viewJson())(args) ?? new Error('unexpected'))
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
