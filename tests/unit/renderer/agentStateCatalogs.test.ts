import { threadsStateFixture } from '../../fixtures/agentState'
import { describe, expect, it, vi } from 'vitest'
import { wrapAgentBridge } from '../../../src/renderer/src/agents/agentStateCatalogs'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentModel, type AgentState, type AgentWireBridge } from '../../../src/shared/agents'

function model(id: string, overrides: Partial<AgentModel> = {}): AgentModel {
  return { id, provider: 'codex', name: id, ready: true, ...overrides }
}

const HOST = 'aaaaaaaa-0000-4000-8000-000000000000'

/** A minimal, schema-shaped AgentState for a `get()` recovery reply. */
function fullState(models: AgentModel[], clientHosts?: { hostId: string; models: AgentModel[] }[]): AgentState {
  return threadsStateFixture({
    cloneOverrides: false,
    configuration: defaultAgentConfiguration(),
    host: { ...EMPTY_AGENT_HOST, hostId: HOST, models,
      ...(clientHosts ? { clientHosts: clientHosts.map(client => ({ hostId: client.hostId, connected: true, models: client.models, capabilities: EMPTY_AGENT_HOST.capabilities })) } : {}) },
    topLevel: { assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draftAttachments: [],
      credentials: { reasoning: false, grokSpeech: false, secure: false }, clientScoped: true },
  })
}

/** A raw broadcast payload, as it would cross the wire once encoded by AgentStateBroadcaster. */
function broadcast(hostModels: unknown, clientHosts?: { hostId: string; models: unknown }[]): unknown {
  return { ...fullState([]), host: { ...fullState([]).host, models: hostModels, ...(clientHosts ? { clientHosts } : {}) } }
}

/** A fake bridge whose `onState` hands back the raw handler the wrapper registered, so a test can feed
 * it broadcasts directly, the way the real preload's IPC subscription would. */
