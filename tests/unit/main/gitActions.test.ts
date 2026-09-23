// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { featureBranchName, GitActionRefusal, GitActions, type GitActionEvent } from '../../../src/main/agents/gitActions'
import { GitStatusReader, runGitStatusCommand, type RunGitCommand } from '../../../src/main/agents/gitStatus'
import { gitActionStages } from '../../../src/shared/gitActions'
import type { CommitMaterial } from '../../../src/main/llm/commitMessage'
import type { PullRequestMaterial } from '../../../src/main/llm/pullRequestText'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim()
const commit = (cwd: string, message: string) => { execFileSync('git', ['add', '.'], { cwd, windowsHide: true }); git(cwd, 'commit', '-qm', message) }
const configure = (cwd: string) => { git(cwd, 'config', 'user.name', 'Fixture'); git(cwd, 'config', 'user.email', 'fixture@example.invalid'); git(cwd, 'config', 'commit.gpgSign', 'false'); git(cwd, 'config', 'core.autocrlf', 'false'); git(cwd, 'config', 'core.hooksPath', '.githooks') }

interface GhFixture { (args: readonly string[]): Promise<string> }
/** A repository on `main`, pushed to an owned bare remote, and a second clone that can move the remote under it. */
async function fixture(options: { remote?: boolean; gh?: GhFixture; commitMessage?: string | null; pullRequestText?: { title: string; body: string } | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-git-actions-')); roots.push(root)
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), other = join(root, 'other')
  await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main'); configure(repo)
  await writeFile(join(repo, 'work.txt'), 'first\n'); commit(repo, 'First')
  if (options.remote !== false) {
    git(root, 'init', '--bare', '-q', '-b', 'main', remote); git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main'); git(repo, 'remote', 'set-head', 'origin', 'main')
    git(root, 'clone', '-q', '-b', 'main', remote, other); configure(other)
  }
  const calls: string[][] = []
  const run: RunGitCommand = async (cwd, command, args, runOptions) => {
    calls.push([command, ...args])
    if (command === 'gh') { if (!options.gh) throw new Error('gh: not signed in'); return options.gh(args) }
    return runGitStatusCommand(cwd, command, args, runOptions)
  }
  const status = new GitStatusReader({ run, fetchIntervalMs: () => 30_000 })
  const writeCommitMessage = vi.fn<(threadId: string, material: CommitMaterial) => Promise<string | null>>(async () => options.commitMessage === undefined ? 'Write the commit from the diff\n\nBecause the fixture asked.' : options.commitMessage)
  const writePullRequestText = vi.fn<(threadId: string, material: PullRequestMaterial) => Promise<{ title: string; body: string } | null>>(async () => options.pullRequestText === undefined ? { title: 'Ship the feature', body: '## What changed\n- Feature work' } : options.pullRequestText)
  const actions = new GitActions({ run, status, writeCommitMessage, writePullRequestText })
  const events: GitActionEvent[] = []
  const onProgress = (event: GitActionEvent) => { events.push(event) }
  return { root, repo, remote, other, actions, calls, events, onProgress, writeCommitMessage, writePullRequestText, gh: () => calls.filter(call => call[0] === 'gh') }
}

