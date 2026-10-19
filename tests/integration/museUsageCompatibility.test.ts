// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import type { AgentHost } from '../../src/main/agents/host'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { unavailableProviderQuota } from '../../src/main/agents/providerQuota'
import { UsageStore } from '../../src/main/agents/usageStore'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { EMPTY_AGENT_HOST, publicProviderEntityId, type AgentHostSnapshot, type ProviderId } from '../../src/shared/agents'
import { isUsageProviderId, type UsageTokenObservation } from '../../src/shared/usageDashboard'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { testCredentials } from '../fixtures/testCredentials'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const MUSE = 'muse-thread', CODEX = 'codex-thread'
const at = '2026-10-12T12:00:00.000Z'
const token: UsageTokenObservation = { providerId: 'codex', threadId: CODEX, modelId: 'codex-native-model', at,
  recordKey: createHash('sha256').update('synthetic-native-request').digest('hex'), tokens: { input: 100, output: 20 }, phase: 'seed', partial: false }

function mixedProvider(root: string) {
  const capabilities = { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true,
    observe: true, reconcile: true, messageOrigin: true }
  const state: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), capabilities,
    providers: (['codex', 'muse'] as const).map(id => ({ id, name: id, version: '1', connection: 'connected', capabilities })),
    models: (['codex', 'muse'] as const).map(id => ({ id: publicProviderEntityId(id, 'model', `${id}-model`), providerId: id, provider: id, name: id, ready: true })),
    projects: (['codex', 'muse'] as const).map(id => ({ id: publicProviderEntityId(id, 'project', `${id}-project`), providerId: id, title: id, path: root })),
    threads: (['codex', 'muse'] as const).map(id => ({ id: id === 'muse' ? MUSE : CODEX, providerId: id, title: id, kind: 'project',
      projectId: publicProviderEntityId(id, 'project', `${id}-project`), modelId: publicProviderEntityId(id, 'model', `${id}-model`),
      status: 'idle', messages: [], requests: [] })) }
  const host: FakeProviderHost & AgentHost = new FakeProviderHost(state)
  const visit = vi.fn((threadId: string, visitor: (record: UsageTokenObservation) => void) => {
    if (threadId === CODEX) visitor(token)
  })
  const quota = vi.fn(async (providerId: ProviderId) => {
    if (!isUsageProviderId(providerId)) throw new Error('Unverified native quota must not be read')
    return unavailableProviderQuota(providerId, 'unsupported')
  })
  host.visitUsage = visit
  host.readProviderQuota = quota
  return { host, visit, quota }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-usage-'))
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-muse-usage-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  })
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const settings = { ...DEFAULT_SETTINGS, threadTitles: false }
  const start = async (museEnabled: boolean, usageEnabled = true) => {
    const provider = mixedProvider(root)
    const runtime = await createAgentRuntime({ directory: root, credentials, host: provider.host, reasoner: {}, museEnabled, usageEnabled,
      settings: () => settings, writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined })
    cleanup.push(() => runtime.close())
    await runtime.agentControl.command({ type: 'connect', provider: 'codex' })
    return { ...provider, runtime }
  }
  return { root, start }
}

