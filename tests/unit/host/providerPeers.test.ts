// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { agentStateSchema, defaultAgentConfiguration, EMPTY_AGENT_HOST, publicProviderEntityId, type AgentState, type AgentThreadDetail } from '../../../src/shared/agents'
import { providersUnknownTo, PROVIDER_HOST_FEATURES } from '../../../src/shared/hostProtocol'
import { deltaWithoutProviders, detailWithoutProviders, eventsWithoutProviders, readWithoutProviders, stateWithoutProviders, type ProviderScope } from '../../../src/host/providerPeers'
import { OPENCODE_EVERYWHERE, openCodeEverywhere, openCodeOnlyInLinks } from '../../fixtures/openCodeEverywhere'

/**
 * What a host sends a desktop or phone from before OpenCode joined Sotto (#1107): such a client reads provider IDs against a
 * list without `opencode` and refuses a whole shell that names it (Bug Bot OC-OLD-PEER-REJECTS-STATE on #1126), so it is
 * sent nothing of OpenCode's at all.
 */
const zen = publicProviderEntityId('opencode', 'model', 'opencode/deepseek-v4.1-flash-free')
const codexModel = publicProviderEntityId('codex', 'model', 'gpt-5.5')
const opencodeProject = publicProviderEntityId('opencode', 'project', 'C:/work')
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const checkedAt = '2026-10-17T00:00:00.000Z'
const draft = (threadId: string, text: string, draftId: string) => ({ threadId, draftId, text, attachments: [], requestId: null, updatedAt: checkedAt })
const thread = (id: string, providerId: 'codex' | 'opencode', projectId: string, modelId: string) =>
  ({ id, providerId, projectId, title: id, modelId, status: 'idle', messages: [], requests: [] })
function hostState(): AgentState {
  return agentStateSchema.parse({
    configuration: { ...defaultAgentConfiguration(), provider: 'opencode', enabledProviders: ['opencode', 'codex'], disconnectedProviders: ['opencode'], defaultModelId: zen, newThreadModelId: zen },
    connection: 'connected', installedProviders: ['codex', 'opencode'],
    host: { ...EMPTY_AGENT_HOST, connected: true,
      providers: [{ id: 'codex', connection: 'connected', name: 'Codex', version: '0.155.1', capabilities }, { id: 'opencode', connection: 'connected', name: 'OpenCode', version: '2.0.31', capabilities }],
      models: [{ id: codexModel, provider: 'Codex', providerId: 'codex', name: 'GPT-5.5', ready: true },
        { id: zen, provider: 'OpenCode', providerId: 'opencode', name: 'DeepSeek V4.1 Flash', ready: true, source: 'OpenCode Zen' }],
      projects: [{ id: 'codex-project', providerId: 'codex', title: 'Work', path: 'C:/work' }, { id: opencodeProject, providerId: 'opencode', title: 'Work', path: 'C:/work' }],
      threads: [thread('codex-thread', 'codex', 'codex-project', codexModel), thread('opencode-thread', 'opencode', opencodeProject, zen)] },
    clientUpdates: [{ id: 'codex', installed: '0.155.1', behind: false, channel: 'npm', canInstall: true, checkedAt }, { id: 'opencode', installed: '2.0.31', published: '2.0.32', behind: true, channel: 'self-update', canInstall: true, checkedAt }],
    clientUpdateRun: { total: 2, done: 0, line: ['opencode'] },
    threadDrafts: [draft('opencode-thread', 'Draft for OpenCode', '11111111-1111-4111-8111-111111111111'), draft('codex-thread', 'Draft for Codex', '22222222-2222-4222-8222-222222222222')],
    activeThreadId: 'opencode-thread', activeProjectId: null,
    draft: '', draftThreadId: 'opencode-thread', draftRequestId: null, composing: false, globalLaneBusy: false, notice: '', error: null,
    credentials: { reasoning: false, secure: true },
  })
}

