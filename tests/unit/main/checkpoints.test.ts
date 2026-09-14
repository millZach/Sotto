// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilesService } from '../../../src/main/files/service'
import { CheckpointService } from '../../../src/main/tools/checkpoints'
import type { CheckpointDependencies, CheckpointThread } from '../../../src/main/tools/checkpointTypes'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-unit-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repo = join(root, 'repo'); await mkdir(repo)
  git(repo, 'init', '-q'); git(repo, 'config', 'core.autocrlf', 'false'); git(repo, 'config', 'user.name', 'Sotto checkpoint fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'app.txt'), 'before\n'); await writeFile(join(repo, 'notes.txt'), 'original notes\n')
  git(repo, 'add', '.'); git(repo, '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Fixture')
  const state: CheckpointThread = { threadId: 'thread-a', providerId: 'codex', bindingId: 'native-a', userMessageIds: [], busy: false, running: false, rollbackSupported: true }
  const second: CheckpointThread = { ...state, threadId: 'thread-b', bindingId: 'native-b', userMessageIds: [] }
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'project', workingDirectory: repo }), copyPath: vi.fn(), reveal: vi.fn() })
  const rollback = vi.fn<CheckpointDependencies['rollback']>(async (_id, count, expected) => { state.userMessageIds = expected.slice(0, -count); return { accepted: true } })
  const refresh = vi.fn(async () => undefined)
  const dependencies: CheckpointDependencies = { files, directory: join(root, 'checkpoints'), resolveThread: async id => id === state.threadId ? { ...state } : id === second.threadId ? { ...second } : null, rollback, refresh }
  const service = new CheckpointService(dependencies); cleanup.push(async () => service.dispose())
  const owner = unwrap(await files.resolveWorkspace(state.threadId))
  const target = { threadId: state.threadId, workspaceId: owner.workspaceId }
  const complete = async () => {
    await service.beforeTurn(state.threadId)
    await writeFile(join(repo, 'app.txt'), 'after\n')
    await writeFile(join(repo, 'new.txt'), 'new file\n')
    state.userMessageIds = ['user-1']
    await service.afterTurn(state.threadId)
    const checkpoint = unwrap(await service.checkpoints(target)).checkpoints[0]!
    return { ...target, checkpointId: checkpoint.id }
  }
  return { root, repo, state, second, dependencies, service, target, complete, rollback, refresh }
}

