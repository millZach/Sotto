// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

// Watcher audit, October 17 and 28, 2026 (#2234): at a limit or while its provider failed, each news wake ran a turn that
// failed, 329 identical replies in one afternoon. While Watcher's provider fails, Sotto holds news and Watcher's queue,
// the room carries one band, and Try now lets what waited go: the user's message first, then the news in one wake.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: true } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true, holdNews: true,
    ordinaryBatch: { quietMs: 20, maxMs: 50 } })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherId = service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const call = async <N extends keyof typeof watcherToolSchemas>(name: N, input: unknown) =>
    watcherToolSchemas[name].output.parse((await tools.call(watcherId, name, input)).structuredContent)
  const started = await call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: project.id },
    modelId: model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' })
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const sessionOf = (threadId: string) => workspace.registry.byThread(threadId)!.sessionId
  const native = (threadId: string) => workspace.adapters.codex.state.threads.find(item => item.id === sessionOf(threadId))!
  const end = async (threadId: string, status: 'completed' | 'failed', error?: string) => {
    const thread = native(threadId), turnId = randomUUID()
    thread.status = status === 'failed' ? 'error' : 'idle'; thread.lastTurn = { id: turnId, status }
    if (error) thread.activities = [...thread.activities ?? [], { id: `${turnId}-turn`, kind: 'turn', title: 'Turn', turnId, status: 'failed', error } as NonNullable<typeof thread.activities>[number]]
    workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  const sends = (threadId: string) => workspace.adapters.codex.commands.filter(item => item.type === 'send' && item.threadId === sessionOf(threadId))
  return { ...f, workspace, service, watcherId, worker: started.target.threadId, end, sends }
}

it('holds news and the user’s message while Watcher’s provider fails, and Try now lets them go, the message first', async () => {
  const f = await fixture()
  // Watcher's turn fails, as an SSL error did for 80 minutes on October 28.
  await f.end(f.watcherId, 'failed', 'request to api.anthropic.com failed, reason: write EPROTO')
  await vi.waitFor(() => expect(f.service.state().hold).toMatchObject({ kind: 'failing', provider: 'codex', tries: 0,
    detail: 'request to api.anthropic.com failed, reason: write EPROTO' }))
  const before = f.sends(f.watcherId).length
  // The worker finishes: news Watcher would be woken with, which waits instead.
  await f.end(f.worker, 'completed')
  await vi.waitFor(() => expect(f.service.state().hold?.held).toBe(1))
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(f.sends(f.watcherId)).toHaveLength(before)
  // The user's message to Watcher waits in its queue rather than starting a turn that fails.
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.watcherId, draftId: randomUUID(), text: 'Synthetic message while failing' })).error).toBeNull()
  expect(f.control.shell().followups?.find(item => item.text === 'Synthetic message while failing')?.status).toBe('queued')
  expect(f.sends(f.watcherId)).toHaveLength(before)
  // Try now: the message goes first.
  expect(await f.service.tryNow()).toMatchObject({ status: 'ok' })
  await vi.waitFor(() => expect(f.sends(f.watcherId).map(item => item.type === 'send' ? item.text : '')).toEqual(
    [...f.sends(f.watcherId).slice(0, before).map(item => item.type === 'send' ? item.text : ''), 'Synthetic message while failing']))
  // Its turn finishes, the hold ends, and the news goes in one wake.
  await f.end(f.watcherId, 'completed')
  await vi.waitFor(() => expect(f.sends(f.watcherId)).toHaveLength(before + 2))
  expect(f.service.state().hold).toBeUndefined()
})