describe('a client that does not know OpenCode', () => {
  it('is a client whose hello does not accept provider-opencode', () => {
    expect(PROVIDER_HOST_FEATURES).toEqual({ opencode: 'provider-opencode', cursor: 'provider-cursor' })
    expect([...providersUnknownTo(undefined)]).toEqual(['opencode', 'cursor'])
    expect([...providersUnknownTo(['detail-delta', 'model-catalog-revision'])]).toEqual(['opencode', 'cursor'])
    // A phone that knows OpenCode but not Cursor (ADR-0127) is sent OpenCode and nothing of Cursor's.
    expect([...providersUnknownTo(['detail-delta', 'provider-opencode'])]).toEqual(['cursor'])
    expect([...providersUnknownTo(['detail-delta', 'provider-opencode', 'provider-cursor'])]).toEqual([])
  })

  it('is sent a shell that names OpenCode nowhere: no row, model, project, thread, draft, client update or setting', () => {
    const state = hostState()
    const view = stateWithoutProviders(state, providersUnknownTo(undefined))
    expect(JSON.stringify(view).toLowerCase()).not.toContain('opencode')
    // Everything else is as the host holds it, and still reads under the shell's own schema.
    expect(agentStateSchema.safeParse(view).success).toBe(true)
    expect(view.host.threads.map(item => item.id)).toEqual(['codex-thread'])
    expect(view.host.models.map(item => item.id)).toEqual([codexModel])
    expect(view.host.projects.map(item => item.id)).toEqual(['codex-project'])
    expect(view.host.providers?.map(item => item.id)).toEqual(['codex'])
    expect(view.configuration).toMatchObject({ provider: 'codex', enabledProviders: ['codex'], disconnectedProviders: [], defaultModelId: '', newThreadModelId: '' })
    expect(view.installedProviders).toEqual(['codex'])
    expect(view.clientUpdates?.map(item => item.id)).toEqual(['codex'])
    expect(view.clientUpdateRun?.line).toEqual([])
    expect(view.threadDrafts?.map(item => item.threadId)).toEqual(['codex-thread'])
    expect([view.activeThreadId, view.draftThreadId]).toEqual([null, null])
    // The host's own state is never edited.
    expect(JSON.stringify(state)).toContain('opencode-thread')
  })

  it('is sent the shell itself when it names no OpenCode, and a client that knows OpenCode always is', () => {
    const state = hostState()
    expect(stateWithoutProviders(state, providersUnknownTo(['provider-opencode']))).toBe(state)
    const without = stateWithoutProviders(state, providersUnknownTo(undefined))
    expect(stateWithoutProviders(without, providersUnknownTo(undefined))).toBe(without)
  })

  it('reads a handover from an OpenCode thread as the message alone, in a detail and a delta', () => {
    const counts = { total: 1, carried: 1, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: false }
    const message = { id: 'first', role: 'user' as const, text: 'Carry on', createdAt: '2026-10-17T00:00:00.000Z', handover: { text: 'From OpenCode', provider: 'opencode' as const, counts } }
    const detail = { threadId: 'codex-thread', revision: 3, messages: [message, { ...message, id: 'second', handover: { ...message.handover, provider: 'claude' as const } }] } as unknown as AgentThreadDetail
    const unknown = providersUnknownTo(undefined)
    const read = detailWithoutProviders(detail, unknown)
    expect(read.messages.map(item => item.handover?.provider ?? null)).toEqual([null, 'claude'])
    expect(read.messages[0]!.text).toBe('Carry on')
    expect(detailWithoutProviders(detail, providersUnknownTo(['provider-opencode']))).toBe(detail)
    const delta = { threadId: 'codex-thread', baseRevision: 2, revision: 3, messageDeltas: [{ message }], activityDeltas: [] } as never
    expect(JSON.stringify(deltaWithoutProviders(delta, unknown))).not.toContain('opencode')
  })

  it('is sent no Watcher row or worker of OpenCode in a read', () => {
    const read = { status: 'ok', result: { threads: [{ provider: 'codex', title: 'A' }, { provider: 'opencode', title: 'B' }],
      projects: [{ title: 'Work', workers: [{ provider: 'opencode', modelId: zen }, { provider: 'claude', modelId: 'claude:opus' }] }] } }
    expect(readWithoutProviders(read, scope)).toEqual({ status: 'ok', result: { threads: [{ provider: 'codex', title: 'A' }],
      projects: [{ title: 'Work', workers: [{ provider: 'claude', modelId: 'claude:opus' }] }] } })
  })

  it('is sent no Watcher row that names an OpenCode thread or project by its target alone', () => {
    const { hostId, opencodeThread, codexThread, opencodeProject, codexProject } = OPENCODE_EVERYWHERE
    const read = { status: 'ok', projects: [{ target: { hostId, projectId: opencodeProject }, title: 'Work', workers: [] }, { target: { hostId, projectId: codexProject }, title: 'Work', workers: [] }],
      rows: [{ target: { hostId, threadId: codexThread }, waitsOn: [{ id: 'q', kind: 'question', label: 'Which?', openTarget: { hostId, threadId: opencodeThread } }] }],
      operations: [{ id: 'a', target: { hostId, threadId: opencodeThread } }, { id: 'b', target: { hostId, threadId: codexThread } }],
      evidence: [{ id: 'e', target: { hostId, threadId: opencodeThread } }], terminals: [{ id: 't', projectId: opencodeProject }] }
    const view = readWithoutProviders(read, scope)
    expect(JSON.stringify(view)).not.toContain('opencode')
    expect(view).toEqual({ status: 'ok', projects: [{ target: { hostId, projectId: codexProject }, title: 'Work', workers: [] }],
      rows: [{ target: { hostId, threadId: codexThread }, waitsOn: [] }], operations: [{ id: 'b', target: { hostId, threadId: codexThread } }], evidence: [], terminals: [] })
  })
})

