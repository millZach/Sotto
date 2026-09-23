// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { AgentHostResult } from '../../src/main/agents/host'
import { PersonalChatService, type PersonalConversationHost, type PersonalChatOptions } from '../../src/main/agents/personalChats'

/** A deterministic double: no child process, no store. `drop()` simulates a
 * transport that ended on its own (the process died, the pipe closed) without
 * the user asking to disconnect, so the reconnect path can be driven exactly. */
class FakePersonalHost implements PersonalConversationHost {
  connected = false
  connectResult: 'success' | 'fail' = 'success'
  connectCalls = 0
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private current(): AgentHostSnapshot {
    return { connected: this.connected, name: 'fake', version: 'fake', projects: [], threads: [], models: [],
      capabilities: { projects: false, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, skills: true } }
  }
  private publish(): void { for (const listener of this.listeners) listener(this.current()) }
  async connect(): Promise<AgentHostSnapshot> {
    this.connectCalls++
    if (this.connectResult === 'fail') { this.connected = false; return { ...this.current(), error: 'Test host could not connect.' } }
    this.connected = true; this.publish(); return this.current()
  }
  disconnect(): void { this.connected = false; this.publish() }
  /** The transport ending on its own: connected drops without a disconnect() call. */
  drop(): void { this.connected = false; this.publish() }
  async closed(): Promise<void> {}
  personalSnapshot() { return [] }
  async refreshThread(): Promise<AgentHostSnapshot> { return this.current() }
  async createPersonalConversation(): Promise<AgentHostResult> { return { accepted: true } }
  async sendPersonalConversation(): Promise<AgentHostResult> { return { accepted: true } }
  async execute(): Promise<AgentHostResult> { return { accepted: true } }
  async listThreadSkills() { return { threadId: 'fake', providerId: 'codex' as const, cwd: 'fake', status: 'ready' as const, errors: [], skills: [] } }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}

const roots: string[] = []
const services: PersonalChatService[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sotto-personal-reconnect-')); roots.push(dir); return dir
}
function make(userDataPath: string, hosts: Partial<Record<'codex' | 'claude' | 'grok', PersonalConversationHost>>, reasoning: string | (() => string)): PersonalChatService {
  const configuration: PersonalChatOptions['configuration'] = () => ({ reasoning: typeof reasoning === 'function' ? reasoning() : reasoning, reasoningModel: 'test-model', reasoningEffort: '' })
  const service = new PersonalChatService({ userDataPath, hosts, configuration })
  services.push(service)
  return service
}

it('connects every provider with a saved chat plus the coordinator provider at launch, without an explicit connect', async () => {
  const dir = await root()
  const codex = new FakePersonalHost(), claude = new FakePersonalHost(), grok = new FakePersonalHost()
  // First session: one codex chat and one claude chat are saved. Grok is never used yet.
  let seedReasoning = 'codex'
  const seeding = make(dir, { codex, claude, grok }, () => seedReasoning)
  await seeding.start()
  await seeding.create()
  seedReasoning = 'claude'
  await seeding.create()
  expect(seeding.get().chats.map(chat => chat.providerId).sort()).toEqual(['claude', 'codex'])
  await seeding.close()

  // Second session: reasoning is 'grok', which has no saved chat of its own.
  const codex2 = new FakePersonalHost(), claude2 = new FakePersonalHost(), grok2 = new FakePersonalHost()
  const service = make(dir, { codex: codex2, claude: claude2, grok: grok2 }, 'grok')
  await service.start()
  await expect.poll(() => codex2.connectCalls).toBe(1)
  await expect.poll(() => claude2.connectCalls).toBe(1)
  // Grok has no saved chat but is the coordinator's provider, so launch connects it too,
  // ready for a brand-new chat.
  await expect.poll(() => grok2.connectCalls).toBe(1)
})

