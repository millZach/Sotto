// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createAgentStateCatalogCache } from '../../../src/preload/agentStateCatalogCache'
import { AGENT_GET, defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentModel, type AgentState } from '../../../src/shared/agents'

function model(id: string, overrides: Partial<AgentModel> = {}): AgentModel {
  return { id, provider: 'codex', name: id, ready: true, ...overrides }
}

const HOST = 'aaaaaaaa-0000-4000-8000-000000000000'

/** A minimal, schema-valid AgentState for the AGENT_GET recovery reply. */
function fullState(models: AgentModel[], clientHosts?: { hostId: string; models: AgentModel[] }[]): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected',
    host: { ...structuredClone(EMPTY_AGENT_HOST), hostId: HOST, models,
      ...(clientHosts ? { clientHosts: clientHosts.map(client => ({ hostId: client.hostId, connected: true, models: client.models, capabilities: EMPTY_AGENT_HOST.capabilities })) } : {}) },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
    draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [], pendingRequest: '',
    globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: false },
    reasoningAccounts: [],
    membership: { status: 'active', label: 'Sotto', expiresAt: null }, clientScoped: true,
  }
}

/** A raw broadcast payload, as it would cross the wire once encoded by AgentStateBroadcaster. */
function broadcast(hostModels: unknown, clientHosts?: { hostId: string; models: unknown }[]): unknown {
  return { ...fullState([]), host: { ...fullState([]).host, models: hostModels, ...(clientHosts ? { clientHosts } : {}) } }
}

describe('createAgentStateCatalogCache', () => {
  it('passes a full catalog straight through and remembers it', () => {
    const renderer = { invoke: vi.fn() }
    const reassemble = createAgentStateCatalogCache(renderer)
    const models = [model('gpt-5')]
    const delivered: AgentState[] = []
    reassemble(broadcast({ revision: 1, models }), state => delivered.push(state))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.host.models).toEqual(models)
    expect(renderer.invoke).not.toHaveBeenCalled()
  })

  it('reads an omitted catalog back from what it was already sent', () => {
    const renderer = { invoke: vi.fn() }
    const reassemble = createAgentStateCatalogCache(renderer)
    const models = [model('gpt-5')]
    const delivered: AgentState[] = []
    reassemble(broadcast({ revision: 1, models }), state => delivered.push(state))
    reassemble(broadcast({ revision: 1, omitted: true }), state => delivered.push(state))
    expect(delivered).toHaveLength(2)
    expect(delivered[1]!.host.models).toEqual(models)
    expect(renderer.invoke).not.toHaveBeenCalled()
  })

  it('recovers with AGENT_GET when a broadcast names a revision this window never received', async () => {
    const recoveredModels = [model('gpt-5')]
    const renderer = { invoke: vi.fn(async (channel: string) => { expect(channel).toBe(AGENT_GET); return fullState(recoveredModels) }) }
    const reassemble = createAgentStateCatalogCache(renderer)
    const delivered: AgentState[] = []
    // The very first broadcast this window ever sees names revision 3 as omitted: a reload or a missed message.
    reassemble(broadcast({ revision: 3, omitted: true }), state => delivered.push(state))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]!.host.models).toEqual(recoveredModels)
    expect(renderer.invoke).toHaveBeenCalledTimes(1)
  })

  it('never hands a consumer an empty model list while recovering: it drops the broadcast instead', async () => {
    let resolveGet: (value: AgentState) => void = () => undefined
    const renderer = { invoke: vi.fn(() => new Promise<AgentState>(resolve => { resolveGet = resolve })) }
    const reassemble = createAgentStateCatalogCache(renderer)
    const delivered: AgentState[] = []
    reassemble(broadcast({ revision: 3, omitted: true }), state => delivered.push(state))
    // A second broadcast arrives while the recovery is still in flight; it must not be delivered as-is.
    reassemble(broadcast({ revision: 3, omitted: true }), state => delivered.push(state))
    expect(delivered).toHaveLength(0)
    expect(renderer.invoke).toHaveBeenCalledTimes(1)
    resolveGet(fullState([model('gpt-5')]))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]!.host.models).toEqual([model('gpt-5')])
  })

  it('remembers the recovered catalog under the revision that triggered recovery, so a repeat needs no second fetch', async () => {
    const renderer = { invoke: vi.fn(async () => fullState([model('gpt-5')])) }
    const reassemble = createAgentStateCatalogCache(renderer)
    const delivered: AgentState[] = []
    reassemble(broadcast({ revision: 3, omitted: true }), state => delivered.push(state))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    reassemble(broadcast({ revision: 3, omitted: true }), state => delivered.push(state))
    expect(delivered).toHaveLength(2)
    expect(delivered[1]!.host.models).toEqual([model('gpt-5')])
    expect(renderer.invoke).toHaveBeenCalledTimes(1)
  })

  it('resolves host.models and every clientHosts[] catalog independently', () => {
    const renderer = { invoke: vi.fn() }
    const reassemble = createAgentStateCatalogCache(renderer)
    const hostA = 'aaaaaaaa-0000-4000-8000-000000000000'
    const hostB = 'bbbbbbbb-0000-4000-8000-000000000000'
    const primaryModels = [model('gpt-5')]
    const bModels = [model('grok-4')]
    const delivered: AgentState[] = []
    reassemble(broadcast({ revision: 1, models: primaryModels },
      [{ hostId: hostA, models: { revision: 1, models: primaryModels } }, { hostId: hostB, models: { revision: 1, models: bModels } }]),
      state => delivered.push(state))
    // Next publish: the primary/hostA catalog repeats (omitted), hostB's changed.
    const newBModels = [model('grok-4', { ready: false })]
    reassemble(broadcast({ revision: 1, omitted: true },
      [{ hostId: hostA, models: { revision: 1, omitted: true } }, { hostId: hostB, models: { revision: 2, models: newBModels } }]),
      state => delivered.push(state))
    expect(delivered).toHaveLength(2)
    expect(delivered[1]!.host.models).toEqual(primaryModels)
    expect(delivered[1]!.host.clientHosts![0]!.models).toEqual(primaryModels)
    expect(delivered[1]!.host.clientHosts![1]!.models).toEqual(newBModels)
    expect(renderer.invoke).not.toHaveBeenCalled()
  })

  it('recovers when only one of several clientHosts catalogs is missing from cache', async () => {
    const hostA = 'aaaaaaaa-0000-4000-8000-000000000000'
    const hostB = 'bbbbbbbb-0000-4000-8000-000000000000'
    const recoveredA = [model('gpt-5')]
    const recoveredB = [model('grok-4')]
    const renderer = { invoke: vi.fn(async () => fullState(recoveredA, [{ hostId: hostA, models: recoveredA }, { hostId: hostB, models: recoveredB }])) }
    const reassemble = createAgentStateCatalogCache(renderer)
    const delivered: AgentState[] = []
    // hostA is included, hostB is only named by revision and this window has never seen it.
    reassemble(broadcast({ revision: 1, models: recoveredA },
      [{ hostId: hostA, models: { revision: 1, models: recoveredA } }, { hostId: hostB, models: { revision: 1, omitted: true } }]),
      state => delivered.push(state))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]!.host.clientHosts!.find(client => client.hostId === hostB)!.models).toEqual(recoveredB)
  })
})
