// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

// Counts the content comparisons the broadcaster makes, without changing what they answer.
const compare = vi.hoisted(() => ({ spy: null as unknown as ReturnType<typeof vi.fn> }))
vi.mock('node:util', async importOriginal => {
  const actual = await importOriginal<typeof import('node:util')>()
  compare.spy = vi.fn(actual.isDeepStrictEqual)
  return { ...actual, isDeepStrictEqual: compare.spy }
})
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentClientHost, type AgentModel, type AgentState, type AgentStateBroadcast } from '../../../src/shared/agents'

function model(id: string, overrides: Partial<AgentModel> = {}): AgentModel {
  return { id, provider: 'codex', name: id, ready: true, ...overrides }
}

function clientHost(hostId: string, models: AgentModel[]): AgentClientHost {
  return { hostId, connected: true, models, capabilities: EMPTY_AGENT_HOST.capabilities }
}

/** A shell whose only interesting field is its host's catalogs; everything else stays the fixed shape. */
function state(models: AgentModel[], clientHosts?: AgentClientHost[]): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected',
    host: { ...structuredClone(EMPTY_AGENT_HOST), hostId: 'aaaaaaaa-0000-4000-8000-000000000000', models, ...(clientHosts ? { clientHosts } : {}) },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
    draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [], pendingRequest: '',
    globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: false },
    reasoningAccounts: [],
  }
}