/** How the host tells an OpenCode thread or project apart for a peer that does not know OpenCode, as the socket server asks it. */
const scope: ProviderScope = { providers: providersUnknownTo(undefined), thread: id => id.startsWith('opencode'), project: id => id === OPENCODE_EVERYWHERE.opencodeProject }

describe('a whole shell with OpenCode in every field', () => {
  const at = '2026-10-17T00:00:00.000Z'
  it('reaches a client that does not know OpenCode with none of it, and every other part as the host holds it', () => {
    const state = openCodeEverywhere()
    const { codexThread } = OPENCODE_EVERYWHERE
    const view = stateWithoutProviders(state, providersUnknownTo(undefined))
    expect(JSON.stringify(view).toLowerCase()).not.toContain('opencode')
    expect(agentStateSchema.safeParse(view).success).toBe(true)
    // The Codex thread keeps its own links and words, and loses only what names OpenCode.
    const codex = view.host.threads.find(item => item.id === codexThread)!
    expect(codex.continuedIn).toEqual([{ threadId: 'claude-thread', provider: 'claude', at }])
    expect([codex.continuedFrom, codex.delegatedBy, codex.startedFrom, codex.messages[0]!.handover]).toEqual([undefined, undefined, undefined, undefined])
    expect(codex.messages[0]!.text).toBe('Carry on')
    for (const list of [view.skillCatalogs, view.threadDrafts, view.threadDraftPersistence, view.deliveries, view.followups, view.followupReceipts,
      view.deliveredDrafts, view.obsoleteDrafts, view.unconfirmedSettings]) expect(list!.map(item => item.threadId)).toEqual([codexThread])
    expect(view.busyThreadIds).toEqual([codexThread])
    expect([view.activeThreadId, view.activeProjectId, view.draftThreadId]).toEqual([null, null, null])
    expect(view.host.clientHosts?.[0]?.agentModelId).toBeUndefined()
    // The host's own state is never edited.
    expect(JSON.stringify(state)).toContain('"provider":"opencode"')
  })

  it('is scrubbed when only a Codex thread’s links, a handover or a skill catalog name OpenCode', () => {
    const state = openCodeOnlyInLinks()
    const view = stateWithoutProviders(state, providersUnknownTo(undefined))
    expect(JSON.stringify(state).toLowerCase()).toContain('opencode')
    expect(JSON.stringify(view).toLowerCase()).not.toContain('opencode')
    expect(agentStateSchema.safeParse(view).success).toBe(true)
  })

  it('sends an event page with no handover from an OpenCode thread, keeping the message itself', () => {
    const counts = { total: 1, carried: 1, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: false }
    const message = { id: 'first', role: 'user' as const, text: 'Carry on', createdAt: at, handover: { text: 'From before', provider: 'opencode' as const, counts } }
    const page = [{ seq: 1, threadId: 'codex-thread', event: { kind: 'message-added' as const, at, message } },
      { seq: 2, threadId: 'codex-thread', event: { kind: 'message-replaced' as const, at, message: { ...message, text: 'Carry on, please' } } },
      { seq: 3, threadId: 'codex-thread', event: { kind: 'message-text-appended' as const, at, messageId: 'first', appendText: '!' } }]
    const view = eventsWithoutProviders(page, providersUnknownTo(undefined))
    expect(JSON.stringify(view)).not.toContain('opencode')
    expect(view.map(row => row.seq)).toEqual([1, 2, 3])
    expect(eventsWithoutProviders(page, providersUnknownTo(['provider-opencode']))).toBe(page)
  })
})
