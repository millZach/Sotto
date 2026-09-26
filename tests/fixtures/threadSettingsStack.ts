import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import type { AgentHost } from '../../src/main/agents/host'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { publicProviderEntityId, type AgentCommand, type AgentRuntimeMode, type ProviderId } from '../../src/shared/agents'
import type { AdapterFixture } from '../integration/adapterContract'

/**
 * One provider's real adapter under the whole host stack: the coordinator, the workspace, provider selection and
 * Sotto's thread identities, as a headless host runs them. What a thread settings change costs is counted at the
 * boundaries it crosses, by name and number only: nothing a thread says is read.
 */
export async function threadSettingsStack(provider: ProviderId, native: AdapterFixture & { adapter: AgentHost }) {
  const providers = { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), [provider]: native.host }
  const host = await startHeadlessHost({ dataDirectory: native.root, providers, reasoner: e2eAgentReasoner })
  const client = desktopWindowClient('thread-settings')
  const command = async (value: AgentCommand) => {
    const state = await host.service.command(value, client)
    if (state.error) throw new Error(state.error)
    return state
  }
  await command({ type: 'configure', patch: { enabledProviders: [provider], provider } })
  await command({ type: 'connect', provider })
  const created = await command({ type: 'create-project', provider, title: 'Settings project', path: native.root, useExisting: true })
  const projectId = created.host.projects.find(project => project.path === native.root)!.id
  const thread = await command({ type: 'create-thread', projectId, title: 'Settings thread', modelId: publicProviderEntityId(provider, 'model', native.modelId), workingCopy: 'shared', managed: false })
  const threadId = thread.activeThreadId!
  await command({ type: 'observe-threads', threadIds: [threadId] })
  // The native session starts on the first send, so a finished turn leaves a thread with a provider session to reap.
  await command({ type: 'manual-send', threadId, text: 'Synthetic prompt' })
  /** The provider session behind the thread, which is what the fixture's own records are keyed by. */
  const session = async (): Promise<string> => {
    const registry = JSON.parse(await readFile(join(native.root, 'threads.json'), 'utf8')) as { bindings: { threadId: string; sessionId: string }[] }
    return registry.bindings.find(item => item.threadId === threadId)!.sessionId
  }
  await native.driver.completeTurn(await session(), 'Completed reply')
  await vi.waitFor(() => { if (host.service.state().host.threads.find(item => item.id === threadId)?.status !== 'idle') throw new Error('Still running') }, { timeout: 15_000 })

  // Counters. A read is a call to the adapter's own refreshThread; a write is one AtomicJsonStore write, by file name.
  // The order of the adapter's reads and commands is kept too, by kind alone.
  const counts = { reads: 0, coordinatorWrites: 0, aliasWrites: 0 }
  const order: string[] = []
  const refresh = native.adapter.refreshThread!.bind(native.adapter)
  const reads = vi.spyOn(native.adapter, 'refreshThread').mockImplementation(async id => { counts.reads += 1; order.push('read'); return refresh(id) })
  const execute = native.adapter.execute.bind(native.adapter)
  const commands = vi.spyOn(native.adapter, 'execute').mockImplementation(async value => { order.push(value.type); return execute(value) })
  const write = AtomicJsonStore.prototype.write
  const aliasFile = `${provider}-threads.json`
  /** Writes started and not yet finished, so a press is counted once every write it set going has landed. */
  const writing = new Set<Promise<void>>()
  const writes = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    const file = basename((this as unknown as { filePath: string }).filePath)
    if (file === 'agents.json') counts.coordinatorWrites += 1
    else if (file === aliasFile) counts.aliasWrites += 1
    const written = write.call(this, value)
    const settled = written.catch(() => undefined).finally(() => writing.delete(settled))
    writing.add(settled)
    return written
  })
  // The workspace publishes a burst's last state at the end of a short window, and the coordinator answers each
  // publish with a write when its state changed. Which workspace is the stack's is read off the publish itself.
  type Publishing = { publishTimer?: unknown; publishSoon(): void }
  const workspaces = new Set<Publishing>()
  const publishSoon = (WorkspaceHost.prototype as unknown as Publishing).publishSoon
  const publishes = vi.spyOn(WorkspaceHost.prototype as unknown as Publishing, 'publishSoon').mockImplementation(function (this: Publishing) {
    workspaces.add(this); publishSoon.call(this)
  })
  /** Nothing the press set going is still to come: no publish is waiting in the workspace, and no write is in flight. */
  const settled = async (): Promise<void> => {
    for (;;) {
      await vi.waitFor(() => { if ([...workspaces].some(workspace => workspace.publishTimer !== undefined)) throw new Error('A publish is still waiting') }, { timeout: 5_000, interval: 5 })
      if (!writing.size) return
      await Promise.all(writing)
    }
  }
  const starts = async (): Promise<number> => native.sessions!.starts(await session())
  // Claude's fixture keeps a stop on record after the thread starts again, so its adapter is asked instead.
  const stopped = async (): Promise<boolean> => provider === 'claude'
    ? !(native.adapter as unknown as { runtimes: Map<string, unknown> }).runtimes.has(await session())
    : native.sessions!.stopped(await session())
  /** Nothing is looking at the thread, so the reaper stops its idle session. */
  const reap = async (): Promise<void> => {
    await command({ type: 'select-project', projectId })
    await command({ type: 'observe-threads', threadIds: [] })
    await vi.waitFor(async () => { if (!await stopped()) throw new Error('Still running') }, { timeout: 12_000 })
  }
  /** The thread is on screen and its session is running. */
  const watch = async (): Promise<void> => {
    await command({ type: 'select-thread', threadId })
    await command({ type: 'observe-threads', threadIds: [threadId] })
    await vi.waitFor(async () => { if (await stopped()) throw new Error('Not running') }, { timeout: 12_000 })
  }
  /** One chip press: the permission mode, as the composer's chip sends it. */
  const press = async (runtimeMode: AgentRuntimeMode) => {
    const before = { ...counts, starts: await starts(), requests: (await native.driver.requests()).length, order: order.length }
    const started = performance.now()
    const state = await host.service.command({ type: 'configure-thread', threadId, runtimeMode }, client)
    const elapsedMs = performance.now() - started
    // What the press queued without waiting, such as the coordinator's answer to the workspace's last publish,
    // has happened before anything is counted.
    await settled()
    const requests = (await native.driver.requests()).slice(before.requests)
    return { error: state.error, runtimeMode: state.host.threads.find(item => item.id === threadId)?.runtimeMode, elapsedMs,
      reads: counts.reads - before.reads, coordinatorWrites: counts.coordinatorWrites - before.coordinatorWrites,
      aliasWrites: counts.aliasWrites - before.aliasWrites, starts: await starts() - before.starts,
      methods: requests.map(record => record.method ?? ''), order: order.slice(before.order) }
  }
  return { host, threadId, command, press, reap, watch, starts,
    cleanup: async () => { reads.mockRestore(); commands.mockRestore(); writes.mockRestore(); publishes.mockRestore(); await host.close(); await native.cleanup() } }
}
