import { deferred } from '../../fixtures/deferred'
import { threadsStateFixture } from '../../fixtures/agentState'
import { afterEach, describe, expect, it } from 'vitest'
import { beginNewThread, unusedNewThread } from '../../../src/renderer/src/agents/newThread'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { defaultAgentConfiguration, type AgentState, type AgentThread } from '../../../src/shared/agents'
import { pendingSettingsStore, settingValues } from '../../../src/renderer/src/agents/pendingSettings'

const project = { id: 'project', title: 'Project', path: 'C:/project' }
const thread = (patch: Partial<AgentThread>): AgentThread => ({ id: 'thread', projectId: project.id, title: 'New thread', titleSource: 'default',
  modelId: 'codex:model', status: 'idle', requests: [], messages: [], ...patch })
const state = (threads: AgentThread[]): AgentState => (threadsStateFixture({ cloneOverrides: false,
    configuration: defaultAgentConfiguration(),
    host: { projects: [project], threads,
    models: [{ id: 'codex:model', name: 'Model', provider: 'Codex', providerId: 'codex', ready: true }] },
    topLevel: { assignments: [], queue: [], activeThreadId: null, activeProjectId: null,  } }))

/** Pressing New thread twice, or by accident, should not leave empty threads behind (#347). */
afterEach(() => pendingSettingsStore.clear())
describe('an unused new thread', () => {
  it('is found when the project already has one that was never used', () => {
    expect(unusedNewThread(state([thread({})]), project)?.id).toBe('thread')
  })

  it('does not reopen an empty thread from workspace-settled work', () => {
    expect(unusedNewThread(state([thread({ workspaceSettledAt: '2026-09-26T00:00:00.000Z' })]), project)).toBeUndefined()
    expect(unusedNewThread(state([thread({})]), { ...project, workspaceSettledAt: '2026-09-26T00:00:00.000Z' })).toBeUndefined()
  })

  it('does not reuse an empty thread with a different saved default model or effort', () => {
    const current = state([thread({ reasoningEffort: 'low' })])
    current.host.models = [{ id: 'codex:model', name: 'Model', provider: 'Codex', ready: true,
      reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }]
    current.configuration.newThreadModelId = 'codex:other'
    expect(unusedNewThread(current, project)).toBeUndefined()
    current.configuration.newThreadModelId = 'codex:model'
    current.configuration.newThreadReasoningEffort = 'high'
    expect(unusedNewThread(current, project)).toBeUndefined()
    current.configuration.newThreadReasoningEffort = 'low'
    expect(unusedNewThread(current, project)?.id).toBe('thread')
  })

  it.each(['model', 'effort'] as const)('does not reuse a thread while its %s change is in flight', kind => {
    const candidate = thread({ reasoningEffort: 'low' })
    const current = state([candidate])
    pendingSettingsStore.press(candidate.id, kind, kind === 'model' ? 'codex:other' : 'high',
      kind === 'model' ? { modelId: 'codex:other' } : { reasoningEffort: 'high' },
      () => deferred<AgentState | null>().promise, settingValues(current, candidate))
    expect(unusedNewThread(current, project)).toBeUndefined()
  })

  it.each([{ modelId: 'codex:other' }, { reasoningEffort: 'high' }])('does not reuse a thread with an unconfirmed change: %j', patch => {
    const current = state([thread({})])
    current.unconfirmedSettings = [{ threadId: 'thread', ...patch }]
    expect(unusedNewThread(current, project)).toBeUndefined()
  })

  it('does not reuse a thread when its saved effort cannot be resolved from the catalog', () => {
    const current = state([thread({ reasoningEffort: 'low' })])
    current.configuration.newThreadModelId = 'codex:model'
    current.configuration.newThreadReasoningEffort = 'high'
    current.host.models = []
    expect(unusedNewThread(current, project)).toBeUndefined()
  })

  it.each([true, false])('does not reuse a thread when its saved permission cannot be resolved (model present: %s)', modelPresent => {
    const current = state([thread({ runtimeMode: 'full-access' })])
    current.configuration.newThreadModelId = 'codex:model'
    current.configuration.newThreadRuntimeMode = 'approval-required'
    if (!modelPresent) current.host.models = []
    expect(unusedNewThread(current, project)).toBeUndefined()
  })

  it('reuses a matching provider profile when the saved runtime mode does not apply', () => {
    const current = state([thread({ providerMode: 'standard' })])
    current.configuration.newThreadRuntimeMode = 'approval-required'
    current.host.models[0]!.providerModes = [{ id: 'standard', name: 'Standard' }]
    expect(unusedNewThread(current, project)?.id).toBe('thread')
  })

  it('is not a thread that has been used, renamed, is running, settled or elsewhere', () => {
    const used = [
      thread({ messages: [{ id: 'm', role: 'user', text: 'Hello', createdAt: '2026-09-26T00:00:00.000Z' }] }),
      thread({ summary: { messageCount: 3 } as AgentThread['summary'] }),
      thread({ titleSource: 'user', title: 'Named' }),
      thread({ titleSource: 'generated', title: 'Fix the build' }),
      thread({ status: 'running' }),
      thread({ settledAt: '2026-09-26T00:00:00.000Z' }),
      thread({ settledOverride: 'settled' }),
      thread({ archivedAt: '2026-09-26T00:00:00.000Z' }),
      thread({ projectId: 'elsewhere' }),
    ]
    for (const candidate of used) expect(unusedNewThread(state([candidate]), project)).toBeUndefined()
  })
})

describe('a new thread shown before main confirms it', () => {
  const LOCAL = '11111111-1111-4111-8111-111111111111', REMOTE = '22222222-2222-4222-8222-222222222222'
  const twoHosts = (): AgentState => ({ ...state([]), hostId: LOCAL, connections: [
    { hostId: LOCAL, kind: 'local', name: 'This computer', connected: true }, { hostId: REMOTE, kind: 'remote', name: 'forge', connected: true }] })
  const draftFor = async (current: AgentState, hostId: string) => {
    const start = await beginNewThread(current, async () => current, { ...project, id: hostEntityKey(hostId, 'project'), hostId })
    if ('error' in start) throw new Error(start.error)
    return start.thread
  }
  // A thread on forge is remote from its first frame, so this computer's cloud iPhone, browser and terminal leave it alone.
  it('is marked with its remote host as main will publish it', async () => {
    expect(await draftFor(twoHosts(), REMOTE)).toMatchObject({ hostId: REMOTE, hostLabel: 'forge', remoteHost: true })
  })
  it('is not marked remote on this computer', async () => {
    const draft = await draftFor(twoHosts(), LOCAL)
    expect(draft).toMatchObject({ hostId: LOCAL, hostLabel: 'This computer' })
    expect(draft.remoteHost).toBeUndefined()
  })
})
