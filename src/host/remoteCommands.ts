import { startsThread } from '../shared/threadStarts'
import type { AgentCommand, AgentConfiguration } from '../shared/agents'
import { managementCommandRefusal } from '../shared/hostProtocol'

type CommandType = AgentCommand['type']
type Fields<T extends CommandType> = readonly Exclude<keyof Extract<AgentCommand, { type: T }>, 'type'>[]

/**
 * Every command a paired client may send over the socket, and every field it may carry. The list is
 * closed: a command type or field added to `agentCommandSchema` is refused remotely until it is added
 * here on purpose, because a paired device is not the user at this computer (ADR-0004). Anything
 * absent is host-local: credentials, the voice commands and voice engine, reasoning checks,
 * opening a folder on the host machine, and `update-client`, which holds the request open for as long as the installer
 * runs. A headless host that lists the `client-updates` feature takes `queue-client-updates` instead: it puts clients in
 * Machine origin is never a command field. `watcher-control` is a separate closed host feature, checked against the
 * SSH-recorded desktop and admitted by the owning host's Watcher service before this coordinator path.
 * the host's own one-at-a-time update line and answers at once (#480). Updating a client answers no permission request
 * and replaces nothing the user made, so pairing is enough, as it is for `connect`.
 */
export const REMOTE_COMMANDS: { readonly [T in CommandType]?: Fields<T> } = {
  configure: ['patch'],
  compose: ['text', 'attachments', 'threadId', 'draftId'], send: ['draft'], 'cancel-draft': [],
  // A paired client can only leave connection feedback unset, never supply notice text or authority.
  connect: ['provider', 'notice'], disconnect: ['provider'], refresh: ['provider'],
  'refresh-thread-skills': ['threadId', 'forceReload'],
  'check-client-updates': [], 'dismiss-client-updates': [],
  // The two update-line commands, only on a listener that offers `client-updates`: see remoteCommandRefusal.
  'queue-client-updates': ['providers'], 'cancel-client-updates': ['providers'],
  'save-thread-draft': ['threadId', 'draftId', 'text', 'attachments', 'skills', 'files', 'requestId', 'questionsDigest', 'expectedDraftId', 'composer'],
  'recover-draft': ['threadId'],
  'manual-send': ['threadId', 'text', 'attachments', 'skills', 'files', 'draftId'],
  'queue-followup': ['threadId', 'draftId', 'text', 'attachments', 'skills', 'files'],
  'edit-followup': ['threadId', 'itemId', 'text', 'attachments', 'skills', 'files'],
  'steer-followup': ['threadId', 'itemId'], 'remove-followup': ['threadId', 'itemId'],
  'reorder-followups': ['threadId', 'itemIds'], 'resume-followups': ['threadId'],
  steer: ['threadId', 'draftId', 'text', 'attachments', 'skills', 'files'],
  'create-project': ['provider', 'title', 'path', 'useExisting'],
  'select-project': ['projectId'], 'settle-project': ['projectId'], 'restore-project': ['projectId'],
  'settle-thread': ['threadId'], 'restore-thread': ['threadId'],
  'rename-thread': ['threadId', 'title'], 'regenerate-thread-title': ['threadId'],
  'create-thread': ['projectId', 'title', 'modelId', 'titleSource', 'threadId', 'workingCopy', 'baseBranch', 'startFromOrigin',
    'existingWorktreePath', 'reasoningEffort', 'runtimeMode', 'providerMode'],
  // Continuing an agent as its own thread makes a new thread on the new-thread defaults, as create-thread does, and asks
  // the model nothing (#1028). Only on a listener that offers `thread-starts`: see remoteCommandRefusal.
  'continue-agent': ['threadId', 'agentId', 'newThreadId', 'modelId', 'handover', 'workingCopy', 'baseBranch', 'startFromOrigin'],
  // Fork from here makes a new thread the same way, from a copy of the conversation or a handover of it (#1028).
  'fork-thread': ['threadId', 'messageId', 'newThreadId', 'modelId', 'workingCopy', 'baseBranch', 'startFromOrigin'],
  'retry-thread-worktree': ['threadId'], 'refresh-thread-worktree': ['threadId', 'background'],
  'restore-thread-branch': ['threadId', 'withUncommittedChanges'],
  'preview-reclaim-thread-worktree': ['threadId'],
  // Deleting a settled thread cannot be taken back, so it takes the remote-answer policy, as clearing Usage does, and only
  // on a listener that offers `thread-delete` (ADR-0140): see remoteCommandRefusal. Clear now and the automatic rule act
  // on the computer whose Settings set them, so neither is a remote command.
  'preview-delete-thread': ['threadId'],
  'delete-thread': ['threadId', 'confirmedIgnored', 'confirmedItems', 'confirmedRepositories'],
  'reclaim-thread-worktree': ['threadId', 'withUncommittedChanges', 'confirmedIgnored', 'confirmedItems', 'confirmedRepositories'],
  'configure-thread-working-copy': ['threadId', 'workingCopy', 'baseBranch', 'startFromOrigin', 'existingWorktreePath'],
  // The Git actions run on the host's own folder and discard nothing: Git refuses a switch that would lose work,
  // a push is never forced, and a pull is fast-forward only (ADR-0027).
  'git-action': ['threadId', 'actionId', 'action', 'commitMessage', 'featureBranch', 'filePaths', 'allowDefaultBranch'],
  'git-pull': ['threadId'], 'git-switch-branch': ['threadId', 'ref', 'create'], 'git-init': ['threadId'],
  'git-publish': ['threadId', 'repository', 'visibility'],
  // The pull request presses are the user's own, through gh on the host's sign-in, and none answers a permission: merging,
  // closing and turning on auto-merge each take the surface's confirmation first, and a checkout never forces (ADR-0027).
  'git-pull-request-action': ['threadId', 'url', 'action', 'method'],
  'git-link-pull-request': ['threadId', 'reference'], 'git-unlink-pull-request': ['threadId', 'url'],
  'git-checkout-pull-request': ['threadId', 'reference', 'mode'],
  // Babysitting is the user's own request too, and grants nothing: a wake-up approves, merges and answers nothing
  // (ADR-0061 decisions 4 and 11), so neither needs a remote-answer policy record.
  'babysit-pull-request': ['threadId', 'url'], 'stop-babysitting': ['threadId', 'url'],
  // Don't restart takes back a restart Sotto scheduled (ADR-0144): it sends and grants nothing, so pairing is enough.
  'cancel-restart': ['threadId'],
  'configure-thread': ['threadId', 'modelId', 'reasoningEffort', 'runtimeMode', 'providerMode'],
  'select-thread': ['threadId'], 'observe-threads': ['threadIds'], 'load-earlier-messages': ['threadId', 'throughMessageId'],
  // Dismiss all marks failed threads seen, as opening each would (ADR-0092). It answers no request: a thread waiting on a
  // permission or a question is never marked, so pairing is enough.
  'dismiss-failures': ['failures'],
  // Early start: typing in a thread's composer starts its provider session. It grants and sends nothing.
  'start-thread-session': ['threadId'],
  interrupt: ['threadId'], 'compact-thread': ['threadId'],
  answer: ['threadId', 'requestId', 'answer', 'approved', 'questionAnswers', 'permissionChoice'],
}
/**
 * The requests besides commands that change something on the host and that a paired client may send: a provider's own
 * sign-in, run on the host and finished in the client's browser (ADR-0037). Each is answered only to the client that
 * started the sign-in, and only by a host that lists the `provider-sign-in` feature, which the desktop's phone listener
 * does not. Signing a provider in on the host answers no permission request, so it needs no `remote-answer` policy; it is
 * the same trust as `connect`, which pairing already gives, and the iPhone client does not send them.
 */
