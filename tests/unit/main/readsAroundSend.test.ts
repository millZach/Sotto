// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHost, ThreadReadPurpose } from '../../../src/main/agents/host'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { ReadsBeforeSend } from '../../../src/main/agents/readsBeforeSend'
import { sameSnapshot } from '../../../src/main/agents/sameSnapshot'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { providerIdSchema, type AgentHostSnapshot, type ProviderId } from '../../../src/shared/agents'
import { manualSendCoordinator } from '../../fixtures/manualSendCoordinator'

/**
 * The reads around a send (#765), above the adapters: a workspace and the provider switch under it write and publish
 * nothing for a read before a send that changed nothing, the workspace answers the read after an accepted send from
 * what it holds, and the coordinator asks for that first and reads whole only when the echo is not in it. The
 * adapters' own share, one read per send, is `tests/integration/sendReads.test.ts`.
 */
class ReadRecordingHost extends E2EAgentHost {
  readonly reads: (ThreadReadPurpose | undefined)[] = []
  /** Leave the provider's echo of a send unpublished, as a provider whose echo waits on a publish window does. */
  quiet = false
  /** Answer the read after a send from the state before it, as a host that has not seen the echo yet does. */
  staleAfterSend: AgentHostSnapshot | undefined
  async refreshThread(_threadId: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    this.reads.push(purpose && structuredClone(purpose))
    return purpose?.afterSend && this.staleAfterSend ? structuredClone(this.staleAfterSend) : this.snapshot()
  }
  override subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    return super.subscribe(snapshot => { if (!this.quiet) listener(snapshot) })
  }
  /** A change the provider made without saying so, which only a read finds. */
  change(threadId: string): void {
    const thread = (this as unknown as { state: AgentHostSnapshot }).state.threads.find(item => item.id === threadId)!
    thread.title = `${thread.title} again`
  }
}

const roots: string[] = []
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-send-reads-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  }
})
async function directory(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'sotto-send-reads-')); roots.push(root); return root }

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
/** What the workspace publishes and writes from now on. */
function watch(host: WorkspaceHost): { published: () => number; written: () => number } {
  let published = 0, written = 0
  cleanup.push(host.subscribe(() => { published++ }))
  const write = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    if (basename((this as unknown as { filePath: string }).filePath) === 'workspace.json') written++
    return write.call(this, value)
  })
  return { published: () => published, written: () => written }
}

describe('a read before a send', () => {
  it('writes and publishes nothing when it changed nothing', async () => {
    const { host, adapter, id } = await composed()
    // A first read settles what connecting left for a read to say.
    await host.refreshThread(id, { beforeSend: true })
    const seen = watch(host)
    adapter.reads.length = 0
    const snapshot = await host.refreshThread(id, { beforeSend: true })
    expect(adapter.reads).toEqual([{ beforeSend: true }])
    expect(snapshot.threads.find(thread => thread.id === id)?.title).toBe('Workshop')
    // A publish the switch had sent would reach the workspace's own subscribers at the end of its window.
    await new Promise(done => setTimeout(done, 100))
    expect({ published: seen.published(), written: seen.written() }).toEqual({ published: 0, written: 0 })
  })

  it('writes and publishes what it found when the provider changed the thread', async () => {
    const { host, adapter, id } = await composed()
    await host.refreshThread(id, { beforeSend: true })
    const seen = watch(host)
    adapter.change('workshop')
    const snapshot = await host.refreshThread(id, { beforeSend: true })
    expect(snapshot.threads.find(thread => thread.id === id)?.title).toBe('Workshop again')
    expect(seen.published()).toBeGreaterThan(0)
    await vi.waitFor(() => expect(seen.written()).toBeGreaterThan(0))
  })

  it('is any other read\'s to write and publish as it always did', async () => {
    const { host, id } = await composed()
    await host.refreshThread(id, { beforeSend: true })
    const seen = watch(host)
    await host.refreshThread(id)
    expect(seen.published()).toBeGreaterThan(0)
  })
})

describe('the read after an accepted send', () => {
  it('is answered from what the workspace holds, without asking the provider', async () => {
    const { host, adapter, id } = await composed()
    adapter.reads.length = 0
    const snapshot = await host.refreshThread(id, { afterSend: true })
    expect(adapter.reads).toEqual([])
    expect(snapshot.threads.some(thread => thread.id === id)).toBe(true)
  })

  async function coordinator(): Promise<{ host: ReadRecordingHost; control: AgentControl }> {
    const root = await directory()
    const host = new ReadRecordingHost()
    const control = await manualSendCoordinator(root, host)
    cleanup.push(async () => { control.dispose(); await control.privacyChanged() })
    await control.start(); expect((await control.command({ type: 'connect' })).error).toBeNull()
    host.reads.length = 0
    return { host, control }
  }
  const userMessages = (control: AgentControl) => control.get().host.threads.find(thread => thread.id === 'workshop')!.messages.filter(message => message.role === 'user').map(message => message.text)

  it('is not made when the echo already settled the send', async () => {
    const { host, control } = await coordinator()
    expect((await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Echoed prompt' })).error).toBeNull()
    expect(host.reads).toEqual([{ beforeSend: true }])
  })

  it('asks the host for what it holds when the echo is not yet published, and reads no further when it is there', async () => {
    const { host, control } = await coordinator()
    host.quiet = true
    expect((await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Quiet prompt' })).error).toBeNull()
    expect(host.reads).toEqual([{ beforeSend: true }, { afterSend: true }])
    expect(userMessages(control)).toContain('Quiet prompt')
  })

  it('reads the thread whole when what the host holds does not have the echo', async () => {
    const { host, control } = await coordinator()
    host.quiet = true
    host.staleAfterSend = await host.snapshot()
    expect((await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Late prompt' })).error).toBeNull()
    expect(host.reads).toEqual([{ beforeSend: true }, { afterSend: true }, undefined])
    expect(userMessages(control)).toContain('Late prompt')
  })
})

describe('sameSnapshot', () => {
  it('compares plain data, taking a field set to undefined for one left out', () => {
    const shared = Object.freeze([{ id: 'a' }])
    expect(sameSnapshot({ threads: [{ id: 't', activities: shared, monitoring: undefined }] }, { threads: [{ id: 't', activities: shared }] })).toBe(true)
    expect(sameSnapshot({ a: [1, 2, { b: 'c' }] }, { a: [1, 2, { b: 'c' }] })).toBe(true)
    expect(sameSnapshot({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false)
    expect(sameSnapshot({ a: { b: 'c' } }, { a: { b: 'd' } })).toBe(false)
    expect(sameSnapshot({ a: 1 }, { a: 1, b: null })).toBe(false)
    expect(sameSnapshot({ a: [] }, { a: {} })).toBe(false)
    expect(sameSnapshot(Number.NaN, Number.NaN)).toBe(true)
  })
})

describe('ReadsBeforeSend', () => {
  it('stands for a send\'s read once, and only while the thread is as it was read', () => {
    const marks = new ReadsBeforeSend()
    marks.mark('thread', '1:4')
    expect(marks.take('thread', '1:4')).toBe(true)
    expect(marks.take('thread', '1:4')).toBe(false)
    marks.mark('thread', '1:4')
    expect(marks.take('thread', '1:5')).toBe(false)
    marks.mark('thread', '1:4'); marks.drop('thread')
    expect(marks.take('thread', '1:4')).toBe(false)
    marks.mark('thread', '1:4'); marks.clear()
    expect(marks.take('thread', '1:4')).toBe(false)
  })
})
