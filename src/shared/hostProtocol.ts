import { agentThreadPromptsSchema } from './threadPrompts'
import { delegationRelayAskSchema, delegationRelayNewsSchema, delegationRemoteAskSchema, DELEGATION_REMOTE_CALLER_MAX, relayedRepliesSchema, type DelegationRelayAsk } from './delegationRelay'
import { z } from 'zod'
import { watcherPhoneStateSchema, watcherPhoneSendSchema, watcherPhonePreviewSchema, watcherPhoneRemoveFollowupSchema, watcherPhoneAnswerSchema, watcherPhoneStopOutcomeSchema, watcherPhoneManageOutcomeSchema, type WatcherPhoneManageOutcome, watcherPhoneSetPermissionSchema, watcherPhoneWatchSchema, type WatcherPhoneStopOutcome, type WatcherPhoneState } from './watcherPhone'
import { watcherHostControlSchema, watcherHostReadSchema, watcherHostProjectionSchema } from './watcherHost'
import { AGENT_IMAGE_MIME_TYPES, AGENT_MAX_FILE_BYTES, agentMimeTypeSchema, agentAttachmentDimensionsSchema, agentAttachmentPreviewRequestSchema, attachmentDigestSchema, agentConfigurationSchema, agentCommandSchema, agentHostSnapshotSchema, agentStateSchema, agentThreadDetailDeltaSchema, agentThreadDetailResultSchema, type AgentMessage, type AgentModel, type AgentState, type AgentThreadDetail, type AgentThreadDetailDelta } from './agents'
import { threadEventSchema, type StoredThreadEvent } from './threadEvents'
import { gitRefsRequestSchema } from './gitRefs'
import { gitChangedFilesRequestSchema } from './gitChangedFiles'
import { gitPullRequestRequestSchema, pullRequestConfirmationRequestSchema, type GitPullRequestReadFailure } from './gitPullRequests'
import { hostFoldersRequestSchema } from './hostFolders'
import { fileListRequestSchema, fileRequestSchema } from './files'
import { gitReviewRequestSchema } from './gitChanges'
import { toolListRequestSchema } from './tools'
import { subagentAssignmentsRequestSchema, subagentPageRequestSchema } from './subagents'
import { desktopDefaultsSchema } from './desktopDefaults'
import { projectSetupRequestSchema } from './workerMachine'
import { DELEGATIONS_CHANGED_MAX } from './delegation'
import { PASTED_CODE_MAX } from './hostProviders'
import { opencodeHostCallSchema } from './opencodeSignIn'
import type { HeldProviders } from './heldProviders'
import { agentActivitySchema, type AgentActivity } from './agentActivity'
import { providerIdSchema, type ProviderClientUpdate, type ProviderId } from './agents'
import { usageLocalClearRequestSchema, usageLocalQuerySchema, usageProviderIdSchema } from './usageDashboard'
import { HOST_UPDATE_STEPS, type HostUpdateStep } from './hostUpdates'
import { hostBranchMoveRequestSchema } from './branchMoves'
import { checkQueueSchema, type CheckQueueEntry } from './checkQueue'

/**
 * Protocol version 1 is frozen (ADR-0025; every message is listed in docs/host-protocol.md). A later host
 * may add optional fields, a feature it lists in `features`, and push forms a client asks for by name in
 * hello's `accepts`; it never changes or removes what v1 already carries.
 */
export const HOST_PROTOCOL_VERSION = 1 as const
export const LEGACY_VOICE_CONFIGURATION = {
  orbColor: 'teal', followupLimit: 5, speak: false, speechProvider: 'grok', speechVoice: 'F1',
  grokSpeechVoice: 'altair', wakeModelDirectory: '', wakeRuntimeDirectory: '',
} as const
export const MANAGEMENT_REMOVED = 'Voice control and thread management are no longer available. Your threads and drafts are kept. Use the thread composer to continue.'
/** What a host still running legacy thread management keeps doing until it is updated: reading, drafting and stopping. */
export const LEGACY_MANAGEMENT_ALLOWED_COMMANDS: ReadonlySet<string> = new Set(['select-thread', 'select-project', 'observe-threads', 'compose', 'save-thread-draft', 'interrupt'])
export const LEGACY_MANAGEMENT_UPDATE = 'This host still has thread management running. Its history and drafts are kept. Update the host from the Threads page before continuing.'

export function withoutVoiceConfiguration(value: object): Record<string, unknown> {
  const configuration = { ...value } as Record<string, unknown>
  for (const key of Object.keys(LEGACY_VOICE_CONFIGURATION)) delete configuration[key]
  return configuration
}

export function withoutLegacyManagement(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const state = { ...value } as Record<string, unknown>
  if (state.configuration && typeof state.configuration === 'object' && !Array.isArray(state.configuration)) {
    state.configuration = withoutVoiceConfiguration(state.configuration)
  }
  delete state.speech
  delete state.voice
  if (state.credentials && typeof state.credentials === 'object') {
    const credentials = { ...state.credentials } as Record<string, unknown>
    delete credentials.grokSpeech
    state.credentials = credentials
  }
  for (const key of ['assignments', 'queue', 'pendingRequest', 'contextSavedAt', 'coordinatorConversation']) delete state[key]
  return { ...state, composing: false }
}

export function managementCommandRefusal(command: { type: string; managed?: unknown; patch?: object }): string | null {
  if (['utterance', 'voice', 'voice-state', 'preview-voice', 'assign', 'unassign', 'pause', 'resume',
    'select-attention', 'next', 'later', 'pause-draft', 'resume-draft', 'cancel-request'].includes(command.type)) return MANAGEMENT_REMOVED
  if (command.type === 'create-thread' && command.managed === true) return MANAGEMENT_REMOVED
  if (command.type === 'configure' && Object.keys(command.patch ?? {}).some(key => key in LEGACY_VOICE_CONFIGURATION)) return MANAGEMENT_REMOVED
  return null
}
const legacyId = z.string().min(1).max(512)
const legacyText = z.string().max(20_000)
const legacyCommandSchema = z.union([
  z.object({ type: z.literal('utterance'), text: legacyText }).strict(),
  z.object({ type: z.literal('assign'), threadId: legacyId, instruction: legacyText.optional(), expectedDraftId: z.uuid().nullable().optional() }).strict(),
  z.object({ type: z.enum(['unassign', 'pause', 'resume']), threadId: legacyId, expectedDraftId: z.uuid().nullable().optional() }).strict(),
  z.object({ type: z.literal('select-attention'), itemId: legacyId }).strict(),
  z.object({ type: z.enum(['next', 'later', 'pause-draft', 'cancel-request']) }).strict(),
  z.object({ type: z.literal('resume-draft'), threadId: legacyId }).strict(),
  z.object({ type: z.literal('create-thread'), managed: z.boolean() }).passthrough().superRefine((command, context) => {
    const { managed, ...manual } = command
    void managed
    if (!agentCommandSchema.safeParse(manual).success) context.addIssue({ code: 'custom', message: 'Invalid thread creation.' })
  }),
  z.object({ type: z.literal('configure'), patch: agentConfigurationSchema.extend({
    orbColor: z.string(), followupLimit: z.number().int().min(0).max(100), speak: z.boolean(), speechProvider: z.enum(['grok', 'kokoro', 'natural', 'system']),
    speechVoice: z.string(), grokSpeechVoice: z.string(), wakeModelDirectory: z.string(), wakeRuntimeDirectory: z.string(),
  }).partial().strict() }).strict(),
])
export const protocolAgentCommandSchema = z.union([agentCommandSchema, legacyCommandSchema])
/** False-only creation is the inert spelling an older phone sends. */
export function commandFromProtocolV1(command: z.infer<typeof protocolAgentCommandSchema>) {
  if (managementCommandRefusal(command)) throw new Error(MANAGEMENT_REMOVED)
  if (command.type === 'create-thread' && 'managed' in command) {
    const { managed, ...manual } = command
    void managed
    return agentCommandSchema.parse(manual)
  }
  return agentCommandSchema.parse(command)
}
/** Retired account fields stay on v1's wire for desktops that still require them. */
export function shellForProtocolV1<T extends AgentState>(state: T) {
  return { ...state, membership: { status: 'beta' as const, label: '', expiresAt: null },
    assignments: [], queue: [], pendingRequest: '', speech: { id: 0, text: '' },
    voice: { status: 'off' as const, error: null, action: 'none' as const, revision: 0 },
    credentials: { ...state.credentials, grokSpeech: false },
    configuration: { ...state.configuration, ...LEGACY_VOICE_CONFIGURATION, membershipEndpoint: '' } }
}
/**
 * A shell as a client reads it. `host.modelsRevision` is sent only to a client that accepts
 * `model-catalog-revision`. The desktop's own client accepts it, and puts a catalog the host left out back
 * before it reads the shell, so it reads `modelsRevision` as optional and `host.models` stays required, as v1 has it.
 * `terminals` is always empty: the retired feature's list, sent only to a client whose hello still accepts it (ADR-0111).
 */