describe('the stacked Git action, the way T3 runs it', () => {
  it('commits everything with the message given, and offers Push', async () => {
    const f = await fixture()
    await writeFile(join(f.repo, 'work.txt'), 'second\n'); await writeFile(join(f.repo, 'new.txt'), 'new\n')
    const result = await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit', commitMessage: 'Second change.\n\nWith a body.', onProgress: f.onProgress })
    expect(result.commit).toMatchObject({ status: 'created', subject: 'Second change' })
    expect(git(f.repo, 'log', '-1', '--pretty=%s%n%b')).toBe('Second change\nWith a body.')
    expect(git(f.repo, 'status', '--porcelain')).toBe('')
    expect(result.toast).toEqual({ title: `Committed ${result.commit.sha!.slice(0, 7)}`, description: 'Second change', cta: { kind: 'run_action', label: 'Push', action: 'push' } })
    expect(f.writeCommitMessage).not.toHaveBeenCalled()
    // Git's own commit summary lines ride along as output, the way T3 passes every line on.
    expect(f.events.filter(event => event.kind !== 'hook_output').map(event => event.kind)).toEqual(['action_started', 'phase_started'])
    expect(f.events[0]).toMatchObject({ stages: ['Committing...'] })
  }, 30000)
  it('commits only the chosen files, and asks the provider for the message with the repository conventions', async () => {
    const f = await fixture()
    await writeFile(join(f.repo, 'AGENTS.md'), '# Rules\nSubjects in the imperative.\n'); commit(f.repo, 'Add the rules')
    await writeFile(join(f.repo, 'work.txt'), 'second\n'); await writeFile(join(f.repo, 'skip.txt'), 'not this one\n')
    git(f.repo, 'add', 'skip.txt') // staged beforehand, and still left out: the chosen files are the whole commit
    const result = await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit', filePaths: ['work.txt'], onProgress: f.onProgress })
    expect(result.commit).toMatchObject({ status: 'created', subject: 'Write the commit from the diff' })
    expect(git(f.repo, 'show', '--stat', '--pretty=', 'HEAD')).toContain('work.txt')
    expect(git(f.repo, 'show', '--stat', '--pretty=', 'HEAD')).not.toContain('skip.txt')
    expect(git(f.repo, 'status', '--porcelain')).toBe('?? skip.txt')
    const material = f.writeCommitMessage.mock.calls[0]![1]
    expect(material.text).toContain('+second')
    expect(material.conventions?.subjects).toEqual(['Add the rules', 'First'])
    expect(material.conventions?.agentsFile).toContain('Subjects in the imperative')
    expect(material.conventions?.nameStatus).toMatch(/^M\twork\.txt$/mu)
    expect(f.events.find(event => event.kind === 'action_started')).toMatchObject({ stages: ['Generating commit message...', 'Committing...'] })
  }, 30000)
  it('falls back to a stand-in subject when the provider writes nothing, and skips a commit with nothing to commit', async () => {
    const f = await fixture({ commitMessage: null })
    await writeFile(join(f.repo, 'work.txt'), 'second\n')
    expect((await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit' })).commit.subject).toBe('Update project files')
    const empty = await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit' })
    expect(empty.commit).toEqual({ status: 'skipped_no_changes' })
    expect(empty.toast.title).toBe('Nothing to commit')
  }, 30000)
  it('commits on a new feature branch named from the subject, unique among the branches there', async () => {
    const f = await fixture()
    git(f.repo, 'branch', 'feature/second-change')
    await writeFile(join(f.repo, 'work.txt'), 'second\n')
    const result = await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit', commitMessage: 'Second change', featureBranch: true, onProgress: f.onProgress })
    expect(result.branch).toEqual({ status: 'created', name: 'feature/second-change-2' })
    expect(git(f.repo, 'branch', '--show-current')).toBe('feature/second-change-2')
    expect(git(f.repo, 'log', '-1', '--pretty=%s')).toBe('Second change')
    expect(git(f.repo, 'log', '-1', '--pretty=%s', 'main')).toBe('First')
    expect(f.events.filter(event => event.kind === 'phase_started').map(event => (event as { phase: string }).phase)).toEqual(['branch', 'commit'])
    await expect(f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'push', featureBranch: true })).rejects.toThrow('Feature-branch checkout is only supported for commit actions.')
    await expect(f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit', featureBranch: true })).rejects.toThrow('no changes to commit')
  }, 30000)
  it('streams what a commit hook prints and names the hook', async () => {
    const f = await fixture({ remote: false })
    await mkdir(join(f.repo, '.githooks'))
    const hook = join(f.repo, '.githooks', 'pre-commit')
    await writeFile(hook, '#!/bin/sh\necho "checking the tree"\necho "still checking" 1>&2\nexit 0\n')
    await chmod(hook, 0o755)
    await writeFile(join(f.repo, 'work.txt'), 'second\n')
    const result = await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit', commitMessage: 'Hooked', onProgress: f.onProgress })
    expect(result.commit.status).toBe('created')
    const output = f.events.filter((event): event is Extract<GitActionEvent, { kind: 'hook_output' }> => event.kind === 'hook_output').map(event => event.text)
    expect(output).toEqual(expect.arrayContaining(['checking the tree', 'still checking']))
    expect(f.events.some(event => event.kind === 'hook_started' && event.hookName === 'pre-commit')).toBe(true)
    expect(f.events.some(event => event.kind === 'hook_finished' && event.hookName === 'pre-commit')).toBe(true)
  }, 30000)
  it('refuses a commit its hook refuses, with the hook\'s last words', async () => {
    const f = await fixture({ remote: false })
    await mkdir(join(f.repo, '.githooks'))
    await writeFile(join(f.repo, '.githooks', 'pre-commit'), '#!/bin/sh\necho "lint failed: trailing space" 1>&2\nexit 1\n')
    await chmod(join(f.repo, '.githooks', 'pre-commit'), 0o755)
    await writeFile(join(f.repo, 'work.txt'), 'second\n')
    await expect(f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit', commitMessage: 'Blocked' })).rejects.toThrow(/Commit failed\. .*lint failed: trailing space/u)
    expect(git(f.repo, 'log', '-1', '--pretty=%s')).toBe('First')
  }, 30000)
  it('pushes a branch with no upstream by setting one, says when there is nothing to push, and never forces', async () => {
    const f = await fixture()
    git(f.repo, 'switch', '-q', '-c', 'feature')
    await writeFile(join(f.repo, 'work.txt'), 'feature\n'); commit(f.repo, 'Feature work')
    const pushed = await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'push', onProgress: f.onProgress })
    expect(pushed.push).toEqual({ status: 'pushed', branch: 'feature', upstream: 'origin/feature', setUpstream: true })
    expect(git(f.repo, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature')
    expect(git(f.remote, 'log', '-1', '--pretty=%s', 'feature')).toBe('Feature work')
    expect(pushed.toast).toMatchObject({ title: expect.stringMatching(/^Pushed to origin\/feature$/u), cta: { kind: 'run_action', label: 'Create PR', action: 'create_pr' } })
    expect(f.events.find(event => event.kind === 'action_started')).toMatchObject({ stages: ['Pushing to origin...'] })
    expect((await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'push' })).push).toEqual({ status: 'skipped_up_to_date' })
    // The remote moves under the branch: the push is refused in T3's words and nothing is forced.
    await writeFile(join(f.other, 'other.txt'), 'remote\n'); commit(f.other, 'Remote commit'); git(f.other, 'push', '-q')
    await writeFile(join(f.repo, 'work.txt'), 'local\n'); commit(f.repo, 'Local commit')
    git(f.repo, 'switch', '-q', 'main')
    await writeFile(join(f.repo, 'work.txt'), 'diverging\n'); commit(f.repo, 'Diverging')
    await expect(f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'push', allowDefaultBranch: true })).rejects.toThrow('Branch is behind upstream. Pull/rebase before pushing.')
    expect(git(f.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('Remote commit')
    expect(f.calls.some(call => call.includes('--force') || call.includes('-f'))).toBe(false)
  }, 40000)
  it('commits and pushes from one press, and asks for the default-branch confirmation first', async () => {
    const f = await fixture()
    await writeFile(join(f.repo, 'work.txt'), 'second\n')
    await expect(f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit_push', commitMessage: 'Second' })).rejects.toThrow(/Confirm pushing from the default branch/u)
    expect(git(f.repo, 'log', '-1', '--pretty=%s')).toBe('First')
    const result = await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit_push', commitMessage: 'Second', allowDefaultBranch: true, onProgress: f.onProgress })
    expect(result.commit).toMatchObject({ status: 'created', subject: 'Second' })
    expect(result.push).toEqual({ status: 'pushed', branch: 'main', upstream: 'origin/main' })
    expect(git(f.remote, 'log', '-1', '--pretty=%s', 'main')).toBe('Second')
    expect(result.toast).toEqual({ title: `Pushed ${result.commit.sha!.slice(0, 7)} to origin/main`, description: 'Second', cta: { kind: 'none' } })
    expect(f.events.find(event => event.kind === 'action_started')).toMatchObject({ stages: ['Committing...', 'Pushing to origin...'] })
  }, 40000)
  it('refuses a pull request from a dirty tree or a detached HEAD, and opens the existing one instead of a second', async () => {
    const f = await fixture({ gh: async args => args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([{ number: 12, title: 'Already open', url: 'https://github.com/o/r/pull/12', baseRefName: 'main', headRefName: 'feature', state: 'OPEN' }]) : '' })
    git(f.repo, 'switch', '-q', '-c', 'feature')
    await writeFile(join(f.repo, 'work.txt'), 'feature\n'); commit(f.repo, 'Feature work')
    await writeFile(join(f.repo, 'work.txt'), 'dirty\n')
    await expect(f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'create_pr' })).rejects.toThrow('Commit local changes before creating a PR.')
    git(f.repo, 'checkout', '-q', '--', 'work.txt')
    git(f.repo, 'push', '-q', '-u', 'origin', 'feature')
    const result = await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'create_pr', onProgress: f.onProgress })
    expect(result.pr).toEqual({ status: 'opened_existing', url: 'https://github.com/o/r/pull/12', number: 12, base: 'main', head: 'feature', title: 'Already open' })
    expect(result.toast).toEqual({ title: 'Opened PR #12', description: 'Already open', cta: { kind: 'open_pr', label: 'View PR', url: 'https://github.com/o/r/pull/12' } })
    expect(f.gh().some(call => call[1] === 'pr' && call[2] === 'create')).toBe(false)
    git(f.repo, 'switch', '-q', '--detach')
    // With no upstream the action would push first, so the push refusal comes first, as in T3.
    await expect(f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'create_pr' })).rejects.toThrow('Cannot push from detached HEAD.')
  }, 40000)
  it('pushes first when needed, writes the pull request from the range and the template, and creates it once', async () => {
    let created = false
    const f = await fixture({ gh: async args => {
      if (args[1] === 'list') return JSON.stringify(created ? [{ number: 34, title: 'Ship the feature', url: 'https://github.com/o/r/pull/34', baseRefName: 'main', headRefName: 'feature', state: 'OPEN' }] : [])
      if (args[1] === 'create') { created = true; return 'https://github.com/o/r/pull/34\n' }
      if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: 'main' } })
      return ''
    } })
    await mkdir(join(f.repo, '.github'))
    await writeFile(join(f.repo, '.github', 'pull_request_template.md'), '## What changed\n<!-- say it -->\n\n## Test plan\n'); commit(f.repo, 'Add the template')
    git(f.repo, 'push', '-q')
    git(f.repo, 'switch', '-q', '-c', 'feature')
    await writeFile(join(f.repo, 'work.txt'), 'feature\n'); commit(f.repo, 'Feature work')
    const result = await f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'create_pr', onProgress: f.onProgress })
    expect(result.push).toEqual({ status: 'pushed', branch: 'feature', upstream: 'origin/feature', setUpstream: true })
    expect(result.pr).toEqual({ status: 'created', head: 'feature', base: 'main', title: 'Ship the feature', url: 'https://github.com/o/r/pull/34', number: 34 })
    expect(result.toast).toEqual({ title: 'Created PR #34', description: 'Ship the feature', cta: { kind: 'open_pr', label: 'View PR', url: 'https://github.com/o/r/pull/34' } })
    const material = f.writePullRequestText.mock.calls[0]![1]
    expect(material.subjects).toEqual(['Feature work'])
    expect(material.stat).toContain('work.txt')
    expect(material.diff).toContain('+feature')
    expect(material.template).toContain('## Test plan')
    const create = f.gh().find(call => call[2] === 'create')!
    expect(create.slice(1, 9)).toEqual(['pr', 'create', '--base', 'main', '--head', 'feature', '--title', 'Ship the feature'])
    expect(create[9]).toBe('--body-file')
    expect(f.gh().filter(call => call[2] === 'create')).toHaveLength(1)
    expect(f.events.find(event => event.kind === 'action_started')).toMatchObject({ stages: ['Pushing to origin...', 'Preparing PR...', 'Generating PR content...', 'Creating pull request...'] })
    expect(f.events.filter(event => event.kind === 'phase_started').map(event => (event as { stage: string }).stage)).toEqual(['Pushing to origin...', 'Preparing PR...', 'Generating PR content...', 'Creating pull request...'])
  }, 40000)
  it('runs one action per folder at a time', async () => {
    const f = await fixture()
    await writeFile(join(f.repo, 'work.txt'), 'second\n')
    const first = f.actions.runStackedAction({ threadId: 't', cwd: f.repo, action: 'commit', commitMessage: 'Second' })
    await expect(f.actions.runStackedAction({ threadId: 'u', cwd: f.repo, action: 'commit', commitMessage: 'Third' })).rejects.toBeInstanceOf(GitActionRefusal)
    await first
  }, 30000)
})

