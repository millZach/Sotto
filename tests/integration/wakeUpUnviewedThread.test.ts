// @vitest-environment node
// #1263: a hidden wake-up sent to a thread no window shows is confirmed by the provider's echo like any other send, and
// does not sit in the queue as unconfirmed, holding back the news behind it.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { WATCHER_WAKE_UP_PROMPT } from '../../src/main/agents/watcherNews'
import type { AgentControl } from '../../src/main/agents/control'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { delegationFixture } from '../fixtures/delegationFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const queued = (control: AgentControl, threadId: string) => (control as unknown as { followupStore: { get(): { items: { threadId: string; status: string }[] } } })
  .followupStore.get().items.filter(item => item.threadId === threadId)

it('sends and confirms a delegation\'s news to a thread the user has moved away from', async () => {
  const f = await delegationFixture(cleanups), parent = await f.userThread('claude')
  const result = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  await f.endTurn(parent, 'Synthetic parent reply')
  // The user opens another thread, so no window shows the one that delegated.
  await f.userThread('grok')
  expect(f.control.shell().activeThreadId).not.toBe(parent)
  await f.endTurn(result.delegation.thread, 'Synthetic later reply')
  const news = () => f.native(parent).messages.filter(message => message.role === 'user' && message.text.includes(`Delegation ${result.delegation.id}`))
  await vi.waitFor(() => expect(news()).toHaveLength(1))
  await vi.waitFor(() => expect(queued(f.control, parent)).toEqual([]))
})

it('confirms Watcher\'s news while the user looks at another thread, so the next news is not held behind it', async () => {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  const fixture = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  const control = fixture.control
  const service = new WatcherService({ directory: fixture.root, host: workspace.host, control, historyEnabled: () => true })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); await fixture.dispose(); await control.closed(); await workspace.stop() })
  await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  const model = control.watcherSnapshot().models.find(item => item.providerId === 'codex')!
  const project = control.watcherSnapshot().projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcher = service.state().current!.target
  const native = (threadId: string) => workspace.adapters.codex.state.threads.find(thread => thread.id === workspace.registry.byThread(threadId)!.sessionId)!
  const refresh = async () => { workspace.adapters.codex.emit(); await control.commandShell({ type: 'refresh', provider: 'codex' }) }
  // A watched thread, which the user then looks at instead of Watcher.
  const worker = randomUUID()
  expect((await control.commandShell({ type: 'create-thread', threadId: worker, projectId: project.id, modelId: model.id, title: 'Synthetic worker', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
  await control.commandShell({ type: 'manual-send', threadId: worker, draftId: randomUUID(), text: 'Synthetic existing turn' })
  native(worker).status = 'idle'; native(worker).lastTurn = { id: randomUUID(), status: 'completed' }; await refresh()
  expect(await service.watchThread({ target: { hostId: watcher.hostId, threadId: worker } })).toMatchObject({ status: 'ok' })
  expect(control.shell().activeThreadId).toBe(worker)
  native(worker).requests = [{ id: 'synthetic-card', kind: 'question', text: 'Synthetic question', options: [] }]
  await refresh()
  await vi.waitFor(() => expect(service.state().news?.some(event => event.kind === 'needs-user')).toBe(true), { timeout: 30_000 })
  const event = service.state().news!.find(item => item.kind === 'needs-user')!
  await control.deliverWakeUp(watcher.threadId, { source: 'watcher', watcher, events: [event], omitted: 0 }, { tool: false })
  await vi.waitFor(() => expect(workspace.adapters.codex.commands.some(command => command.type === 'send' && command.threadId === workspace.registry.byThread(watcher.threadId)?.sessionId && command.text === WATCHER_WAKE_UP_PROMPT)).toBe(true), { timeout: 30_000 })
  // The provider took it: the wake-up leaves Watcher's queue told, and Watcher's news is free to go again.
  await vi.waitFor(() => expect(queued(control, watcher.threadId)).toEqual([]), { timeout: 30_000 })
  expect(control.watcherWakeUpQueued()).toBe(false)
})