const hostClientShellSchema = agentStateSchema.extend({ clientCapabilities: z.object({ mayAnswer: z.boolean() }).optional(),
  terminals: z.tuple([]).optional(),
  watcher: watcherPhoneStateSchema.optional(),
  host: agentHostSnapshotSchema.extend({ modelsRevision: z.number().int().positive().optional() }) })
/** Older hosts carry retired fields; strip them before the strict domain schemas read them. */
export const protocolAgentStateSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const state = withoutLegacyManagement(value) as Record<string, unknown>
  const assignments = (value as Record<string, unknown>).assignments
  state.legacyManagement = (value as Record<string, unknown>).legacyManagement === true || Array.isArray(assignments) && assignments.length > 0
  state.composing = (value as Record<string, unknown>).composing
  delete state.membership
  const configuration = state.configuration
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return state
  const current = { ...configuration } as Record<string, unknown>
  delete current.membershipEndpoint
  return { ...state, configuration: current }
}, hostClientShellSchema)
/**
 * The host features this build offers: parts of v1 beyond its base, which a client uses only when a
 * host lists them. `detail-delta`: a client that accepts it is sent what changed in an observed thread
 * (a `detail-delta` push) in place of the whole thread on every change. `git-refs`: the host answers the
 * `git-refs` request with a page of a thread's branches for the branch picker. `git-changed-files`: the
 * host answers the `git-changed-files` request with a thread's changed files for the commit dialog.
 * `git-pull-request`: the host answers the `git-pull-request` request with one of a thread's pull requests,
 * read through gh, for the Pull request surface and its dialogs. `attachment-staging`: the host keeps an image a client
 * sends once and answers with its handle (`stage-attachment`), and hands a staged image back by digest
 * (`attachment-content`); drafts and commands carry the handle (ADR-0031). `host-folders`: the host answers the
 * `host-folders` request with one folder's subfolders on the host machine, for the Add project dialog's folder browser.
 * `provider-sign-in`: the host runs one of its providers' own sign-in for the client that asks, and answers the
 * `sign-in-start`, `sign-in-read`, `sign-in-code` and `sign-in-cancel` requests (ADR-0037). Only a headless host offers
 * it: the desktop's phone listener does not. `message-aliases`: event pages may carry
 * message-aliased only after the client explicitly accepts it; other clients read the repaired detail.
 * `client-updates`: the host's shell carries its client updates for the client to show, and the host takes the
 * `queue-client-updates` command, which updates its clients one at a time (ADR-0042, #480). Only a headless host offers
 * it, and a client shows a host's client updates only when the host lists it. `activity-summaries`: a client that
 * accepts it is sent every activity record in a detail, a detail delta and a `detail` answer as its activity summary
 * (`activitySummary`), without the output, text and diffs it would not show (#701).
 * `model-catalog-revision`: to a client that accepts it, every shell's `host` names its model catalog's revision
 * (`modelsRevision`) and carries `models` only when this connection has not yet been sent that revision whole
 * (ADR-0028, October 3 amendment). Every other client is sent the whole catalog in every shell.
 * `thread-files`: the host answers `thread-files` with a folder's entries in a thread's working copy and
 * `thread-file-preview` with one file's preview, for Files. `thread-changes`: the host answers `thread-changes` with a thread's
 * changed files as Git's status lists them and `thread-changes-review` with its Working tree or Branch changes comparison, for
 * Changes. `subagents`: the host answers `subagent-page` and `subagent-assignments` with a thread's agents, for Agents.
 * All six are reads, bounded as the desktop's own are (ADR-0025, October 5 amendment).
 * `answer-check`: an authorized client's `check-answer` freshly reads an exact native question and may
 * release its restart re-offer for a new user choice. Receipt reads and background publications never do this.
 * `atomic-send`: `send` may carry its selected thread's text and staged attachment handles in `draft`.
 * The host admits and sends that draft together, without a separate Compose request. A Compose save may also
 * carry `threadId` to retain its exact selected owner after Send. Neither field grants authority.
 * `draft-revisions`: targeted Compose and atomic Send accept stable draft IDs; recovery saves can
 * require an exact previous host revision. Socket save outcomes remain private to their caller.
 * `background-refresh`: `refresh-thread-worktree` takes `background`, a refresh the window made on its own, which asks
 * GitHub only as the host's timer would (#820). A client strips the field for a host that does not list it.
 * `watcher-work-settled`: the host's threads report their background work, monitoring and sub-agent counts, so a desktop's
 * Watcher can say when a finished turn's work has ended (ADR-0073). A host that does not list it reads as unknown, not idle.
 * `watcher-outcomes`: the host's exact operation reads carry each Watcher start's or send's outcome, its text-free result
 * reference and, once answered, that turn's reply (ADR-0073). A desktop asks for them; one whose host does not list it reads unknown.
 * `host-facts`: the host answers `host-facts` with its machine's host facts and how many of its threads are running a turn
 * (#1031). Numbers and the system's own name only. Only a desktop is offered it; one whose host does not list it reads unknown.
 * `watcher-muse`: the host takes Watcher requests from a desktop whose Watcher runs on Muse, whose identity names `muse` as
 * its provider (ADR-0079, #1039). It adds no request, field or push. A desktop whose Watcher is on Muse reads and directs
 * no thread on a host that does not list it, and says to update that host.
 * `thread-starts`: the host takes `continue-agent`, which continues one of a thread's agents as a thread of its own, and
 * `fork-thread`, which forks a thread at one of its replies (Fork from here), and
 * answers `start-handover` with the handover a thread that began from another goes with on its first message (#1028). Only
 * a host whose Owl answer turns them on lists it; a desktop refuses both for a host that does not.
 * `bring-changes-back`: the host takes `bring-changes-back`, which brings a thread's commits back to the branch of the
 * thread it began from, running Git on the host that holds both folders (#1030). Only a host whose Owl answer turns it on
 * lists it; a desktop refuses the command for a host that does not, and says to update it.
 * `pull-request-confirmation`: the host gives a **confirmation receipt** for one merge, close or auto-merge
 * (`pull-request-confirmation`), and refuses a `git-pull-request-action` of those three from any paired client that does
 * not carry one in `confirmation` (#1691, ADR-0027, October 28 amendment). A receipt counts once, for two minutes, for the
 * client it was given to and the exact thread, pull request, action and method, and for the head commit of the reading that
 * client shows, which it names by the `readId` each `git-pull-request` answer carries, and which `gh pr merge
 * --match-head-commit` holds GitHub to. The desktop asks for one only after the user
 * confirms in its window. Listed by every host that reads pull requests; the iPhone and Android clients send none of the
 * three presses.
 * `thread-prompts`: the host answers `thread-prompts` with every message the user sent before one, oldest first, from the
 * thread's store, and takes `load-earlier-messages` with `throughMessageId`, which widens the thread's window back to that
 * message, for the message scrubber (ADR-0109). Only a desktop is offered it. A desktop whose host does not list it marks
 * the messages the window holds, and sends no `throughMessageId`.
 * `host-update`: the host updates itself when a desktop asks (ADR-0088): `host-update` runs one step of a host update on
 * the host, the way the launch script runs it over SSH, and `host-update-step` pushes say which step it is on to a client
 * that accepts the feature. Offered only to a client the launch script recorded as a desktop whose `remote-answer` policy
 * lets it answer, and only by a host Sotto started from a release's own layout.
 * `provider-opencode`: the host sends OpenCode's provider row, models, projects and threads to a client whose hello accepts
 * it, and leaves every one of them out of what it sends any other client, whose provider list may not know `opencode` and
 * would refuse a whole shell that names it (#1107, ADR-0087). A client that does not accept it reads, observes and
 * commands no OpenCode thread there.
 * `opencode-sign-in`: the host signs its own Sotto OpenCode in to model sources, and out of them, for the desktop that asks
 * (`opencode-sign-in`, #1107, ADR-0037). Only a headless host whose OpenCode runs offers it, and only to a desktop.
 * `activity-bodies`: a desktop that accepts it is sent every activity record in a detail, a detail delta and a `detail`
 * answer with each body over 2,048 UTF-8 bytes cut, its whole size named in the record's `cut`, and answers
 * `activity-body` with one whole record (ADR-0025, October 18 amendment). A client that accepts `activity-summaries` too
 * is sent summaries. Only a desktop is offered it, and the desktop's own phone listener never offers it.
 * `failure-seen`: every thread in error carries the host's name for its failure (`failureId`) and its recorded reason
 * (`failureReason`), one that some client has shown or Dismiss all named carries `failureSeen`, and the host takes
 * `dismiss-failures`, which names each thread with the failure its row showed (ADR-0092). A desktop sends Dismiss all
 * only to a host that lists it, and says to update any other whose threads it named.
 * `usage-muse-opencode`: Usage reads and refreshes may name Muse and OpenCode, and their rows come back (October 21, 2026,
 * ADR-0083). A desktop names neither to a host that does not list it, and a host reads and sends a desktop whose hello does
 * not accept it only the providers Usage counted before, since that desktop's strict schemas refuse a read naming another.
 * `usage-background-refresh`: `usage-refresh` takes `background`, a refresh the desktop's Usage made on its own when it
 * opened, which a provider whose read is costly may answer from a reading of the last few minutes (#1456). Read again
 * never sends it. A desktop strips the field for a host that does not list it, which then reads that refresh afresh.
 * `watcher-phone-steer`: offered with `watcher-phone` on the Owl desktop's phone listener. A phone that accepts it may send
 * `watcher-phone-send` with `delivery: 'steer'`, which steers into Watcher's running turn, or queues the message to go next
 * when Watcher's provider takes no steer or the turn ended first; its page carries `current.steers` and `followups`, the
 * user's follow-ups waiting for Watcher; and `watcher-phone-remove-followup` takes one out of the queue (#1229).
 * `watcher-phone-photos`: offered with `watcher-phone` on a Watcher desktop's phone listener, where the host stages images.
 * A phone may add `images`, handles `stage-attachment` answered, to `watcher-phone-send`, with words or without; they go with
 * the message however it goes, now, as a steer or next. The page's messages carry their photos' markers, and
 * `watcher-phone-preview` answers one of them, as `preview` does for a thread the phone is shown (October 23, 2026).
 * `watcher-phone-files`: offered with `watcher-phone-photos` where the host also lists `file-staging`. A phone's
 * `watcher-phone-send` may then carry, in `images`, handles the last `stage-file-part` answered for files that are not
 * images, which reach Watcher as a thread's reply's files do (ADR-0131, October 28 amendment). Without it a non-image
 * handle is refused.
 * `client-update-outcomes`: offered with `client-updates`. The host's `check-client-updates` keeps what an update already
 * run said about a client while it still describes the client (the same version installed, the same release), so a
 * desktop may ask it to check afresh whatever its readings hold (ADR-0077, October 21 amendment). A host that does not
 * list it may set those findings aside when it checks.
 * `client-update-not-listed`: offered with `client-updates`. A client update's `failure` may be `not-listed`, when mise's
 * version list did not have the published version and Sotto could not install it (October 23 and 27, 2026). A desktop whose hello does
 * not accept it reads that failure as `installer`, since its strict schema refuses a value it does not know.
 * `agents-view`: the host offers the iPhone's Agents view (ADR-0103) and answers `thread-delegations` with what delegation's
 * record knows of each thread delegated below one thread, both levels: the delegating thread, the kind of work, when it
 * started, its outcome and the start of its brief, never a reply. A thread's sub-agents come from `subagents`. Only a host
 * whose Owl answer turns it on lists it; where delegation does not run, every thread reads as having none.
 * `branch-moves`: the host takes `branch-move`, which moves a committed branch between it and the desktop as a Git bundle in
 * chunks over this socket (ADR-0082, ADR-0105 decision 8): it reads a project's branch tips, takes a bundle into an incoming
 * ref of its own, or stages a thread's branch for the desktop to read. Only a host whose Owl answer turns on
 * `cross-machine-work` lists it, and only to a client the launch script recorded as a desktop.
 * `watcher-phone-machines`: offered with `watcher-phone` on the Owl desktop's phone listener while Work across machines is
 * on (#1032). A phone that accepts it is sent `machines` on its page, each machine with its working threads, its work
 * placed but not started and its load as last read, and may send `watcher-phone-read` with `machines: true`, which reads
 * the machines afresh before answering: when the user opens a machine's numbers or Watcher has placed work, never on a
 * timer.
 * `file-staging`: the host keeps an attached file that is not an image (ADR-0131), sent in parts with `stage-file-part`,
 * since a file in base64 can be larger than a frame. It keeps one upload per client in memory, drops it after two
 * minutes without a part or when the client leaves, checks the size and digest once the last part arrives, then answers
 * with the handle. Images still go by `stage-attachment`. Only a host whose Owl answer for `attach-any-file` is on lists
 * it; a desktop asks no other host to keep a file, and says to update it.
 * `provider-cursor`: as `provider-opencode`, for Cursor (ADR-0128). A host sends Cursor's provider row, models, projects and
 * threads only to a client whose hello accepts it, since a client from before Cursor reads provider IDs against a list
 * without `cursor` and would refuse a whole shell that names it.
 * `watcher-cursor`: as `watcher-muse`, for a desktop whose Watcher runs on Cursor, whose identity names `cursor` as its
 * provider (ADR-0128). It adds no request, field or push. A desktop whose Watcher is on Cursor reads and directs no thread
 * on a host that does not list it, and says to update that host.
 * `attachment-files`: the host hands a sent attached file's bytes to a client that reads its thread, for the iPhone's
 * Quick Look (ADR-0131, October 25 amendment). `attachment-file` names a thread, a message and an attachment, as `preview`
 * does, and a part: the host answers only for a file, never an image, that the message carries and its store keeps, at most
 * 8 MiB a part, and null otherwise. It takes the socket's preview guard, and the paired client has one such read at a time
 * across all its sockets. Only a host that lists `file-staging` lists it.
 * `project-origins`: the host answers `project-origins` with the GitHub repository each of its projects' `origin` remote
 * names, host, owner and name only, so a desktop placing a worker can find the same project on this machine (#1032). Only
 * a host whose Owl answer turns on Work across machines lists it, and only to a desktop; one that does not cannot be
 * matched by repository, and a start must name one of its projects instead.
 * `project-setup`: the host takes `project-setup`, which names a GitHub repository and a project title, and gives itself a
 * copy of that repository for a worker a desktop places there (#1690): a clone already in its usual projects folder becomes
 * a project and is brought up to date when nothing stands in the way, else the host clones the repository there. It
 * answers the project, how it was set up and whether it is current, or a refusal in plain words; it never prompts for a
 * password and removes nothing of the user's. Offered exactly where `project-origins` is; a desktop refuses a start on a
 * host without it that has no copy, and says to update it.
 * `host-delegation`: the host runs delegation for its own threads (#1310), so a thread there may delegate to threads on
 * the same machine, and it takes `desktop-defaults`, the desktop's new-thread default and worker roles, which it keeps and
 * holds those threads to. Only a host whose Owl answer turns on Work across machines lists it, and only to a desktop the
 * launch script recorded. A host never told holds every delegated start to Ask for approval.
 * `delegation-views`: the host answers `delegation-views` and `delegation-brief` for its own threads as the desktop's
 * window reads this computer's (#1310): what one thread delegated and was sent, with each delegation's outcome and timing,
 * and the newest brief a delegated thread was sent, never a reply. A desktop whose hello accepts it is pushed
 * `delegations-changed`, naming the threads whose delegations changed, and reads those it shows again. Only a host that
 * runs delegation for its own threads lists it, where its Owl answer turns on Work across machines, and only to a desktop
 * the launch script recorded.
 * `thread-delete`: the host takes `preview-delete-thread` and `delete-thread` for one of its settled threads (ADR-0140),
 * from a client whose `remote-answer` policy lets it answer, since a deletion cannot be taken back. Only a host whose Owl
 * answer turns clearing on lists it; a desktop shows Delete thread… off for a host that does not, and says to update it.
 * `bring-changes-back`: the host takes `bring-changes-back`, which brings a thread's commits back to the branch of the
 * thread it began from, running Git on the host that holds both folders (#1030). Only a host whose Owl answer turns on
 * `cross-machine-work` lists it; a desktop refuses the command for a host that does not, and says to update it.
 * `delegation-relay`: a thread on the host may delegate to a thread on another machine through the desktop (#1316,
 * ADR-0105 decisions 1 and 6). The host pushes `delegation-relay-ask` to a desktop whose hello accepted the feature, and
 * that desktop answers it with `delegation-relay-answer`, under its own rules, and tells the host each outcome change with
 * `delegation-relay-news`. Only a host that runs delegation for its own threads lists it, where its Owl answer turns on
 * Work across machines, and only to a desktop the launch script recorded; a desktop accepts it only where its own Owl
 * answer turns Work across machines on. While no such desktop is connected, a start elsewhere is refused by name and
 * nothing is queued.
 * `delegation-relay-send`: with `delegation-relay`, the host may push a `send` ask, another brief to a thread one of its
 * threads delegated to through the desktop (#1316 part 2). Listed and accepted under the same conditions.
 * `delegation-remote`: the desktop may ask this host, with `delegation-remote-ask`, to start a delegated thread here for a
 * thread on another machine, send it briefs, read it and cancel it, admitted by this host's own delegation (#1316 part 2,
 * ADR-0105 decision 1). The host pushes `delegation-remote-news` to that desktop when an outcome changes. Only a host that
 * runs delegation for its own threads lists it, where its Owl answer turns on Work across machines, and only to a desktop
 * the launch script recorded; a desktop accepts it only where its own Owl answer turns Work across machines on.
 * `delegation-branch-starts`: a delegated start on another machine may begin from the delegating thread's branch, or be a
 * check (#1316 part 2). Both ways go through the desktop, which moves the branch, or a check's snapshot, over its own
 * connections first. To this host, `delegation-remote-ask` may carry `branch`, a move the desktop already landed in the
 * host's project, and `test_run` in its input, which waits in this host's own check queue; to a desktop whose hello
 * accepted the feature, the host pushes a relayed start with `from_my_branch`, `test_run` and `takenAt`. Listed with
 * `delegation-remote` and `delegation-relay`, on the same terms; a desktop accepts it with them.
 * `watcher-check-stop`: a `stop_thread` the desktop's Watcher sends in `watcher-control` for a check still waiting in the
 * host's own queue (`watcher-check-queue`) takes it out (#1637): the host fails the waiting start as stopped, starts
 * nothing, and accepts the stop. A check whose turn has come is stopped as any thread is. Only a host that lists
 * `watcher-check-queue` lists it; a desktop facing a host without it leaves such a check to the user's Stop.
 * `check-queue-views`: the host pushes `check-queue`, its own check queue as its machine's panel and Tools › Agents show it
 * (#1312, fourth part), to a desktop whose hello accepted the feature: once after the hello, and again whenever the queue
 * changes. Each check is its ticket in the queue, whether it is Watcher's or a thread's, its thread and the thread that
 * asked once known, and the title, kind of work and provider that name it before its thread is made; never a brief, a
 * reply or a log. A thread the desktop is not sent is not named. Only a host that keeps a check queue lists it, where its
 * Owl answer turns on Work across machines, and only to a desktop the launch script recorded; a desktop accepts it only
 * where its own Owl answer turns Work across machines on. A desktop that does not accept it is pushed nothing.
 */
