// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { testCredentials } from '../../fixtures/testCredentials'
import { PROVIDER_LABELS } from '../../../src/shared/agents'
import { hostHelloSchema, hostPushSchema, shellForProtocolV1 } from '../../../src/shared/hostProtocol'
import { encryption, fixture, registerAgentControlRecoveryCleanup, ROUTER_KEY, UnacknowledgedCreationHost } from '../../fixtures/agentControlRecovery'
import { olderDesktopAccountSchema } from '../../fixtures/olderDesktopAccountSchema'

registerAgentControlRecoveryCleanup()

it.each(['claude', 'grok', 'codex'] as const)('changes the default to %s without discarding connected threads or coordinator credentials', async provider => {
  const f = await fixture()
  await f.control.command({ type: 'configure', patch: { provider: provider === 'codex' ? 'claude' : 'codex' } })
  await f.control.command({ type: 'configure', patch: { defaultModelId: 'old-provider-model' } })
  const changed = await f.control.command({ type: 'configure', patch: { provider } })
  expect(changed).toMatchObject({ error: null, configuration: { provider, defaultModelId: '' }, activeThreadId: null, activeProjectId: null })
  expect(changed.host).toMatchObject({ connected: true, threads: [{ id: 'workshop' }, { id: 'docs' }] })
  const connect = vi.spyOn(f.host, 'connect')
  const connected = await f.control.command({ type: 'connect' })
  expect(connect).toHaveBeenCalledWith()
  expect(connected.notice).toBe(`${PROVIDER_LABELS[provider]} connected`)
})

it('preserves the native account sign-in guidance when the adapter cannot connect', async () => {
  const f = await fixture()
  await f.control.command({ type: 'configure', patch: { provider: 'claude' } })
  vi.spyOn(f.host, 'connect').mockResolvedValue({ ...(await f.host.snapshot()), connected: false, error: 'Sign in through Claude Code, then reconnect.' })
  const result = await f.control.command({ type: 'connect' })
  expect(result).toMatchObject({ connection: 'disconnected', error: 'Sign in through Claude Code, then reconnect.' })
})

it('does not reconnect again after a native adapter replaces its process while connecting', async () => {
  const f = await fixture()
  const originalConnect = f.host.connect.bind(f.host)
  const connect = vi.spyOn(f.host, 'connect').mockImplementation(async () => {
    f.host.event({ type: 'disconnect', threadId: '', text: '' })
    return originalConnect()
  })
  vi.useFakeTimers()
  try {
    expect((await f.control.command({ type: 'connect' })).connection).toBe('connected')
    await vi.advanceTimersByTimeAsync(5100)
    expect(connect).toHaveBeenCalledOnce()
    expect(f.control.get().connection).toBe('connected')
  } finally { vi.useRealTimers() }
})

