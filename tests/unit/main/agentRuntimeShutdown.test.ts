// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { createAgentRuntime, type AgentRuntimeOptions } from '../../../src/main/agents/runtime'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { startHeadlessHost } from '../../../src/host'
import { threadTitleRequest } from '../../../src/main/llm/threadTitle'

const roots: string[] = []
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-shutdown-')); roots.push(root); return root
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function runtime(options: Partial<AgentRuntimeOptions> = {}) {
  const root = await directory()
  const credentials = new AgentCredentials(root, {
    isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '',
  })
  await credentials.load()
  return createAgentRuntime({
    directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, coordinatorEnabled: () => false, openExternal: async () => undefined,
    ...(options.providers ? {} : { host: new E2EAgentHost() }), reasoner: e2eAgentReasoner, ...options,
  })
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-runtime-shutdown-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('host runtime shutdown', () => {
  it('stops a side call still writing a title, so no client outlives the host (ADR-0026)', async () => {
    const host = await runtime()
    let signal: AbortSignal | undefined
    const entered = deferred()
    vi.spyOn(host.agentHost, 'writeShortText').mockImplementation((_threadId, _prompt, received) => {
      signal = received; entered.resolve()
      return new Promise<string | null>((_resolve, reject) => { received!.addEventListener('abort', () => reject(new Error('Client stopped')), { once: true }) })
    })
    const pending = host.shortTextWriter.write('thread-a', threadTitleRequest({ prompt: 'Fix the contrast', reply: 'Done' }))
    await entered.promise
    await host.close()
    expect(signal!.aborted).toBe(true)
    await expect(pending).resolves.toBeNull()
  })

  it('waits for a pending organization save before closing the event store', async () => {
    const host = await runtime()
    await host.hostService.command({ type: 'connect' }, desktopWindowClient())
    const entered = deferred(), release = deferred()
    const original = AtomicJsonStore.prototype.write
    let held = false
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value: unknown) {
      if (!held && value && typeof value === 'object' && 'snapshot' in value) {
        held = true; entered.resolve(); await release.promise
      }
      return original.call(this, value)
    })
    const dispose = vi.spyOn(host.agentHost, 'dispose')
    host.agentHost.disconnect()
    await entered.promise
    const closed = host.close()
    await Promise.resolve()
    expect(dispose).not.toHaveBeenCalled()
    release.resolve()
    await closed
    expect(dispose).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(roots[0]!, 'workspace.json'), 'utf8')).snapshot.connected).toBe(false)
    await host.close()
    expect(dispose).toHaveBeenCalledOnce()
    const rejected = await host.hostService.command({ type: 'connect' }, desktopWindowClient())
    expect(rejected.error).toContain('Sotto is stopping')
  })

  it('waits for a draft save outside the command lanes before releasing stores', async () => {
    const host = await runtime()
    await host.hostService.command({ type: 'connect' }, desktopWindowClient())
    const threadId = host.hostService.state().host.threads[0]!.id
    const entered = deferred(), release = deferred()
    let held = false
    // Hold exactly the direct draft-save write. All later writes settle immediately, so an
    // omitted active-command drain deterministically closes the stores before the save finishes.
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async value => {
      if (!held && value && typeof value === 'object' && 'threadDrafts' in value) {
        held = true; entered.resolve(); await release.promise
      }
    })
    const saving = host.hostService.command({
      type: 'save-thread-draft', threadId, draftId: randomUUID(), text: 'Draft being saved',
    }, desktopWindowClient())
    await entered.promise
    const dispose = vi.spyOn(host.agentHost, 'dispose')
    const closed = host.close()
    try {
      // Advance one event-loop turn without a timer; all unblocked work above is promise-only.
      await new Promise<void>(done => setImmediate(done))
      expect(dispose).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await saving
      await closed
    }
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('drains every provider and the reasoner before propagating one shutdown failure', async () => {
    const providerRelease = deferred(), reasonerRelease = deferred()
    const providers = {
      codex: Object.assign(new E2EAgentHost(), { closed: vi.fn(async () => { throw new Error('Provider shutdown failed') }) }),
      claude: Object.assign(new E2EAgentHost(), { closed: vi.fn(() => providerRelease.promise) }),
      grok: new E2EAgentHost(), devin: new E2EAgentHost(),
    }
    const reasoner = { ...e2eAgentReasoner, close: vi.fn(() => reasonerRelease.promise) }
    const host = await runtime({ providers, reasoner })
    const dispose = vi.spyOn(host.agentHost, 'dispose')
    const closed = host.close()
    const assertion = expect(closed).rejects.toThrow('Provider shutdown failed')
    await Promise.resolve()
    expect(reasoner.close).toHaveBeenCalledOnce()
    expect(providers.claude.closed).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    providerRelease.resolve(); reasonerRelease.resolve()
    await assertion
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('preserves an unreadable workspace when initialization fails and cleanup runs', async () => {
    const root = await directory(), path = join(root, 'workspace.json')
    const original = '{broken workspace with original user data'
    await writeFile(path, original)
    await expect(startHeadlessHost({ dataDirectory: root, providers: {
      codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(),
    }, reasoner: e2eAgentReasoner })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})
