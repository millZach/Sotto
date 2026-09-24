import { describe, expect, it, vi } from 'vitest'
import { wrapAgentBridge } from '../../../src/renderer/src/agents/agentStateCatalogs'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentBridge, type AgentModel, type AgentState } from '../../../src/shared/agents'

function model(id: string, overrides: Partial<AgentModel> = {}): AgentModel {
  return { id, provider: 'codex', name: id, ready: true, ...overrides }
}

const HOST = 'aaaaaaaa-0000-4000-8000-000000000000'

/** A minimal, schema-shaped AgentState for a `get()` recovery reply. */
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

/** A fake bridge whose `onState` hands back the raw handler the wrapper registered, so a test can feed
 * it broadcasts directly, the way the real preload's IPC subscription would. */
function fakeBridge(get: () => Promise<AgentState>): { bridge: AgentBridge; emit: (raw: unknown) => void; get: ReturnType<typeof vi.fn> } {
  let raw: ((value: unknown) => void) | null = null
  const getFn = vi.fn(get)
  const bridge = {
    get: getFn,
    command: vi.fn(),
    onState: (listener: (state: AgentState) => void) => { raw = listener as unknown as (value: unknown) => void; return () => { raw = null } },
  } as unknown as AgentBridge
  return { bridge, emit: value => raw?.(value), get: getFn }
}