export const REMOTE_SIGN_IN_OPERATIONS = ['sign-in-start', 'sign-in-read', 'sign-in-code', 'sign-in-cancel'] as const
/**
 * The host's own OpenCode signed in to a model source, or out of one, for the desktop that asks (#1107): the same trust as a
 * provider's sign-in above. It answers no permission request and signs in the user's own account, finished in the user's
 * own browser on that desktop, so pairing is enough. Only a host whose OpenCode runs lists `opencode-sign-in`, only a
 * desktop is offered it, and only the client that started a browser sign-in reads, finishes or cancels it.
 */
export const REMOTE_OPENCODE_SIGN_IN_OPERATIONS = ['opencode-sign-in'] as const
/** Usage reads grant nothing. Clearing numeric history takes the authenticated client's remote-answer policy. */
export const REMOTE_USAGE_OPERATIONS = ['usage-read', 'usage-refresh', 'usage-clear'] as const
export function remoteUsageRefusal(operation: typeof REMOTE_USAGE_OPERATIONS[number], mayAnswer: boolean): 'forbidden' | null {
  return operation === 'usage-clear' && !mayAnswer ? 'forbidden' : null
}
/**
 * A host update the host runs on itself (ADR-0088). It installs and restarts into a newer published Sotto release, so it
 * takes more than pairing: the client must be one the launch script recorded as a desktop over the owner's SSH session,
 * and its `remote-answer` policy must let it answer, which `--deny-answers` on the host revokes. A phone never may. The
 * client names only a version, and for install the archive name and checksum the host's own download answered; the host
 * builds every path, URL and setting itself, and refuses any version that is not newer than its own.
 */
export const REMOTE_HOST_UPDATE_ACTIONS = ['fetch', 'install', 'restart', 'cancel', 'outcome'] as const
export function remoteHostUpdateRefusal(client: { readonly desktop: boolean; readonly mayAnswer: boolean }): 'forbidden' | null {
  return client.desktop && client.mayAnswer ? null : 'forbidden'
}
/**
 * The account and thread defaults a paired client may change. Keys stay on the host. The projects directory is only
 * where a new project goes, and `create-project` already takes a path from a paired client, so a desktop sets it from
 * its own Settings (ADR-0074). A new-thread permission default that lets threads act without asking is a grant, so it
 * needs the same remote-answer policy a thread's own permission does (see `remoteCommandNeedsAnswerPolicy`). A paired
 * client may turn the host's Muse shell sandbox back on, which grants nothing, but never off: that stays the host's own
 * Settings' to do, whatever the client's answer policy (ADR-0079, `remoteCommandRefusal`).
 */
