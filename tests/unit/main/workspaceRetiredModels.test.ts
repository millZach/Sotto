// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { publicProviderEntityId } from '../../../src/shared/agents'

/**
 * ADR-0171: a Claude Code or Codex model the provider no longer lists leaves the catalog, unless a thread is still on it;
 * that thread moves to the newest model of its line when it is opened, and keeps a note of the move.
 */
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const claude = (value: string): string => publicProviderEntityId('claude', 'model', value)

describe('retired models in the workspace', () => {
  it('drops what nothing uses, keeps what a thread is on until the thread moves, and moves it when it is opened', async () => {
    const f = await workspaceFixture(undefined, { history: true })
    cleanup.push(async () => { await f.stop(); await f.remove() })
    const adapter = f.adapters.claude
    adapter.state.models = [
      { id: 'opus', provider: 'Claude Code', name: 'Opus 5.5', ready: true, runtimeModes: ['approval-required'] },
      { id: 'opus[1m]', provider: 'Claude Code', name: 'Opus 5.5 with 1M context', ready: true, runtimeModes: ['approval-required'] },
      { id: 'claude-opus-4', provider: 'Claude Code', name: 'Opus 4', ready: true, runtimeModes: ['approval-required'] },
    ]
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'claude')!
    await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'local', projectId: project.id, title: 'Task', modelId: claude('opus[1m]') })
    const ids = () => f.host.workspaceSnapshot().models.filter(model => model.providerId === 'claude').map(model => [model.id, model.ready])

    // Claude Code stops listing both older models: the unused one goes, the thread's stays, not ready.
    adapter.state.models = adapter.state.models.filter(model => model.id === 'opus')
    adapter.emit()
    await expect.poll(ids).toEqual([[claude('opus'), true], [claude('opus[1m]'), false]])

    f.host.observeThreads(['local'])
    const thread = () => f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!
    await expect.poll(() => thread().modelId).toBe(claude('opus'))
    expect(thread().modelMoved).toMatchObject({ from: 'Opus 5.5 with 1M context', to: 'Opus 5.5' })
    // Not started yet, so the move changes only what it will start on: nothing reaches Claude Code.
    expect(adapter.commands.filter(command => command.type === 'configure-thread')).toHaveLength(0)

    // Nothing is on it now, so the next catalog leaves it out, and the note stays through a restart.
    adapter.emit()
    await expect.poll(ids).toEqual([[claude('opus'), true]])
    await f.stop()
    const reopened = await workspaceFixture(f.root, { adapters: f.adapters })
    cleanup.push(() => reopened.stop())
    expect(reopened.host.workspaceSnapshot().threads.find(item => item.id === 'local')!.modelMoved?.to).toBe('Opus 5.5')
  })

  it('keeps every model of a provider that is not connected, and leaves its threads where they are', async () => {
    const f = await workspaceFixture(undefined, { history: true })
    cleanup.push(async () => { await f.stop(); await f.remove() })
    const adapter = f.adapters.claude
    adapter.state.models = [{ id: 'opus', provider: 'Claude Code', name: 'Opus 5.5', ready: true }, { id: 'claude-opus-4', provider: 'Claude Code', name: 'Opus 4', ready: true }]
    await f.host.connect()
    adapter.state.models = adapter.state.models.map(model => ({ ...model, ready: false }))
    adapter.emit()
    await expect.poll(() => f.host.workspaceSnapshot().models.filter(model => model.providerId === 'claude').map(model => model.ready)).toEqual([false, false])
  })

  it('lets a settled thread’s retired model go, and moves the thread by its ID once it is restored and opened', async () => {
    const f = await workspaceFixture(undefined, { history: true })
    cleanup.push(async () => { await f.stop(); await f.remove() })
    const adapter = f.adapters.claude
    adapter.state.models = [{ id: 'fable', provider: 'Claude Code', name: 'Fable 5.1', ready: true }, { id: 'claude-fable-5', provider: 'Claude Code', name: 'Fable 5', ready: true }]
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'claude')!
    await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'local', projectId: project.id, title: 'Task', modelId: claude('claude-fable-5') })
    await f.host.setWorkspaceSettled('thread', 'local', true)
    const thread = () => f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!
    adapter.state.models = adapter.state.models.filter(model => model.id === 'fable')
    adapter.emit()
    await expect.poll(() => f.host.workspaceSnapshot().models.filter(model => model.providerId === 'claude').map(model => model.id)).toEqual([claude('fable')])
    f.host.observeThreads(['local'])
    expect(thread().modelId).toBe(claude('claude-fable-5'))

    await f.host.setWorkspaceSettled('thread', 'local', false)
    f.host.observeThreads([])
    f.host.observeThreads(['local'])
    await expect.poll(() => thread().modelId).toBe(claude('fable'))
    expect(thread().modelMoved).toMatchObject({ from: 'Fable 5', to: 'Fable 5.1' })
  })
})
