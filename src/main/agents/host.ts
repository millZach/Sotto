import type { AgentActivity } from '../../shared/agentActivity'
import type { AgentSkillCatalog, AgentSkillReference } from '../../shared/agentSkills'
import type { AgentFileReference } from '../../shared/agentFiles'
import type { AnswerGivenEvent } from '../../shared/threadEvents'
import type { AgentWorkingCopyOptions, AgentWorkingCopySelection, AgentAttachment, AgentHostSnapshot, AgentMessage, AgentProject, AgentQuestionAnswers, AgentThreadOptions, ProviderId } from '../../shared/agents'
import type { ThreadEvent } from '../../shared/threadEvents'

export type AgentHostCommand =
  | { readonly type: 'create-project'; readonly provider?: ProviderId; readonly commandId: string; readonly projectId: string; readonly title: string; readonly path: string }
  | ({ readonly type: 'create-thread'; readonly commandId: string; readonly threadId: string; readonly projectId: string; readonly title: string; readonly modelId: string; readonly titleSource?: 'user' | 'default'; readonly project?: AgentProject; readonly workingCopy?: 'independent' | 'shared'; readonly baseBranch?: string; readonly startFromOrigin?: boolean; readonly existingWorktreePath?: string; readonly workingDirectory?: string } & AgentThreadOptions)
  | ({ readonly type: 'configure-thread'; readonly commandId: string; readonly threadId: string } & AgentThreadOptions)
  | { readonly type: 'send'; readonly commandId: string; readonly threadId: string; readonly messageId: string; readonly text: string; readonly attachments?: AgentAttachment[]; readonly skills?: AgentSkillReference[]; readonly files?: AgentFileReference[]; readonly expectedLastUserMessageId?: string | null }
  | { readonly type: 'steer'; readonly commandId: string; readonly threadId: string; readonly messageId: string; readonly text: string; readonly attachments?: AgentAttachment[]; readonly skills?: AgentSkillReference[]; readonly files?: AgentFileReference[]; readonly expectedLastUserMessageId?: string | null }
  | { readonly type: 'answer'; readonly commandId: string; readonly threadId: string; readonly requestId: string; readonly answer: string; readonly approved?: boolean; readonly questionAnswers?: AgentQuestionAnswers; readonly permissionChoice?: string }
  | { readonly type: 'interrupt'; readonly commandId: string; readonly threadId: string }
  | { readonly type: 'compact-thread'; readonly commandId: string; readonly threadId: string }
export interface AgentHostResult { readonly accepted: boolean; readonly uncertain?: boolean }
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
  /** Bounded activity evidence for this history epoch; undefined means it must be read afresh. */
  activities?(threadId: string, historyEpoch?: string): readonly AgentActivity[] | undefined
}
/**
 * Sotto thread interface: create = execute create-thread; resume = observeThreads then snapshot;
 * prompt = execute send; cancel = execute interrupt; status = snapshot; events = subscribe.
 */
export interface AgentHost {
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
  renameThread?(threadId: string, title: string, source?: 'user' | 'generated'): Promise<AgentHostSnapshot>
  /**
   * One thread's whole history from Sotto's own store, for the few things that need more than the window
   * a pane holds — naming a thread from its first exchange. Absent on hosts that keep no history.
   */
  threadMessages?(threadId: string): readonly AgentMessage[]
  /**
   * Record that a request was answered and which client answered it. Absent on hosts that keep no
   * history. The event carries no answer text; attribution is evidence, never authority (ADR-0004).
   */
  recordAnswer?(threadId: string, event: AnswerGivenEvent): void
  /** Widen one thread's loaded message window by another twenty turns and publish (issue #119). */
  loadEarlierMessages?(threadId: string): Promise<AgentHostSnapshot>
  workingCopyOptions?(projectId: string): Promise<AgentWorkingCopyOptions>
  configureThreadWorkingCopy?(threadId: string, selection: AgentWorkingCopySelection): Promise<AgentHostSnapshot>
  updateThreadWorktree?(threadId: string, retry: boolean): Promise<AgentHostSnapshot>
  restoreThreadBranch?(threadId: string, withUncommittedChanges: boolean): Promise<AgentHostSnapshot>
  threadWorkingDirectory?(threadId: string): Promise<string>
  privacyChanged?(): Promise<void>
  createProjectId?(provider: ProviderId): string
  connect(provider?: ProviderId): Promise<AgentHostSnapshot>
  snapshot(provider?: ProviderId): Promise<AgentHostSnapshot>
  /** Refresh only this thread's authoritative history/status, returning the full cached snapshot.
   * Native adapters must not join a refresh blocked on another thread or model discovery. */
  refreshThread?(threadId: string): Promise<AgentHostSnapshot>
  /** Throws only for a definitive rejection before commitment; unknown delivery returns uncertain. */
  execute(command: AgentHostCommand): Promise<AgentHostResult>
  /** Resolve saved pre-composite IDs without changing provider session identity. */
  providerForThread?(threadId: string): ProviderId | undefined
  resolveProjectId?(id: string): string
  resolveModelId?(id: string): string
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void
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
  disconnect(provider?: ProviderId): void
}