export const HOST_FEATURES = ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'answer-check', 'atomic-send', 'draft-revisions', 'background-refresh', 'pull-request-babysit', 'watcher-control', 'watcher-reads', 'usage-dashboard', 'watcher-phone', 'watcher-phone-stop-all', 'watcher-phone-manage', 'watcher-standing-watch', 'usage-history', 'watcher-work-settled', 'watcher-outcomes', 'host-facts', 'watcher-muse', 'thread-starts', 'host-update', 'provider-opencode', 'opencode-sign-in', 'activity-bodies', 'failure-seen', 'watcher-phone-steer', 'usage-muse-opencode', 'client-update-outcomes', 'pull-request-view', 'agents-view', 'provider-cursor', 'watcher-cursor', 'usage-background-refresh', 'client-update-not-listed', 'thread-prompts', 'file-staging', 'watcher-phone-photos', 'attachment-files', 'project-origins', 'watcher-phone-machines', 'host-delegation', 'thread-delete', 'delegation-views', 'branch-moves', 'bring-changes-back', 'delegation-relay', 'watcher-check-queue', 'watcher-check-stop', 'check-queue-views', 'project-setup', 'delegation-relay-send', 'delegation-remote', 'delegation-branch-starts', 'watcher-phone-files', 'pull-request-confirmation'] as const
export type HostFeature = typeof HOST_FEATURES[number]
/**
 * The features a headless host's tailnet listener offers only to a client the launch script recorded as a desktop
 * (ADR-0053). Its health lists them; a phone's hello does not, and their requests are refused for a phone.
 */
