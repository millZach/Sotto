// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesService } from '../../../src/main/files/service'
import { GitPullRequestsService } from '../../../src/main/tools/gitPullRequests'
import type { ToolsResult } from '../../../src/shared/tools'
const unwrap = <T>(r: ToolsResult<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r)); return r.value }
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim()
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-pr-')); roots.push(root)
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'); await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'feature'); git(repo, 'config', 'user.name', 'Sotto fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'work.txt'), 'reviewed work\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Reviewed change')
  git(root, 'init', '--bare', '-q', remote); git(repo, 'remote', 'add', 'origin', remote)
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'project', workingDirectory: repo }), copyPath: vi.fn(), reveal: vi.fn() })
  const service = new GitPullRequestsService({ files, mutations: new Set() })
  return { repo, remote, files, service }
}
it('reviews the selected working copy and only pushes its reviewed commit after explicit action', async () => {
  const f = await fixture()
  const review = unwrap(await f.service.review({ threadId: 'a' }))
  expect(review).toMatchObject({ branch: 'feature', remote: 'origin', remoteUrl: f.remote, title: 'Reviewed change', pullRequest: null })
  expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('')
  const target = { threadId: 'a', workspaceId: review.workspace.workspaceId, revision: review.revision, remote: review.remote!, action: 'push' }
  expect(await f.service.act(target)).toMatchObject({ ok: true, value: { message: 'Branch pushed.' } })
  expect(git(f.remote, 'rev-parse', 'refs/heads/feature')).toBe(git(f.repo, 'rev-parse', 'HEAD'))
  git(f.repo, 'switch', '-qc', 'another')
  expect(await f.service.act(target)).toMatchObject({ ok: false, error: { code: 'workspace-changed' } })
}, 20000)
it('creates a PR once, recovers a lost acknowledgement, and refreshes actual check/review results', async () => {
  const f = await fixture(); git(f.repo, 'remote', 'set-url', 'origin', 'https://github.com/sotto-fixture/owned.git')
  git(f.repo, 'remote', 'set-url', 'origin', 'https://github.com/sotto-fixture/fetch-only.git')
  git(f.repo, 'config', 'remote.origin.pushurl', 'https://github.com/sotto-fixture/owned.git')
  let created = false, creates = 0, approved = false
  const rawPr = () => ({ number: 17, title: 'Reviewed title', url: 'https://github.com/sotto-fixture/owned/pull/17', state: 'OPEN', baseRefName: 'main', headRefName: 'feature', isDraft: false, headRepository: { name: 'owned' }, headRepositoryOwner: { login: 'sotto-fixture' }, reviewDecision: approved ? 'APPROVED' : 'REVIEW_REQUIRED', statusCheckRollup: [{ __typename: 'CheckRun', name: 'Build', status: 'COMPLETED', conclusion: approved ? 'SUCCESS' : 'FAILURE', detailsUrl: 'https://github.com/sotto-fixture/owned/actions/runs/1' }] })
  const command = vi.fn(async (cwd: string, executable: 'git' | 'gh', args: string[], stdin?: string) => {
    if (executable === 'git') {
      if (args[0] === 'ls-remote') { expect(args).toContain('https://github.com/sotto-fixture/owned.git'); return `${git(cwd, 'rev-parse', 'HEAD')}\trefs/heads/feature` }
      return git(cwd, ...args)
    }
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'sotto-fixture/owned', url: 'https://github.com/sotto-fixture/owned', defaultBranchRef: { name: 'main' } })
    if (args[1] === 'list') return JSON.stringify(created ? [rawPr()] : [])
    if (args[1] === 'create') { creates++; expect(stdin).toBe('Exact body\n\n$() `literal`'); created = true; throw new Error('Network connection lost after create') }
    throw new Error('Unexpected command')
  })
  const service = new GitPullRequestsService({ files: f.files, mutations: new Set(), command })
  const review = unwrap(await service.review({ threadId: 'a' }))
  expect(review).toMatchObject({ repository: 'https://github.com/sotto-fixture/owned', base: 'main', pullRequest: null, error: null })
  const request = { threadId: 'a', workspaceId: review.workspace.workspaceId, remote: 'origin', revision: review.revision, action: 'create', base: 'main', title: 'Reviewed title', body: 'Exact body\n\n$() `literal`' }
  expect(await service.act(request)).toMatchObject({ ok: true, value: { pullRequest: { number: 17, review: 'REVIEW_REQUIRED', checks: [{ name: 'Build', status: 'FAILURE' }] } } })
  approved = true
  expect(await service.act(request)).toMatchObject({ ok: true, value: { pullRequest: { number: 17, review: 'APPROVED', checks: [{ status: 'SUCCESS' }] } } })
  expect(creates).toBe(1)
}, 20000)
it('keeps closed PR status visible and never treats an authentication failure as absence', async () => {
  const f = await fixture(); git(f.repo, 'remote', 'set-url', 'origin', 'https://github.com/sotto-fixture/owned.git')
  let unavailable = false
  const command = vi.fn(async (cwd: string, executable: 'git' | 'gh', args: string[]) => {
    if (executable === 'git') return git(cwd, ...args)
    if (unavailable) throw new Error('HTTP 401: Bad credentials')
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'sotto-fixture/owned', url: 'https://github.com/sotto-fixture/owned', defaultBranchRef: { name: 'main' } })
    if (args[1] === 'list') { expect(args[args.indexOf('--state') + 1]).toBe('all'); return JSON.stringify([{ number: 11, title: 'Merged work', url: 'https://github.com/sotto-fixture/owned/pull/11', state: 'MERGED', baseRefName: 'main', headRefName: 'feature', isDraft: false, headRepository: { name: 'owned' }, headRepositoryOwner: { login: 'sotto-fixture' }, reviewDecision: 'APPROVED', statusCheckRollup: [] }]) }
    throw new Error('Must not create')
  })
  const service = new GitPullRequestsService({ files: f.files, mutations: new Set(), command })
  const review = unwrap(await service.review({ threadId: 'a' }))
  expect(review.pullRequest).toMatchObject({ state: 'MERGED' })
  unavailable = true
  const denied = unwrap(await service.review({ threadId: 'a' }))
  expect(denied.error).toContain('authentication')
  expect(await service.act({ threadId: 'a', workspaceId: denied.workspace.workspaceId, remote: 'origin', revision: denied.revision, action: 'create', base: 'main', title: 'No duplicate' })).toMatchObject({ ok: false })
  expect(command.mock.calls.some(call => call[1] === 'gh' && call[2][1] === 'create')).toBe(false)
}, 20000)
it('redacts remote credentials in review and failure diagnostics', async () => {
  const f = await fixture(); git(f.repo, 'remote', 'set-url', 'origin', 'https://account:secret-token@github.com/sotto-fixture/owned.git')
  const command = async (cwd: string, executable: 'git' | 'gh', args: string[]) => {
    if (executable === 'gh' || args[0] === 'push') throw new Error('Authentication failed for https://account:secret-token@github.com/sotto-fixture/owned.git')
    return git(cwd, ...args)
  }
  const service = new GitPullRequestsService({ files: f.files, mutations: new Set(), command })
  const review = unwrap(await service.review({ threadId: 'a' }))
  expect(JSON.stringify(review)).not.toContain('secret-token')
  const result = await service.act({ threadId: 'a', workspaceId: review.workspace.workspaceId, remote: 'origin', revision: review.revision, action: 'push' })
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('secret-token')
}, 20000)
