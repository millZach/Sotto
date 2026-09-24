// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesService } from '../../../src/main/files/service'
import { GitChangesService } from '../../../src/main/tools/gitChanges'
import { parseNameStatusZ, parseNumstatZ, sectionPath, splitPatch, unquoteGitPath } from '../../../src/main/tools/gitReview'
import type { GitReview } from '../../../src/shared/gitChanges'
import type { ToolsResult } from '../../../src/shared/tools'

const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
const commit = (cwd: string, message: string) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message) }
const file = (review: GitReview, path: string) => review.files.find(item => item.path === path)
const patchOf = (review: GitReview, path: string): string => { const content = file(review, path)?.content; return content?.kind === 'text' ? content.patch : '' }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-git-unit-'))
  // dispose() kills an in-flight Git poll, but Windows releases its cwd handle after process exit.
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repo = join(root, 'repo'); await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Sotto owned test'); git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repo, 'changed.txt'), 'before\n'); await writeFile(join(repo, 'deleted.txt'), 'delete me\n')
  commit(repo, 'fixture')
  const other = join(root, 'other'); git(repo, 'worktree', 'add', '-q', '-b', 'other', other)
  const bindings: Record<string, string> = { a: repo, b: other, shared: repo }
  const files = new FilesService({ resolveBinding: threadId => bindings[threadId] ? { threadId, projectId: 'project', workingDirectory: bindings[threadId]! } : null, copyPath: vi.fn(), reveal: vi.fn() })
  const emit = vi.fn(), copyPath = vi.fn(), reveal = vi.fn()
  const service = new GitChangesService({ files, emit, copyPath, reveal, pollMs: 40 })
  cleanup.push(async () => service.dispose())
  const owner = unwrap(await service.list({ threadId: 'a' })).workspace
  return { root, repo, other, service, target: { threadId: 'a', workspaceId: owner.workspaceId }, emit, copyPath, reveal }
}
function serviceFor(workingDirectory: string) {
  const service = new GitChangesService({ files: new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory }), copyPath: vi.fn(), reveal: vi.fn() }), copyPath: vi.fn(), reveal: vi.fn(), emit: vi.fn() })
  cleanup.push(async () => service.dispose())
  return service
}
/** A comparison asks for the working copy the change list named, as the panel does. */
async function reviewOf(service: GitChangesService, threadId: string, scope: { kind: 'working' } | { kind: 'branch'; base: string | null }) {
  const workspaceId = unwrap(await service.list({ threadId })).workspace.workspaceId
  return service.review({ threadId, workspaceId, scope })
}

