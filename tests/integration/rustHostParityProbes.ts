// One request for every remote command (`REMOTE_COMMANDS`) and every protocol v1 operation (`hostRequestSchema`), which
// `rustHostParity.test.ts` sends to the Node host and the Rust host alike and whose answers it compares (ADR-0214, #2876).
// The two maps are typed so that a command or operation added to the protocol fails typecheck here until it has a probe.
//
// A probe is the smallest request either host must take seriously: it parses, it names the thread the test made for it,
// and it does nothing outside the test's own folders. Nothing here reaches GitHub, a provider's sign-in page or a real
// provider client: the hosts run with an empty `gh` configuration, Git limited to local files, the referee's fake provider
// and no provider client on their PATH. A repository a probe names is on `github.invalid`, a name that never resolves.
import { randomUUID } from 'node:crypto'
import { publicProviderEntityId, type AgentCommand } from '../../src/shared/agents'
import type { HostRequest } from '../../src/shared/hostProtocol'

/** What a probe may name: the host's project, a thread made for this probe alone, and a folder inside the test's own. */
export interface ProbeIds {
  readonly projectId: string
  readonly threadId: string
  readonly folder: string
}

type CommandType = AgentCommand['type']
type CommandProbe<T extends CommandType> = (ids: ProbeIds) => AgentCommand & { type: T }

/** The referee's fake Codex model, by the ID the host's model list gives it. */
export const FIXTURE_MODEL = publicProviderEntityId('codex', 'model', 'fixture-model')
const PULL_REQUEST = 'https://github.com/sotto-parity-probe/none/pull/1'
const SHA = 'a'.repeat(64)