function fakeBridge(get: () => Promise<AgentState>): { bridge: AgentWireBridge; emit: (raw: unknown) => void; get: ReturnType<typeof vi.fn> } {
  let raw: ((value: unknown) => void) | null = null
  const getFn = vi.fn(get)
  const bridge = {
    get: getFn,
    command: vi.fn(),
    onState: (listener: (state: AgentState) => void) => { raw = listener as unknown as (value: unknown) => void; return () => { raw = null } },
  } as unknown as AgentWireBridge
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

  describe('command receipts', () => {
    /** A bridge whose `command` answers with the given receipts in turn, as main's handler would. */
    function receiptBridge(get: () => Promise<AgentState>, ...answers: unknown[]) {
      const fake = fakeBridge(get)
      ;(fake.bridge.command as ReturnType<typeof vi.fn>).mockImplementation(async () => answers.shift())
      return fake
    }
    const voice = { type: 'voice', action: 'mute' } as const

    it('puts back the catalog the broadcast sent, without asking main', async () => {
      const models = [model('gpt-5')]
      const { bridge, emit, get } = receiptBridge(() => Promise.reject(new Error('unused')), broadcast({ revision: 1, omitted: true }))
      const wrapped = wrapAgentBridge(bridge)
      wrapped.onState(() => undefined)
      emit(broadcast({ revision: 1, models }))
      const reply = await wrapped.command(voice)
      expect(reply.host.models).toBe(models)
      expect(get).not.toHaveBeenCalled()
    })

    it('answers with the receipt\'s own fields, never the recovery\'s', async () => {
      const recovered = { ...fullState([model('gpt-5')]), error: 'from get', configuration: { ...defaultAgentConfiguration(), speak: false } }
      const receipt = { ...(broadcast({ revision: 4, omitted: true }) as AgentState), threadDraftPersistence: [{ threadId: 't', draftId: '11111111-1111-4111-8111-111111111111', status: 'saved' as const }] }
      const { bridge } = receiptBridge(() => Promise.resolve(recovered), receipt)
      const reply = await wrapAgentBridge(bridge).command(voice)
      expect(reply.host.models).toEqual([model('gpt-5')])
      expect(reply.threadDraftPersistence).toEqual(receipt.threadDraftPersistence)
      expect(reply.error).toBeNull()
      expect(reply.configuration).toEqual(defaultAgentConfiguration())
    })

    it('files a catalog recovered for a receipt where the next broadcast naming it finds it', async () => {
      const { bridge, emit, get } = receiptBridge(() => Promise.resolve(fullState([model('gpt-5')])), broadcast({ revision: 2, omitted: true }))
      const wrapped = wrapAgentBridge(bridge)
      const delivered: AgentState[] = []
      wrapped.onState(state => delivered.push(state))
      await wrapped.command(voice)
      emit(broadcast({ revision: 2, omitted: true }))
      expect(delivered[0]!.host.models).toEqual([model('gpt-5')])
      expect(get).toHaveBeenCalledTimes(1)
    })

    it('stands in the catalog it last held when a recovery fails twice', async () => {
      const held = [model('gpt-5')]
      const { bridge, emit, get } = receiptBridge(() => Promise.reject(new Error('offline')), broadcast({ revision: 2, omitted: true }))
      const wrapped = wrapAgentBridge(bridge)
      wrapped.onState(() => undefined)
      emit(broadcast({ revision: 1, models: held }))
      expect((await wrapped.command(voice)).host.models).toBe(held)
      expect(get).toHaveBeenCalledTimes(2)
    })

    it('stands in the catalog the last get() listed when a recovery fails and no broadcast has landed', async () => {
      const read = [model('gpt-5')]
      let online = true
      const receipt = { ...(broadcast({ revision: 2, omitted: true }) as AgentState), notice: 'Saved.' }
      const { bridge } = receiptBridge(() => online ? Promise.resolve(fullState(read)) : Promise.reject(new Error('offline')), receipt)
      const wrapped = wrapAgentBridge(bridge)
      await wrapped.get()
      online = false
      const reply = await wrapped.command(voice)
      expect(reply.host.models).toBe(read)
      expect(reply.notice).toBe('Saved.')
    })

    it('still answers with the receipt when a recovery fails and the window holds no catalog, since main ran the command', async () => {
      const receipt = { ...(broadcast({ revision: 2, omitted: true }) as AgentState), notice: 'Saved.' }
      const { bridge, emit, get } = receiptBridge(() => Promise.reject(new Error('offline')), receipt)
      const wrapped = wrapAgentBridge(bridge)
      const delivered: AgentState[] = []
      wrapped.onState(state => delivered.push(state))
      const reply = await wrapped.command(voice)
      expect(reply.notice).toBe('Saved.')
      expect(reply.host.models).toEqual([])
      expect(get).toHaveBeenCalledTimes(2)
      // Main recorded no catalog as sent to this window, so its next broadcast carries it in full.
      const models = [model('gpt-5')]
      emit(broadcast({ revision: 2, models }))
      expect(delivered[0]!.host.models).toBe(models)
    })

    // Main never sends a bare catalog, and the preload refuses one from main's command
    // (agentCommandReceiptSchema), so the page does not trust one either: it asks main.
    it('recovers a catalog sent as a bare list rather than trusting it', async () => {
      const read = [model('gpt-5')]
      const { bridge, get } = receiptBridge(() => Promise.resolve(fullState(read)), fullState([model('stale')]))
      const reply = await wrapAgentBridge(bridge).command(voice)
      expect(reply.host.models).toBe(read)
      expect(get).toHaveBeenCalledTimes(1)
    })

    it('resolves a receipt naming an older revision from the newer catalog the window holds, without asking main', async () => {
      const newer = [model('gpt-5.1')]
      const { bridge, emit, get } = receiptBridge(() => Promise.reject(new Error('unused')), broadcast({ revision: 1, omitted: true }))
      const wrapped = wrapAgentBridge(bridge)
      wrapped.onState(() => undefined)
      emit(broadcast({ revision: 2, models: newer }))
      // Main built this receipt before the broadcast of revision 2 the window already has.
      expect((await wrapped.command(voice)).host.models).toBe(newer)
      expect(get).not.toHaveBeenCalled()
    })

    it('never files a recovery for an older revision over the newer catalog the window holds', async () => {
      const newer = [model('gpt-5.1')]
      let resolveGet: (value: AgentState) => void = () => undefined
      const { bridge, emit, get } = receiptBridge(() => new Promise<AgentState>(resolve => { resolveGet = resolve }), broadcast({ revision: 3, omitted: true }))
      const wrapped = wrapAgentBridge(bridge)
      const delivered: AgentState[] = []
      wrapped.onState(state => delivered.push(state))
      const reply = wrapped.command(voice)
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
      // Revision 4 lands in full while the recovery for revision 3 is in flight, and the recovery answers older.
      emit(broadcast({ revision: 4, models: newer }))
      resolveGet(fullState([model('gpt-5')]))
      expect((await reply).host.models).toBe(newer)
      emit(broadcast({ revision: 4, omitted: true }))
      expect(delivered[1]!.host.models).toBe(newer)
      expect(get).toHaveBeenCalledTimes(1)
    })

    it('recovers a receipt for another host on its own, even at the same revision while one is in flight', async () => {
      const hostB = 'bbbbbbbb-0000-4000-8000-000000000000'
      const modelsA = [model('gpt-5')]
      const modelsB = [model('grok-4')]
      const answers: Array<(value: AgentState) => void> = []
      const full = fullState(modelsA, [{ hostId: HOST, models: modelsA }, { hostId: hostB, models: modelsB }])
      // The selected host changes between two commands: each receipt names its own host's catalog at revision 1.
      const forB = broadcast({ revision: 1, omitted: true }) as AgentState
      const { bridge, get } = receiptBridge(() => new Promise<AgentState>(resolve => { answers.push(resolve) }),
        broadcast({ revision: 1, omitted: true }), { ...forB, host: { ...forB.host, hostId: hostB } })
      const wrapped = wrapAgentBridge(bridge)
      const first = wrapped.command(voice)
      const second = wrapped.command(voice)
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
      for (const answer of answers) answer(full)
      expect((await first).host.models).toEqual(modelsA)
      expect((await second).host.models).toEqual(modelsB)
    })

    it('asks main once more when a recovery fails, rather than failing a command main already ran', async () => {
      let calls = 0
      const { bridge, get } = receiptBridge(() => ++calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(fullState([model('gpt-5')])),
        broadcast({ revision: 2, omitted: true }))
      expect((await wrapAgentBridge(bridge).command(voice)).host.models).toEqual([model('gpt-5')])
      expect(get).toHaveBeenCalledTimes(2)
    })
  })
})