export const HOST_DESKTOP_FEATURES: readonly HostFeature[] = ['provider-sign-in', 'client-updates', 'client-update-outcomes', 'client-update-not-listed', 'watcher-control', 'watcher-reads', 'watcher-standing-watch', 'watcher-work-settled', 'watcher-outcomes', 'host-facts', 'watcher-muse', 'watcher-cursor', 'host-update', 'opencode-sign-in', 'activity-bodies', 'thread-prompts', 'project-origins', 'host-delegation', 'delegation-views', 'branch-moves', 'delegation-relay', 'check-queue-views', 'project-setup', 'delegation-relay-send', 'delegation-remote', 'delegation-branch-starts']
/**
 * The providers a host sends only to a client whose hello accepts their feature (#1107, ADR-0087). A desktop or phone from
 * before a provider joined Sotto reads provider IDs against a list without it, and refuses a whole shell that names one, so
 * the host leaves the provider's rows, models, projects and threads out of what it sends that client.
 */
export const PROVIDER_HOST_FEATURES = { opencode: 'provider-opencode', cursor: 'provider-cursor' } as const satisfies Partial<Record<ProviderId, HostFeature>>
/** The providers a client's hello does not accept the feature of, which the host leaves out of everything it sends it. */
export function providersUnknownTo(accepts: readonly string[] | undefined): HeldProviders {
  return new Set((Object.entries(PROVIDER_HOST_FEATURES) as [ProviderId, HostFeature][]).filter(([, feature]) => !accepts?.includes(feature)).map(([provider]) => provider))
}
/**
 * What a desktop may ask of a host that updates itself (ADR-0088): download and check a release's archive, install it
 * beside the running version, restart into it, cancel its own download, or read how the last restart went. The client
 * names a version, and for `install` the archive's name and checksum `fetch` answered; never a URL, a path or any code.
 */
export const HOST_UPDATE_REQUEST_ACTIONS = ['fetch', 'install', 'restart', 'cancel', 'outcome'] as const
export type HostUpdateRequestAction = typeof HOST_UPDATE_REQUEST_ACTIONS[number]
/**
 * A client update as a client that does not accept `client-updates` can read it: the mise channel, which such a client
 * does not know, reads as one it will not drive, and a client waiting in the update line reads as not started. Every
 * other field it does not know is optional and ignored.
 */