/** A probe for each command a paired client may send. `rustHostParity.test.ts` checks the keys are `REMOTE_COMMANDS`'s. */
export const COMMAND_PROBES: { readonly [T in CommandType]?: CommandProbe<T> } = {
  configure: () => ({ type: 'configure', patch: { newThreadSpeed: null } }),
  compose: () => ({ type: 'compose', text: 'Probe draft' }),
  send: () => ({ type: 'send' }),
  'cancel-draft': () => ({ type: 'cancel-draft' }),
  connect: () => ({ type: 'connect', provider: 'codex' }),
  // A provider the referee holds, so the probe leaves the fake codex connected for the probes after it.
  disconnect: () => ({ type: 'disconnect', provider: 'grok' }),
  refresh: () => ({ type: 'refresh', provider: 'codex' }),
  'refresh-thread-skills': ({ threadId }) => ({ type: 'refresh-thread-skills', threadId }),
  'check-client-updates': () => ({ type: 'check-client-updates' }),
  'dismiss-client-updates': () => ({ type: 'dismiss-client-updates' }),
  'queue-client-updates': () => ({ type: 'queue-client-updates', providers: ['grok'] }),
  'cancel-client-updates': () => ({ type: 'cancel-client-updates', providers: ['grok'] }),
  'save-thread-draft': ({ threadId }) => ({ type: 'save-thread-draft', threadId, draftId: randomUUID(), text: 'Saved draft', requestId: null }),
  'recover-draft': ({ threadId }) => ({ type: 'recover-draft', threadId }),
  'manual-send': ({ threadId }) => ({ type: 'manual-send', threadId, text: 'Hello from the parity probe', draftId: randomUUID() }),
  'queue-followup': ({ threadId }) => ({ type: 'queue-followup', threadId, draftId: randomUUID(), text: 'Queued probe' }),
  'edit-followup': ({ threadId }) => ({ type: 'edit-followup', threadId, itemId: randomUUID(), text: 'Edited probe' }),
  'steer-followup': ({ threadId }) => ({ type: 'steer-followup', threadId, itemId: randomUUID() }),
  'remove-followup': ({ threadId }) => ({ type: 'remove-followup', threadId, itemId: randomUUID() }),
  'reorder-followups': ({ threadId }) => ({ type: 'reorder-followups', threadId, itemIds: [] }),
  'resume-followups': ({ threadId }) => ({ type: 'resume-followups', threadId }),
  steer: ({ threadId }) => ({ type: 'steer', threadId, draftId: randomUUID(), text: 'Steer probe' }),
  'create-project': ({ folder }) => ({ type: 'create-project', title: 'Probe project', path: folder }),
  'select-project': ({ projectId }) => ({ type: 'select-project', projectId }),
  'settle-project': ({ projectId }) => ({ type: 'settle-project', projectId }),
  'restore-project': ({ projectId }) => ({ type: 'restore-project', projectId }),
  'settle-thread': ({ threadId }) => ({ type: 'settle-thread', threadId }),
  'restore-thread': ({ threadId }) => ({ type: 'restore-thread', threadId }),
  'rename-thread': ({ threadId }) => ({ type: 'rename-thread', threadId, title: 'Renamed probe' }),
  'regenerate-thread-title': ({ threadId }) => ({ type: 'regenerate-thread-title', threadId }),
  'create-owlet': () => ({ type: 'create-owlet', threadId: randomUUID(), name: 'Probe owlet', role: 'Answers probes', modelId: FIXTURE_MODEL }),
  'set-owlet': ({ threadId }) => ({ type: 'set-owlet', threadId, name: 'Probe owlet' }),
  'create-thread': ({ projectId }) => ({ type: 'create-thread', projectId, title: 'Probe thread', modelId: FIXTURE_MODEL, threadId: randomUUID() }),
  'continue-agent': ({ threadId }) => ({ type: 'continue-agent', threadId, agentId: 'agent-probe', newThreadId: randomUUID() }),
  'fork-thread': ({ threadId }) => ({ type: 'fork-thread', threadId, messageId: 'message-probe', newThreadId: randomUUID() }),
  'retry-thread-worktree': ({ threadId }) => ({ type: 'retry-thread-worktree', threadId }),
  'refresh-thread-worktree': ({ threadId }) => ({ type: 'refresh-thread-worktree', threadId }),
  'restore-thread-branch': ({ threadId }) => ({ type: 'restore-thread-branch', threadId }),
  'preview-reclaim-thread-worktree': ({ threadId }) => ({ type: 'preview-reclaim-thread-worktree', threadId }),
  'preview-delete-thread': ({ threadId }) => ({ type: 'preview-delete-thread', threadId }),
  'delete-thread': ({ threadId }) => ({ type: 'delete-thread', threadId }),
  'reclaim-thread-worktree': ({ threadId }) => ({ type: 'reclaim-thread-worktree', threadId }),
  'configure-thread-working-copy': ({ threadId }) => ({ type: 'configure-thread-working-copy', threadId, workingCopy: 'shared' }),
  'git-action': ({ threadId }) => ({ type: 'git-action', threadId, actionId: randomUUID(), action: 'commit', commitMessage: 'Probe commit' }),
  'git-pull': ({ threadId }) => ({ type: 'git-pull', threadId }),
  'git-switch-branch': ({ threadId }) => ({ type: 'git-switch-branch', threadId, ref: 'probe-branch' }),
  'git-init': ({ threadId }) => ({ type: 'git-init', threadId }),
  'bring-changes-back': ({ threadId }) => ({ type: 'bring-changes-back', threadId, actionId: randomUUID() }),
  'git-publish': ({ threadId }) => ({ type: 'git-publish', threadId, repository: 'sotto-parity-probe/none', visibility: 'private' }),
  'git-pull-request-action': ({ threadId }) => ({ type: 'git-pull-request-action', threadId, url: PULL_REQUEST, action: 'ready' }),
  'git-link-pull-request': ({ threadId }) => ({ type: 'git-link-pull-request', threadId, reference: PULL_REQUEST }),
  'git-unlink-pull-request': ({ threadId }) => ({ type: 'git-unlink-pull-request', threadId, url: PULL_REQUEST }),
  'git-checkout-pull-request': ({ threadId }) => ({ type: 'git-checkout-pull-request', threadId, reference: PULL_REQUEST, mode: 'local' }),
  'babysit-pull-request': ({ threadId }) => ({ type: 'babysit-pull-request', threadId, url: PULL_REQUEST }),
  'stop-babysitting': ({ threadId }) => ({ type: 'stop-babysitting', threadId, url: PULL_REQUEST }),
  'cancel-restart': ({ threadId }) => ({ type: 'cancel-restart', threadId }),
  'snooze-thread': ({ threadId }) => ({ type: 'snooze-thread', threadId, until: null }),
  'configure-thread': ({ threadId }) => ({ type: 'configure-thread', threadId, reasoningEffort: 'medium' }),
  'select-thread': ({ threadId }) => ({ type: 'select-thread', threadId }),
  'observe-threads': ({ threadId }) => ({ type: 'observe-threads', threadIds: [threadId] }),
  'load-earlier-messages': ({ threadId }) => ({ type: 'load-earlier-messages', threadId, throughMessageId: 'message-probe' }),
  'dismiss-failures': ({ threadId }) => ({ type: 'dismiss-failures', failures: [{ threadId, failure: 'probe' }] }),
  'start-thread-session': ({ threadId }) => ({ type: 'start-thread-session', threadId }),
  interrupt: ({ threadId }) => ({ type: 'interrupt', threadId }),
  'compact-thread': ({ threadId }) => ({ type: 'compact-thread', threadId }),
  'stop-detached-run': ({ threadId }) => ({ type: 'stop-detached-run', threadId, runId: randomUUID() }),
  answer: ({ threadId }) => ({ type: 'answer', threadId, requestId: 'request-probe', answer: 'yes', approved: true }),
}

