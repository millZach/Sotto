import { threadsStateFixture } from '../../fixtures/agentState'
import { describe, expect, it, vi } from 'vitest'
import { beginNewThread } from '../../../src/renderer/src/agents/newThread'
import { shownWords } from '../../../src/renderer/src/agents/interfaceWords'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { defaultAgentConfiguration, type AgentCommand, type AgentConfiguration, type AgentModel, type AgentState } from '../../../src/shared/agents'

const LOCAL = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222'
const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const sonnet: AgentModel = { id: 'claude:sonnet', name: 'Claude Sonnet', provider: 'Claude', providerId: 'claude', ready: true,
  reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] }
const codex: AgentModel = { id: 'codex:gpt', name: 'GPT', provider: 'Codex', providerId: 'codex', ready: true, recommended: true,
  reasoningEfforts: ['low', 'medium', 'high'], runtimeModes: ['approval-required', 'auto', 'full-access'] }

/** This computer and forge, with this computer's defaults over the selected host's as the router publishes them. */
function computers(configuration: Partial<AgentConfiguration>, forge: { models?: AgentModel[]; mayAnswer?: boolean } = {}): AgentState {
  const forgeModels = forge.models ?? [sonnet, codex]
  return { ...threadsStateFixture({ cloneOverrides: false, configuration: { ...defaultAgentConfiguration(), ...configuration },
    host: { projects: [], threads: [], models: [sonnet, codex], clientHosts: [
      { hostId: LOCAL, connected: true, models: [sonnet, codex], capabilities: caps, mayAnswer: true },
      { hostId: FORGE, connected: true, models: forgeModels, capabilities: caps, mayAnswer: forge.mayAnswer ?? true }] },
    topLevel: { activeThreadId: null, activeProjectId: null } }), hostId: LOCAL,
  connections: [{ hostId: LOCAL, kind: 'local', name: 'This computer', connected: true }, { hostId: FORGE, kind: 'remote', name: 'forge', connected: true }] }
}
async function create(state: AgentState, hostId: string): Promise<Extract<AgentCommand, { type: 'create-thread' }>> {
  const command = vi.fn(async (_command: AgentCommand) => { void _command; return state })
  const start = await beginNewThread(state, command, { id: hostEntityKey(hostId, 'project'), hostId, title: 'Project', path: '/repo' })
  if ('error' in start) throw new Error(shownWords(start.error))
  await start.created
  return command.mock.calls[0]![0] as Extract<AgentCommand, { type: 'create-thread' }>
}

describe('a new thread on any computer starts on this computer’s defaults (ADR-0074)', () => {
  it('sends the default model, effort and permission to a remote host, which would otherwise use its own', async () => {
    const sent = await create(computers({ newThreadModelId: 'claude:sonnet', newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'auto' }), FORGE)
    expect(sent).toMatchObject({ modelId: 'claude:sonnet', reasoningEffort: 'high', runtimeMode: 'auto' })
  })
  it('sends the same on this computer', async () => {
    const sent = await create(computers({ newThreadModelId: 'claude:sonnet', newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'auto' }), LOCAL)
    expect(sent).toMatchObject({ modelId: 'claude:sonnet', reasoningEffort: 'high', runtimeMode: 'auto' })
  })
  it('starts on the host’s recommended model where its catalog does not list the default', async () => {
    const sent = await create(computers({ newThreadModelId: 'claude:sonnet', newThreadReasoningEffort: 'high' }, { models: [codex] }), FORGE)
    expect(sent).toMatchObject({ modelId: 'codex:gpt', reasoningEffort: 'high' })
  })
  it('maps the effort by its position among the default model’s levels, on the host’s model', async () => {
    const opus: AgentModel = { ...sonnet, id: 'claude:opus', name: 'Claude Opus', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] }
    // The router hands the window this computer's model already resolved, inherited or chosen.
    const state = computers({ newThreadModelId: 'claude:opus', newThreadReasoningEffort: 'xhigh' }, { models: [codex] })
    state.host.clientHosts![0]!.models = [opus, codex]
    expect(await create(state, FORGE)).toMatchObject({ modelId: 'codex:gpt', reasoningEffort: 'high' })
    expect(await create(state, LOCAL)).toMatchObject({ modelId: 'claude:opus', reasoningEffort: 'xhigh' })
  })
  it('opens on the host’s recommended model when this computer has no model to offer', async () => {
    const state = computers({})
    state.host.clientHosts![0]!.models = []
    expect((await create(state, FORGE)).modelId).toBe('codex:gpt')
  })
  it('takes the model the router resolved while another host is selected, even an empty one', async () => {
    const state = { ...computers({ newThreadModelId: '' }), hostId: FORGE }
    state.host.models = [codex]
    // This computer has no model to offer, so forge's recommended one starts the thread, never one inferred from forge's settings.
    state.host.clientHosts![0]!.models = []
    expect((await create(state, FORGE)).modelId).toBe('codex:gpt')
  })
  it('keeps the default on this computer even while its provider is away, so the thread can say what to connect', async () => {
    const state = computers({ newThreadModelId: 'claude:opus' })
    expect((await create(state, LOCAL)).modelId).toBe('claude:opus')
  })
  it('starts asking on a host that does not let this computer answer, instead of a permission that grants', async () => {
    const state = computers({ newThreadModelId: 'claude:sonnet', newThreadRuntimeMode: 'full-access' }, { mayAnswer: false })
    expect((await create(state, FORGE)).runtimeMode).toBe('approval-required')
    expect((await create(state, LOCAL)).runtimeMode).toBe('full-access')
  })
  it('leaves effort and permission to the host where no default chose them', async () => {
    const sent = await create(computers({ newThreadModelId: 'claude:sonnet' }), FORGE)
    expect(sent).not.toHaveProperty('reasoningEffort')
    expect(sent).not.toHaveProperty('runtimeMode')
  })
})
