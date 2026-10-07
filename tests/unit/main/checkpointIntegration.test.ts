// @vitest-environment node
import * as worktrees from '../../../src/main/agents/threadWorktrees'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { connectCheckpoints } from '../../../src/main/tools/checkpointIntegration'
import { FilesService } from '../../../src/main/files/service'
import { resolveFilesBinding } from '../../../src/main/files/binding'
import type { GitActions } from '../../../src/main/agents/gitActions'
import type { AgentControl } from '../../../src/main/agents/control'

it('excludes an unallocated worktree from shared-folder checkpoint guards while retaining active shared-thread protection', async () => {
  const f = await workspaceFixture()
  let integration: ReturnType<typeof connectCheckpoints> | undefined
  try {
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'ready', threadId: 'ready', projectId: project.id, modelId: model.id, title: 'Ready' })
    await f.host.execute({ type: 'create-thread', commandId: 'pending', threadId: 'pending', projectId: project.id, modelId: model.id, title: 'Pending', workingCopy: 'independent' })
    const files = new FilesService({ resolveBinding: id => resolveFilesBinding(f.host.workspaceSnapshot(), id), copyPath: vi.fn(), reveal: vi.fn() })
    const pending = vi.fn(() => false)
    const subscribe = vi.fn<AgentControl['subscribe']>(() => () => undefined)
    const hooks = vi.spyOn(f.host, 'setCheckpointHooks')
    let historyEnabled = true
    integration = connectCheckpoints({ historyEnabled: () => historyEnabled, files, directory: f.root, host: f.host, registry: f.registry,
      control: { subscribe, hasPendingThreadWork: pending } as unknown as AgentControl,
      report: vi.fn() })
    await expect(Promise.resolve(hooks.mock.calls[0]![0].isBlocked('pending'))).resolves.toBe(false)
    await expect(integration.canMutate('pending')).resolves.toBe(false)
    await expect(integration.canMutate('ready')).resolves.toBe(true)
    expect(pending).not.toHaveBeenCalledWith('pending')
    // A local PR checkout tests the selected destination without changing the independent draft.
    await expect(integration.canMutate('pending', project.path)).resolves.toBe(true)
    pending.mockImplementation((id?: string) => id === 'pending')
    await expect(integration.canMutate('pending', project.path)).resolves.toBe(false)
    pending.mockImplementation(() => false)
    expect(f.host.workspaceSnapshot().threads.find(t => t.id === 'pending')?.worktree).toMatchObject({ mode: 'independent', status: 'pending' })
    const releaseMutation = await f.host.acquireCheckoutMutation('ready')
    await expect(Promise.resolve(hooks.mock.calls[0]![0].isBlocked('ready'))).resolves.toBe(true)
    releaseMutation()
    await expect(Promise.resolve(hooks.mock.calls[0]![0].isBlocked('ready'))).resolves.toBe(false)
    // A revert holds the checkpoint queue while validating files. Git commands
    // hold the real host lane while consulting the integration guard.
    const internals = integration.checkpoints as unknown as { locks: Set<string>; serial<T>(work: () => Promise<T>): Promise<T> }
    let release!: () => void, entered!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const checking = new Promise<void>(resolve => { entered = resolve })
    const revert = internals.serial(async () => {
      internals.locks.add('ready'); entered(); await paused
      await f.host.rollbackThread('ready', 1, []).catch(() => undefined)
      internals.locks.delete('ready')
    })
    await checking
    f.host.setGitActions({} as GitActions)
    f.host.setMutationGuard(integration.canMutate)
    const git = f.host.pullThreadBranch('ready')
    const refused = expect(git).rejects.toThrow('Wait for active or pending thread work')
    release()
    await refused
    await revert
    const forgotten = vi.spyOn(integration.checkpoints, 'forgetThread').mockResolvedValue()
    subscribe.mock.calls[0]![0]({ host: { ...f.host.workspaceSnapshot(), threads: [] } } as unknown as Parameters<Parameters<AgentControl['subscribe']>[0]>[0])
    expect(forgotten).toHaveBeenCalledWith('ready')
    expect(forgotten).toHaveBeenCalledWith('pending')
    const privacy = vi.spyOn(integration.checkpoints, 'privacyChanged').mockResolvedValue()
    await hooks.mock.calls[0]![0].privacyChanged?.()
    expect(privacy).not.toHaveBeenCalled()
    historyEnabled = false
    await hooks.mock.calls[0]![0].privacyChanged?.()
    expect(privacy).toHaveBeenCalledOnce()
    f.adapters.codex.state.threads[0]!.status = 'running'; f.adapters.codex.emit()
    await expect(integration.canMutate('ready')).resolves.toBe(false)
  } finally {
    integration?.dispose()
    await f.stop(); await f.remove()
  }
})

