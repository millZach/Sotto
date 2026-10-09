// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { ConfiguredAgentReasoner } from '../../../src/main/agents/reasoning'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { PROVIDER_LABELS, type AgentConfiguration } from '../../../src/shared/agents'
import { olderDesktopAccountSchema } from '../../fixtures/olderDesktopAccountSchema'
import { hostHelloSchema, hostPushSchema, shellForProtocolV1 } from '../../../src/shared/hostProtocol'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const controls: AgentControl[] = []
const ROUTER_KEY = 'fixture-openrouter-key'

// OS encryption and native coding adapters are scripted; coordinator and stores are real.
const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decryptString: value => Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8'),
}

class UnacknowledgedCreationHost extends E2EAgentHost {
  readonly creationAttempts: AgentHostCommand[] = []
  private pending: AgentHostCommand | null = null
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type !== 'create-project' && command.type !== 'create-thread') return super.execute(command)
    this.creationAttempts.push(command)
    this.pending = command
    return { accepted: false, uncertain: true }
  }
  async revealOriginalCreation(): Promise<void> {
    if (!this.pending) throw new Error('No fixture creation is pending')
    await super.execute(this.pending)
    this.pending = null
  }
}

async function fixture(host = new E2EAgentHost()) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-control-recovery-'))
  roots.push(root)
  const credentialsDirectory = join(root, 'vault')
  const credentials = new AgentCredentials(credentialsDirectory, encryption)
  await credentials.load()
  let control: AgentControl
  const reasoner = new ConfiguredAgentReasoner()
  const create = async (): Promise<void> => {
    control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner,
    })
    controls.push(control)
    await control.start()
    if (!control.get().host.connected) await control.command({ type: 'connect' })
  }
  await create()
  return {
    root, credentialsDirectory, credentials, host,
    get control() { return control },
    async restart() { control.dispose(); await create() },
    async account(provider: AgentConfiguration['reasoning'] = 'openrouter', key = ROUTER_KEY) {
      await control.command({ type: 'configure', patch: { reasoning: provider, reasoningModel: 'fixture-model' } })
      await control.command({ type: 'credential', slot: 'reasoning', value: key })
    },

  }
}

afterEach(async () => {
  for (const control of controls.splice(0)) {
    control.dispose()
    // Disposal stops new work; drain the serialized stores before deleting the
    // fixture directory while a final snapshot may still be writing.
    await Promise.allSettled([control.privacyChanged()]) // Some cases deliberately make agents.json unwritable.
  }
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-control-recovery-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

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
    const reloaded = new AgentCredentials(f.credentialsDirectory, encryption)
    await reloaded.load()
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

  it('clears retired encrypted slots at start and tolerates absent slots on the next start', async () => {
    const f = await fixture()
    await f.credentials.set('membership', 'retired-token')
    await f.credentials.set('membership-cache', 'retired-cache')
    await f.credentials.set('formatting', 'keep-this-key')
    await f.restart()
    const reloaded = new AgentCredentials(f.credentialsDirectory, encryption)
    await reloaded.load()
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
    const reloaded = new AgentCredentials(f.credentialsDirectory, encryption); await reloaded.load()
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
    const reloaded = new AgentCredentials(f.credentialsDirectory, encryption)
    await reloaded.load()
    expect(reloaded.has('reasoning')).toBe(false)
    expect(f.credentials.has('reasoning')).toBe(false)
  })
})

describe('manual thread and project creation', () => {

  it('adopts the thread ID the window minted, refuses to create it twice, and still mints one when none is given', async () => {
    const f = await fixture()
    const threadId = randomUUID()
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Minted in the window', modelId: 'claude:test', threadId })
    expect(created).toMatchObject({ error: null, activeThreadId: threadId })
    expect(created.host.threads.filter(thread => thread.id === threadId)).toHaveLength(1)
    const duplicate = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Same ID again', modelId: 'claude:test', threadId })
    expect(duplicate.error).toBe('This thread already exists. Select it instead of creating it again.')
    expect(duplicate.host.threads.filter(thread => thread.id === threadId)).toHaveLength(1)
    const minted = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Main mints this one', modelId: 'claude:test' })
    expect(minted.error).toBeNull()
    expect(minted.activeThreadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
    expect(minted.activeThreadId).not.toBe(threadId)
  })

  it.each(['con.txt', 'NUL.log', 'aux.archive.tar', 'COM1.txt', 'lpt9.log', 'LPT¹', 'com³.txt', 'nul .txt', 'CON  .log'])('refuses the Windows device folder name %s before creating it', async title => {
    const f = await fixture()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const execute = vi.spyOn(f.host, 'execute')
      const result = await f.control.command({ type: 'create-project', title, path: join(f.root, title) })
      expect(result.error).toBe('Choose a project name that can be used as a folder name.')
      expect(execute).not.toHaveBeenCalled()
      expect(await readdir(f.root)).not.toContain(title)
    } finally { Object.defineProperty(process, 'platform', platform) }
  })
})

