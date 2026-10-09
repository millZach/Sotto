// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { agentCommandSchema, PROVIDER_LABELS } from '../../../src/shared/agents'
import { olderDesktopAccountSchema } from '../../fixtures/olderDesktopAccountSchema'
import { hostHelloSchema, hostPushSchema, shellForProtocolV1 } from '../../../src/shared/hostProtocol'
import { ROUTER_KEY, OPENAI_KEY, encryption, UnacknowledgedCreationHost, fixture, registerAgentControlRecoveryCleanup } from '../../fixtures/agentControlRecovery'
import { testCredentials } from '../../fixtures/testCredentials'

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
  it('defaults to Grok Altair and preserves an explicit Kokoro selection across restart', async () => {
    const f = await fixture()
    expect(f.control.get().configuration).toMatchObject({ speechProvider: 'grok', grokSpeechVoice: 'altair' })
    await f.control.command(agentCommandSchema.parse({ type: 'configure', patch: { speechProvider: 'kokoro', grokSpeechVoice: 'my-custom-voice' } }))
    await f.restart()
    expect(f.control.get().configuration).toMatchObject({ speechProvider: 'kokoro', grokSpeechVoice: 'my-custom-voice' })
  })
  it('persists Grok speech credentials separately and preserves both voices through unrelated settings and restart', async () => {
    const f = await fixture()
    await f.account()
    const key = 'fixture-dedicated-grok-speech-key'
    await f.control.command({ type: 'credential', slot: 'grokSpeech', value: key })
    await f.control.command({ type: 'configure', patch: { speechProvider: 'grok', grokSpeechVoice: 'my-custom-voice', speechVoice: 'M3' } })
    await f.control.command(agentCommandSchema.parse({ type: 'configure', patch: { followupLimit: 4 } }))
    await f.restart()
    expect(f.control.get().configuration).toMatchObject({ speechProvider: 'grok', grokSpeechVoice: 'my-custom-voice', speechVoice: 'M3', reasoning: 'openrouter' })
    expect(f.control.get().credentials).toMatchObject({ grokSpeech: true, reasoning: true })
    expect(JSON.stringify(f.control.get())).not.toContain(key)
    expect(await readFile(join(f.credentialsDirectory, 'credentials.json'), 'utf8')).not.toContain(key)
    expect(await readFile(join(f.root, 'agents.json'), 'utf8')).not.toContain(key)
    const reloaded = await testCredentials(f.credentialsDirectory, { encryption: encryption })

    expect(reloaded.get('grokSpeech')).toBe(key)
    expect(reloaded.get('reasoning')).toBe(ROUTER_KEY)
    await f.control.command({ type: 'configure', patch: { reasoning: 'openai', speechProvider: 'natural' } })
    expect(f.credentials.get('grokSpeech')).toBe(key)
    await f.control.command({ type: 'credential', slot: 'grokSpeech', value: '' })
    expect(f.control.get().credentials.grokSpeech).toBe(false)
  })

  it.each([
    ['openrouter', ROUTER_KEY, 'https://openrouter.ai', 'openai', OPENAI_KEY, 'https://api.openai.com'],
    ['openai', OPENAI_KEY, 'https://api.openai.com', 'openrouter', ROUTER_KEY, 'https://openrouter.ai'],
  ] as const)('requires a new key when switching %s to another provider', async (before, oldKey, oldOrigin, after, newKey, newOrigin) => {
    const f = await fixture()
    await f.account(before, oldKey)
    await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    await f.control.command({ type: 'configure', patch: { reasoning: after } })
    const missing = await f.control.command({ type: 'utterance', text: 'Choose the test project again.' })
    expect(missing.credentials.reasoning).toBe(false)
    expect(missing.error).toMatch(/connect.*reasoning api account/iu)
    expect(f.requests).toHaveLength(1)
    await f.control.command({ type: 'credential', slot: 'reasoning', value: newKey })
    await f.control.command({ type: 'utterance', text: 'Choose the test project with the new account.' })
    expect(f.requests.map(({ origin, authorization }) => ({ origin, authorization }))).toEqual([
      { origin: oldOrigin, authorization: `Bearer ${oldKey}` },
      { origin: newOrigin, authorization: `Bearer ${newKey}` },
    ])
  })

  it('retains the current provider key when only its model changes', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'configure', patch: { reasoningModel: 'another-fixture-model' } })
    const state = await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    expect(state.error).toBeNull()
    expect(f.requests[0]).toMatchObject({ origin: 'https://openrouter.ai', authorization: `Bearer ${ROUTER_KEY}` })
  })

  it('loads retired endpoint configuration without losing assignments or drafts', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: '643812b8-aed2-4eaf-8cc5-cd5174103c1a', text: 'Keep this draft.' })
    f.control.dispose()
    const file = join(f.root, 'agents.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    saved.configuration.membershipEndpoint = 'https://retired.example'
    await writeFile(file, JSON.stringify(saved))
    await f.restart()
    expect(f.control.get().assignments).toEqual(saved.assignments)
    expect(f.control.get().threadDrafts).toEqual(saved.threadDrafts)
    expect(f.control.configuration()).not.toHaveProperty('membershipEndpoint')
    expect(JSON.parse(await readFile(file, 'utf8')).configuration).not.toHaveProperty('membershipEndpoint')
  })

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
    const hello = hostHelloSchema.parse({ hostId: randomUUID(), clientId: 'older-host', shell: wire,
      capabilities: { mayAnswer: false }, sottoVersion: '0.1.21', features: [], events: [], latestSeq: 0, hasMore: false })
    expect(hello.shell).toEqual(current)
    expect(olderDesktopAccountSchema.parse(wire)).toMatchObject({ membership: { status: 'beta' }, configuration: { membershipEndpoint: '' } })
    for (const state of [current, wire]) {
      const parsed = hostPushSchema.parse({ v: 1, event: 'shell', state })
      expect(parsed).toMatchObject({ state: current })
      if (parsed.event !== 'shell') throw new Error('Expected shell')
      expect(parsed.state).not.toHaveProperty('membership')
      expect(parsed.state.configuration).not.toHaveProperty('membershipEndpoint')
    }
  })

  it('changes the default provider while preserving assignments and unrelated reasoning credentials', async () => {
    const f = await fixture()
    await f.control.command({ type: 'credential', slot: 'reasoning', value: 'fixture-reasoning-token' })
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    const updated = await f.control.command({ type: 'configure', patch: { provider: 'claude' } })
    expect(updated.error).toBeNull()
    expect(updated.configuration.provider).toBe('claude')
    expect(updated.connection).toBe('connected')
    expect(updated.assignments).toMatchObject([{ threadId: 'workshop' }])
    await f.control.command({ type: 'unassign', threadId: 'workshop' })
    const changed = await f.control.command({ type: 'configure', patch: { provider: 'claude' } })
    expect(changed).toMatchObject({ error: null, configuration: { provider: 'claude' }, connection: 'connected', credentials: { reasoning: true } })
    expect(f.credentials.get('reasoning')).toBe('fixture-reasoning-token')
    const reloaded = await testCredentials(f.credentialsDirectory, { encryption: encryption });
    expect(reloaded.get('reasoning')).toBe('fixture-reasoning-token')
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
    await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    expect(f.requests[0]).toMatchObject({ origin: 'https://openrouter.ai', authorization: `Bearer ${ROUTER_KEY}` })
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
    await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    expect(f.requests).toEqual([])
  })
})
