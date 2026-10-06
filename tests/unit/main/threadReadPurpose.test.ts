// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHost, AgentHostCommand, AgentHostResult, ThreadReadPurpose } from '../../../src/main/agents/host'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import type { AgentReasoner } from '../../../src/main/agents/reasoning'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { providerIdSchema, type AgentHostSnapshot, type ProviderId } from '../../../src/shared/agents'
import { manualSendCoordinator } from '../../fixtures/manualSendCoordinator'

/**
 * What a thread read is for reaches the adapter (#324). Codex makes the read before a send lighter when it can
 * show nothing changed (ADR-0005), so every layer between the coordinator and the adapter has to hand it on, and
 * every other read has to arrive without it.
 */
class ReadRecordingHost extends E2EAgentHost {
  readonly reads: { threadId: string; purpose: ThreadReadPurpose | undefined }[] = []
  /** The message ID of each send dispatched to this host. */
  readonly sent: string[] = []
  async refreshThread(threadId: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    this.reads.push({ threadId, purpose: purpose && structuredClone(purpose) }); return this.snapshot()
  }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type === 'send') this.sent.push(command.messageId)
    return super.execute(command)
  }
}
/** The same, publishing thread events so a workspace above it keeps history from them, and recording settings changes (#368). */
class EventReadRecordingHost extends ReadRecordingHost {
  readonly subscribeEvents = (): (() => void) => () => undefined
  readonly settings: { threadId: string; historyFromEvents: boolean | undefined }[] = []
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type === 'configure-thread') this.settings.push({ threadId: command.threadId, historyFromEvents: command.historyFromEvents })
    return super.execute(command)
  }
}

const roots: string[] = []
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-read-purpose-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  }
})
async function directory(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'sotto-read-purpose-')); roots.push(root); return root }

describe('the hosts between the coordinator and the adapter hand on what a read is for', () => {
  /** The adapter under the Sotto thread host, the provider switch and the workspace, as the runtime composes them. */
  async function composed(): Promise<{ host: WorkspaceHost; adapter: ReadRecordingHost; id: string }> {
    const root = await directory()
    const adapter = new ReadRecordingHost()
    const registry = new ThreadRegistry(root)
    const hosts = {} as Record<ProviderId, AgentHost>
    for (const provider of providerIdSchema.options) hosts[provider] = new SottoThreadHost(provider, provider === 'codex' ? adapter : new ReadRecordingHost(), registry)
    const host = new WorkspaceHost(new ConfiguredProviderHost({ directory: root, hosts, provider: () => 'codex', threadProvider: id => registry.byThread(id)?.provider }), root)
    cleanup.push(async () => { host.disconnect(); await host.close(); await registry.flush() })
    const connected = await host.connect()
    return { host, adapter, id: connected.threads.find(thread => thread.title === 'Workshop')!.id }
  }

  it('reaches the adapter with the read before a send, under the adapter\'s own session ID', async () => {
    const { host, adapter, id } = await composed()
    adapter.reads.length = 0
    await host.refreshThread(id, { beforeSend: true })
    expect(adapter.reads).toEqual([{ threadId: 'workshop', purpose: { beforeSend: true } }])
  })

  it('reaches the adapter without a purpose for any other read', async () => {
    const { host, adapter, id } = await composed()
    adapter.reads.length = 0
    await host.refreshThread(id)
    expect(adapter.reads).toEqual([{ threadId: 'workshop', purpose: undefined }])
  })

  it.each([
    ['WorkspaceHost', (inner: AgentHost, root: string) => new WorkspaceHost(inner, root)],
    ['ConfiguredProviderHost', (inner: AgentHost, root: string) => {
      const hosts = {} as Record<ProviderId, AgentHost>
      for (const provider of providerIdSchema.options) hosts[provider] = provider === 'codex' ? inner : new ReadRecordingHost()
      return new ConfiguredProviderHost({ directory: root, hosts, provider: () => 'codex', threadProvider: () => 'codex' })
    }],
  ] as const)('%s hands the read before a send to the host it wraps', async (_name, wrap) => {
    const root = await directory()
    const inner = new ReadRecordingHost()
    const host = wrap(inner, root)
    cleanup.push(async () => { host.disconnect(); if (host instanceof WorkspaceHost) await host.close() })
    await host.connect()
    inner.reads.length = 0
    await host.refreshThread!('workshop', { beforeSend: true })
    await host.refreshThread!('workshop')
    expect(inner.reads).toEqual([{ threadId: 'workshop', purpose: { beforeSend: true } }, { threadId: 'workshop', purpose: undefined }])
  })
})