it('reconnects a dropped provider by itself after about 5s', async () => {
  const dir = await root()
  const codex = new FakePersonalHost()
  const service = make(dir, { codex }, 'codex')
  await service.start(); await service.connect()
  expect(service.get().connected).toBe(true)
  expect(codex.connectCalls).toBe(1)
  vi.useFakeTimers()
  try {
    codex.drop()
    expect(service.get().connected).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
  } finally { vi.useRealTimers() }
  await expect.poll(() => codex.connectCalls).toBe(2)
  await expect.poll(() => service.get().connected).toBe(true)
})

it('holds off auto-reconnect after Disconnect until Connect re-arms it', async () => {
  const dir = await root()
  const codex = new FakePersonalHost()
  const service = make(dir, { codex }, 'codex')
  await service.start(); await service.connect()
  expect(codex.connectCalls).toBe(1)
  await service.disconnect()
  expect(service.get().connected).toBe(false)
  vi.useFakeTimers()
  try { await vi.advanceTimersByTimeAsync(10_000) } finally { vi.useRealTimers() }
  // No reconnect attempt: the user asked to disconnect, so nothing retries on its own.
  expect(codex.connectCalls).toBe(1)
  await service.connect()
  expect(codex.connectCalls).toBe(2)
  expect(service.get().connected).toBe(true)
})

/** Lets a connect attempt finish its real file writes while the clock is fake, so the next wait starts on time. */
async function settled(service: PersonalChatService, host: FakePersonalHost, calls: number): Promise<void> {
  await vi.waitFor(() => { expect(host.connectCalls).toBe(calls); expect(service.get().connecting).toBe(false) })
}

it('retries a failing reconnect after longer waits, then leaves the error and Connect to the user', async () => {
  const dir = await root()
  const codex = new FakePersonalHost()
  const service = make(dir, { codex }, 'codex')
  await service.start(); await service.connect()
  expect(codex.connectCalls).toBe(1)
  vi.useFakeTimers()
  try {
    codex.connectResult = 'fail'
    codex.drop()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(codex.connectCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await settled(service, codex, 2)
    for (const [wait, calls] of [[15_000, 3], [45_000, 4], [120_000, 5], [300_000, 6]] as const) {
      await vi.advanceTimersByTimeAsync(wait)
      await settled(service, codex, calls)
    }
    await vi.advanceTimersByTimeAsync(60 * 60_000)
  } finally { vi.useRealTimers() }
  // Out of waits: the failure stays put for the user, who can still press Connect.
  expect(codex.connectCalls).toBe(6)
  expect(service.get().connected).toBe(false)
  expect(service.get().error).toBe('Test host could not connect.')
  codex.connectResult = 'success'
  await service.connect()
  expect(service.get().connected).toBe(true)
})

it('stops respawning a client that exits as soon as it starts, and starts afresh after a connection that held', async () => {
  const dir = await root()
  const codex = new FakePersonalHost()
  const service = make(dir, { codex }, 'codex')
  await service.start(); await service.connect()
  vi.useFakeTimers()
  try {
    // Held for a minute: the first drop waits the shortest time.
    await vi.advanceTimersByTimeAsync(60_000)
    codex.drop()
    await vi.advanceTimersByTimeAsync(5_000)
    await settled(service, codex, 2)
    // Each reconnect succeeds and falls straight back; the waits keep growing and then run out.
    for (const [wait, calls] of [[15_000, 3], [45_000, 4], [120_000, 5], [300_000, 6]] as const) {
      codex.drop()
      await vi.advanceTimersByTimeAsync(wait)
      await settled(service, codex, calls)
    }
    codex.drop()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(codex.connectCalls).toBe(6)
  } finally { vi.useRealTimers() }
})

it('close() cancels a pending reconnect timer so it cannot fire afterward', async () => {
  const dir = await root()
  const codex = new FakePersonalHost()
  const service = make(dir, { codex }, 'codex')
  await service.start(); await service.connect()
  expect(codex.connectCalls).toBe(1)
  vi.useFakeTimers()
  try {
    codex.drop()
    await service.close()
    services.splice(services.indexOf(service), 1)
    await vi.advanceTimersByTimeAsync(30_000)
  } finally { vi.useRealTimers() }
  // No timer outlived close(): the closed service never called connect() again.
  expect(codex.connectCalls).toBe(1)
})