describe('AgentStateBroadcaster', () => {
  it('sends the catalog in full the first time and omits an unchanged repeat', () => {
    const broadcaster = new AgentStateBroadcaster()
    const sent: AgentStateBroadcast[] = []
    const first = state([model('gpt-5'), model('gpt-5-mini')])
    broadcaster.send(first, payload => { sent.push(payload); return true })
    expect(sent[0]!.host.models).toEqual({ revision: 1, models: first.host.models })

    // clientAgentState deep-clones on every shell, so a second, content-identical array is not the same
    // reference -- the broadcaster must still recognise it as unchanged.
    const second = state(first.host.models.map(entry => ({ ...entry })))
    broadcaster.send(second, payload => { sent.push(payload); return true })
    expect(sent[1]!.host.models).toEqual({ revision: 1, omitted: true })
  })

  it('sends the catalog again once its content changes', () => {
    const broadcaster = new AgentStateBroadcaster()
    const sent: AgentStateBroadcast[] = []
    broadcaster.send(state([model('gpt-5')]), payload => { sent.push(payload); return true })
    broadcaster.send(state([model('gpt-5', { ready: false })]), payload => { sent.push(payload); return true })
    expect(sent[0]!.host.models).toMatchObject({ revision: 1 })
    expect(sent[1]!.host.models).toMatchObject({ revision: 2, models: [model('gpt-5', { ready: false })] })
  })

  it('does not mark a catalog sent when delivery fails, so the next attempt sends it in full again', () => {
    const broadcaster = new AgentStateBroadcaster()
    const shell = state([model('gpt-5')])
    const failed: AgentStateBroadcast[] = []
    const delivered = broadcaster.send(shell, payload => { failed.push(payload); return false })
    expect(delivered).toBe(false)
    expect(failed[0]!.host.models).toMatchObject({ models: shell.host.models })
    const succeeded: AgentStateBroadcast[] = []
    broadcaster.send(shell, payload => { succeeded.push(payload); return true })
    // Nothing was ever confirmed delivered, so this window still needed the catalog in full.
    expect(succeeded[0]!.host.models).toMatchObject({ models: shell.host.models })
  })

  it('tracks a client host catalog apart from another connected host, and apart from the selected host', () => {
    const broadcaster = new AgentStateBroadcaster()
    const sent: AgentStateBroadcast[] = []
    const hostA = 'aaaaaaaa-0000-4000-8000-000000000000'
    const hostB = 'bbbbbbbb-0000-4000-8000-000000000000'
    const shellModels = [model('gpt-5')]
    const first = state(shellModels, [clientHost(hostA, shellModels), clientHost(hostB, [model('grok-4')])])
    broadcaster.send(first, payload => { sent.push(payload); return true })
    // host.models and the selected host's own clientHosts entry are the same array, so they share a revision.
    expect(sent[0]!.host.models).toMatchObject({ revision: 1 })
    expect(sent[0]!.host.clientHosts![0]!.models).toMatchObject({ revision: 1, models: shellModels })
    expect(sent[0]!.host.clientHosts![1]!.models).toMatchObject({ revision: 1, models: [model('grok-4')] })

    // Only host B's catalog changes; host A and the primary catalog stay omitted.
    const second = state(shellModels.map(entry => ({ ...entry })),
      [clientHost(hostA, shellModels.map(entry => ({ ...entry }))), clientHost(hostB, [model('grok-4', { ready: false })])])
    broadcaster.send(second, payload => { sent.push(payload); return true })
    expect(sent[1]!.host.models).toEqual({ revision: 1, omitted: true })
    expect(sent[1]!.host.clientHosts![0]!.models).toEqual({ revision: 1, omitted: true })
    expect(sent[1]!.host.clientHosts![1]!.models).toMatchObject({ revision: 2, models: [model('grok-4', { ready: false })] })
  })

  it('keys host.models and the selected host\'s own clientHosts entry apart, so a divergence between them cannot flip both forever', () => {
    const broadcaster = new AgentStateBroadcaster()
    const sent: AgentStateBroadcast[] = []
    const hostId = 'aaaaaaaa-0000-4000-8000-000000000000'
    const hostModels = [model('gpt-5')]
    const clientModels = [model('grok-4')]
    // Contrived: host.models and the selected host's own entry hold different content, which
    // `DesktopHostRouter.shell()` never does today but nothing stops it in principle.
    const send = () => broadcaster.send(state(hostModels, [clientHost(hostId, clientModels)]), payload => { sent.push(payload); return true })
    send()
    expect(sent[0]!.host.models).toMatchObject({ revision: 1, models: hostModels })
    expect(sent[0]!.host.clientHosts![0]!.models).toMatchObject({ revision: 1, models: clientModels })
    // Neither catalog changes on the next two publishes; a shared key would have kept flipping both
    // between full and omitted forever, since each would see the other's unrelated content as a change.
    send()
    send()
    expect(sent[1]!.host.models).toEqual({ revision: 1, omitted: true })
    expect(sent[1]!.host.clientHosts![0]!.models).toEqual({ revision: 1, omitted: true })
    expect(sent[2]!.host.models).toEqual({ revision: 1, omitted: true })
    expect(sent[2]!.host.clientHosts![0]!.models).toEqual({ revision: 1, omitted: true })
  })

  it('names every catalog in a command receipt by the revision the broadcast uses, and lists no models', () => {
    const broadcaster = new AgentStateBroadcaster()
    const hostA = 'aaaaaaaa-0000-4000-8000-000000000000'
    const hostB = 'bbbbbbbb-0000-4000-8000-000000000000'
    const shellModels = [model('gpt-5')]
    const shell = state(shellModels, [clientHost(hostA, shellModels), clientHost(hostB, [model('grok-4')])])
    const sent: AgentStateBroadcast[] = []
    broadcaster.send(shell, payload => { sent.push(payload); return true })

    const receipt = broadcaster.encodeReceipt(state(shellModels.map(entry => ({ ...entry })),
      [clientHost(hostA, shellModels.map(entry => ({ ...entry }))), clientHost(hostB, [model('grok-4')])]))
    expect(receipt.host.models).toEqual({ revision: 1, omitted: true })
    expect(receipt.host.clientHosts!.map(client => client.models)).toEqual([{ revision: 1, omitted: true }, { revision: 1, omitted: true }])
    // Everything but the catalogs is the shell as it was.
    expect({ ...receipt, host: { ...receipt.host, models: shell.host.models, clientHosts: shell.host.clientHosts } }).toEqual(shell)
  })

  it('advances the shared revision when a receipt sees a changed catalog, and records nothing as sent', () => {
    const broadcaster = new AgentStateBroadcaster()
    const sent: AgentStateBroadcast[] = []
    broadcaster.send(state([model('gpt-5')]), payload => { sent.push(payload); return true })
    const changed = state([model('gpt-5', { ready: false })])
    expect(broadcaster.encodeReceipt(changed).host.models).toEqual({ revision: 2, omitted: true })
    // The window was never sent revision 2, so its next broadcast carries it in full.
    broadcaster.send(changed, payload => { sent.push(payload); return true })
    expect(sent[1]!.host.models).toEqual({ revision: 2, models: changed.host.models })
  })

  it('compares a catalog shared by host.models and its clientHosts entry once per shell and receipt', () => {
    const broadcaster = new AgentStateBroadcaster()
    const hostId = 'aaaaaaaa-0000-4000-8000-000000000000'
    const fresh = (): AgentState => { const models = [model('gpt-5'), model('gpt-5-mini')]; return state(models, [clientHost(hostId, models)]) }
    const deliver = (): boolean => true
    broadcaster.send(fresh(), deliver)
    compare.spy.mockClear()
    const shell = fresh()
    broadcaster.send(shell, deliver)
    expect(compare.spy).toHaveBeenCalledTimes(1)
    compare.spy.mockClear()
    expect(broadcaster.encodeReceipt(fresh()).host.models).toEqual({ revision: 1, omitted: true })
    expect(compare.spy).toHaveBeenCalledTimes(1)
  })

  it('compares afresh when a catalog it compared gains a model in place, rather than reusing the answer', () => {
    const broadcaster = new AgentStateBroadcaster()
    const sent: AgentStateBroadcast[] = []
    const deliver = (payload: AgentStateBroadcast): boolean => { sent.push(payload); return true }
    broadcaster.send(state([model('gpt-5')]), deliver)
    const repeat = state([model('gpt-5')])
    broadcaster.send(repeat, deliver)
    expect(sent[1]!.host.models).toEqual({ revision: 1, omitted: true })
    // A shell is rebuilt, never edited; this is the edit that assumption rules out.
    repeat.host.models.push(model('gpt-5-mini'))
    broadcaster.send(repeat, deliver)
    expect(sent[2]!.host.models).toEqual({ revision: 2, models: repeat.host.models })
  })
})