it('looks up only related active checkout candidates and caches shared folders for one checkpoint check', async () => {
  const f = await workspaceFixture()
  let integration: ReturnType<typeof connectCheckpoints> | undefined
  try {
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'ready', threadId: 'ready', projectId: project.id, modelId: model.id, title: 'Ready' })
    const ready = f.host.workspaceSnapshot().threads.find(t => t.id === 'ready')!
    const unrelated = join(f.root, 'unrelated'); await mkdir(unrelated)
    await worktrees.runWorktreeGit(project.path, ['init'])
    await worktrees.runWorktreeGit(unrelated, ['init'])
    const copies = [ready, { ...ready, id: 'same' }, { ...ready, id: 'archived', archivedAt: '2026-10-01T00:00:00Z', workingDirectory: join(f.root, 'archived'), worktree: undefined },
      ...Array.from({ length: 30 }, (_, i) => ({ ...ready, id: `other-${i}`, projectId: `other-project-${i}`, workingDirectory: unrelated, worktree: undefined })),
      { ...ready, id: 'other-worktree', worktree: { mode: 'independent' as const, status: 'ready' as const, path: unrelated }, workingDirectory: unrelated }]
    vi.spyOn(f.host, 'workspaceSnapshot').mockReturnValue({ ...f.host.workspaceSnapshot(), threads: copies })
    const files = new FilesService({ resolveBinding: id => resolveFilesBinding(f.host.workspaceSnapshot(), id), copyPath: vi.fn(), reveal: vi.fn() })
    integration = connectCheckpoints({ files, directory: f.root, host: f.host, registry: f.registry,
      control: { subscribe: () => () => undefined, hasPendingThreadWork: () => false } as unknown as AgentControl, report: vi.fn() })
    const lookup = vi.spyOn(worktrees, 'checkoutIdentity')
    await expect(integration.canMutate('ready')).resolves.toBe(true)
    expect(lookup.mock.calls.map(call => call[0])).toEqual([project.path])
  } finally { vi.restoreAllMocks(); integration?.dispose(); await f.stop(); await f.remove() }
})

it('takes a send\'s checkpoint from the thread the coordinator just read, settling the last turn once', async () => {
  const f = await workspaceFixture()
  let integration: ReturnType<typeof connectCheckpoints> | undefined
  try {
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'ready', threadId: 'ready', projectId: project.id, modelId: model.id, title: 'Ready' })
    const files = new FilesService({ resolveBinding: id => resolveFilesBinding(f.host.workspaceSnapshot(), id), copyPath: vi.fn(), reveal: vi.fn() })
    const hooks = vi.spyOn(f.host, 'setCheckpointHooks')
    const pending = vi.fn(() => false)
    integration = connectCheckpoints({ files, directory: f.root, host: f.host, registry: f.registry,
      control: { subscribe: () => () => undefined, hasPendingThreadWork: pending } as unknown as AgentControl, report: vi.fn() })
    const refresh = vi.spyOn(f.host, 'refreshThread')
    const settle = vi.spyOn(integration.checkpoints, 'afterTurn')
    await hooks.mock.calls[0]![0].beforeTurn('ready')
    expect(refresh).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledOnce()
    // Taking the checkpoint asks for the thread's history, not whether other work is pending.
    expect(pending).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks(); integration?.dispose(); await f.stop(); await f.remove() }
})