export function clientUpdateForOlderClient(update: ProviderClientUpdate): ProviderClientUpdate {
  return clientUpdateWithoutNotListed({ ...update, ...(update.channel === 'mise' ? { channel: 'unknown' as const } : {}), ...(update.state === 'queued' ? { state: 'idle' as const } : {}) })
}
/** A client update as a client that does not accept `client-update-not-listed` reads it: that failure as the installer's. */
export function clientUpdateWithoutNotListed(update: ProviderClientUpdate): ProviderClientUpdate {
  return update.failure === 'not-listed' ? { ...update, failure: 'installer' } : update
}
/**
 * An activity record as a summary row reads it, for a client that accepts `activity-summaries` (#701): what it is, how
 * it went, how long it took, the command it ran and the files it changed. Its output, text, error, folder, diffs, plan,
 * agents and context stay on the host. It is still an activity record under the same schema, with the same ID and
 * sequence, so a delta of summaries applies to a detail of summaries exactly as a delta of whole records does.
 */
export function activitySummary(record: AgentActivity): AgentActivity {
  return {
    id: record.id, turnId: record.turnId, sequence: record.sequence, kind: record.kind, status: record.status, title: record.title,
    ...(record.command !== undefined ? { command: record.command } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.changes !== undefined ? { changes: record.changes.map(change => ({ path: change.path, kind: change.kind })) } : {}),
  }
}
/** A message without the visual Sotto drew for it (ADR-0056): its text, the visual's words, stands in. */
function withoutVisual(message: AgentMessage): AgentMessage {
  if (!('visual' in message)) return message
  const { visual, ...rest } = message
  void visual
  return rest
}
/**
 * A thread's detail as a socket client is sent it: every visual message keeps its text and loses its `visual`, so the
 * iPhone shows a visual's explanation and the line saying the drawing is on the computer (ADR-0056). The same detail
 * when it holds no visual.
 */
export function detailWithoutVisuals(detail: AgentThreadDetail): AgentThreadDetail {
  return detail.messages.some(message => 'visual' in message) ? { ...detail, messages: detail.messages.map(withoutVisual) } : detail
}
/** The same for a detail delta: a whole message it carries loses its `visual`. Its revisions are unchanged, so it still applies. */
export function deltaWithoutVisuals(delta: AgentThreadDetailDelta): AgentThreadDetailDelta {
  return delta.messageDeltas.some(item => 'message' in item && 'visual' in item.message)
    ? { ...delta, messageDeltas: delta.messageDeltas.map(item => 'message' in item ? { message: withoutVisual(item.message) } : item) } : delta
}
/** A thread's detail with each activity record as its summary. Messages, revision and the rest are the detail's own. */
export function detailWithActivitySummaries(detail: AgentThreadDetail): AgentThreadDetail {
  return detail.activities === undefined ? detail : { ...detail, activities: detail.activities.map(activitySummary) }
}
/** A detail delta with each record it carries as its summary. Removals and the revisions are unchanged, so it still applies. */
export function deltaWithActivitySummaries(delta: AgentThreadDetailDelta): AgentThreadDetailDelta {
  return delta.activityDeltas.length === 0 ? delta
    : { ...delta, activityDeltas: delta.activityDeltas.map(item => 'record' in item ? { record: activitySummary(item.record) } : item) }
}
/**
 * Whether a host's Sotto version is later than this client's, by release number. A version that cannot
 * be read, such as a host from before v1 froze that advertises none, is never newer.
 */
export function hostIsNewer(hostVersion: string | undefined, clientVersion: string): boolean {
  return compareSottoVersions(hostVersion, clientVersion) === 1
}
/**
 * Whether a host's Sotto version is earlier than this client's, by release number: the host needs an update
 * (ADR-0040). A version that cannot be read is never older, so nothing is offered for a host that says nothing.
 */
export function hostIsOlder(hostVersion: string | undefined, clientVersion: string): boolean {
  return compareSottoVersions(hostVersion, clientVersion) === -1
}
/** -1, 0 or 1 by release number; null when either side is not a release number. */
function compareSottoVersions(hostVersion: string | undefined, clientVersion: string): -1 | 0 | 1 | null {
  const parts = (version: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
  }
  const host = hostVersion === undefined ? null : parts(hostVersion), client = parts(clientVersion)
  if (!host || !client) return null
  for (let index = 0; index < 3; index += 1) if (host[index] !== client[index]) return host[index]! > client[index]! ? 1 : -1
  return 0
}
/**
 * What a client says when a host speaks a version of the protocol it cannot use: a host from before v1
 * froze, or one of another Sotto version sending what this client cannot read. The host keeps running,
 * so nothing on it is lost. The last sentence is the way out, and it depends on which side is behind:
 * Connect starts whatever is in the host installation folder, so an older host needs this computer's
 * version put there before it is stopped, and a newer one needs this computer updated instead.
 * `owned` says whether Sotto started the host, and so whether Stop host is there to press. `newer` is whether the host
 * is ahead, by release number unless the caller orders Owl builds too.
 */
