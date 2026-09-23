import type { AgentCommand, AgentConfiguration } from '../shared/agents'

type CommandType = AgentCommand['type']
type Fields<T extends CommandType> = readonly Exclude<keyof Extract<AgentCommand, { type: T }>, 'type'>[]

/**
 * Every command a paired client may send over the socket, and every field it may carry. The list is
 * closed: a command type or field added to `agentCommandSchema` is refused remotely until it is added
 * here on purpose, because a paired device is not the user at this computer (ADR-0004). Anything
 * absent is host-local: credentials, membership, the voice commands and voice engine, reasoning checks,
 * opening a folder on the host machine and installing provider client updates.
 */
export const REMOTE_COMMANDS: { readonly [T in CommandType]?: Fields<T> } = {
  configure: ['patch'],
  connect: ['provider'], disconnect: ['provider'], refresh: ['provider'],
  'refresh-thread-skills': ['threadId', 'forceReload'],
  'check-client-updates': [], 'dismiss-client-updates': [],
  compose: ['text', 'attachments'],
  'save-thread-draft': ['threadId', 'draftId', 'text', 'attachments', 'skills', 'files', 'requestId', 'composer'],
  'recover-draft': ['threadId'], send: [],
  'manual-send': ['threadId', 'text', 'attachments', 'skills', 'files', 'draftId'],
  'queue-followup': ['threadId', 'draftId', 'text', 'attachments', 'skills', 'files'],
  'edit-followup': ['threadId', 'itemId', 'text', 'attachments', 'skills', 'files'],
  'steer-followup': ['threadId', 'itemId'], 'remove-followup': ['threadId', 'itemId'],
  'reorder-followups': ['threadId', 'itemIds'], 'resume-followups': ['threadId'],
  steer: ['threadId', 'draftId', 'text', 'attachments', 'skills', 'files'],
  'cancel-draft': [], 'pause-draft': [], 'resume-draft': ['threadId'], 'cancel-request': [],
  'create-project': ['provider', 'title', 'path', 'useExisting'],
  'select-project': ['projectId'], 'settle-project': ['projectId'], 'restore-project': ['projectId'],
  'settle-thread': ['threadId'], 'restore-thread': ['threadId'],
  'rename-thread': ['threadId', 'title'], 'regenerate-thread-title': ['threadId'],
  'create-thread': ['projectId', 'title', 'modelId', 'titleSource', 'threadId', 'workingCopy', 'baseBranch', 'startFromOrigin',
    'existingWorktreePath', 'reasoningEffort', 'runtimeMode', 'providerMode', 'managed'],
  'retry-thread-worktree': ['threadId'], 'refresh-thread-worktree': ['threadId'],
  'restore-thread-branch': ['threadId', 'withUncommittedChanges'],
  'reclaim-thread-worktree': ['threadId', 'withUncommittedChanges'],
  'configure-thread-working-copy': ['threadId', 'workingCopy', 'baseBranch', 'startFromOrigin', 'existingWorktreePath'],
  // The Git actions run on the host's own folder and discard nothing: Git refuses a switch that would lose work,
  // a push is never forced, and a pull is fast-forward only (ADR-0027).
  'git-action': ['threadId', 'actionId', 'action', 'commitMessage', 'featureBranch', 'filePaths', 'allowDefaultBranch'],
  'git-pull': ['threadId'], 'git-switch-branch': ['threadId', 'ref', 'create'], 'git-init': ['threadId'],
  'git-publish': ['threadId', 'repository', 'visibility'],
  'configure-thread': ['threadId', 'modelId', 'reasoningEffort', 'runtimeMode', 'providerMode'],
  'select-thread': ['threadId'], 'observe-threads': ['threadIds'], 'load-earlier-messages': ['threadId'],
  'select-attention': ['itemId'],
  assign: ['threadId', 'instruction', 'expectedDraftId'], unassign: ['threadId'],
  resume: ['threadId', 'expectedDraftId'], pause: ['threadId'], interrupt: ['threadId'], 'compact-thread': ['threadId'],
  next: [], later: [],
  answer: ['threadId', 'requestId', 'answer', 'approved', 'questionAnswers', 'permissionChoice'],
}
/**
 * The coordinator settings a paired client may change. Keys, endpoints and the voice engine (speech
 * provider, voices, wake word) stay on the host. Turning spoken replies on or off and the orb colour are
 * preferences, and the follow-up limit only bounds work the user already assigned, which a paired device
 * may send itself; none of them answers a request.
 */
export const REMOTE_CONFIGURATION_FIELDS: readonly (keyof AgentConfiguration)[] = ['provider', 'enabledProviders', 'enabled', 'defaultModelId',
  'reasoning', 'reasoningModel', 'reasoningEffort', 'followupLimit', 'orbColor', 'speak']

/**
 * Whether a remote command changes what a thread may do without asking, or discards work the user has
 * not committed. Each is the user's answer to a question, so it needs the same remote-answer policy
 * record an answer does. A permission setting whose allowance is nothing grants nothing and is free, so a
 * paired device can always put a thread back to asking: Sotto's own `approval-required` runtime mode, and
 * the provider modes `askingProviderModes` names for the thread's model, by what each allows rather than by
 * where it sits in the list, because the list is only the modes the provider happens to report.
 */
export function remoteCommandNeedsAnswerPolicy(command: AgentCommand, askingProviderModes: readonly string[]): boolean {
  switch (command.type) {
    case 'answer': return true
    case 'create-thread': case 'configure-thread':
      return (command.runtimeMode !== undefined && command.runtimeMode !== 'approval-required')
        || (command.providerMode !== undefined && !askingProviderModes.includes(command.providerMode))
    case 'restore-thread-branch': case 'reclaim-thread-worktree': return command.withUncommittedChanges === true
    default: return false
  }
}

/** Why a paired client may not send this command, or null when it may. */
export function remoteCommandRefusal(command: AgentCommand, context: { readonly mayAnswer: boolean; readonly askingProviderModes?: readonly string[] | undefined }): 'forbidden' | null {
  const fields = REMOTE_COMMANDS[command.type] as readonly string[] | undefined
  if (!fields) return 'forbidden'
  if (Object.keys(command).some(key => key !== 'type' && !fields.includes(key))) return 'forbidden'
  if (command.type === 'configure' && Object.keys(command.patch).some(key => !(REMOTE_CONFIGURATION_FIELDS as readonly string[]).includes(key))) return 'forbidden'
  if (!context.mayAnswer && remoteCommandNeedsAnswerPolicy(command, context.askingProviderModes ?? [])) return 'forbidden'
  return null
}