describe('Working tree: the working copy against HEAD, untracked files included', () => {
  it('reads changed, new, deleted, binary and large files with their counts, staged or not, in the selected worktree only', async () => {
    const f = await fixture()
    await writeFile(join(f.repo, 'changed.txt'), 'staged\n'); git(f.repo, 'add', 'changed.txt')
    await writeFile(join(f.repo, 'changed.txt'), 'after\nand more\n'); await rm(join(f.repo, 'deleted.txt'))
    await writeFile(join(f.repo, 'new.txt'), 'new content\n'); await writeFile(join(f.repo, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(f.repo, 'large.txt'), 'x'.repeat(600000))
    const indexBefore = git(f.repo, 'ls-files', '--stage')
    const review = unwrap(await f.service.review({ ...f.target, scope: { kind: 'working' } }))
    expect(review.scope).toEqual({ kind: 'working' })
    expect(review.files.map(item => item.path)).toEqual(['binary.dat', 'changed.txt', 'deleted.txt', 'large.txt', 'new.txt'])
    // Staged and unstaged edits are one comparison against HEAD: the reader sees what the commit would hold.
    expect(file(review, 'changed.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 1 })
    expect(patchOf(review, 'changed.txt')).toContain('+after')
    expect(patchOf(review, 'changed.txt')).not.toContain('+staged')
    expect(file(review, 'deleted.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 })
    expect(patchOf(review, 'deleted.txt')).toContain('-delete me')
    expect(file(review, 'new.txt')).toMatchObject({ status: 'untracked', additions: 1, deletions: 0 })
    expect(patchOf(review, 'new.txt')).toContain('+new content')
    expect(file(review, 'binary.dat')).toMatchObject({ status: 'untracked', content: { kind: 'binary' } })
    expect(file(review, 'large.txt')).toMatchObject({ status: 'untracked', additions: null, content: { kind: 'too-large' } })
    // The untracked files joined through a copy of the index; the real one is as it was.
    expect(git(f.repo, 'ls-files', '--stage')).toBe(indexBefore)
    expect(git(f.repo, 'status', '--porcelain', '--', 'new.txt').trim()).toBe('?? new.txt')
    expect(unwrap(await reviewOf(f.service, 'b', { kind: 'working' })).files).toEqual([])
    const shared = unwrap(await f.service.list({ threadId: 'shared' }))
    expect(shared.workspace.workspaceId).not.toBe(f.target.workspaceId)
    expect(await f.service.review({ ...f.target, threadId: 'b', scope: { kind: 'working' } })).toMatchObject({ ok: false, error: { code: 'workspace-changed' } })
    unwrap(await f.service.copyPath({ ...f.target, path: 'deleted.txt' })); unwrap(await f.service.reveal({ ...f.target, path: 'deleted.txt' }))
    expect(f.copyPath).toHaveBeenCalledWith(join(f.repo, 'deleted.txt')); expect(f.reveal).toHaveBeenCalledWith(f.repo)
    expect(await f.service.copyPath({ ...f.target, path: '../outside.txt' })).toMatchObject({ ok: false })
  }, 20000)

  it('hides whitespace-only changes when asked, and keeps the real ones', async () => {
    const f = await fixture()
    await writeFile(join(f.repo, 'changed.txt'), 'before   \n')
    await writeFile(join(f.repo, 'deleted.txt'), 'deleted me\n')
    const all = unwrap(await f.service.review({ ...f.target, scope: { kind: 'working' } }))
    expect(all.files.map(item => item.path)).toEqual(['changed.txt', 'deleted.txt'])
    const quiet = unwrap(await f.service.review({ ...f.target, scope: { kind: 'working' }, ignoreWhitespace: true }))
    expect(quiet.files.map(item => item.path)).toEqual(['deleted.txt'])
  }, 20000)

  it('follows a rename, refreshes on content changes without crossing watch identity, and says when a folder is not a repository', async () => {
    const f = await fixture()
    await rename(join(f.repo, 'changed.txt'), join(f.repo, 'renamed.txt')); git(f.repo, 'add', '-A')
    const review = unwrap(await f.service.review({ ...f.target, scope: { kind: 'working' } }))
    expect(file(review, 'renamed.txt')).toMatchObject({ status: 'renamed', originalPath: 'changed.txt', content: { kind: 'text' } })
    unwrap(await f.service.watch({ ...f.target, enabled: true }))
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalled(), { timeout: 6000 })
    const revision = f.emit.mock.calls.at(-1)![0].revision
    await writeFile(join(f.repo, 'renamed.txt'), 'newer contents\n')
    await vi.waitFor(() => expect(f.emit.mock.calls.at(-1)![0].revision).not.toBe(revision), { timeout: 6000 })
    expect(f.emit.mock.calls.every(([event]) => event.threadId === 'a' && event.workspaceId === f.target.workspaceId)).toBe(true)
    unwrap(await f.service.watch({ ...f.target, enabled: false }))
    expect(await f.service.review({ ...f.target, scope: { kind: 'branch', base: '--output=x' } })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(await serviceFor(f.root).list({ threadId: 'none' })).toMatchObject({ ok: false, error: { code: 'not-repository' } })
  }, 20000)

  it('does not expose files reached through directory junctions outside the cwd', async () => {
    const f = await fixture()
    await writeFile(join(f.other, 'secret.txt'), 'never disclose')
    await symlink(f.other, join(f.repo, 'escape'), 'junction')
    const result = await f.service.review({ ...f.target, scope: { kind: 'working' } })
    expect(JSON.stringify(result)).not.toContain('never disclose')
  }, 20000)

  it('scopes a project subdirectory and reads new files on an unborn branch', async () => {
    const f = await fixture()
    const nested = join(f.repo, 'nested'); await mkdir(nested)
    await writeFile(join(nested, 'inside.txt'), 'nested text\n')
    await writeFile(join(f.repo, 'outside.txt'), 'outside text\n')
    const nestedReview = unwrap(await reviewOf(serviceFor(nested), 'nested', { kind: 'working' }))
    expect(nestedReview.files.map(item => item.path)).toEqual(['inside.txt'])
    expect(patchOf(nestedReview, 'inside.txt')).toContain('+nested text')
    const unborn = join(f.root, 'unborn'); await mkdir(unborn); git(unborn, 'init', '-q')
    await writeFile(join(unborn, 'first.txt'), 'first line\n'); git(unborn, 'add', '.')
    await writeFile(join(unborn, 'second.txt'), 'second line\n')
    const fresh = unwrap(await reviewOf(serviceFor(unborn), 'fresh', { kind: 'working' }))
    expect(fresh.files.map(item => [item.path, item.status])).toEqual([['first.txt', 'added'], ['second.txt', 'untracked']])
    expect(patchOf(fresh, 'first.txt')).toContain('+first line')
    expect(patchOf(fresh, 'second.txt')).toContain('+second line')
    expect(await reviewOf(serviceFor(unborn), 'fresh', { kind: 'branch', base: null })).toMatchObject({ ok: false, error: { code: 'blocked', message: expect.stringContaining('no commits yet') } })
  }, 20000)
})

describe('Branch changes: base...HEAD', () => {
  it('compares against the automatic base, a chosen one, and the remote copy when there is one', async () => {
    const f = await fixture()
    git(f.repo, 'switch', '-q', '-c', 'feature/trail')
    await writeFile(join(f.repo, 'trail.txt'), 'a trail\n'); commit(f.repo, 'Add a trail')
    git(f.repo, 'switch', '-q', 'main')
    await writeFile(join(f.repo, 'changed.txt'), 'main moved on\n'); commit(f.repo, 'Main moves')
    git(f.repo, 'switch', '-q', 'feature/trail')
    await writeFile(join(f.repo, 'uncommitted.txt'), 'not in the branch\n')

    const automatic = unwrap(await f.service.review({ ...f.target, scope: { kind: 'branch', base: null } }))
    expect(automatic.scope).toEqual({ kind: 'branch', base: 'main', automatic: true, head: 'feature/trail' })
    // The merge-base diff: what the branch added, not what main did since, and nothing uncommitted.
    expect(automatic.files.map(item => [item.path, item.status, item.additions])).toEqual([['trail.txt', 'added', 1]])

    const chosen = unwrap(await f.service.review({ ...f.target, scope: { kind: 'branch', base: 'other' } }))
    expect(chosen.scope).toMatchObject({ base: 'other', automatic: false })
    expect(chosen.files.map(item => item.path)).toEqual(['trail.txt'])
    expect(await f.service.review({ ...f.target, scope: { kind: 'branch', base: 'no-such-branch' } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('no-such-branch is not a branch') } })

    const remote = join(f.root, 'remote.git'); git(f.root, 'init', '-q', '--bare', remote)
    git(f.repo, 'remote', 'add', 'origin', remote); git(f.repo, 'push', '-q', 'origin', 'main')
    git(f.repo, 'remote', 'set-head', 'origin', 'main')
    expect(unwrap(await f.service.review({ ...f.target, scope: { kind: 'branch', base: null } })).scope).toMatchObject({ base: 'origin/main', automatic: true })
    git(f.repo, 'config', 'branch.feature/trail.gh-merge-base', 'other')
    expect(unwrap(await f.service.review({ ...f.target, scope: { kind: 'branch', base: null } })).scope).toMatchObject({ base: 'other' })

    git(f.repo, 'switch', '-q', '--detach')
    expect(await f.service.review({ ...f.target, scope: { kind: 'branch', base: null } })).toMatchObject({ ok: false, error: { code: 'blocked', message: expect.stringContaining('detached HEAD') } })
  }, 30000)

  it('answers with no base when the repository has nothing to compare against', async () => {
    const f = await fixture()
    git(f.repo, 'branch', '-m', 'main', 'trunk')
    const review = unwrap(await f.service.review({ ...f.target, scope: { kind: 'branch', base: null } }))
    expect(review).toMatchObject({ scope: { kind: 'branch', base: null, automatic: true, head: 'trunk' }, files: [] })
  }, 20000)
})

describe('reading what git diff prints', () => {
  it('reads counts and statuses, renames included, with NUL separators', () => {
    expect(parseNumstatZ('1\t2\ta.txt\0-\t-\tlogo.png\0' + '3\t0\t\0old.ts\0new.ts\0')).toEqual([
      { path: 'a.txt', additions: 1, deletions: 2 }, { path: 'logo.png', additions: null, deletions: null },
      { path: 'new.ts', originalPath: 'old.ts', additions: 3, deletions: 0 },
    ])
    expect(parseNameStatusZ('M\0a.txt\0R087\0old.ts\0new.ts\0D\0gone.md\0U\0both.txt\0')).toEqual([
      { path: 'a.txt', status: 'modified' }, { path: 'new.ts', originalPath: 'old.ts', status: 'renamed' },
      { path: 'gone.md', status: 'deleted' }, { path: 'both.txt', status: 'conflicted' },
    ])
  })

  it('finds each section’s file, quoted, deleted, binary or renamed', () => {
    const patch = [
      'diff --git a/src/app.ts b/src/app.ts', 'index 1..2 100644', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/gone.md b/gone.md', 'deleted file mode 100644', '--- a/gone.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
      'diff --git "a/tab\\there.txt" "b/tab\\there.txt"', '--- "a/tab\\there.txt"', '+++ "b/tab\\there.txt"', '@@ -1 +1 @@', '-y', '+z',
      'diff --git a/logo png.png b/logo png.png', 'new file mode 100644', 'Binary files /dev/null and b/logo png.png differ',
      'diff --git a/old.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts', '',
    ].join('\n')
    expect(splitPatch(patch).map(sectionPath)).toEqual(['src/app.ts', 'gone.md', 'tab\there.txt', 'logo png.png', 'new.ts'])
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe('café.txt')
  })
})
