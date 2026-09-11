// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { ConfiguredAgentReasoner } from '../../../src/main/agents/reasoning'
import type { SubscriptionClient } from '../../../src/main/agents/subscriptionTypes'
import { AgentControl } from '../../../src/main/agents/control'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { agentCommandSchema, agentConfigurationSchema, defaultAgentConfiguration, EMPTY_AGENT_HOST, type SubscriptionProvider } from '../../../src/shared/agents'

const roots: string[] = []
const controls: AgentControl[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-subscription-'))
  roots.push(root)
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  const configuration = defaultAgentConfiguration()
  const client = {
    status: vi.fn(async () => ({ provider: 'claude' as const, installed: true, ready: true, label: 'Claude Max', detail: 'Connected', models: [] })),
    complete: vi.fn<SubscriptionClient['complete']>(async (_system, input, model) => {
      if (model === 'unavailable-fixture-model') throw new Error('Fixture model unavailable')
      return 'utterance' in (input as object)
        ? { type: 'select-project', projectId: 'project' } : { decision: 'done', text: 'Assignment complete.' }
    }),
  }
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  return { root, credentials, configuration, client, fetch }
}
afterEach(async () => {
  controls.splice(0).forEach(control => control.dispose())
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-subscription-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('Sotto subscription reasoning integration', () => {
  it('migrates old configuration without resetting effort in unrelated settings patches', () => {
    const legacy = Object.fromEntries(Object.entries(defaultAgentConfiguration()).filter(([key]) => key !== 'reasoningEffort'))
    expect(agentConfigurationSchema.parse(legacy).reasoningEffort).toBe('')
    expect(agentCommandSchema.parse({ type: 'configure', patch: { speak: false } })).toEqual({ type: 'configure', patch: { speak: false } })
  })
  it.each(['claude', 'codex', 'grok'] as const)('uses the selected %s model and effort for both intent and supervision with no Sotto API credential', async provider => {
    const f = await fixture()
    f.configuration.reasoning = provider
    f.configuration.reasoningModel = 'subscription-advertised-model'
    f.configuration.reasoningEffort = 'high'
    const reasoner = new ConfiguredAgentReasoner(() => f.configuration, f.credentials, { [provider]: f.client })
    expect(await reasoner.intent('Select my project.', EMPTY_AGENT_HOST, null, '')).toEqual({ type: 'select-project', projectId: 'project' })
    expect(await reasoner.decide('Finish the assigned change.', { id: 'thread', title: 'Feature', projectId: 'project', modelId: 'coding-model', status: 'idle', messages: [], requests: [] }))
      .toEqual({ decision: 'done', text: 'Assignment complete.' })
    expect(f.client.complete).toHaveBeenCalledTimes(2)
    expect(f.client.complete.mock.calls.every(call => call[2] === 'subscription-advertised-model' && call[3] === 'high')).toBe(true)
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.credentials.has('reasoning')).toBe(false)
  })

  it('does not use a saved API key or another client after a subscription error', async () => {
    const f = await fixture()
    await f.credentials.set('reasoning', 'fixture-api-key')
    f.configuration.reasoning = 'claude'
    f.client.complete.mockRejectedValue(new Error('Claude subscription allowance reached.'))
    const other = { ...f.client, complete: vi.fn() }
    const reasoner = new ConfiguredAgentReasoner(() => f.configuration, f.credentials, { claude: f.client, codex: other })
    await expect(reasoner.intent('Open a project.', EMPTY_AGENT_HOST, null, '')).rejects.toThrow('subscription allowance reached')
    expect(f.fetch).not.toHaveBeenCalled()
    expect(other.complete).not.toHaveBeenCalled()
  })

  it('validates subscription output before accepting an action', async () => {
    const f = await fixture()
    f.configuration.reasoning = 'claude'
    f.client.complete.mockResolvedValue({ type: 'execute-shell', command: 'not an allowed action' })
    const reasoner = new ConfiguredAgentReasoner(() => f.configuration, f.credentials, { claude: f.client })
    await expect(reasoner.intent('Open a project.', EMPTY_AGENT_HOST, null, '')).rejects.toThrow()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('queues simultaneous subscription decisions and continues after the first one fails', async () => {
    const f = await fixture()
    f.configuration.reasoning = 'codex'
    let release!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    f.client.complete.mockImplementationOnce(async () => { await gate; throw new Error('First request failed') })
    const reasoner = new ConfiguredAgentReasoner(() => f.configuration, f.credentials, { codex: f.client })
    const first = reasoner.intent('First project.', EMPTY_AGENT_HOST, null, '')
    const second = reasoner.intent('Second project.', EMPTY_AGENT_HOST, null, '')
    const results = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(f.client.complete).toHaveBeenCalledTimes(1))
    release()
    expect((await results).map(result => result.status)).toEqual(['rejected', 'fulfilled'])
    expect(f.client.complete).toHaveBeenCalledTimes(2)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('persists a subscription selection, restores its status, and executes through the real controller without a key', async () => {
    const f = await fixture()
    let control: AgentControl
    const reasoner = new ConfiguredAgentReasoner(() => control.get().configuration, f.credentials, { claude: f.client })
    const start = async () => {
      control = new AgentControl({ directory: f.root, credentials: f.credentials, reasoner, host: new E2EAgentHost(),
        membership: { status: async () => ({ status: 'beta', label: 'Test beta', expiresAt: null }),
          action: async () => ({ status: 'beta', label: 'Test beta', expiresAt: null }) } })
      controls.push(control)
      await control.start()
      return control
    }
    const initial = await start()
    await f.credentials.set('reasoning', 'fixture-previous-api-key')
    await initial.command({ type: 'configure', patch: { reasoning: 'claude', reasoningModel: 'selected-model', reasoningEffort: 'high' } })
    expect(f.credentials.has('reasoning')).toBe(false)
    const checked = await initial.command({ type: 'check-reasoning', provider: 'claude' as SubscriptionProvider })
    expect(checked.reasoningAccounts).toEqual([expect.objectContaining({ provider: 'claude', ready: true })])
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).configuration.reasoning).toBe('claude')
    initial.dispose()
    let finishStatus!: () => void
    f.client.status.mockImplementationOnce(() => new Promise(resolveStatus => { finishStatus = () => resolveStatus({
      provider: 'claude', installed: true, ready: true, label: 'Claude Max', detail: 'Connected', models: [],
    }) }))
    const restarted = await start()
    // A native client can stall without delaying the rest of Sotto's startup.
    expect(restarted.get().configuration.reasoning).toBe('claude')
    expect(restarted.get().configuration.reasoningModel).toBe('selected-model')
    expect(restarted.get().configuration.reasoningEffort).toBe('high')
    expect(restarted.get().reasoningAccounts).toEqual([])
    finishStatus()
    await vi.waitFor(() => expect(restarted.get().reasoningAccounts[0]?.ready).toBe(true))
    await restarted.command({ type: 'connect' })
    const result = await restarted.command({ type: 'utterance', text: 'Select my project.' })
    expect(result.error).toBeNull()
    expect(result.activeProjectId).toBe('project')
    expect(result.credentials.reasoning).toBe(false)
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