export const REMOTE_CONFIGURATION_FIELDS: readonly (keyof AgentConfiguration)[] = ['provider', 'enabledProviders', 'enabled', 'defaultModelId',
  'reasoning', 'reasoningModel', 'reasoningEffort', 'projectsDirectory', 'newThreadModelId', 'newThreadReasoningEffort', 'newThreadRuntimeMode', 'museDisableSandbox']

/**
 * Whether a remote command changes what a thread may do without asking, or discards work the user has
 * not committed. Each is the user's answer to a question, so it needs the same remote-answer policy
 * record an answer does. A permission setting whose allowance is nothing grants nothing and is free, so a
 * paired device can always put a thread back to asking: Sotto's own `approval-required` runtime mode, and
 * the provider modes `askingProviderModes` names for the thread's model, by what each allows rather than by
 * where it sits in the list, because the list is only the modes the provider happens to report.
 */
export function remoteCommandNeedsAnswerPolicy(command: AgentCommand, askingProviderModes: readonly string[], draftRequestId?: string | null): boolean {
  switch (command.type) {
    case 'answer': return true
    case 'compose': case 'send': return draftRequestId != null
    case 'save-thread-draft': return command.requestId != null
    case 'create-thread': case 'configure-thread':
      return (command.runtimeMode !== undefined && command.runtimeMode !== 'approval-required')
        || (command.providerMode !== undefined && !askingProviderModes.includes(command.providerMode))
    // Every new thread would start on it, so it is at least the grant one thread's own would be.
    case 'configure': return command.patch.newThreadRuntimeMode != null && command.patch.newThreadRuntimeMode !== 'approval-required'
    case 'restore-thread-branch': return command.withUncommittedChanges === true
    case 'reclaim-thread-worktree': return command.withUncommittedChanges === true || Boolean(command.confirmedIgnored?.length)
    case 'delete-thread': return true
    default: return false
  }
}

/** Why a paired client may not send this command, or null when it may. */
export function remoteCommandRefusal(command: AgentCommand, context: { readonly mayAnswer: boolean; readonly askingProviderModes?: readonly string[] | undefined
  readonly draftRequestId?: string | null | undefined
  /** Selection belongs to this authenticated socket, never to the command payload. */
  readonly selectedThreadId?: string | null | undefined
  /** Whether this listener offers `client-updates`: the headless host does, the desktop's phone listener does not. */
  readonly clientUpdates?: boolean | undefined
  /** Whether this listener offers `thread-starts`: only a host whose Owl answer turns them on (#1028). */
  readonly threadStarts?: boolean | undefined
  /** Whether this listener offers `thread-delete`: only a host whose Owl answer turns clearing on, to a desktop (ADR-0140). */
  readonly threadDelete?: boolean | undefined }): 'forbidden' | null {
  if (managementCommandRefusal(command)) return 'forbidden'
  if (command.type === 'connect' && command.notice !== undefined && command.notice !== false) return 'forbidden'
  const fields = REMOTE_COMMANDS[command.type] as readonly string[] | undefined
  if (!fields) return 'forbidden'
  if ((command.type === 'queue-client-updates' || command.type === 'cancel-client-updates') && context.clientUpdates !== true) return 'forbidden'
  if (startsThread(command) && context.threadStarts !== true) return 'forbidden'
  if ((command.type === 'delete-thread' || command.type === 'preview-delete-thread') && context.threadDelete !== true) return 'forbidden'
  if (Object.keys(command).some(key => key !== 'type' && !fields.includes(key))) return 'forbidden'
  if (command.type === 'configure' && Object.keys(command.patch).some(key => !(REMOTE_CONFIGURATION_FIELDS as readonly string[]).includes(key))) return 'forbidden'
  // Muse without its shell sandbox is the host's own Settings' to choose, even for a client that may answer (ADR-0079).
  if (command.type === 'configure' && command.patch.museDisableSandbox === true) return 'forbidden'
  if (command.type === 'compose' && command.threadId !== undefined && command.threadId !== context.selectedThreadId) return 'forbidden'
  if (command.type === 'send' && command.draft && (command.draft.threadId !== context.selectedThreadId
    || Object.keys(command.draft).some(key => !['threadId', 'text', 'attachments', 'binding', 'draftId'].includes(key))
    || command.draft.binding && Object.keys(command.draft.binding).some(key => !['requestId', 'questionsDigest'].includes(key)))) return 'forbidden'
  if (!context.mayAnswer && remoteCommandNeedsAnswerPolicy(command, context.askingProviderModes ?? [], context.draftRequestId)) return 'forbidden'
  return null
}