export function hostVersionMismatch(clientVersion: string, hostVersion: string | undefined, owned: boolean, newer = hostIsNewer(hostVersion, clientVersion)): string {
  if (newer) return 'This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again.'
  const stop = owned ? 'press Stop host' : 'stop the host on that machine'
  // A host that said which older Sotto it runs is offered an update on the Threads page (ADR-0040).
  const update = hostIsOlder(hostVersion, clientVersion) ? 'Update it from the Threads page, or put' : 'Put'
  return `This host is running a different version of Sotto. Nothing on the host was lost. ${update} the Sotto ${clientVersion} host in its installation folder, ${stop}, then connect again.`
}
export const HOST_MAX_FRAME_BYTES = 16 * 1024 * 1024
export const HOST_EVENT_PAGE_SIZE = 256
const id = z.string().min(1).max(512)
/** Evidence of acceptance of one exact answer attempt; never the question or answer text. */
export const hostAnswerTargetSchema = z.object({ threadId: id, providerId: providerIdSchema, requestId: id,
  questionsDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export type HostAnswerTarget = z.infer<typeof hostAnswerTargetSchema>
/** Feature names are read leniently, so a name this build does not know is ignored rather than refused. */
const featureList = z.array(z.string().min(1).max(64)).max(64)
const sottoVersion = z.string().min(1).max(64)
const base = { v: z.literal(1), id, session: z.string().min(1).max(2048) }
/** An image as it crosses the socket: base64 inside one frame, at most 10 MiB of bytes. */
const imageData = z.string().max(Math.ceil(10 * 1024 * 1024 / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u)
export const hostAttachmentSchema = z.object({ name: z.string().trim().min(1).max(255), mimeType: z.enum(AGENT_IMAGE_MIME_TYPES), data: imageData,
  dimensions: agentAttachmentDimensionsSchema.optional() }).strict()
export const hostAttachmentContentSchema = z.object({ mimeType: z.enum(AGENT_IMAGE_MIME_TYPES), data: imageData }).strict().nullable()
/** The raw bytes one `stage-file-part` carries at most: about 11.2 MB of base64, inside one 16 MiB frame. */
export const HOST_FILE_PART_BYTES = 8 * 1024 * 1024
/** The most parts a file may take: a 25 MiB file in 8 MiB parts. */
export const HOST_FILE_PARTS_MAX = Math.ceil(AGENT_MAX_FILE_BYTES / HOST_FILE_PART_BYTES)
/**
 * One part of an attached file on its way to a host (`file-staging`, ADR-0131). Every part names the whole file, so the
 * host can tell a part of this upload from one of another; parts go in order, from 0 to `count - 1`.
 */
export const hostFilePartSchema = z.object({
  uploadId: z.uuid(), index: z.number().int().min(0).max(HOST_FILE_PARTS_MAX - 1), count: z.number().int().min(1).max(HOST_FILE_PARTS_MAX),
  name: z.string().trim().min(1).max(255), mimeType: agentMimeTypeSchema, sizeBytes: z.number().int().min(1).max(AGENT_MAX_FILE_BYTES),
  digest: attachmentDigestSchema, data: z.string().min(1).max(Math.ceil(HOST_FILE_PART_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
}).strict().refine(part => part.index < part.count, 'A part must be one of its upload’s parts.')
export type HostFilePart = z.infer<typeof hostFilePartSchema>
/** One part of a sent attached file a client asks for by its message (`attachment-files`). */
export const hostAttachmentFileRequestSchema = z.object({
  threadId: z.string().min(1).max(512), messageId: z.string().min(1).max(512), attachmentId: z.string().min(1).max(512),
  part: z.number().int().min(0).max(HOST_FILE_PARTS_MAX - 1),
}).strict()
export type HostAttachmentFileRequest = z.infer<typeof hostAttachmentFileRequestSchema>
/** A part of the file's bytes in base64, with what the whole file is, so the client can check it once every part is in. */
export const hostAttachmentFileSchema = z.object({
  name: z.string().min(1).max(255), mimeType: agentMimeTypeSchema, sizeBytes: z.number().int().min(1).max(AGENT_MAX_FILE_BYTES), digest: attachmentDigestSchema,
  part: z.number().int().min(0).max(HOST_FILE_PARTS_MAX - 1), parts: z.number().int().min(1).max(HOST_FILE_PARTS_MAX),
  data: z.string().min(1).max(Math.ceil(HOST_FILE_PART_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
}).strict().nullable()
export type HostAttachmentFile = z.infer<typeof hostAttachmentFileSchema>
/** Just enough of a request to answer it: a request the host cannot otherwise read is refused by its id. */
export const hostRequestEnvelopeSchema = z.object(base)
export const hostRequestSchema = z.discriminatedUnion('op', [
  // `machines`: only from a phone that negotiated `watcher-phone-machines`, which has the machines read afresh first.
  z.object({ ...base, op: z.literal('watcher-phone-read'), machines: z.literal(true).optional() }).strict(),
  z.object({ ...base, op: z.literal('watcher-phone-set-permission'), request: watcherPhoneSetPermissionSchema }).strict(),
  z.object({ ...base, op: z.literal('watcher-phone-watch'), request: watcherPhoneWatchSchema }).strict(),
  z.object({ ...base, op: z.literal('watcher-phone-unwatch'), request: watcherPhoneWatchSchema }).strict(),
  z.object({ ...base, op: z.literal('watcher-phone-send'), request: watcherPhoneSendSchema }).strict(),
  z.object({ ...base, op: z.literal('watcher-phone-remove-followup'), request: watcherPhoneRemoveFollowupSchema }).strict(),
  z.object({ ...base, op: z.literal('watcher-phone-preview'), request: watcherPhonePreviewSchema }).strict(),
  z.object({ ...base, op: z.literal('watcher-phone-answer'), request: watcherPhoneAnswerSchema }).strict(),
  z.object({ ...base, op: z.literal('watcher-phone-prepare-stop-all') }).strict(),
  z.object({ ...base, op: z.literal('watcher-phone-stop-all'), confirmationId: z.uuid() }).strict(),
  z.object({ ...base, op: z.literal('watcher-control'), request: watcherHostControlSchema }).strict(),
  z.object({ ...base, op: z.literal('watcher-read'), request: watcherHostReadSchema }).strict(),
  z.object({ ...base, op: z.literal('hello'), afterSeq: z.number().int().nonnegative().optional(), accepts: featureList.optional() }).strict(),
  z.object({ ...base, op: z.literal('shell') }).strict(),
  z.object({ ...base, op: z.literal('detail'), threadId: id }).strict(),
  z.object({ ...base, op: z.literal('events'), afterSeq: z.number().int().nonnegative(), threadId: id.optional() }).strict(),
  /** `shown: false`: a desktop whose window is behind another app, minimised or in the tray. Its threads stay observed, so
   * they keep streaming, but none counts as shown, which reads a finish or sees a failure (ADR-0046, ADR-0092). Sent only
   * to a host that lists `failure-seen`; absent, the threads are shown, as from every older client and every phone. */
  z.object({ ...base, op: z.literal('observe'), threadIds: z.array(id).max(100), shown: z.literal(false).optional() }).strict(),
  z.object({ ...base, op: z.literal('command'), command: protocolAgentCommandSchema }).strict(),
  z.object({ ...base, op: z.literal('preview'), request: agentAttachmentPreviewRequestSchema }).strict(),
  z.object({ ...base, op: z.literal('receipt'), commandId: id, answer: hostAnswerTargetSchema.optional() }).strict(),
  z.object({ ...base, op: z.literal('check-answer'), answer: hostAnswerTargetSchema }).strict(),
  /** The branches a thread's folder offers, for the picker; read on request, never pushed (ADR-0027). */
  z.object({ ...base, op: z.literal('git-refs'), request: gitRefsRequestSchema }).strict(),
  /** The changed files of a thread's folder with their line counts, for the commit dialog; read on request (ADR-0027). */
  z.object({ ...base, op: z.literal('git-changed-files'), request: gitChangedFilesRequestSchema }).strict(),
  /** One of a thread's pull requests, read through gh for the Pull request surface; read on request (ADR-0027). */
  z.object({ ...base, op: z.literal('git-pull-request'), request: gitPullRequestRequestSchema }).strict(),
  /** A confirmation receipt for one merge, close or auto-merge the client is about to send (`pull-request-confirmation`, #1691). */
  z.object({ ...base, op: z.literal('pull-request-confirmation'), request: pullRequestConfirmationRequestSchema }).strict(),
  /** An image for a draft on this host, sent once; the answer is its handle (ADR-0031). */
  z.object({ ...base, op: z.literal('stage-attachment'), image: hostAttachmentSchema }).strict(),
  /** A staged image's bytes by digest, for a chip the client holds no copy of; null once the host no longer keeps it. */
  z.object({ ...base, op: z.literal('attachment-content'), digest: attachmentDigestSchema }).strict(),
  /** One part of a file for a draft on this host (`file-staging`); the last part's answer is its handle, the others' null. */
  z.object({ ...base, op: z.literal('stage-file-part'), part: hostFilePartSchema }).strict(),
  z.object({ ...base, op: z.literal('attachment-file'), request: hostAttachmentFileRequestSchema }).strict(),
  /** One folder's subfolders on the host, for the Add project dialog's folder browser; read on request. */
  z.object({ ...base, op: z.literal('host-folders'), request: hostFoldersRequestSchema }).strict(),
  /** One folder's entries in a thread's working copy, for Files; read on request (ADR-0025, October 5 amendment). */
  z.object({ ...base, op: z.literal('thread-files'), request: fileListRequestSchema }).strict(),
  /** One file's preview from a thread's working copy, for Files; one at a time per client, on the preview guard. */
  z.object({ ...base, op: z.literal('thread-file-preview'), request: fileRequestSchema }).strict(),
  /** A thread's changed files as Git's status lists them, for Changes; read on request. */
  z.object({ ...base, op: z.literal('thread-changes'), request: toolListRequestSchema }).strict(),
  /** A thread's Working tree or Branch changes comparison, for Changes; one at a time per client, on the preview guard. */
  z.object({ ...base, op: z.literal('thread-changes-review'), request: gitReviewRequestSchema }).strict(),
  /** A page of a thread's agents, and one agent's assignments, for Agents; read on request. */
  z.object({ ...base, op: z.literal('subagent-page'), request: subagentPageRequestSchema }).strict(),
  z.object({ ...base, op: z.literal('subagent-assignments'), request: subagentAssignmentsRequestSchema }).strict(),
  /** The host's machine facts and running thread count, read on request and never pushed (#1031). */
  z.object({ ...base, op: z.literal('host-facts') }).strict(),
  /** The GitHub repository of each of the host's projects, read on request and never pushed (#1032). */
  z.object({ ...base, op: z.literal('project-origins') }).strict(),
  /** A copy of a GitHub repository set up on the host for a worker placed there (#1690). */
  z.object({ ...base, op: z.literal('project-setup'), request: projectSetupRequestSchema }).strict(),
  /** A desktop's new-thread default and worker roles, which a host that runs delegation for its own threads keeps (#1310). */
  z.object({ ...base, op: z.literal('desktop-defaults'), defaults: desktopDefaultsSchema }).strict(),
  /** One activity record whole, for a desktop that was sent it with a cut body; read when its row opens (`activity-bodies`). */
  z.object({ ...base, op: z.literal('activity-body'), threadId: id, activityId: id }).strict(),
  /** The words of a started thread's handover, read only when the user asks to read them (#1028). */
  z.object({ ...base, op: z.literal('start-handover'), threadId: id }).strict(),
  /** Every message the user sent before one, for the message scrubber, read when a pane opens or widens (`thread-prompts`). */
  z.object({ ...base, op: z.literal('thread-prompts'), threadId: id, beforeMessageId: id }).strict(),
  /** One step of a host update, run by the host on itself for a desktop that may answer (ADR-0088). */
  z.object({ ...base, op: z.literal('host-update'), action: z.enum(HOST_UPDATE_REQUEST_ACTIONS), version: z.string().min(1).max(64).optional(),
    file: z.string().min(1).max(128).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional() }).strict(),
  z.object({ ...base, op: z.literal('usage-read'), query: usageLocalQuerySchema }).strict(),
  z.object({ ...base, op: z.literal('usage-refresh'), providerIds: z.array(usageProviderIdSchema).max(usageProviderIdSchema.options.length).optional(),
    background: z.literal(true).optional() }).strict(),
  z.object({ ...base, op: z.literal('usage-clear'), request: usageLocalClearRequestSchema }).strict(),
  /**
   * A provider's sign-in on the host, for the client that asks and for no other (ADR-0037): start one, read where it
   * stands, hand its client a code pasted from the sign-in page, or cancel it. Each answers with the sign-in, or null.
   */
  z.object({ ...base, op: z.literal('sign-in-start'), provider: providerIdSchema }).strict(),
  z.object({ ...base, op: z.literal('sign-in-read'), signInId: z.uuid() }).strict(),
  z.object({ ...base, op: z.literal('sign-in-code'), signInId: z.uuid(), code: z.string().min(1).max(PASTED_CODE_MAX) }).strict(),
  z.object({ ...base, op: z.literal('sign-in-cancel'), signInId: z.uuid() }).strict(),
  /** The host's own OpenCode signed in to a model source, or out of one, for the desktop that asks (#1107). */
  z.object({ ...base, op: z.literal('opencode-sign-in'), call: opencodeHostCallSchema }).strict(),
  /** A thread's delegated threads as delegation's record knows them, for the iPhone's Agents view (`agents-view`, ADR-0103). */
  z.object({ ...base, op: z.literal('thread-delegations'), threadId: id }).strict(),
  /** What one of the host's threads delegated and was sent, as the desktop's window reads it (`delegation-views`, #1310). */
  z.object({ ...base, op: z.literal('delegation-views'), threadId: id }).strict(),
  /** The newest brief one of the host's delegated threads was sent, in full, never a reply (`delegation-views`). */
  z.object({ ...base, op: z.literal('delegation-brief'), threadId: id }).strict(),
  /** One step of a branch move, either way, for a recorded desktop (`branch-moves`, ADR-0105 decision 8). */
  z.object({ ...base, op: z.literal('branch-move'), request: hostBranchMoveRequestSchema }).strict(),
  /** The desktop's answer to an ask the host pushed (`delegation-relay`, #1316): a `delegate`, read or cancel result, or a machine list. */
  z.object({ ...base, op: z.literal('delegation-relay-answer'), askId: z.uuid(), result: z.unknown() }).strict(),
  /** A relayed delegation's outcome changed (`delegation-relay`): the host tells the thread that delegated, as a hidden wake-up. */
  /** The name the desktop saved for this host, which the host's refusal says while no desktop is connected (Zach, October 27, 2026). */
  z.object({ ...base, op: z.literal('delegation-relay-name'), name: z.string().trim().min(1).max(64) }).strict(),
  z.object({ ...base, op: z.literal('delegation-relay-news'), threadId: id, news: delegationRelayNewsSchema, replies: relayedRepliesSchema.optional() }).strict(),
  /** A delegation on this host for a thread on another machine (`delegation-remote`, #1316 part 2): a `delegate`, read or cancel, answered with its result. */
  z.object({ ...base, op: z.literal('delegation-remote-ask'), ask: delegationRemoteAskSchema }).strict(),
])
export type HostRequest = z.infer<typeof hostRequestSchema>
export type HostOperation = HostRequest extends infer R ? R extends HostRequest ? Omit<R, 'v' | 'id' | 'session'> : never : never
export type HostErrorCode = 'unauthenticated' | 'invalid_request' | 'stale_request' | 'forbidden' | 'unavailable' | 'busy' | 'too_large'
/**
 * `reason` says why a `git-pull-request` read was refused `unavailable`, in words of the protocol's own (#1290), for a
 * client to say what to do next; any other refusal, and a host before it, leaves it out. Older readers ignore it.
 */
export interface HostProtocolError { code: HostErrorCode; message: string; reason?: GitPullRequestReadFailure | undefined }
export type HostResponse = { v: 1; id: string; ok: true; result: unknown } | { v: 1; id: string; ok: false; error: HostProtocolError }
/** `error` stands in for a push that would not fit in one frame, instead of the host closing the socket. */
export type HostClientShell = AgentState & { watcher?: WatcherPhoneState | undefined; clientCapabilities?: { mayAnswer: boolean } | undefined; terminals?: [] | undefined }
/**
 * A shell as it crosses the socket. To a client that accepts `model-catalog-revision` its `host` names the
 * catalog's revision and leaves `models` out when this connection was already sent that revision; to every
 * other client it is a `HostClientShell` as v1 has it.
 */
export type HostWireShell = Omit<HostClientShell, 'host'> & {
  host: Omit<AgentState['host'], 'models'> & { models?: AgentModel[] | undefined; modelsRevision?: number | undefined }
}
export type HostPush = { v: 1; event: 'shell'; state: HostWireShell; eventPage?: HostEventPage | undefined } | { v: 1; event: 'detail'; detail: AgentThreadDetail | null; threadId: string }
  | { v: 1; event: 'watcher-state'; projection: z.infer<typeof watcherHostProjectionSchema> }
  | { v: 1; event: 'detail-delta'; threadId: string; delta: AgentThreadDetailDelta }
  | { v: 1; event: 'answer-receipt'; acceptedAnswer: HostAnswerTarget & { decisionId: string } }
  | { v: 1; event: 'error'; threadId?: string | undefined; error: HostProtocolError }
  /** Which step a host update this client asked for is on (ADR-0088); only to a client that accepts `host-update`. */
  | { v: 1; event: 'host-update-step'; step: HostUpdateStep }
  /** The host's threads whose delegations changed (#1310); only to a desktop that accepts `delegation-views`. */
  | { v: 1; event: 'delegations-changed'; threadIds: string[] }
  /** An ask for the desktop relay (#1316); only to a desktop whose hello accepted `delegation-relay`. */
  | { v: 1; event: 'delegation-relay-ask'; askId: string; ask: DelegationRelayAsk }
  /** The host's own check queue, the running check first (#1312); only to a desktop whose hello accepted `check-queue-views`. */
  | { v: 1; event: 'check-queue'; checks: CheckQueueEntry[] }
  /** A delegation this host holds for a thread on another machine changed (#1316 part 2); only to the desktop that asked, whose hello accepted `delegation-remote`. */
  | { v: 1; event: 'delegation-remote-news'; caller: string; news: z.infer<typeof delegationRelayNewsSchema>; replies?: z.infer<typeof relayedRepliesSchema> | undefined }
export interface HostEventPage { events: StoredThreadEvent[]; latestSeq: number; hasMore: boolean }
/**
 * What a headless host says about itself in health and hello (ADR-0053, ADR-0054). `tailnetAddress` is the address
 * Tailscale Serve carries its tailnet listener at, `https://<MagicDNS name>:<port>`, while Serve runs for it. `startedBy`
 * is who started it, as its listener descriptor records: `launch-script` or `boot` (its start at boot unit), and absent
 * for a host its owner started by hand. A value this build does not know reads as absent. Neither is evidence of identity: the host's ID, its certificate and the pairing are.
 */
export interface HostAbout { tailnetAddress?: string | undefined; startedBy?: string | undefined }
/** A host's phone access in the words its row uses, as hello reports it to a desktop (ADR-0053): off, starting, on with how many phones are paired, or needs the owner. */
export const HOST_PHONE_ACCESS_STATUSES = ['off', 'starting', 'on', 'needs-you'] as const
export interface HostPhoneAccessSummary { status: typeof HOST_PHONE_ACCESS_STATUSES[number]; phones: number }
/**
 * `capabilities` is what this client may do on this host; `features` is what the host's protocol offers this client,
 * which on a headless host's tailnet listener depends on whether it is a desktop (ADR-0053). `phoneAccess` goes only to
 * a desktop, as it stood when the session's hello was answered.
 */
export interface HostHello extends HostEventPage, HostAbout { hostId: string; clientId: string; shell: HostClientShell; capabilities: { mayAnswer: boolean }; sottoVersion: string; features: string[]; phoneAccess?: HostPhoneAccessSummary | undefined }
export interface HostSession { v: 1; hostId: string; clientId: string; session: string; expiresAt: string }
export interface HostPairing { v: 1; hostId: string; clientId: string; token: string }
export interface HostReceipt {
  status: 'pending' | 'completed' | 'unknown'; error?: HostProtocolError | undefined
  /** This answer command's own successful outcome. Older hosts omit it; completion alone proves none. */
  answerDelivered?: boolean | undefined
  /** Acceptance of this authenticated client's exact answer attempt and original questions. */
  acceptedAnswer?: (HostAnswerTarget & { decisionId: string }) | undefined
  /** Exact Stop all outcome, including partial results, for this authenticated phone's request ID. */
  watcherStop?: WatcherPhoneStopOutcome | undefined
  watcherManage?: WatcherPhoneManageOutcome | undefined
}
/** Written to host-listener.json and served, with `status`, as /v1/health. */
export interface HostDescriptor extends HostAbout { v: 1; pid: number; hostId: string; port: number; sottoVersion: string; features: string[] }
export interface HostHealth extends HostDescriptor {
  status: 'ready'
  /** The computer's name as its owner set it for phones; only the desktop's phone access sends it (ADR-0033). */
  name?: string
}
export const HOST_SESSION_REJECTED = 'This connection is no longer authorized. Connect again or pair this device on the host.'
/** What an HTTP 429 from the host means to the user: nothing is wrong with this device, and waiting is the fix. */
export const HOST_BUSY = 'The host is busy. Nothing was lost. Try again in a moment.'

const eventPageShape = { events: z.array(z.object({ seq: z.number().int().nonnegative(), threadId: id, event: threadEventSchema })).max(HOST_EVENT_PAGE_SIZE), latestSeq: z.number().int().nonnegative(), hasMore: z.boolean() }
export const hostEventPageSchema = z.object(eventPageShape)
export const hostPairingSchema = z.object({ v: z.literal(1), hostId: z.uuid(), clientId: id, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
export const hostSessionSchema = z.object({ v: z.literal(1), hostId: z.uuid(), clientId: id, session: z.string().min(1).max(2048), expiresAt: z.iso.datetime() })
/**
 * Health's and hello's additions since v1 froze. Each is optional and read leniently: a value this build cannot read,
 * such as a later host's new `startedBy` or phone access status, reads as absent rather than refusing the whole answer.
 */
const aboutShape = {
  tailnetAddress: z.string().min(1).max(300).optional().catch(undefined),
  startedBy: z.string().min(1).max(64).optional().catch(undefined),
}
export const hostPhoneAccessSchema = z.object({ status: z.enum(HOST_PHONE_ACCESS_STATUSES), phones: z.number().int().nonnegative().max(1000) })
export const hostHelloSchema = z.object({ ...eventPageShape, hostId: z.uuid(), clientId: id, shell: protocolAgentStateSchema, capabilities: z.object({ mayAnswer: z.boolean() }), sottoVersion, features: featureList,
  ...aboutShape, phoneAccess: hostPhoneAccessSchema.optional().catch(undefined) })
/** One activity record whole as a host answers `activity-body`, or null when the thread no longer has it. */
export const hostActivityBodySchema = agentActivitySchema.nullable()
/** The prompts above a pane's window as a host answers `thread-prompts`, or null when its store cannot say (ADR-0109). */
export const hostThreadPromptsSchema = agentThreadPromptsSchema.nullable()
/** A started thread's handover as a host answers `start-handover`: its words, or null when it has none (#1028). */
export const hostStartHandoverSchema = z.object({ handover: z.object({ text: z.string() }).strict().nullable() }).strict()
export const hostHealthSchema = z.object({ v: z.literal(1), status: z.literal('ready'), hostId: z.uuid(), pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), sottoVersion, features: featureList, ...aboutShape })
/**
 * The host ID, Sotto version and features a host's health advertises, or null when the host does not speak the
 * frozen v1: another protocol version, or a host from before the freeze that advertises neither.
 */
export function hostHealthFeatures(value: unknown): { hostId: string; sottoVersion: string; features: string[] } | null {
  const health = hostHealthSchema.safeParse(value)
  return health.success ? { hostId: health.data.hostId, sottoVersion: health.data.sottoVersion, features: health.data.features } : null
}
export const hostProtocolErrorSchema = z.object({ code: z.enum(['unauthenticated', 'invalid_request', 'stale_request', 'forbidden', 'unavailable', 'busy', 'too_large']), message: z.string().min(1).max(1000) })
export const hostResponseSchema = z.discriminatedUnion('ok', [
  z.object({ v: z.literal(1), id, ok: z.literal(true), result: z.unknown() }),
  z.object({ v: z.literal(1), id, ok: z.literal(false), error: hostProtocolErrorSchema }),
])
export const hostPushSchema = z.discriminatedUnion('event', [
  z.object({ v: z.literal(1), event: z.literal('watcher-state'), projection: watcherHostProjectionSchema }),
  z.object({ v: z.literal(1), event: z.literal('shell'), state: protocolAgentStateSchema, eventPage: hostEventPageSchema.optional() }),
  z.object({ v: z.literal(1), event: z.literal('detail'), threadId: id, detail: agentThreadDetailResultSchema }),
  z.object({ v: z.literal(1), event: z.literal('detail-delta'), threadId: id, delta: agentThreadDetailDeltaSchema }),
  z.object({ v: z.literal(1), event: z.literal('answer-receipt'), acceptedAnswer: hostAnswerTargetSchema.extend({ decisionId: id }) }),
  z.object({ v: z.literal(1), event: z.literal('error'), threadId: id.optional(), error: hostProtocolErrorSchema }),
  z.object({ v: z.literal(1), event: z.literal('host-update-step'), step: z.enum(HOST_UPDATE_STEPS) }),
  /** The host's threads whose delegations changed (`delegation-views`), only to a desktop whose hello accepts it. */
  z.object({ v: z.literal(1), event: z.literal('delegations-changed'), threadIds: z.array(id).max(DELEGATIONS_CHANGED_MAX) }),
  /** An ask for the desktop relay (`delegation-relay`), only to a desktop whose hello accepted it. */
  z.object({ v: z.literal(1), event: z.literal('delegation-relay-ask'), askId: z.uuid(), ask: delegationRelayAskSchema }),
  /** The host's own check queue (`check-queue-views`), only to a desktop whose hello accepted it. */
  z.object({ v: z.literal(1), event: z.literal('check-queue'), checks: checkQueueSchema }),
  /** News of a delegation this host holds for a thread on another machine (`delegation-remote`), only to the desktop that asked. */
  z.object({ v: z.literal(1), event: z.literal('delegation-remote-news'), caller: z.string().min(1).max(DELEGATION_REMOTE_CALLER_MAX), news: delegationRelayNewsSchema, replies: relayedRepliesSchema.optional() }),
])
export const hostReceiptSchema = z.object({ status: z.enum(['pending', 'completed', 'unknown']), error: hostProtocolErrorSchema.optional(),
  answerDelivered: z.boolean().optional(), acceptedAnswer: hostAnswerTargetSchema.extend({ decisionId: id }).optional(),
  watcherManage: watcherPhoneManageOutcomeSchema.optional().catch(undefined),
  watcherStop: watcherPhoneStopOutcomeSchema.optional().catch(undefined) })
