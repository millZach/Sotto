import { agentStateSchema, defaultAgentConfiguration, EMPTY_AGENT_HOST, publicProviderEntityId, type AgentState } from '../../src/shared/agents'

/**
 * A host's state that names OpenCode in every field of the shell that can name a provider, a model, a project or a thread
 * (#1107): what a host must leave out, every part of it, for a client whose hello does not accept `provider-opencode`.
 * Every OpenCode identifier spells `opencode`, so a test can say a value names it nowhere by reading its text.
 */
export const OPENCODE_EVERYWHERE = {
  hostId: '7b0c1f1e-5b8f-4d8e-9a55-2d6f0f3d1a01',
  zen: publicProviderEntityId('opencode', 'model', 'opencode/deepseek-v4.1-flash-free'),
  codexModel: publicProviderEntityId('codex', 'model', 'gpt-5.5'),
  opencodeProject: publicProviderEntityId('opencode', 'project', 'C:/work'),
  codexProject: 'codex-project',
  /** An OpenCode thread the host holds, and one it no longer holds that a Codex thread's links still name. */
  opencodeThread: 'opencode-thread', goneThread: 'opencode-gone',
  codexThread: 'codex-thread',
} as const

const at = '2026-10-17T00:00:00.000Z'
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const counts = { total: 1, carried: 1, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: false }
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const receipt = (threadId: string, n: number) => ({ threadId, draftId: uuid(n) })

export function openCodeEverywhere(): AgentState {
  const { hostId, zen, codexModel, opencodeProject, codexProject, opencodeThread, goneThread, codexThread } = OPENCODE_EVERYWHERE
  const opencodeRow = { id: 'opencode' as const, connection: 'connected' as const, name: 'OpenCode', version: '2.0.31', capabilities }
  const codexRow = { id: 'codex' as const, connection: 'connected' as const, name: 'Codex', version: '0.155.1', capabilities }
  const zenModel = { id: zen, provider: 'OpenCode', providerId: 'opencode' as const, name: 'DeepSeek V4.1 Flash', ready: true, source: 'OpenCode Zen' }
  const codexModelRow = { id: codexModel, provider: 'Codex', providerId: 'codex' as const, name: 'GPT-5.5', ready: true }
  const update = (id: 'codex' | 'opencode') => ({ id, installed: '1.0.0', behind: false, channel: 'npm' as const, canInstall: true, checkedAt: at })
  const draft = (threadId: string, n: number) => ({ threadId, draftId: uuid(n), text: `Draft ${n}`, attachments: [], requestId: null, updatedAt: at })
  return agentStateSchema.parse({
    hostId,
    configuration: { ...defaultAgentConfiguration(), provider: 'opencode', enabledProviders: ['opencode', 'codex'], disconnectedProviders: ['opencode'], defaultModelId: zen, newThreadModelId: zen },
    connection: 'connected', installedProviders: ['codex', 'opencode'],
    skillCatalogs: [
      // A catalog OpenCode could not read still names it: `refresh-thread-skills` records the error under its provider.
      { threadId: opencodeThread, providerId: 'opencode', cwd: 'C:/work', status: 'error', skills: [], errors: [], error: 'The skills could not be read.' },
      { threadId: codexThread, providerId: 'codex', cwd: 'C:/work', status: 'ready', skills: [], errors: [] },
    ],
    clientUpdates: [update('codex'), update('opencode')], clientUpdateRun: { total: 2, done: 0, line: ['opencode'] },
    host: { ...EMPTY_AGENT_HOST, hostId, connected: true, providers: [codexRow, opencodeRow], models: [codexModelRow, zenModel],
      projects: [{ id: codexProject, providerId: 'codex', title: 'Work', path: 'C:/work' }, { id: opencodeProject, providerId: 'opencode', title: 'Work', path: 'C:/work' }],
      clientHosts: [{ hostId, connected: true, models: [codexModelRow, zenModel], capabilities, providers: [codexRow, opencodeRow],
        clientUpdates: [update('codex'), update('opencode')], clientUpdateRun: { total: 1, done: 0, line: ['opencode'] }, enabledProviders: ['codex', 'opencode'], agentModelId: zen }],
      threads: [
        { id: codexThread, providerId: 'codex', projectId: codexProject, title: 'Codex work', modelId: codexModel, status: 'idle', requests: [],
          // A Codex thread that continues an OpenCode one, is continued on OpenCode, was delegated by and began from one.
          continuedFrom: { threadId: opencodeThread, provider: 'opencode', at },
          continuedIn: [{ threadId: goneThread, provider: 'opencode', at }, { threadId: 'claude-thread', provider: 'claude', at }],
          delegatedBy: opencodeThread, startedFrom: { threadId: opencodeThread, from: 'turn', route: 'fork', at },
          messages: [{ id: 'first', role: 'user', text: 'Carry on', createdAt: at, handover: { text: 'From before', provider: 'opencode', counts } }] },
        { id: opencodeThread, providerId: 'opencode', projectId: opencodeProject, title: 'OpenCode work', modelId: zen, status: 'running', messages: [], requests: [] },
      ] },
    activeThreadId: opencodeThread, activeProjectId: opencodeProject,
    draft: '', draftThreadId: opencodeThread, draftRequestId: null, composing: false,
    threadDrafts: [draft(opencodeThread, 1), draft(codexThread, 2)],
    threadDraftPersistence: [{ ...receipt(opencodeThread, 1), status: 'saved' }, { ...receipt(codexThread, 2), status: 'saved' }],
    deliveries: [{ ...receipt(opencodeThread, 3), status: 'accepted', createdAt: at, updatedAt: at }, { ...receipt(codexThread, 4), status: 'accepted', createdAt: at, updatedAt: at }],
    followups: [{ id: uuid(5), ...receipt(opencodeThread, 6), text: 'Next', attachments: [], createdAt: at, updatedAt: at, status: 'queued' },
      { id: uuid(7), ...receipt(codexThread, 8), text: 'Next', attachments: [], createdAt: at, updatedAt: at, status: 'queued' }],
    followupReceipts: [receipt(opencodeThread, 9), receipt(codexThread, 10)],
    deliveredDrafts: [receipt(opencodeThread, 11), receipt(codexThread, 12)],
    obsoleteDrafts: [receipt(opencodeThread, 13), receipt(codexThread, 14)],
    busyThreadIds: [opencodeThread, codexThread],
    unconfirmedSettings: [{ threadId: opencodeThread, modelId: zen }, { threadId: codexThread, modelId: codexModel }],
    globalLaneBusy: false, notice: '', error: null, credentials: { reasoning: false, secure: true },
  })
}

