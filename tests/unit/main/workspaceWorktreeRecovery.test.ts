// @vitest-environment node
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { type AgentHostSnapshot } from '../../../src/shared/agents'

import { runWorktreeGit as git, ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'

import { fixture, local, send, deferred } from '../../fixtures/workspaceTestFixture'

describe("durable project/thread organization", () => {
  it('reads a folder for a refresh only once a send has set it up or put it back, so the refresh marks no error', async () => {
    const f = await fixture({ worktreeRefreshDelayMs: 600_000 })
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const checkout = join(project.path, 'own-worktree')
    const record = { mode: 'independent' as const, status: 'ready' as const, path: checkout, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    const present = () => stat(checkout).then(() => true, () => false)
    // `git worktree add` makes the folder first and keeps the worktree locked until it is done, so an inspection
    // in between would be refused. The test holds Git there.
    let locked = false
    let gitAtWork: { started: ReturnType<typeof deferred>; finish: ReturnType<typeof deferred> } | undefined
    const worktreeAdd = async () => {
      const hold = gitAtWork
      await mkdir(checkout, { recursive: true })
      if (!hold) return
      locked = true; hold.started.release(); await hold.finish.promise; locked = false
    }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockImplementation(async () => { await worktreeAdd(); return record })
    vi.spyOn(ThreadWorktrees.prototype, 'restore').mockImplementation(async metadata => {
      if (!await present()) await worktreeAdd()
      return { ...metadata, status: 'ready', error: undefined }
    })
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => {
      if (locked || !await present()) throw new Error('Git has locked this worktree. Unlock it in Git, then send again.')
      return { ...metadata, status: 'ready', branch: 'sotto/thread-fixture', dirty: false }
    })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id, workingCopy: 'independent' })
    const worktree = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree
    const sends = () => f.adapters.codex.commands.filter(command => command.type === 'send').length
    // The first send sets the worktree up, and the window asks for a refresh while Git is making it.
    let hold = gitAtWork = { started: deferred(), finish: deferred() }
    const first = f.host.execute(send())
    await hold.started.promise
    const refreshed = f.host.updateThreadWorktree('local', false)
    gitAtWork = undefined; hold.finish.release()
    await Promise.all([first, refreshed])
    expect(worktree()?.status).toBe('ready'); expect(worktree()?.error).toBeUndefined()
    f.adapters.codex.state.threads.at(-1)!.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.status).toBe('idle'))
    // The folder is deleted; the next send puts it back, and a refresh is asked for while Git is doing so.
    await rm(checkout, { recursive: true })
    hold = gitAtWork = { started: deferred(), finish: deferred() }
    const again = f.host.execute({ ...send(), commandId: 'again', messageId: 'again' })
    await hold.started.promise
    const refreshedAgain = f.host.updateThreadWorktree('local', false)
    gitAtWork = undefined; hold.finish.release()
    // The send goes to the folder it put back, and the refresh after it finds that folder sound.
    await expect(again).resolves.toMatchObject({ accepted: true })
    await refreshedAgain
    expect(sends()).toBe(2)
    expect(worktree()?.status).toBe('ready'); expect(worktree()?.error).toBeUndefined()
  })

  it('restores the branch of the last send by hand, and leaves uncommitted work alone until it is confirmed', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    let checkedOut = 'sotto/thread-fixture'
    let dirty = true
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: checkedOut, dirty }))
    const switched = vi.spyOn(ThreadWorktrees.prototype, 'switchBranch').mockImplementation(async (metadata, branch) => { checkedOut = branch; return { ...metadata, status: 'ready', branch, dirty } })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    f.adapters.codex.state.threads.at(-1)!.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.status).toBe('idle'))
    checkedOut = 'feat/agent-chose'
    await expect(f.host.restoreThreadBranch('local', false)).rejects.toThrow('uncommitted changes')
    expect(switched).not.toHaveBeenCalled()
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ branch: 'feat/agent-chose', sentBranch: 'sotto/thread-fixture' })
    const restored = await f.host.restoreThreadBranch('local', true)
    expect(switched).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feat/agent-chose' }), 'sotto/thread-fixture')
    expect(restored.threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ branch: 'sotto/thread-fixture', sentBranch: 'sotto/thread-fixture' })
    // A clean folder needs no confirmation.
    dirty = false; checkedOut = 'feat/agent-chose'
    expect((await f.host.restoreThreadBranch('local', false)).threads.find(thread => thread.id === 'local')?.worktree?.branch).toBe('sotto/thread-fixture')
    await expect(f.host.restoreThreadBranch('other', false)).rejects.toThrow('not known to Sotto')
  })

  it('puts a deleted folder back before a refresh reads it, and a send repairs a record an earlier read marked as an error', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    // A folder of its own that really goes away, since a refresh looks at the disk to know whether it must put one back.
    const checkout = join(project.path, 'own-worktree'); await mkdir(checkout)
    const record = { mode: 'independent' as const, status: 'ready' as const, path: checkout, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    const present = () => stat(checkout).then(() => true, () => false)
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    const restore = vi.spyOn(ThreadWorktrees.prototype, 'restore').mockImplementation(async metadata => { await mkdir(checkout, { recursive: true }); return { ...metadata, status: 'ready', error: undefined } })
    const inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => {
      if (!await present()) throw new Error('The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.')
      return { ...metadata, status: 'ready', branch: 'sotto/thread-fixture', dirty: false }
    })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const worktree = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree
    // Typing in the pane asks for one refresh; with the folder gone it is put back rather than marked as an error.
    await rm(checkout, { recursive: true }); restore.mockClear(); inspect.mockClear()
    await f.host.updateThreadWorktree('local', false)
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(inspect.mock.invocationCallOrder[0]!)
    expect(worktree()).toMatchObject({ status: 'ready', branch: 'sotto/thread-fixture' })
    // A record an earlier read left as an error is given the same chance on the next send.
    restore.mockImplementationOnce(async metadata => metadata)
    await rm(checkout, { recursive: true })
    await f.host.updateThreadWorktree('local', false)
    expect(worktree()?.status).toBe('error')
    await expect(f.host.threadWorkingDirectory('local')).resolves.toBe(checkout)
    expect(worktree()).toMatchObject({ status: 'ready', error: undefined })
  })

  it.each(['missing', 'reclaimed', 'unreadable', 'shared-after-missing', 'missing-shared-subfolder'] as const)('checks checkout ownership with a %s thread folder', async kind => {
    const f = await fixture()
    const repository = f.adapters.codex.state.projects[0]!.path
    await git(repository, ['init'])
    await writeFile(join(repository, 'tracked.txt'), 'baseline')
    await git(repository, ['add', '.'])
    await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
    f.host.setWorkingCopyDefaults(() => 'independent')
    await local(f)
    await f.host.execute(send())
    const owner = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
    const provider = f.adapters.codex.state.threads
    provider.at(-1)!.status = 'idle'
    const missing = join(kind === 'missing-shared-subfolder' ? owner.workingDirectory! : repository, 'missing-folder')
    provider[0]!.workingDirectory = missing
    if (kind === 'reclaimed') provider[0]!.worktree = { mode: 'independent', status: 'ready', path: missing, reclaimedAt: '2026-09-22T00:00:00.000Z' }
    if (kind === 'shared-after-missing') {
      f.adapters.claude.state.threads[0]!.workingDirectory = owner.workingDirectory
      f.adapters.claude.emit()
    }
    const original = ThreadWorktrees.prototype.checkoutIdentity
    const service = new ThreadWorktrees(f.root)
    const identity = vi.spyOn(ThreadWorktrees.prototype, 'checkoutIdentity')
    if (kind === 'unreadable') {
      identity.mockImplementation(async path => {
        if (path === missing) throw Object.assign(new Error('Unreadable folder'), { code: 'EACCES' })
        return original.call(service, path)
      })
    }
    f.adapters.codex.emit()
    await f.host.snapshot()
    await f.host.renameTemporaryBranch('local', 'sotto/available-name')
    const blocked = kind === 'unreadable' || kind === 'shared-after-missing' || kind === 'missing-shared-subfolder'
    expect((await git(owner.workingDirectory!, ['branch', '--show-current'])).trim()).toBe(blocked ? owner.worktree!.branch : 'sotto/available-name')
    if (kind === 'reclaimed') expect(identity).not.toHaveBeenCalledWith(missing)
    if (blocked) await expect(f.host.reclaimThreadWorktree('local')).rejects.toThrow('Another thread works in this folder')
    else {
      // The removal holds the folder off the remote half of status reads and waits for one already running in it.
      const order: string[] = []
      f.host.setGitStatus({ read: vi.fn(async () => { throw new Error('Not read here.') }), invalidate: vi.fn(),
        hold: vi.fn(() => { order.push('hold'); return () => { order.push('released') } }), idle: vi.fn(async () => { order.push('idle') }) }, { pollIntervalMs: () => 0 })
      await f.host.reclaimThreadWorktree('local', { automatic: kind === 'reclaimed' })
      expect(order).toEqual(['hold', 'idle', 'released'])
      expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.reclaimedAt).toBeDefined()
    }
  })

  it('checks each shared folder once per ownership decision and checks it again before the next decision', async () => {
    const f = await fixture()
    const project = (await f.host.connect()).projects.find(project => project.providerId === 'codex')!
    const checkout = join(project.path, 'owned-copy')
    await mkdir(checkout)
    const record = { mode: 'independent' as const, status: 'ready' as const, path: checkout, repositoryRoot: project.path, branch: 'sotto/fixture', baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', dirty: false }))
    const identity = vi.spyOn(ThreadWorktrees.prototype, 'checkoutIdentity').mockImplementation(async path => path)
    f.host.setWorkingCopyDefaults(() => 'independent')
    await local(f)
    await f.host.execute(send())
    const provider = f.adapters.codex.state.threads
    provider.at(-1)!.status = 'idle'
    provider[0]!.workingDirectory = project.path
    for (let index = 0; index < 30; index++) provider.push({ ...provider[0]!, id: `shared-${index}`, messages: [], requests: [] })
    f.adapters.codex.emit()
    await f.host.snapshot()
    const reclaim = vi.spyOn(ThreadWorktrees.prototype, 'reclaim').mockRejectedValue(new Error('Stopped after ownership check'))
    identity.mockClear()
    await expect(f.host.reclaimThreadWorktree('local')).rejects.toThrow('Stopped after ownership check')
    expect(identity.mock.calls.filter(([path]) => path === project.path)).toHaveLength(1)
    // A moved/replaced checkout must be discovered afresh by the next operation.
    identity.mockImplementation(async path => path === project.path ? checkout : path)
    reclaim.mockClear()
    await expect(f.host.reclaimThreadWorktree('local')).rejects.toThrow('Another thread works in this folder')
    expect(reclaim).not.toHaveBeenCalled()
  })

  it('reclaims a thread’s own worktree on request, keeps the record, and lets only a send put the folder back', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    // Its own folder, so no other thread of the project shares it.
    const checkout = join(project.path, 'own-worktree'); await mkdir(checkout)
    const record = { mode: 'independent' as const, status: 'ready' as const, path: checkout, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    let present = true
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'checkoutIdentity').mockImplementation(async path => path.toLowerCase())
    const restore = vi.spyOn(ThreadWorktrees.prototype, 'restore').mockImplementation(async metadata => { present = true; return { ...metadata, status: 'ready', error: undefined, reclaimedAt: undefined } })
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => {
      if (!present) throw new Error('The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.')
      return { ...metadata, status: 'ready', branch: 'sotto/thread-fixture', dirty: false, reclaimedAt: undefined }
    })
    const reclaim = vi.spyOn(ThreadWorktrees.prototype, 'reclaim').mockImplementation(async (metadata, options) => {
      if (options?.automatic) throw new Error('This folder holds ignored files besides installed dependencies, so a rule leaves it alone.')
      present = false; return { ...metadata, status: 'ready', dirty: undefined, reclaimedAt: '2026-09-22T00:00:00.000Z' }
    })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const worktree = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree
    // A running thread keeps its folder; so does one something else still works in.
    await expect(f.host.reclaimThreadWorktree('local')).rejects.toThrow('still working')
    f.adapters.codex.state.threads.at(-1)!.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.status).toBe('idle'))
    f.host.setWorktreeInUse(() => true)
    await expect(f.host.reclaimThreadWorktree('local')).rejects.toThrow('terminal is open')
    f.host.setWorktreeInUse(() => false)
    // A rule's refusal is the folder's own, and the record is untouched by it.
    await expect(f.host.reclaimThreadWorktree('local', { automatic: true })).rejects.toThrow('rule leaves it alone')
    expect(worktree()?.reclaimedAt).toBeUndefined()
    const published: AgentHostSnapshot[] = []
    f.host.subscribe(snapshot => published.push(snapshot))
    await f.host.reclaimThreadWorktree('local')
    expect(reclaim).toHaveBeenLastCalledWith(expect.objectContaining({ path: checkout }), {})
    expect(worktree()).toMatchObject({ status: 'ready', branch: 'sotto/thread-fixture', reclaimedAt: '2026-09-22T00:00:00.000Z' })
    expect(published.at(-1)?.threads.find(thread => thread.id === 'local')?.worktree?.reclaimedAt).toBe('2026-09-22T00:00:00.000Z')
    // Asking twice changes nothing; a refresh reads but does not put the folder back.
    await f.host.reclaimThreadWorktree('local')
    expect(reclaim).toHaveBeenCalledTimes(2)
    restore.mockClear()
    await f.host.updateThreadWorktree('local', false)
    expect(restore).not.toHaveBeenCalled()
    expect(worktree()).toMatchObject({ status: 'ready', reclaimedAt: '2026-09-22T00:00:00.000Z' })
    // The next send puts it back on its branch and the record says so.
    await expect(f.host.threadWorkingDirectory('local')).resolves.toBe(checkout)
    expect(restore).toHaveBeenCalled()
    expect(worktree()).toMatchObject({ status: 'ready', branch: 'sotto/thread-fixture', reclaimedAt: undefined })
    await expect(f.host.reclaimThreadWorktree('other')).rejects.toThrow('not known to Sotto')
  })

})