describe('question draft recovery', () => {
  it('preserves a matching draft on a rejected option answer, then clears it only after confirmation', async () => {
    const f = await fixture()
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Choose colors.', requestId: 'workshop-colors' })
    f.host.event({ type: 'question', threadId: 'docs', text: 'Choose the heading.', requestId: 'docs-heading' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Use the existing palette.' })
    f.host.event({ type: 'reject', threadId: 'workshop', text: 'Fixture option answer was rejected.' })
    const failed = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'workshop-colors', answer: 'Blue' })
    expect(failed.error).toContain('rejected')
    expect(failed).toMatchObject({ draft: 'Use the existing palette.', draftThreadId: 'workshop', draftRequestId: 'workshop-colors', composing: true })
    const confirmed = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'workshop-colors', answer: 'Blue' })
    expect(confirmed.error).toBeNull()
    expect(confirmed).toMatchObject({ draft: '', draftThreadId: null, draftRequestId: null, composing: false, activeThreadId: 'workshop' })
    expect(confirmed.host.threads.find(thread => thread.id === 'workshop')?.requests).toEqual([])
  })

  it.each(['another-question', 'another-thread'] as const)('preserves the current draft when a confirmed option answers %s', async target => {
    const f = await fixture()
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Choose colors.', requestId: 'workshop-colors' })
    const answeredThread = target === 'another-question' ? 'workshop' : 'docs'
    f.host.event({ type: 'question', threadId: answeredThread, text: 'Choose the heading.', requestId: 'other-question' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Use the existing palette.' })
    const confirmed = await f.control.command({ type: 'answer', threadId: answeredThread, requestId: 'other-question', answer: 'Original heading' })
    expect(confirmed.error).toBeNull()
    expect(confirmed).toMatchObject({ draft: 'Use the existing palette.', draftThreadId: 'workshop', draftRequestId: 'workshop-colors', composing: true })
    expect(confirmed.host.threads.find(thread => thread.id === 'workshop')?.requests.some(request => request.id === 'workshop-colors')).toBe(true)
  })
})

describe('uncertain creation recovery', () => {


  it.each(['create-project', 'create-thread'] as const)('blocks fresh creation intents while %s has an unknown acknowledgment, including after restart', async type => {
    const host = new UnacknowledgedCreationHost()
    const f = await fixture(host)
    await f.account()
    const command = type === 'create-project'
      ? { type: 'create-project' as const, title: 'Lantern', path: join(f.root, 'first-project') }
      : { type: 'create-thread' as const, title: 'Lantern', projectId: 'project', modelId: 'claude:test' }
    const failed = await f.control.command(command)
    expect(failed.error).toMatch(/did not confirm/iu)
    await f.restart()
    const retry = await f.control.command(command)
    expect(retry.error).toMatch(/unknown result/iu)
    const alternativePath = join(f.root, 'must-not-be-created')
    const another = await f.control.command({ type: 'create-project', title: 'Another', path: alternativePath })
    expect(another.error).toMatch(/unknown result/iu)
    await expect(stat(alternativePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(host.creationAttempts).toHaveLength(1)
    await host.revealOriginalCreation()
    const observed = await f.control.command({ type: 'refresh' })
    const existing = type === 'create-project'
      ? observed.host.projects.find(project => project.title === 'Lantern')!
      : observed.host.threads.find(thread => thread.title === 'Lantern')!
    const selected = await f.control.command(type === 'create-project'
      ? { type: 'select-project', projectId: existing.id } : { type: 'select-thread', threadId: existing.id })
    expect(selected.error).toBeNull()
    expect(selected).not.toHaveProperty('pendingRequest')
    expect(host.creationAttempts).toHaveLength(1)
  })
})
