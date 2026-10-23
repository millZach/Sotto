// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { HostFactsSource, hostMachineReport } from '../../src/main/agents/hostFacts'
import { watcherToolSchemas } from '../../src/shared/watcher'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { deferred } from '../fixtures/deferred'

/**
 * Work placed but not started (#1311) counts a Watcher start from its admission: the start's reservation is recorded
 * before its working copy is resolved and its thread is created, so a second placement seconds later sees the first.
 */
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture() {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true })
  const tools = new WatcherToolServer(service); workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); await f.dispose(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherThread = service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: watcherThread, draftId: randomUUID(), text: 'Start two workers.' })).error).toBeNull()
  await f.control.commandShell({ type: 'observe-threads', threadIds: [watcherThread] })
  await tools.call(watcherThread, 'read_state', {})
  const start = async (title: string) => {
    const result = await tools.call(watcherThread, 'start_thread', { requestId: service.state().requests.at(-1)!.id, retryKey: randomUUID(),
      project: { hostId: f.control.hostId()!, projectId: project.id }, modelId: model.id, title, workingCopy: { kind: 'shared' }, firstPrompt: `${title}, please.` })
    return watcherToolSchemas.start_thread.output.parse(result.structuredContent)
  }
  // The report as the runtime reads it: threads and sends in place, with Watcher's starts still on their way here.
  const facts = new HostFactsSource({ sleep: async () => undefined })
  const report = () => hostMachineReport(facts, () => ({ threads: f.control.watcherSnapshot().threads, ...f.control.watcherSendRecords(),
    startsNotYetSent: service.startsNotYetSent() }))
  return { ...f, service, start, report }
}

it('counts a start as placed from its admission, before its thread exists, and stops once its first prompt has gone', async () => {
  const f = await fixture()
  const gate = deferred()
  let held = 0
  const command = f.control.commandFromWatcher.bind(f.control)
  vi.spyOn(f.control, 'commandFromWatcher').mockImplementation(async (sent, origin) => {
    if (sent.type === 'create-thread') { held += 1; await gate.promise }
    return command(sent, origin)
  })
  const first = f.start('Synthetic first worker')
  await vi.waitFor(() => expect(held).toBe(1))
  // Its thread is not created yet, and the machine already counts it.
  expect(f.service.startsNotYetSent()).toHaveLength(1)
  expect(f.control.watcherSnapshot().threads.some(thread => thread.id === f.service.startsNotYetSent()[0])).toBe(false)
  expect(await f.report()).toMatchObject({ placedNotStarted: 1 })
  // A second placement seconds later sees the first, and counts itself too.
  const second = f.start('Synthetic second worker')
  await vi.waitFor(() => expect(held).toBe(2))
  expect(await f.report()).toMatchObject({ placedNotStarted: 2 })
  gate.resolve()
  expect(await first).toMatchObject({ status: 'ok' })
  expect(await second).toMatchObject({ status: 'ok' })
  expect(f.service.startsNotYetSent()).toEqual([])
}, 60_000)