type Operation = HostRequest['op']
type OperationProbe<O extends Operation> = (ids: ProbeIds) => Omit<Extract<HostRequest, { op: O }>, 'v' | 'id' | 'session'>

/**
 * A probe for each v1 operation. `command` and `hello` are probed on their own by the test, so theirs here are the plain
 * forms. The mapped type has no `?`: an operation added to `hostRequestSchema` fails typecheck until it is here.
 */
export const OPERATION_PROBES: { readonly [O in Operation]: OperationProbe<O> } = {
  'watcher-phone-read': () => ({ op: 'watcher-phone-read' }),
  'watcher-phone-set-permission': () => ({ op: 'watcher-phone-set-permission', request: { runtimeMode: 'approval-required' } }),
  'watcher-phone-watch': ({ threadId }) => ({ op: 'watcher-phone-watch', request: { target: target(threadId) } }),
  'watcher-phone-unwatch': ({ threadId }) => ({ op: 'watcher-phone-unwatch', request: { target: target(threadId) } }),
  'watcher-phone-open': () => ({ op: 'watcher-phone-open', request: { target: target(randomUUID()), provider: 'codex', modelId: FIXTURE_MODEL } }),
  'watcher-phone-new': () => ({ op: 'watcher-phone-new', request: { target: target(randomUUID()) } }),
  'watcher-phone-stop-turn': () => ({ op: 'watcher-phone-stop-turn', request: { target: target(randomUUID()) } }),
  'watcher-phone-dismiss-handover': () => ({ op: 'watcher-phone-dismiss-handover', request: { target: target(randomUUID()) } }),
  'watcher-phone-send': () => ({ op: 'watcher-phone-send', request: { origin: { kind: 'phone', hostId: randomUUID(), clientId: 'client-probe' }, target: target(randomUUID()), draftId: randomUUID(), text: 'Probe for Watcher' } }),
  'watcher-phone-remove-followup': () => ({ op: 'watcher-phone-remove-followup', request: { target: target(randomUUID()), itemId: randomUUID() } }),
  'watcher-phone-preview': () => ({ op: 'watcher-phone-preview', request: { target: target(randomUUID()), messageId: 'message-probe', attachmentId: 'attachment-probe' } }),
  'watcher-phone-answer': () => ({ op: 'watcher-phone-answer', request: { target: target(randomUUID()), command: { type: 'answer', threadId: randomUUID(), requestId: 'request-probe', answer: 'yes' } } }),
  'watcher-phone-prepare-stop-all': () => ({ op: 'watcher-phone-prepare-stop-all' }),
  'watcher-phone-stop-all': () => ({ op: 'watcher-phone-stop-all', confirmationId: randomUUID() }),
  'watcher-control': ({ threadId }) => ({ op: 'watcher-control', request: {
    master: watcherMaster(), request: { id: requestId, watcher: target(randomUUID()), rootUserMessageId: 'message-probe', createdAt: now() },
    ceiling: 'approval-required', operation: { id: randomUUID(), requestId, retryKey: randomUUID(), digest: SHA, action: 'stop', target: target(threadId),
      generation: 0, deliveryState: 'queued', createdAt: now(), updatedAt: now(), receiptId: 'receipt-probe', cardId: 'card-probe' },
    call: { name: 'stop_thread', input: { requestId, retryKey: randomUUID(), target: target(threadId) } } } }),
  'watcher-read': () => ({ op: 'watcher-read', request: { master: watcherMaster(), call: { name: 'list_projects', input: { limit: 10 } } } }),
  hello: () => ({ op: 'hello' }),
  shell: () => ({ op: 'shell' }),
  'settled-threads': () => ({ op: 'settled-threads' }),
  detail: ({ threadId }) => ({ op: 'detail', threadId }),
  'earlier-steps': ({ threadId }) => ({ op: 'earlier-steps', threadId }),
  events: () => ({ op: 'events', afterSeq: 0 }),
  observe: ({ threadId }) => ({ op: 'observe', threadIds: [threadId] }),
  command: ({ threadId }) => ({ op: 'command', command: { type: 'select-thread', threadId } }),
  preview: ({ threadId }) => ({ op: 'preview', request: { threadId, messageId: 'message-probe', attachmentId: 'attachment-probe' } }),
  'thread-media': ({ threadId }) => ({ op: 'thread-media', request: { threadId, activityId: 'activity-probe', mediaId: 'm0' } }),
  'thread-media-part': ({ threadId }) => ({ op: 'thread-media-part', request: { threadId, activityId: 'activity-probe', mediaId: 'm0', part: 0 } }),
  receipt: () => ({ op: 'receipt', commandId: 'command-probe' }),
  'check-answer': ({ threadId }) => ({ op: 'check-answer', answer: { threadId, providerId: 'codex', requestId: 'request-probe', questionsDigest: SHA } }),
  'git-refs': ({ threadId }) => ({ op: 'git-refs', request: { threadId } }),
  'git-changed-files': ({ threadId }) => ({ op: 'git-changed-files', request: { threadId } }),
  'git-pull-request': ({ threadId }) => ({ op: 'git-pull-request', request: { threadId, reference: PULL_REQUEST } }),
  'git-pull-request-list': ({ threadId }) => ({ op: 'git-pull-request-list', request: { threadId } }),
  'pull-request-confirmation': ({ threadId }) => ({ op: 'pull-request-confirmation', request: { threadId, url: PULL_REQUEST, action: 'close' } }),
  'stage-attachment': () => ({ op: 'stage-attachment', image: { name: 'Probe.png', mimeType: 'image/png', data: ONE_PIXEL_PNG } }),
  'attachment-content': () => ({ op: 'attachment-content', digest: SHA }),
  'stage-file-part': () => ({ op: 'stage-file-part', part: { uploadId: randomUUID(), index: 0, count: 1, name: 'probe.txt', mimeType: 'text/plain', sizeBytes: 5, digest: SHA, data: Buffer.from('probe').toString('base64') } }),
  'file-upload-progress': () => ({ op: 'file-upload-progress', uploadId: randomUUID() }),
  'attachment-file': ({ threadId }) => ({ op: 'attachment-file', request: { threadId, messageId: 'message-probe', attachmentId: 'attachment-probe', part: 0 } }),
  'host-folders': ({ folder }) => ({ op: 'host-folders', request: { path: folder } }),
  'thread-files': ({ threadId }) => ({ op: 'thread-files', request: { threadId, path: '' } }),
  browser: ({ threadId }) => ({ op: 'browser', request: { method: 'list', payload: { threadId } } }),
  'thread-file-preview': ({ threadId }) => ({ op: 'thread-file-preview', request: { threadId, path: 'README.md', workspaceId: SHA } }),
  'thread-file-link': ({ threadId }) => ({ op: 'thread-file-link', request: { threadId, path: 'README.md' } }),
  'thread-linked-file': ({ threadId }) => ({ op: 'thread-linked-file', request: { threadId, path: 'README.md', want: 'place' } }),
  'thread-changes': ({ threadId }) => ({ op: 'thread-changes', request: { threadId } }),
  'thread-changes-review': ({ threadId }) => ({ op: 'thread-changes-review', request: { threadId, workspaceId: SHA, scope: { kind: 'working' } } }),
  'subagent-page': ({ threadId }) => ({ op: 'subagent-page', request: { threadId } }),
  'subagent-assignments': ({ threadId }) => ({ op: 'subagent-assignments', request: { threadId, agentId: 'agent-probe' } }),
  'host-facts': () => ({ op: 'host-facts' }),
  'detached-runs-look': () => ({ op: 'detached-runs-look' }),
  'detached-run-elsewhere-stop': () => ({ op: 'detached-run-elsewhere-stop', runId: randomUUID(), mark: { name: 'CODEX_THREAD_ID', value: 'probe' } }),
  'project-origins': () => ({ op: 'project-origins' }),
  'project-setup': () => ({ op: 'project-setup', request: { repository: { host: 'github.invalid', owner: 'sotto-parity-probe', name: 'none' }, title: 'Probe' } }),
  'desktop-defaults': () => ({ op: 'desktop-defaults', defaults: { newThreadRuntimeMode: null } }),
  'plugin-account-copy': () => ({ op: 'plugin-account-copy', copy: { account: { id: randomUUID(), plugin: 'vercel', name: 'Probe', savedAt: now(), signedInAs: null, on: true, projects: null }, secret: 'probe-secret' } }),
  'plugin-account-copy-remove': () => ({ op: 'plugin-account-copy-remove', accountId: randomUUID() }),
  'plugin-account-copies': () => ({ op: 'plugin-account-copies' }),
  'plugin-meshy-spending': () => ({ op: 'plugin-meshy-spending', reports: [] }),
  'plugin-elevenlabs-spending': () => ({ op: 'plugin-elevenlabs-spending', reports: [] }),
  'plugin-meshy-models': () => ({ op: 'plugin-meshy-models', request: {} }),
  'plugin-meshy-model': () => ({ op: 'plugin-meshy-model', request: { id: randomUUID() } }),
  'plugin-meshy-model-bytes': () => ({ op: 'plugin-meshy-model-bytes', request: { id: randomUUID(), part: 'model', offset: 0 } }),
  'plugin-meshy-model-remove': () => ({ op: 'plugin-meshy-model-remove', request: { id: randomUUID() } }),
  'plugin-elevenlabs-sound': () => ({ op: 'plugin-elevenlabs-sound', request: { id: randomUUID() } }),
  'plugin-elevenlabs-sound-bytes': () => ({ op: 'plugin-elevenlabs-sound-bytes', request: { id: randomUUID(), offset: 0 } }),
  'plugin-github-sign-in': () => ({ op: 'plugin-github-sign-in' }),
  'activity-body': ({ threadId }) => ({ op: 'activity-body', threadId, activityId: 'activity-probe' }),
  'start-handover': ({ threadId }) => ({ op: 'start-handover', threadId }),
  'thread-prompts': ({ threadId }) => ({ op: 'thread-prompts', threadId, beforeMessageId: 'message-probe' }),
  'thread-words': () => ({ op: 'thread-words', query: 'probe' }),
  // `outcome` reads how the last update went; nothing is fetched, installed or restarted.
  'host-update': () => ({ op: 'host-update', action: 'outcome' }),
  'usage-read': () => ({ op: 'usage-read', query: {} }),
  'usage-refresh': () => ({ op: 'usage-refresh', providerIds: [] }),
  'usage-clear': () => ({ op: 'usage-clear', request: { expectedRevision: 999_999 } }),
  'hermes-sign-out': () => ({ op: 'hermes-sign-out' }),
  // Devin has no sign-in program, so neither host starts one.
  'sign-in-start': () => ({ op: 'sign-in-start', provider: 'devin' }),
  'sign-in-read': () => ({ op: 'sign-in-read', signInId: randomUUID() }),
  'sign-in-code': () => ({ op: 'sign-in-code', signInId: randomUUID(), code: 'probe-code' }),
  'sign-in-cancel': () => ({ op: 'sign-in-cancel', signInId: randomUUID() }),
  'opencode-sign-in': () => ({ op: 'opencode-sign-in', call: { action: 'sources' } }),
  'thread-delegations': ({ threadId }) => ({ op: 'thread-delegations', threadId }),
  'delegation-views': ({ threadId }) => ({ op: 'delegation-views', threadId }),
  'delegation-brief': ({ threadId }) => ({ op: 'delegation-brief', threadId }),
  'branch-move': ({ projectId }) => ({ op: 'branch-move', request: { action: 'tips', projectId } }),
  'thread-move': () => ({ op: 'thread-move', request: { action: 'handover', moveId: randomUUID() } }),
  'delegation-relay-answer': () => ({ op: 'delegation-relay-answer', askId: randomUUID(), result: null }),
  'watcher-tell-answer': () => ({ op: 'watcher-tell-answer', askId: randomUUID(), answer: { status: 'refused', reason: 'no-watcher' } }),
  'delegation-relay-name': () => ({ op: 'delegation-relay-name', name: 'Probe host' }),
  'delegation-relay-news': ({ threadId }) => ({ op: 'delegation-relay-news', threadId, news: { source: 'delegation', items: [{ delegationId: randomUUID(), threadId, outcome: 'working' }] } }),
  'delegation-remote-ask': () => ({ op: 'delegation-remote-ask', ask: { type: 'read', caller: 'caller-probe', delegation: randomUUID() } }),
  'coordination-views': ({ threadId }) => ({ op: 'coordination-views', threadId }),
  'coordination-reply': ({ threadId }) => ({ op: 'coordination-reply', threadId, exchangeId: randomUUID() }),
  'coordination-remote-ask': () => ({ op: 'coordination-remote-ask', ask: { type: 'list', caller: { threadId: randomUUID(), hostId: randomUUID(), title: 'Probe caller', projectId: 'probe-project' }, input: {} } }),
  'coordination-relay-answer': () => ({ op: 'coordination-relay-answer', askId: randomUUID(), result: null }),
  'coordination-relay-news': ({ threadId }) => ({ op: 'coordination-relay-news', threadId, news: { source: 'coordination', items: [{ exchangeId: randomUUID(), threadId, outcome: 'working' }] } }),
  'next-prompts-wanted': () => ({ op: 'next-prompts-wanted', wanted: false }),
}

const now = (): string => new Date().toISOString()
const target = (threadId: string) => ({ hostId: randomUUID(), threadId })
const requestId = randomUUID()

function watcherMaster() {
  return { target: target(randomUUID()), projectId: 'probe-project', provider: 'codex' as const, creationOperationId: randomUUID(), createdAt: now() }
}

/** The smallest PNG, one transparent pixel, in base64. */
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