describe('reasoning account route isolation', () => {

  it('clears retired encrypted slots at start and tolerates absent slots on the next start', async () => {
    const f = await fixture()
    await f.credentials.set('membership', 'retired-token')
    await f.credentials.set('membership-cache', 'retired-cache')
    await f.credentials.set('formatting', 'keep-this-key')
    await f.restart()
    const reloaded = await testCredentials(f.credentialsDirectory, { encryption: encryption })

    expect(reloaded.has('membership')).toBe(false)
    expect(reloaded.has('membership-cache')).toBe(false)
    expect(reloaded.get('formatting')).toBe('keep-this-key')
    await f.restart()
    expect(f.credentials.has('membership')).toBe(false)
  })

  it('completes startup when each retired credential write fails', async () => {
    const f = await fixture()
    await f.credentials.set('membership', 'retired-token')
    await f.credentials.set('membership-cache', 'retired-cache')
    const write = vi.spyOn(f.credentials, 'set').mockRejectedValue(new Error('Private fixture failure'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(f.restart()).resolves.toBeUndefined()
      expect(f.control.get().host.connected).toBe(true)
      expect(write.mock.calls).toEqual([['membership', ''], ['membership-cache', '']])
      expect(warning.mock.calls).toEqual([['retired-credential-clear-failed'], ['retired-credential-clear-failed']])
    } finally { write.mockRestore(); warning.mockRestore() }
  })

  it('reads older hosts and sends retired v1 fields required by older desktops', async () => {
    const f = await fixture()
    const current = f.control.shell()
    expect(current).not.toHaveProperty('membership')
    expect(current.configuration).not.toHaveProperty('membershipEndpoint')
    const wire = shellForProtocolV1(current)
    const compatibility = { ...current, legacyManagement: false }
    const hello = hostHelloSchema.parse({ hostId: randomUUID(), clientId: 'older-host', shell: wire,
      capabilities: { mayAnswer: false }, sottoVersion: '0.1.21', features: [], events: [], latestSeq: 0, hasMore: false })
    expect(hello.shell).toEqual(compatibility)
    expect(olderDesktopAccountSchema.parse(wire)).toMatchObject({ membership: { status: 'beta' }, configuration: { membershipEndpoint: '' } })
    for (const state of [current, wire]) {
      const parsed = hostPushSchema.parse({ v: 1, event: 'shell', state })
      expect(parsed).toMatchObject({ state: compatibility })
      if (parsed.event !== 'shell') throw new Error('Expected shell')
      expect(parsed.state).not.toHaveProperty('membership')
      expect(parsed.state.configuration).not.toHaveProperty('membershipEndpoint')
    }
  })

  it('keeps an uncertain creation bound when the default provider changes', async () => {
    const host = new UnacknowledgedCreationHost()
    const f = await fixture(host)
    await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Pending', modelId: 'claude:test' })
    const updated = await f.control.command({ type: 'configure', patch: { provider: 'claude' } })
    expect(updated.error).toBeNull()
    expect(updated.configuration.provider).toBe('claude')
    const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))
    expect(saved.outbox).toMatchObject([{ type: 'create-thread' }])
    expect(host.creationAttempts).toHaveLength(1)
  })

  it('keeps the original route when deleting its credential fails', async () => {
    const f = await fixture()
    await f.account()
    const credentialFile = join(f.credentialsDirectory, 'credentials.json')
    await rename(credentialFile, credentialFile + '.saved')
    await mkdir(credentialFile)
    const state = await f.control.command({ type: 'configure', patch: { reasoning: 'openai' } })
    expect(state.error).not.toBeNull()
    expect(state.configuration.reasoning).toBe('openrouter')
    expect(f.credentials.get('reasoning')).toBe(ROUTER_KEY)
  })

  it('durably deletes the old key before attempting to persist the new provider', async () => {
    const f = await fixture()
    await f.account()
    const stateFile = join(f.root, 'agents.json')
    await rename(stateFile, stateFile + '.saved')
    await mkdir(stateFile)
    const failed = await f.control.command({ type: 'configure', patch: { reasoning: 'openai' } })
    expect(failed.error).toMatch(/could not save/iu)
    const reloaded = await testCredentials(f.credentialsDirectory, { encryption: encryption })

    expect(reloaded.has('reasoning')).toBe(false)
    expect(f.credentials.has('reasoning')).toBe(false)
  })
})

it('says nothing when Sotto reconnects on its own at start, and says it connected when asked', async () => {
  const f = await fixture()
  expect(f.control.get().notice).toMatch(/connected$/)
  await f.restart()
  await vi.waitFor(() => expect(f.control.get().host.connected).toBe(true))
  expect(f.control.get().notice).toBe('')
})

it.each([
  ['setup', undefined],
  ['Settings, Providers', 'codex'],
] as const)('leaves no connection notice from %s, while a Threads connection still says it connected', async (_surface, provider) => {
  const f = await fixture()
  await f.restart()
  const connect = vi.spyOn(f.host, 'connect')
  const connected = await f.control.command({ type: 'connect', ...(provider ? { provider } : {}), notice: false })
  expect(connected).toMatchObject({ connection: 'connected', notice: '', error: null })
  expect(connect).toHaveBeenCalledWith(...(provider ? [provider] : []))
  const requested = await f.control.command({ type: 'connect', ...(provider ? { provider } : {}) })
  expect(requested.notice).toBe('Codex connected')
})