describe('wrapAgentBridge', () => {
  it('passes a full catalog straight through and remembers it', () => {
    const { bridge, emit, get } = fakeBridge(() => Promise.reject(new Error('unused')))
    const delivered: AgentState[] = []
    wrapAgentBridge(bridge).onState(state => delivered.push(state))
    const models = [model('gpt-5')]
    emit(broadcast({ revision: 1, models }))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.host.models).toEqual(models)
    expect(get).not.toHaveBeenCalled()
  })

  it('reads an omitted catalog back from what it was already sent', () => {
    const { bridge, emit, get } = fakeBridge(() => Promise.reject(new Error('unused')))
    const delivered: AgentState[] = []
    wrapAgentBridge(bridge).onState(state => delivered.push(state))
    const models = [model('gpt-5')]
    emit(broadcast({ revision: 1, models }))
    emit(broadcast({ revision: 1, omitted: true }))
    expect(delivered).toHaveLength(2)
    expect(delivered[1]!.host.models).toEqual(models)
    expect(get).not.toHaveBeenCalled()
  })

  it('recovers with get() when a broadcast names a revision this window never received', async () => {
    const recoveredModels = [model('gpt-5')]
    const { bridge, emit, get } = fakeBridge(() => Promise.resolve(fullState(recoveredModels)))
    const delivered: AgentState[] = []
    wrapAgentBridge(bridge).onState(state => delivered.push(state))
    // The very first broadcast this window ever sees names revision 3 as omitted: a reload or a missed message.
    emit(broadcast({ revision: 3, omitted: true }))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]!.host.models).toEqual(recoveredModels)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('never delivers a broadcast kept during a successful recovery after the newer answer, but keeps its catalog', async () => {
    let resolveGet: (value: AgentState) => void = () => undefined
    const { bridge, emit, get } = fakeBridge(() => new Promise<AgentState>(resolve => { resolveGet = resolve }))
    const delivered: AgentState[] = []
    wrapAgentBridge(bridge).onState(state => delivered.push(state))
    emit(broadcast({ revision: 3, omitted: true }))
    // Sent before main answered get(), so older than the answer; it carries a changed catalog in full.
    emit(broadcast({ revision: 4, models: [model('gpt-5.1')] }))
    expect(delivered).toHaveLength(0)
    resolveGet(fullState([model('gpt-5.1')]))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    await Promise.resolve()
    expect(delivered).toHaveLength(1)
    // Its catalog was kept: the next repeat of revision 4 resolves without another fetch.
    emit(broadcast({ revision: 4, omitted: true }))
    expect(delivered).toHaveLength(2)
    expect(delivered[1]!.host.models).toEqual([model('gpt-5.1')])
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('keeps the newest broadcast that arrives during recovery and gives it its own attempt after recovery fails', async () => {
    let rejectGet: (error: unknown) => void = () => undefined
    let calls = 0
    const { bridge, emit, get } = fakeBridge(() => {
      calls += 1
      if (calls === 1) return new Promise<AgentState>((_resolve, reject) => { rejectGet = reject })
      return Promise.resolve(fullState([model('gpt-5')]))
    })
    const delivered: AgentState[] = []
    wrapAgentBridge(bridge).onState(state => delivered.push(state))
    emit(broadcast({ revision: 3, omitted: true }))
    // A newer broadcast arrives while the first recovery is still in flight, and is kept rather than dropped.
    emit(broadcast({ revision: 3, omitted: true }))
    expect(get).toHaveBeenCalledTimes(1)
    rejectGet(new Error('offline'))
    // The failed recovery has nothing to deliver, but the broadcast kept during it gets its own attempt
    // once the first one settles — a second, independent call to get(), never a retry loop on its own.
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]!.host.models).toEqual([model('gpt-5')])
  })

  it('remembers the recovered catalog under the revision that triggered recovery, so a repeat needs no second fetch', async () => {
    const { bridge, emit, get } = fakeBridge(() => Promise.resolve(fullState([model('gpt-5')])))
    const delivered: AgentState[] = []
    wrapAgentBridge(bridge).onState(state => delivered.push(state))
    emit(broadcast({ revision: 3, omitted: true }))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    emit(broadcast({ revision: 3, omitted: true }))
    expect(delivered).toHaveLength(2)
    expect(delivered[1]!.host.models).toEqual([model('gpt-5')])
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('resolves host.models and every clientHosts[] catalog independently', () => {
    const { bridge, emit, get } = fakeBridge(() => Promise.reject(new Error('unused')))
    const delivered: AgentState[] = []
    wrapAgentBridge(bridge).onState(state => delivered.push(state))
    const hostA = 'aaaaaaaa-0000-4000-8000-000000000000'
    const hostB = 'bbbbbbbb-0000-4000-8000-000000000000'
    const primaryModels = [model('gpt-5')]
    const bModels = [model('grok-4')]
    emit(broadcast({ revision: 1, models: primaryModels },
      [{ hostId: hostA, models: { revision: 1, models: primaryModels } }, { hostId: hostB, models: { revision: 1, models: bModels } }]))
    // Next publish: the primary/hostA catalog repeats (omitted), hostB's changed.
    const newBModels = [model('grok-4', { ready: false })]
    emit(broadcast({ revision: 1, omitted: true },
      [{ hostId: hostA, models: { revision: 1, omitted: true } }, { hostId: hostB, models: { revision: 2, models: newBModels } }]))
    expect(delivered).toHaveLength(2)
    expect(delivered[1]!.host.models).toEqual(primaryModels)
    expect(delivered[1]!.host.clientHosts![0]!.models).toEqual(primaryModels)
    expect(delivered[1]!.host.clientHosts![1]!.models).toEqual(newBModels)
    expect(get).not.toHaveBeenCalled()
  })

  it('recovers when only one of several clientHosts catalogs is missing from cache', async () => {
    const hostA = 'aaaaaaaa-0000-4000-8000-000000000000'
    const hostB = 'bbbbbbbb-0000-4000-8000-000000000000'
    const recoveredA = [model('gpt-5')]
    const recoveredB = [model('grok-4')]
    const { bridge, emit } = fakeBridge(() => Promise.resolve(fullState(recoveredA, [{ hostId: hostA, models: recoveredA }, { hostId: hostB, models: recoveredB }])))
    const delivered: AgentState[] = []
    wrapAgentBridge(bridge).onState(state => delivered.push(state))
    // hostA is included, hostB is only named by revision and this window has never seen it.
    emit(broadcast({ revision: 1, models: recoveredA },
      [{ hostId: hostA, models: { revision: 1, models: recoveredA } }, { hostId: hostB, models: { revision: 1, omitted: true } }]))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]!.host.clientHosts!.find(client => client.hostId === hostB)!.models).toEqual(recoveredB)
  })

  it('reuses one array for host.models and the selected host\'s own clientHosts entry, so the page holds one copy', () => {
    const { bridge, emit } = fakeBridge(() => Promise.reject(new Error('unused')))
    const delivered: AgentState[] = []
    wrapAgentBridge(bridge).onState(state => delivered.push(state))
    // The wire shares one array for both fields (DesktopHostRouter.shell()); reassembly must not clone it apart.
    const sharedModels = [model('gpt-5')]
    emit(broadcast({ revision: 1, models: sharedModels }, [{ hostId: HOST, models: { revision: 1, models: sharedModels } }]))
    expect(delivered[0]!.host.models).toBe(delivered[0]!.host.clientHosts![0]!.models)
  })

  it('memoizes the wrapped bridge by identity, so a re-render gets the same instance back', () => {
    const { bridge } = fakeBridge(() => Promise.reject(new Error('unused')))
    expect(wrapAgentBridge(bridge)).toBe(wrapAgentBridge(bridge))
  })
})