describe('pull, switch, init and publish', () => {
  it('pulls only a fast-forward, refuses a diverged branch in T3\'s words, and says when it is already current', async () => {
    const f = await fixture()
    expect(await f.actions.pull(f.repo)).toEqual({ status: 'skipped_up_to_date', branch: 'main', upstream: 'origin/main' })
    await writeFile(join(f.other, 'other.txt'), 'remote\n'); commit(f.other, 'Remote commit'); git(f.other, 'push', '-q')
    expect(await f.actions.pull(f.repo)).toEqual({ status: 'pulled', branch: 'main', upstream: 'origin/main' })
    expect(await readFile(join(f.repo, 'other.txt'), 'utf8')).toBe('remote\n')
    await writeFile(join(f.other, 'other.txt'), 'remote again\n'); commit(f.other, 'Remote again'); git(f.other, 'push', '-q')
    await writeFile(join(f.repo, 'work.txt'), 'local\n'); commit(f.repo, 'Local')
    await expect(f.actions.pull(f.repo)).rejects.toThrow('Branch has diverged from upstream. Rebase/merge first.')
    expect(git(f.repo, 'log', '-1', '--pretty=%s')).toBe('Local')
    git(f.repo, 'switch', '-q', '-c', 'lonely')
    await expect(f.actions.pull(f.repo)).rejects.toThrow('Current branch has no upstream configured. Push with upstream first.')
    git(f.repo, 'switch', '-q', '--detach')
    await expect(f.actions.pull(f.repo)).rejects.toThrow('Cannot pull from detached HEAD.')
  }, 40000)
  it('switches to a local branch, creates one from HEAD, tracks a remote ref, and lets Git refuse a switch that would lose work', async () => {
    const f = await fixture()
    expect(await f.actions.switchBranch(f.repo, 'topic', { create: true })).toEqual({ branch: 'topic' })
    await expect(f.actions.switchBranch(f.repo, 'topic', { create: true })).rejects.toThrow('already exists')
    expect(await f.actions.switchBranch(f.repo, 'main')).toEqual({ branch: 'main' })
    git(f.other, 'switch', '-q', '-c', 'remote-only'); await writeFile(join(f.other, 'r.txt'), 'r\n'); commit(f.other, 'Remote only'); git(f.other, 'push', '-q', '-u', 'origin', 'remote-only')
    git(f.repo, 'fetch', '-q', 'origin')
    expect(await f.actions.switchBranch(f.repo, 'origin/remote-only')).toEqual({ branch: 'remote-only' })
    expect(git(f.repo, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/remote-only')
    expect(await f.actions.switchBranch(f.repo, 'origin/remote-only')).toEqual({ branch: 'remote-only' }) // the tracking branch is reused
    git(f.repo, 'switch', '-q', 'main')
    await writeFile(join(f.repo, 'r.txt'), 'conflicting\n')
    await expect(f.actions.switchBranch(f.repo, 'remote-only')).rejects.toThrow(/Failed to switch ref\./u)
    expect(git(f.repo, 'branch', '--show-current')).toBe('main')
    expect(await readFile(join(f.repo, 'r.txt'), 'utf8')).toBe('conflicting\n')
    await expect(f.actions.switchBranch(f.repo, '--orphan')).rejects.toThrow('Enter a valid branch name.')
  }, 40000)
  it('initializes a folder once, and publishes a repository to GitHub through gh', async () => {
    const f = await fixture({ remote: false, gh: async args => args[0] === 'repo' && args[1] === 'create' ? '✓ Created repository o/r on GitHub\n  https://github.com/o/r\n' : '' })
    const plain = join(f.root, 'plain'); await mkdir(plain)
    await f.actions.init(plain)
    expect(git(plain, 'rev-parse', '--is-inside-work-tree')).toBe('true')
    await expect(f.actions.init(plain)).rejects.toThrow('already a Git repository')
    await expect(f.actions.publish(f.repo, { repository: 'not a name', visibility: 'private' })).rejects.toThrow('owner/name')
    expect(await f.actions.publish(f.repo, { repository: 'o/r', visibility: 'private' })).toEqual({ url: 'https://github.com/o/r' })
    expect(f.gh().at(-1)!.slice(1)).toEqual(['repo', 'create', 'o/r', '--private', '--source', '.', '--remote', 'origin', '--push'])
  }, 30000)
})

describe('names and stages', () => {
  it('names a feature branch the way T3 does', () => {
    expect(featureBranchName('Add the commit dialog!')).toBe('feature/add-the-commit-dialog')
    expect(featureBranchName('"Quoted" subject')).toBe('feature/quoted-subject')
    expect(featureBranchName('fix/keep-namespace')).toBe('fix/keep-namespace')
    expect(featureBranchName('')).toBe('feature/update')
    expect(featureBranchName('x'.repeat(100)).length).toBeLessThanOrEqual(64)
  })
  it('lists the stages a notice shows, in T3\'s words', () => {
    expect(gitActionStages({ action: 'commit_push_pr', hasMessage: false, hasChanges: true, pushTarget: 'origin', featureBranch: true })).toEqual(['Preparing feature ref...', 'Generating commit message...', 'Committing...', 'Pushing to origin...', 'Preparing PR...', 'Generating PR content...', 'Creating pull request...'])
    expect(gitActionStages({ action: 'commit_push', hasMessage: true, hasChanges: false })).toEqual(['Pushing...'])
    expect(gitActionStages({ action: 'create_pr', hasMessage: false, hasChanges: false, pushBeforePr: false })).toEqual(['Preparing PR...', 'Generating PR content...', 'Creating pull request...'])
  })
})
