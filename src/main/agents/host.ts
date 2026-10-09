import type { BrowserAgentTools } from './browserAgentServer'
import type { ScopedThreadTools, ThreadMcpServer } from './threadToolServer'
import type { AgentActivity } from '../../shared/agentActivity'
import type { AgentSkillCatalog, AgentSkillReference } from '../../shared/agentSkills'
import type { AgentFileReference } from '../../shared/agentFiles'
import type { AnswerGivenEvent } from '../../shared/threadEvents'
import type { WorktreeReclaimPreview, AgentWorkingCopyOptions, AgentWorkingCopySelection, AgentAttachmentHandle, AgentHostSnapshot, AgentMessage, AgentProject, AgentQuestionAnswers, AgentRuntimeMode, AgentThreadOptions, ProviderId } from '../../shared/agents'
import type { GitPullResult, GitStackedAction } from '../../shared/gitActions'
import type { GitRefsPage, GitRefsRequest } from '../../shared/gitRefs'
import type { GitChangedFiles, GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import type { GitPullRequestAction, GitPullRequestLink, GitPullRequestRead, GitPullRequestMergeMethod, GitPullRequestRequest } from '../../shared/gitPullRequests'
import type { ThreadEvent } from '../../shared/threadEvents'

/**
 * A staged image as an adapter receives it (ADR-0031): its handle, and its bytes read from this host's attachment
 * store when the adapter builds the provider's own form of it. Nothing before the adapter holds the bytes.
 */
export interface PromptImage extends AgentAttachmentHandle { read(): Promise<Uint8Array> }

/** Internal capability supplied by main's durable identity, never part of a command or runtime mode. */
export interface CommandCenterLaunchProfile {
  readonly kind: 'command-center'
  readonly server: Readonly<Omit<ThreadMcpServer, 'headers'>> & { readonly headers: readonly Readonly<{ name: string; value: string }>[] }
  readonly toolNames: readonly string[]
  /** Revokes this session's server admission; recovery requires a fresh admission. */
  revoke(reason: string): void
}
export interface ThreadLaunchProfiles {
  profileFor(threadId: string): Promise<CommandCenterLaunchProfile | undefined>
}
/** Ticket 3 supplies the server; ticket 2 consumes only this thread-bound capability. */
export interface CommandCenterProfileTools extends ScopedThreadTools { revoke(threadId: string): void }

export type AgentHostCommand =
  | { readonly type: 'create-project'; readonly provider?: ProviderId; readonly commandId: string; readonly projectId: string; readonly title: string; readonly path: string }
  | ({ readonly type: 'create-thread'; readonly commandId: string; readonly threadId: string; readonly projectId: string; readonly title: string; readonly modelId: string; readonly titleSource?: 'user' | 'default'; readonly project?: AgentProject; readonly workingCopy?: 'independent' | 'shared'; readonly baseBranch?: string; readonly startFromOrigin?: boolean; readonly existingWorktreePath?: string; readonly workingDirectory?: string } & AgentThreadOptions)
  | ({ readonly type: 'configure-thread'; readonly commandId: string; readonly threadId: string
    /** The caller keeps history from the host's events, so the result's snapshot may leave every thread's messages out (`ThreadReadPurpose`, #368). */
    readonly historyFromEvents?: boolean } & AgentThreadOptions)
  | { readonly type: 'send'; readonly commandId: string; readonly threadId: string; readonly messageId: string; readonly text: string; readonly attachments?: readonly PromptImage[]; readonly skills?: AgentSkillReference[]; readonly files?: AgentFileReference[]; readonly expectedLastUserMessageId?: string | null
    /** A wake-up babysitting sends (ADR-0061 decision 8): the workspace records the message as Sotto's before the provider hears it. */
    readonly wakeUp?: true }
  | { readonly type: 'steer'; readonly commandId: string; readonly threadId: string; readonly messageId: string; readonly text: string; readonly attachments?: readonly PromptImage[]; readonly skills?: AgentSkillReference[]; readonly files?: AgentFileReference[]; readonly expectedLastUserMessageId?: string | null }
  | { readonly type: 'answer'; readonly commandId: string; readonly threadId: string; readonly requestId: string; readonly answer: string; readonly approved?: boolean; readonly questionAnswers?: AgentQuestionAnswers; readonly permissionChoice?: string }
  | { readonly type: 'interrupt'; readonly commandId: string; readonly threadId: string }
  | { readonly type: 'compact-thread'; readonly commandId: string; readonly threadId: string }
export interface AgentHostResult {
  readonly accepted: boolean
  readonly uncertain?: boolean
  /** Local answer delivery after its deadline; observes the original write and never sends another. */
  readonly answerCompletion?: Promise<boolean>
  /**
   * For `configure-thread`: the snapshot the adapter emitted once the provider confirmed the change, carrying
   * the thread's effective settings. The coordinator accepts it in place of reading the thread again, and
   * reads only when it is absent. Never set on an uncertain result, which is reconciled from the outbox. It
   * carries no messages, and may share frozen activity trees, when the command asked `historyFromEvents` of a
   * host that publishes events.
   */
  readonly snapshot?: AgentHostSnapshot
  /**
   * For an uncertain result: what the adapter knows was lost on the way, in words the user reads, such as
   * background work that ended when an unconfirmed change stopped the provider's process. The coordinator shows
   * it in place of its own "did not confirm" error, and keeps the outbox entry all the same.
   */
  readonly error?: string
}
/**
 * A settings change's result as a host layer passes it up: the result without its snapshot, and the snapshot only
 * when the provider confirmed the change. One on any other result is dropped rather than trusted.
 */
export function confirmedSettingsSnapshot(result: AgentHostResult): [Omit<AgentHostResult, 'snapshot'>, AgentHostSnapshot | undefined] {
  const { snapshot, ...rest } = result
  return [rest, rest.accepted && !rest.uncertain ? snapshot : undefined]
}
/**
 * What a thread read is for, and what its reader keeps for itself. `beforeSend` is the read immediately before a
 * send: an adapter brings the thread up to date from what is new (Codex's newest-turn check, ADR-0005), and reads
 * it whole whenever it cannot show nothing changed. A host above it writes and publishes nothing when the read
 * changed nothing (#765). Every other read omits it.
 */
export interface ThreadReadPurpose {
  readonly beforeSend?: boolean
  /**
   * The message ID of the send a read before a send is for. That read stands for the adapter's own read at the start
   * of that send and no other, which the adapter then skips while the thread has not moved (`readsBeforeSend.ts`,
   * #765). A read before a send without it stands for none.
   */
  readonly sendMessageId?: string
  /**
   * The read after a host accepted a send, made only to find the provider's echo of the sent message. A host that
   * already holds the thread newer than it has published (the workspace, between publishes) answers from what it
   * holds without asking the provider; the caller reads again, whole, when the echo is not there (#765).
   */
  readonly afterSend?: boolean
  /** An explicit Check may reopen a native re-offer for a fresh user choice. */
  readonly retryUncertainAnswers?: boolean
  /** Restricts an explicit answer Check to the exact request the user selected. */
  readonly retryUncertainAnswerId?: string
  /**
   * The reader keeps each thread's history from the host's `subscribeEvents` and reads none from what the read
   * hands back, as an activity subscriber that asks for it does. A host that publishes events then hands back
   * every thread with its summary and no messages (ADR-0016, #368). What the read does is the same either way.
   */
  readonly historyFromEvents?: boolean
}
/**
 * What Sotto asks a thread's own client to write on the side: a title, a branch name, a commit message or
 * pull request text (ADR-0026). The instruction and the material stay apart so a client that takes a
 * system prompt keeps them apart too, and the material is always something to describe, never to obey.
 */
/** Where a rename came from: by hand, written by the thread's own provider, or a first-message title. */
export type ThreadRenameSource = 'user' | 'generated' | 'first-message'
export interface ShortTextPrompt { readonly instruction: string; readonly material: string }
export interface AgentSkillScope { readonly providerId: ProviderId; readonly workingDirectory: string }
/** One thread's messages as the workspace still holds them, handed back before a connection reads history. */
export interface RestoredThreadHistory {
  readonly threadId: string
  readonly messages: readonly AgentMessage[]
  readonly activities?: readonly AgentActivity[]
  readonly historyEpoch?: string
}
/** One change to what a thread said, addressed by Sotto thread ID (ADR-0016). */
export interface ThreadHostEvent { readonly threadId: string; readonly event: ThreadEvent }
/** One message the event store already holds, as an adapter needs to recognise it: its ID and its role. */
export interface StoredMessageIdentity { readonly id: string; readonly role: 'user' | 'assistant' }
/**
 * What the host's event store already holds for a thread, asked for one thread at a time. An adapter
 * re-reading a provider's own history uses it to append the unseen tail instead of adding the history
 * again. Nothing is read until an adapter asks, so a thread nobody opened costs nothing.
 */
export interface ThreadHistorySource {
  /** Every message the store holds for a thread, by ID and role, oldest first. */
  messageIdentities(threadId: string): readonly StoredMessageIdentity[]
  /** One indexed message, for checking a native identity repair against the saved words. */
  message?(threadId: string, messageId: string): AgentMessage | undefined
  /** Bounded activity evidence for this history epoch; undefined means it must be read afresh. */
  activities?(threadId: string, historyEpoch?: string): readonly AgentActivity[] | undefined
  /** Indexed text-free classification for a native task older than the activity window. */
  activity?(threadId: string, activityId: string, historyEpoch?: string): AgentActivity | undefined
}
/**
 * What a thread whose native session has not started will be created with on its first send, for an early start of
 * the client that send would use (#769). The working directory is the folder the thread already has. A draft whose
 * worktree the first send makes has none, and an adapter whose client runs in the thread's folder starts nothing for it.
 */
export interface ThreadSessionDraft {
  readonly modelId: string
  readonly workingDirectory?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly runtimeMode?: AgentRuntimeMode | undefined
}
/** What an activity subscriber asks of the host it subscribes to. */
export interface ActivitySubscriptionOptions {
  /**
   * The subscriber keeps each thread's history from the host's `subscribeEvents` and reads none from the
   * snapshots, so a host that publishes events leaves every thread's messages out and carries its summary
   * instead (ADR-0016, #322). A subscriber that reads messages from the snapshots leaves this unset.
   */
  historyFromEvents?: boolean
}
/**
 * Sotto thread interface: create = execute create-thread; resume = observeThreads then snapshot;
 * prompt = execute send; cancel = execute interrupt; status = snapshot; events = subscribe.
 */
export interface AgentHost {
  /** Main-only launch capabilities. Wrappers translate identity before handing them to an adapter. */
  useLaunchProfiles?(profiles: ThreadLaunchProfiles): void
  useCommandCenterTools?(tools: CommandCenterProfileTools): void
  /** Capture the owned runtime before main checks identity. A refusal cannot close its replacement. */
  profileRefusalHandler?(threadId: string): ((reason: string) => void | Promise<void>) | undefined
  /** Inject shared browser tools before connecting the native providers. */
  useBrowserTools?(tools: BrowserAgentTools): void
  /**
   * Inject Sotto's scoped tool servers before connecting: the host setup tools, which only a host setup thread is
   * given (ADR-0035), and the visual tool (ADR-0056). Each launch offers every one that answers for its thread.
   */
  useThreadTools?(tools: readonly ScopedThreadTools[]): void
  rollbackCapability?(threadId: string): { supported: boolean; reason?: string }
  /** Explicit checkpoint rewind; compare exact authored history before any native mutation.
   * Throws only for definitive rejection; possible unconfirmed native writes return uncertain. */
  rollbackThread?(threadId: string, removedUserMessages: number, expectedUserMessageIds: readonly string[]): Promise<AgentHostResult>
  /** Scope is constructed only by WorkspaceHost for an unstarted local thread. */
  listThreadSkills?(threadId: string, forceReload?: boolean, scope?: AgentSkillScope): Promise<AgentSkillCatalog>
  readonly concurrentProviders?: boolean
  initialize?(): Promise<void>
  /**
   * Hand a connection the messages the workspace still holds for its threads, before it connects.
   * An adapter that reads a provider's own transcript may then continue from where it stopped instead
   * of reading the whole history again. Messages the caller does not hand back are read afresh.
   */
  restoreThreadHistory?(threads: readonly RestoredThreadHistory[]): Promise<void>
  /** Local organization/history; available without a provider connection. */
  workspaceSnapshot?(): AgentHostSnapshot
  setWorkspaceSettled?(kind: 'project' | 'thread', id: string, settled: boolean): Promise<AgentHostSnapshot>
  /** Rename a thread in Sotto's own workspace and record where the name came from; a hand rename is
   * `user` and outranks everything later. The provider is not told. */
  renameThread?(threadId: string, title: string, source?: ThreadRenameSource): Promise<AgentHostSnapshot>
  /**
   * One thread's whole history from Sotto's own store, for the few things that need more than the window
   * a pane holds — naming a thread from its first exchange. Absent on hosts that keep no history.
   */
  threadMessages?(threadId: string): readonly AgentMessage[]
  /**
   * One side call to the thread's own client, account and model, in the thread's working folder: the
   * instruction and material go in and the written text comes back (ADR-0026). It never resumes or writes
   * to the thread's session, transcript, history or activity, and nothing about it reaches the Threads
   * page. Resolves null where this thread's provider writes nothing: Devin, a disconnected client, a thread
   * it does not own. Throws when the client was asked and failed; the error names no prompt text. An aborted
   * `signal` stops the client the call started, which is how a host shutdown leaves no child behind.
   */
  writeShortText?(threadId: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null>
  /**
   * Record that a request was answered and which client answered it. Absent on hosts that keep no
   * history. The event carries no answer text; attribution is evidence, never authority (ADR-0004).
   */
  recordAnswer?(threadId: string, event: AnswerGivenEvent): void
  /** Widen one thread's loaded message window by another twenty turns and publish (issue #119). */
  loadEarlierMessages?(threadId: string): Promise<AgentHostSnapshot>
  /**
   * The records of `activities` a pane is given beside the thread's loaded history window: the work of a
   * turn above the window waits there with its messages. A view for the thread detail alone; the records
   * themselves stay whole everywhere else. Absent on hosts that keep no window, which give every record.
   */
  paneActivities?(threadId: string, activities: readonly AgentActivity[]): readonly AgentActivity[]
  workingCopyOptions?(projectId: string): Promise<AgentWorkingCopyOptions>
  configureThreadWorkingCopy?(threadId: string, selection: AgentWorkingCopySelection): Promise<AgentHostSnapshot>
  /** `background` is a read the window made on its own, which asks GitHub only as the timer would (#820). */
  updateThreadWorktree?(threadId: string, retry: boolean, options?: { readonly background?: boolean }): Promise<AgentHostSnapshot>
  restoreThreadBranch?(threadId: string, withUncommittedChanges: boolean): Promise<AgentHostSnapshot>
  /** Remove the thread's own worktree folder and keep its branch (ADR-0041). */
  previewThreadWorktreeReclaim?(threadId: string): Promise<WorktreeReclaimPreview>
  reclaimThreadWorktree?(threadId: string, options?: { withUncommittedChanges?: boolean; automatic?: boolean; confirmedIgnored?: readonly string[]; confirmedItems?: readonly { path: string; fileCount: number }[]; confirmedRepositories?: WorktreeReclaimPreview['repositories'] }): Promise<AgentHostSnapshot>
  threadWorkingDirectory?(threadId: string): Promise<string>
  /** T3's stacked Git action on the thread's folder, reported on the thread record as it runs (ADR-0027). */
  runGitAction?(command: { threadId: string; actionId: string; action: GitStackedAction; commitMessage?: string | undefined; featureBranch?: boolean | undefined; filePaths?: readonly string[] | undefined; allowDefaultBranch?: boolean | undefined }): Promise<AgentHostSnapshot>
  pullThreadBranch?(threadId: string): Promise<{ snapshot: AgentHostSnapshot; result: GitPullResult }>
  /** The branches the thread's folder offers, for the picker (ADR-0027). */
  listThreadRefs?(request: GitRefsRequest): Promise<GitRefsPage>
  /** The changed files of the thread's folder with their line counts, for the commit dialog (ADR-0027). */
  listThreadChangedFiles?(request: GitChangedFilesRequest): Promise<GitChangedFiles>
  switchThreadBranch?(threadId: string, ref: string, create: boolean): Promise<AgentHostSnapshot>
  initThreadRepository?(threadId: string): Promise<AgentHostSnapshot>
  publishThreadRepository?(threadId: string, options: { repository: string; visibility: 'private' | 'public' }): Promise<{ snapshot: AgentHostSnapshot; url: string }>
  /** One pull request of the thread's through `gh`: by reference, else its branch's own or the one last linked (ADR-0027). */
  readThreadPullRequest?(request: GitPullRequestRequest): Promise<GitPullRequestRead>
  /** A press on the Pull request surface; answers with what happened, in T3's words. */
  runPullRequestAction?(command: { threadId: string; url: string; action: GitPullRequestAction; method?: GitPullRequestMergeMethod | undefined }): Promise<{ snapshot: AgentHostSnapshot; notice: string }>
  linkThreadPullRequest?(threadId: string, reference: string): Promise<{ snapshot: AgentHostSnapshot; link: GitPullRequestLink }>
  unlinkThreadPullRequest?(threadId: string, url: string): Promise<AgentHostSnapshot>
  /** T3's Checkout pull request, Local or Worktree. */
  checkoutThreadPullRequest?(threadId: string, reference: string, mode: 'local' | 'worktree'): Promise<{ snapshot: AgentHostSnapshot; notice: string }>
  privacyChanged?(): Promise<void>
  createProjectId?(provider: ProviderId): string
  connect(provider?: ProviderId): Promise<AgentHostSnapshot>
  snapshot(provider?: ProviderId): Promise<AgentHostSnapshot>
  /** Refresh only this thread's authoritative history/status, returning the full cached snapshot, with every
   * thread's messages unless `purpose.historyFromEvents` says the caller reads none from it. A read with
   * `purpose.afterSend` may be answered from what a host above the adapter already holds, without asking the
   * provider (#765). A result without
   * messages may share frozen activity trees, as an activity snapshot does; the provider switch copies it.
   * Native adapters must not join a refresh blocked on another thread or model discovery. */
  refreshThread?(threadId: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot>
  /** Throws only for a definitive rejection before commitment; unknown delivery returns uncertain. */
  execute(command: AgentHostCommand): Promise<AgentHostResult>
  /** Resolve saved pre-composite IDs without changing provider session identity. */
  providerForThread?(threadId: string): ProviderId | undefined
  resolveProjectId?(id: string): string
  resolveModelId?(id: string): string
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void
  /** Internal readers may share deeply immutable activity trees. All other containers remain
   * isolated for the consumer. Callers needing writable activities use subscribe/snapshot instead.
   * Absence means mutable legacy data: never infer unchanged activity from array identity alone.
   * A subscriber that keeps history from `subscribeEvents` says so in `options`, and then a host that
   * publishes events carries every thread with its summary and no messages, held or not (ADR-0016, #322). */
  subscribeActivitySnapshots?(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void
  /**
   * Every change to what a thread said, as it happens. An adapter that implements this publishes each
   * change once through its own append path, and its snapshots then carry the messages only for the
   * threads in the watched set; everything else carries its summary (ADR-0016, issue #120). A host
   * without it is read the old way: the whole `messages` array is compared against what is held.
   */
  subscribeEvents?(listener: (event: ThreadHostEvent) => void): () => void
  /** Hand the adapter a way to ask what the event store already holds, before it reads a provider. */
  useThreadHistory?(source: ThreadHistorySource): void
  observeThreads?(threadIds: readonly string[]): void
  /**
   * Early start (#769): start this thread's provider session now, the way its next action would, because the user began
   * typing in its composer. A thread whose native session has not started yet has none to start; with `draft` the
   * adapter may instead start the client that thread's first send would use, but it never creates a provider session,
   * a worktree or a branch, and sends nothing to a model. Counts as activity for the session reaper. Resolves once the
   * start has settled either way; callers ignore a rejection, since the send reports its own.
   */
  startThreadSession?(threadId: string, draft?: ThreadSessionDraft): Promise<void>
  disconnect(provider?: ProviderId): void
  /**
   * A new client for `provider` is on disk (ADR-0042). The adapter finds it again, reads its version, stops each
   * idle process now the way the reaper does, and each working one once it goes idle, so the next process a thread
   * starts runs the new client. It never disconnects, cancels a turn or answers a request, and does nothing for a
   * provider that is not connected. Absent on a host with no local client.
   */
  clientUpdated?(provider: ProviderId): Promise<void>
}
