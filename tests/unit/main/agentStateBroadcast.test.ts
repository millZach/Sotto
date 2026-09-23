// @vitest-environment node
import { describe, expect, it } from 'vitest'
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
    membership: { status: 'active', label: 'Sotto', expiresAt: null },
  }
}

describe('AgentStateBroadcaster', () => {
  it('sends the catalog in full the first time and omits an unchanged repeat', () => {
    const broadcaster = new AgentStateBroadcaster()
    const sent: AgentStateBroadcast[] = []
    const first = state([model('gpt-5'), model('gpt-5-mini')])
    broadcaster.send(first, 'main', payload => { sent.push(payload); return true })
    expect(sent[0]!.host.models).toEqual({ revision: 1, models: first.host.models })

    // clientAgentState deep-clones on every shell, so a second, content-identical array is not the same
    // reference -- the broadcaster must still recognise it as unchanged.
    const second = state(first.host.models.map(entry => ({ ...entry })))
    broadcaster.send(second, 'main', payload => { sent.push(payload); return true })
    expect(sent[1]!.host.models).toEqual({ revision: 1, omitted: true })
  })

  it('sends the catalog again once its content changes', () => {
    const broadcaster = new AgentStateBroadcaster()
    const sent: AgentStateBroadcast[] = []
    broadcaster.send(state([model('gpt-5')]), 'main', payload => { sent.push(payload); return true })
    broadcaster.send(state([model('gpt-5', { ready: false })]), 'main', payload => { sent.push(payload); return true })
    expect(sent[0]!.host.models).toMatchObject({ revision: 1 })
    expect(sent[1]!.host.models).toMatchObject({ revision: 2, models: [model('gpt-5', { ready: false })] })
  })

  it('tracks each destination window apart: the widget still needs its own first send', () => {
    const broadcaster = new AgentStateBroadcaster()
    const mainSent: AgentStateBroadcast[] = []
    const widgetSent: AgentStateBroadcast[] = []
    const shell = state([model('gpt-5')])
    broadcaster.send(shell, 'main', payload => { mainSent.push(payload); return true })
    broadcaster.send(shell, 'main', payload => { mainSent.push(payload); return true })
    broadcaster.send(shell, 'widget', payload => { widgetSent.push(payload); return true })
    expect(mainSent[0]!.host.models).toMatchObject({ revision: 1, models: shell.host.models })
    expect(mainSent[1]!.host.models).toEqual({ revision: 1, omitted: true })
    // The widget has never been sent revision 1, so its first send is full even though main's was not.
    expect(widgetSent[0]!.host.models).toMatchObject({ revision: 1, models: shell.host.models })
  })

  it('does not mark a catalog sent when delivery fails, so the next attempt sends it in full again', () => {
    const broadcaster = new AgentStateBroadcaster()
    const shell = state([model('gpt-5')])
    const failed: AgentStateBroadcast[] = []
    const delivered = broadcaster.send(shell, 'main', payload => { failed.push(payload); return false })
    expect(delivered).toBe(false)
    expect(failed[0]!.host.models).toMatchObject({ models: shell.host.models })
    const succeeded: AgentStateBroadcast[] = []
    broadcaster.send(shell, 'main', payload => { succeeded.push(payload); return true })
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
    broadcaster.send(first, 'main', payload => { sent.push(payload); return true })
    // host.models and the selected host's own clientHosts entry are the same array, so they share a revision.
    expect(sent[0]!.host.models).toMatchObject({ revision: 1 })
    expect(sent[0]!.host.clientHosts![0]!.models).toMatchObject({ revision: 1, models: shellModels })
    expect(sent[0]!.host.clientHosts![1]!.models).toMatchObject({ revision: 1, models: [model('grok-4')] })

    // Only host B's catalog changes; host A and the primary catalog stay omitted.
    const second = state(shellModels.map(entry => ({ ...entry })),
      [clientHost(hostA, shellModels.map(entry => ({ ...entry }))), clientHost(hostB, [model('grok-4', { ready: false })])])
    broadcaster.send(second, 'main', payload => { sent.push(payload); return true })
    expect(sent[1]!.host.models).toEqual({ revision: 1, omitted: true })
    expect(sent[1]!.host.clientHosts![0]!.models).toEqual({ revision: 1, omitted: true })
    expect(sent[1]!.host.clientHosts![1]!.models).toMatchObject({ revision: 2, models: [model('grok-4', { ready: false })] })
  })
})