/**
 * The same state with no OpenCode thread, model, project or row left: only the links a Codex thread keeps to OpenCode
 * threads it continues or is continued in, the handover one of its messages carried, and a skill catalog still name it.
 */
export function openCodeOnlyInLinks(): AgentState {
  const state = openCodeEverywhere()
  const { codexThread, opencodeThread, codexModel } = OPENCODE_EVERYWHERE
  const keep = (threadId: string) => threadId !== opencodeThread
  return { ...state,
    configuration: { ...state.configuration, provider: 'codex', enabledProviders: ['codex'], disconnectedProviders: [], defaultModelId: codexModel, newThreadModelId: codexModel },
    installedProviders: ['codex'], clientUpdates: state.clientUpdates!.filter(item => item.id === 'codex'), clientUpdateRun: { total: 1, done: 0, line: [] },
    host: { ...state.host, clientHosts: [], providers: state.host.providers!.filter(row => row.id === 'codex'), models: state.host.models.filter(model => model.providerId === 'codex'),
      projects: state.host.projects.filter(project => project.providerId === 'codex'),
      // A delegation or a fork names its source by thread ID alone, which says nothing of a provider once that thread is gone.
      threads: state.host.threads.filter(thread => thread.id === codexThread).map(({ delegatedBy, startedFrom, ...thread }) => { void delegatedBy; void startedFrom; return thread }) },
    activeThreadId: null, activeProjectId: null, draftThreadId: null,
    threadDrafts: state.threadDrafts!.filter(item => keep(item.threadId)), threadDraftPersistence: state.threadDraftPersistence!.filter(item => keep(item.threadId)),
    deliveries: state.deliveries!.filter(item => keep(item.threadId)), followups: state.followups!.filter(item => keep(item.threadId)),
    followupReceipts: state.followupReceipts!.filter(item => keep(item.threadId)), deliveredDrafts: state.deliveredDrafts!.filter(item => keep(item.threadId)),
    obsoleteDrafts: state.obsoleteDrafts!.filter(item => keep(item.threadId)), busyThreadIds: [codexThread],
    unconfirmedSettings: state.unconfirmedSettings!.filter(item => keep(item.threadId)) }
}
