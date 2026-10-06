import { hostEntityKey, parseHostEntityKey, projectWorkingCopyDefaultKey } from '../../../shared/clientIdentity'
import { defaultNewThreadModelId, hostForThread, type AgentProject, type AgentState, type AgentThread } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import { nearestReasoningEffort, resolveNewThreadPermission } from '../../../shared/newThreadDefaults'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../../shared/threadActivity'
import type { AgentConnection } from './AgentContext'
import { draftThread, UNCONFIRMED_CREATION } from './draftThreads'
import { pendingSettingsStore, unconfirmedKinds } from './pendingSettings'

/** A creation on its way, handed over the moment it is issued so the thread can be shown without waiting. */
export interface ThreadCreationStart {
  /** The local record for the ID this window minted, to show until main's state carries the thread. */
  readonly thread: AgentThread
  /** Resolves null once main has the thread, or with the reason main refused it. Never rejects. */
  readonly created: Promise<string | null>
}

/** The host a project's own entities belong to, and a new thread in it with them. */
function projectHostId(state: AgentState, project: AgentProject): string | undefined {
  return project.hostId ?? parseHostEntityKey(project.id)?.hostId ?? state.hostId
}

/**
 * A remote host's thread as the desktop router publishes it: what reads `remoteHost` (the cloud iPhone, the browser,
 * the terminal) must not treat the draft as this computer's in the moment before main's state carries it.
 */
function draftHost(state: AgentState, project: AgentProject): Pick<AgentThread, 'hostId' | 'hostLabel' | 'remoteHost'> | undefined {
  const hostId = projectHostId(state, project)
  const connection = hostId === undefined ? undefined : state.connections?.find(item => item.hostId === hostId)
  if (connection === undefined) return undefined
  return { hostId, remoteHost: connection.kind === 'remote', ...((state.connections?.length ?? 0) > 1 ? { hostLabel: connection.name } : {}) }
}

/** What creation says when Settings would not say which working copy a thread starts in. */
export const WORKING_COPY_READ_ERROR = 'Could not read your working-copy default from Settings → Agents. Check your connection and try again.'

/**
 * A project's saved working-copy default, read fresh for each creation; rejects when Settings cannot say,
 * so a thread is never opened in a working copy the user did not choose.
 */
export async function projectWorkingCopy(state: AgentState, project: AgentProject): Promise<'independent' | 'shared'> {
  if (!window.sotto?.getSettings) return 'shared'
  const settings = await window.sotto.getSettings()
  return settings.projectThreadWorkingCopyDefaults[projectWorkingCopyDefaultKey(state, project.id)] || settings.threadWorkingCopyDefault
}

/**
 * A thread the project already has that was opened and never used: still on its default title, nothing sent, at rest
 * and not settled, with the current new-thread defaults. New thread returns to it instead of leaving another
 * empty thread behind (#347), without reviving settled work or carrying older choices into new work.
 */
export function unusedNewThread(state: AgentState, project: AgentProject): AgentThread | undefined {
  const { modelId, selectedModel, reasoningEffort, permission } = newThreadOptions(state, project)
  if (state.configuration.newThreadReasoningEffort && reasoningEffort === undefined) return undefined
  if (state.configuration.newThreadRuntimeMode && permission.runtimeMode === undefined && permission.providerMode === undefined) return undefined
  return state.host.threads.find(thread => thread.projectId === project.id && thread.titleSource === 'default' && thread.status === 'idle'
    && !isThreadClosed(thread) && !isWorkspaceThreadSettled(thread, project)
    && Object.keys(pendingSettingsStore.view(thread.id).pending).length === 0 && unconfirmedKinds(state, thread.id).size === 0
    && thread.modelId === modelId && (reasoningEffort === undefined || (thread.reasoningEffort ?? selectedModel?.defaultReasoningEffort) === reasoningEffort)
    && (permission.runtimeMode === undefined || thread.runtimeMode === permission.runtimeMode)
    && (permission.providerMode === undefined || thread.providerMode === permission.providerMode)
    && (thread.summary?.messageCount ?? thread.messages.length) === 0)
}

/** Read creation and reuse against the same host catalog and current Settings defaults. */
function newThreadOptions(state: AgentState, project: AgentProject) {
  const projectHost = hostForThread(state.host, { hostId: projectHostId(state, project) })
  const modelId = defaultNewThreadModelId(state.configuration, projectHost.models, state.reasoningAccounts)
  // A long-context variant the catalog does not list (`opus[1m]`) answers from its base model's entry.
  const selectedModel = resolveModel(projectHost.models, modelId)
  const configuration = state.configuration
  let reasoningEffort: string | undefined
  if (configuration.newThreadReasoningEffort) {
    const reference = resolveModel(projectHost.models, configuration.newThreadModelId)?.reasoningEfforts ?? selectedModel?.reasoningEfforts ?? []
    reasoningEffort = nearestReasoningEffort(configuration.newThreadReasoningEffort, reference, selectedModel?.reasoningEfforts ?? [])
  }
  const permission = resolveNewThreadPermission(selectedModel, configuration.newThreadRuntimeMode)
  return { modelId, selectedModel, reasoningEffort: reasoningEffort ?? selectedModel?.defaultReasoningEffort, permission }
}

/**
 * Open a new thread in `project` at once, on the defaults from Settings → Agents: the pen on a project row,
 * the empty Threads page's button and the project chooser all create the thread this way (issue #347). It
 * mints the thread's ID here so the caller can show it before main answers; a refusal resolves `created`
 * with the reason. The draft uses the same option helpers as main, so its chips show the defaults immediately.
 */
export async function beginNewThread(state: AgentState, command: AgentConnection['command'], project: AgentProject, managed = false): Promise<ThreadCreationStart | { readonly error: string }> {
  const { modelId, selectedModel, reasoningEffort, permission } = newThreadOptions(state, project)
  if (!modelId) return { error: 'No model is ready to start this thread. Connect a provider or choose one in Settings → Agents.' }
  let workingCopy: 'independent' | 'shared'
  try { workingCopy = await projectWorkingCopy(state, project) }
  catch { return { error: WORKING_COPY_READ_ERROR } }
  const worktreeChoices = workingCopy === 'independent' ? { startFromOrigin: true } : {}
  const threadId = hostEntityKey(projectHostId(state, project), crypto.randomUUID())
  const title = 'New thread'
  const thread = draftThread({ id: threadId, projectId: project.id, title, modelId, workingCopy, ...worktreeChoices,
    ...(selectedModel?.providerId ? { providerId: selectedModel.providerId } : {}),
    reasoningEffort, runtimeMode: permission.runtimeMode, providerMode: permission.providerMode, host: draftHost(state, project) })
  const created = command({ type: 'create-thread', threadId, projectId: project.id, title, modelId, titleSource: 'default', managed, workingCopy, ...worktreeChoices })
    .then(result => result === null ? UNCONFIRMED_CREATION : result.error, () => UNCONFIRMED_CREATION)
  return { thread, created }
}