function numericRows(root: string) {
  const db = new DatabaseSync(join(root, 'usage.sqlite'), { readOnly: true })
  try { return ['token_rows', 'prompt_rows', 'pending_prompt_rows'].flatMap(table => db.prepare(`SELECT * FROM ${table}`).all()) }
  finally { db.close() }
}
function savedMuseMessages(root: string) {
  const db = new DatabaseSync(join(root, 'threads.sqlite'), { readOnly: true })
  try { return db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY rowid').all(MUSE) }
  finally { db.close() }
}

describe('Muse beside four-provider Usage', () => {
  it('accepts a Muse prompt without reporting failed persistence and still counts ordinary prompts', async () => {
    const f = await fixture(), { runtime, host, quota, visit } = await f.start(true)
    expect((await runtime.agentControl.command({ type: 'select-thread', threadId: MUSE })).error).toBeNull()
    const museText = 'Synthetic Muse words stay in the thread'
    const muse = await runtime.agentControl.command({ type: 'manual-send', threadId: MUSE, draftId: randomUUID(), text: museText })
    expect(muse.error).toBeNull()
    expect(host.commands.filter(command => command.type === 'send' && command.threadId === MUSE)).toHaveLength(1)
    expect(runtime.agentControl.get().host.threads.find(thread => thread.id === MUSE)!.messages.some(message => message.text === museText)).toBe(true)
    const read = await runtime.usage!.read()
    expect(read).toMatchObject({ status: 'ready', persistence: 'saved', activity: { totals: { prompts: { total: 0 }, tokens: { total: { value: 120 } } } } })
    expect(visit.mock.calls.map(([id]) => id)).not.toContain(MUSE)
    expect(quota.mock.calls.map(([id]) => id)).not.toContain('muse')
    expect(numericRows(f.root).every(row => row.provider === 'codex')).toBe(true)
    expect(JSON.stringify(numericRows(f.root))).not.toContain(museText)

    const ordinaryText = 'Synthetic ordinary words stay out of numeric storage'
    const ordinary = await runtime.agentControl.command({ type: 'manual-send', threadId: CODEX, draftId: randomUUID(), text: ordinaryText })
    expect(ordinary.error).toBeNull()
    await runtime.agentControl.command({ type: 'refresh' })
    const counted = await runtime.usage!.read()
    expect(counted).toMatchObject({ status: 'ready', persistence: 'saved', activity: { totals: { prompts: { user: 1, total: 1 } } } })
    expect(counted.activity!.providers.map(provider => provider.providerId)).toEqual(['codex'])
    expect(JSON.stringify(numericRows(f.root))).not.toContain(ordinaryText)
    expect(numericRows(f.root).some(row => row.thread_id === MUSE)).toBe(false)
  })

  it.each([false, true])('keeps a held Muse transcript dormant with Usage enabled=%s', async usageEnabled => {
    const f = await fixture(), owl = await f.start(true)
    expect((await owl.runtime.agentControl.command({ type: 'select-thread', threadId: MUSE })).error).toBeNull()
    const sent = await owl.runtime.agentControl.command({ type: 'manual-send', threadId: MUSE, text: 'Synthetic dormant Muse message' })
    expect(sent.error).toBeNull()
    const echo = owl.runtime.agentControl.get().host.threads.find(thread => thread.id === MUSE)!.messages.findLast(message => message.role === 'user')!
    await owl.runtime.usage!.read()
    await owl.runtime.close()
    const before = savedMuseMessages(f.root)
    expect(before.length).toBeGreaterThan(0)
    const held = await f.start(false, usageEnabled)
    expect(held.runtime.agentControl.shell().host.threads.some(thread => thread.id === MUSE)).toBe(false)
    expect(held.runtime.agentHost.preservesDormantThread(MUSE)).toBe(true)
    expect(held.runtime.agentHost.recordedUserMessages([{ threadId: MUSE, messageId: echo.id }])).toEqual([])
    const refused = await held.runtime.agentControl.command({ type: 'manual-send', threadId: MUSE, text: 'Cannot send while held' })
    expect(refused.error).toBeTruthy()
    expect(held.host.commands.filter(command => command.type === 'send')).toHaveLength(0)
    if (usageEnabled) expect(await held.runtime.usage!.read()).toMatchObject({ status: 'ready', persistence: 'saved' })
    else expect(held.runtime.usage).toBeUndefined()
    expect(held.visit.mock.calls.map(([id]) => id)).not.toContain(MUSE)
    expect(held.quota.mock.calls.map(([id]) => id)).not.toContain('muse')
    await held.runtime.close()
    expect(savedMuseMessages(f.root)).toEqual(before)
    const store = new UsageStore(join(f.root, 'usage.sqlite'))
    store.open()
    try { expect(store.query().totals.tokens.total.value).toBe(120) } finally { store.close() }
  })

  it('refuses unsupported quota reads before native execution and excludes Muse from token publication and replay', async () => {
    const codex: FakeProviderHost & AgentHost = new FakeProviderHost()
    const muse: FakeProviderHost & AgentHost = new FakeProviderHost()
    let publish: ((record: UsageTokenObservation) => void) | undefined
    const subscribeCodex = vi.fn((listener: (record: UsageTokenObservation) => void) => { publish = listener; return () => { publish = undefined } })
    const subscribeMuse = vi.fn(() => () => undefined)
    const visitCodex = vi.fn((_threadId: string, visitor: (record: UsageTokenObservation) => void) => visitor(token))
    const visitMuse = vi.fn()
    const codexQuota = vi.fn(async () => unavailableProviderQuota('codex', 'unsupported'))
    const museQuota = vi.fn(async () => unavailableProviderQuota('codex', 'unsupported'))
    codex.subscribeUsage = subscribeCodex; codex.visitUsage = visitCodex; codex.readProviderQuota = codexQuota
    muse.subscribeUsage = subscribeMuse; muse.visitUsage = visitMuse; muse.readProviderQuota = museQuota
    const host = new ConfiguredProviderHost({ provider: () => 'codex', hosts: {
      codex, muse, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), opencode: new FakeProviderHost() } })
    cleanup.push(async () => host.disconnect())
    const records: UsageTokenObservation[] = []
    const off = host.subscribeUsage!(record => records.push(record))
    cleanup.push(async () => off())
    await host.connect('codex'); await host.connect('muse')
    expect(subscribeCodex).toHaveBeenCalledOnce(); expect(subscribeMuse).not.toHaveBeenCalled()
    publish!(token)
    expect(records).toMatchObject([{ providerId: 'codex', modelId: publicProviderEntityId('codex', 'model', token.modelId) }])
    host.visitUsage!(CODEX, record => records.push(record))
    expect(visitCodex).toHaveBeenCalledOnce(); expect(visitMuse).not.toHaveBeenCalled()
    await expect(host.readProviderQuota!('muse', true)).rejects.toThrow('Usage is not available for this provider.')
    expect(museQuota).not.toHaveBeenCalled()
    expect(await host.readProviderQuota!('codex', true)).toMatchObject({ providerId: 'codex', status: 'unavailable', reason: 'unsupported' })
    expect(codexQuota).toHaveBeenCalledOnce()
  })
})