describe('completed native turn checkpoints', () => {
  it('never attributes edits made while Sotto was closed to a turn whose completion snapshot was interrupted', async () => {
    const f = await fixture()
    await f.service.beforeTurn('thread-a')
    await writeFile(join(f.repo, 'app.txt'), 'native turn edit\n')
    f.state.userMessageIds = ['user-1']
    f.service.dispose()
    await writeFile(join(f.repo, 'notes.txt'), 'unrelated offline edit\n')
    const restarted = new CheckpointService(f.dependencies); cleanup.push(async () => restarted.dispose())
    await restarted.initialize()
    const checkpoint = unwrap(await restarted.checkpoints(f.target)).checkpoints[0]!
    expect(checkpoint).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('interrupted') })
    expect(await restarted.revertCheckpoint({ ...f.target, checkpointId: checkpoint.id, confirmed: true })).toMatchObject({ ok: false })
    expect(f.rollback).not.toHaveBeenCalled()
    expect(await readFile(join(f.repo, 'notes.txt'), 'utf8')).toBe('unrelated offline edit\n')
  }, 20000)
  it('fails closed when recovery storage is corrupt instead of silently forgetting an unfinished revert', async () => {
    const f = await fixture(), request = await f.complete()
    f.rollback.mockResolvedValue({ accepted: false, uncertain: true })
    unwrap(await f.service.revertCheckpoint({ ...request, confirmed: true }))
    f.service.dispose()
    await writeFile(join(f.dependencies.directory, 'checkpoints.json'), '{"truncated":')
    const restarted = new CheckpointService(f.dependencies); cleanup.push(async () => restarted.dispose())
    await expect(restarted.initialize()).rejects.toThrow('corrupt')
    restarted.dispose()
    const again = new CheckpointService(f.dependencies); cleanup.push(async () => again.dispose())
    await expect(again.initialize()).rejects.toThrow('corrupt')
  }, 20000)
  it('refuses checkpoint attribution when two threads overlap in the same working copy', async () => {
    const f = await fixture()
    await f.service.beforeTurn('thread-a'); f.state.running = true
    await writeFile(join(f.repo, 'app.txt'), 'thread a\n')
    await f.service.beforeTurn('thread-b'); f.second.running = true
    await writeFile(join(f.repo, 'notes.txt'), 'thread b\n')
    f.state.running = false; f.state.userMessageIds = ['user-a']; await f.service.afterTurn('thread-a')
    f.second.running = false; f.second.userMessageIds = ['user-b']; await f.service.afterTurn('thread-b')
    const checkpoint = unwrap(await f.service.checkpoints(f.target)).checkpoints[0]!
    expect(checkpoint).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('overlapped') })
    expect(await f.service.revertCheckpoint({ ...f.target, checkpointId: checkpoint.id, confirmed: true })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    expect(f.rollback).not.toHaveBeenCalled()
    expect(await readFile(join(f.repo, 'notes.txt'), 'utf8')).toBe('thread b\n')
  }, 20000)
  it('keeps file inspection available for Grok while refusing a file-only conversation rewind', async () => {
    const f = await fixture()
    f.state.providerId = 'grok'; f.state.rollbackSupported = false; f.state.unsupportedReason = 'Grok ACP does not support native conversation rollback.'
    const request = await f.complete()
    const review = unwrap(await f.service.inspectCheckpoint(request))
    expect(review.checkpoint).toMatchObject({ supported: false, reason: expect.stringContaining('Grok ACP') })
    expect(review.patches).toHaveLength(2)
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    expect(f.rollback).not.toHaveBeenCalled()
    expect(await readFile(join(f.repo, 'app.txt'), 'utf8')).toBe('after\n')
  }, 20000)
  it('guards pending work, later file edits, staging and changed native history before any rollback', async () => {
    const f = await fixture(), request = await f.complete()
    f.state.busy = true
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false, error: { code: 'blocked' } })
    f.state.busy = false
    await writeFile(join(f.repo, 'app.txt'), 'later independent edit\n')
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false, error: { message: expect.stringContaining('Later edits') } })
    await writeFile(join(f.repo, 'app.txt'), 'after\n'); git(f.repo, 'add', 'app.txt')
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false, error: { message: expect.stringContaining('staging changed') } })
    git(f.repo, 'reset', '-q', 'HEAD', '--', 'app.txt')
    f.state.userMessageIds.push('external-user-message')
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false, error: { message: expect.stringContaining('unchanged native history') } })
    expect(f.rollback).not.toHaveBeenCalled()
    expect(await readFile(join(f.repo, 'app.txt'), 'utf8')).toBe('after\n')
  }, 20000)
  it('holds an uncertain native outcome, blocks new work, and never retries the native mutation during recovery', async () => {
    const f = await fixture(), request = await f.complete()
    f.rollback.mockResolvedValue({ accepted: false, uncertain: true })
    expect(unwrap(await f.service.revertCheckpoint({ ...request, confirmed: true })).status).toBe('uncertain')
    expect(await f.service.isWorkspaceBlocked('thread-b')).toBe(true)
    await expect(f.service.beforeTurn('thread-a')).rejects.toThrow('interrupted checkpoint')
    expect(await f.service.recoverCheckpoint(request)).toMatchObject({ ok: false, error: { code: 'blocked' } })
    expect(f.rollback).toHaveBeenCalledTimes(1)
    expect(await readFile(join(f.repo, 'app.txt'), 'utf8')).toBe('after\n')
    f.state.userMessageIds = []
    expect(unwrap(await f.service.recoverCheckpoint(request)).status).toBe('reverted')
    expect(f.rollback).toHaveBeenCalledTimes(1)
  }, 20000)
  it('recovers a restart after native rollback without sending rollback twice', async () => {
    const f = await fixture(), request = await f.complete()
    f.refresh.mockRejectedValueOnce(new Error('process interrupted after native acceptance'))
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false })
    expect(await readFile(join(f.repo, 'app.txt'), 'utf8')).toBe('after\n')
    expect(f.state.userMessageIds).toEqual([])
    f.service.dispose()
    const restarted = new CheckpointService(f.dependencies); cleanup.push(async () => restarted.dispose())
    await restarted.initialize()
    expect(restarted.isBlocked('thread-a')).toBe(true)
    expect(unwrap(await restarted.checkpoints(f.target)).checkpoints[0]?.status).toBe('uncertain')
    expect(unwrap(await restarted.recoverCheckpoint(request)).status).toBe('reverted')
    expect(f.rollback).toHaveBeenCalledTimes(1)
    expect(await readFile(join(f.repo, 'app.txt'), 'utf8')).toBe('before\n')
    expect(restarted.isBlocked('thread-a')).toBe(false)
  }, 20000)
  it('reviews exact before/after files and rewinds native history while preserving unrelated later edits', async () => {
    const f = await fixture(), request = await f.complete()
    const inspection = unwrap(await f.service.inspectCheckpoint(request))
    expect(inspection.checkpoint).toMatchObject({ threadId: 'thread-a', status: 'ready', supported: true, files: [{ path: 'app.txt', change: 'modified' }, { path: 'new.txt', change: 'added' }] })
    expect(inspection.patches[0]).toEqual({ path: 'app.txt', before: 'before\n', after: 'after\n', binary: false })
    await writeFile(join(f.repo, 'notes.txt'), 'my unrelated edit\n')
    expect(unwrap(await f.service.revertCheckpoint({ ...request, confirmed: true })).status).toBe('reverted')
    expect(f.rollback).toHaveBeenCalledExactlyOnceWith('thread-a', 1, ['user-1'])
    expect(await readFile(join(f.repo, 'app.txt'), 'utf8')).toBe('before\n')
    expect(await readFile(join(f.repo, 'notes.txt'), 'utf8')).toBe('my unrelated edit\n')
    await expect(readFile(join(f.repo, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.state.userMessageIds).toEqual([])
  }, 20000)
})