it('leaves every installed agent setup connection quiet, while each Threads connection still announces itself', async () => {
  const installed = ['codex', 'claude', 'grok'] as const
  const f = await fixture(undefined, { installedProviders: async () => installed })
  await f.restart()
  const connect = vi.spyOn(f.host, 'connect')
  const connections = await Promise.all(installed.map(provider => f.control.command({ type: 'connect', provider, notice: false })))
  expect(connections).toHaveLength(installed.length)
  for (const connected of connections) expect(connected).toMatchObject({ connection: 'connected', notice: '', error: null })
  expect(f.control.get().notice).toBe('')
  for (const provider of installed) expect(connect).toHaveBeenCalledWith(provider)
  for (const provider of installed) {
    const requested = await f.control.command({ type: 'connect', provider })
    expect(requested.notice).toBe(`${PROVIDER_LABELS[provider]} connected`)
  }
})

it('clears the retired speech key on reload while preserving reasoning credentials', async () => {
    const f = await fixture()
    await f.account()
    const key = 'fixture-dedicated-grok-speech-key'
    await f.credentials.set('grokSpeech', key)
    await f.credentials.load()
    await f.restart()
    expect(f.control.get().configuration).toMatchObject({ reasoning: 'openrouter' })
    expect(f.control.get().credentials).toMatchObject({ reasoning: true })
    expect(f.control.get().credentials).not.toHaveProperty('grokSpeech')
    expect(JSON.stringify(f.control.get())).not.toContain(key)
    expect(await readFile(join(f.credentialsDirectory, 'credentials.json'), 'utf8')).not.toContain(key)
    expect(await readFile(join(f.root, 'agents.json'), 'utf8')).not.toContain(key)
    const reloaded = await testCredentials(f.credentialsDirectory, { encryption })
    expect(reloaded.get('grokSpeech')).toBe('')
    expect(reloaded.get('reasoning')).toBe(ROUTER_KEY)
    await f.control.command({ type: 'configure', patch: { reasoning: 'openai' } })
    expect(f.credentials.get('grokSpeech')).toBe('')
    expect(f.control.get().credentials).not.toHaveProperty('grokSpeech')
  })

it.each(['openrouter', 'openai'] as const)('clears the saved key when switching away from %s', async before => {
    const f = await fixture(); await f.account(before)
    const changed = await f.control.command({ type: 'configure', patch: { reasoning: before === 'openai' ? 'openrouter' : 'openai' } })
    expect(changed.credentials.reasoning).toBe(false)
    await f.restart(); expect(f.credentials.has('reasoning')).toBe(false)
  })

it('retains the saved key when only its model changes', async () => {
    const f = await fixture(); await f.account()
    const state = await f.control.command({ type: 'configure', patch: { reasoningModel: 'another-fixture-model' } })
    expect(state.error).toBeNull(); expect(f.credentials.get('reasoning')).toBe(ROUTER_KEY)
  })

it('loads retired endpoint configuration without losing drafts', async () => {
    const f = await fixture()
    await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: '643812b8-aed2-4eaf-8cc5-cd5174103c1a', text: 'Keep this draft.' })
    f.control.dispose()
    const file = join(f.root, 'agents.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    saved.configuration.membershipEndpoint = 'https://retired.example'
    await writeFile(file, JSON.stringify(saved))
    await f.restart()
    expect(f.control.get()).not.toHaveProperty('assignments')
    expect(f.control.get().threadDrafts).toEqual(saved.threadDrafts)
    expect(f.control.configuration()).not.toHaveProperty('membershipEndpoint')
    expect(JSON.parse(await readFile(file, 'utf8')).configuration).not.toHaveProperty('membershipEndpoint')
  })

it('changes the default provider while preserving threads and unrelated reasoning credentials', async () => {
    const f = await fixture()
    await f.control.command({ type: 'credential', slot: 'reasoning', value: 'fixture-reasoning-token' })
    const updated = await f.control.command({ type: 'configure', patch: { provider: 'claude' } })
    expect(updated.error).toBeNull()
    expect(updated.configuration.provider).toBe('claude')
    expect(updated.connection).toBe('connected')
    expect(updated.host.threads).toHaveLength(2)
    const changed = await f.control.command({ type: 'configure', patch: { provider: 'claude' } })
    expect(changed).toMatchObject({ error: null, configuration: { provider: 'claude' }, connection: 'connected', credentials: { reasoning: true } })
    expect(f.credentials.get('reasoning')).toBe('fixture-reasoning-token')
    const reloaded = await testCredentials(f.credentialsDirectory, { encryption })
    expect(reloaded.get('reasoning')).toBe('fixture-reasoning-token')
  })