describe('a workspace that keeps history from events asks its reads and settings results for no messages (#368)', () => {
  /** The adapter under the Sotto thread host, the provider switch and the workspace, with `ordinary` reading the switch whole beside it. */
  async function composed(ordinary = false): Promise<{ host: WorkspaceHost; adapter: EventReadRecordingHost; id: string }> {
    const root = await directory()
    const adapter = new EventReadRecordingHost()
    const registry = new ThreadRegistry(root)
    const hosts = {} as Record<ProviderId, AgentHost>
    for (const provider of providerIdSchema.options) hosts[provider] = new SottoThreadHost(provider, provider === 'codex' ? adapter : new ReadRecordingHost(), registry)
    const providers = new ConfiguredProviderHost({ directory: root, hosts, provider: () => 'codex', threadProvider: id => registry.byThread(id)?.provider })
    if (ordinary) cleanup.push(providers.subscribe(() => undefined))
    const host = new WorkspaceHost(providers, root)
    cleanup.push(async () => { host.disconnect(); await host.close(); await registry.flush() })
    const connected = await host.connect()
    return { host, adapter, id: connected.threads.find(thread => thread.title === 'Workshop')!.id }
  }

  it('reaches the adapter asking for no messages, beside what the read is for', async () => {
    const { host, adapter, id } = await composed()
    adapter.reads.length = 0
    await host.refreshThread(id, { beforeSend: true })
    await host.refreshThread(id)
    expect(adapter.reads).toEqual([{ threadId: 'workshop', purpose: { beforeSend: true, historyFromEvents: true } },
      { threadId: 'workshop', purpose: { historyFromEvents: true } }])
    expect((await host.execute({ type: 'configure-thread', commandId: 'settings', threadId: id, runtimeMode: 'full-access' })).accepted).toBe(true)
    expect(adapter.settings).toEqual([{ threadId: 'workshop', historyFromEvents: true }])
  })

  it('is read whole when something beside the workspace reads the provider switch\'s messages', async () => {
    const { host, adapter, id } = await composed(true)
    adapter.reads.length = 0
    await host.refreshThread(id, { beforeSend: true })
    expect(adapter.reads).toEqual([{ threadId: 'workshop', purpose: { beforeSend: true, historyFromEvents: false } }])
    expect((await host.execute({ type: 'configure-thread', commandId: 'settings', threadId: id, runtimeMode: 'full-access' })).accepted).toBe(true)
    expect(adapter.settings).toEqual([{ threadId: 'workshop', historyFromEvents: false }])
  })

  it('reads a host that publishes no events whole, whatever the workspace\'s own caller asked', async () => {
    const root = await directory()
    const inner = new ReadRecordingHost()
    const host = new WorkspaceHost(inner, root)
    cleanup.push(async () => { host.disconnect(); await host.close() })
    await host.connect()
    inner.reads.length = 0
    await host.refreshThread('workshop', { beforeSend: true, historyFromEvents: true })
    expect(inner.reads).toEqual([{ threadId: 'workshop', purpose: { beforeSend: true, historyFromEvents: false } }])
  })
})

describe('the coordinator marks only its reads immediately before a send', () => {
  async function coordinator(decide?: AgentReasoner['decide']): Promise<{ host: ReadRecordingHost; control: AgentControl }> {
    const root = await directory()
    const host = new ReadRecordingHost()
    const control = await manualSendCoordinator(root, host, decide)
    cleanup.push(async () => { control.dispose(); await control.privacyChanged() })
    await control.start(); expect((await control.command({ type: 'connect' })).error).toBeNull()
    host.reads.length = 0
    return { host, control }
  }
  /** The read before a send, naming the message of the send that followed it (#765). */
  const beforeSend = (host: ReadRecordingHost) => ({ threadId: 'workshop', purpose: { beforeSend: true, sendMessageId: host.sent.at(-1) ?? 'no send was dispatched' } })
  const plain = { threadId: 'workshop', purpose: undefined }

  it('a manual send', async () => {
    const { host, control } = await coordinator()
    expect((await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Manual prompt' })).error).toBeNull()
    expect(host.reads[0]).toEqual(beforeSend(host))
  })

  it('a coordinator draft send, and not the assign read before it', async () => {
    const { host, control } = await coordinator()
    await control.command({ type: 'assign', threadId: 'workshop' })
    expect(host.reads).toEqual([plain])
    await control.command({ type: 'compose', text: 'Drafted prompt' })
    host.reads.length = 0
    expect((await control.command({ type: 'send' })).error).toBeNull()
    expect(host.reads[0]).toEqual(beforeSend(host))
  })

  it('a supervision follow-up', async () => {
    const { host, control } = await coordinator(async () => ({ decision: 'followup', text: 'Fix the failing test within the assigned scope.' }))
    await control.command({ type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'fixture-model' } })
    await control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the existing failing tests.' })
    host.reads.length = 0
    host.event({ type: 'ready', threadId: 'workshop', text: 'First test failed.', status: 'idle' })
    await expect.poll(() => control.get().assignments[0]?.followups).toBe(1)
    await expect.poll(() => control.get().host.threads.find(thread => thread.id === 'workshop')?.status).toBe('running')
    expect(host.reads[0]).toEqual(beforeSend(host))
  })

  it('not the read that reconciles a send whose delivery is uncertain', async () => {
    const { host, control } = await coordinator()
    host.event({ type: 'uncertain', threadId: 'workshop', text: '' })
    await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Uncertain prompt' })
    host.reads.length = 0
    await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Uncertain prompt' })
    expect(host.reads).toEqual([plain])
  })

  it('not the read when a thread is selected', async () => {
    const { host, control } = await coordinator()
    await control.command({ type: 'select-thread', threadId: 'workshop' })
    expect(host.reads.every(read => read.purpose === undefined)).toBe(true)
  })
})
