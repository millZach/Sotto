// @vitest-environment node
import * as fsPromises from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilesService } from '../../../src/main/files/service'
import { CheckoutMutations } from '../../../src/main/agents/checkoutMutations'
import { CheckpointService } from '../../../src/main/tools/checkpoints'
import type { CheckpointDependencies, CheckpointThread } from '../../../src/main/tools/checkpointTypes'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual }
})

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
  it('does not let an inaccessible legacy recovery record block an unrelated checkout', async () => {
    const f = await fixture(), target = await f.complete()
    const internals = f.service as unknown as { records: Map<string, { cwd: string; status: string; threadId: string; checkout?: string }> }
    const inaccessible = join(f.root, 'inaccessible')
    const legacy = { ...internals.records.get(target.checkpointId)!, threadId: f.second.threadId, cwd: inaccessible, status: 'uncertain' }
    delete legacy.checkout
    internals.records.set('legacy', legacy)
    const actual = fsPromises.realpath
    const spy = vi.spyOn(fsPromises, 'realpath').mockImplementation((...args) => args[0] === inaccessible
      ? Promise.reject(Object.assign(new Error('Unavailable folder'), { code: 'EACCES' })) : actual(...args))
    try { expect(await f.service.isWorkspaceBlocked(f.state.threadId)).toBe(false) }
    finally { spy.mockRestore() }
  })
  it('blocks a sibling subdirectory while checkout recovery remains uncertain', async () => {
    const f = await fixture(), target = await f.complete()
    const nested = join(f.repo, 'nested'); await mkdir(nested)
    f.dependencies.files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'project', workingDirectory: threadId === f.second.threadId ? nested : f.repo }), copyPath: vi.fn(), reveal: vi.fn() })
    f.dependencies.rollback = async () => ({ accepted: false, uncertain: true })
    expect(unwrap(await f.service.revertCheckpoint({ ...target, confirmed: true })).status).toBe('uncertain')
    expect(await f.service.isWorkspaceBlocked(f.second.threadId)).toBe(true)
  })
  it('checks recovery in a proposed destination before an unallocated draft has a file binding', async () => {
    const f = await fixture(), target = await f.complete()
    f.dependencies.rollback = async () => ({ accepted: false, uncertain: true })
    expect(unwrap(await f.service.revertCheckpoint({ ...target, confirmed: true })).status).toBe('uncertain')
    const unrelated = join(f.root, 'unrelated'); await mkdir(unrelated)
    git(unrelated, 'init', '-q')
    f.dependencies.files = new FilesService({ resolveBinding: () => null, copyPath: vi.fn(), reveal: vi.fn() })
    expect(await f.service.isWorkspaceBlocked('draft', f.repo)).toBe(true)
    expect(await f.service.isWorkspaceBlocked('draft', unrelated)).toBe(false)
  })
  it('reserves the checkout before checking revert files', async () => {
    const f = await fixture(), target = await f.complete(), mutations = new CheckoutMutations()
    f.dependencies.acquireMutation = () => mutations.acquire(f.repo, 'mutation')
    const internals = f.service as unknown as { checkFiles(...args: unknown[]): Promise<void> }
    const original = internals.checkFiles.bind(internals)
    let release!: () => void, enter!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { enter = resolve })
    vi.spyOn(internals, 'checkFiles').mockImplementation(async (...args) => { enter(); await paused; await original(...args) })
    const revert = f.service.revertCheckpoint({ ...target, confirmed: true })
    try { await entered; await expect(mutations.acquire(f.repo, 'send')).rejects.toThrow('Your message was not sent') }
    finally { release() }
    expect(unwrap(await revert).status).toBe('reverted')
  })
  it('holds the checkout across interrupted revert recovery', async () => {
    const f = await fixture(), target = await f.complete(), mutations = new CheckoutMutations()
    f.dependencies.rollback = async () => ({ accepted: false, uncertain: true })
    expect(unwrap(await f.service.revertCheckpoint({ ...target, confirmed: true })).status).toBe('uncertain')
    f.state.userMessageIds = []
    f.dependencies.acquireMutation = () => mutations.acquire(f.repo, 'mutation')
    let release!: () => void, enter!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { enter = resolve })
    f.dependencies.refresh = async () => { enter(); await paused }
    const recovery = f.service.recoverCheckpoint(target)
    try { await entered; await expect(mutations.acquire(f.repo, 'send')).rejects.toThrow('Your message was not sent') }
    finally { release() }
    expect(unwrap(await recovery).status).toBe('reverted')
    expect(await mutations.isMutating(f.repo)).toBe(false)
  })
  it('holds the checkout across rollback and releases it after reverting', async () => {
    const f = await fixture(), target = await f.complete(), mutations = new CheckoutMutations()
    f.dependencies.acquireMutation = () => mutations.acquire(f.repo, 'mutation')
    const rollback = f.dependencies.rollback
    let release!: () => void, enter!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { enter = resolve })
    f.dependencies.rollback = async (...args) => { enter(); await paused; return rollback(...args) }
    const revert = f.service.revertCheckpoint({ ...target, confirmed: true })
    try {
      await entered
      await expect(mutations.acquire(f.repo, 'send')).rejects.toThrow('Your message was not sent')
      await expect(mutations.acquire(f.repo, 'mutation')).rejects.toThrow('Wait for')
    } finally { release() }
    expect(unwrap(await revert).status).toBe('reverted')
    expect(await mutations.isMutating(f.repo)).toBe(false)
  })
  it('refuses a concurrent Git action on the thread lane and completes the revert', async () => {
    const f = await fixture(), request = await f.complete()
    await f.service.initialize()
    let lane: Promise<unknown> = Promise.resolve()
    const onLane = <T>(work: () => Promise<T>): Promise<T> => {
      const next = lane.then(work, work); lane = next.catch(() => undefined); return next
    }
    let release!: () => void, checking!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { checking = resolve })
    const internals = f.service as unknown as { checkFiles: (...args: unknown[]) => Promise<void> }
    const checkFiles = internals.checkFiles.bind(f.service)
    vi.spyOn(internals, 'checkFiles').mockImplementationOnce(async (...args) => { checking(); await paused; await checkFiles(...args) })
    const rollback = f.dependencies.rollback
    f.dependencies.rollback = (...args) => onLane(() => rollback(...args))
    const revert = f.service.revertCheckpoint({ ...request, confirmed: true })
    await entered
    const gitAction = onLane(async () => {
      await f.service.initialize()
      if (await f.service.isWorkspaceBlocked('thread-a')) return 'refused'
      git(f.repo, 'status', '--porcelain'); return 'accepted'
    })
    // Start the action while validation holds the checkpoint queue.
    release()
    expect(await gitAction).toBe('refused')
    expect(unwrap(await revert).status).toBe('reverted')
  })
  it.each(['backup stat', 'storage listing', 'blob listing', 'blob stat'])('keeps sends working when %s cleanup fails', async failure => {
    const f = await fixture(); await f.complete()
    const backup = join(f.dependencies.directory, 'checkpoints.json.corrupt-fixture')
    await writeFile(backup, 'backup')
    const report = vi.fn(); f.dependencies.report = report
    const actualStat = fsPromises.lstat, actualRead = fsPromises.readdir
    const stat = vi.spyOn(fsPromises, 'lstat').mockImplementation((...args) => {
      if (failure === 'backup stat' && args[0] === backup || failure === 'blob stat' && args[0] === join(f.dependencies.directory, 'blobs')) return Promise.reject(Object.assign(new Error('private path'), { code: 'EACCES' }))
      return actualStat(...args)
    })
    const listing = vi.spyOn(fsPromises, 'readdir').mockImplementation((...args) => {
      if (failure === 'storage listing' && args[0] === f.dependencies.directory || failure === 'blob listing' && args[0] === join(f.dependencies.directory, 'blobs')) return Promise.reject(Object.assign(new Error('private path'), { code: 'EACCES' }))
      return actualRead(...args)
    })
    try {
      await expect(f.service.beforeTurn('thread-a')).resolves.toBeUndefined()
      expect(report).toHaveBeenCalledWith('checkpoint-cleanup-failed')
      expect(await readFile(backup, 'utf8')).toBe('backup')
    } finally { stat.mockRestore(); listing.mockRestore() }
  })
  it.each(['EBUSY', 'EPERM'])('retries %s blob removal and keeps sends working after cleanup fails', async code => {
    const f = await fixture(); await f.complete()
    const orphan = join(f.dependencies.directory, 'blobs', 'f'.repeat(64))
    await writeFile(orphan, 'orphan')
    const realUnlink = fsPromises.unlink
    const report = vi.fn(); f.dependencies.report = report
    const remove = vi.spyOn(fsPromises, 'unlink').mockImplementation(async path => {
      if (path === orphan) throw Object.assign(new Error('private path'), { code })
      await realUnlink(path)
    })
    try {
      await expect(f.service.beforeTurn('thread-a')).resolves.toBeUndefined()
      expect(remove.mock.calls.filter(([path]) => path === orphan)).toHaveLength(3)
      expect(report).toHaveBeenCalledWith('checkpoint-cleanup-failed')
    } finally { remove.mockRestore() }
  })
  it.each(['age', 'size', 'history off', 'forget thread'])('keeps unfinished revert guards and blobs through %s cleanup', async limit => {
    const f = await fixture(), request = await f.complete()
    f.refresh.mockRejectedValueOnce(new Error('interrupted after native acceptance'))
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false })
    const blobs = (await readdir(join(f.dependencies.directory, 'blobs'))).sort()
    if (limit === 'age') f.dependencies.now = () => Date.now() + 31 * 24 * 60 * 60 * 1000
    if (limit === 'size') f.dependencies.maxBytes = 1
    if (limit === 'history off') f.dependencies.historyEnabled = () => false
    if (limit === 'forget thread') await f.service.forgetThread('thread-a')
    else await f.service.privacyChanged()
    const restarted = new CheckpointService(f.dependencies); cleanup.push(async () => restarted.dispose())
    await restarted.initialize()
    expect(await restarted.isWorkspaceBlocked('thread-b')).toBe(true)
    await expect(restarted.beforeTurn('thread-a')).rejects.toThrow('interrupted checkpoint')
    expect((await readdir(join(f.dependencies.directory, 'blobs'))).sort()).toEqual(blobs)
    expect(unwrap(await restarted.recoverCheckpoint(request)).status).toBe('reverted')
    expect(f.rollback).toHaveBeenCalledTimes(1)
  })
  it('keeps a reverting checkpoint record and its blobs when its thread is forgotten', async () => {
    const f = await fixture(); await f.complete()
    const path = join(f.dependencies.directory, 'checkpoints.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.records[0].status = 'reverting'
    await writeFile(path, JSON.stringify(saved))
    const restarted = new CheckpointService(f.dependencies); cleanup.push(async () => restarted.dispose())
    await restarted.initialize()
    const blobs = (await readdir(join(f.dependencies.directory, 'blobs'))).sort()
    await restarted.forgetThread('thread-a')
    expect(await restarted.isWorkspaceBlocked('thread-b')).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).records[0].status).toBe('reverting')
    expect((await readdir(join(f.dependencies.directory, 'blobs'))).sort()).toEqual(blobs)
  })
  it('never cleans through a blob directory junction or removes non-blob entries', async () => {
    const f = await fixture(); await f.complete()
    const directory = join(f.dependencies.directory, 'blobs'), external = join(f.root, 'external')
    await writeFile(join(directory, 'keep.txt'), 'keep')
    await mkdir(join(directory, 'a'.repeat(64)))
    await f.service.privacyChanged()
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep')
    await rename(directory, external)
    await symlink(external, directory, 'junction')
    f.dependencies.historyEnabled = () => false
    await f.service.privacyChanged()
    expect(await readdir(external)).toContain('keep.txt')
    expect((await readdir(external)).filter(name => /^[a-f0-9]{64}$/.test(name)).length).toBeGreaterThan(1)
  })
  it('deletes forgotten checkpoints and shared blobs only after their last reference goes', async () => {
    const f = await fixture()
    await f.complete(); await f.service.beforeTurn('thread-b')
    await f.service.forgetThread('thread-a')
    expect(unwrap(await f.service.checkpoints(f.target)).checkpoints).toEqual([])
    expect((await readdir(join(f.dependencies.directory, 'blobs'))).length).toBeGreaterThan(0)
    await f.service.forgetThread('thread-b')
    expect(await readdir(join(f.dependencies.directory, 'blobs'))).toEqual([])
  })
  it('writes a backup deleted outside Sotto again once a save has seen it gone', async () => {
    const f = await fixture()
    // The clock a minute ahead of the files, so no file is too recent to reuse its hash.
    f.dependencies.now = () => Date.now() + 60_000
    await f.complete()
    const blobs = join(f.dependencies.directory, 'blobs')
    for (const name of await readdir(blobs)) await rm(join(blobs, name))
    // This send's capture still trusts the backups; its save sees they are gone.
    await f.service.beforeTurn(f.state.threadId)
    f.state.userMessageIds = ['user-1', 'user-2']
    // So the capture that completes the turn writes them again.
    await f.service.afterTurn(f.state.threadId)
    expect((await readdir(blobs)).length).toBeGreaterThan(0)
  })
  it('evicts the oldest checkpoint first when newer snapshots exceed the byte budget', async () => {
    const f = await fixture(); let now = Date.now(); f.dependencies.now = () => now
    const first = await f.complete(); now++
    await f.service.beforeTurn('thread-a')
    await writeFile(join(f.repo, 'app.txt'), 'newer snapshot contents\n')
    f.state.userMessageIds.push('user-2'); await f.service.afterTurn('thread-a')
    const directory = join(f.dependencies.directory, 'blobs')
    const bytes = (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name))))).reduce((total, data) => total + data.length, 0)
    f.dependencies.maxBytes = bytes + (await readFile(join(f.dependencies.directory, 'checkpoints.json'))).length - 1
    await f.service.privacyChanged()
    const records = unwrap(await f.service.checkpoints(f.target)).checkpoints
    expect(records).toHaveLength(1)
    expect(records[0]!.id).not.toBe(first.checkpointId)
    expect(unwrap(await f.service.inspectCheckpoint({ ...f.target, checkpointId: records[0]!.id })).patches[0]!.after).toBe('newer snapshot contents\n')
  })
  it('erases checkpoints when history is off and writes no new file snapshots', async () => {
    const f = await fixture(); let enabled = true
    f.dependencies.historyEnabled = () => enabled
    await f.complete(); enabled = false; await f.service.privacyChanged()
    await f.service.beforeTurn('thread-a')
    expect(unwrap(await f.service.checkpoints(f.target)).checkpoints).toEqual([])
    expect(await readdir(join(f.dependencies.directory, 'blobs'))).toEqual([])
    const restarted = new CheckpointService(f.dependencies); await restarted.initialize(); restarted.dispose()
    expect(await readdir(join(f.dependencies.directory, 'blobs'))).toEqual([])
  })
  it('prunes expired records and evicts oldest records to fit the shared blob budget', async () => {
    const f = await fixture(); let now = Date.now()
    f.dependencies.now = () => now
    await f.complete()
    now += 31 * 24 * 60 * 60 * 1000
    await f.service.privacyChanged()
    expect(unwrap(await f.service.checkpoints(f.target)).checkpoints).toEqual([])
    expect(await readdir(join(f.dependencies.directory, 'blobs'))).toEqual([])
    await f.service.beforeTurn('thread-a')
    f.dependencies.maxBytes = 0
    await f.service.privacyChanged()
    expect(await readdir(join(f.dependencies.directory, 'blobs'))).toEqual([])
  })

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
  it('retries a failed load once access to the named storage file is restored', async () => {
    const f = await fixture(), path = join(f.dependencies.directory, 'checkpoints.json')
    await mkdir(path, { recursive: true })
    const restarted = new CheckpointService(f.dependencies); cleanup.push(async () => restarted.dispose())
    await expect(restarted.initialize()).rejects.toThrow(path)
    await rm(path, { recursive: true }); await writeFile(path, '[]')
    await restarted.initialize(); await restarted.beforeTurn('thread-a')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 2 })
  })
  it('refuses an expired checkpoint before calling native rollback between hourly sweeps', async () => {
    const f = await fixture(); let now = Date.now(); f.dependencies.now = () => now
    const request = await f.complete()
    now += 31 * 24 * 60 * 60 * 1000
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false })
    expect(f.rollback).not.toHaveBeenCalled()
    expect(await readFile(join(f.repo, 'app.txt'), 'utf8')).toBe('after\n')
  })
  it('never rolls back native history if retention expires while checking a revert', async () => {
    const f = await fixture(), now = Date.now(); f.dependencies.now = () => now
    const request = await f.complete(); let saves = 0
    f.dependencies.now = () => ++saves === 1 ? now : now + 31 * 24 * 60 * 60 * 1000
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false, error: { message: expect.stringContaining('No rollback was sent') } })
    expect(f.rollback).not.toHaveBeenCalled()
    expect(await readFile(join(f.repo, 'app.txt'), 'utf8')).toBe('after\n')
  })
  it('expires idle checkpoints on the hourly sweep without another turn or restart', async () => {
    const f = await fixture(); let now = Date.now(); f.dependencies.now = () => now
    await f.complete()
    vi.useFakeTimers()
    const restarted = new CheckpointService(f.dependencies)
    try {
      await restarted.initialize()
      const sweep = vi.spyOn(restarted, 'privacyChanged')
      now += 31 * 24 * 60 * 60 * 1000
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(sweep).toHaveBeenCalledOnce()
      await sweep.mock.results[0]!.value
      expect(unwrap(await restarted.checkpoints(f.target)).checkpoints).toEqual([])
      expect(await readdir(join(f.dependencies.directory, 'blobs'))).toEqual([])
    } finally { restarted.dispose(); vi.useRealTimers() }
  })
  it('backs up damaged JSON and keeps readable recovery records without blocking unrelated sends', async () => {
    const f = await fixture(), request = await f.complete()
    f.rollback.mockResolvedValue({ accepted: false, uncertain: true })
    unwrap(await f.service.revertCheckpoint({ ...request, confirmed: true }))
    const path = join(f.dependencies.directory, 'checkpoints.json')
    const saved = JSON.parse(await readFile(path, 'utf8')) as { version: number; records: unknown[] }
    const damaged = JSON.stringify({ version: 1, records: [...saved.records, { bad: 'record' }] })
    await writeFile(path, damaged)
    const report = vi.fn(); f.dependencies.report = report
    const restarted = new CheckpointService(f.dependencies); cleanup.push(async () => restarted.dispose())
    await restarted.initialize()
    expect(restarted.isBlocked('thread-a')).toBe(true)
    const backup = (await readdir(f.dependencies.directory)).find(name => name.startsWith('checkpoints.json.corrupt-'))!
    expect(await readFile(join(f.dependencies.directory, backup), 'utf8')).toBe(damaged)
    expect(report).toHaveBeenCalledWith(`Sotto set aside a checkpoint file it could not read as ${backup} and kept the rest.`)
    expect(unwrap(await restarted.checkpoints(f.target)).reason).toBe(`Sotto set aside a checkpoint file it could not read as ${backup} and kept the rest.`)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 2, records: saved.records })
    expect(f.rollback).toHaveBeenCalledTimes(1)
    f.dependencies.historyEnabled = () => false
    await restarted.privacyChanged()
    expect(await readdir(f.dependencies.directory)).not.toContain(backup)
    expect(unwrap(await restarted.checkpoints(f.target)).reason).toBeUndefined()
  })
  it('erases a recovery backup that contains a forgotten thread without discarding other checkpoints', async () => {
    const f = await fixture(); await f.complete(); await f.service.beforeTurn('thread-b')
    const directory = f.dependencies.directory, backup = join(directory, 'checkpoints.json.corrupt-fixture')
    await writeFile(backup, (await readFile(join(directory, 'checkpoints.json'), 'utf8')) + ' damaged tail')
    await f.service.forgetThread('thread-a')
    await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((JSON.parse(await readFile(join(directory, 'checkpoints.json'), 'utf8')) as { records: { threadId: string }[] }).records.map(record => record.threadId)).toEqual(['thread-b'])
  })
  it.each(['truncated tail', 'unclosed earlier record'])('salvages complete legacy records after a %s and upgrades the format', async damage => {
    const f = await fixture(); await f.complete()
    const path = join(f.dependencies.directory, 'checkpoints.json')
    const saved = JSON.parse(await readFile(path, 'utf8')) as { records: unknown[] }
    await writeFile(path, damage === 'truncated tail' ? `[${JSON.stringify(saved.records[0])},{"truncated":` : `[{"broken":,${JSON.stringify(saved.records[0])}`)
    const restarted = new CheckpointService(f.dependencies); cleanup.push(async () => restarted.dispose())
    await restarted.initialize()
    expect(unwrap(await restarted.checkpoints(f.target)).checkpoints).toHaveLength(1)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 2, records: saved.records })
  })
  it('recovers an unreadable file once and accepts fresh checkpoints without restarting', async () => {
    const f = await fixture()
    await mkdir(f.dependencies.directory, { recursive: true })
    await writeFile(join(f.dependencies.directory, 'checkpoints.json'), '{"truncated":')
    const restarted = new CheckpointService(f.dependencies); cleanup.push(async () => restarted.dispose())
    await restarted.initialize(); await restarted.beforeTurn('thread-a')
    expect(restarted.isBlocked('thread-a')).toBe(false)
    expect((await readdir(f.dependencies.directory)).filter(name => name.startsWith('checkpoints.json.corrupt-'))).toHaveLength(1)
  })
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
    const retainedBlobs = (await readdir(join(f.dependencies.directory, 'blobs'))).sort()
    await writeFile(join(f.repo, 'app.txt'), 'later independent edit\n')
    expect(await f.service.revertCheckpoint({ ...request, confirmed: true })).toMatchObject({ ok: false, error: { message: expect.stringContaining('Later edits') } })
    expect((await readdir(join(f.dependencies.directory, 'blobs'))).sort()).toEqual(retainedBlobs)
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
