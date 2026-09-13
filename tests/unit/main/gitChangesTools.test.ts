// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesService } from '../../../src/main/files/service'
import { GitChangesService } from '../../../src/main/tools/gitChanges'
import type { ToolsResult } from '../../../src/shared/tools'

const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-git-unit-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'); await mkdir(repo)
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Sotto owned test')
  await writeFile(join(repo, 'changed.txt'), 'before\n'); await writeFile(join(repo, 'deleted.txt'), 'delete me\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture')
  const other = join(root, 'other'); git(repo, 'worktree', 'add', '-q', '-b', 'other', other)
  const bindings: Record<string, string> = { a: repo, b: other, shared: repo }
  const files = new FilesService({ resolveBinding: threadId => bindings[threadId] ? { threadId, projectId: 'project', workingDirectory: bindings[threadId]! } : null, copyPath: vi.fn(), reveal: vi.fn() })
  const emit = vi.fn(), copyPath = vi.fn(), reveal = vi.fn()
  const service = new GitChangesService({ files, emit, copyPath, reveal, pollMs: 40 })
  cleanup.push(async () => service.dispose())
  const owner = unwrap(await service.list({ threadId: 'a' })).workspace
  return { root, repo, other, service, target: { threadId: 'a', workspaceId: owner.workspaceId }, emit, copyPath, reveal }
}
describe('Git review in exact thread working directories', () => {
  it('reads changed/new/deleted/binary/large paths and staged plus unstaged changes with two worktrees and deliberate sharing', async () => {
    const f = await fixture()
    await writeFile(join(f.repo, 'changed.txt'), 'staged\n'); git(f.repo, 'add', 'changed.txt')
    await writeFile(join(f.repo, 'changed.txt'), 'after\n'); await rm(join(f.repo, 'deleted.txt'))
    await writeFile(join(f.repo, 'new.txt'), 'new content\n'); await writeFile(join(f.repo, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(f.repo, 'large.txt'), 'x'.repeat(600000))
    const listing = unwrap(await f.service.list(f.target))
    expect(listing.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'changed.txt', status: 'modified', staged: true, unstaged: true }), expect.objectContaining({ path: 'deleted.txt', status: 'deleted' }), expect.objectContaining({ path: 'new.txt', status: 'untracked' })]))
    expect(unwrap(await f.service.diff({ ...f.target, path: 'changed.txt' })).content).toMatchObject({ kind: 'text', patch: expect.stringContaining('+after') })
    expect(unwrap(await f.service.diff({ ...f.target, path: 'deleted.txt' })).content).toMatchObject({ kind: 'text', patch: expect.stringContaining('-delete me') })
    expect(unwrap(await f.service.diff({ ...f.target, path: 'new.txt' })).content).toMatchObject({ kind: 'text', patch: expect.stringContaining('+new content') })
    expect(unwrap(await f.service.diff({ ...f.target, path: 'binary.dat' })).content.kind).toBe('binary')
    expect(unwrap(await f.service.diff({ ...f.target, path: 'large.txt' })).content.kind).toBe('too-large')
    expect(unwrap(await f.service.list({ threadId: 'b' })).files).toEqual([])
    const shared = unwrap(await f.service.list({ threadId: 'shared' }))
    expect(shared.files).toEqual(listing.files); expect(shared.workspace.workspaceId).not.toBe(f.target.workspaceId)
    expect(await f.service.diff({ ...f.target, threadId: 'b', path: 'changed.txt' })).toMatchObject({ ok: false, error: { code: 'workspace-changed' } })
    unwrap(await f.service.copyPath({ ...f.target, path: 'deleted.txt' })); unwrap(await f.service.reveal({ ...f.target, path: 'deleted.txt' }))
    expect(f.copyPath).toHaveBeenCalledWith(join(f.repo, 'deleted.txt')); expect(f.reveal).toHaveBeenCalledWith(f.repo)
  }, 20000)
  it('refreshes content changes without crossing watch identity, handles rename and unavailable repository', async () => {
    const f = await fixture()
    await rename(join(f.repo, 'changed.txt'), join(f.repo, 'renamed.txt')); git(f.repo, 'add', '-A')
    const listing = unwrap(await f.service.list(f.target))
    expect(listing.files[0]).toMatchObject({ status: 'renamed', path: 'renamed.txt', originalPath: 'changed.txt' })
    expect(unwrap(await f.service.diff({ ...f.target, path: 'renamed.txt' })).content.kind).toBe('text')
    unwrap(await f.service.watch({ ...f.target, enabled: true }))
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalled(), { timeout: 6000 })
    const revision = f.emit.mock.calls.at(-1)![0].revision
    await writeFile(join(f.repo, 'renamed.txt'), 'newer contents\n')
    await vi.waitFor(() => expect(f.emit.mock.calls.at(-1)![0].revision).not.toBe(revision), { timeout: 6000 })
    expect(f.emit.mock.calls.every(([event]) => event.threadId === 'a' && event.workspaceId === f.target.workspaceId)).toBe(true)
    unwrap(await f.service.watch({ ...f.target, enabled: false }))
    expect(await f.service.diff({ ...f.target, path: '../secret' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    const unversioned = new GitChangesService({ files: new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: f.root }), copyPath: vi.fn(), reveal: vi.fn() }), copyPath: vi.fn(), reveal: vi.fn(), emit: vi.fn() })
    expect(await unversioned.list({ threadId: 'none' })).toMatchObject({ ok: false, error: { code: 'not-repository' } }); unversioned.dispose()
  }, 20000)
  it('does not expose files reached through directory junctions outside the cwd', async () => {
    const f = await fixture()
    await writeFile(join(f.other, 'secret.txt'), 'never disclose')
    await symlink(f.other, join(f.repo, 'escape'), 'junction')
    const result = await f.service.diff({ ...f.target, path: 'escape/secret.txt' })
    expect(JSON.stringify(result)).not.toContain('never disclose')
  }, 20000)
  it('scopes a project subdirectory and reads new files on an unborn branch', async () => {
    const f = await fixture()
    const nested = join(f.repo, 'nested'); await mkdir(nested)
    await writeFile(join(nested, 'inside.txt'), 'nested text\n')
    await writeFile(join(f.repo, 'outside.txt'), 'outside text\n')
    const nestedService = new GitChangesService({ files: new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: nested }), copyPath: vi.fn(), reveal: vi.fn() }), copyPath: vi.fn(), reveal: vi.fn(), emit: vi.fn() })
    cleanup.push(async () => nestedService.dispose())
    const listing = unwrap(await nestedService.list({ threadId: 'nested' }))
    expect(listing.files.map(file => file.path)).toEqual(['inside.txt'])
    expect(unwrap(await nestedService.diff({ threadId: 'nested', workspaceId: listing.workspace.workspaceId, path: 'inside.txt' })).content).toMatchObject({ kind: 'text', patch: expect.stringContaining('+nested text') })
    const unborn = join(f.root, 'unborn'); await mkdir(unborn); git(unborn, 'init', '-q')
    await writeFile(join(unborn, 'first.txt'), 'first line\n'); git(unborn, 'add', '.')
    const fresh = new GitChangesService({ files: new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: unborn }), copyPath: vi.fn(), reveal: vi.fn() }), copyPath: vi.fn(), reveal: vi.fn(), emit: vi.fn() })
    cleanup.push(async () => fresh.dispose())
    const initial = unwrap(await fresh.list({ threadId: 'fresh' }))
    expect(unwrap(await fresh.diff({ threadId: 'fresh', workspaceId: initial.workspace.workspaceId, path: 'first.txt' })).content).toMatchObject({ kind: 'text', patch: expect.stringContaining('+first line') })
  }, 20000)
})
