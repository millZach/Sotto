// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas } from '../../src/shared/watcher'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/**
 * Watcher's observe pass runs on every update the coordinator accepts and walks every thread. Copying the Watcher record
 * per thread, or the whole shell per operation or watched thread, made it most of main's work with a few hundred
 * threads: what it copies must not grow with the number of threads, and it never needs a whole shell.
 */
it('copies nothing per thread while observing an update', async () => {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  const control = f.control
  const service = new WatcherService({ directory: f.root, host: workspace.host, control, historyEnabled: () => true })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); control.dispose(); await control.closed(); await workspace.stop() })
  await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  const model = control.shell().host.models.find(item => item.providerId === 'codex')!
  const project = control.shell().host.projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherId = service.state().current!.target.threadId
  expect((await control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const call = async (name: keyof typeof watcherToolSchemas, input: unknown) => watcherToolSchemas[name].output.parse((await tools.call(watcherId, name, input)).structuredContent)
  // A worker Watcher started (an operation and a participant) and a standing watch on it: every per-thread path runs.
  const started = await call('start_thread', { requestId: service.state().requests.at(-1)!.id, retryKey: randomUUID(),
    project: { hostId: control.hostId()!, projectId: project.id }, modelId: model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' })
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  expect(await call('watch_thread', { target: started.target })).toMatchObject({ status: 'ok' })
  expect(control.watcherRecordView().operations.length).toBeGreaterThan(0)
  expect(control.watcherRecordView().watches?.length).toBeGreaterThan(0)

  const base = control.watcherSnapshot()
  const template = base.threads.find(thread => thread.id === started.target.threadId)!
  // The real threads last, as in a long sidebar: a lookup that copies per thread copies for every thread before them.
  const withThreads = (count: number): AgentHostSnapshot => ({ ...base, threads: [
    ...Array.from({ length: count }, (_, index) => ({ ...template, id: `synthetic-${index}`, messages: [], requests: [] })),
    ...base.threads,
  ] })
  const copies = (count: number) => {
    const record = vi.spyOn(control, 'watcherRecord'), shell = vi.spyOn(control, 'shell')
    service.observe(withThreads(count), new Set())
    const counted = { record: record.mock.calls.length, shell: shell.mock.calls.length }
    record.mockRestore(); shell.mockRestore()
    return counted
  }
  copies(0)
  const few = copies(5), many = copies(200)
  expect(many.record).toBe(few.record)
  expect(few.shell).toBe(0)
  expect(many.shell).toBe(0)
})
