import { annotateWatcherOwnChanges } from './watcherOwnChanges'
import { withKeptMessageMetadata } from '../../shared/agents'
import type { AgentThreadPrompts } from '../../shared/threadPrompts'
import { watcherAsksSchema, type WatcherAsk } from '../../shared/watcherAsks'
import { catalogWithoutHeld, heldProviderOfThreadRecord } from './heldProviderGate'
import { heldProviderRefusal, heldProvidersOf, type HeldProviders } from '../../shared/heldProviders'
import { summarizePullRequestChecks } from './pullRequestCheckState'
import type { PullRequestObservation } from './watcherEvidence'
import { threadsInCheckout } from './checkoutCandidates'
import { CheckoutMutations, checkoutMutationRefusal, type CheckoutHolder, type CheckoutPendingWork } from './checkoutMutations'
import { loadHostIdentity, migrateWorkspaceHost, stampHostSnapshot, stampHostThread } from './hostIdentity'
import { ThreadChangesPublisher, ThreadMap, inPlacingOrder, orderBetween, threadChangesBetween, verifyingThreadChanges, type ActivityChangesListener, type ActivityChangesSubscription, type AgentHostChanges, type ThreadChangeSet, type ThreadPlacement } from './threadChanges'
import type { BrowserAgentTools } from './browserAgentServer'
import type { ScopedThreadTools } from './threadToolServer'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { sameSnapshot } from './sameSnapshot'
import { immutableActivities, immutableModels, immutableUpdates, isImmutableActivities, isImmutableModels, subscribeActivitySnapshots } from './activitySnapshots'
import { readdir, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { agentHostSnapshotSchema, dropLiveThreadState, EMPTY_AGENT_HOST, NO_LIVE_THREAD_STATE, isThreadProviderConnected, threadTakesSottoTools, PROVIDER_LABELS, isVisualMessage, RESTORE_BRANCH_NEEDS_CONFIRMATION, summarizeThread, THREAD_CONTINUED_IN_MAX, WAKE_UP_MESSAGE_IDS_MAX, type ThreadContinuedFrom, type ThreadContinuedIn, type WorktreeReclaimPreview, type AgentWorkingCopyOptions, type AgentWorkingCopySelection, type AgentHostSnapshot, type AgentModel, type AgentProject, type AgentMessage, type AgentThread, type AgentThreadStart, type AgentThreadSummary, type AgentWorktree, type ProviderId } from '../../shared/agents'
import type { AgentSkillReference } from '../../shared/agentSkills'
import { isUsageProviderId, type UsageQuotaRead, type UsageTokenObservation } from '../../shared/usageDashboard'
import { isUsageHistoryThreadId, mappedSink, type UsageHistorySink, type UsageRecordedUserMessage } from './usageHistory/sink'
import type { UserMessageInstantSource } from './usageHistory/sottoPrompts'
import { threadEventSchema, type AnswerGivenEvent, type StoredThreadEvent, type ThreadEvent } from '../../shared/threadEvents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { confirmedSettingsSnapshot, type ActivitySubscriptionOptions, type AgentContinuation, type AgentHost, type ReplyFork, type AgentHostCommand, type AgentHostResult, type ShortTextPrompt, type StartHandoverSent, type StoredMessageIdentity, type ThreadReadPurpose, type ThreadRenameSource } from './host'
import { agentHandover, type AgentHandover } from './agentHandover'
import { AGENT_HANDOVER_UNAVAILABLE, AGENT_NOT_SEEN_FINISHING, AGENT_STILL_WORKING, FORK_REPLY_GONE, FORK_TURN_RUNNING, NATIVE_FORKS } from '../../shared/threadStarts'
import { EMPTY_WINDOW, FIRST_WINDOW_TURNS, LATER_WINDOW_TURNS, RECORDED_USER_MESSAGES_MAX, replacementEvents, summaryOf, ThreadStore, type RecordedUserMessageIdentity, type StoredVisual, type ThreadMessageWindow } from './threadStore'
import { BUILT_STORE_WORKER, CLOSE_LIMIT_MS, type StoreWorkerOptions } from './storeWorker'
import { NO_EVENTS, throwIfFailed, writeFailed, ThreadStoreWriterOnWorker, type ActivityReadBack, type ThreadStoreWrite, type ThreadStoreWriteOutcome, type ThreadStoreWriter } from './threadStoreWriter'
import { applyEventsToIdentities, applyEventsToMessage, applyEventsToSummary, applyEventsToWindow, keepsPositions, pageWithEvents } from './storeOverlay'
import { readHandover, type Handover, type HandoverStore } from './handover'
import { continuedPromptWords, continuedWordsOnly } from './continueThread'
import { handoverCounts } from './watcherHandover'
import { placeVisuals } from './visualPlacement'
import { visualFromInput, VISUALS_PER_THREAD_MAX, VISUALS_PER_TURN_MAX, type AgentVisual, type VisualInput } from '../../shared/visuals'
import { SubagentStore, subagentActivityClassification } from './subagentStore'
import { observedSubagentStatus, EMPTY_SUBAGENT_SUMMARY, type SubagentChange, type SubagentRow, type SubagentSummary, type SubagentPageRequest, type SubagentAssignmentsRequest } from '../../shared/subagents'
import { validateThreadOptions } from './threadOptions'
import { resolveModel } from '../../shared/modelCatalog'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import { isThreadArchived, isThreadSettled, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { delegatedThreadsBelow } from '../../shared/delegation'
import { npmCi, preparePackages, type PackageInstaller } from './checkWorktree'
import { checkoutIdentity, existingWorkingDirectory, movedBranchRef, runWorktreeGit, ThreadWorktrees } from './threadWorktrees'
import { claudeSkillFolder, claudeSkillPath } from './claudeSkills'
import { providerTakesNoSkills } from './providerSwitch'
import { gitStatusFingerprint, type GitStatus } from '../../shared/gitStatus'
import type { GitStatusSource } from './gitStatus'
import { BringBackRefusal, GitActionRefusal, type BringBackOutcome, type GitActionEvent, type GitActions } from './gitActions'
import { BRING_BACK_FROM_DESKTOP, BRING_BACK_NO_TARGET, BRING_BACK_OFF, BRING_BACK_QUESTION_GONE, bringBackTarget, incomingRefBranch, type BringBack, type BringBackAway, type WorktreeMadeFrom } from '../../shared/bringChangesBack'
import type { GitActionProgress, GitPullResult, GitStackedAction } from '../../shared/gitActions'
import type { GitRefsPage, GitRefsRequest } from '../../shared/gitRefs'
import type { GitChangedFiles, GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import { branchPullRequestUrl, GIT_PULL_REQUEST_LINKS_MAX, parsePullRequestReference, pullRequestAddress, pullRequestKey, type GitPullRequestAction, type GitPullRequestDetail, type GitPullRequestLink, type GitPullRequestLinkSource, type GitPullRequestMergeMethod, type GitPullRequestRead, type GitPullRequestRequest } from '../../shared/gitPullRequests'
import { GitPullRequestLimited, GitPullRequestRefusal, PULL_REQUEST_ACTION_DONE, type GitPullRequests, type GitPullRequestView } from './gitPullRequests'
import { MAX_AGENT_ACTIVITIES, isTerminalActivity, mergeAgentActivities, wordlessReasoningSummary, type AgentActivity } from '../../shared/agentActivity'
import { markSendStage } from './sendStages'
import { babysitRecordSchema, publishedBabysitting, type BabysitRecord } from './babysitNews'
import type { BabysitStore, BabysitThread } from './babysitting'
import { BABYSITTING_PER_THREAD_MAX, type BabysitEndedReason } from '../../shared/babysitting'
import { migrateWorkspaceThreadKinds } from './watcherRecords'
import { WatcherLaunchProfiles, WATCHER_DISABLED } from './watcherLaunchProfiles'
import { WatcherProfileRefusal } from './watcherProfile'
import { assertWatcherPermission } from './watcherProviderTools'
import type { WatcherProfileTools, WorkerRoleSource } from './host'
import type { ThreadClearKeptReason } from '../../shared/threadClear'

/**
 * Fold a run of appends to one message into the first of them, so a reply streamed over one write
 * window is one event rather than one per chunk (#991). An event that is not an append, an append to
 * another message, a change in redaction, or the stored events' own text limit ends the run.
 */
function foldAppends(events: readonly ThreadEvent[]): ThreadEvent[] {
  const folded: ThreadEvent[] = []
  for (const event of events) {
    const last = folded.at(-1)
    if (event.kind === 'message-text-appended' && last?.kind === 'message-text-appended'
      && last.messageId === event.messageId && last.redacted === event.redacted
      && last.appendText.length + event.appendText.length <= 100_000) {
      folded[folded.length - 1] = { ...last, appendText: last.appendText + event.appendText }
    } else folded.push(event)
  }
  return folded
}

/** Keep a Unicode character whole at an event boundary so SQLite preserves its text. */
function historyTextChunks(text: string): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 100_000, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--
    chunks.push(text.slice(offset, end))
    offset = end
  }
  return chunks
}

/** Milliseconds a burst of tool activity is left to settle before the worktree is read again. */
const WORKTREE_REFRESH_DELAY_MS = 1_500
/** One spelling of a folder for the re-read rounds: resolved, and without case on Windows. */
function folderKey(folder: string): string {
  const path = resolve(folder)
  return process.platform === 'win32' ? path.toLowerCase() : path
}
/**
 * One round of trailing re-reads (`scheduleWorktreeRefresh`): when its timer fired, and the inspection of each shared
 * folder in it, by folder, with the count of Git actions when it began.
 */
interface RefreshRound {
  readonly firedAt: number
  readonly inspections: Map<string, { readonly changes: number; readonly reads: Promise<(metadata: AgentWorktree) => AgentWorktree> }>
}
/** How often the Git status timer looks at whether a remote read is due. */
/** Two spellings of one folder: trailing separators, slashes and case are not a difference on the platforms Sotto ships on. */
const sameFolder = (left: string, right: string): boolean => left.replace(/[\\/]+$/u, '').replace(/\\/gu, '/').toLowerCase() === right.replace(/[\\/]+$/u, '').replace(/\\/gu, '/').toLowerCase()
const GIT_STATUS_TICK_MS = 5_000
const GIT_ACTION_SAVE_ERROR = 'The Git action finished, but its record could not be saved. Check the folder; the notice may not show it.'
/** Work that can leave the worktree on another branch: a finished turn, a shell command it ran, or files it changed. */
const HEAD_MOVING_KINDS: ReadonlySet<AgentActivity['kind']> = new Set(['turn', 'command', 'file-change', 'tool'])
/** The finished records that could have moved HEAD, by ID, so only new ones ask for a re-read. */
/**
 * A skill picked from the project folder's catalog, named as the same skill in the thread's own working copy. A skill
 * file inside the project moves with it; a Claude skill is named by the folder it was listed in, so it takes the new one.
 */
async function skillInWorkingCopy(selected: AgentSkillReference, projectPath: string, workingDirectory: string): Promise<AgentSkillReference> {
  const listedIn = claudeSkillFolder(selected.path)
  if (listedIn !== undefined) return sameFolder(listedIn, projectPath) ? { ...selected, path: claudeSkillPath(await existingWorkingDirectory(workingDirectory), selected.name) } : selected
  const local = relative(projectPath, selected.path)
  return { ...selected, path: !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) ? join(workingDirectory, local) : selected.path }
}
function settledHeadMovers(activities: readonly AgentActivity[] | undefined): Set<string> {
  return new Set((activities ?? []).filter(activity => HEAD_MOVING_KINDS.has(activity.kind) && isTerminalActivity(activity.status)).map(activity => activity.id))
}
/** Whether `after` settled a record that may move a branch which `before` had not, so the worktree is read again. */
function settledHeadMoved(before: readonly AgentActivity[] | undefined, after: readonly AgentActivity[] | undefined): boolean {
  if (before === after) return false
  const settled = settledHeadMovers(before)
  return [...settledHeadMovers(after)].some(id => !settled.has(id))
}

/** A stored thread's records on their way back from the store worker for a window (`readBack`). */
interface ActivityRead {
  /** Each record the thread's provider published meanwhile, merged onto the list in the order it came once it is here. */
  readonly held: AgentThread[]
  /** Settles once the read has been dealt with: arrived, let go, or waited out behind a clear. */
  readonly done: Promise<void>
}

/**
 * The turn still being worked: the latest running turn record's, or, with none and the thread running, the
 * turn of its newest record. A running record alone is not enough: a re-read tool call with no result is one.
 */
function liveTurn(activities: readonly AgentActivity[], status: AgentThread['status']): string | undefined {
  let latest: AgentActivity | undefined
  let newest: AgentActivity | undefined
  for (const record of activities) {
    if (record.kind === 'turn' && record.status === 'running' && (!latest || record.sequence > latest.sequence)) latest = record
    if (!newest || record.sequence > newest.sequence) newest = record
  }
  return latest?.turnId ?? (status === 'running' ? newest?.turnId : undefined)
}

/** Said when the branch on a working-copy record could not be written; the folder itself was verified. */
const BRANCH_SAVE_ERROR = 'The branch name could not be saved. Restore local storage and refresh.'
/** What a deletion that failed after its folders went says of them (ADR-0140 decision 5). */
const DELETION_FOLDERS_WORDS = 'Worktree folders it already removed stay removed; their branches and commits stay.'
/** Said when a thread's own history could not be written. The thread still works; what it said is at risk. */
const HISTORY_SAVE_ERROR = 'Thread messages could not be saved. Restore access to local storage and refresh.'
/** The thread list of the part of an activity publication that is shared from one to the next. */
const NO_THREADS: AgentThread[] = []
/** Said on a thread part of whose own history could not be written; the rest of it was kept. */
const HISTORY_SAVE_NOTICE = 'Part of this thread’s history could not be saved. Other messages were kept. Copy any missing text before closing Sotto.'
/** Said when the thread history database could not be opened at all. This run keeps its messages in memory. */
const HISTORY_OPEN_ERROR = 'Thread messages could not be opened. Restore access to local storage and restart Sotto.'
const ACTIVITY_READ_ERROR = 'Thread activity could not be read. Saved activity remains available. Restore local storage and restart Sotto.'

/**
 * What became of a visual an agent asked to draw (ADR-0056): kept and shown, with where it went, or why nothing was drawn.
 * `anchor` is who wrote the message it sits under: the agent's own words, the user's message, or nothing yet.
 */
export type VisualAddition =
  | { readonly added: true; readonly visual: AgentVisual; readonly anchor: 'assistant' | 'user' | 'none' }
  | { readonly added: false; readonly reason: 'unknown-thread' | 'history-unavailable' | 'turn-limit' | 'thread-limit' }

/** How much of a message the last publish left behind: enough to tell an append from a rewrite. */
interface MessageMark { readonly id: string; readonly length: number; readonly attachments: number; readonly tail: string; readonly watcherChanges: string; readonly turnMessageId: string | undefined }
/** The characters of a message kept for comparison; a rewrite of the same length still differs here. */
const TAIL = 24
/** A slice of a long string keeps the whole message alive. Joining the slice onto a space first leaves the mark pointing at a short string of its own (#1618). */
const ownCopy = (text: string): string => (' ' + text).slice(1)
const markOf = (message: AgentMessage): MessageMark =>
  ({ id: message.id, length: message.text.length, attachments: message.attachments?.length ?? 0, tail: ownCopy(message.text.slice(-TAIL)), watcherChanges: JSON.stringify([message.watcherOwnChange ?? null, message.watcherObservedChanges ?? null]), turnMessageId: message.turnMessageId })

/** A record read back from disk: one still running there was an unfinished observation, not a live process. */
function savedRecord(activity: AgentActivity): AgentActivity {
  return activity.status === 'running' ? { ...activity, status: 'unknown' } : activity
}

/**
 * One thread as `workspace.json` keeps it: no messages, and no summary either, because the summary
 * quotes them. Both are read back from the thread store, which is what the history switch governs. The
 * user's last message ID is the adapter's to say again once it runs; a saved one could only be stale.
 * Subagent task/result text has only one durable copy, in the roster store. The ordinary activity
 * store and JSON migration fallback retain only text-free subagent classification.
 */
const retainedActivityViews = new WeakMap<AgentActivity[], AgentActivity[]>()
function retainedActivities(activities: AgentActivity[]): AgentActivity[] {
  const immutable = isImmutableActivities(activities)
  const held = immutable ? retainedActivityViews.get(activities) : undefined
  if (held) return held
  const records = activities.map(activity => activity.kind === 'subagent' || activity.agents?.length || activity.taskUpdatesExcluded !== undefined ? subagentActivityClassification(activity) : activity)
  if (!immutable) return records
  const retained = immutableActivities(records)
  retainedActivityViews.set(activities, retained)
  return retained
}

/** Where the serialized catalog goes in a saved workspace built without it, spliced back from its cache. */
const CATALOG_PLACEHOLDER = 'sotto-catalog-placeholder-v1'
const modelProviderKey = (model: AgentModel): string => model.providerId ?? model.provider
/**
 * The catalog as `workspace.json` keeps it with cheaper publish windows on: a provider's permission
 * modes are the same list on every one of its models (Devin's, today), so they are stored once, on
 * the first model that carries them, and read back onto the rest. A model whose modes differ from
 * its provider's first keeps its own.
 */
function catalogModelsForSave(models: readonly AgentModel[]): AgentModel[] {
  const first = new Map<string, string>()
  return models.map(model => {
    if (model.providerModes === undefined) return model
    const key = modelProviderKey(model)
    const modes = JSON.stringify(model.providerModes)
    if (first.get(key) === modes) {
      const { providerModes, ...rest } = model
      void providerModes
      return rest
    }
    if (!first.has(key)) first.set(key, modes)
    return model
  })
}
/** Give every model its provider's stored modes back, sharing the one list, as the adapters publish it. */
function expandProviderModes(models: AgentModel[]): void {
  const byProvider = new Map<string, NonNullable<AgentModel['providerModes']>>()
  for (const model of models) {
    if (model.providerModes?.length && !byProvider.has(modelProviderKey(model))) byProvider.set(modelProviderKey(model), model.providerModes)
  }
  for (const model of models) {
    if (model.providerModes === undefined) {
      const modes = byProvider.get(modelProviderKey(model))
      if (modes) model.providerModes = modes
    }
  }
}

/** A migration that cannot hand a thread's task words to the roster, durably, stops before it strips them. */
const ROSTER_LACKS_WORDS_ERROR = 'Agent history could not be saved. Thread activity keeps its task words, so nothing was lost. Restore access to local storage and restart Sotto.'
class RosterLacksWords extends Error { constructor() { super('The agent roster could not keep this thread\u2019s task words.') } }

/** Whether two folders are the same checkout, by Git's own root for each; a folder Git cannot read is no match. */
const sameCheckout = async (left: string, right: string): Promise<boolean> => {
  try { return await checkoutIdentity(left) === await checkoutIdentity(right) } catch { return false }
}

/**
 * The thread as workspace.json keeps it. `keepActivities` keeps its records there, as the fallback when the store
 * cannot take them, text-free for subagents, unless `keepTaskWords`: the roster, the words' only other copy, lacks
 * them or is not on the disk, so the file keeps them as it had them.
 */
function organizationOnly(thread: AgentThread, keepActivities = false, keepTaskWords = false): AgentThread {
  // A bring-back outcome and the question it may hold are never saved (#1030): a restart forgets both.
  const { summary, earlierAvailable, monitoring, backgroundWork, subagentSummary, activities, lastUserMessageId, providerSessionOpen, sottoToolsWithheld, sottoToolsGiven, bringBack, broughtBack, ...rest } = thread
  void summary; void earlierAvailable; void monitoring; void backgroundWork; void subagentSummary; void lastUserMessageId; void providerSessionOpen; void sottoToolsWithheld; void sottoToolsGiven; void bringBack; void broughtBack
  return { ...rest, messages: [], ...(keepActivities && activities ? { activities: keepTaskWords ? activities : retainedActivities(activities) } : {}) }
}

/**
 * A thread that pointed at threads now deleted (ADR-0140 decision 5): it keeps its own history and loses only the links,
 * the thread that delegated to it, the thread it continues or that continues it, and the thread it began from. Unchanged,
 * the same record comes back.
 */
function unlinkedFrom(thread: AgentThread, gone: ReadonlySet<string>): AgentThread {
  const delegated = thread.delegatedBy !== undefined && gone.has(thread.delegatedBy)
  const from = thread.continuedFrom !== undefined && gone.has(thread.continuedFrom.threadId)
  const into = thread.continuedIn?.some(item => gone.has(item.threadId)) === true
  const started = thread.startedFrom !== undefined && gone.has(thread.startedFrom.threadId)
  if (!delegated && !from && !into && !started) return thread
  const next: AgentThread = { ...thread }
  if (delegated) delete next.delegatedBy
  if (from) delete next.continuedFrom
  if (started) delete next.startedFrom
  if (into) {
    const continuedIn = thread.continuedIn!.filter(item => !gone.has(item.threadId))
    if (continuedIn.length) next.continuedIn = continuedIn; else delete next.continuedIn
  }
  return next
}

const workspaceSchema = z.object({
  snapshot: z.preprocess(migrateWorkspaceThreadKinds, agentHostSnapshotSchema),
  projectAliases: z.array(z.object({ providerProjectId: z.string(), projectId: z.string() })).default([]),
  creations: z.array(z.object({ threadId: z.string(), projectId: z.string(), commandId: z.string(), phase: z.enum(['unstarted', 'starting', 'retryable', 'started']) })),
  /** The Sotto thread IDs of cleared threads (ADR-0140 decision 6): IDs alone, never a title or a word. */
  clearedThreadIds: z.array(z.string().min(1).max(512)).default([]),
})
type Workspace = z.infer<typeof workspaceSchema>
/**
 * What each thread babysits as `workspace.json` keeps it (ADR-0061 decision 10): on the thread's record, the published
 * fields beside what the thread was last told. Read from the file before the thread schema, which keeps only the published
 * fields; a record that does not read is dropped rather than refusing the workspace.
 */
function savedBabysitting(input: unknown): Map<string, BabysitRecord[]> {
  const records = new Map<string, BabysitRecord[]>()
  const threads = (input as { snapshot?: { threads?: unknown } } | null)?.snapshot?.threads
  if (!Array.isArray(threads)) return records
  for (const thread of threads as unknown[]) {
    const { id, babysitting } = (thread ?? {}) as { id?: unknown; babysitting?: unknown }
    if (typeof id !== 'string' || !Array.isArray(babysitting)) continue
    const kept = babysitting.flatMap(item => { const parsed = babysitRecordSchema.safeParse(item); return parsed.success ? [parsed.data] : [] }).slice(0, BABYSITTING_PER_THREAD_MAX)
    if (kept.length) records.set(id, kept)
  }
  return records
}
const babysittingSummary = (records: readonly BabysitRecord[]): AgentThread['babysitting'] => records.map(publishedBabysitting)
/**
 * How many of a thread's wake-up message IDs its record in `workspace.json` keeps, newest last (ADR-0061 decision 8).
 * Kept whether or not Keep local history is on, since they are IDs and carry nothing anyone wrote: with history off the
 * thread store is in memory, and the record is what still marks a wake-up after a restart. A thousand IDs is about 40 KB.
 */
export const WAKE_UP_IDS_KEPT = 1_000
/**
 * Each thread's kept wake-up IDs as `workspace.json` holds them, `wakeUps` on the thread's record. Read from the file
 * before the thread schema, which drops the field; a file written before it was kept gives the newest it published.
 */
function savedWakeUps(input: unknown): Map<string, string[]> {
  const kept = new Map<string, string[]>()
  const threads = (input as { snapshot?: { threads?: unknown } } | null)?.snapshot?.threads
  if (!Array.isArray(threads)) return kept
  for (const thread of threads as unknown[]) {
    const { id, wakeUps, wakeUpMessageIds } = (thread ?? {}) as { id?: unknown; wakeUps?: unknown; wakeUpMessageIds?: unknown }
    const listed: unknown[] = Array.isArray(wakeUps) ? wakeUps : Array.isArray(wakeUpMessageIds) ? wakeUpMessageIds : []
    const ids = [...new Set(listed.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 512))].slice(-WAKE_UP_IDS_KEPT)
    if (typeof id === 'string' && ids.length) kept.set(id, ids)
  }
  return kept
}
/**
 * How many of a thread's wake-ups keep the requests their news said waited on the user in its record in `workspace.json`,
 * newest last (ADR-0073, answering in Watcher's conversation). Only Watcher's wake-ups carry any. Identities alone, kept
 * whatever Keep local history says, for the reason the wake-up IDs are; the thread store keeps every one while it is on.
 */
export const WAKE_UP_ASKS_KEPT = 200
const NO_ASKS: ReadonlyMap<string, readonly WatcherAsk[]> = new Map()
const NO_THREAD_IDS: ReadonlySet<string> = new Set()
/** Why a write for a thread being cleared was not taken. */
const CLEARED_THREAD_WRITE = new Error('The thread is being cleared')
/** The user message an event adds or replaces, which is evidence that the user sent it; undefined for any other event. */
function recordedUserMessage(event: ThreadEvent): string | undefined {
  return (event.kind === 'message-added' || event.kind === 'message-replaced') && event.message.role === 'user' ? event.message.id : undefined
}
/** A message's identity as the store lists it (`ThreadStore.messageIdentities`). */
function storedIdentity(message: AgentMessage): StoredMessageIdentity {
  return { id: message.id, role: message.role, ...(message.turnMessageId === undefined ? {} : { turnMessageId: message.turnMessageId }) }
}
/** Each thread's kept wake-up asks as `workspace.json` holds them, `wakeUpAsks` on the thread's record, read before the schema drops it. */
function savedWakeUpAsks(input: unknown): Map<string, Map<string, readonly WatcherAsk[]>> {
  const kept = new Map<string, Map<string, readonly WatcherAsk[]>>()
  const threads = (input as { snapshot?: { threads?: unknown } } | null)?.snapshot?.threads
  if (!Array.isArray(threads)) return kept
  for (const thread of threads as unknown[]) {
    const { id, wakeUpAsks } = (thread ?? {}) as { id?: unknown; wakeUpAsks?: unknown }
    if (typeof id !== 'string' || !Array.isArray(wakeUpAsks)) continue
    const asks = new Map<string, readonly WatcherAsk[]>()
    for (const entry of (wakeUpAsks as unknown[]).slice(-WAKE_UP_ASKS_KEPT)) {
      const { messageId, asks: listed } = (entry ?? {}) as { messageId?: unknown; asks?: unknown }
      const parsed = watcherAsksSchema.safeParse(listed)
      if (typeof messageId === 'string' && messageId.length > 0 && messageId.length <= 512 && parsed.success && parsed.data.length) asks.set(messageId, parsed.data)
    }
    if (asks.size) kept.set(id, asks)
  }
  return kept
}
/**
 * A send as its provider hears it: whether it is a wake-up, and what its news said waited on the user, are the
 * workspace's record, not the adapter's business.
 */
function withoutWakeUp<C extends Extract<AgentHostCommand, { type: 'send' }>>(command: C): C {
  if (command.wakeUp === undefined && command.watcherAsks === undefined && command.hiddenWakeUp === undefined) return command
  const { wakeUp, watcherAsks, hiddenWakeUp, ...rest } = command
  void wakeUp; void watcherAsks; void hiddenWakeUp
  return rest as C
}
/**
 * Each thread's kept hidden wake-up IDs as `workspace.json` holds them, `hiddenWakeUps` on the thread's record: the
 * wake-ups that carried only delegation news (ADR-0081, October 19, 2026). IDs only, kept whatever Keep local history
 * says, as `wakeUps` are, so a restart or a history read again keeps them hidden. Read before the thread schema drops it.
 */
function savedHiddenWakeUps(input: unknown): Map<string, string[]> {
  const kept = new Map<string, string[]>()
  const threads = (input as { snapshot?: { threads?: unknown } } | null)?.snapshot?.threads
  if (!Array.isArray(threads)) return kept
  for (const thread of threads as unknown[]) {
    const { id, hiddenWakeUps } = (thread ?? {}) as { id?: unknown; hiddenWakeUps?: unknown }
    if (typeof id !== 'string' || !Array.isArray(hiddenWakeUps)) continue
    const ids = [...new Set((hiddenWakeUps as unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 512))].slice(-WAKE_UP_IDS_KEPT)
    if (ids.length) kept.set(id, ids)
  }
  return kept
}

/** How long a burst of provider snapshots is gathered into one publish. The coordinator's own
 * broadcast window is the same 16 ms, so this costs a window rather than a visible delay. */
const PUBLISH_WINDOW_MS = 16
/** How long a provider-driven cache write waits for the state to settle. A user command never
 * waits this out: it writes through `flush()` and returns after its own write. */
const WRITE_WINDOW_MS = 250

/** Durable Sotto organization above the existing native identity/transport boundary.
 * Only an unstarted local thread can change provider. Native bindings are never rewritten. */
export class WorkspaceHost implements AgentHost, BabysitStore {
  private watcherPrObserver: ((read: PullRequestObservation) => void) | undefined
  setWatcherPrObserver(observer: (read: PullRequestObservation) => void): void { if (this.watcherEnabled) this.watcherPrObserver = observer }
  private observePullRequest(view: GitPullRequestView): void {
    if (view.state === 'merged') this.pullRequestMerged(view.url)
    if (!this.watcherPrObserver) return
    const checks = summarizePullRequestChecks(view.headId, view.checks, view.checksUnknown)
    this.watcherPrObserver({ url: view.url, head: view.headId ?? null, observedAt: view.observedAt ?? new Date().toISOString(),
      state: view.state, availability: 'available', checks, ...(checks !== 'unknown' ? { checkCount: view.checks.length } : {}),
      reviewApproved: view.reviewDecision === 'approved', changesRequested: view.reviewDecision === 'changes_requested', autoMerge: view.autoMerge !== null,
      ...(view.mergeable !== 'unknown' ? { conflicting: view.mergeable === 'conflicting' } : {}) })
  }
  private readonly launchProfiles: WatcherLaunchProfiles
  /** The providers held to Owl on this run, read once at start. */
  private readonly held: HeldProviders
  /** The held provider a new project or thread would be on: the project's provider, or the thread's model's. */
  private heldProviderCreatedBy(command: AgentHostCommand): ProviderId | undefined {
    if (!this.held.size) return undefined
    if (command.type === 'create-project') return command.provider && this.held.has(command.provider) ? command.provider : undefined
    if (command.type !== 'create-thread') return undefined
    const model = resolveModel(this.state.snapshot.models, command.modelId)
    const owner = model?.providerId && this.held.has(model.providerId) ? model.providerId : undefined
    return owner ?? heldProviderOfThreadRecord({ modelId: command.modelId }, this.held)
  }
  /** Disabled records are carried through saves exactly as read, outside the active projection. */
  private readonly preservedDormantThreads = new Map<string, AgentThread>()
  private readonly retainedWatcherIds = new Set<string>()
  private visible(thread: AgentThread): boolean {
    return (this.watcherEnabled || !this.retainedWatcherIds.has(thread.id) && thread.kind !== 'watcher' && thread.kind !== 'watcher-history')
      && heldProviderOfThreadRecord(thread, this.held) === undefined
  }
  /**
   * Marks a thread the workspace changed (#925): its record, or something its merge or its publication reads, such as its
   * stored activity, its subagent summary or its creation. The next accept merges it again over its provider's record, as
   * every accept used to merge every thread, and the next publication, save and release look at it. Every path that
   * changes a thread marks it, after the change and by its ID, so a change made after an await is marked too.
   */
  private touch(id: string): void { this.remerge.add(id); this.markChanged(id) }
  /** `touch`, answering the thread, for a write made on the spot: `this.touched(thread).title = title`. */
  private touched(thread: AgentThread): AgentThread { this.touch(thread.id); return thread }
  /** The next publication, save and release look at this thread again. An accept marks what it merged this way. */
  private markChanged(id: string): void { this.unpublished.add(id); this.unsaved.add(id); this.releasable.add(id) }
  /** Anything about any thread may have changed: the next accept takes the inner host's publication in whole. */
  private touchAll(): void { this.remergeAll = true; this.markAllChanged() }
  /** The next publication, save and release look at every thread. */
  private markAllChanged(): void { this.unpublishedAll = true; this.unsavedAll = true; this.releasableAll = true }
  /**
   * Where the state lists a thread, without walking the list. The index is read again whenever the list is another or a
   * different length, and when what it names is not there; a thread taken in place keeps its place.
   */
  private positionOf(id: string): number | undefined {
    const threads = this.state.snapshot.threads
    let index = this.threadIndex
    if (!index || index.array !== threads || index.length !== threads.length) index = this.indexThreads()
    let at = index.positions.get(id)
    if (at !== undefined && threads[at]?.id !== id) { index = this.indexThreads(); at = index.positions.get(id) }
    return at
  }
  private indexThreads(): NonNullable<WorkspaceHost['threadIndex']> {
    const threads = this.state.snapshot.threads
    const positions = new Map<string, number>()
    for (let at = 0; at < threads.length; at++) positions.set(threads[at]!.id, at)
    this.threadIndex = { array: threads, length: threads.length, positions }
    return this.threadIndex
  }
  /**
   * A thread's creation, without walking the list: started creations stay in it for as long as their threads do, and an
   * accept looks one up for every thread it merges. Read again whenever the list is another or a different length, and
   * when what it names is not there; a phase changes in place and keeps its entry.
   */
  private creationOf(threadId: string): Workspace['creations'][number] | undefined {
    const creations = this.state.creations
    let index = this.creationIndex
    if (!index || index.array !== creations || index.length !== creations.length) index = this.indexCreations()
    let at = index.positions.get(threadId)
    if (at !== undefined && creations[at]?.threadId !== threadId) { index = this.indexCreations(); at = index.positions.get(threadId) }
    return at === undefined ? undefined : creations[at]
  }
  private indexCreations(): NonNullable<WorkspaceHost['creationIndex']> {
    const creations = this.state.creations
    const positions = new Map<string, number>()
    for (let at = 0; at < creations.length; at++) if (!positions.has(creations[at]!.threadId)) positions.set(creations[at]!.threadId, at)
    this.creationIndex = { array: creations, length: creations.length, positions }
    return this.creationIndex
  }
  /** The state's record of a thread, visible or not. */
  private threadById(id: string): AgentThread | undefined {
    const at = this.positionOf(id)
    return at === undefined ? undefined : this.state.snapshot.threads[at]
  }
  /** Takes a thread out of the state. One its provider still publishes comes back at the next accept, as it always did. */
  private removeThread(id: string): void {
    this.state.snapshot.threads = this.state.snapshot.threads.filter(item => item.id !== id)
    this.touch(id)
  }
  private threadVisible(id: string): boolean {
    const thread = this.threadById(id)
    return (this.watcherEnabled || !this.retainedWatcherIds.has(id)) && (!thread || this.visible(thread))
  }
  private visibleSnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    if (this.watcherEnabled && !this.held.size) return snapshot
    return { ...snapshot, threads: snapshot.threads.filter(thread => this.visible(thread)),
      ...(this.held.size ? catalogWithoutHeld(snapshot, this.held) : {}) }
  }
  watcherCreationPhase(threadId: string): 'unstarted' | 'starting' | 'retryable' | 'started' | undefined { return this.creationOf(threadId)?.phase }
  async watcherRead(threadId: string, afterPosition?: number, limit = 50) {
    if (!this.watcherEnabled) throw new Error(WATCHER_DISABLED)
    await this.refreshThread(threadId)
    const thread = this.thread(threadId)
    this.applyEvents()
    // Positions and the epoch are the store's own, so the read waits for what was posted for the thread.
    await this.settled(threadId)
    if (this.storeUnavailable || thread.historyStatus === 'error' || thread.historyStatus === 'loading') return undefined
    const epoch = this.threadStore.readMessageEpoch(threadId)
    return { historyEpoch: epoch?.epoch ?? String(epoch?.sequence ?? 0), ...this.threadStore.readForwardMessages(threadId, afterPosition, limit),
      activities: this.threadStore.readActivities(threadId, { keep: false }).slice(-100).map(({ id, kind, status, title, startedAt, completedAt }) => ({
        id, kind, status, title: title.slice(0, 2_000), ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}) })) }
  }
  /**
   * A handover of an earlier Watcher conversation (ADR-0073), read from Sotto's own record of it (ADR-0016) with each
   * message as `shown` makes it. Undefined when the record cannot be read; with Keep local history off it is what this
   * run kept in memory, and says so.
   */
  watcherHandover(threadId: string, shown: (message: AgentMessage) => AgentMessage | null): Handover | undefined {
    if (!this.watcherEnabled) throw new Error(WATCHER_DISABLED)
    return this.handoverOf(threadId, shown)
  }
  /**
   * A handover of an ordinary thread for a thread that continues it on another provider (ADR-0089), read from Sotto's own
   * record (ADR-0016). A thread that itself continued another carries its first message's words without the handover it
   * began with. Undefined when the record cannot be read; with Keep local history off it says what it holds.
   */
  threadHandover(threadId: string): Handover | undefined {
    const thread = this.threadById(threadId)
    if (!thread || !this.threadVisible(threadId) || thread.kind === 'watcher' || thread.kind === 'watcher-history') return undefined
    return this.handoverOf(threadId, message => continuedWordsOnly(thread, message))
  }
  private handoverOf(threadId: string, shown: (message: AgentMessage) => AgentMessage | null): Handover | undefined {
    const thread = this.threadById(threadId)
    if (!thread?.providerId || this.storeUnavailable) return undefined
    this.applyEvents()
    // Each message is shown once it is marked as a wake-up or not, so a hidden wake-up is known by its provenance.
    const source = { threadId, title: thread.title, provider: thread.providerId }
    // Read at one moment of the file, so a write the store worker commits meanwhile is not laid over it twice.
    return this.threadStore.reading(() => readHandover(this.handoverStore(threadId), { source, shown }))
  }
  async setWatcherKind(threadId: string, kind: 'watcher' | 'watcher-history'): Promise<void> {
    if (!this.watcherEnabled) throw new Error(WATCHER_DISABLED)
    await this.initialize(); const thread = this.thread(threadId); this.touched(thread).kind = kind
    this.dirty = true; await this.flush(); this.publish()
  }
  /**
   * Records the thread that delegated work to this one (ADR-0081), by Sotto thread ID, on the thread's own record, so the
   * link is in the snapshot and survives a restart. Set once, before the delegated thread's first send; never changed.
   */
  async setDelegatedBy(threadId: string, delegatingThreadId: string): Promise<void> {
    await this.initialize(); const thread = this.thread(threadId)
    if (thread.delegatedBy === delegatingThreadId) return
    if (thread.delegatedBy !== undefined) throw new Error('This thread was delegated by another thread.')
    this.touched(thread).delegatedBy = delegatingThreadId
    this.dirty = true; await this.flush(); this.publish()
  }
  /** Continuing agents as threads and forking at a reply (#1028): the Owl list's answer, given once at start. */
  private threadStarts = false
  allowThreadStarts(): void { this.threadStarts = true }
  /**
   * One of a thread's agents continued as a thread of its own (#1028), by Sotto thread IDs alone (ADR-0002). The new
   * thread is made in the agent's project, on its working-copy choice. A Codex agent becomes Codex's own copy of its
   * conversation, bound to the new thread now; any other agent, or a Codex agent asked to `handover`, starts the new
   * thread from a thin handover of its task and result that goes with its first message. The model is asked nothing.
   */
  async continueAgent(request: AgentContinuation): Promise<AgentHostResult> {
    if (!this.threadStarts) throw new Error('Continuing an agent as a thread is available in Sotto Owl. Nothing was made.')
    await this.initialize()
    const source = this.thread(request.sourceThreadId)
    if (!this.visible(source) || source.kind === 'watcher' || source.kind === 'watcher-history' || !source.providerId) throw new Error('This thread’s agents can’t be continued as threads. Nothing was made.')
    if (this.subagentUnavailable) throw new Error('Agent history is unavailable. Restore access to local storage and restart Sotto.')
    const row = this.subagentStore.row(source.id, request.agentId)
    if (!row || row.kind === 'workflow') throw new Error('Sotto no longer lists this agent, so nothing was made. Open Agents again and choose it.')
    if (row.status === 'running') throw new Error(AGENT_STILL_WORKING)
    if (row.status === 'unknown') throw new Error(AGENT_NOT_SEEN_FINISHING)
    const fork = request.handover !== true && source.providerId === 'codex'
    const handover = fork ? undefined : this.agentStartHandover(source, row, row.assignmentId)
    if (!fork && !handover) throw new Error(AGENT_HANDOVER_UNAVAILABLE)
    const title = row.title.trim().slice(0, 240) || 'Agent task'
    const startedFrom: AgentThreadStart = { threadId: source.id, from: 'agent', route: fork ? 'fork' : 'handover', at: new Date().toISOString(), agentTitle: title,
      ...(handover ? { agentId: row.id, assignmentId: row.assignmentId, handover: { thin: true, counts: handover.counts } } : {}) }
    return this.startThread({ ...request, title, startedFrom, ...(fork ? { fork: { agentId: row.id } } : {}) })
  }
  /**
   * Fork from here (#1028, E5b): a new thread with a thread's conversation up to one of its replies, by Sotto IDs alone.
   * Codex and Claude Code copy it themselves, bound to the new thread now; every other provider starts the new thread
   * from a handover of the conversation up to the reply, which goes with its first message. The model is asked nothing.
   */
  async forkAtReply(request: ReplyFork): Promise<AgentHostResult> {
    if (!this.threadStarts) throw new Error('Fork from here is available in Sotto Owl. Nothing was made.')
    await this.initialize()
    const source = this.thread(request.sourceThreadId)
    if (!this.visible(source) || source.kind === 'watcher' || source.kind === 'watcher-history' || !source.providerId) throw new Error('This thread can’t be forked. Nothing was made.')
    if (source.status === 'running') throw new Error(FORK_TURN_RUNNING)
    if (this.threadMessage(source.id, request.messageId)?.role !== 'assistant') throw new Error(FORK_REPLY_GONE)
    const title = `Fork of ${source.title}`.slice(0, 240)
    const at = new Date().toISOString()
    if (NATIVE_FORKS.has(source.providerId)) {
      return this.startThread({ ...request, title, startedFrom: { threadId: source.id, from: 'turn', route: 'fork', at, messageId: request.messageId }, fork: { messageId: request.messageId } })
    }
    const handover = this.replyHandover(source, request.messageId)
    if (!handover) throw new Error(FORK_REPLY_GONE)
    return this.startThread({ ...request, title, startedFrom: { threadId: source.id, from: 'turn', route: 'handover', at, messageId: request.messageId, handover: { thin: false, counts: handover.counts } } })
  }
  /**
   * A handover of a thread's conversation up to one of its replies, read from Sotto's own record the way Watcher's
   * handover reads a whole thread (#1028, E5b): its first request, its latest request up to the reply and the reply, and
   * the newest messages that fit. The store is read as if the thread ended at the reply, so nothing after it is carried.
   * Each message is carried as the provider heard it, a handover the thread itself began from included.
   */
  private replyHandover(source: AgentThread, messageId: string): AgentHandover | undefined {
    if (!source.providerId || this.storeUnavailable) return undefined
    this.applyEvents()
    const provider = source.providerId
    return this.threadStore.reading(() => this.replyHandoverRead(source, provider, messageId))
  }
  /** `replyHandover`'s read, made at one moment of the file. */
  private replyHandoverRead(source: AgentThread, provider: NonNullable<AgentThread['providerId']>, messageId: string): AgentHandover | undefined {
    const store = this.handoverStore(source.id)
    const identities = store.messageIdentities(source.id)
    const end = identities.findIndex(identity => identity.id === messageId)
    if (end < 0 || identities[end]!.role !== 'assistant') return undefined
    const upToReply: HandoverStore = {
      ephemeral: store.ephemeral,
      readMessages: (id, options = {}) => {
        if (options.beforePosition !== undefined) return store.readMessages(id, options)
        // The newest page is the one that holds the reply, cut after it; the pages after it are read past.
        for (let beforePosition: number | undefined; ;) {
          const window = store.readMessages(id, { ...options, ...(beforePosition === undefined ? {} : { beforePosition }) })
          const at = window.messages.findIndex(message => message.id === messageId)
          if (at >= 0) return { ...window, messages: window.messages.slice(0, at + 1) }
          if (!window.earlierAvailable || !window.messages.length) return { ...window, messages: [] }
          beforePosition = window.firstPosition
        }
      },
      messageIdentities: () => identities.slice(0, end + 1),
      message: (id, wanted) => store.message(id, wanted),
      wakeUps: id => store.wakeUps(id),
      activityCount: id => store.activityCount(id),
    }
    const built = readHandover(upToReply, { source: { threadId: source.id, title: source.title, provider } })
    return { text: built.text, counts: handoverCounts(built.summary) }
  }
  /**
   * Makes a thread that begins from another (#1028): an ordinary new thread in the source's project, then, for a fork, the
   * provider's copy bound to it before anything is published as made. A refused or unconfirmed copy leaves nothing behind.
   */
  private async startThread(request: Omit<AgentContinuation, 'sourceThreadId' | 'agentId' | 'handover'> & { readonly title: string; readonly startedFrom: AgentThreadStart
    readonly fork?: { readonly agentId?: string; readonly messageId?: string } }): Promise<AgentHostResult> {
    const source = this.thread(request.startedFrom.threadId)
    // Same folder is the source thread's own: its worktree when it has one, else the project folder it shares.
    const own = source.worktree?.mode === 'independent' ? source.worktree.path ?? source.worktree.existingWorktreePath : undefined
    const workingCopy = request.workingCopy === 'independent' ? { workingCopy: 'independent' as const, ...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
      ...(request.startFromOrigin !== undefined ? { startFromOrigin: request.startFromOrigin } : {}) }
      : own ? { workingCopy: 'independent' as const, existingWorktreePath: own } : { workingCopy: 'shared' as const }
    await this.execute({ type: 'create-thread', commandId: randomUUID(), threadId: request.threadId, projectId: source.projectId, title: request.title, titleSource: 'user', modelId: request.modelId,
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}), ...(request.runtimeMode ? { runtimeMode: request.runtimeMode } : {}),
      ...(request.providerMode ? { providerMode: request.providerMode } : {}), ...workingCopy })
    return this.onLane(request.threadId, async () => {
      this.touched(this.thread(request.threadId)).startedFrom = request.startedFrom
      if (!request.fork) { this.dirty = true; await this.flush(); this.publish(); return { accepted: true } }
      try {
        const creation = this.creationOf(request.threadId)
        if (!creation || !this.inner.forkThread) throw new Error(`${PROVIDER_LABELS[source.providerId!]} has no fork of its own, so nothing was made.`)
        if (this.thread(request.threadId).worktree?.status !== 'ready') await this.startWorkingCopy(this.thread(request.threadId))
        const thread = this.thread(request.threadId)
        if (thread.worktree?.status === 'error') throw new Error(thread.worktree.error ?? 'The new worktree could not be made, so nothing was made.')
        const workingDirectory = await this.threadWorkingDirectory(thread.id)
        creation.phase = 'starting'; this.touched(thread).nativeSessionStarted = true; this.dirty = true
        await this.flush(); this.publish()
        const result = await this.inner.forkThread({ commandId: creation.commandId, threadId: thread.id, title: thread.title, modelId: thread.modelId, workingDirectory,
          ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}), ...(thread.runtimeMode ? { runtimeMode: thread.runtimeMode } : {}),
          ...(thread.providerMode ? { providerMode: thread.providerMode } : {}), source: { threadId: source.id, ...request.fork } })
        if (!result.accepted) throw new Error(`${PROVIDER_LABELS[source.providerId!]} did not confirm the copy, so Sotto made no thread for it. It may have kept one, which Sotto leaves alone. Nothing in “${source.title}” changed. Try again.`)
      } catch (error) {
        if (await this.discardStart(request.threadId)) throw error
        const message = error instanceof Error ? error.message : 'The copy was not made.'
        throw new Error(`${message} Its new worktree couldn’t be removed, so it stays with an empty thread, “${request.title}”. Remove the thread’s folder or use the thread.`, { cause: error })
      }
      this.accept(await this.inner.snapshot(source.providerId)); await this.flush(); this.publish()
      return { accepted: true }
    })
  }
  /**
   * A thread a refused or unconfirmed fork was to be (#1028): its record goes, and a worktree made for it is removed again.
   * A worktree that cannot be removed keeps its thread, made an ordinary unstarted one, so the folder is not lost track of:
   * the worktree sweep and the user's own Remove folder reach only a thread's (ADR-0041). Answers whether the record went.
   */
  private async discardStart(threadId: string): Promise<boolean> {
    const worktree = this.threadById(threadId)?.worktree
    if (worktree?.mode === 'independent' && worktree.path && !worktree.reused) {
      // A fresh worktree holds nothing of the user's. No status read is left working in it when it goes.
      const releaseStatus = this.gitStatus?.hold?.(worktree.path)
      try { await this.gitStatus?.idle?.(worktree.path); await this.worktrees.reclaim(worktree, { automatic: true }) }
      catch {
        const thread = this.thread(threadId), creation = this.creationOf(threadId)
        delete this.touched(thread).startedFrom; thread.nativeSessionStarted = false
        if (creation) creation.phase = 'unstarted'
        this.dirty = true
        try { await this.flush() } catch { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.' }
        this.publish()
        return false
      } finally { releaseStatus?.() }
    }
    this.removeThread(threadId)
    this.state.creations = this.state.creations.filter(item => item.threadId !== threadId)
    this.privateLegacyMessages.delete(threadId)
    this.dirty = true
    try { await this.flush() } catch { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.' }
    this.publish()
    return true
  }
  private agentStartHandover(source: Pick<AgentThread, 'id' | 'title' | 'providerId'>, row: SubagentRow, assignmentId: string): AgentHandover | undefined {
    if (!source.providerId || this.subagentUnavailable) return undefined
    return agentHandover({ source: { threadId: source.id, title: source.title, provider: source.providerId }, agent: row,
      assignment: this.subagentStore.assignment(source.id, row.id, assignmentId), historyKept: !this.subagentStore.ephemeral })
  }
  /**
   * The handover a thread that began from another goes with on its first message (#1028), built afresh from Sotto's own
   * record whenever it is asked for, so its words are kept nowhere else. Undefined once it has gone or been put away, and
   * when Sotto no longer holds what it carries.
   */
  startHandover(threadId: string): AgentHandover | undefined {
    if (!this.threadStarts) return undefined
    const thread = this.threadById(threadId)
    const start = thread?.startedFrom
    if (!start || start.route !== 'handover' || !start.handover || start.handover.sent) return undefined
    const source = this.threadById(start.threadId)
    if (source && start.from === 'turn' && start.messageId) return this.replyHandover(source, start.messageId)
    if (!source || start.from !== 'agent' || !start.agentId || !start.assignmentId || this.subagentUnavailable) return undefined
    const row = this.subagentStore.row(source.id, start.agentId)
    return row ? this.agentStartHandover(source, row, start.assignmentId) : undefined
  }
  /** The first message went with its handover, did not after all (`null`), or goes without it (`'drop'`) (#1028). */
  async markStartHandover(threadId: string, sent: StartHandoverSent | null | 'drop'): Promise<void> {
    await this.initialize()
    const thread = this.thread(threadId), start = thread.startedFrom
    if (!start?.handover) return
    this.touch(threadId)
    if (sent === 'drop') { const { handover, ...rest } = start; void handover; thread.startedFrom = rest }
    else if (sent === null) { const { sent: _sent, ...handover } = start.handover; void _sent; thread.startedFrom = { ...start, handover } }
    else thread.startedFrom = { ...start, handover: { ...start.handover, sent } }
    this.dirty = true; await this.flush(); this.publish()
  }
  /**
   * Records the thread this one continues on another provider (ADR-0089), on its own record, before its first message
   * goes, so the handover that message carries is told apart from the user's words from its first echo. The continued
   * thread keeps the source's title: one the user typed stays theirs, and any other is kept as Sotto's, so naming from
   * the first message, which begins with the handover, never renames it. Set again only by a retry of the same continuation.
   */
  async setContinuedFrom(threadId: string, from: ThreadContinuedFrom): Promise<void> {
    await this.initialize(); const thread = this.thread(threadId)
    if (thread.continuedFrom !== undefined && thread.continuedFrom.threadId !== from.threadId) throw new Error('This thread continues another thread.')
    const previous = { continuedFrom: thread.continuedFrom, titleSource: thread.titleSource, titledFromFirstMessage: thread.titledFromFirstMessage }
    this.touched(thread).continuedFrom = from
    if (thread.titleSource !== 'user') { thread.titleSource = 'generated'; delete thread.titledFromFirstMessage }
    this.dirty = true
    try { await this.flush() } catch (error) { Object.assign(this.touched(thread), previous); if (previous.titledFromFirstMessage === undefined) delete thread.titledFromFirstMessage; throw error }
    this.publish()
  }
  /** Records which message carried a continued thread's handover, once its send named it (ADR-0089). */
  async noteContinuedMessage(threadId: string, messageId: string): Promise<void> {
    await this.initialize(); const thread = this.thread(threadId)
    const handover = thread.continuedFrom?.handover
    if (!thread.continuedFrom || !handover || handover.messageId === messageId) return
    const previous = thread.continuedFrom
    this.touched(thread).continuedFrom = { ...previous, handover: { ...handover, messageId } }
    this.dirty = true
    try { await this.flush() } catch (error) { this.touched(thread).continuedFrom = previous; throw error }
    this.publish()
  }
  /** Records a thread that continues this one (ADR-0089), newest last, on this thread's own record. */
  async addContinuedIn(threadId: string, link: ThreadContinuedIn): Promise<void> {
    await this.initialize(); const thread = this.thread(threadId)
    const previous = thread.continuedIn
    this.touched(thread).continuedIn = [...(previous ?? []).filter(item => item.threadId !== link.threadId), link].slice(-THREAD_CONTINUED_IN_MAX)
    this.dirty = true
    try { await this.flush() } catch (error) { if (previous === undefined) delete this.touched(thread).continuedIn; else this.touched(thread).continuedIn = previous; throw error }
    this.publish()
  }
  /** One message of a thread as Sotto's record holds it, read by its ID alone: a delegation's reply (ADR-0081). */
  threadMessage(threadId: string, messageId: string): AgentMessage | undefined {
    if (!this.threadVisible(threadId) || this.storeUnavailable) return undefined
    this.applyEvents()
    try { return this.writes.unconfirmed(threadId) ? this.messageWithHeld(threadId, messageId) : this.threadStore.message(threadId, messageId) }
    catch { return undefined }
  }
  useWatcherTools(tools: WatcherProfileTools): void { this.launchProfiles.useTools(tools) }
  useBrowserTools(tools: BrowserAgentTools): void { this.inner.useBrowserTools?.(tools) }
  useWorkerRoles(roles: WorkerRoleSource): void { this.inner.useWorkerRoles?.(roles) }
  useThreadTools(tools: readonly ScopedThreadTools[]): void { this.inner.useThreadTools?.(this.watcherEnabled ? tools : tools.filter(tool => tool.name !== 'sotto_threads')) }
  readonly concurrentProviders: boolean
  readonly subscribeUsage?: (listener: (record: UsageTokenObservation) => void) => () => void
  readonly visitUsage?: (threadId: string, visitor: (record: UsageTokenObservation) => void) => void
  readonly readProviderQuota?: (providerId: ProviderId, refresh: boolean, background?: boolean) => Promise<UsageQuotaRead>
  readonly scanUsageHistory?: (sink: UsageHistorySink, signal: AbortSignal) => Promise<void>
  private state: Workspace = { snapshot: structuredClone(EMPTY_AGENT_HOST), creations: [], projectAliases: [], clearedThreadIds: [] }
  /**
   * The cleared threads' IDs as a set (ADR-0140 decision 6), read from `clearedThreadIds`: every provider snapshot and
   * thread event naming one is refused, so a provider that still reports it cannot bring it back. Asking costs the same
   * however many threads were cleared.
   */
  private readonly clearedIds = new Set<string>()
  /**
   * What each thread babysits, with what it was last told, by thread (ADR-0061 decision 10). Saved on the thread's record
   * in `workspace.json`; the thread itself carries only the published part, `babysitting`, so no client is sent the rest.
   */
  private babysitRecords = new Map<string, BabysitRecord[]>()
  /**
   * Each thread's newest wake-up message IDs, up to WAKE_UP_IDS_KEPT, by thread (ADR-0061 decision 8). Saved on the
   * thread's record in `workspace.json` as `wakeUps`; the thread publishes only the newest fifty, `wakeUpMessageIds`.
   */
  private wakeUpRecords = new Map<string, string[]>()
  /**
   * Which of each thread's wake-ups carried only delegation news, up to WAKE_UP_IDS_KEPT, by thread (ADR-0081, October 19,
   * 2026). Saved on the thread's record as `hiddenWakeUps`; the thread publishes the newest fifty, `hiddenWakeUpMessageIds`,
   * and each such message carries `hiddenWakeUp`.
   */
  private hiddenWakeUpRecords = new Map<string, string[]>()
  /**
   * The requests each of a thread's newest Watcher wake-ups said waited on the user, by thread and then by the wake-up's
   * message ID, up to WAKE_UP_ASKS_KEPT a thread (ADR-0073). Saved on the thread's record in `workspace.json` as
   * `wakeUpAsks`; published only as each wake-up's `watcherAsks` mark.
   */
  private wakeUpAskRecords = new Map<string, Map<string, readonly WatcherAsk[]>>()
  /** Babysitting, told of each Unlink so it can end babysitting that pull request (ADR-0061 decision 9). */
  private readonly unlinkListeners = new Set<(threadId: string, url: string) => Promise<void>>()
  /** Babysitting, told when a thread that babysits is settled or archived, so it ends then (ADR-0061 decision 9). */
  private readonly babysatClosedListeners = new Set<() => void>()
  private readonly store: AtomicJsonStore<Workspace>
  private loading: Promise<void> | undefined
  private hostId: string | undefined
  private ready = false
  private stopping = false
  private deliveryStopped = false
  private readonly providerSubscriptions: Array<() => void> = []
  private dirty = false
  private saving: Promise<void> | undefined
  /** Someone asked for the state to be on disk before they continue, so a write in flight is followed by another. */
  private flushWanted = false
  private saveError: string | undefined
  /** Only a successfully committed organization snapshot can suppress another write. */
  private savedOrganization: Workspace | undefined
  /** The same, as the compact text the cheaper flush last wrote; comparing text replaces cloning. */
  private savedOrganizationText: string | undefined
  /** The catalog's serialized form, kept while the certified catalog array itself is unchanged. */
  private catalogTextCache: { readonly models: readonly AgentModel[]; readonly text: string } | undefined
  /** A failed activity migration keeps the legacy JSON payload recoverable this run. */
  private activityStoreUnavailable = false
  /** Once retention is disabled, the live timeline must never become a plaintext fallback. */
  private activityJsonFallbackAllowed = true
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly settledThreadListeners = new Set<(ids: readonly string[]) => void>()
  private readonly activityListeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  /**
   * The activity publication's thread records, frozen and owned, in the state's order, and everything else it carries, the
   * same way, with an empty thread list in its place (#1326). Each publication reads again only the threads marked since
   * the last (`unpublished`) and builds its snapshot from this map, a reference per thread (#925). Verifying
   * (`SOTTO_VERIFY_THREAD_CHANGES=1`), it is checked against a publication worked out from every thread after each change.
   */
  private published: ThreadMap
  /** The threads whose record may differ from the publication's, since it was last brought up to the state; all of them when set. */
  private readonly unpublished = new Set<string>()
  private unpublishedAll = true
  /** What changed in the publication since the workspace's thread changes were last built: threads, threads moved, or all. */
  private readonly changesSince = { whole: true, ids: new Set<string>(), placed: new Set<string>() }
  /** The workspace's own thread changes (#925), built from the publication's records. */
  private readonly changes = new ThreadChangesPublisher()
  /**
   * The inner host's threads and the rest of its snapshot, as its thread changes left them, or as the shim works them out
   * from a host that publishes only snapshots (#925). An upserted thread is merged over its record here; a publication
   * taken in whole reads them all.
   */
  private readonly incoming = new ThreadMap({ verify: false })
  /**
   * Whether the next publication of the inner host is taken in whole: until one has been, and after a read, which may have
   * left the state saying what the inner host's publications have not.
   */
  private remergeAll = true
  /**
   * Threads whose record, or something their merge reads, the workspace changed since the last accept, so the next accept
   * merges them again over their provider's record, as it used to merge every thread. A thread its provider no longer
   * publishes loses its live state then, as every such thread did on every accept.
   */
  private readonly remerge = new Set<string>()
  /** The workspace changed the providers, the catalog or the connection itself, so the next accept takes the inner host's in again. */
  private restTouched = false
  /**
   * The threads the accept that last took each of them in found disconnected, and when the last accept ran. An accept used
   * to date every such thread's agents afresh (`trackSubagents`); now the date is put on one when it is next taken in.
   */
  private readonly disconnectedThreads = new Set<string>()
  private acceptedAt: number | undefined
  /** The threads whose activity may not be in the store as it is held now; all of them when set. */
  private readonly unsaved = new Set<string>()
  private unsavedAll = true
  /** Whether the last save kept subagent task words in the records, so the next one without them saves every thread. */
  private savedWithWords = false
  /** The threads that may have gone idle or out of view since the last release; all of them when set. */
  private readonly releasable = new Set<string>()
  private releasableAll = true
  /** The state's threads by ID, with the list and its length they were read from, so a look-up costs no walk. */
  private threadIndex: { readonly array: AgentThread[]; readonly length: number; readonly positions: Map<string, number> } | undefined
  /** The creations by thread ID, with the list and its length they were read from. */
  private creationIndex: { readonly array: Workspace['creations']; readonly length: number; readonly positions: Map<string, number> } | undefined
  /**
   * Every publication of the inner host taken in whole and every activity publication worked out from every thread, as
   * before #925. Only the test that holds the two paths to one another sets it.
   */
  private acceptsWhole = false
  /** Only certified immutable inputs can be a revision. Legacy hosts may edit their arrays in place. */
  private readonly activityInputs = new Map<string, { input: AgentActivity[]; output: AgentActivity[]; epoch: string | undefined; records: Map<string, AgentActivity> }>()
  /** The catalog a snapshot last brought and the one accepting it made. */
  private modelInputs: { incoming: AgentModel[]; output: AgentModel[] } | undefined
  /**
   * Threads whose activity records are in the store and not in memory: none is in view, none is working, and the store
   * holds exactly their list. Each costs its marker and count; a window, a phone or new provider input reads the records
   * back (#918). Such a thread carries no `activities`, and nothing syncs it, so its stored list is never overwritten.
   */
  private readonly storedActivity = new Set<string>()
  /**
   * Stored threads whose records the store worker is reading back for a window (ADR-0016, October 26): their provider is
   * not told they are observed until the list arrives, and each record it publishes for them meanwhile waits in `held`,
   * merged onto the list once it is here, so it keeps its sequence. `done` settles once the read has been dealt with.
   */
  private readonly activityReads = new Map<string, ActivityRead>()
  /** The threads the window last said it looks at, which their provider is told once no read holds one back. */
  private observation: ReadonlySet<string> = new Set()
  /**
   * How many reads in `activityReads` are of threads in `observation`. The provider is told the observation once this
   * comes to nought, so a window opening many stored threads tells it once for them all, not once for each (`endRead`).
   */
  private observedReads = 0
  /** Whether telling the provider waits for the task an accept runs in to end (`endRead`). */
  private observationQueued = false
  /** Reads whose list arrived while their thread was being cleared, each waiting to hear whether the clear went through. */
  private readonly readsAwaitingForget = new Map<string, () => void>()
  /** Whether this start read every record because the store had not yet said the roster holds their words. */
  private subagentWordsPending = false
  /** Set when legacy activity was moved into the roster, which the next save puts on the disk before anything drops it. */
  private rosterFlushPending = false
  /**
   * Set when the roster could not take moved task words, so every save until a restart keeps records whole, words and
   * all, and the warning stays up; the next start moves the words again from the records read back.
   */
  private rosterLacksWords = false
  /** The certified list a stored thread's provider last published, so publishing it again reads nothing back. */
  private readonly storedInputs = new Map<string, AgentActivity[]>()
  /** Stored lists read back during the accept now running, as the base a Git refresh compares new records with. */
  private readonly heldForInput = new Map<string, AgentActivity[] | undefined>()
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private publishPending = false
  /** Whether the open publish window lets no opening change cut it short: one already did, or it carries a flood. */
  private publishCut = false
  /** Whether an opening change is among what waits for the end of the open publish window. */
  private publishHeldOpening = false
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly lanes = new Map<string, Promise<unknown>>()
  private readonly organizationLanes = new Map<string, Promise<unknown>>()
  private readonly interruptLanes = new Map<string, Promise<unknown>>()
  /**
   * The remote half of status reads under way: a fetch or a GitHub lookup, run outside every lane and outside the
   * thread's folder, so a send never waits for one (issue #766). Closing waits for them as it waits for the lanes.
   */
  private readonly remoteStatusReads = new Set<Promise<void>>()
  /** Threads whose send has queued Git's inspection of the folder in the thread's lane, not yet begun. */
  private readonly inspectionsQueued = new Set<string>()
  /** Threads whose folder an inspection after a send or a turn could not confirm: their next send asks Git before the prompt. */
  private readonly fullCheckDue = new Set<string>()
  /** In-flight working-copy setup per thread, so a send waits for it instead of starting a second one. */
  private readonly preparations = new Map<string, Promise<void>>()
  private readonly worktrees: ThreadWorktrees
  private checkpointHooks: { privacyChanged?(): Promise<void>; beforeTurn(threadId: string): Promise<void>; isBlocked(threadId: string): boolean | Promise<boolean> } | undefined
  /**
   * One pending worktree re-read per folder, by `refreshKey`, with the threads waiting on it: a busy turn asks for a
   * single read rather than one per record, and threads working in one folder (ADR-0014) share it.
   */
  private readonly worktreeRefreshes = new Map<string, { readonly timer: ReturnType<typeof setTimeout>; readonly threads: Set<string> }>()
  /** Threads whose re-read came due while no window showed; the Git status timer reads them once one shows again. */
  private readonly refreshesOwed = new Set<string>()
  /** How many Git actions have changed a folder (`invalidateGitStatus`); an inspection begun before the last is not shared. */
  private gitChanges = 0
  /** Reads a folder's Git status the way T3 does; without one, records carry no status. */
  private gitStatus: GitStatusSource | undefined
  private gitStatusOptions: { foreground: () => boolean; visible: () => boolean; pollIntervalMs: () => number; autoPull: () => boolean } = { foreground: () => true, visible: () => true, pollIntervalMs: () => 0, autoPull: () => false }
  private gitStatusTimer: ReturnType<typeof setInterval> | undefined
  private gitStatusPolledAt = 0
  private gitStatusPolling = false
  /** Runs the Git actions on a thread's folder the way T3 does; without one, the commands say so. */
  private gitActions: GitActions | undefined
  /** Reads and acts on a thread's pull requests through gh (ADR-0027); without one, the surface says so. */
  private gitPullRequests: GitPullRequests | undefined
  /** Shared by desktop and headless hosts, with one reservation per checkout. */
  private readonly checkoutMutations = new CheckoutMutations()
  private pendingThreadWork: (threadId: string) => boolean = () => false
  private pendingThreadWorkReason: (threadId: string) => CheckoutPendingWork | null = () => null
  /** Additional desktop checkpoint recovery checks. */
  private mutationGuard: ((threadId: string, destinationFolder?: string) => Promise<boolean> | boolean) | undefined
  /** A thread's own history: the log and the message projection every window reads (issue #119). */
  private readonly subagentStore: SubagentStore
  private subagentUnavailable = false
  private readonly subagentSummaries = new Map<string, SubagentSummary>()
  private readonly subagentInputs = new Map<string, { epoch: string | undefined; records: Map<string, string>; activities: readonly AgentActivity[] | undefined }>()
  private readonly subagentListeners = new Set<(change: SubagentChange) => void>()
  private readonly subagentChanges = new Map<string, SubagentChange>()
  private subagentTimer: ReturnType<typeof setTimeout> | undefined
  private readonly subagentLiveSince = new Map<string, number>()
  private readonly startedAt = Date.now()
  private readonly threadStore: ThreadStore
  /**
   * Every write to the thread store goes through this (#1457). A write posted and not yet confirmed is held: its events
   * stay in `pendingEvents` or with the writer, and what reads the store either lays them over it or waits for them.
   */
  private readonly writes: ThreadStoreWriter
  /** The batch at the front of a thread's `pendingEvents` that is posted and not yet confirmed. One per thread is. */
  private readonly inFlight = new Map<string, readonly ThreadEvent[]>()
  /**
   * Answers posted on their own and not yet confirmed, by thread. A thread's next batch waits for them, so each thread has
   * one write of events unconfirmed at a time: what the store worker committed of it can then be told from the file.
   */
  private readonly answersInFlight = new Map<string, number>()
  /** A history-publishing host's write per thread that is not yet confirmed (`record`), as `inFlight` is for events. */
  private readonly recordsInFlight = new Set<string>()
  /**
   * What such a host published while its thread's writes were held, or the history whose write failed, compared again once
   * nothing holds it; with the answers given since, which follow that comparison's write, so each commits after the words
   * it answers.
   */
  private readonly recordsOwed = new Map<string, { readonly messages: readonly AgentMessage[]; readonly previousEpoch: string | undefined; readonly answers: AnswerGivenEvent[] }>()
  /**
   * Threads whose last whole-history write failed. Its retry is the next comparison, at the next publication or the history
   * retry, whichever comes first; answers already waiting wait for it, so nothing commits ahead of the words that failed.
   */
  private readonly recordsFailed = new Set<string>()
  /** When closing must be done by, once `close` began (`CLOSE_LIMIT_MS`). */
  private closeDeadline: number | undefined
  /** Counts activity saves, so a failure heard late puts back only what no later save has replaced. */
  private activitySaves = 0
  /** Activity saves posted and not yet confirmed: until they are, what the store holds is not known. */
  private activitySavesInFlight = 0
  /** Threads whose forget is posted and not yet confirmed. Nothing more of theirs is posted; what waits is held. */
  private readonly forgetting = new Set<string>()
  /** True once opening the history database failed; this run then keeps its messages in memory alone. */
  private storeUnavailable = false
  /** What the store already holds for a thread, so a publish appends the difference rather than the history. */
  private readonly known = new Map<string, { epoch: string | undefined; messages: MessageMark[] }>()
  /** Legacy snapshots may replay private messages after retention resumes. Keep their identities alone. */
  private readonly privateLegacyMessages = new Map<string, Set<string>>()
  /** The threads a window is looking at, each with how many turns of its history it has been given. */
  private readonly watched = new Map<string, number>()
  /** False until a window has said what it is looking at. Until then no thread's history is put away. */
  private declared = false
  /** How many of a watched thread's messages sit before the window loaded into memory. */
  private readonly hidden = new Map<string, number>()
  /**
   * Per thread a pane is looking at, what the store said when asked whether it holds a message an activity
   * record names above the window. Only the asked IDs are kept, so each costs one indexed lookup however
   * often the thread is published. The answers go with a reset, a failed write, a store switch or the pane.
   */
  private readonly storedAnchors = new Map<string, { readonly answers: Map<string, boolean>; generation: number }>()
  /** Stamps each change to those answers, so a view worked out against older ones is never reused. */
  private anchorGeneration = 0
  /** The message IDs of a loaded window, worked out once per loaded array. */
  private readonly loadedIds = new WeakMap<readonly AgentMessage[], ReadonlySet<string>>()
  /** The last pane view worked out for an activity list, reused while nothing it depends on has moved. */
  private readonly paneViews = new WeakMap<readonly AgentActivity[], { readonly messages: readonly AgentMessage[]; readonly hidden: number;
    readonly watched: boolean; readonly status: AgentThread['status']; readonly generation: number; readonly records: readonly AgentActivity[] }>()
  /** True when the provider host says what changed rather than publishing a whole history to compare. */
  private readonly eventSourced: boolean
  /** Events waiting to be written: everything but trailing text appends at the next publish, those at the write window. */
  private readonly pendingEvents = new Map<string, ThreadEvent[]>()
  /** A failed privacy transition must not later promote these pending words to durable history. */
  private pendingEventsPrivate = false
  /** Turning history back on cannot cancel a durable redaction that has not finished. */
  private historyRedactionPending = false
  /** Failed batches stay ahead of later events; organization saves cannot acknowledge their warning. */
  private readonly failedEventThreads = new Set<string>()
  private readonly invalidEventThreads = new Set<string>()
  private historyRetryTimer: ReturnType<typeof setTimeout> | undefined
  private historyRetryDelay = 1_000
  /** The threads whose window and summary the next publish has to read again. */
  private readonly eventChanged = new Set<string>()

  private workingCopyDefault: (projectId: string) => 'independent' | 'shared' = () => 'shared'
  private branchNameWriter: ((threadId: string, prompt: string) => Promise<string | null>) | undefined
  private readonly namingBranches = new Set<string>()
  private readonly branchWrites = new Set<Promise<void>>()
  setWorkingCopyDefaults(resolver: (projectId: string) => 'independent' | 'shared'): void { this.workingCopyDefault = resolver }
  /** Names a new worktree's branch from its first prompt, asking that thread's own provider (ADR-0026). */
  setBranchNameWriter(writer: (threadId: string, prompt: string) => Promise<string | null>): void { this.branchNameWriter = writer }
  /** Whether something outside this host, a Tools terminal, still runs in the thread's folder. */
  private worktreeInUse: (threadId: string) => boolean = () => false
  setWorktreeInUse(inUse: (threadId: string) => boolean): void { this.worktreeInUse = inUse }
  /**
   * Gives the workspace its Git status source. Status is read with the worktree after a turn, with the
   * remote on a refresh, and for the threads a window is looking at on a timer while that window is in
   * front, once per fetch interval; an interval of zero leaves the timer with nothing to do. `autoPull` is the
   * Automatically pull setting, read at each remote read; absent, nothing is pulled on its own. `visible` is whether
   * a window shows at all: a re-read after a turn waits for one, and absent, one always does.
   */
  setGitStatus(source: GitStatusSource, options: { foreground?: () => boolean; visible?: () => boolean; pollIntervalMs: () => number; autoPull?: () => boolean; tickMs?: number }): void {
    this.gitStatus = source
    this.gitStatusOptions = { foreground: options.foreground ?? (() => true), visible: options.visible ?? (() => true), pollIntervalMs: options.pollIntervalMs, autoPull: options.autoPull ?? (() => false) }
    if (this.gitStatusTimer) clearInterval(this.gitStatusTimer)
    this.gitStatusTimer = setInterval(() => {
      if (this.refreshesOwed.size && this.gitStatusOptions.visible()) {
        const owed = [...this.refreshesOwed]
        this.refreshesOwed.clear()
        for (const threadId of owed) this.scheduleWorktreeRefresh(threadId)
      }
      void this.pollGitStatus()
    }, options.tickMs ?? GIT_STATUS_TICK_MS)
    this.gitStatusTimer.unref?.()
  }
  setGitActions(actions: GitActions): void { this.gitActions = actions }
  setGitPullRequests(pullRequests: GitPullRequests): void { this.gitPullRequests = pullRequests }
  /** The branches of the folder a thread works in, or would work in: a draft reads its project's folder, or the worktree it points at. */
  async listThreadRefs(request: GitRefsRequest): Promise<GitRefsPage> {
    await this.initialize()
    if (!this.gitStatus?.listRefs) throw new Error('Branches are unavailable on this host.')
    const folder = this.threadRepositoryFolder(request.threadId, 'branches')
    const options = { ...request } as Partial<GitRefsRequest>
    delete options.threadId
    return this.gitStatus.listRefs(folder, options)
  }
  /** The changed files of the folder a thread works in, for the commit dialog; a draft's folder answers too, as it does for branches. */
  async listThreadChangedFiles(request: GitChangedFilesRequest): Promise<GitChangedFiles> {
    await this.initialize()
    if (!this.gitStatus?.listChangedFiles) throw new Error('Changed files are unavailable on this host.')
    return this.gitStatus.listChangedFiles(this.threadRepositoryFolder(request.threadId, 'changed files'))
  }
  /** The folder a thread's repository reads come from: its ready worktree, the worktree a draft points at, or its project's folder. */
  private threadRepositoryFolder(threadId: string, what: string): string {
    const thread = this.thread(threadId)
    const project = this.state.snapshot.projects.find(item => item.id === thread.projectId)
    if (thread.worktree?.status === 'ready' && !thread.worktree.reclaimedAt) return resolveThreadWorkingDirectory(thread, project)
    if (thread.worktree?.existingWorktreePath && !thread.worktree.path) return thread.worktree.existingWorktreePath
    // A reclaimed worktree's folder is gone; the project folder is the same repository, so its branches are the answer.
    if (thread.worktree?.reclaimedAt && project?.path) return project.path
    if (thread.workingDirectory) return thread.workingDirectory
    if (project?.path) return project.path
    throw new Error(`This thread has no working folder to read ${what} from.`)
  }
  private gitActionsOrRefuse(): GitActions {
    if (!this.gitActions) throw new Error('Git actions are unavailable on this host.')
    return this.gitActions
  }
  /** An independent worktree's recorded root is also its identity before a missing folder is restored. */
  private threadCheckoutFolder(threadId: string): string {
    const thread = this.thread(threadId)
    return thread.worktree?.mode === 'independent' && thread.worktree.path
      ? thread.worktree.path : this.threadRepositoryFolder(threadId, 'Git')
  }
  private checkoutThreadHolder(threadId: string, kind: Extract<CheckoutHolder, { threadId: string }>['kind']): CheckoutHolder {
    const thread = this.thread(threadId)
    return { kind, threadId, title: thread.title }
  }
  setPendingThreadWork(pending: (threadId: string) => boolean, reason: (threadId: string) => CheckoutPendingWork | null = () => null): void {
    this.pendingThreadWork = pending
    this.pendingThreadWorkReason = reason
  }
  private checkoutWorkHolder(thread: AgentThread, purpose: 'mutation' | 'settle' = 'mutation'): CheckoutHolder | null {
    const kind = thread.requests.length ? 'waiting-answer'
      : thread.status === 'running' ? 'turn'
      : thread.historyStatus === 'loading' ? 'history-loading'
      : thread.historyStatus === 'error' && purpose !== 'settle' ? 'history-error'
      : this.preparations.has(thread.id) ? 'preparation'
      : this.pendingThreadWork(thread.id) ? this.pendingThreadWorkReason(thread.id) ?? 'pending-work' : null
    return kind ? this.checkoutThreadHolder(thread.id, kind) : null
  }
  async acquireCheckoutRead(threadId: string): Promise<() => void> {
    return this.checkoutMutations.acquire(this.threadCheckoutFolder(threadId), 'send', { kind: 'checkpoint' })
  }
  async acquireTerminalStart(folder: string): Promise<() => void> {
    return this.checkoutMutations.acquire(folder, 'send', { kind: 'terminal-start' })
  }
  async isCheckoutMutating(threadId: string): Promise<boolean> {
    return this.checkoutMutations.isMutating(this.threadCheckoutFolder(threadId))
  }
  /** Check active and queued work after reserving the checkout, before any asynchronous mutation checks. */
  async acquireCheckoutMutation(threadId: string, holder: CheckoutHolder = { kind: 'git-action' }): Promise<() => void> {
    await this.initialize()
    return this.acquireCheckoutMutationInFolder(threadId, this.threadCheckoutFolder(threadId), holder)
  }
  private async acquireCheckoutMutationInFolder(threadId: string, folder: string, holder: CheckoutHolder): Promise<() => void> {
    const own = this.thread(threadId)
    if (own.requests.length) throw checkoutMutationRefusal(this.checkoutThreadHolder(threadId, 'waiting-answer'))
    if (own.status === 'running') throw checkoutMutationRefusal(this.checkoutThreadHolder(threadId, 'turn'))
    const key = await checkoutIdentity(folder)
    const release = this.checkoutMutations.acquireIdentity(key, 'mutation', holder)
    try {
      const candidates = await threadsInCheckout(this.state.snapshot, threadId, thread => thread.id === threadId ? folder : this.threadCheckoutFolder(thread.id), key)
      // The requesting draft may have no folder yet, but its own queued work still holds the destination.
      for (const candidate of [own, ...candidates.filter(candidate => candidate.id !== threadId)]) {
        const thread = this.thread(candidate.id)
        const work = this.checkoutWorkHolder(thread)
        if (work) throw checkoutMutationRefusal(work)
      }
      return release
    } catch (error) { release(); throw error }
  }
  /** Keep main up to date's projects (ADR-0142): each with its folder and whether the user settled it. */
  mainCheckoutProjects(): readonly { readonly id: string; readonly path: string; readonly settled: boolean }[] {
    return this.state.snapshot.projects.filter(project => project.path).map(project => ({ id: project.id, path: project.path, settled: Boolean(project.workspaceSettledAt) }))
  }
  /**
   * Keep main up to date's reservation (ADR-0142): `work` runs under the mutation reservation of the checkout at `folder`
   * that sends, Git actions and automatic pulls share, once no thread whose working copy is that checkout is running, waiting
   * on an answer, loading its history, being set up, running a Git action or holding queued work. Null, having run nothing,
   * when anything holds it; Keep main up to date tries again later rather than wait here.
   */
  async withProjectCheckout<T>(folder: string, work: () => Promise<T>): Promise<T | null> {
    await this.initialize()
    let key: string
    try { key = await checkoutIdentity(folder) } catch { return null }
    let release: () => void
    try { release = this.checkoutMutations.acquireIdentity(key, 'mutation', { kind: 'automatic-pull' }) } catch { return null }
    try {
      for (const thread of this.state.snapshot.threads) {
        if (!this.checkoutWorkHolder(thread) && thread.gitAction?.status !== 'running') continue
        let identity: string
        try { identity = await checkoutIdentity(this.threadCheckoutFolder(thread.id)) } catch { continue }
        if (identity === key) return null
      }
      return await work()
    } finally { release() }
  }
  /**
   * Keep main up to date moved the checkout at `folder` (ADR-0142): each thread working in it, or in a folder inside it,
   * reads its Git status again, so its branch stops saying it is behind. Matched by path alone, so it costs no Git.
   */
  async projectCheckoutMoved(folder: string): Promise<void> {
    const key = (path: string): string => path.replace(/[\\/]+$/u, '').replace(/\\/gu, '/').toLowerCase()
    const root = key(folder)
    const reads: Promise<void>[] = []
    for (const thread of this.state.snapshot.threads) {
      const own = this.statusFolder(thread.id)
      if (own === undefined) continue
      const path = key(own)
      if (path === root || path.startsWith(`${root}/`)) reads.push(this.onLane(thread.id, () => this.readGitStatus(thread.id, true)).catch(() => undefined))
    }
    await Promise.all(reads)
  }
  private pullRequestMergedListener: ((url: string) => void) | undefined
  /** Told of each pull request a read finds merged, for Keep main up to date (ADR-0142); one listener, set by the runtime. */
  onPullRequestMerged(listener: (url: string) => void): void { this.pullRequestMergedListener = listener }
  private pullRequestMerged(url: string): void { try { this.pullRequestMergedListener?.(url) } catch { /* The listener's failure is its own. */ } }
  private onGitLane<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return this.onLane(threadId, () => this.withCheckoutMutation(threadId, operation))
  }
  private async withCheckoutMutation<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireCheckoutMutation(threadId)
    try { return await operation() } finally { release() }
  }
  setMutationGuard(guard: (threadId: string, destinationFolder?: string) => Promise<boolean> | boolean): void { this.mutationGuard = guard }
  /** The folder a Git command may act on now, or the reason it may not, in plain words. */
  private async gitActionFolder(threadId: string, destinationFolder?: string): Promise<string> {
    await this.initialize()
    const thread = this.thread(threadId)
    if (thread.status === 'running') throw new GitActionRefusal('Wait for the thread to finish its turn before changing Git.')
    if (thread.requests.length > 0) throw new GitActionRefusal('Answer the thread\'s waiting request before changing Git.')
    if (this.preparations.has(threadId)) throw new GitActionRefusal('Wait for the working copy to be set up before changing Git.')
    if (thread.gitAction?.status === 'running') throw new GitActionRefusal('Git action in progress.')
    if (this.mutationGuard && !await (destinationFolder === undefined ? this.mutationGuard(threadId) : this.mutationGuard(threadId, destinationFolder))) throw new GitActionRefusal('Wait for active or pending thread work before changing Git.')
    return destinationFolder ?? this.threadWorkingDirectory(threadId)
  }
  private setGitActionProgress(threadId: string, progress: GitActionProgress): void {
    const thread = this.threadById(threadId)
    if (!thread) return
    this.touched(thread).gitAction = progress
    this.dirty = true
    this.publishSoon()
  }
  /**
   * T3's stacked action, run on the thread's lane so nothing is sent to the thread while its folder
   * changes. Admission refusals preserve the previous result. Once admitted, progress and the
   * result stay on the thread record, and the folder's status is read again with the remote afterward.
   */
  runGitAction(command: { threadId: string; actionId: string; action: GitStackedAction; commitMessage?: string | undefined; featureBranch?: boolean | undefined; filePaths?: readonly string[] | undefined; allowDefaultBranch?: boolean | undefined }): Promise<AgentHostSnapshot> {
    return this.thenReadRemoteStatus(command.threadId, this.onLane(command.threadId, async () => {
      await this.initialize()
      this.thread(command.threadId)
      const release = await this.acquireCheckoutMutation(command.threadId)
      const startedAt = new Date().toISOString()
      let progress: GitActionProgress = { actionId: command.actionId, action: command.action, status: 'running', phases: [], phase: null, stage: null, hook: null, startedAt, finishedAt: null, result: null, error: null }
      const update = (change: Partial<GitActionProgress>): void => { progress = { ...progress, ...change }; this.setGitActionProgress(command.threadId, progress) }
      const onProgress = (event: GitActionEvent): void => {
        if (event.kind === 'action_started') update({ phases: [...event.phases], stage: event.stages[0] ?? null })
        else if (event.kind === 'phase_started') update({ phase: event.phase, stage: event.stage, hook: null })
        else if (event.kind === 'hook_started') update({ hook: { name: event.hookName, output: null } })
        else if (event.kind === 'hook_output') update({ hook: { name: event.hookName ?? progress.hook?.name ?? 'hook', output: event.text } })
        else if (event.kind === 'hook_finished') update({ hook: null })
      }
      let started = false
      try {
        try {
          const actions = this.gitActionsOrRefuse()
          const cwd = await this.threadWorkingDirectory(command.threadId)
          if (this.mutationGuard && !await this.mutationGuard(command.threadId)) throw new GitActionRefusal('Wait for active or pending thread work before changing Git.')
          started = true
          update({})
          const result = await actions.runStackedAction({ threadId: command.threadId, cwd, action: command.action, commitMessage: command.commitMessage, featureBranch: command.featureBranch, filePaths: command.filePaths, allowDefaultBranch: command.allowDefaultBranch, onProgress })
          update({ status: 'done', phase: null, stage: null, hook: null, finishedAt: new Date().toISOString(), result })
          // The pull request the action created, or the open one it found, is linked to the thread the way T3 links it.
          if ((result.pr.status === 'created' || result.pr.status === 'opened_existing') && result.pr.url && result.pr.number) {
            this.linkPullRequestRecord(command.threadId, { number: result.pr.number, url: result.pr.url, title: result.pr.title ?? `Pull request #${result.pr.number}`, state: 'open', draft: false }, 'created')
          }
        } catch (error) {
          if (!started) throw error
          update({ status: 'failed', phase: null, stage: null, hook: null, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'The Git action failed.' })
        }
        try { await this.flush() } catch { this.saveError = GIT_ACTION_SAVE_ERROR }
        await this.followGitChange(command.threadId)
      } finally { release() }
    }), () => this.workspaceSnapshot())
  }
  /**
   * A change made in the thread's lane, then the remote half of the folder's status once the change has left the
   * lane: the fetch and the GitHub lookup outside it, and the read that takes what they brought back in it
   * (`readRemoteStatus`). A send queued behind the change waits for the change and its local read, never for the
   * fetch (issue #766). The caller's answer is built after all of it, so it carries the new status.
   */
  private async thenReadRemoteStatus<R, T>(threadId: string, change: Promise<R>, answer: (result: R) => T): Promise<T> {
    const result = await change
    await this.readRemoteStatus(threadId)
    this.publish()
    return answer(result)
  }
  /**
   * A commit, push, switch or pull moved the folder: the caches are dropped, and the worktree record and its local
   * status follow at once, in the lane that moved it. The remote half follows once the lane is free.
   */
  private async followGitChange(threadId: string, options: { readonly followSentBranch?: boolean } = {}): Promise<void> {
    this.invalidateGitStatus(threadId)
    const worktree = this.threadById(threadId)?.worktree
    if (worktree?.status === 'ready' && worktree.path) {
      try {
        const inspected = await this.worktrees.inspect(worktree)
        const current = this.threadById(threadId)
        if (current?.worktree === worktree) {
          // A switch made here is the user's own: the sent branch moves with it in the same publish, so the
          // branch notice never shows for it and stays for a checkout someone else moved (ADR-0014).
          const sentBranch = worktree.sentBranch === undefined ? undefined : options.followSentBranch && inspected.branch ? inspected.branch : worktree.sentBranch
          // The status it had stays on the record until the read below replaces it, so the controls never blank between the two.
          this.touched(current).worktree = { ...inspected, ...(worktree.git ? { git: worktree.git } : {}), ...(sentBranch !== undefined ? { sentBranch } : {}) }
          this.dirty = true
          if (sentBranch !== worktree.sentBranch) await this.flush().catch(() => undefined)
        }
      } catch { /* The next send reports a folder that stopped being the thread's. */ }
    }
    await this.readGitStatus(threadId, false)
    this.publish()
  }
  pullThreadBranch(threadId: string): Promise<{ snapshot: AgentHostSnapshot; result: GitPullResult }> {
    return this.thenReadRemoteStatus(threadId, this.onGitLane(threadId, async () => {
      const result = await this.gitActionsOrRefuse().pull(await this.gitActionFolder(threadId))
      await this.followGitChange(threadId)
      return result
    }), result => ({ snapshot: this.workspaceSnapshot(), result }))
  }
  /** T3's switch: Git refuses when work would be lost, and the thread follows whatever branch the folder ends up on (ADR-0014). */
  switchThreadBranch(threadId: string, ref: string, create: boolean): Promise<AgentHostSnapshot> {
    return this.thenReadRemoteStatus(threadId, this.onGitLane(threadId, async () => {
      await this.gitActionsOrRefuse().switchBranch(await this.gitActionFolder(threadId), ref, { create })
      await this.followGitChange(threadId, { followSentBranch: true })
    }), () => this.workspaceSnapshot())
  }
  initThreadRepository(threadId: string): Promise<AgentHostSnapshot> {
    return this.thenReadRemoteStatus(threadId, this.onGitLane(threadId, async () => {
      await this.gitActionsOrRefuse().init(await this.gitActionFolder(threadId))
      // A folder that just became a repository is discovered again so its record says so; the record itself stays,
      // with what the thread already chose on it, since a draft is not discovered afresh.
      const thread = this.thread(threadId)
      const project = this.state.snapshot.projects.find(item => item.id === thread.projectId)
      const directory = thread.workingDirectory ?? project?.path
      if (thread.worktree?.mode === 'shared' && directory) {
        try { thread.worktree = { ...thread.worktree, ...await this.worktrees.discover(directory, project?.path ?? directory) }; this.touch(threadId); this.dirty = true } catch { /* The refresh below reads what it can. */ }
      } else if (!thread.worktree) await this.discoverWorkingCopy(threadId).catch(() => undefined)
      await this.followGitChange(threadId)
    }), () => this.workspaceSnapshot())
  }
  publishThreadRepository(threadId: string, options: { repository: string; visibility: 'private' | 'public' }): Promise<{ snapshot: AgentHostSnapshot; url: string }> {
    return this.thenReadRemoteStatus(threadId, this.onGitLane(threadId, async () => {
      const { url } = await this.gitActionsOrRefuse().publish(await this.gitActionFolder(threadId), options)
      await this.followGitChange(threadId)
      return url
    }), url => ({ snapshot: this.workspaceSnapshot(), url }))
  }
  /** Bringing changes back (#1030), on only where Work across machines is on, read once at start. */
  private bringBackAllowed = false
  allowBringBack(): void { this.bringBackAllowed = true }
  /**
   * How a check installs packages first, present only while Work across machines is on (#1312, ADR-0072): main turns it on
   * once, at start. Absent, a check's new worktree is made as any new worktree is.
   */
  private checkInstaller: PackageInstaller | undefined
  allowCheckWorktrees(install: PackageInstaller = npmCi): void { this.checkInstaller = install }
  /**
   * The merge-commit question each thread holds, by the press that asked it and the two tips it named. A question about a
   * child on another machine is held by the thread the commits go to, under that child's name too. Never saved.
   */
  private readonly bringBackQuestions = new Map<string, { readonly actionId: string; readonly targetHead: string; readonly branchHead: string }>()
  /**
   * Bring changes to <branch> (#1030): this thread's commits go to the branch of the thread it began from, which its new
   * worktree was made from. Run on this thread's lane and its checkout, with the folder that has the target checked out
   * held too, so no send, turn or Git action changes either meanwhile. The outcome, or the merge-commit question, goes on
   * this thread's record; nothing is saved. Git runs only here, on the user's press, never on the update path. Nothing in
   * it touches a remote, so no fetch follows: the folders' local status is read again, and the press answers with it.
   * With `away`, the desktop already moved a child's branch here from another machine, and `threadId` names the thread
   * the commits go to (`bringChangesArrived`).
   */
  async bringChangesBack(command: { readonly threadId: string; readonly actionId: string; readonly mergeCommit?: string | undefined; readonly away?: BringBackAway | undefined }): Promise<AgentHostSnapshot> {
    if (command.away) return this.bringChangesArrived({ ...command, away: command.away })
    await this.onGitLane(command.threadId, async () => {
      if (!this.bringBackAllowed) throw new GitActionRefusal(BRING_BACK_OFF)
      const thread = this.thread(command.threadId)
      // A child of a thread on another machine moves its branch there first, which only the desktop does.
      if (thread.worktree?.madeFrom?.host !== undefined) throw new GitActionRefusal(BRING_BACK_FROM_DESKTOP)
      const found = bringBackTarget(thread, this.state.snapshot.threads)
      if (!found) throw new GitActionRefusal(BRING_BACK_NO_TARGET)
      const question = this.bringBackQuestions.get(thread.id)
      if (command.mergeCommit !== undefined && question?.actionId !== command.mergeCommit) throw new GitActionRefusal(BRING_BACK_QUESTION_GONE)
      const actions = this.gitActionsOrRefuse()
      const cwd = await this.gitActionFolder(thread.id)
      const project = this.state.snapshot.projects.find(item => item.id === thread.projectId)
      const parent = this.thread(found.parentId)
      const parentFolder = resolveThreadWorkingDirectory(parent, this.state.snapshot.projects.find(item => item.id === parent.projectId))
      const at = new Date().toISOString()
      const base = { actionId: command.actionId, target: found.target, branch: found.branch, at }
      let record: BringBack
      let checkout: string | null
      try {
        const outcome = await actions.bringBack({ cwd, target: found.target,
          ...(command.mergeCommit !== undefined && question ? { mergeCommit: { targetHead: question.targetHead, branchHead: question.branchHead } } : {}),
          parentCheckout: folder => sameCheckout(folder, parentFolder),
          holdCheckout: async folder => {
            // Every thread that works where the target is checked out, the one it began from first, must be at rest.
            const release = await this.acquireCheckoutMutationInFolder(thread.id, folder, { kind: 'git-action' })
            try {
              if (this.mutationGuard && !await this.mutationGuard(thread.id, folder)) throw new GitActionRefusal(`Wait for the work where ${found.target} is checked out to finish, then try again. Nothing changed.`)
              return release
            } catch (error) { release(); throw error }
          } })
        checkout = outcome.checkout
        record = { ...base, branch: outcome.branch, ...this.bringBackRecord(outcome, await this.checkoutPlace(outcome.checkout, project?.path)) }
        if (outcome.kind === 'asks') this.bringBackQuestions.set(thread.id, { actionId: command.actionId, targetHead: outcome.targetHead, branchHead: outcome.branchHead })
        else this.bringBackQuestions.delete(thread.id)
      } catch (error) {
        this.bringBackQuestions.delete(thread.id)
        checkout = error instanceof BringBackRefusal ? error.detail.checkout ?? null : null
        record = await this.bringBackRefused(base, error, project?.path)
      }
      this.touched(this.thread(command.threadId)).bringBack = record
      this.dirty = true
      await this.followGitChange(command.threadId)
      // The thread it began from, and every thread in the folder that has the target checked out, read their folders again.
      if (record.status === 'done' && record.how !== 'nothing') this.followBroughtChanges(found.parentId, checkout)
    })
    return this.workspaceSnapshot()
  }
  /**
   * The second half of bringing changes back from a child on another machine (#1030): the desktop moved the child's
   * branch into this project's incoming ref for `away.moveId`, and the commits now go to the branch of `threadId`, the
   * thread the child began from, the same way as for a child on this machine. Run on that thread's lane, in its folder,
   * which must still be on `away.target`. The question or outcome goes on that thread's `broughtBack`, naming the child as
   * the desktop does; the incoming ref goes once the press is over, whatever it did.
   */
  private async bringChangesArrived(command: { readonly threadId: string; readonly actionId: string; readonly mergeCommit?: string | undefined; readonly away: BringBackAway }): Promise<AgentHostSnapshot> {
    const { away } = command
    // The desktop landed the branch before asking, so its incoming ref is found first and goes whatever happens next,
    // a refusal to take the checkout included: no press, and no retry of one, leaves a ref behind.
    await this.initialize()
    const named = this.state.snapshot.threads.find(item => item.id === command.threadId)
    const repository = named ? this.state.snapshot.projects.find(item => item.id === named.projectId)?.path : undefined
    const arrived = repository ? await movedBranchRef(repository, away.moveId).then(ref => ({ repository, ref }), () => undefined) : undefined
    try {
      await this.onGitLane(command.threadId, async () => {
        if (!this.bringBackAllowed) throw new GitActionRefusal(BRING_BACK_OFF)
        const parent = this.thread(command.threadId)
        if (!repository) throw new GitActionRefusal(BRING_BACK_NO_TARGET)
        if (!arrived) throw new GitActionRefusal('The branch didn’t arrive here, so nothing was brought back. Try again. Nothing changed.')
        const project = { path: repository }
        const branch = incomingRefBranch(arrived.ref)
        if (!branch) throw new GitActionRefusal('The branch didn’t arrive here, so nothing was brought back. Try again. Nothing changed.')
        const key = `${parent.id}\0${away.from}`
        const question = this.bringBackQuestions.get(key)
        if (command.mergeCommit !== undefined && question?.actionId !== command.mergeCommit) throw new GitActionRefusal(BRING_BACK_QUESTION_GONE)
        const actions = this.gitActionsOrRefuse()
        const cwd = await this.gitActionFolder(parent.id)
        const base = { actionId: command.actionId, target: away.target, branch, from: away.from, at: new Date().toISOString() }
        let record: BringBack
        let checkout: string | null
        try {
          // This thread's own folder holds the target and is held already, on its lane.
          const outcome = await actions.bringBack({ cwd, target: away.target, arrived: { ref: arrived.ref, branch },
            ...(command.mergeCommit !== undefined && question ? { mergeCommit: { targetHead: question.targetHead, branchHead: question.branchHead } } : {}),
            parentCheckout: folder => sameCheckout(folder, cwd) })
          checkout = outcome.checkout
          record = { ...base, ...this.bringBackRecord(outcome, await this.checkoutPlace(outcome.checkout, project.path)) }
          if (outcome.kind === 'asks') this.bringBackQuestions.set(key, { actionId: command.actionId, targetHead: outcome.targetHead, branchHead: outcome.branchHead })
          else this.bringBackQuestions.delete(key)
        } catch (error) {
          this.bringBackQuestions.delete(key)
          checkout = error instanceof BringBackRefusal ? error.detail.checkout ?? null : null
          record = await this.bringBackRefused(base, error, project.path)
        }
        this.touched(this.thread(parent.id)).broughtBack = record
        this.dirty = true
        await this.followGitChange(parent.id)
        if (record.status === 'done' && record.how !== 'nothing') this.followBroughtChanges(parent.id, checkout)
      })
    } finally {
      // The child's branch is in the target now, or was not wanted: no ref keeps its commits here (ADR-0082 decision 3).
      if (arrived) await runWorktreeGit(arrived.repository, ['update-ref', '-d', '--no-deref', arrived.ref]).catch(() => undefined)
    }
    return this.workspaceSnapshot()
  }
  /** A refusal's record: why, how many files, Git's own words, where the target is, and Sotto's sentence where it has no plainer one. */
  private async bringBackRefused(base: Pick<BringBack, 'actionId' | 'target' | 'branch' | 'at'> & { readonly from?: string }, error: unknown, projectPath: string | undefined): Promise<BringBack> {
    const refusal = error instanceof BringBackRefusal ? error : undefined
    return { ...base, status: 'refused', refusal: refusal?.reason ?? 'git',
      ...(refusal?.detail.files !== undefined ? { files: refusal.detail.files } : {}),
      ...(refusal?.detail.gitSaid ? { gitSaid: refusal.detail.gitSaid } : {}),
      ...(refusal?.detail.checkout !== undefined ? { checkedOut: await this.checkoutPlace(refusal.detail.checkout, projectPath) } : {}),
      ...(!refusal || refusal.reason === 'busy' || refusal.reason === 'git' || refusal.reason === 'ignored' ? { message: (error instanceof Error ? error.message : 'Git did not answer.').slice(0, 1_000) } : {}) }
  }
  private bringBackRecord(outcome: BringBackOutcome, checkedOut: NonNullable<BringBack['checkedOut']>): Omit<BringBack, 'actionId' | 'target' | 'branch' | 'at'> {
    switch (outcome.kind) {
      case 'nothing': return { status: 'done', how: 'nothing', commits: 0, checkedOut }
      case 'asks': return { status: 'asks', commits: outcome.commits, targetCommits: outcome.targetCommits, checkedOut }
      case 'fast-forward': return { status: 'done', how: 'fast-forward', commits: outcome.commits, head: outcome.head, checkedOut }
      case 'merge-commit': return { status: 'done', how: 'merge-commit', commits: outcome.commits, targetCommits: outcome.targetCommits, head: outcome.head, subject: outcome.subject, checkedOut }
    }
  }
  /** Where a folder Git named sits for the user: the project folder, another worktree, or none at all. */
  private async checkoutPlace(folder: string | null, projectPath: string | undefined): Promise<NonNullable<BringBack['checkedOut']>> {
    if (folder === null) return 'none'
    if (!projectPath) return 'worktree'
    try { return await checkoutIdentity(folder) === await checkoutIdentity(projectPath) ? 'project' : 'worktree' } catch { return 'worktree' }
  }
  /**
   * After a bring-back moved a branch: the parent thread, and every thread working where it is checked out, read again.
   * One pass over the threads finds them all, with the projects looked up by ID, so the work grows with the threads and
   * not with their square; the folder's status is let go once, and each thread then reads it on its own lane.
   */
  private followBroughtChanges(parentId: string, checkout: string | null): void {
    const projects = new Map(this.state.snapshot.projects.map(project => [project.id, project]))
    const ids: string[] = []
    for (const thread of this.state.snapshot.threads) {
      if (thread.id === parentId) { ids.push(thread.id); continue }
      if (checkout === null) continue
      try { if (sameFolder(resolveThreadWorkingDirectory(thread, projects.get(thread.projectId)), checkout)) ids.push(thread.id) } catch { /* A thread with no folder reads nothing. */ }
    }
    if (checkout !== null) this.gitStatus?.invalidate(checkout)
    for (const id of ids) void this.onLane(id, () => this.followGitChange(id)).catch(() => undefined)
  }
  private pullRequestsOrRefuse(): GitPullRequests {
    if (!this.gitPullRequests) throw new Error('Pull requests are unavailable on this host.')
    return this.gitPullRequests
  }
  /** Whether the thread knows this pull request: its branch's own, or one linked to it. Only those are acted on. */
  private knowsPullRequest(thread: AgentThread, url: string): boolean {
    const key = pullRequestKey(url)
    if (!key) return false
    const branch = branchPullRequestUrl(thread)
    return (branch !== undefined && pullRequestKey(branch) === key) || (thread.pullRequests ?? []).some(link => pullRequestKey(link.url) === key)
  }
  /**
   * Adds a pull request to the thread's links, or brings a link it has up to date with what GitHub said. A link
   * keeps how it was first made. The oldest goes when the list is full. Callers hold the thread's lane, or run
   * where nothing else changes the record; the caller saves.
   */
  private linkPullRequestRecord(threadId: string, pullRequest: Pick<GitPullRequestLink, 'number' | 'url' | 'title' | 'state' | 'draft'>, source: GitPullRequestLinkSource): GitPullRequestLink | null {
    const thread = this.threadById(threadId)
    const key = pullRequestKey(pullRequest.url)
    if (!thread || !key || !pullRequestAddress(pullRequest.url)) return null
    const links = [...(thread.pullRequests ?? [])]
    const index = links.findIndex(link => pullRequestKey(link.url) === key)
    const snapshot = { number: pullRequest.number, url: pullRequest.url, title: pullRequest.title.slice(0, 500), state: pullRequest.state, draft: pullRequest.draft }
    let link: GitPullRequestLink
    if (index >= 0) {
      const existing = links[index]!
      link = { ...existing, ...snapshot }
      if (isDeepStrictEqual(existing, link)) return existing
      links[index] = link
    } else {
      link = { ...snapshot, source, linkedAt: new Date().toISOString() }
      links.push(link)
      while (links.length > GIT_PULL_REQUEST_LINKS_MAX) links.shift()
    }
    this.touched(thread).pullRequests = links
    this.dirty = true
    this.publishSoon()
    return link
  }
  /**
   * Brings a link a thread has up to date with the state GitHub just gave Sotto through a read of its own, as the branch's
   * Git read or babysitting makes (#1147). Otherwise a link keeps the state it had when the user last opened it, and lists
   * a pull request merged long ago as open. Merged is final, so no read moves a merged link. Callers hold the thread's lane.
   */
  private followPullRequestState(threadId: string, url: string, state: GitPullRequestLink['state']): boolean {
    const link = this.threadById(threadId)?.pullRequests?.find(item => pullRequestKey(item.url) === pullRequestKey(url))
    if (!link || link.state === state || link.state === 'merged') return false
    return this.linkPullRequestRecord(threadId, { ...link, state }, link.source) !== null
  }
  /** A pull request read Sotto made outside a thread's own Pull request surface, such as babysitting's (#1147). */
  notePullRequestState(read: PullRequestObservation): void {
    if (read.availability !== 'available' || read.state === undefined || this.stopping) return
    const key = pullRequestKey(read.url), state = read.state
    for (const thread of this.state.snapshot.threads) {
      const link = thread.pullRequests?.find(item => pullRequestKey(item.url) === key)
      if (!link || link.state === state || link.state === 'merged') continue
      void this.onLane(thread.id, async () => { if (this.followPullRequestState(thread.id, read.url, state)) await this.saveLinks() }).catch(() => undefined)
    }
  }
  private async saveLinks(): Promise<void> {
    try { await this.flush() } catch { this.saveError = 'The pull request link could not be saved. It shows until Sotto restarts.' }
  }
  /**
   * One pull request of the thread's, read through gh: the one named, else its branch's own, else the one
   * linked last. A draft reads through its project's folder, as it does for branches. A linked pull request's
   * title and state on the record follow what GitHub just said. A read GitHub's rate limit held back answers when it may
   * be asked again, for the surface to say (#820).
   */
  async readThreadPullRequest(request: GitPullRequestRequest): Promise<GitPullRequestRead> {
    await this.initialize()
    const service = this.pullRequestsOrRefuse()
    const thread = this.thread(request.threadId)
    const reference = request.reference ?? branchPullRequestUrl(thread) ?? thread.pullRequests?.at(-1)?.url
    if (!reference) return null
    let view: GitPullRequestView
    try { view = await service.view(this.threadRepositoryFolder(request.threadId, 'pull requests'), reference) }
    catch (error) {
      if (this.watcherPrObserver && typeof reference === 'string' && pullRequestKey(reference)) this.watcherPrObserver({ url: reference, head: null,
        observedAt: new Date().toISOString(), availability: 'unavailable', reason: error instanceof GitPullRequestLimited ? 'rate-limited' : 'read-failed' })
      if (error instanceof GitPullRequestLimited) return { limited: { retryAt: new Date(error.retryAt).toISOString() } }; throw error }
    this.observePullRequest(view)
    const current = this.thread(request.threadId)
    const key = pullRequestKey(view.url)
    const link = current.pullRequests?.find(item => pullRequestKey(item.url) === key)
    if (link && (link.title !== view.title || link.state !== view.state || link.draft !== view.draft)) {
      void this.onLane(request.threadId, async () => { if (this.linkPullRequestRecord(request.threadId, view, link.source)) await this.saveLinks() }).catch(() => undefined)
    }
    const branch = branchPullRequestUrl(current)
    return this.detailOf(view, link?.source ?? null, branch !== undefined && pullRequestKey(branch) === key)
  }
  private detailOf(view: GitPullRequestView, linked: GitPullRequestLinkSource | null, branch: boolean): GitPullRequestDetail {
    return { ...view, linked, branch }
  }
  /** A press on the Pull request surface, for a pull request the thread knows. GitHub moved, so the badge and the Git action read it again. */
  runPullRequestAction(command: { threadId: string; url: string; action: GitPullRequestAction; method?: GitPullRequestMergeMethod | undefined }): Promise<{ snapshot: AgentHostSnapshot; notice: string }> {
    return this.thenReadRemoteStatus(command.threadId, this.onLane(command.threadId, async () => {
      await this.initialize()
      const service = this.pullRequestsOrRefuse()
      if (!this.knowsPullRequest(this.thread(command.threadId), command.url)) throw new GitPullRequestRefusal('Link this pull request to the thread before acting on it.')
      const after = await service.act(this.threadRepositoryFolder(command.threadId, 'pull requests'), command.url, command.action, command.method)
      const link = this.thread(command.threadId).pullRequests?.find(item => pullRequestKey(item.url) === pullRequestKey(command.url))
      if (after) this.observePullRequest(after)
      if (after && link) { this.linkPullRequestRecord(command.threadId, after, link.source); await this.saveLinks() }
      this.invalidateGitStatus(command.threadId)
    }), () => ({ snapshot: this.workspaceSnapshot(), notice: `${PULL_REQUEST_ACTION_DONE[command.action]}.` }))
  }
  /** Link pull request: a GitHub URL or `#42`, read through gh first so the link names a pull request that exists. */
  linkThreadPullRequest(threadId: string, reference: string): Promise<{ snapshot: AgentHostSnapshot; link: GitPullRequestLink }> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      const service = this.pullRequestsOrRefuse()
      if (!parsePullRequestReference(reference)) throw new GitPullRequestRefusal('Use a pull request URL, 123, or #123.')
      const view = await service.view(this.threadRepositoryFolder(threadId, 'pull requests'), reference)
      const link = this.linkPullRequestRecord(threadId, view, 'linked')
      if (!link) throw new GitPullRequestRefusal('Sotto links pull requests from GitHub only.')
      await this.saveLinks()
      this.publish()
      return { snapshot: this.workspaceSnapshot(), link }
    })
  }
  unlinkThreadPullRequest(threadId: string, url: string): Promise<AgentHostSnapshot> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      const thread = this.thread(threadId)
      const key = pullRequestKey(url)
      const links = (thread.pullRequests ?? []).filter(link => pullRequestKey(link.url) !== key)
      if (links.length !== (thread.pullRequests ?? []).length) {
        if (links.length) this.touched(thread).pullRequests = links; else delete this.touched(thread).pullRequests
        this.dirty = true
        await this.saveLinks()
        this.publish()
        // The link is gone whatever babysitting makes of it, so a babysitting that could not end is left to the next Unlink or Stop.
        await Promise.all([...this.unlinkListeners].map(listener => listener(threadId, url).catch(() => undefined)))
      }
      return this.workspaceSnapshot()
    })
  }
  /**
   * T3's Checkout pull request from the branch picker. Local runs `gh pr checkout` in the thread's folder, the
   * project's own checkout for a draft, and the thread follows the branch the folder lands on (ADR-0014).
   * Worktree is for a draft: the pull request's head becomes a branch, and the draft's new worktree checks that
   * branch out on first send, or the draft points at the worktree that already has it. Either way the pull
   * request is linked to the thread.
   */
  async checkoutThreadPullRequest(threadId: string, reference: string, mode: 'local' | 'worktree'): Promise<{ snapshot: AgentHostSnapshot; notice: string }> {
    const outcome = await this.onLane(threadId, async (): Promise<{ readonly notice: string } | { readonly checkedOut: number }> => {
      await this.initialize()
      const service = this.pullRequestsOrRefuse()
      if (!parsePullRequestReference(reference)) throw new GitPullRequestRefusal('Use a pull request URL, 123, or #123.')
      const thread = this.thread(threadId)
      const creation = this.creationOf(threadId)
      const draft = thread.nativeSessionStarted === false && creation?.phase === 'unstarted' && !(thread.worktree?.mode === 'independent' && thread.worktree.path)
      if (mode === 'worktree' && !draft) throw new GitPullRequestRefusal('This thread already has a working folder. Use Local, or start a new thread to check the pull request out in a worktree of its own.')
      const view = await service.view(this.threadRepositoryFolder(threadId, 'pull requests'), reference)
      if (mode === 'local') {
        const shared = draft && thread.worktree?.mode !== 'shared'
          ? await this.selectedWorkingCopy(thread.projectId, { workingCopy: 'shared' }) : undefined
        const release = await this.acquireCheckoutMutationInFolder(threadId, shared?.path ?? this.threadCheckoutFolder(threadId), { kind: 'git-action' })
        try {
          // Check the destination without exposing a new draft binding to concurrent saves.
          const cwd = await this.gitActionFolder(threadId, shared?.path)
          if (shared) {
            const current = this.thread(threadId)
            const previous = { worktree: current.worktree, workingDirectory: current.workingDirectory }
            this.touched(current).worktree = shared; current.workingDirectory = shared.path
            this.dirty = true
            try { await this.flush() } catch (error) {
              Object.assign(this.touched(this.thread(threadId)), previous)
              this.dirty = true
              try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
              throw error
            }
          }
          await service.checkoutLocal(cwd, view.url)
          this.linkPullRequestRecord(threadId, view, 'checkout')
          await this.followGitChange(threadId, { followSentBranch: true })
          await this.saveLinks()
          return { checkedOut: view.number }
        } finally { release() }
      }
      const prepared = await service.prepareWorktreeBranch(this.threadRepositoryFolder(threadId, 'pull requests'), view)
      const current = this.thread(threadId)
      current.worktree = prepared.worktreePath
        ? await this.selectedWorkingCopy(current.projectId, { workingCopy: 'independent', existingWorktreePath: prepared.worktreePath })
        : { mode: 'independent', status: 'pending', branch: prepared.branch, checkoutBranch: true }
      current.workingDirectory = undefined
      this.touch(threadId)
      this.linkPullRequestRecord(threadId, view, 'checkout')
      this.dirty = true
      await this.flush()
      this.publish()
      return { notice: prepared.worktreePath
        ? `PR #${view.number} is checked out in another worktree already. This thread will work there.`
        : `PR #${view.number} will be checked out on ${prepared.branch} in a new worktree when you send.` }
    })
    if ('notice' in outcome) return { snapshot: this.workspaceSnapshot(), notice: outcome.notice }
    // As after any Git action, the remote half of the status follows once the thread's lane is free; the notice names the branch it found.
    return this.thenReadRemoteStatus(threadId, Promise.resolve(outcome.checkedOut), number => {
      const after = this.threadById(threadId)?.worktree
      const branch = after?.git?.branch ?? after?.branch
      return { snapshot: this.workspaceSnapshot(), notice: `Checked out PR #${number}${branch ? ` on ${branch}` : ''}.` }
    })
  }
  /** A Git action changed this thread's folder: read it again, remote and all, without waiting for the timer. */
  gitActionFinished(threadId: string): Promise<void> {
    this.invalidateGitStatus(threadId)
    return this.readRemoteStatus(threadId)
  }
  /**
   * A Git or pull request action ran in the thread's folder: that repository's fetch timing and pull request answers
   * go stale, and every other repository keeps its own (#820). A thread with no folder to name stales every repository.
   */
  private invalidateGitStatus(threadId: string): void {
    this.gitChanges++
    const folder = this.statusFolder(threadId)
    if (folder === undefined) this.gitStatus?.invalidate()
    else this.gitStatus?.invalidate(folder)
  }
  private async pollGitStatus(): Promise<void> {
    if (this.gitStatusPolling || this.stopping || !this.gitStatus || !this.declared) return
    const interval = this.gitStatusOptions.pollIntervalMs()
    if (interval <= 0 || Date.now() - this.gitStatusPolledAt < interval || !this.gitStatusOptions.foreground()) return
    this.gitStatusPolling = true
    this.gitStatusPolledAt = Date.now()
    // Every watched thread at once, so the pull request lookups of one repository arrive together and share one
    // GitHub query (#820). Each thread's own reads still run in its lane, one after another.
    try { await Promise.all([...this.watched.keys()].map(threadId => this.readRemoteStatus(threadId, { background: true }))) }
    finally { this.gitStatusPolling = false }
  }
  /**
   * The folder's status with its remote half, for the timer, a refresh and after a Git action. The slow calls, a
   * `git fetch` and the GitHub lookup (`GitStatusSource.readRemote`), run outside the thread's lane, so a send never
   * waits for them (issue #766); they run in the folder, and a folder being removed holds them off and waits for them
   * (`reclaimThreadWorktree`). A local read in the lane comes first, so the remote calls ask about the branch the folder
   * is on now, even after a switch made outside Sotto; a local read in the lane then takes what they brought, and
   * decides an automatic pull. `background` is the timer's read, which GitHub may hold back (#820); every other is the
   * user's or a Git action's. Never rejects.
   */
  private readRemoteStatus(threadId: string, options: { readonly background?: boolean } = {}): Promise<void> {
    const read = (async () => {
      const source = this.gitStatus
      if (!source || this.statusFolder(threadId) === undefined || this.stopping) return
      if (source.readRemote) {
        // A Git action anywhere can land between the read and the remote half, which then has not been told the
        // folder; it is read once more and asked again rather than skipping the round.
        for (let attempt = 0; attempt < 2; attempt++) {
          await this.onLane(threadId, () => this.readGitStatus(threadId, false))
          const folder = this.statusFolder(threadId)
          if (folder === undefined || this.stopping) return
          if (await source.readRemote(folder, options)) break
        }
      }
      await this.onLane(threadId, () => this.readGitStatus(threadId, true))
    })().catch(() => undefined)
    this.remoteStatusReads.add(read)
    void read.finally(() => this.remoteStatusReads.delete(read))
    return read
  }
  /**
   * Reads the thread's folder, locally, and publishes only a status that changed. Callers hold the thread's lane, so
   * a read never lands inside a send, a switch or a folder being put back; it is short, since the remote half it
   * may follow ran outside the lane. `afterRemote` is a read taking what a fetch brought, which pulls a clean
   * default branch only behind its upstream when Automatically pull is on.
   */
  private async readGitStatus(threadId: string, afterRemote: boolean, options: { readonly startedAfter?: number } = {}): Promise<void> {
    if (!this.gitStatus || this.stopping) return
    const folder = this.statusFolder(threadId)
    if (folder === undefined) return
    let status: GitStatus
    // The read after a fetch is its own, so it never joins a read of the same folder begun before the fetch landed.
    // A trailing re-read takes any read of the folder begun since its timer fired (`refreshWorktreeRecord`).
    const share = afterRemote ? { fresh: true } : options.startedAfter !== undefined ? { startedAfter: options.startedAfter } : {}
    try { status = await this.gitStatus.read(folder, { remote: false, ...share }) } catch { return }
    if (afterRemote && this.mayAutoPull(status)) status = await this.autoPull(threadId, folder) ?? status
    const current = this.threadById(threadId)
    if (!current?.worktree || current.worktree.status !== 'ready' || this.stopping) return
    if (gitStatusFingerprint(current.worktree.git) === gitStatusFingerprint(status)) return
    if (status.pullRequest?.state === 'merged' && current.worktree.git?.pullRequest?.state !== 'merged') this.pullRequestMerged(status.pullRequest.url)
    this.touched(current).worktree = { ...current.worktree, git: status }
    // The branch's own pull request, as this read found it, brings the thread's link to it up to date (#1147).
    if (status.pullRequest) this.followPullRequestState(threadId, status.pullRequest.url, status.pullRequest.state)
    this.dirty = true
    try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
    this.publish()
  }
  /** The folder whose Git status the thread shows: a ready record's, not reclaimed, or none. */
  private statusFolder(threadId: string): string | undefined {
    const thread = this.threadById(threadId)
    if (!thread?.worktree || thread.worktree.status !== 'ready' || thread.worktree.reclaimedAt) return undefined
    try { return this.threadFolder(thread) } catch { return undefined }
  }
  /** The folder a thread works in, from its record and its project: `resolveThreadWorkingDirectory`, which throws for one it has not got. */
  private threadFolder(thread: AgentThread): string {
    return resolveThreadWorkingDirectory(thread, this.state.snapshot.projects.find(project => project.id === thread.projectId))
  }
  /** Automatically pull's condition, T3's: on, the default branch, clean, tracking an upstream, and only behind it. */
  private mayAutoPull(status: GitStatus): boolean {
    if (!this.gitActions || !status.isRepository || !status.isDefaultBranch || status.dirty || !status.upstream || status.ahead > 0 || status.behind <= 0) return false
    try { return this.gitStatusOptions.autoPull() } catch { return false }
  }
  /**
   * Fast-forwards the folder with the Pull action's own `git pull --ff-only`, while the caller holds the thread's
   * lane. A folder any thread is working in, waiting on, setting up or running a Git action in is left for the next
   * read, and a pull that fails changes nothing. The status read after the pull, or null when nothing was
   * pulled. The read that asked for the pull may have been shared with another thread's read of the same folder,
   * begun before something changed it, so the pull is decided again from a read of its own under the checkout guard.
   */
  private async autoPull(threadId: string, folder: string): Promise<GitStatus | null> {
    const projects = this.state.snapshot.projects
    const busy = this.state.snapshot.threads.some(thread => {
      if (thread.status !== 'running' && !thread.requests.length && !this.preparations.has(thread.id) && thread.gitAction?.status !== 'running') return false
      if (thread.id === threadId) return true
      try { return sameFolder(resolveThreadWorkingDirectory(thread, projects.find(project => project.id === thread.projectId)), folder) } catch { return false }
    })
    if (busy || !this.gitActions || !this.gitStatus) return null
    try {
      const release = await this.acquireCheckoutMutation(threadId, { kind: 'automatic-pull' })
      try {
        if (this.mutationGuard && !await this.mutationGuard(threadId)) return null
        if (!this.mayAutoPull(await this.gitStatus.read(folder, { remote: false, fresh: true }))) return null
        const result = await this.gitActions.pull(folder, { automatic: true })
        if (result.status !== 'pulled') return null
        return await this.gitStatus.read(folder, { remote: false, fresh: true })
      } finally { release() }
    } catch { return null }
  }
  /**
   * Removes this thread's own worktree folder because the user asked, or a rule the user turned on did
   * (ADR-0041). The thread keeps its record and its branch keeps its commits; the next send puts the
   * folder back. Refused while the thread is running, waiting on an answer, sharing the folder with
   * another thread, or has a terminal open in it. `withUncommittedChanges` is the user's answer to the
   * confirmation; a rule never gives it.
   */
  async previewThreadWorktreeReclaim(threadId: string): Promise<WorktreeReclaimPreview> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      const metadata = this.thread(threadId).worktree
      if (!metadata || metadata.mode !== 'independent' || metadata.reused) throw new Error('This thread has no worktree of its own to remove.')
      const facts = await this.worktrees.reclaimFacts(metadata)
      return { ...facts, ignored: [...facts.ignored], items: [...facts.items], repositories: [...facts.repositories], untracked: [...facts.untracked] }
    })
  }
  async reclaimThreadWorktree(threadId: string, options: { withUncommittedChanges?: boolean; automatic?: boolean; confirmedIgnored?: readonly string[]; confirmedItems?: readonly { path: string; fileCount: number }[]; confirmedRepositories?: WorktreeReclaimPreview['repositories']; expectedMergedTip?: string } = {}): Promise<AgentHostSnapshot> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      const thread = this.thread(threadId)
      const worktree = thread.worktree
      if (worktree?.mode !== 'independent' || !worktree.path || worktree.reused) throw new Error('This thread has no worktree of its own to remove.')
      if (worktree.reclaimedAt) return this.workspaceSnapshot()
      if (thread.status === 'running' || thread.requests.length || this.preparations.has(threadId)) throw new Error('This thread is still working. Wait for it to finish and answer its requests before removing its folder.')
      if (!await this.ownsCheckoutAlone(threadId)) throw new Error('Another thread works in this folder too, so it stays.')
      if (this.worktreeInUse(threadId)) throw new Error('A terminal is open in this folder. Close it before removing the folder.')
      const release = await this.checkoutMutations.acquire(this.threadCheckoutFolder(threadId), 'mutation', { kind: 'remove-folder' })
      // No remote status call starts in the folder from now, and one already running finishes before it is removed: on
      // Windows a folder another process works in cannot be deleted whole.
      const releaseStatus = this.gitStatus?.hold?.(worktree.path)
      try {
        await this.gitStatus?.idle?.(worktree.path)
        if (options.expectedMergedTip && (await runWorktreeGit(worktree.path!, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== options.expectedMergedTip) {
          throw new Error('This branch changed after its merged pull request was checked. Its folder stays.')
        }
        const reclaimed = await this.worktrees.reclaim(worktree, options)
        this.touched(this.thread(threadId)).worktree = reclaimed
        this.dirty = true
        try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
        this.publish()
        return this.workspaceSnapshot()
      } finally { releaseStatus?.(); release() }
    })
  }
  /** Whether this thread was cleared (ADR-0140): its ID is refused in every snapshot and event from now on. */
  isThreadCleared(threadId: string): boolean { return this.clearedIds.has(threadId) }
  /**
   * What holds a thread back from deletion that only the workspace can see (ADR-0140 decision 3): work it is doing, a
   * request waiting on the user, a working copy being prepared, or a Git action running. The coordinator asks the rest.
   */
  private deletionHold(thread: AgentThread): ThreadClearKeptReason | null {
    if (thread.requests.length) return 'waiting-on-you'
    if (thread.status === 'running' || thread.lastTurn?.status === 'running' || thread.compaction?.status === 'running'
      || thread.backgroundWork?.length || thread.monitoring?.length || thread.subagentSummary?.working
      || this.preparations.has(thread.id) || thread.gitAction?.status === 'running') return 'working'
    return null
  }
  /** A checkpoint step still running, or an interrupted revert, is an action whose result is unknown (ADR-0140 decision 3). */
  private async checkpointHold(threadId: string): Promise<ThreadClearKeptReason | null> {
    return await Promise.resolve(this.checkpointHooks?.isBlocked(threadId)).catch(() => true) ? 'queued' : null
  }
  /** The thread's own worktree folder, when it has one on the disk to remove: never a shared checkout or a reused folder. */
  private async ownWorktreeToRemove(thread: AgentThread): Promise<AgentWorktree | undefined> {
    const worktree = thread.worktree
    if (worktree?.mode !== 'independent' || !worktree.path || worktree.reused || worktree.reclaimedAt) return undefined
    return await stat(worktree.path).then(() => worktree, () => undefined)
  }
  /**
   * Why the thread's own worktree keeps the thread, read from the folder (ADR-0140 decision 3), with the facts read. A
   * folder another thread or a terminal uses, one with uncommitted changes, and one with a link out of it are always
   * kept; ignored files besides dependencies and nested work keep it only for a rule or Clear now (`automatic`), since
   * Delete thread… lists them for the user to tick.
   */
  private async worktreeDeletionHold(thread: AgentThread, worktree: AgentWorktree, automatic: boolean): Promise<{ reason: ThreadClearKeptReason | null; facts?: WorktreeReclaimPreview }> {
    if (!await this.ownsCheckoutAlone(thread.id) || this.worktreeInUse(thread.id)) return { reason: 'worktree-in-use' }
    let facts: WorktreeReclaimPreview
    try {
      const read = await this.worktrees.reclaimFacts(worktree)
      facts = { ...read, ignored: [...read.ignored], items: [...read.items], repositories: [...read.repositories], untracked: [...read.untracked] }
    } catch { return { reason: 'worktree-error' } }
    if (facts.dirty) return { reason: 'uncommitted', facts }
    if (facts.outsideLink || !facts.branch) return { reason: 'worktree-error', facts }
    if (automatic && (facts.ignored.length || facts.repositories.length)) return { reason: 'worktree-files', facts }
    return { reason: null, facts }
  }
  /**
   * What deleting this thread would do (ADR-0140), checked in its lane: why it is kept, or null, and the facts of its own
   * worktree folder when it has one to remove. `automatic` is Clear now's and the rule's question, which keeps a folder
   * holding ignored files or nested work rather than listing them.
   */
  async previewThreadDeletion(threadId: string, automatic = false): Promise<{ kept: ThreadClearKeptReason | null; worktree: WorktreeReclaimPreview | null }> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      const thread = this.threadById(threadId)
      if (!thread || !this.visible(thread)) return { kept: 'hidden' as const, worktree: null }
      const held = this.deletionHold(thread) ?? await this.checkpointHold(threadId)
      const worktree = await this.ownWorktreeToRemove(thread)
      if (!worktree) return { kept: held, worktree: null }
      const folder = await this.worktreeDeletionHold(thread, worktree, automatic)
      return { kept: held ?? folder.reason, worktree: folder.facts ?? null }
    })
  }
  /**
   * Deletes threads, finally (ADR-0140 decision 4). Each is checked again in its own lane, the coordinator's `hold`
   * first, and its own worktree folder is removed under ADR-0041's guards before anything else of it goes; one that
   * fails a check is kept and says why. Then all that passed go together: their IDs join the cleared list, their rows
   * leave `threads.sqlite` and `subagents.sqlite` in one transaction each, their records and creation records leave the
   * workspace, other threads lose their links to them, and each adapter forgets its alias. Branches, Usage's numbers and
   * the providers' own transcripts are kept. `worktree` carries Delete thread…'s ticked items, for one thread alone.
   */
  async deleteThreads(threadIds: readonly string[], options: { readonly automatic: boolean; readonly hold: (threadId: string) => ThreadClearKeptReason | null
    readonly worktree?: { confirmedIgnored?: readonly string[]; confirmedItems?: readonly { path: string; fileCount: number }[]; confirmedRepositories?: WorktreeReclaimPreview['repositories'] } }): Promise<{ deleted: string[]; kept: { threadId: string; reason: ThreadClearKeptReason; error?: string }[] }> {
    await this.initialize()
    // A store that did not open cannot erase a word, so nothing is deleted, not even a folder (ADR-0140 decision 4).
    if (this.storeUnavailable || this.subagentUnavailable) throw new Error('Sotto could not open its thread history, so it deleted nothing. Restart Sotto and try again.')
    const passed: string[] = []
    const kept: { threadId: string; reason: ThreadClearKeptReason; error?: string }[] = []
    for (const threadId of [...new Set(threadIds)]) {
      if (this.stopping) break
      if (this.clearedIds.has(threadId)) continue
      await this.onLane(threadId, async () => {
        const thread = this.threadById(threadId)
        if (!thread) return
        const reason = !this.visible(thread) ? 'hidden' : options.hold(threadId) ?? this.deletionHold(thread) ?? await this.checkpointHold(threadId)
        if (reason) { kept.push({ threadId, reason }); return }
        const worktree = await this.ownWorktreeToRemove(thread)
        if (worktree) {
          const folder = await this.worktreeDeletionHold(thread, worktree, options.automatic)
          if (folder.reason) { kept.push({ threadId, reason: folder.reason }); return }
          const release = await this.checkoutMutations.acquire(this.threadCheckoutFolder(threadId), 'mutation', { kind: 'remove-folder' })
          const releaseStatus = this.gitStatus?.hold?.(worktree.path!)
          try {
            await this.gitStatus?.idle?.(worktree.path!)
            // Asked once more with the folder held: a turn or a request that began meanwhile keeps the thread.
            const late = options.hold(threadId) ?? this.deletionHold(this.thread(threadId)) ?? await this.checkpointHold(threadId)
            if (late) { kept.push({ threadId, reason: late }); return }
            const reclaimed = await this.worktrees.reclaim(worktree, options.automatic ? { automatic: true }
              : { ...options.worktree?.confirmedIgnored ? { confirmedIgnored: options.worktree.confirmedIgnored } : {},
                ...options.worktree?.confirmedItems ? { confirmedItems: options.worktree.confirmedItems } : {},
                ...options.worktree?.confirmedRepositories ? { confirmedRepositories: options.worktree.confirmedRepositories } : {} })
            this.touched(this.thread(threadId)).worktree = reclaimed
            this.dirty = true
          } catch (error) {
            kept.push({ threadId, reason: 'worktree-error', ...error instanceof Error ? { error: error.message } : {} })
            return
          } finally { releaseStatus?.(); release() }
        }
        passed.push(threadId)
      })
    }
    // Whatever began in the moment between a thread's lane and this removal keeps it.
    const deleted = passed.filter(threadId => {
      const thread = this.threadById(threadId)
      const late = thread ? options.hold(threadId) ?? this.deletionHold(thread) : null
      if (late) kept.push({ threadId, reason: late })
      return thread !== undefined && !late
    })
    if (!deleted.length) {
      if (this.dirty) {
        try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
        this.publish()
      }
      return { deleted, kept }
    }
    const gone = new Set(deleted)
    // From here no snapshot or event can bring them back, even before the list is on the disk.
    // Each store erases in one transaction, the sub-agent lists first, so a failure loses at most those lists.
    try { this.subagentStore.forgetMany(deleted) }
    catch { throw new Error(`Sotto could not erase these threads' history, so it kept them. ${DELETION_FOLDERS_WORDS} Restore access to local storage and try again.`) }
    // From the forget on, nothing more of theirs is posted (`admitted`): what was posted before it commits ahead of it and
    // is taken out with the rest. What still waits is held, not dropped, until the forget is confirmed, so a failed one
    // keeps the threads whole, as it says. The removal is done only once the writer says it committed, waiting for the disk.
    for (const threadId of deleted) this.forgetting.add(threadId)
    try { await this.waited(this.commit({ kind: 'forget', threadIds: deleted })) }
    catch {
      // Kept: their held words go once the store takes them, and their records are saved again.
      // A history held for them while they were being cleared is compared now, and the answers behind it follow it.
      for (const threadId of deleted) { this.forgetting.delete(threadId); this.unsaved.add(threadId); this.recordOwed(threadId) }
      this.forgetEnded(deleted)
      throw new Error(`Sotto could not erase these threads' history, so it kept them, but their sub-agent lists are gone. ${DELETION_FOLDERS_WORDS} Restore access to local storage and try again.`)
    }
    for (const threadId of deleted) {
      this.clearedIds.add(threadId)
      this.forgetting.delete(threadId)
      this.pendingEvents.delete(threadId); this.inFlight.delete(threadId); this.failedEventThreads.delete(threadId); this.recordsFailed.delete(threadId); this.recordsOwed.delete(threadId); this.invalidEventThreads.delete(threadId); this.eventChanged.delete(threadId)
    }
    this.forgetEnded(deleted)
    this.state.snapshot.threads = this.state.snapshot.threads.flatMap(thread => {
      if (gone.has(thread.id)) return []
      const unlinked = unlinkedFrom(thread, gone)
      if (unlinked !== thread) this.touch(thread.id)
      return [unlinked]
    })
    // The next publication drops them, and the next save and release look at them as threads that went.
    for (const threadId of deleted) { this.markChanged(threadId); this.remerge.delete(threadId) }
    this.state.creations = this.state.creations.filter(item => !gone.has(item.threadId))
    this.state.clearedThreadIds = [...this.state.clearedThreadIds, ...deleted]
    for (const threadId of deleted) this.forgetThreadState(threadId)
    this.dirty = true
    try { await this.flush() } catch { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.' }
    // The cleared list already refuses each one; an adapter that cannot forget its alias leaves only that behind.
    for (const threadId of deleted) await this.inner.forgetThread?.(threadId).catch(() => { console.warn('thread-forget-alias-failed') })
    this.publish()
    return { deleted, kept }
  }
  /** Every record this host holds in memory for one deleted thread, beside its record. */
  private forgetThreadState(threadId: string): void {
    this.babysitRecords.delete(threadId); this.wakeUpRecords.delete(threadId); this.hiddenWakeUpRecords.delete(threadId); this.wakeUpAskRecords.delete(threadId)
    this.privateLegacyMessages.delete(threadId); this.storedActivity.delete(threadId); this.storedInputs.delete(threadId); this.heldForInput.delete(threadId); this.letReadGo(threadId)
    this.activityInputs.delete(threadId); this.known.delete(threadId); this.watched.delete(threadId); this.hidden.delete(threadId)
    this.storedAnchors.delete(threadId); this.inspectionsQueued.delete(threadId); this.fullCheckDue.delete(threadId)
    this.subagentSummaries.delete(threadId); this.subagentInputs.delete(threadId); this.subagentChanges.delete(threadId); this.subagentLiveSince.delete(threadId)
  }
  async workingCopyOptions(projectId: string): Promise<AgentWorkingCopyOptions> {
    await this.initialize()
    const project = this.state.snapshot.projects.find(item => item.id === projectId)
    if (!project) throw new Error('Choose an available project.')
    return this.worktrees.options(project.path)
  }
  private async selectedWorkingCopy(projectId: string, selection: AgentWorkingCopySelection & { readonly startFromMove?: string | undefined; readonly madeFrom?: WorktreeMadeFrom | undefined; readonly check?: true | undefined }): Promise<AgentWorktree> {
    const project = this.state.snapshot.projects.find(item => item.id === projectId)
    if (!project) throw new Error('Choose an available project.')
    // A check's new worktree is the machine's check worktree, moved to its commit as setup begins (#1312), while Work
    // across machines is on; a check that would work in the project folder or an existing worktree stays there.
    const check = selection.check && this.checkInstaller ? { check: {} } : {}
    if (selection.startFromMove) {
      return { mode: 'independent', status: 'pending', incomingRef: await movedBranchRef(project.path, selection.startFromMove), ...selection.madeFrom ? { madeFrom: selection.madeFrom } : {}, ...check }
    }
    if (selection.workingCopy === 'shared') return this.worktrees.inspect(await this.worktrees.allocate(project.path, 'shared'))
    // A draft pointed at a worktree that exists carries that worktree's branch, so the toolbar can name it.
    const existing = selection.existingWorktreePath
    const known = existing ? (await this.worktrees.options(project.path).catch(() => null))?.worktrees.find(item => sameFolder(item.path, existing)) : undefined
    return { mode: 'independent', status: 'pending', baseBranch: selection.baseBranch,
      startFromOrigin: selection.startFromOrigin, existingWorktreePath: existing, ...(known?.branch ? { branch: known.branch } : {}), ...existing ? {} : check }
  }
  /**
   * A check's working copy (#1312): the repository's check worktree on this machine, moved to the check's commit, with the
   * folder's checkout reservation, held from before it is read until the caller lets it go once the check's packages are
   * ready, so no send or Git action starts there meanwhile. Undefined when the check worktree is not taken, and the check
   * gets a worktree of its own as before (CHECK_WORKTREE_PREVIOUS_THREAD).
   */
  private async takeCheckWorktree(threadId: string, metadata: AgentWorktree): Promise<{ readonly worktree: AgentWorktree; readonly release: () => void } | undefined> {
    if (!this.checkInstaller || !metadata.check || metadata.reused || metadata.status !== 'pending') return undefined
    try {
      const taken = await this.worktrees.takeCheckWorktree(metadata, path => this.reserveCheckWorktree(threadId, path))
      if (!taken) console.info('check-worktree-held')
      return taken
    } catch { console.warn('check-worktree-not-taken'); return undefined }
  }
  /**
   * A check's packages, in whichever worktree it got (#1312), the check worktree or one of its own: `npm ci` first when
   * its `package-lock.json` differs from the one `node_modules` there was installed from. The thread reads as installing
   * meanwhile, and its first message waits, as it waits for any setup.
   */
  private async checkPackages(threadId: string, metadata: AgentWorktree, folder: string): Promise<AgentWorktree> {
    const install = this.checkInstaller
    if (!install || !metadata.check) return metadata
    const outcome = await preparePackages(folder, install, () => {
      const running = this.threadById(threadId)
      if (running) { this.touched(running).worktree = { ...metadata, status: 'pending', check: { install: 'running' } }; this.publish() }
    }).catch(() => 'failed' as const)
    return outcome === 'none' ? metadata : { ...metadata, check: outcome === 'installed' ? {} : { install: 'failed' } }
  }
  /**
   * The check worktree's checkout reservation (ADR-0027's checkout guard), taken as a Git action takes it: the mutation
   * reservation first, so no send or Git action starts there from now on, then every other thread whose checkout it is
   * must hold no work, active or pending. Undefined, holding nothing, when one does.
   */
  private async reserveCheckWorktree(threadId: string, path: string): Promise<(() => void) | undefined> {
    let key: string
    try { key = await checkoutIdentity(path) } catch { return undefined }
    let release: () => void
    try { release = this.checkoutMutations.acquireIdentity(key, 'mutation', this.checkoutThreadHolder(threadId, 'preparation')) } catch { return undefined }
    try {
      for (const thread of this.state.snapshot.threads) {
        if (thread.id === threadId || !this.checkoutWorkHolder(thread) && thread.gitAction?.status !== 'running') continue
        let identity: string
        try { identity = await checkoutIdentity(this.threadCheckoutFolder(thread.id)) } catch { continue }
        if (identity === key) { release(); return undefined }
      }
      return release
    } catch (error) { release(); throw error }
  }
  /** Keep a destination checkout present from its first inspection through publication of the new reference. */
  private async reserveWorkingCopySelection(projectId: string, selection: AgentWorkingCopySelection, holder: CheckoutHolder): Promise<(() => void) | undefined> {
    const project = this.state.snapshot.projects.find(item => item.id === projectId)
    if (!project) throw new Error('Choose an available project.')
    const folder = selection.workingCopy === 'shared' ? project.path : selection.existingWorktreePath
    return folder ? this.checkoutMutations.acquire(folder, 'read', holder) : undefined
  }
  configureThreadWorkingCopy(threadId: string, selection: AgentWorkingCopySelection): Promise<AgentHostSnapshot> {
    return this.onLane(threadId, () => this.withProfileRefusal(threadId, async () => {
      await this.initialize()
      if (await this.launchProfiles.profileFor(threadId)) throw new Error('Watcher’s working folder cannot be changed.')
      const thread = this.thread(threadId)
      const creation = this.creationOf(threadId)
      if (thread.nativeSessionStarted !== false || creation?.phase !== 'unstarted' || thread.worktree?.mode === 'independent' && thread.worktree.path) {
        throw new Error('This thread already has a working folder. Start a new thread to choose another one.')
      }
      const previous = { worktree: thread.worktree, workingDirectory: thread.workingDirectory }
      const release = await this.reserveWorkingCopySelection(thread.projectId, selection, { kind: 'preparation', threadId, title: thread.title })
      try {
        const worktree = await this.selectedWorkingCopy(thread.projectId, selection)
        const current = this.thread(threadId)
        this.touched(current).worktree = worktree
        current.workingDirectory = worktree.mode === 'shared' ? worktree.path : undefined
        this.dirty = true
        try { await this.flush() } catch (error) { Object.assign(this.touched(this.thread(threadId)), previous); throw error }
        // A folder chosen now is read now, locally, so the toolbar knows it is a repository without waiting for the timer.
        await this.readGitStatus(threadId, false)
        this.publish()
        return this.workspaceSnapshot()
      } finally { release?.() }
    }))
  }
  /** Folder ownership includes legacy sessions and project subdirectories, not just stored worktree paths. */
  private async exclusivelyOwnsCheckout(threadId: string): Promise<boolean> {
    const metadata = this.thread(threadId).worktree
    if (!metadata?.temporaryBranch) return false
    return this.ownsCheckoutAlone(threadId)
  }
  /** No other thread, by its own folder or its project's, works in this thread's checkout. */
  private async ownsCheckoutAlone(threadId: string): Promise<boolean> {
    const metadata = this.thread(threadId).worktree
    if (!metadata || metadata.reused || !metadata.path) return false
    return this.checkoutIsUnreferenced(metadata.path, threadId)
  }
  private async checkoutIsUnreferenced(folder: string, exceptThreadId?: string): Promise<boolean> {
    // Threads often share a project folder. Discover that exact path once for this
    // decision; the next rename/removal must revalidate every path from scratch.
    const identities = new Map<string, Promise<string>>()
    const identify = (path: string): Promise<string> => {
      let pending = identities.get(path)
      if (!pending) { pending = this.worktrees.checkoutIdentity(path); identities.set(path, pending) }
      return pending
    }
    try {
      const identity = await identify(folder)
      const others = this.state.snapshot.threads.filter(other => other.id !== exceptThreadId)
      for (const other of others) {
        if (other.worktree?.reclaimedAt) continue
        if (other.nativeSessionStarted === false && other.worktree?.mode === 'independent' && !other.worktree.path && !other.worktree.existingWorktreePath) continue
        const path = other.workingDirectory ?? other.worktree?.path ?? other.worktree?.existingWorktreePath
          ?? this.state.snapshot.projects.find(project => project.id === other.projectId)?.path
        if (!path) return false
        try {
          if (await identify(path) === identity) return false
        } catch (error) {
          // Resolve missing subfolders through their nearest available parent. Other failures leave ownership unproven.
          const cause = error instanceof Error ? error.cause : undefined
          if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'ENOENT') return false
          let parent = dirname(path)
          while (true) {
            try {
              if (await identify(parent) === identity) return false
              break
            } catch (parentError) {
              const parentCause = parentError instanceof Error ? parentError.cause : undefined
              if (!parentCause || typeof parentCause !== 'object' || !('code' in parentCause) || parentCause.code !== 'ENOENT') return false
              const next = dirname(parent)
              if (next === parent) break
              parent = next
            }
          }
        }
      }
      return true
    } catch { return false } // The owner’s unavailable folder makes exclusive ownership unprovable.
  }
  async renameTemporaryBranch(threadId: string, name: string): Promise<void> {
    return this.onLane(threadId, async () => {
      if (this.stopping || !await this.exclusivelyOwnsCheckout(threadId) || this.stopping) return
      const metadata = this.thread(threadId).worktree!
      const renamed = await this.worktrees.renameTemporaryBranch(metadata, name)
      this.touched(this.thread(threadId)).worktree = renamed
      this.dirty = true
      await this.flush()
      this.publish()
    })
  }
  private nameBranch(threadId: string, prompt: string): void {
    if (this.stopping || !this.branchNameWriter || this.namingBranches.has(threadId)) return
    this.namingBranches.add(threadId)
    const writer = this.branchNameWriter
    const pending = this.exclusivelyOwnsCheckout(threadId).then(exclusive => !this.stopping && exclusive && this.thread(threadId).worktree?.temporaryBranch ? writer(threadId, prompt) : null)
      .then(name => !this.stopping && name ? this.renameTemporaryBranch(threadId, name) : undefined).catch(() => undefined)
    this.branchWrites.add(pending)
    void pending.finally(() => this.branchWrites.delete(pending))
  }
  private async discoverWorkingCopy(threadId: string): Promise<void> {
    const thread = this.thread(threadId)
    if (thread.worktree || thread.nativeSessionStarted === false) return
    const project = this.state.snapshot.projects.find(item => item.id === thread.projectId)
    const directory = thread.workingDirectory ?? project?.path
    if (!directory) throw new Error('This thread’s working folder is unavailable.')
    const metadata = await this.worktrees.discover(directory, project?.path ?? directory)
    const current = this.thread(threadId)
    if (current.worktree) return
    this.touched(current).worktree = metadata
    this.dirty = true
    try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
    this.publish()
  }

  setCheckpointHooks(hooks: { privacyChanged?(): Promise<void>; beforeTurn(threadId: string): Promise<void>; isBlocked(threadId: string): boolean | Promise<boolean> }): void { this.checkpointHooks = hooks }
  rollbackCapability(threadId: string) { if (!this.threadVisible(threadId)) return { supported: false, reason: WATCHER_DISABLED }; return this.inner.rollbackCapability?.(threadId) ?? { supported: false, reason: 'This provider does not expose verified conversation rewind.' } }
  rollbackThread(threadId: string, removedUserMessages: number, expectedUserMessageIds: readonly string[]): Promise<AgentHostResult> {
    return this.onLane(threadId, async () => {
      await this.initialize()
      this.thread(threadId)
      if (!this.inner.rollbackThread) throw new Error('Native conversation rewind is unavailable.')
      const result = await this.withProfileRefusal(threadId, () => this.inner.rollbackThread!(threadId, removedUserMessages, expectedUserMessageIds))
      // A confirmed rewind takes its turns back, and the visuals drawn in them go with them (ADR-0056). An uncertain one
      // keeps them: a visual whose turn did go is left out of every window anyway, having no place to sit.
      if (result.accepted && !result.uncertain && removedUserMessages > 0) this.forgetVisuals(threadId, expectedUserMessageIds.slice(-removedUserMessages))
      return result
    })
  }
  /** Removes the visuals drawn in these turns, and shows the thread without them. */
  private forgetVisuals(threadId: string, userMessageIds: readonly string[]): void {
    if (this.storeUnavailable) return
    this.post({ kind: 'visuals-removed', threadId, userMessageIds }, outcome => {
      if (outcome.error !== undefined) { this.saveError = HISTORY_SAVE_ERROR; return }
      if (!outcome.removed) return
      this.eventChanged.add(threadId)
      this.publishSoon()
    })
  }
  /**
   * Keeps a visual an agent drew in this thread and shows it where the thread stood when the call arrived: under the
   * newest message the store holds, in the newest user message's turn (ADR-0056). Whatever the provider said before the
   * call is written first, so the visual lands after those words and before anything said after it. Nothing is shown
   * that was not kept; with Keep local history off the store is in memory, so the visual lasts this run alone.
   */
  async addVisual(threadId: string, input: VisualInput): Promise<VisualAddition> {
    if (!this.threadVisible(threadId)) return { added: false, reason: 'unknown-thread' }
    await this.initialize()
    if (!this.ready || this.stopping || this.threadById(threadId) === undefined) return { added: false, reason: 'unknown-thread' }
    // Whatever the provider said before the call is committed first; what it says while this waits comes after the visual.
    await this.settled(threadId, true)
    if (!this.ready || this.stopping) return { added: false, reason: 'unknown-thread' }
    if (!this.historyWritable() || this.failedEventThreads.has(threadId)) return { added: false, reason: 'history-unavailable' }
    let stored: StoredVisual
    try {
      const newest = this.threadStore.newestMessages(threadId)
      const visuals = this.threadStore.readVisuals(threadId)
      if (visuals.length >= VISUALS_PER_THREAD_MAX) return { added: false, reason: 'thread-limit' }
      if (visuals.filter(item => item.anchorUserMessageId === newest.userMessageId).length >= VISUALS_PER_TURN_MAX) return { added: false, reason: 'turn-limit' }
      stored = { visual: visualFromInput(randomUUID(), input), createdAt: new Date().toISOString(), anchorMessageId: newest.messageId, anchorUserMessageId: newest.userMessageId }
      // Nothing is shown that was not kept: the visual is drawn once the writer says it committed.
      await this.waited(this.commit({ kind: 'visual', threadId, stored }))
    } catch { return { added: false, reason: 'history-unavailable' } }
    const anchor = stored.anchorMessageId === null ? 'none' : this.threadStore.message(threadId, stored.anchorMessageId)?.role ?? 'none'
    this.eventChanged.add(threadId)
    this.publishSoon()
    return { added: true, visual: stored.visual, anchor }
  }
  /** Whether a thread may draw a visual: one this host holds, on a provider that can receive Sotto's tool servers. */
  admitsVisuals(threadId: string): boolean {
    const thread = this.threadById(threadId)
    return thread !== undefined && this.visible(thread) && threadTakesSottoTools(thread)
  }
  /**
   * Whether an agent in this thread is offered Sotto's pull request tools (ADR-0061 decision 2): a thread this host holds,
   * on any provider whose client took Sotto's servers: Muse where its client grants them (ADR-0079), and Devin from CLI
   * 3000.11.92 (ADR-0056). A thread whose client withheld them is babysat only from the Pull request surface (decision 11).
   */
  admitsBabysitting(threadId: string): boolean {
    const thread = this.threadById(threadId)
    return thread !== undefined && this.visible(thread) && threadTakesSottoTools(thread)
  }
  /** The thread's branch's own pull request as the host last read it, and its linked ones, by URL (ADR-0061 decision 5). */
  threadPullRequests(threadId: string): { branch: string | undefined; linked: string[] } {
    if (!this.threadVisible(threadId)) return { branch: undefined, linked: [] }
    const thread = this.threadById(threadId)
    return { branch: thread ? branchPullRequestUrl(thread) : undefined, linked: (thread?.pullRequests ?? []).map(link => link.url) }
  }
  /**
   * The thread's pull requests not known to have merged or closed, its branch's own and its linked ones, by URL: what
   * Watcher's background reads follow for a watched thread (ADR-0144). Read by ID, so asking costs the thread's links alone.
   */
  openPullRequestUrls(threadId: string): string[] {
    const thread = this.threadVisible(threadId) ? this.threadById(threadId) : undefined
    if (!thread) return []
    const branch = thread.worktree?.git?.pullRequest
    return [...branch?.state === 'open' ? [branch.url] : [], ...(thread.pullRequests ?? []).flatMap(link => link.state === 'open' ? [link.url] : [])]
  }
  /** One visual this thread holds, as the store keeps it: what an interactive visual's page is served from (ADR-0060). */
  visual(threadId: string, visualId: string): AgentVisual | undefined {
    if (!this.threadVisible(threadId)) return undefined
    if (this.storeUnavailable) return undefined
    try { return this.threadStore.readVisuals(threadId).find(stored => stored.visual.id === visualId)?.visual } catch { return undefined }
  }
  /**
   * A window's messages with the thread's visuals in their places, the messages alone when the store cannot say, and
   * each wake-up marked as Sotto's from the host's own records of sending it (ADR-0061 decision 8). Both are put on as
   * the window is read, so a history read again from the provider gets them again.
   */
  private withVisuals(threadId: string, messages: readonly AgentMessage[], windowStartsThread: boolean): AgentMessage[] {
    return this.withWakeUps(threadId, this.placedVisuals(threadId, messages, windowStartsThread))
  }
  private placedVisuals(threadId: string, messages: readonly AgentMessage[], windowStartsThread: boolean): AgentMessage[] {
    if (this.storeUnavailable) return [...messages]
    let visuals: readonly StoredVisual[]
    try { visuals = this.threadStore.readVisuals(threadId) } catch { return [...messages] }
    return placeVisuals(messages, visuals, windowStartsThread)
  }
  /**
   * The thread's record keeps its newest thousand wake-ups whatever Keep local history says, and with history on the
   * thread store keeps every one, so a wake-up stays Sotto's after a restart. The record alone answers when the store cannot.
   */
  private withWakeUps(threadId: string, messages: AgentMessage[]): AgentMessage[] {
    const recorded = this.wakeUpRecords.get(threadId) ?? []
    const recordedHidden = this.hiddenWakeUpRecords.get(threadId) ?? []
    let stored: ReadonlySet<string> = new Set()
    let storedHidden: ReadonlySet<string> = new Set()
    let storedAsks = NO_ASKS
    if (!this.storeUnavailable) try { stored = this.threadStore.wakeUps(threadId); storedAsks = this.threadStore.wakeUpAsks(threadId); storedHidden = this.threadStore.hiddenWakeUps(threadId) } catch { /* The record still answers. */ }
    // A wake-up of delegation news alone stays hidden past the record's newest thousand: the thread store keeps every mark.
    const hidden: ReadonlySet<string> = recordedHidden.length ? new Set([...storedHidden, ...recordedHidden]) : storedHidden
    if (!recorded.length && !stored.size) return messages
    const kept = new Set(recorded)
    // A Watcher wake-up also carries the requests its news said waited on the user, from the same records (ADR-0073).
    const keptAsks = this.wakeUpAskRecords.get(threadId) ?? NO_ASKS
    return messages.map(message => {
      if (message.role !== 'user') return message
      const wakeUp = !message.wakeUp && (kept.has(message.id) || stored.has(message.id))
      // A wake-up of delegation news alone is marked from the record too, so no window or phone shows it (ADR-0081).
      const hiddenWakeUp = !message.hiddenWakeUp && hidden.has(message.id)
      const asks = message.watcherAsks === undefined ? keptAsks.get(message.id) ?? storedAsks.get(message.id) : undefined
      return wakeUp || hiddenWakeUp || asks ? { ...message, ...(wakeUp ? { wakeUp: true as const } : {}), ...(hiddenWakeUp ? { wakeUp: true as const, hiddenWakeUp: true as const } : {}),
        ...(asks ? { watcherAsks: [...asks] } : {}) } : message
    })
  }
  /**
   * Copies each thread's kept wake-up IDs from its record into the thread store once the store is durable: at start, and
   * when Keep local history is turned on. The record keeps only the newest thousand; the store keeps every one from then
   * on, so a wake-up recorded while history was off stays marked however many come after. A store that refuses them
   * leaves the record to mark its thousand.
   */
  private seedWakeUps(): void {
    if (this.storeUnavailable || this.threadStore.ephemeral) return
    for (const thread of this.state.snapshot.threads.filter(thread => this.visible(thread))) {
      const ids = this.wakeUpRecords.get(thread.id)
      // A store that refuses them leaves the record to mark its own.
      if (ids?.length) this.post({ kind: 'wake-ups', threadId: thread.id, messageIds: ids, asks: this.wakeUpAskRecords.get(thread.id), hidden: this.hiddenWakeUpRecords.get(thread.id) ?? [] })
    }
  }
  /**
   * Records a wake-up's message ID on its thread's record, and in the thread store, before the provider hears the
   * prompt, so the message is Sotto's from its first echo, after a restart and after its history is read again
   * (ADR-0061 decision 8). A store that refuses it costs only the mark on a wake-up older than the record's newest thousand.
   */
  private async recordWakeUp(threadId: string, messageId: string, asks: readonly WatcherAsk[] = [], hidden = false): Promise<void> {
    const thread = this.thread(threadId)
    const hiddenRecord = this.hiddenWakeUpRecords.get(threadId) ?? []
    if (hidden && !hiddenRecord.includes(messageId)) {
      const next = [...hiddenRecord, messageId].slice(-WAKE_UP_IDS_KEPT)
      this.hiddenWakeUpRecords.set(threadId, next)
      this.touched(thread).hiddenWakeUpMessageIds = next.slice(-WAKE_UP_MESSAGE_IDS_MAX)
      this.dirty = true
    }
    // Only a Watcher wake-up whose news said threads waited on the user has asks, and only their identities are kept.
    const parsed = watcherAsksSchema.safeParse(asks)
    const kept = parsed.success && parsed.data.length ? parsed.data : undefined
    // A store that refuses it leaves the record below to name it, and the record marks it until the store holds it.
    if (!this.storeUnavailable) this.post({ kind: 'wake-up', threadId, messageId, asks: kept, hidden })
    const recorded = this.wakeUpRecords.get(threadId) ?? []
    const askRecord = this.wakeUpAskRecords.get(threadId)
    if (recorded.includes(messageId) && (kept === undefined || askRecord?.has(messageId))) return
    if (!recorded.includes(messageId)) {
      const next = [...recorded, messageId].slice(-WAKE_UP_IDS_KEPT)
      this.wakeUpRecords.set(threadId, next)
      this.touched(thread).wakeUpMessageIds = next.slice(-WAKE_UP_MESSAGE_IDS_MAX)
    }
    if (kept !== undefined) {
      const next = askRecord ?? new Map<string, readonly WatcherAsk[]>()
      next.set(messageId, kept)
      while (next.size > WAKE_UP_ASKS_KEPT) next.delete(next.keys().next().value!)
      this.wakeUpAskRecords.set(threadId, next)
    }
    this.dirty = true
    await this.flush()
  }

  constructor(private readonly inner: AgentHost, private readonly directory: string, private readonly historyEnabled: () => boolean = () => true,
    private readonly worktreeRefreshDelayMs: number = WORKTREE_REFRESH_DELAY_MS, private readonly watcherEnabled = false,
    /** The providers held to Owl on this run (ADR-0072), or, from before the held set, Muse's answer alone. Absent holds every one. */
    heldProviders: HeldProviders | boolean = false,
    /** The Owl list's answer for cheaper publish windows (#991), read once by the process owner. Absent fails closed. */
    private readonly streamingPublishCostEnabled = false,
    /**
     * The writer every thread-store write goes through (#1457). Absent, the store worker's, which commits off main where the
     * built worker sits beside this module and on main at once where it does not, as under the test runner.
     */
    storeWriter: (store: ThreadStore) => ThreadStoreWriter = store => new ThreadStoreWriterOnWorker(store),
    /** The built store worker, or null to write on main; absent, the file beside this module, which the test runner lacks. */
    storeWorker: string | StoreWorkerOptions | null = BUILT_STORE_WORKER) {
    this.held = typeof heldProviders === 'boolean' ? heldProvidersOf({ muse: heldProviders }) : heldProviders
    this.concurrentProviders = inner.concurrentProviders === true
    if (inner.subscribeUsage) this.subscribeUsage = listener => inner.subscribeUsage!(record => {
      if (this.ready && this.threadVisible(record.threadId)) listener(record)
    })
    if (inner.visitUsage) this.visitUsage = (threadId, visitor) => {
      if (this.ready && this.threadVisible(threadId)) inner.visitUsage!(threadId, visitor)
    }
    if (inner.readProviderQuota) this.readProviderQuota = (providerId, refresh, background) => inner.readProviderQuota!(providerId, refresh, background)
    if (inner.scanUsageHistory) this.scanUsageHistory = async (sink, signal) => {
      await this.initialize()
      // A Sotto thread's rows follow its visibility, as its live rows do; work outside Sotto has no thread to hide.
      const visible = <T extends { threadId: string }>(record: T): T | undefined =>
        isUsageHistoryThreadId(record.threadId) || this.ready && this.threadVisible(record.threadId) ? record : undefined
      await inner.scanUsageHistory!(mappedSink(sink, { token: visible, prompt: visible }), signal)
    }
    this.launchProfiles = new WatcherLaunchProfiles(directory, () => this.hostId,
      id => this.threadById(id), watcherEnabled)
    inner.useLaunchProfiles?.({ profileFor: async id => { await this.initialize(); return this.launchProfiles.profileFor(id) } })
    this.worktrees = new ThreadWorktrees(directory)
    const preserveThread = watcherEnabled && !this.held.size ? undefined : (id: string): boolean => !this.threadVisible(id)
    this.threadStore = new ThreadStore(join(directory, 'threads.sqlite'), preserveThread, storeWorker)
    this.writes = storeWriter(this.threadStore)
    this.subagentStore = new SubagentStore(join(directory, 'subagents.sqlite'), preserveThread)
    const parseWorkspace = (input: unknown): Workspace => { this.babysitRecords = savedBabysitting(input); this.wakeUpRecords = savedWakeUps(input); this.hiddenWakeUpRecords = savedHiddenWakeUps(input); this.wakeUpAskRecords = savedWakeUpAsks(input); const parsed = workspaceSchema.parse(input);
      // Whichever track wrote the file, every model reads back with its provider's modes on it.
      expandProviderModes(parsed.snapshot.models)
      if (!this.watcherEnabled || this.held.size) {
        const original = input as { snapshot: AgentHostSnapshot }
        this.preservedDormantThreads.clear()
        for (const thread of original.snapshot.threads) if (!this.visible(thread)) this.preservedDormantThreads.set(thread.id, structuredClone(thread))
      }
      return parsed }
    // With cheaper publish windows on, the file is written compact; every reader parses either form.
    this.store = this.streamingPublishCostEnabled
      ? AtomicJsonStore.compact(join(directory, 'workspace.json'), parseWorkspace, () => this.state)
      : new AtomicJsonStore(join(directory, 'workspace.json'), parseWorkspace, () => this.state)
    // A host that says what changed is believed: its events are this thread's history, and the array
    // comparison below is left for a host that publishes whole histories and nothing else. Such a host
    // is asked to leave the messages out of its snapshots, since none would be read (#322).
    this.eventSourced = typeof inner.subscribeEvents === 'function'
    this.published = new ThreadMap({ wholeOf: () => this.wholePublication(), verify: verifyingThreadChanges() })
    // The inner host's thread changes (#925), in the form asked of it before, so the provider switch subscribes to its
    // providers as it did. A host that publishes only snapshots has them worked out by the shim.
    const incoming = this.incoming
    const taken = (changes: AgentHostChanges, original?: AgentHostSnapshot): void => {
      const opening = this.acceptChanges(changes, original)
      this.writeSoon()
      this.publishSoon(opening)
    }
    if (inner.subscribeActivityChanges) {
      const subscription = inner.subscribeActivityChanges(changes => {
        if (this.deliveryStopped) return
        // Applied whatever the workspace is doing, so no publication is missed; taken in once it is ready, whole the first time.
        const applied = incoming.apply(changes)
        if (applied === 'resync') subscription.resync()
        if (applied === 'applied' && this.ready) taken(changes)
      }, { historyFromEvents: this.eventSourced })
      this.providerSubscriptions.push(subscription)
    } else {
      this.providerSubscriptions.push(subscribeActivitySnapshots(inner, snapshot => {
        if (!this.ready || this.deliveryStopped) return
        const changes: AgentHostChanges = { ...threadChangesBetween(incoming.sequence === undefined ? undefined : incoming, snapshot), sequence: (incoming.sequence ?? 0) + 1 }
        incoming.apply(changes)
        taken(changes, snapshot)
      }, { historyFromEvents: this.eventSourced }))
    }
    const unsubscribeEvents = inner.subscribeEvents?.(({ threadId, event }) => {
      if (!this.deliveryStopped) this.recordEvent(threadId, event)
    })
    if (unsubscribeEvents) this.providerSubscriptions.push(unsubscribeEvents)
  }

  initialize(): Promise<void> {
    this.loading ??= (async () => {
      this.hostId = await loadHostIdentity(this.directory)
      try { await migrateWorkspaceHost(this.directory, this.hostId) }
      catch (error) {
        // History-off recovery already discards an unreadable snapshot without keeping private
        // copies. Identity validation must not prevent that explicit privacy cleanup. A refused
        // write, unreadable file or valid workspace belonging to another host still stops startup.
        if (this.historyEnabled() || !(error instanceof SyntaxError || error instanceof z.ZodError)) throw error
      }
      if (!this.watcherEnabled) for (const id of await this.launchProfiles.retainedThreadIds()) this.retainedWatcherIds.add(id)
      // Native history is recoverable from the providers. Never create independent
      // private transcript backups, and remove this cache's abandoned write copies.
      const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const name of names) if (/^workspace\.json\.(?:tmp|corrupt)-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) {
        await unlink(join(this.directory, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
      // Read the release-gated kinds before either store applies an offline privacy change.
      this.state = await this.store.peek()
      this.state.snapshot = stampHostSnapshot(this.state.snapshot, this.hostId)
      for (const id of this.state.clearedThreadIds) this.clearedIds.add(id)
      if (this.clearedIds.size && this.state.snapshot.threads.some(thread => this.clearedIds.has(thread.id))) {
        this.state.snapshot.threads = this.state.snapshot.threads.filter(thread => !this.clearedIds.has(thread.id))
      }
      try { this.threadStore.open({ ephemeral: !this.historyEnabled() }) }
      catch { this.storeUnavailable = true; this.saveError = HISTORY_OPEN_ERROR }
      try { this.subagentStore.open({ ephemeral: !this.historyEnabled() }) }
      catch { this.subagentUnavailable = true; this.saveError = 'Agent history could not be opened. Restore access to local storage and restart Sotto.' }
      const snapshot = this.state.snapshot
      // Babysitting is Sotto's own record, so it is restored with the thread (decision 10); the thread shows only what clients see.
      for (const thread of snapshot.threads.filter(thread => this.visible(thread))) {
        const records = this.babysitRecords.get(thread.id)
        if (records?.length) thread.babysitting = babysittingSummary(records); else delete thread.babysitting
        const wakeUps = this.wakeUpRecords.get(thread.id)
        if (wakeUps?.length) thread.wakeUpMessageIds = wakeUps.slice(-WAKE_UP_MESSAGE_IDS_MAX); else delete thread.wakeUpMessageIds
        const hidden = this.hiddenWakeUpRecords.get(thread.id)
        if (hidden?.length) thread.hiddenWakeUpMessageIds = hidden.slice(-WAKE_UP_MESSAGE_IDS_MAX); else delete thread.hiddenWakeUpMessageIds
      }
      this.seedWakeUps()
      snapshot.connected = false
      // A Git action that was running when the host stopped did not finish here; the folder says what it did.
      for (const thread of snapshot.threads.filter(thread => this.visible(thread))) if (thread.gitAction?.status === 'running') thread.gitAction = { ...thread.gitAction, status: 'failed', phase: null, stage: null, hook: null, finishedAt: new Date().toISOString(), error: 'Sotto stopped while this action ran. Check the folder before running it again.' }
      // A Claude Code model saved before the adapter named it carries the provider's id as its label, and a model that
      // has left the catalog is never refreshed, so it takes the name here.
      snapshot.models.forEach(model => { model.ready = false; if (model.provider === 'claude') model.provider = PROVIDER_LABELS.claude })
      snapshot.providers?.forEach(provider => { provider.connection = 'disconnected'; delete provider.error })
      delete snapshot.error
      for (const thread of snapshot.threads.filter(thread => this.visible(thread))) dropLiveThreadState(thread)
      if (!this.historyEnabled()) {
        this.activityJsonFallbackAllowed = false
        for (const thread of snapshot.threads.filter(thread => this.visible(thread))) {
          if (!this.storeUnavailable) {
            try { await this.waited(this.commit({ kind: 'activity-identities-redacted', threadId: thread.id, activityIds: (thread.activities ?? []).map(activity => activity.id) })) }
            catch { this.activityStoreUnavailable = true; this.saveError = HISTORY_OPEN_ERROR }
          }
          thread.messages = []; thread.requests = []; delete thread.activities
        }
      }
      await this.adoptSavedActivities(snapshot)
      // Cached running activity is evidence of an unfinished observation, not a live process.
      // Disk reads are private mutable copies. Certify them only when a provider's snapshot reaches the
      // thread, with activity or without, so reopening a large archive does not pay for an ownership transfer
      // it may never need.
      for (const thread of snapshot.threads.filter(thread => this.visible(thread))) if (thread.activities) thread.activities = thread.activities.map(savedRecord)
      for (const thread of snapshot.threads.filter(thread => this.visible(thread))) {
        this.trackSubagents(thread, false)
        thread.subagentSummary = this.subagentSummaries.get(thread.id) ?? EMPTY_SUBAGENT_SUMMARY
      }
      await this.adoptSavedMessages(snapshot)
      if (!this.storeUnavailable) this.inner.useThreadHistory?.(this)
      await this.inner.initialize?.()
      // The store below is what a provider's own transcript would otherwise be re-read to rebuild.
      // Handing it back before the first connection is what lets an adapter resume where it stopped.
      // A host that publishes events asks the store itself, one thread at a time, rather than being
      // handed every thread's whole history before it has read anything.
      if (!this.eventSourced) await this.inner.restoreThreadHistory?.(this.storeUnavailable ? [] : snapshot.threads.filter(thread => this.visible(thread)).flatMap(thread => {
        const messages = this.readWindow(thread.id)?.messages ?? []
        if (!messages.length) return []
        const activities = this.storedActivity.has(thread.id) ? this.storedActivities(thread.id) : thread.activities?.slice(-MAX_AGENT_ACTIVITIES)
        return [{ threadId: thread.id, messages, ...(activities ? { activities } : {}), ...(thread.historyEpoch ? { historyEpoch: thread.historyEpoch } : {}) }]
      }))
      // Every thread was just read: the first publication is taken in whole, and everything is published and saved.
      this.touchAll()
      this.ready = true
      await this.applyHistoryPrivacy(false)
    })().catch(error => { this.loading = undefined; throw error })
    return this.loading
  }

  /**
   * The one-time move of every thread's messages out of `workspace.json` and into the store (issue #119).
   * `workspace.json` keeps organization from here on. A store that refuses the write leaves the file
   * exactly as it was, so the next start can try again with nothing lost.
   */
  private async adoptSavedMessages(snapshot: AgentHostSnapshot): Promise<void> {
    if (this.storeUnavailable) return
    const carrying = snapshot.threads.filter(thread => this.visible(thread) && thread.messages.length)
    if (carrying.length) {
      // Each thread's move is confirmed before the next is posted, so the first that fails stops them, as it did.
      try {
        for (const thread of carrying) {
          await this.waited(this.commit({ kind: 'events', threadId: thread.id, events: replacementEvents(thread.messages, thread.historyEpoch) }))
          this.storedAnchors.delete(thread.id)
        }
      } catch { this.saveError = HISTORY_SAVE_ERROR; return }
      this.dirty = true
    }
    // Startup needs the sidebar's facts, not a message window for every saved thread. Observation loads
    // the windows a pane wants. Legacy hosts still need message marks to compare their next arrays.
    for (const thread of snapshot.threads.filter(thread => this.visible(thread))) {
      if (!this.eventSourced) this.known.set(thread.id, { epoch: thread.historyEpoch, messages: this.readWindow(thread.id)?.messages.map(markOf) ?? [] })
      thread.messages = []
      delete thread.earlierAvailable
      thread.summary = this.threadSummary(thread)
    }
  }
  /** Import old JSON activity without replacing a committed message generation after an interrupted save. */
  private async adoptSavedActivities(snapshot: AgentHostSnapshot): Promise<void> {
    if (this.storeUnavailable) { this.activityStoreUnavailable = true; return }
    /** Each write here is read straight back, so each waits for its confirmation; a failure throws, as the store's did. */
    const commit = (write: ThreadStoreWrite): Promise<void> => this.waited(this.commit(write))
    try {
      // Until a start has read every record once and saved them back, a record may still carry subagent task words
      // the roster lacks; reading them in is what moves the words (`trackSubagents`) and saving strips them (#918).
      this.subagentWordsPending = !this.threadStore.subagentWordsMoved()
      for (const thread of snapshot.threads.filter(thread => this.visible(thread))) {
        let messageGeneration = this.threadStore.readMessageEpoch(thread.id)
        if (messageGeneration) {
          // A committed reset, including an unversioned or empty reset, outranks legacy JSON.
          thread.messages = []
          if (thread.historyEpoch !== messageGeneration.epoch) thread.activities = []
          if (messageGeneration.epoch === undefined) delete thread.historyEpoch
          else thread.historyEpoch = messageGeneration.epoch
        }
        if (!this.threadStore.hasActivities(thread.id) && thread.activities !== undefined) {
          if (!messageGeneration && thread.messages.length) {
            // Both legacy projections describe the same JSON generation. Commit its first message
            // reset before activity so even an exit before the later flush leaves a matching marker.
            await commit({ kind: 'events', threadId: thread.id, events: replacementEvents(thread.messages, thread.historyEpoch) })
            this.storedAnchors.delete(thread.id)
            thread.messages = []
            messageGeneration = this.threadStore.readMessageEpoch(thread.id)
          }
          // Retain legacy child tasks before the activity migration removes their payload. The commit below saves the
          // records without their task words, so the roster's copy of the words reaches the disk first; if it cannot,
          // this fails as a failed migration does, and workspace.json keeps the records.
          if (!this.trackSubagents(thread, false)) throw new RosterLacksWords()
          try { this.subagentStore.flushToDisk() } catch { throw new RosterLacksWords() }
          // The flush after this drops the records from workspace.json, so they wait for the disk here first.
          await commit({ kind: 'activity-list', threadId: thread.id, activities: retainedActivities(thread.activities!), epoch: thread.historyEpoch, flushed: true })
        }
        if (this.threadStore.hasActivities(thread.id)) {
          const activityEpoch = this.threadStore.readActivityEpoch(thread.id)
          const activityReset = this.threadStore.readActivityResetSequence(thread.id)
          if (messageGeneration && (activityEpoch !== messageGeneration.epoch || (activityReset !== undefined && activityReset !== messageGeneration.sequence))) {
            // The message reset may commit before activity sync. Old activity must not roll it back.
            thread.activities = []
            await commit({ kind: 'activity-list', threadId: thread.id, activities: [], epoch: messageGeneration.epoch })
          } else {
            const epoch = messageGeneration ? messageGeneration.epoch : activityEpoch
            if (thread.historyEpoch !== epoch) thread.messages = []
            if (epoch === undefined) delete thread.historyEpoch
            else thread.historyEpoch = epoch
            if (this.subagentWordsPending) thread.activities = this.threadStore.readActivities(thread.id)
            else {
              // Startup reads the marker and count alone; the records wait until someone looks at the thread (#918).
              delete thread.activities
              this.post({ kind: 'activities-released', threadId: thread.id })
              this.storedActivity.add(thread.id)
            }
          }
        }
      }
    } catch (error) {
      this.activityStoreUnavailable = true
      // workspace.json then keeps the records, and their task words with them while the roster lacks them.
      if (error instanceof RosterLacksWords) this.rosterLacksWords = true
      this.saveError = 'Thread activity could not be saved. Saved activity remains available. Restore local storage and restart Sotto.'
    }
  }
  private historyWritable(): boolean {
    return !this.storeUnavailable && (this.threadStore.ephemeral
      || (this.historyEnabled() && !this.pendingEventsPrivate && !this.historyRedactionPending))
  }
  /**
   * `keepTaskWords` saves the records as this run holds them, task words included, for when the roster may lack them.
   * Only the threads marked since the last save that succeeded are saved (#925), unless `all` asks for every one, as does
   * a save with the words or the first without them after one. A list that is not certified may be edited where it is,
   * so its thread stays marked and is saved every time, as every thread was.
   */
  private saveActivities(keepTaskWords = false, all = false): void | Promise<void> {
    if (!this.historyWritable() || this.activityStoreUnavailable) return
    const whole = all || keepTaskWords || this.unsavedAll || this.savedWithWords
    const threads = whole ? this.state.snapshot.threads : [...this.unsaved].flatMap(id => { const thread = this.threadById(id); return thread ? [thread] : [] })
    // A thread being cleared, or cleared, is left to its forget: the store takes no more of its records (`admitted`), and
    // counting it would fail the save for every other thread in it.
    const saved = threads.filter(thread => this.visible(thread) && thread.activities !== undefined && !this.forgetting.has(thread.id) && !this.clearedIds.has(thread.id))
    // Every thread's records in one transaction: a save with several busy threads pays one disk flush, not one each.
    // A writer on main throws its failure here, before anything below, exactly as the store did.
    const done = this.commit({ kind: 'activities', entries: saved.map(thread => ({ threadId: thread.id, activities: keepTaskWords ? thread.activities! : retainedActivities(thread.activities!), epoch: thread.historyEpoch })) })
    // A writer that confirms later: what this save took is put back if it fails, so the next save tries it again.
    const taken = done ? { unsaved: [...this.unsaved], unsavedAll: this.unsavedAll, savedWithWords: this.savedWithWords, save: ++this.activitySaves } : undefined
    this.unsaved.clear()
    this.unsavedAll = false
    // Records let go with their words kept are let go again once a save has stripped them.
    if (this.savedWithWords && !keepTaskWords) this.releasableAll = true
    this.savedWithWords = keepTaskWords
    for (const thread of saved) if (!isImmutableActivities(thread.activities)) this.unsaved.add(thread.id)
    if (!done || !taken) return
    this.activitySavesInFlight++
    return done.finally(() => { this.activitySavesInFlight-- }).catch((error: unknown) => {
      for (const id of taken.unsaved) this.unsaved.add(id)
      if (taken.unsavedAll) this.unsavedAll = true
      if (taken.save === this.activitySaves) this.savedWithWords = taken.savedWithWords
      throw error
    })
  }
  /**
   * Whether a save may strip moved task words from their records now: none are being moved, or the roster, their only
   * other copy, took them and is on the disk. When not, the caller saves the records with their words (`saveActivities(true)`),
   * so nothing is lost and a record let go afterwards is in the store as this run held it; a later save asks again.
   */
  private rosterOnDisk(): boolean {
    if (this.rosterLacksWords) return false
    if (!this.subagentWordsPending && !this.rosterFlushPending) return true
    if (this.subagentUnavailable) return false
    try { this.subagentStore.flushToDisk() } catch { this.saveError = 'Agent history could not be saved. Restore access to local storage and refresh.'; return false }
    this.rosterFlushPending = false
    return true
  }
  /** Once the records a start read whole are saved back without their words, later starts need not read them (#918). */
  private noteSubagentWordsMoved(): void | Promise<void> {
    if (!this.subagentWordsPending || !this.historyWritable() || this.activityStoreUnavailable || this.subagentUnavailable) return
    const done = this.commit({ kind: 'subagent-words-moved' })
    this.subagentWordsPending = false
    if (done) return done.catch((error: unknown) => { this.subagentWordsPending = true; throw error })
  }
  /**
   * Reads a stored thread's records back into memory, mapped as the startup read was: a record still running in the
   * store was not live (#918). A read that fails turns saving off, as a failed startup read does, so the store keeps
   * the records for the next start while this run shows only what the provider brings. `records` gives those the store
   * worker read back, frozen as they arrived, or throws as a failed read does; by default they are read here, on main.
   */
  private holdActivities(thread: AgentThread, records: () => readonly AgentActivity[] = () => this.threadStore.readActivities(thread.id, { shared: true })): AgentActivity[] | undefined {
    if (!this.storedActivity.has(thread.id)) return thread.activities
    this.storedActivity.delete(thread.id)
    this.touch(thread.id)
    this.storedInputs.delete(thread.id)
    try {
      // Frozen records, shared: this list is replaced, never edited, like every list the workspace holds.
      this.touched(thread).activities = records().map(savedRecord)
    } catch {
      this.activityStoreUnavailable = true
      this.saveError = ACTIVITY_READ_ERROR
    }
    if (thread.activities) this.moveSubagentWords(thread, thread.activities)
    return thread.activities
  }
  /**
   * A stored thread a window began to look at has its records read back on the store worker, so the query, the parse and
   * the schema check leave main; its provider hears of the observation once they have arrived (`activitiesArrived`). With
   * no worker to read on, or writes waiting unsent that the read must follow, they are read here at once, as before.
   */
  private readBack(thread: AgentThread): void {
    if (this.activityReads.has(thread.id)) return
    const answer = this.writes.readActivities?.(thread.id)
    if (!answer) { this.holdActivities(thread); return }
    const held: AgentThread[] = []
    const read: ActivityRead = { held, done: answer.then(result => this.activitiesArrived(thread.id, read, result)).catch(() => { console.warn('thread-activity-read-back-failed') }) }
    this.activityReads.set(thread.id, read)
  }
  /**
   * A read that will not be used. The provider is told the observation once no observed thread's read is on its way: the
   * last of a batch tells it, once, and every read ends (arrived, let go or lost), so none waits for good. `soon` waits for
   * the task under way to end, for a read let go inside an accept, which telling the provider must not run inside.
   */
  private endRead(threadId: string, read: ActivityRead, soon = false): void {
    if (this.activityReads.get(threadId) !== read) return
    this.activityReads.delete(threadId)
    if (!this.observation.has(threadId) || --this.observedReads > 0 || this.stopping) return
    if (!soon) { this.tellObservation(); return }
    if (this.observationQueued) return
    this.observationQueued = true
    queueMicrotask(() => { this.observationQueued = false; if (this.observedReads === 0 && !this.stopping) this.tellObservation() })
  }
  /**
   * A stored thread's list stops being the one a read on its way was asked for: a new history epoch's list replaced it,
   * Keep local history turning off emptied it, or the thread was cleared. The read is let go for good, so it takes
   * nothing when it arrives, and a later read of whatever the thread holds then starts afresh.
   */
  private letReadGo(threadId: string): void {
    const read = this.activityReads.get(threadId)
    if (read) this.endRead(threadId, read, true)
  }
  /** A clear of these threads is over, whether or not it went through: lists that arrived meanwhile go on (`activitiesArrived`). */
  private forgetEnded(threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      const go = this.readsAwaitingForget.get(threadId)
      if (go) { this.readsAwaitingForget.delete(threadId); go() }
    }
  }
  /**
   * A stored thread's records are back from the store worker. They are held as a read on main holds them, then each record
   * its provider published meanwhile is merged onto them in the order it came, and the provider is told the window looks
   * at the thread. A window that stopped looking meanwhile leaves them held, as a read on main had, until a save lets them
   * go. A read let go (`letReadGo`) takes nothing. A list that arrives while its thread is being cleared waits to hear
   * whether the clear went through: a clear that fails keeps the thread, and what was published behind the list with it.
   * A worker that went first answers lost, and the records are read on main behind what it left unanswered, closing
   * included, so the last save keeps what was published behind them.
   */
  private async activitiesArrived(threadId: string, read: ActivityRead, result: ActivityReadBack): Promise<void> {
    if (this.activityReads.get(threadId) !== read) return
    if ('lost' in result) await this.writes.confirmed(threadId)
    if (this.forgetting.has(threadId) && this.activityReads.get(threadId) === read) await new Promise<void>(resolve => { this.readsAwaitingForget.set(threadId, resolve) })
    if (this.activityReads.get(threadId) !== read) return
    const wanted = this.observation.has(threadId)
    const thread = this.threadById(threadId)
    // While closing, a read matters only for what was published behind it, which the save closing makes then keeps.
    const keeps = thread !== undefined && this.storedActivity.has(threadId) && !this.clearedIds.has(threadId) && (!this.stopping || read.held.length > 0)
    if (keeps) {
      const stored = 'activities' in result ? (): readonly AgentActivity[] => result.activities
        : 'unreadable' in result ? (): never => { throw new Error('Thread activity could not be read') } : undefined
      const before = this.holdActivities(thread, stored)
      for (const record of read.held) {
        const current = this.threadById(threadId)!
        this.touched(current).activities = this.mergeActivities(record, current)
      }
      if (read.held.length) {
        // A record the provider settled while the list was on its way may have moved the thread's branch (`refreshIfHeadMoved`).
        if (settledHeadMoved(before, this.threadById(threadId)!.activities)) this.scheduleWorktreeRefresh(threadId)
        this.dirty = true
        this.writeSoon()
      }
    }
    this.endRead(threadId, read)
    // A window opening many stored threads publishes their records as a burst does, not once for each.
    if (keeps && !this.stopping) this.publishSoon(wanted)
  }
  /** The provider hears which threads the window looks at, less those whose records are still on their way. */
  private tellObservation(): void {
    // A thread cleared since the window last said what it shows is left out: a read let go with the clear tells the provider
    // again before the window does. A thread the workspace does not hold yet still goes, as the window names it.
    this.inner.observeThreads?.([...this.observation].filter(id => !this.activityReads.has(id) && !this.forgetting.has(id)
      && !this.clearedIds.has(id) && this.threadById(id)?.nativeSessionStarted !== false))
  }
  /**
   * A record read back may still carry subagent task words from before the roster held them, when the start that moved
   * every thread's words did not reach this one, such as a Watcher thread hidden then. They go to the roster now, the way
   * that start moved them, before anything saves the list back without them (#918).
   */
  private moveSubagentWords(thread: AgentThread, activities: readonly AgentActivity[]): void {
    const unmoved = activities.filter(activity => (activity.kind === 'subagent' || activity.agents?.length || activity.taskUpdatesExcluded !== undefined)
      && !isDeepStrictEqual(subagentActivityClassification(activity), activity))
    if (!unmoved.length) return
    // With no roster to take them, the words stay in their records.
    if (this.subagentUnavailable) { this.rosterLacksWords = true; return }
    // Read back from the store, an agent marked working there is history, not a live one.
    const observations = unmoved.flatMap(activity => activity.agents ?? []).map(agent => observedSubagentStatus(agent.status) === 'running' ? { ...agent, status: 'unknown' as const } : agent)
    try {
      this.subagentsChanged(this.subagentStore.ingest(thread.id, observations, thread.historyEpoch, unmoved))
      // The next save strips these records, so the roster's copy of the words reaches the disk first.
      this.rosterFlushPending = true
    } catch {
      // The words stay in their records: nothing strips them while the roster lacks them.
      this.rosterLacksWords = true
      this.saveError = ROSTER_LACKS_WORDS_ERROR
    }
  }
  /**
   * Once a save has put every held list in the store, a thread nobody is looking at and nothing is running in lets its
   * records go: the store holds exactly them, and the thread keeps its marker and count (#918). Before a window says
   * what it shows, every thread counts as in view, so nothing goes.
   */
  private releaseIdleActivities(): boolean {
    if (!this.historyWritable() || this.activityStoreUnavailable || this.storeUnavailable || !this.declared) return false
    // What the store holds is known only once every activity save posted is confirmed; the next save asks again.
    if (this.activitySavesInFlight > 0) return false
    let released = false
    // Only threads marked since the last release can have become idle, out of view or whole in the store (#925).
    const candidates = this.releasableAll ? this.state.snapshot.threads : [...this.releasable].flatMap(id => { const thread = this.threadById(id); return thread ? [thread] : [] })
    this.releasable.clear()
    this.releasableAll = false
    for (const thread of candidates.filter(thread => this.visible(thread))) {
      if (!thread.activities || this.inView(thread.id) || thread.status === 'running' || thread.activities.some(activity => activity.status === 'running')) continue
      if (!this.storesWhole(thread.id, thread.activities)) continue
      const input = this.activityInputs.get(thread.id)?.input
      if (input) this.storedInputs.set(thread.id, input)
      this.activityInputs.delete(thread.id)
      // The subagent tracker compares by the list it walked last; that may be this one, as the first start's read is.
      const tracked = this.subagentInputs.get(thread.id)
      if (tracked?.activities === thread.activities) tracked.activities = undefined
      this.post({ kind: 'activities-released', threadId: thread.id })
      delete this.touched(thread).activities
      this.storedActivity.add(thread.id)
      released = true
    }
    return released
  }
  /**
   * Whether the store holds this list as this run shows it, so letting it go loses nothing: every record is there, and a
   * subagent record the store keeps only the classification of (`retainedActivities`) had nothing more in it. A live one
   * still carrying its task's words keeps the thread in memory, as does a record a redacted identity kept out.
   */
  private storesWhole(threadId: string, activities: AgentActivity[]): boolean {
    const retained = retainedActivities(activities)
    if (this.threadStore.activityCount(threadId) !== retained.length) return false
    return retained.every((record, index) => record === activities[index] || isDeepStrictEqual(record, activities[index]))
  }
  /** One window of a thread's messages, or nothing when the store cannot answer. */
  private readWindow(threadId: string, turns?: number) {
    if (this.storeUnavailable) return undefined
    this.writeEvents()
    try { return this.windowWithHeld(threadId, () => this.threadStore.readMessages(threadId, turns === undefined ? {} : { turns }), true) }
    catch { this.saveError = HISTORY_SAVE_ERROR; return undefined }
  }
  /**
   * The sidebar's facts about a thread. With the history in hand they come from it; without it they come
   * from the store's projection, with the activity counted from the records the thread still carries.
   */
  private threadSummary(thread: AgentThread, messages?: readonly AgentMessage[]): AgentThreadSummary {
    const beside = this.withStoredCount(thread, summarizeThread({ messages: [], activities: thread.activities }))
    if (messages !== undefined) return this.withStoredCount(thread, summarizeThread({ messages: [...messages], activities: thread.activities }))
    if (this.storeUnavailable) return beside
    this.writeEvents()
    try {
      // The appends waiting for the write window, and what is posted and not yet confirmed, lie over the store (`heldEvents`),
      // read at one moment of the file with it.
      const stored = this.threadStore.reading(() => {
        const messages = this.threadStore.summaryMessages(thread.id)
        const events = this.heldEvents(thread.id, true)
        return summaryOf(events.length === 0 ? messages : applyEventsToSummary(messages, events))
      })
      return { ...stored, activityCount: beside.activityCount, ...(beside.runningTurnStartedAt === undefined ? {} : { runningTurnStartedAt: beside.runningTurnStartedAt }) }
    } catch { return beside }
  }
  /** A stored thread's records are counted where they are kept (#918). None of them is running. */
  private withStoredCount(thread: AgentThread, summary: AgentThreadSummary): AgentThreadSummary {
    if (!this.storedActivity.has(thread.id)) return summary
    try { return { ...summary, activityCount: this.threadStore.activityCount(thread.id) } }
    catch { return summary }
  }
  /**
   * What changed between the history the store holds for a thread and the one its provider just published.
   * A message that grew is an append, an id that is new is an addition, anything else about a known message
   * is a replacement, and a history that no longer starts the same way — a rewind, a compaction — is a reset.
   */
  private differences(threadId: string, messages: readonly AgentMessage[], epoch: string | undefined, previousEpoch: string | undefined): ThreadEvent[] {
    const at = new Date().toISOString()
    const added = (message: AgentMessage): ThreadEvent => ({ kind: 'message-added', at: message.createdAt || at, message })
    const reset = (): ThreadEvent[] => [{ kind: 'messages-reset', at, ...(epoch === undefined ? {} : { historyEpoch: epoch }) }, ...messages.map(added)]
    let known = this.known.get(threadId)
    if (known === undefined) {
      known = { epoch: previousEpoch, messages: this.readWindow(threadId)?.messages.map(markOf) ?? [] }
      this.known.set(threadId, known)
    }
    if (known.epoch !== epoch) return reset()
    if (messages.length < known.messages.length) return reset()
    const events: ThreadEvent[] = []
    for (const [index, message] of messages.entries()) {
      const mark = known.messages[index]
      if (mark === undefined) { events.push(added(message)); continue }
      if (mark.id !== message.id) return reset()
      const attachments = message.attachments?.length ?? 0
      if (mark.length === message.text.length && mark.attachments === attachments && mark.tail === message.text.slice(-TAIL)
        && mark.turnMessageId === message.turnMessageId && mark.watcherChanges === JSON.stringify([message.watcherOwnChange ?? null, message.watcherObservedChanges ?? null])) continue
      // A true append leaves the characters the store already holds exactly where they were.
      if (message.text.length > mark.length && mark.attachments === attachments
        && mark.turnMessageId === message.turnMessageId
        && mark.watcherChanges === JSON.stringify([message.watcherOwnChange ?? null, message.watcherObservedChanges ?? null])
        && message.text.slice(Math.max(0, mark.length - TAIL), mark.length) === mark.tail) {
        events.push({ kind: 'message-text-appended', at, messageId: message.id, appendText: message.text.slice(mark.length) })
      } else events.push({ kind: 'message-replaced', at, message })
    }
    return events
  }
  /**
   * One change a provider host reported. Events are the record from an adapter that publishes them, so
   * they are written whole and in order; the window a pane holds and the sidebar's facts are read again
   * at the next publish rather than per event, which keeps a streamed reply at one publish per window.
   */
  private recordEvent(threadId: string, event: ThreadEvent): void {
    if (this.clearedIds.has(threadId)) return
    const thread = this.threadById(threadId)
    if (thread && !this.visible(thread)) return
    if (!this.historyEnabled()) this.pendingEventsPrivate = true
    const waiting = this.pendingEvents.get(threadId)
    if (waiting) waiting.push(event)
    else this.pendingEvents.set(threadId, [event])
    this.eventChanged.add(threadId)
    if (this.ready) this.publishSoon(event.kind === 'message-added' && this.inView(threadId))
  }
  /**
   * Write what the events said. Called before anything reads the store, and at every publish.
   * Everything due goes in one transaction for the window, a savepoint per thread, so several
   * streaming threads pay one fsync (#991). Unless asked to include them, a thread's trailing text
   * appends wait for the write window instead: the pane reads them laid over its stored window
   * (readWindow), and any reader of the store itself asks first. Any other event kind commits at once,
   * with the appends ahead of it, and folds its thread's append run into single events.
   */
  private writeEvents(force = false, includeAppends = force): void {
    if (this.pendingEvents.size === 0 || !this.ready || this.storeUnavailable) return
    // Another store may have stopped privacyChanged before this connection could be replaced.
    // The setting already forbids durable text, including a timer or shutdown retry.
    if (!this.historyWritable()) return
    const due = new Map<string, ThreadEvent[]>()
    for (const [threadId, pending] of this.pendingEvents) {
      // A thread's posted batch, or answer, is confirmed before its next is posted, so nothing commits ahead of one that failed.
      // A history-publishing host's write in flight, or one that failed and waits for its next comparison, holds it too.
      if (this.inFlight.has(threadId) || this.answersInFlight.has(threadId) || this.recordsInFlight.has(threadId) || this.recordsFailed.has(threadId)) continue
      // A thread being cleared posts nothing more: its forget is posted, and anything after it would outlive it.
      if (this.forgetting.has(threadId)) continue
      const events: ThreadEvent[] = []
      for (const event of pending) {
        const parts: ThreadEvent[] = []
        if ((event.kind === 'message-added' || event.kind === 'message-replaced') && typeof event.message?.text === 'string' && event.message.text.length > 100_000) {
          const chunks = historyTextChunks(event.message.text)
          parts.push({ ...event, message: { ...event.message, text: chunks[0]! } })
          for (const appendText of chunks.slice(1)) {
            parts.push({ kind: 'message-text-appended', at: event.at, messageId: event.message.id, appendText, ...(event.redacted ? { redacted: event.redacted } : {}) })
          }
        } else if (event.kind === 'message-text-appended' && typeof event.appendText === 'string' && event.appendText.length > 100_000) {
          for (const appendText of historyTextChunks(event.appendText)) parts.push({ ...event, appendText })
        } else parts.push(event)
        const parsed = parts.map(part => threadEventSchema.safeParse(part))
        if (parsed.every(part => part.success)) events.push(...parsed.map(part => part.data!))
        else {
          this.invalidEventThreads.add(threadId)
          this.touch(threadId)
          console.warn('thread-history-event-invalid')
        }
      }
      // With the feature off, nothing folds and nothing waits: stable writes as it always has.
      const folded = this.streamingPublishCostEnabled ? foldAppends(events) : events
      // A batch validation emptied has nothing left to write; keeping it would wait forever.
      if (folded.length === 0) { this.pendingEvents.delete(threadId); continue }
      this.pendingEvents.set(threadId, folded)
      if (!force && this.historyRetryTimer && this.failedEventThreads.has(threadId)) continue
      let take = folded.length
      // A failed thread's batch is one retry unit, trailing appends included, as it was when it failed.
      if (this.streamingPublishCostEnabled && !includeAppends && !this.failedEventThreads.has(threadId)) {
        take = 0
        for (let index = folded.length - 1; index >= 0; index--) {
          if (folded[index]!.kind !== 'message-text-appended') { take = index + 1; break }
        }
      }
      if (take > 0) due.set(threadId, folded.slice(0, take))
    }
    if (due.size > 0) {
      // Each batch is held, at the front of its thread's waiting events, until the writer confirms it (#1457).
      for (const [threadId, events] of due) this.inFlight.set(threadId, events)
      if (this.streamingPublishCostEnabled) {
        this.post({ kind: 'event-batches', batches: due }, (outcome, late) =>
          this.eventsConfirmed(due, outcome.error === undefined ? outcome.failed : new Set(due.keys()), late))
      } else {
        for (const [threadId, events] of due) {
          const batch = new Map([[threadId, events]])
          this.post({ kind: 'events', threadId, events }, (outcome, late) => this.eventsConfirmed(batch, writeFailed(outcome) ? new Set([threadId]) : NO_THREAD_IDS, late))
        }
      }
    }
    // Appends left waiting still need their write: the write window's flush includes them. A batch
    // a failed write left behind keeps its own retry's pace instead (#378).
    if (this.streamingPublishCostEnabled && !includeAppends && !this.stopping && [...this.pendingEvents.keys()].some(threadId => !this.failedEventThreads.has(threadId))) this.writeSoon()
    this.scheduleHistoryRetry()
  }
  /**
   * The writer's word on posted event batches. A committed batch leaves the front of its thread's waiting events, and
   * appends held for the write window stay behind it; a failed one stays there, whole, for its retry. A confirmation
   * for a batch the thread no longer holds, because the thread was cleared or history switched meanwhile, changes nothing.
   */
  private eventsConfirmed(batches: ReadonlyMap<string, readonly ThreadEvent[]>, failed: ReadonlySet<string>, late: boolean): void {
    for (const [threadId, events] of batches) {
      if (this.inFlight.get(threadId) !== events) continue
      this.inFlight.delete(threadId)
      if (failed.has(threadId)) {
        this.failedEventThreads.add(threadId)
        this.storedAnchors.delete(threadId)
        continue
      }
      // Remove only a committed batch; appends held for the write window stay waiting behind it.
      const waiting = (this.pendingEvents.get(threadId) ?? []).slice(events.length)
      if (waiting.length > 0) this.pendingEvents.set(threadId, waiting)
      else this.pendingEvents.delete(threadId)
      this.failedEventThreads.delete(threadId)
      this.noteWritten(threadId, events)
      this.recordOwed(threadId)
      this.markChanged(threadId)
      this.eventChanged.add(threadId)
      this.known.delete(threadId)
      if (events.some(event => event.kind === 'messages-reset')) this.hidden.delete(threadId)
      this.dirty = true
    }
    if (!late) return
    this.scheduleHistoryRetry()
    // A confirmation that came after its post owes a publish: its window is read again, and what waited behind it is posted.
    if (!this.stopping) this.publishSoon()
  }
  /** A batch that failed is retried at one second, doubling to thirty, until it commits (ADR-0016, September 27). */
  private scheduleHistoryRetry(): void {
    if (this.failedEventThreads.size === 0 && this.recordsFailed.size === 0) {
      clearTimeout(this.historyRetryTimer)
      this.historyRetryTimer = undefined
      this.historyRetryDelay = 1_000
    } else if (!this.historyRetryTimer && !this.stopping) {
      this.historyRetryTimer = setTimeout(() => {
        this.historyRetryTimer = undefined
        this.applyEvents()
        // A failed whole-history write is compared again, with nothing from its host needed to start it.
        for (const threadId of [...this.recordsFailed]) this.recordOwed(threadId)
        this.scheduleHistoryRetry()
        this.publish()
      }, this.historyRetryDelay)
      this.historyRetryTimer.unref?.()
      this.historyRetryDelay = Math.min(this.historyRetryDelay * 2, 30_000)
    }
  }
  /** Posts one write; `confirmed` hears whether the writer confirmed it inside the post or later (`late`). */
  private post(write: ThreadStoreWrite, confirmed?: (outcome: ThreadStoreWriteOutcome, late: boolean) => void): void {
    const { admitted, refused } = this.admitted(write)
    let late = false
    const hear = confirmed && ((outcome: ThreadStoreWriteOutcome) =>
      confirmed(refused.size === 0 ? outcome : { ...outcome, failed: new Set([...outcome.failed, ...refused]) }, late))
    if (admitted) this.writes.post(admitted, hear)
    else hear?.({ failed: refused, error: CLEARED_THREAD_WRITE })
    late = true
  }
  /**
   * The part of a write the store may still take. A thread being cleared, or cleared, takes no more of its words, records,
   * visuals or wake-ups: posted after its forget, they would commit after the removal and outlive it. Removals still go.
   */
  private admitted(write: ThreadStoreWrite): { admitted: ThreadStoreWrite | undefined; refused: ReadonlySet<string> } {
    if (this.forgetting.size === 0 && this.clearedIds.size === 0) return { admitted: write, refused: NO_THREAD_IDS }
    const closed = (threadId: string): boolean => this.forgetting.has(threadId) || this.clearedIds.has(threadId)
    switch (write.kind) {
      case 'event-batches': {
        if (![...write.batches.keys()].some(closed)) return { admitted: write, refused: NO_THREAD_IDS }
        const batches = new Map([...write.batches].filter(([threadId]) => !closed(threadId)))
        return { admitted: batches.size ? { ...write, batches } : undefined, refused: new Set([...write.batches.keys()].filter(closed)) }
      }
      case 'activities': {
        if (!write.entries.some(entry => closed(entry.threadId))) return { admitted: write, refused: NO_THREAD_IDS }
        return { admitted: { ...write, entries: write.entries.filter(entry => !closed(entry.threadId)) }, refused: new Set(write.entries.map(entry => entry.threadId).filter(closed)) }
      }
      case 'events':
      case 'activity-list':
      case 'visual':
      case 'wake-up':
      case 'wake-ups':
        return closed(write.threadId) ? { admitted: undefined, refused: new Set([write.threadId]) } : { admitted: write, refused: NO_THREAD_IDS }
      default:
        return { admitted: write, refused: NO_THREAD_IDS }
    }
  }
  /**
   * Posts a write its caller cannot go on without, and throws its failure as the store would have: at once when the
   * writer confirmed it inside the post, so a caller on a writer that commits on main runs exactly as it did, or else
   * from the promise it returns.
   */
  private commit(write: ThreadStoreWrite): void | Promise<void> {
    let outcome: ThreadStoreWriteOutcome | undefined
    let settle: ((outcome: ThreadStoreWriteOutcome) => void) | undefined
    this.post(write, confirmed => { outcome = confirmed; settle?.(confirmed) })
    if (outcome) { throwIfFailed(outcome); return }
    return new Promise<ThreadStoreWriteOutcome>(resolve => { settle = resolve }).then(throwIfFailed)
  }
  /** Waits for a write `commit` or a save returned, when it returned one: a writer on main has already finished it. */
  private async waited(done: void | Promise<void>): Promise<void> {
    if (done) await done
  }
  /**
   * Posts what waits for this thread, or for every thread, and waits until the writer has confirmed it, and what waited
   * behind a batch already in flight: a read that needs the store itself reads after this. Events that arrive meanwhile
   * are not waited for. With a writer that commits on main nothing is left to wait for, and this does not yield.
   */
  private async settled(threadId?: string, includeAppends = false): Promise<void> {
    this.writeEvents(false, includeAppends)
    if (!this.writes.unconfirmed(threadId)) return
    await this.writes.confirmed(threadId)
    this.writeEvents(false, includeAppends)
    if (this.writes.unconfirmed(threadId)) await this.writes.confirmed(threadId)
  }
  /**
   * The events held for a thread that a read lays over what the store returns (#1457): every event posted and not yet
   * confirmed, then what waits behind a batch in flight. With nothing in flight, `withWaitingAppends` also lays the
   * appends at the head of what waits for the write window (#991), as the publish does; a read of the store itself asked
   * for those to be posted first, and goes without them. Only appends can lie over stored messages from what waits:
   * anything else waiting, such as a batch a failed write left behind, is not the store's to show from, exactly as it was
   * when every publish committed first. A thread whose batch failed lays nothing.
   */
  private heldEvents(threadId: string, withWaitingAppends: boolean): readonly ThreadEvent[] {
    if (this.failedEventThreads.has(threadId)) return NO_EVENTS
    const posted = this.writes.posted(threadId)
    const waiting = this.pendingEvents.get(threadId)
    const flying = this.inFlight.get(threadId)?.length ?? 0
    let rest: readonly ThreadEvent[] = NO_EVENTS
    // Behind a batch or an answer in flight, everything waiting is held for its turn, not left behind by a failure.
    if (waiting && (flying > 0 || this.answersInFlight.has(threadId))) rest = flying > 0 ? waiting.slice(flying) : waiting
    else if (waiting && withWaitingAppends && this.streamingPublishCostEnabled) {
      let leading = 0
      while (leading < waiting.length && waiting[leading]!.kind === 'message-text-appended') leading++
      if (leading > 0) rest = leading === waiting.length ? waiting : waiting.slice(0, leading)
    }
    return posted.length === 0 ? rest : rest.length === 0 ? posted : [...posted, ...rest]
  }
  /**
   * A window read from the store with the thread's held events laid over it (`heldEvents`). The window and the check of
   * which posted writes it already holds read the file at one moment (`ThreadStore.reading`).
   */
  private windowWithHeld(threadId: string, read: () => ThreadMessageWindow, withWaitingAppends: boolean): ThreadMessageWindow {
    return this.threadStore.reading(() => {
      const window = read()
      const events = this.heldEvents(threadId, withWaitingAppends)
      return events.length === 0 ? window : applyEventsToWindow(window, events, id => this.threadStore.message(threadId, id))
    })
  }
  /** One message as the store will hold it once what is held for its thread commits: it reads that message alone. */
  private messageWithHeld(threadId: string, messageId: string): AgentMessage | undefined {
    return this.threadStore.reading(() => applyEventsToMessage(messageId, this.heldEvents(threadId, false), id => this.threadStore.message(threadId, id)))
  }
  /**
   * A thread's whole history as the store will hold it once what was posted for it commits: for a read made while a
   * write is in flight, which reads it whole rather than waiting. It reads every message, so only a command reads it.
   */
  private historyWithHeld(threadId: string): AgentMessage[] {
    return this.windowWithHeld(threadId, () => this.threadStore.readMessages(threadId), false).messages
  }
  /**
   * What a handover reads (#1028). While a write for the thread is in flight, its whole history as the store will hold
   * it, read once, with the wake-ups this run's record names; otherwise the store itself. A handover reads by count.
   */
  private handoverStore(threadId: string): HandoverStore {
    const store = this.threadStore
    if (!this.writes.unconfirmed(threadId)) return store
    const wakeUps: ReadonlySet<string> = new Set([...store.wakeUps(threadId), ...this.wakeUpRecords.get(threadId) ?? []])
    // What is posted, read once: the pages below lay it over the store page by page, so the handover reads what it shows.
    const { events, lastStored } = store.reading(() => ({ events: this.heldEvents(threadId, false), lastStored: store.readMessages(threadId, { limit: 1 }).lastPosition }))
    if (keepsPositions(events)) {
      return {
        ephemeral: store.ephemeral,
        readMessages: (_id, options = {}) => pageWithEvents(page => store.readMessages(threadId, page), lastStored, events, options),
        messageIdentities: () => [...applyEventsToIdentities(store.messageIdentities(threadId), events, id => store.message(threadId, id))],
        message: (_id, messageId) => applyEventsToMessage(messageId, events, id => store.message(threadId, id)),
        wakeUps: () => wakeUps,
        activityCount: id => store.activityCount(id),
      }
    }
    // A reset or an alias moves the stored messages, so the history is read whole once, as it will stand.
    const messages = this.historyWithHeld(threadId)
    const byId = new Map(messages.map(message => [message.id, message]))
    return {
      ephemeral: store.ephemeral,
      readMessages: (_id, options = {}) => {
        const end = options.beforePosition === undefined ? messages.length : Math.max(0, Math.min(options.beforePosition, messages.length))
        const first = options.limit === undefined ? 0 : Math.max(0, end - options.limit)
        if (end <= first) return EMPTY_WINDOW
        return { messages: messages.slice(first, end), earlierAvailable: first > 0, firstPosition: first, lastPosition: end - 1 }
      },
      messageIdentities: () => messages.map(storedIdentity),
      message: (_id, messageId) => byId.get(messageId),
      wakeUps: () => wakeUps,
      activityCount: id => store.activityCount(id),
    }
  }
  /** Give every thread an event touched its window again, and its summary from the projection. */
  private applyEvents(): void {
    this.writeEvents()
    if (this.eventChanged.size === 0) { this.markWatcherReplies(); return }
    const changed = [...this.eventChanged]
    this.eventChanged.clear()
    for (const id of changed) {
      const thread = this.threadById(id)
      if (!thread) continue
      if (this.watched.has(id) || !this.declared) this.loadWindow(id)
      else { this.touched(thread).messages = []; delete thread.earlierAvailable; thread.summary = this.threadSummary(thread) }
    }
    this.markWatcherReplies()
  }
  /** Retain observed changes from history even while no pane holds Watcher's message window. */
  private markWatcherReplies(): void {
    if (!this.eventSourced || !this.watcherEnabled) return
    let changed = false
    for (const thread of this.state.snapshot.threads) if (thread.kind === 'watcher') {
      // Pane visibility cannot decide whether early edits survive the activity window. This temporary
      // history read includes the current user turn without putting a background transcript in the shell.
      const messages = thread.messages.length ? thread.messages : this.readWindow(thread.id, FIRST_WINDOW_TURNS)?.messages
      if (!messages?.length) continue
      const annotated = annotateWatcherOwnChanges({ ...thread, messages })
      let replaced = false
      for (const [index, message] of annotated.entries()) if (message !== messages[index]) {
        this.recordEvent(thread.id, { kind: 'message-replaced', at: new Date().toISOString(), message })
        changed = true; replaced = true
      }
      if (thread.messages.length) {
        // The same messages again are no change to the record; a message annotated afresh is.
        if (replaced || annotated.length !== thread.messages.length) this.touch(thread.id)
        thread.messages = annotated
      }
    }
    if (changed) this.writeEvents()
  }
  /** Every message the store holds for a thread, for an adapter about to read its provider's history. */
  messageIdentities(threadId: string): readonly StoredMessageIdentity[] {
    if (!this.threadVisible(threadId)) return []
    if (this.storeUnavailable) return []
    this.writeEvents(false, true)
    // An adapter seeds from this synchronously, so a write still in flight is laid over the store rather than waited for.
    // The identities are laid over, not the words: an adapter seeding reads no more while a write is in flight than after it.
    try {
      if (!this.writes.unconfirmed(threadId)) return this.threadStore.messageIdentities(threadId)
      return this.threadStore.reading(() => applyEventsToIdentities(this.threadStore.messageIdentities(threadId), this.heldEvents(threadId, false), id => this.threadStore.message(threadId, id)))
    }
    catch { return [] }
  }
  message(threadId: string, messageId: string): AgentMessage | undefined {
    if (!this.threadVisible(threadId)) return undefined
    if (this.storeUnavailable) return undefined
    this.writeEvents(false, true)
    // Not yet, while words wait that are not posted, as behind a failed batch or a thread being cleared: a caller that cannot
    // wait asks again once they have committed. What is posted, and what waits behind it, is laid over the one message.
    if (this.failedEventThreads.has(threadId) || this.forgetting.has(threadId) || (this.pendingEvents.has(threadId) && !this.inFlight.has(threadId) && !this.answersInFlight.has(threadId))) return undefined
    try { return this.writes.unconfirmed(threadId) || this.pendingEvents.has(threadId) ? this.messageWithHeld(threadId, messageId) : this.threadStore.message(threadId, messageId) }
    catch { return undefined }
  }
  /**
   * Commit everything waiting for this thread and say whether the store now holds it all. A
   * provider saves no transcript cursor past text this has not committed, so a crash cannot make
   * a saved cursor skip words the store never received (ADR-0016).
   */
  flushEvents(threadId: string): boolean {
    if (!this.threadVisible(threadId)) return true
    if (this.storeUnavailable) return !this.pendingEvents.has(threadId)
    this.writeEvents(false, true)
    // A batch posted and not yet confirmed is still held, so the cursor waits for its confirmation.
    return !this.pendingEvents.has(threadId) && !this.writes.unconfirmed(threadId)
  }
  /** Indexed historical task classification, never live monitoring or task/result text. */
  activity(threadId: string, activityId: string, historyEpoch?: string): AgentActivity | undefined {
    if (!this.threadVisible(threadId)) return undefined
    if (this.subagentUnavailable) return undefined
    try { return this.subagentStore.activity(threadId, activityId, historyEpoch) }
    catch { return undefined }
  }
  /** Historical classification only; live monitoring is never handed back to an adapter. */
  activities(threadId: string, historyEpoch?: string): readonly AgentActivity[] | undefined {
    if (!this.threadVisible(threadId)) return undefined
    const thread = this.threadById(threadId)
    if (!thread || thread.historyEpoch !== historyEpoch) return undefined
    if (this.storedActivity.has(threadId)) return this.storedActivities(threadId)
    if (!thread.activities) return undefined
    return structuredClone(thread.activities.slice(-MAX_AGENT_ACTIVITIES))
  }
  /** Whether `activities` would answer for this epoch, asked without reading a record (#918). */
  hasActivities(threadId: string, historyEpoch?: string): boolean {
    if (!this.threadVisible(threadId) || this.storeUnavailable || this.activityStoreUnavailable) return false
    const thread = this.threadById(threadId)
    return thread !== undefined && thread.historyEpoch === historyEpoch && (this.storedActivity.has(threadId) || thread.activities !== undefined)
  }
  /** A stored thread's records as an adapter is handed them: read for it and not kept, mapped as the startup read was (#918). */
  private storedActivities(threadId: string): AgentActivity[] | undefined {
    try {
      const activities = this.threadStore.readActivities(threadId, { keep: false }).slice(-MAX_AGENT_ACTIVITIES).map(savedRecord)
      const thread = this.threadById(threadId)
      if (thread) this.moveSubagentWords(thread, activities)
      return activities
    } catch {
      // As a failed read back does: saving stops, so the store keeps the records for the next start, and the user is told.
      this.activityStoreUnavailable = true
      this.saveError = ACTIVITY_READ_ERROR
      return undefined
    }
  }
  /**
   * Records what a provider published and answers with the messages this thread keeps in memory: the
   * loaded window while a pane is looking at it, nothing at all while none is.
   */
  private record(thread: AgentThread, messages: readonly AgentMessage[], previousEpoch: string | undefined): AgentMessage[] {
    // A thread being cleared takes no more of its words into the store; the next accept compares again if it is kept.
    if (!this.historyWritable() || this.forgetting.has(thread.id)) return [...messages]
    if (!this.recordHistory(thread, messages, previousEpoch)) return [...messages]
    if (!this.watched.has(thread.id)) return this.declared ? [] : this.withVisuals(thread.id, messages, true)
    const hidden = Math.min(this.hidden.get(thread.id) ?? 0, messages.length)
    if (hidden > 0) thread.earlierAvailable = true
    return this.withVisuals(thread.id, hidden > 0 ? messages.slice(hidden) : messages, hidden === 0)
  }
  /**
   * Posts what changed in a published history, or, while this thread's last such write is unconfirmed, keeps the history
   * to compare once it is, so nothing commits ahead of a write that may fail (#1457). Answers false when the write failed
   * at once.
   */
  private recordHistory(thread: AgentThread, messages: readonly AgentMessage[], previousEpoch: string | undefined): boolean {
    // Behind its own write in flight, an answer or a batch in flight, or a batch that failed: kept, and compared once it lands.
    if (this.historyHeld(thread.id)) {
      this.recordsOwed.set(thread.id, { messages, previousEpoch, answers: this.recordsOwed.get(thread.id)?.answers ?? [] })
      return true
    }
    // This comparison takes the place of any history held for the thread, and the answers that waited for it follow it.
    const owed = this.recordsOwed.get(thread.id)
    this.recordsOwed.delete(thread.id)
    const events = this.differences(thread.id, messages, thread.historyEpoch, previousEpoch)
    if (events.length) {
      let failed = false
      this.recordsInFlight.add(thread.id)
      this.post({ kind: 'events', threadId: thread.id, events }, (outcome, late) => {
        this.recordsInFlight.delete(thread.id)
        if (!writeFailed(outcome)) {
          this.recordsFailed.delete(thread.id)
          this.noteWritten(thread.id, events)
          // What the host published meanwhile is compared with the store as this write left it, and posted in turn.
          this.recordOwed(thread.id)
          // A confirmation heard after the post owes a publish: a client catching up reads the commit with it, and an
          // answer that waited behind the write is posted.
          if (late && !this.stopping) this.publishSoon()
          return
        }
        // The history is compared again, at the next publication or the history retry; answers given meanwhile follow it.
        this.recordsFailed.add(thread.id)
        const later = this.recordsOwed.get(thread.id)
        this.recordsOwed.set(thread.id, later ?? { messages, previousEpoch, answers: [] })
        this.scheduleHistoryRetry()
        failed = true
        // The whole history goes to the pane as it is, so nothing is above a window any more.
        this.saveError = HISTORY_SAVE_ERROR; this.hidden.delete(thread.id); this.storedAnchors.delete(thread.id)
        // The next accept compares this history again whatever it names, as every accept did before #925.
        this.remerge.add(thread.id)
        // A failure heard after the post: the store is compared afresh, and the thread published again.
        if (late) { this.known.delete(thread.id); this.touch(thread.id); if (!this.stopping) this.publishSoon() }
      })
      this.follow(thread.id, owed?.answers)
      if (failed) return false
      if (events[0]?.kind === 'messages-reset') this.hidden.delete(thread.id)
      this.known.set(thread.id, { epoch: thread.historyEpoch, messages: messages.map(markOf) })
      return true
    }
    // Nothing to write: the store already holds this history, so a write that failed before it needs no retry.
    this.recordsFailed.delete(thread.id)
    this.follow(thread.id, owed?.answers)
    return true
  }
  /**
   * Answers that waited for a history now compared go to the thread's waiting events, behind its write if it posted one,
   * and are posted as soon as nothing of the thread holds them: at once when the store already held that history.
   */
  private follow(threadId: string, answers: readonly AnswerGivenEvent[] | undefined): void {
    if (answers?.length) {
      const waiting = this.pendingEvents.get(threadId)
      if (waiting) waiting.push(...answers)
      else this.pendingEvents.set(threadId, [...answers])
    }
    if (this.pendingEvents.has(threadId) && !this.recordsInFlight.has(threadId) && !this.recordsFailed.has(threadId)) this.writeEvents(false, true)
  }
  /** Whether a thread's next whole-history write waits: behind its own, an answer or a batch in flight, or a batch that failed. */
  private historyHeld(threadId: string): boolean {
    return this.recordsInFlight.has(threadId) || this.answersInFlight.has(threadId) || this.inFlight.has(threadId) || this.failedEventThreads.has(threadId)
  }
  /** Compares and posts the history held for a thread, once nothing holds it; its answers follow (`recordHistory`). */
  private recordOwed(threadId: string): void {
    const owed = this.recordsOwed.get(threadId)
    if (!owed || this.historyHeld(threadId)) return
    const thread = this.threadById(threadId)
    if (!thread) {
      // The thread went: nothing of it is compared again, and what it held waits with whatever else it holds.
      this.recordsOwed.delete(threadId)
      this.recordsFailed.delete(threadId)
      this.follow(threadId, owed.answers)
      return
    }
    // While the thread is being cleared, or Keep local history is switching, the history and its answers wait for the outcome:
    // a clear that succeeds takes them with the thread, and one that fails, or a switch that finishes, compares them again.
    if (!this.historyWritable() || this.forgetting.has(threadId)) return
    this.recordHistory(thread, owed.messages, owed.previousEpoch)
  }
  private legacyMessages(thread: AgentThread, messages: readonly AgentMessage[]): readonly AgentMessage[] {
    let privateMessages = this.privateLegacyMessages.get(thread.id)
    if (!this.historyEnabled()) {
      if (!privateMessages) {
        privateMessages = new Set()
        this.privateLegacyMessages.set(thread.id, privateMessages)
      }
      for (const message of messages) privateMessages.add(message.id)
      return messages
    }
    return privateMessages ? messages.filter(message => !privateMessages.has(message.id)) : messages
  }
  /** Puts this thread's current window into memory: what the pane draws, and how much sits before it. */
  private loadWindow(threadId: string): void {
    const thread = this.threadById(threadId)
    if (!thread || !this.visible(thread)) return
    const window = this.readWindow(threadId, this.watched.get(threadId) ?? FIRST_WINDOW_TURNS)
    if (!window) return
    this.hidden.set(threadId, Math.max(0, window.firstPosition))
    this.touched(thread).messages = this.withVisuals(threadId, window.messages, !window.earlierAvailable)
    if (window.earlierAvailable) thread.earlierAvailable = true
    else delete thread.earlierAvailable
    thread.summary = this.threadSummary(thread, window.earlierAvailable ? undefined : window.messages)
  }
  /**
   * Every message the user sent before `beforeMessageId`, read from the store for the message scrubber (ADR-0109): the
   * prompts above the window a pane holds. Wake-ups are Sotto's, so they are left out, as the window leaves them unmarked.
   * Read only when a pane asks, and never published. Null when the store cannot answer.
   */
  async threadPrompts(threadId: string, beforeMessageId: string): Promise<AgentThreadPrompts | null> {
    const thread = this.threadById(threadId)
    if (!thread || !this.visible(thread) || this.storeUnavailable) return null
    await this.settled(threadId)
    if (this.storeUnavailable) return null
    try {
      const skip = new Set([...this.wakeUpRecords.get(threadId) ?? [], ...this.hiddenWakeUpRecords.get(threadId) ?? [],
        ...this.threadStore.wakeUps(threadId), ...this.threadStore.hiddenWakeUps(threadId)])
      return this.threadStore.promptsBefore(threadId, beforeMessageId, skip)
    } catch { return null }
  }
  /** A thread no pane is looking at goes back to its summary alone. */
  private unloadWindow(threadId: string): void {
    const thread = this.threadById(threadId)
    if (!thread) return
    this.touched(thread).summary = this.threadSummary(thread, thread.earlierAvailable ? undefined : thread.messages)
    thread.messages = []
    delete thread.earlierAvailable
  }
  /**
   * Widens the pane's window by another twenty turns, because the user pressed Show earlier messages, or back to a message
   * the user sent, because they pressed its tick in the message scrubber (ADR-0109). The store holds the whole history;
   * only how much of it is in memory changes here.
   */
  async loadEarlierMessages(threadId: string, throughMessageId?: string): Promise<AgentHostSnapshot> {
    await this.initialize()
    this.thread(threadId)
    const turns = this.watched.get(threadId) ?? FIRST_WINDOW_TURNS
    let through: number | undefined
    if (throughMessageId !== undefined && !this.storeUnavailable) {
      await this.settled(threadId)
      try { through = this.threadStore.turnsFrom(threadId, throughMessageId) } catch { this.saveError = HISTORY_SAVE_ERROR }
    }
    this.watched.set(threadId, throughMessageId === undefined ? turns + LATER_WINDOW_TURNS : Math.max(turns, through ?? turns))
    this.loadWindow(threadId)
    this.publish()
    return this.workspaceSnapshot()
  }
  /**
   * The records a pane is given beside this thread's loaded window, decided a turn at a time. A turn's
   * anchors are the messages its records followed, and its own ID when that names a message (Claude, Grok
   * and Devin name a turn after its prompt). The window is the newest tail of the store, so a turn with an
   * anchor among the loaded messages is inside it; one whose anchors the store holds elsewhere is above it
   * and waits there with its messages until the window widens, however new a provider re-read made its
   * records; one the store knows nothing of is given, for the pane to place. The live turn is always given.
   *
   * A thread no pane is looking at holds no messages, so everything but its live turn is above its window.
   * The records themselves are untouched: the store, the summary and the adapters read them whole.
   */
  paneActivities(threadId: string, activities: readonly AgentActivity[]): readonly AgentActivity[] {
    if (!this.threadVisible(threadId)) return []
    const thread = this.threadById(threadId)
    if (this.storeUnavailable || !thread || !activities.length) return activities
    const watched = !this.declared || this.watched.has(threadId)
    const hidden = watched ? this.hidden.get(threadId) ?? 0 : 0
    if (watched && hidden <= 0) return activities
    const held = this.paneViews.get(activities)
    if (held && held.messages === thread.messages && held.hidden === hidden && held.watched === watched && held.status === thread.status
      && held.generation === (this.storedAnchors.get(threadId)?.generation ?? 0)) return held.records

    const live = liveTurn(activities, thread.status)
    let records: readonly AgentActivity[]
    if (!watched) records = activities.filter(record => record.turnId === live)
    else {
      let loaded = this.loadedIds.get(thread.messages)
      if (!loaded) { loaded = new Set(thread.messages.map(message => message.id)); this.loadedIds.set(thread.messages, loaded) }
      const anchors = new Map<string, Set<string>>()
      for (const record of activities) {
        let ids = anchors.get(record.turnId)
        if (!ids) { ids = new Set(); anchors.set(record.turnId, ids) }
        if (record.afterMessageId !== undefined) ids.add(record.afterMessageId)
      }
      const above = new Set<string>()
      for (const [turnId, ids] of anchors) {
        ids.add(turnId)
        if (turnId === live || [...ids].some(id => loaded.has(id))) continue
        const stored = this.storesAny(threadId, ids)
        if (stored === undefined) return activities
        if (stored) above.add(turnId)
      }
      records = above.size ? activities.filter(record => !above.has(record.turnId)) : activities
    }
    if (isImmutableActivities(activities)) records = immutableActivities(records)
    this.paneViews.set(activities, { messages: thread.messages, hidden, watched, status: thread.status,
      generation: this.storedAnchors.get(threadId)?.generation ?? 0, records })
    return records
  }
  /** Whether the store holds any of these messages, asking only about the ones it has not answered for yet. */
  private storesAny(threadId: string, ids: Iterable<string>): boolean | undefined {
    let entry = this.storedAnchors.get(threadId)
    if (!entry) { entry = { answers: new Map(), generation: ++this.anchorGeneration }; this.storedAnchors.set(threadId, entry) }
    for (const id of ids) {
      let answer = entry.answers.get(id)
      if (answer === undefined) {
        try { answer = this.threadStore.hasMessage(threadId, id) }
        catch { return undefined }
        entry.answers.set(id, answer)
      }
      if (answer) return true
    }
    return false
  }
  /** Keeps the store's answers true to what was just written: a reset voids them, an added message is now held. */
  private noteWritten(threadId: string, events: readonly ThreadEvent[]): void {
    const entry = this.storedAnchors.get(threadId)
    if (!entry) return
    if (events.some(event => event.kind === 'messages-reset' || event.kind === 'message-aliased')) { this.storedAnchors.delete(threadId); return }
    let changed = false
    for (const event of events) {
      if (event.kind === 'message-added' && entry.answers.get(event.message.id) === false) { entry.answers.set(event.message.id, true); changed = true }
    }
    if (changed) entry.generation = ++this.anchorGeneration
  }
  /** Exact text-free acceptance evidence, including the current unwritten native echo. */
  hasRecordedUserMessage(threadId: string, messageId: string): boolean {
    if (!this.ready || !this.threadVisible(threadId)) return false
    this.writeEvents()
    // What waits, and what is posted and not yet confirmed, is evidence before the store holds it.
    const recorded = (event: ThreadEvent): boolean => recordedUserMessage(event) === messageId
    if (this.pendingEvents.get(threadId)?.some(recorded) || this.writes.posted(threadId).some(recorded)) return true
    const thread = this.threadById(threadId)
    if (thread?.messages.some(message => message.id === messageId && message.role === 'user')) return true
    return !this.storeUnavailable && this.threadStore.hasRecordedUserMessage(threadId, messageId)
  }

  /**
   * Sotto's own stored user messages created before `before`, for the Usage history import (ADR-0083): identities,
   * instants, the thread's provider and model and whether babysitting sent each. The store query names no text column.
   * False until the thread store can be read.
   */
  async visitRecordedUserMessages(visitor: (message: UsageRecordedUserMessage) => void, before?: string): Promise<boolean> {
    if (!this.ready || this.storeUnavailable) return false
    const store = this.threadStore as ThreadStore & Partial<UserMessageInstantSource>
    if (typeof store.visitUserMessageInstants !== 'function') return false
    // The import reads the store's own rows once, so it waits for what every thread has posted.
    await this.settled()
    if (!this.ready || this.storeUnavailable) return false
    const threads = new Map(this.state.snapshot.threads.map(thread => [thread.id, thread]))
    store.visitUserMessageInstants(message => {
      const thread = threads.get(message.threadId)
      if (!thread || !isUsageProviderId(thread.providerId) || !this.threadVisible(thread.id)) return
      visitor({ threadId: thread.id, messageId: message.messageId, providerId: thread.providerId, modelId: thread.modelId || 'unknown',
        at: message.at, wakeUp: message.wakeUp })
    }, before)
    return true
  }

  /** Flush once and recover exact numeric identities without reading a transcript for each pending intent. */
  recordedUserMessages(identities: readonly RecordedUserMessageIdentity[]): RecordedUserMessageIdentity[] {
    if (identities.length > RECORDED_USER_MESSAGES_MAX) throw new RangeError('Too many message identities')
    if (!this.ready || identities.length === 0) return []
    this.writeEvents()
    const requested = new Map<string, Set<string>>()
    for (const { threadId, messageId } of identities) {
      let ids = requested.get(threadId)
      if (ids === undefined) { ids = new Set(); requested.set(threadId, ids) }
      ids.add(messageId)
    }
    const accepted = new Map<string, Set<string>>()
    for (const [threadId, ids] of requested) {
      if (!this.threadVisible(threadId)) { requested.delete(threadId); continue }
      const found = new Set<string>()
      for (const events of [this.pendingEvents.get(threadId) ?? NO_EVENTS, this.writes.posted(threadId)]) for (const event of events) {
        const id = recordedUserMessage(event)
        if (id !== undefined && ids.has(id)) found.add(id)
      }
      for (const message of this.threadById(threadId)?.messages ?? []) {
        if (message.role === 'user' && ids.has(message.id)) found.add(message.id)
      }
      accepted.set(threadId, found)
    }
    const unresolved = identities.filter(({ threadId, messageId }) => requested.has(threadId) && !accepted.get(threadId)?.has(messageId))
    if (!this.storeUnavailable) {
      for (const { threadId, messageId } of this.threadStore.recordedUserMessages(unresolved)) accepted.get(threadId)!.add(messageId)
    }
    const result: RecordedUserMessageIdentity[] = []
    for (const identity of identities) {
      if (accepted.get(identity.threadId)?.delete(identity.messageId)) result.push({ threadId: identity.threadId, messageId: identity.messageId })
    }
    return result
  }
  /** One thread's whole history, whatever window is loaded: the store is the record, not the pane. */
  threadMessages(threadId: string): readonly AgentMessage[] {
    if (!this.threadVisible(threadId)) return []
    this.writeEvents(false, true)
    const thread = this.threadById(threadId)
    if (this.storeUnavailable) return thread?.messages ?? []
    if (thread && thread.messages.length > 0 && !thread.earlierAvailable) return thread.messages
    return this.readWindow(threadId)?.messages ?? thread?.messages ?? []
  }
  /**
   * Records that a request was answered, and by which client, in the thread's own log (ADR-0016). The
   * answer's words are never written: an answer can read like a prompt, and the log says what happened
   * rather than what was said. Nothing is projected from it, so a failed write costs the record alone.
   */
  recordAnswer(threadId: string, event: AnswerGivenEvent): void {
    if (!this.threadVisible(threadId)) return
    if (this.storeUnavailable || this.clearedIds.has(threadId)) return
    // The answer lands in the log after the words it answered, held appends included: writes commit in the order posted.
    if (this.streamingPublishCostEnabled) this.writeEvents(false, true)
    // Behind words still held, in flight, waiting for a failed batch's retry or held while the thread is cleared, the
    // answer waits with them, so it is posted after them and its batch is retried with theirs.
    // A history-publishing host's history held for the thread is what this answers: the answer follows its write.
    const owed = this.recordsOwed.get(threadId)
    if (owed) {
      if (!this.historyEnabled()) this.pendingEventsPrivate = true
      owed.answers.push(event)
      return
    }
    const waiting = this.pendingEvents.get(threadId)
    // A history-publishing host's write in flight, or one that failed and waits for its retry, holds the answer the same way.
    if (waiting || this.forgetting.has(threadId) || this.recordsInFlight.has(threadId) || this.recordsFailed.has(threadId)) {
      if (!this.historyEnabled()) this.pendingEventsPrivate = true
      if (waiting) waiting.push(event)
      else this.pendingEvents.set(threadId, [event])
      this.writeEvents(false, true)
      return
    }
    this.answersInFlight.set(threadId, (this.answersInFlight.get(threadId) ?? 0) + 1)
    this.post({ kind: 'events', threadId, events: [event] }, (outcome, late) => {
      const left = (this.answersInFlight.get(threadId) ?? 1) - 1
      if (left > 0) this.answersInFlight.set(threadId, left)
      else this.answersInFlight.delete(threadId)
      if (writeFailed(outcome)) this.saveError = HISTORY_SAVE_ERROR
      // A history the host published behind the answer is compared now; words that waited are posted at the next publish.
      if (left === 0) this.recordOwed(threadId)
      if (late && left === 0 && this.pendingEvents.has(threadId) && !this.stopping) this.publishSoon()
    })
  }
  /** What a client reads to catch up: every thread event after `seq`, with anything still buffered written first (ADR-0016). */
  eventsAfter(seq: number, threadId?: string, limit?: number): StoredThreadEvent[] {
    if (this.storeUnavailable) return []
    // Read on every shell a socket is pushed, so it never waits. An event posted and not yet confirmed takes its sequence
    // when it commits, after every one read here, and the publish its confirmation makes carries it in the next page.
    this.writeEvents(false, true)
    return this.threadStore.eventsAfter(seq, threadId, limit, this.dormantThreadIds())
  }
  private stopDelivery(): void {
    this.stopping = true
    this.deliveryStopped = true
    for (const unsubscribe of this.providerSubscriptions.splice(0)) unsubscribe()
  }
  /** Finish command lanes before detaching provider delivery and closing SQLite. */
  async close(): Promise<void> {
    this.stopping = true
    // Closing waits a minute at most, whatever holds it: a store worker that stops answering costs that, and what it did
    // not answer is reported as not saved (ADR-0016, October 26 amendment).
    const deadline = Date.now() + CLOSE_LIMIT_MS
    // A stored thread's records still on their way carry what its provider published meanwhile, which the last save keeps.
    let inTime = await this.beforeDeadline(Promise.allSettled([...this.branchWrites, ...this.lanes.values(), ...this.interruptLanes.values(), ...this.remoteStatusReads,
      ...[...this.activityReads.values()].map(read => read.done)]), deadline)
    this.stopDelivery()
    // Quitting loses no commit: what was posted is confirmed before the store closes.
    try {
      if (this.ready && inTime) inTime = await this.beforeDeadline((async () => { await this.flush(); if (this.writes.unconfirmed()) await this.settled(undefined, true) })(), deadline)
    } finally {
      this.closeDeadline = deadline
      this.dispose()
    }
    if (!inTime) { console.warn('thread-store-close-timed-out'); throw new Error(HISTORY_SAVE_ERROR) }
    if (this.pendingEvents.size) throw new Error(HISTORY_SAVE_ERROR)
  }
  /** Whether `work` settled before `deadline`. A failure it meets in time is thrown; one after is left, as it is no longer waited for. */
  private async beforeDeadline(work: Promise<unknown>, deadline: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); timer.unref?.() })
    work.catch(() => undefined)
    try { return await Promise.race([work.then(() => true as const), late]) } finally { clearTimeout(timer) }
  }

  /** What is left of the minute closing may take, once `close` began; undefined for a dispose on its own. */
  private closeRemaining(): number | undefined {
    return this.closeDeadline === undefined ? undefined : Math.max(0, this.closeDeadline - Date.now())
  }
  /** Closes the history store. Called when the app quits, after the last flush. */
  dispose(): void {
    this.stopDelivery()
    clearTimeout(this.publishTimer); clearTimeout(this.writeTimer); clearTimeout(this.historyRetryTimer)
    this.historyRetryTimer = undefined
    for (const { timer } of this.worktreeRefreshes.values()) clearTimeout(timer)
    this.worktreeRefreshes.clear()
    this.refreshesOwed.clear()
    if (this.gitStatusTimer) { clearInterval(this.gitStatusTimer); this.gitStatusTimer = undefined }
    // A roster that cannot reach the disk leaves the records unstripped, as the flush does.
    const unsaved = 'Thread activity could not be saved. Restore local storage and restart Sotto.'
    try {
      if (this.ready) {
        this.writeEvents(true)
        // What waited behind a batch in flight is posted once that batch is confirmed, which shutdown cannot wait for.
        if (this.inFlight.size || this.answersInFlight.size) { this.writes.drain(this.closeRemaining()); this.writeEvents(true) }
        const saved = this.saveActivities(!this.rosterOnDisk(), true)
        if (saved) saved.catch(() => { this.saveError = unsaved })
      }
    }
    catch { this.saveError = unsaved }
    // Closing confirms everything posted before the store closes, so quitting loses no commit.
    finally { this.writes.close(this.closeRemaining()); this.subagentStore.close() }
    if (this.subagentTimer) clearTimeout(this.subagentTimer)
    this.subagentChanges.clear(); this.subagentListeners.clear()
    this.activityInputs.clear(); this.activityListeners.clear(); this.listeners.clear(); this.settledThreadListeners.clear()
    this.published = new ThreadMap({ verify: false }); this.unpublishedAll = true
    this.subagentInputs.clear()
    this.ready = false
  }

  async subagentPage(request: SubagentPageRequest) {
    await this.initialize(); this.thread(request.threadId)
    if (this.subagentUnavailable) throw new Error('Agent history is unavailable. Restore access to local storage and restart Sotto.')
    return this.subagentStore.page(request)
  }
  async subagentAssignments(request: SubagentAssignmentsRequest) {
    await this.initialize(); this.thread(request.threadId)
    if (this.subagentUnavailable) throw new Error('Agent history is unavailable. Restore access to local storage and restart Sotto.')
    return this.subagentStore.assignments(request)
  }
  subscribeSubagents(listener: (change: SubagentChange) => void): () => void {
    this.subagentListeners.add(listener)
    return () => this.subagentListeners.delete(listener)
  }
  private subagentsChanged(change: SubagentChange | undefined): void {
    if (!change) return
    this.subagentSummaries.set(change.threadId, change.summary)
    this.touch(change.threadId)
    const pending = this.subagentChanges.get(change.threadId)
    const rows = new Map((change.reset ? [] : pending?.rows ?? []).map(row => [row.id, row]))
    for (const row of change.rows) rows.set(row.id, row)
    this.subagentChanges.set(change.threadId, { ...change, rows: [...rows.values()], ...(pending?.reset ? { reset: true } : {}) })
    if (this.subagentTimer) return
    this.subagentTimer = setTimeout(() => {
      this.subagentTimer = undefined
      const changes = [...this.subagentChanges.values()]; this.subagentChanges.clear()
      for (const next of changes) for (const listener of this.subagentListeners) listener(next)
    }, PUBLISH_WINDOW_MS)
    this.subagentTimer.unref?.()
  }
  /** Only changed native observations enter the indexed roster; its archive never enters a host snapshot. */
  /** Whether the roster took the thread's records; false when it is unavailable or its write failed. */
  private trackSubagents(thread: AgentThread, connected: boolean): boolean {
    if (this.subagentUnavailable) return false
    try {
      let input = this.subagentInputs.get(thread.id)
      if (!input || input.epoch !== thread.historyEpoch) {
        input = { epoch: thread.historyEpoch, records: new Map(), activities: undefined }
        this.subagentInputs.set(thread.id, input)
        this.subagentsChanged(this.subagentStore.ingest(thread.id, [], thread.historyEpoch))
      }
      if (!isImmutableActivities(thread.activities) || input.activities !== thread.activities) {
        const observations: NonNullable<AgentActivity['agents']> = []
        const classifications: AgentActivity[] = []
        const retained = new Set<string>()
        for (const activity of thread.activities ?? []) {
          if (activity.kind !== 'subagent' && !activity.agents?.length && activity.taskUpdatesExcluded === undefined) continue
          retained.add(activity.id)
          const fingerprint = createHash('sha256').update(JSON.stringify([subagentActivityClassification(activity), activity.agents])).digest('hex')
          if (input.records.get(activity.id) === fingerprint) continue
          input.records.set(activity.id, fingerprint)
          classifications.push(activity)
          for (const agent of activity.agents ?? []) {
            const fresh = agent.observedAt !== undefined && Date.parse(agent.observedAt) >= (this.subagentLiveSince.get(thread.id) ?? this.startedAt)
            const working = observedSubagentStatus(agent.status) === 'running'
            observations.push(working && (!connected || !fresh) ? { ...agent, status: 'unknown' } : agent)
          }
        }
        for (const id of input.records.keys()) if (!retained.has(id)) input.records.delete(id)
        input.activities = thread.activities
        if (observations.length || classifications.length) this.subagentsChanged(this.subagentStore.ingest(thread.id, observations, thread.historyEpoch, classifications))
      }
      if (!connected) {
        this.subagentLiveSince.set(thread.id, Date.now())
        this.subagentsChanged(this.subagentStore.markUnknown(thread.id))
      }
      if (!this.subagentSummaries.has(thread.id)) this.subagentSummaries.set(thread.id, this.subagentStore.state(thread.id).summary)
    } catch {
      // An unchanged provider snapshot still needs retrying when its store transaction failed: the next accept merges this
      // thread again whatever it names, as every accept merged every thread before #925.
      this.subagentInputs.delete(thread.id)
      this.remerge.add(thread.id)
      // Words still being moved stay in their records: nothing strips them while the roster lacks them.
      if (this.subagentWordsPending || this.rosterFlushPending) this.rosterLacksWords = true
      this.saveError = this.rosterLacksWords ? ROSTER_LACKS_WORDS_ERROR : 'Agent history could not be saved. Restore access to local storage and refresh.'
      return false
    }
    return true
  }

  async listThreadSkills(threadId: string, forceReload = false) {
    await this.initialize()
    const thread = this.threadById(threadId)
    if (!thread || !this.visible(thread) || !this.inner.listThreadSkills) throw new Error('Skills are unavailable for this thread.')
    const workingDirectory = thread.nativeSessionStarted === false && thread.worktree?.status === 'pending' && !thread.worktree.path
      ? await existingWorkingDirectory(this.state.snapshot.projects.find(item => item.id === thread.projectId)!.path)
      : await this.threadWorkingDirectory(threadId)
    const creation = this.creationOf(threadId)
    if (creation && (creation.phase === 'unstarted' || creation.phase === 'retryable')) {
      const project = this.state.snapshot.projects.find(project => project.id === thread.projectId)
      if (!project || !thread.providerId) throw new Error('This thread has no available working folder.')
      return this.withProfileRefusal(threadId, () => this.inner.listThreadSkills!(threadId, forceReload, { providerId: thread.providerId!, workingDirectory }))
    }
    return this.withProfileRefusal(threadId, () => this.inner.listThreadSkills!(threadId, forceReload))
  }
  preservesWatcherThread(threadId: string): boolean { return !this.watcherEnabled && this.watcherThreadIds().includes(threadId) }
  preservesDormantThread(threadId: string): boolean { return !this.threadVisible(threadId) }
  dormantThreadIds(): readonly string[] {
    return [...new Set([...(this.watcherEnabled ? [] : this.retainedWatcherIds), ...this.state.snapshot.threads.filter(thread => !this.visible(thread)).map(thread => thread.id)])]
  }
  dormantThreadProviders(): ReadonlyMap<string, ProviderId> {
    const providers = new Map<string, ProviderId>()
    for (const thread of this.state.snapshot.threads) {
      const provider = heldProviderOfThreadRecord(thread, this.held)
      if (provider) providers.set(thread.id, provider)
    }
    return providers
  }
  watcherThreadIds(): readonly string[] {
    return [...new Set([...this.retainedWatcherIds, ...this.state.snapshot.threads.filter(thread => thread.kind === 'watcher' || thread.kind === 'watcher-history').map(thread => thread.id)])]
  }
  workspaceSnapshot(): AgentHostSnapshot {
    this.applyEvents()
    const snapshot = cloneHostSnapshot(this.visibleSnapshot(this.state.snapshot))
    this.historyNotices(snapshot)
    if (this.failedEventThreads.size) snapshot.error = HISTORY_SAVE_ERROR
    else if (this.saveError) snapshot.error = this.saveError
    return snapshot
  }
  private historyNotices(snapshot: AgentHostSnapshot): void {
    for (const thread of snapshot.threads.filter(thread => this.visible(thread))) {
      if (this.invalidEventThreads.has(thread.id)) thread.historySaveNotice = HISTORY_SAVE_NOTICE
    }
  }
  private publish(): void {
    if (this.babysatClosedListeners.size && this.babysatThreadClosed()) for (const listener of this.babysatClosedListeners) listener()
    if (this.settledThreadListeners.size) {
      const ids = this.settledThreadIds()
      for (const listener of this.settledThreadListeners) listener(ids)
    }
    for (const listener of this.listeners) listener(this.workspaceSnapshot())
    if (this.activityListeners.size) {
      const snapshot = this.activityPublication()
      for (const listener of this.activityListeners) listener(snapshot)
    } else if (this.changes.size) { this.applyEvents(); this.refreshPublished() }
    // Built when its publisher builds it, which for a publish made from inside a listener is once every listener has the last.
    if (this.changes.size) this.changes.publishChanges((_, published) => this.workspaceChanges(published))
  }
  /**
   * One publication for every activity subscriber: the coordinator takes it as its own and changes only what it builds
   * over it, and usage reads it as it arrives and keeps none of it. It was a copy each, and each copied every thread.
   * Its thread records are frozen and owned, and a thread that has not changed since the last publication is the very
   * record that one carried, so a publish copies only the threads that changed (#1326). It is built from the
   * publication's map (`published`), which reads again only the threads marked since the last, so a publish costs a
   * reference per thread (#925). The snapshot around the threads and its thread list are each publication's own.
   */
  private activityPublication(): AgentHostSnapshot {
    this.applyEvents()
    this.refreshPublished()
    return { ...this.published.rest!, threads: this.published.threads() } as AgentHostSnapshot
  }
  /**
   * Everything an activity publication carries but its threads, as the state holds it now, with an empty thread list where
   * the threads go: the providers, catalog and projects this run shows, and the error a save left.
   */
  private publicationRest(): AgentHostSnapshot {
    const snapshot = this.state.snapshot
    const rest: AgentHostSnapshot = { ...snapshot, threads: NO_THREADS, ...(this.held.size ? catalogWithoutHeld(snapshot, this.held) : {}) }
    if (this.failedEventThreads.size) rest.error = HISTORY_SAVE_ERROR
    else if (this.saveError) rest.error = this.saveError
    return rest
  }
  /** A thread as the publication carries it. The notice is the publication's, never the workspace's record: a thread that carries one is a new record over it. */
  private publicationSource(thread: AgentThread): AgentThread {
    return this.invalidEventThreads.has(thread.id) ? { ...thread, historySaveNotice: HISTORY_SAVE_NOTICE } : thread
  }
  /** The publication worked out from every visible thread, as it was before #925: what verifying checks the map against. */
  private wholePublication(): AgentHostSnapshot {
    return { ...this.publicationRest(), threads: this.state.snapshot.threads.filter(thread => this.visible(thread)).map(thread => this.publicationSource(thread)) }
  }
  /**
   * Brings the publication's map up to the state (#925). Only the threads marked since the last (`unpublished`) are read,
   * each against the record the map holds for it, which comes back as itself when it has not changed. A thread that is
   * gone or out of view is removed, and one new to the publication goes last, as the state's own list grows. One that
   * comes anywhere else, and everything after a whole accept or a change to every thread, is worked out from every
   * thread, as each publication was. Answers how many thread records it read.
   */
  private refreshPublished(): number {
    const published = this.published
    const [rest] = immutableUpdates([this.publicationRest()], [published.rest as AgentHostSnapshot | undefined])
    const sequence = (published.sequence ?? 0) + 1
    if (this.unpublishedAll || published.sequence === undefined || this.acceptsWhole) return this.republishAll(rest!, sequence)
    const threads = this.state.snapshot.threads
    const upserts: AgentThread[] = [], removals: string[] = [], added: { readonly index: number; readonly record: AgentThread }[] = []
    const sources: AgentThread[] = [], positions: number[] = []
    for (const id of this.unpublished) {
      const at = this.positionOf(id)
      const thread = at === undefined ? undefined : threads[at]
      if (thread && this.visible(thread)) { sources.push(this.publicationSource(thread)); positions.push(at!) }
      else if (published.has(id)) removals.push(id)
    }
    // One call for every thread read, as one publication's records were always copied over the last one's.
    const previous = sources.map(thread => published.get(thread.id))
    const records = immutableUpdates(sources, previous)
    for (let index = 0; index < records.length; index++) {
      if (!previous[index]) added.push({ index: positions[index]!, record: records[index]! })
      else if (records[index] !== previous[index]) upserts.push(records[index]!)
    }
    const read = sources.length
    if (added.length) {
      const last = published.lastId === undefined ? -1 : this.positionOf(published.lastId)
      if (last === undefined || added.some(item => item.index <= last)) return this.republishAll(rest!, sequence)
      upserts.push(...added.sort((left, right) => left.index - right.index).map(item => item.record))
    }
    this.unpublished.clear()
    published.apply({ sequence, upserts, removals, ...(rest !== published.rest ? { rest } : {}) })
    if (this.changes.size) {
      for (const record of upserts) this.changesSince.ids.add(record.id)
      for (const id of removals) this.changesSince.ids.add(id)
    }
    return read
  }
  /** Every visible thread read against the publication's record, and the map brought to them, removals and order and all. */
  private republishAll(rest: AgentHostSnapshot, sequence: number): number {
    this.unpublishedAll = false
    this.unpublished.clear()
    const published = this.published
    const sources = this.state.snapshot.threads.filter(thread => this.visible(thread)).map(thread => this.publicationSource(thread))
    const threads = immutableUpdates(sources, sources.map(thread => published.get(thread.id)))
    const order = published.sequence === undefined || this.acceptsWhole ? undefined : orderBetween(published, threads)
    if (!order) {
      published.apply({ sequence, whole: true, upserts: threads, removals: [], rest })
      this.changesSince.whole = true
      return threads.length
    }
    const upserts = threads.filter(record => published.get(record.id) !== record)
    published.apply({ sequence, upserts, removals: order.removals, ...(order.placements.length ? { placements: order.placements } : {}), ...(rest !== published.rest ? { rest } : {}) })
    if (this.changes.size) {
      for (const record of upserts) this.changesSince.ids.add(record.id)
      for (const id of order.removals) this.changesSince.ids.add(id)
      for (const { id } of order.placements) { this.changesSince.ids.add(id); this.changesSince.placed.add(id) }
    }
    return threads.length
  }
  /**
   * The workspace's thread changes since `published`, what its subscribers were last sent, read off the publication's map
   * when the publisher builds them, and the marks taken then: each thread that changed is upserted as the publication
   * carries it, or removed, and a thread that came or moved is placed just before the thread that follows it. A first
   * publication, one after the publication was worked out whole, and one whose placements the subscribers could not apply
   * are whole.
   */
  private workspaceChanges(published: ThreadMap | undefined): ThreadChangeSet {
    const since = this.changesSince, map = this.published
    const whole = since.whole, ids = [...since.ids], placed = new Set(since.placed)
    since.whole = false; since.ids.clear(); since.placed.clear()
    const everything = (): ThreadChangeSet => ({ whole: true, upserts: map.threads(), removals: [], rest: map.rest! })
    if (!published || whole) return everything()
    const upserts: AgentThread[] = [], removals: string[] = [], placing: string[] = []
    const upserted = new Set<string>()
    for (const id of ids) {
      const record = map.get(id)
      if (record) {
        upserts.push(record); upserted.add(id)
        if (!published.has(id) || placed.has(id)) placing.push(id)
      } else if (published.has(id)) removals.push(id)
    }
    const placements: ThreadPlacement[] = []
    for (const id of placing) {
      const beforeId = map.nextId(id) ?? null
      if (beforeId !== null && !upserted.has(beforeId) && !published.has(beforeId)) return everything()
      placements.push({ id, beforeId })
    }
    return { upserts, removals, ...(placements.length ? { placements: inPlacingOrder(placements) } : {}), ...(map.rest !== published.rest ? { rest: map.rest! } : {}) }
  }

  /** Native snapshots upsert records. Reused input records have already been merged, so only changed
   * records need that work again. An epoch, mutable input or replacement of the held output reconciles
   * the complete list; array identity is never evidence for legacy mutable snapshots. */
  private mergeActivities(thread: AgentThread, old: AgentThread | undefined): AgentActivity[] | undefined {
    const input = thread.activities
    // A stored thread (#918) keeps its list in the store while input brings nothing to it: none, an empty list, or the
    // same certified array as last time. Merging with an empty list never removes a record, so that is what merging gave.
    // A new history epoch replaces the list, as below. Anything else reads the stored list back first and merges onto
    // it, so sequence, anchors and finished states are kept; merging onto nothing would renumber every record.
    if (old && this.storedActivity.has(thread.id)) {
      const reading = this.activityReads.get(thread.id)
      if (old.historyEpoch !== thread.historyEpoch) { this.storedActivity.delete(thread.id); this.letReadGo(thread.id) }
      else if (input !== undefined && input.length > 0 && this.storedInputs.get(thread.id) !== input) {
        // While the store worker reads the list back, the record waits to merge onto it (`activitiesArrived`); the same
        // array published again is the same input.
        if (reading) { if (reading.held.at(-1)?.activities !== input) reading.held.push(thread); return undefined }
        this.heldForInput.set(thread.id, this.holdActivities(old))
      } else {
        // The array kept for this comparison is only ever the one the provider is still publishing, which it holds anyway.
        if (this.storedInputs.get(thread.id) !== input) this.storedInputs.delete(thread.id)
        return undefined
      }
      this.storedInputs.delete(thread.id)
    }
    // A thread its provider has not read this run, as Codex before one is opened, comes with no activity, so what the
    // workspace holds is the whole list. Merging it with nothing gives the same records, so it is certified once and then
    // kept as it is, rather than rebuilt on every accept and copied whole into every publish and save (#917).
    if (input === undefined && old?.activities && old.historyEpoch === thread.historyEpoch) {
      return isImmutableActivities(old.activities) ? old.activities : immutableActivities(mergeAgentActivities(old.activities, []))
    }
    const previous = this.activityInputs.get(thread.id)
    const stable = isImmutableActivities(input)
    const reusable = stable && previous && old && previous.epoch === thread.historyEpoch
      && old.historyEpoch === thread.historyEpoch && old.activities === previous.output
    if (reusable && previous.input === input) return previous.output
    const incoming = reusable ? input!.filter(record => previous.records.get(record.id) !== record) : input ?? []
    const combined = old?.historyEpoch !== thread.historyEpoch ? input ?? [] : mergeAgentActivities(old?.activities, incoming)
    // A wordless Codex reasoning summary an earlier Sotto saved goes once the thread's activity is read again.
    const merged = combined.some(wordlessReasoningSummary) ? combined.filter(record => !wordlessReasoningSummary(record)) : combined
    // Legacy input cannot be reused on the next update. Keep its full reconciliation path
    // without adding an ownership copy that every subsequent publication must replace.
    const output = stable ? immutableActivities(merged) : merged
    if (stable) this.activityInputs.set(thread.id, { input: input!, output, epoch: thread.historyEpoch, records: new Map(input!.map(record => [record.id, record])) })
    else this.activityInputs.delete(thread.id)
    return output
  }
  /**
   * A publish the providers asked for. The first of a burst goes out at once, so a reply appearing
   * still feels immediate, and everything inside the window behind it becomes one publish at its
   * end with the last state. No adapter can make the host copy the workspace per event.
   *
   * `opening` is an opening change in a thread a window may be looking at: a message's first words or a new
   * activity record. It goes out at once even inside a window, and starts a fresh one behind it, so the first
   * words of a reply never wait behind the echo of the prompt that asked for it. The fresh window lets no second
   * opening change through: a read that records a hundred messages in one task costs two publishes and a trailing
   * one, not a hundred. Nor does a window whose trailing publish carried opening changes held back, so a flood
   * that goes on across tasks, such as a long transcript read in chunks, costs one publish a window like any
   * other burst. Later chunks of the same message ride the window as before.
   */
  private publishSoon(opening = false): void {
    if (this.publishTimer) {
      if (!opening || this.publishCut) { this.publishPending = true; this.publishHeldOpening ||= opening; return }
      clearTimeout(this.publishTimer); this.publishTimer = undefined; this.publishPending = false
      this.publishNow(true)
      return
    }
    this.publishNow(false)
  }
  /** Publish now and open a window behind it; `closed` is whether that window lets no opening change cut it. */
  private publishNow(closed: boolean): void {
    this.publish()
    this.publishCut = closed
    this.publishHeldOpening = false
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      this.publishCut = false
      if (this.publishPending) { this.publishPending = false; this.publishNow(this.publishHeldOpening) }
    }, PUBLISH_WINDOW_MS)
    this.publishTimer.unref?.()
  }
  /** Whether a window may be looking at this thread: one it said it watches, or any while none has said. */
  private inView(threadId: string): boolean { return !this.declared || this.watched.has(threadId) }
  /** The activity records of the threads a window may be looking at, so a provider snapshot that brought one
   * there can say so. A record in a thread nobody is looking at has nothing to paint and rides the window. */
  private watchedRecordCount(): number {
    let count = 0
    for (const thread of this.state.snapshot.threads.filter(thread => this.visible(thread))) if (this.inView(thread.id)) count += thread.activities?.length ?? 0
    return count
  }
  /** A cache write the providers asked for: never more than one waiting, and the state it finds
   * when it runs is the one that is written. */
  private writeSoon(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined
      void this.flush()
        // A commit this flush made for a stream that has since gone quiet still owes its publish.
        .then(() => { if (this.streamingPublishCostEnabled && this.eventChanged.size > 0) this.publishSoon() })
        .catch(() => { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.'; this.publish() })
    }, WRITE_WINDOW_MS)
    this.writeTimer.unref?.()
  }
  /**
   * The catalog after a snapshot: every model the providers name now, and those they no longer name kept, not ready, so a
   * thread's model still resolves. The same certified catalog onto the catalog this made last time gives the same
   * catalog, so it is kept as it is and stays shared with the layers either side (#917). A catalog that is not certified
   * may have been edited in place, so it is merged afresh each time, as before.
   */
  private acceptedModels(previous: AgentModel[], incoming: AgentModel[]): AgentModel[] {
    const held = this.modelInputs
    if (held && held.incoming === incoming && held.output === previous && isImmutableModels(incoming)) return previous
    const models = new Map(previous.map(model => [model.id, model.ready ? { ...model, ready: false } : model]))
    for (const model of incoming) models.set(model.id, model)
    const output = isImmutableModels(incoming) ? immutableModels([...models.values()]) : [...models.values()]
    this.modelInputs = { incoming, output }
    return output
  }
  /**
   * One publication of the inner host's activity, as thread changes already applied to `incoming` (#925). The threads it
   * changed are merged over their provider's records, and so is every thread the workspace changed since the last accept
   * (`remerge`); every other thread is left as it is, which is what merging it again would give, since neither its
   * provider's record nor anything the workspace lays over it moved. A whole publication, one carrying the rest of the
   * snapshot, the first after a read or after the workspace changed the rest itself, and one bringing more than one thread
   * new to the workspace are taken in whole, as every publication used to be. Answers whether a thread a window may be
   * looking at gained an activity record, which a publish window lets through at once.
   */
  private acceptChanges(changes: AgentHostChanges, original?: AgentHostSnapshot): boolean {
    if (this.acceptsWhole || changes.whole || changes.rest || this.remergeAll || this.restTouched || this.bringsThreads(changes) > 1) {
      const records = this.watchedRecordCount()
      this.accept(original ?? this.incomingSnapshot(), true)
      return this.watchedRecordCount() > records
    }
    return this.acceptThreads(changes).opening
  }
  /** How many threads new to the workspace this change, with the threads waiting to be merged again, would add. */
  private bringsThreads(changes: AgentHostChanges): number {
    let added = 0
    const count = (id: string): void => {
      const record = this.incoming.get(id)
      if (record && this.visible(record) && this.positionOf(id) === undefined) added++
    }
    const upserted = new Set(changes.upserts.map(record => record.id))
    for (const id of upserted) count(id)
    for (const id of this.remerge) if (!upserted.has(id)) count(id)
    return added
  }
  /**
   * What `incoming` holds as one snapshot, for a publication taken in whole: laid out as the provider switch lays out its
   * own, the threads after the projects and an error after the threads.
   */
  private incomingSnapshot(): AgentHostSnapshot {
    const rest = this.incoming.rest! as AgentHostSnapshot
    const { error, ...head } = rest
    return { ...head, threads: this.incoming.threads(), ...('error' in rest ? { error } : {}) } as AgentHostSnapshot
  }
  /**
   * `trackSubagents` dates a thread's live agents against the last accept that found the thread disconnected, which used
   * to date every disconnected thread afresh on every accept. A thread found connected, or gone from its provider's
   * snapshot, after accepts that left it disconnected and untouched takes the last of those accepts' date now.
   * `connected` is undefined for a thread its provider no longer publishes.
   */
  private noteConnection(id: string, connected: boolean | undefined, previousAcceptAt: number | undefined): void {
    if (this.disconnectedThreads.delete(id) && previousAcceptAt !== undefined) {
      this.subagentLiveSince.set(id, Math.max(this.subagentLiveSince.get(id) ?? Number.NEGATIVE_INFINITY, previousAcceptAt))
    }
    if (connected === false) this.disconnectedThreads.add(id)
  }
  /**
   * One thread of the inner host's merged with what the workspace lays over it: its project and kind, its title when the
   * user or Sotto named it, its worktree, Git action, pull requests, links and wake-ups, its activity, and the messages and
   * summary its history gives. `thread` is the provider's record, frozen and shared, so it is spread, never written into.
   */
  private mergeThread(thread: AgentThread, old: AgentThread | undefined, connected: boolean, previousAcceptAt: number | undefined): AgentThread {
    this.noteConnection(thread.id, connected, previousAcceptAt)
    this.trackSubagents(thread, connected)
    const creation = this.creationOf(thread.id)
    if (creation) creation.phase = 'started'
    const activities = old?.activities || thread.activities || this.storedActivity.has(thread.id) ? this.mergeActivities(thread, old) : undefined
    // A new provider registration may have a different project ID. The original Sotto
    // project remains the workspace/memory scope for a thread created beneath it.
    const merged: AgentThread = { ...thread,
      kind: old?.kind ?? 'project',
      subagentSummary: this.subagentSummaries.get(thread.id) ?? EMPTY_SUBAGENT_SUMMARY,
      // A name the user set by hand, or one Sotto gave this thread, outranks whatever the provider still calls it.
      ...(old?.titleSource === 'user' || old?.titleSource === 'generated' ? { title: old.title, titleSource: old.titleSource }
        : old?.titledFromFirstMessage ? { title: old.title, titleSource: 'default' as const, titledFromFirstMessage: true } : {}),
      ...(old?.worktree ? { worktree: old.worktree, workingDirectory: old.workingDirectory } : {}),
      // The Git action and the linked pull requests are Sotto's record, not the provider's: a provider update keeps them.
      ...(old?.gitAction ? { gitAction: old.gitAction } : {}),
      ...(old?.bringBack ? { bringBack: old.bringBack } : {}),
      ...(old?.broughtBack ? { broughtBack: old.broughtBack } : {}),
      ...(old?.pullRequests ? { pullRequests: old.pullRequests } : {}),
      // The thread that delegated to this one is Sotto's record too (ADR-0081), and so are a continuation's links (ADR-0089) and where it began (#1028).
      ...(old?.delegatedBy ? { delegatedBy: old.delegatedBy } : {}),
      ...(old?.continuedFrom ? { continuedFrom: old.continuedFrom } : {}),
      ...(old?.continuedIn ? { continuedIn: old.continuedIn } : {}),
      ...(old?.startedFrom ? { startedFrom: old.startedFrom } : {}),
      ...(old?.babysitting ? { babysitting: old.babysitting } : {}),
      ...(old?.babysitEnded ? { babysitEnded: old.babysitEnded } : {}),
      ...(old?.wakeUpMessageIds ? { wakeUpMessageIds: old.wakeUpMessageIds } : {}),
      ...(old?.hiddenWakeUpMessageIds ? { hiddenWakeUpMessageIds: old.hiddenWakeUpMessageIds } : {}),
      messages: [],
      ...(activities ? { activities } : {}),
      projectId: creation?.projectId ?? old?.projectId ?? this.state.projectAliases.find(alias => alias.providerProjectId === thread.projectId)?.projectId ?? thread.projectId,
      workspaceSettledAt: old?.workspaceSettledAt ?? null, nativeSessionStarted: true }
    // A stored thread keeps no list, not the provider's: an empty one saved over the store would remove every record.
    if (!activities) delete merged.activities
    // A provider that is still loading a thread's history has published no history yet, so the
    // store keeps what it already holds and the pane keeps the window it was given.
    if (this.eventSourced) {
      // The events already said what this thread's history is. What the snapshot carries beside them
      // is the window this host loaded, which only an event or an observation changes.
      merged.messages = old?.messages ?? []
      if (old?.earlierAvailable) merged.earlierAvailable = true
      merged.summary = old?.summary ?? this.threadSummary(merged)
      if (!old) this.eventChanged.add(thread.id)
    } else if ((thread.historyStatus === 'loading' || thread.historyStatus === 'error') && !thread.messages.length) {
      merged.messages = old?.messages ?? []
      merged.summary = old?.summary ?? this.threadSummary(merged)
    } else {
      const nativeMessages = this.legacyMessages(merged, thread.messages)
      const retained = new Map(old?.messages.filter(message => message.watcherOwnChange || message.watcherObservedChanges).map(message => [message.id, message]) ?? [])
      const messages = merged.kind === 'watcher' ? annotateWatcherOwnChanges({ ...merged, messages: nativeMessages.map(message =>
        withKeptMessageMetadata(message, retained.get(message.id) ?? this.message(merged.id, message.id))) }) : nativeMessages
      merged.messages = this.record(merged, messages, old?.historyEpoch)
      merged.summary = this.threadSummary(merged, this.storeUnavailable ? merged.messages : messages)
    }
    return merged
  }
  /**
   * A whole snapshot taken in: a read's, or a publication of the inner host's taken in whole (`fromPublication`). Every
   * thread it carries is merged over and every other thread loses its live state, so every thread may have changed. After
   * a read the state may say what the inner host's publications have not, so the next publication is taken in whole too.
   */
  private accept(snapshot: AgentHostSnapshot, fromPublication = false): void {
    const previousAcceptAt = this.acceptedAt
    this.acceptedAt = Date.now()
    this.remerge.clear()
    const previous = this.state.snapshot
    const previousThreads = new Map(previous.threads.map(thread => [thread.id, thread]))
    const connectedInputs = new Set<string>()
    const projects = new Map(previous.projects.map(project => [project.id, project]))
    for (const project of snapshot.projects) {
      // Hide only registrations introduced for our pending creation, never merge
      // pre-existing project scopes just because they happen to share a folder.
      if (!projects.has(project.id) && !this.state.projectAliases.some(alias => alias.providerProjectId === project.id)) {
        const creation = this.state.creations.find(item => item.phase === 'starting'
          && previous.threads.find(thread => thread.id === item.threadId)?.providerId === project.providerId
          && previous.projects.some(source => source.id === item.projectId && source.path === project.path && source.id !== project.id))
        if (creation) this.state.projectAliases.push({ providerProjectId: project.id, projectId: creation.projectId })
      }
      if (!this.state.projectAliases.some(alias => alias.providerProjectId === project.id)) projects.set(project.id, { ...project, workspaceSettledAt: projects.get(project.id)?.workspaceSettledAt ?? null })
    }
    const threads = new Map(previous.threads.map(thread => [thread.id, this.visible(thread) ? { ...thread, ...NO_LIVE_THREAD_STATE } as AgentThread : thread]))
    const merged = new Set<string>()
    for (const thread of snapshot.threads.filter(thread => this.visible(thread))) {
      // A cleared thread stays cleared, whatever its provider still reports (ADR-0140 decision 6).
      if (this.clearedIds.has(thread.id)) continue
      const old = threads.get(thread.id)
      if (old && !this.visible(old)) continue
      const connected = isThreadProviderConnected(snapshot, thread)
      if (connected && !thread.archivedAt) connectedInputs.add(thread.id)
      threads.set(thread.id, this.mergeThread(thread, old, connected, previousAcceptAt))
      merged.add(thread.id)
    }
    for (const id of [...this.disconnectedThreads]) if (!merged.has(id)) this.noteConnection(id, undefined, previousAcceptAt)
    // Retained workspace history is not a live provider input. Reconnect reconciles it afresh.
    for (const id of this.activityInputs.keys()) if (!connectedInputs.has(id)) this.activityInputs.delete(id)
    for (const id of this.storedInputs.keys()) if (!connectedInputs.has(id)) this.storedInputs.delete(id)
    this.state.snapshot = stampHostSnapshot({ ...snapshot, models: this.acceptedModels(previous.models, snapshot.models), projects: [...projects.values()], threads: [...threads.values()] }, this.hostId!)
    for (const thread of this.state.snapshot.threads.filter(thread => this.visible(thread))) if (!isThreadProviderConnected(snapshot, thread)) dropLiveThreadState(thread)
    // An agent that switched branches mid-turn moved HEAD without a send, so finished work asks for a re-read.
    for (const thread of this.state.snapshot.threads.filter(thread => this.visible(thread))) {
      const old = previousThreads.get(thread.id)
      if (old) this.refreshIfHeadMoved(thread, old)
    }
    this.heldForInput.clear()
    this.dirty = true
    this.restTouched = false
    this.remergeAll = !fromPublication
    this.markAllChanged()
    // Capture each Watcher observation before another source update can evict an early edit, or a save
    // can release idle activity. Native events supply its turn anchor even when no pane is observing it.
    if (this.eventSourced && this.watcherEnabled && this.state.snapshot.threads.some(thread => thread.kind === 'watcher' && this.watcherMoved(thread, previousThreads.get(thread.id)))) this.applyEvents()
  }
  /**
   * One publication of the inner host's thread changes taken in at a cost that follows the change (#925): each thread it
   * upserted or removed, and each the workspace changed since the last accept, is merged again or loses its live state,
   * exactly as taking in the whole snapshot would treat it, and goes back in its place in the state, or last when it is
   * new. The provider's order is not followed, as it never was: the workspace keeps its own. Answers how many threads it
   * took in, and whether a thread a window may be looking at gained an activity record.
   */
  private acceptThreads(changes: AgentHostChanges): { readonly handled: number; readonly opening: boolean } {
    const incoming = this.incoming
    // The providers and the connection, which say whether a thread is connected; the rest did not change since the last accept.
    const host = incoming.rest! as AgentHostSnapshot
    const previousAcceptAt = this.acceptedAt
    this.acceptedAt = Date.now()
    const ids = new Set<string>()
    for (const record of changes.upserts) ids.add(record.id)
    for (const id of changes.removals) ids.add(id)
    for (const id of this.remerge) ids.add(id)
    this.remerge.clear()
    const threads = this.state.snapshot.threads
    let recordsBefore = 0, recordsAfter = 0, watcher = false, handled = 0
    for (const id of ids) {
      // A cleared thread stays cleared, whatever its provider still publishes (ADR-0140 decision 6).
      if (this.clearedIds.has(id)) continue
      const at = this.positionOf(id)
      const old = at === undefined ? undefined : threads[at]
      const record = incoming.get(id)
      let next: AgentThread
      if (record && this.visible(record) && !(old && !this.visible(old))) {
        const connected = isThreadProviderConnected(host, record)
        next = this.mergeThread(record, old, connected, previousAcceptAt)
        if (!connected || record.archivedAt) { this.activityInputs.delete(id); this.storedInputs.delete(id) }
      } else if (old) {
        // Not published by its provider now, or a thread the workspace keeps out of view: its live state goes.
        this.noteConnection(id, undefined, previousAcceptAt)
        this.activityInputs.delete(id); this.storedInputs.delete(id)
        next = this.visible(old) ? { ...old, ...NO_LIVE_THREAD_STATE } as AgentThread : old
      } else continue
      handled++
      const stamped = stampHostThread(next, this.hostId!)
      const visible = this.visible(stamped)
      if (visible && !isThreadProviderConnected(host, stamped)) dropLiveThreadState(stamped)
      if (at === undefined) threads.push(stamped)
      else threads[at] = stamped
      this.markChanged(id)
      if (this.inView(id)) {
        if (old && this.visible(old)) recordsBefore += old.activities?.length ?? 0
        if (visible) recordsAfter += stamped.activities?.length ?? 0
      }
      if (visible && old) this.refreshIfHeadMoved(stamped, old)
      if (stamped.kind === 'watcher' && this.watcherMoved(stamped, old)) watcher = true
    }
    this.heldForInput.clear()
    this.dirty = true
    // A Watcher thread with events waiting is captured whether or not this change named it, as `accept` captures it.
    if (!watcher && this.eventSourced && this.watcherEnabled) for (const id of this.pendingEvents.keys()) if (this.threadById(id)?.kind === 'watcher') { watcher = true; break }
    if (this.eventSourced && this.watcherEnabled && watcher) this.applyEvents()
    return { handled, opening: recordsAfter > recordsBefore }
  }
  /** An agent that switched branches mid-turn moved HEAD without a send, so finished work asks for a re-read. */
  private refreshIfHeadMoved(thread: AgentThread, old: AgentThread): void {
    let moved = old.status === 'running' && thread.status !== 'running'
    // A stored list read back in this accept is what the thread held before it, not nothing (#918).
    const base = this.heldForInput.has(thread.id) ? this.heldForInput.get(thread.id) : old.activities
    if (!moved) moved = settledHeadMoved(base, thread.activities)
    if (moved) this.scheduleWorktreeRefresh(thread.id)
  }
  /** Whether a Watcher thread has something an accept must capture before it can be lost (`accept`). */
  private watcherMoved(thread: AgentThread, old: AgentThread | undefined): boolean {
    return this.pendingEvents.has(thread.id) || thread.activities !== old?.activities || thread.status !== old?.status
      || thread.lastTurn?.id !== old?.lastTurn?.id || thread.lastTurn?.status !== old?.lastTurn?.status
  }
  /**
   * Queues one trailing re-read of this thread's worktree; a burst of records still reads the folder once. A thread
   * whose folder already has a re-read queued joins it, so threads working in one folder at once read it once a round
   * rather than once each: every record the round answers settled before its timer fired, and so before its read began.
   */
  private scheduleWorktreeRefresh(threadId: string): void {
    const thread = this.threadById(threadId)
    if (!thread || thread.nativeSessionStarted === false || thread.worktree && thread.worktree.status !== 'ready') return
    if ([...this.worktreeRefreshes.values()].some(pending => pending.threads.has(threadId))) return
    const key = this.refreshKey(threadId)
    const queued = this.worktreeRefreshes.get(key)
    if (queued) { queued.threads.add(threadId); return }
    const threads = new Set([threadId])
    const timer = setTimeout(() => {
      this.worktreeRefreshes.delete(key)
      // Nobody sees a re-read with no window showing, so it waits for one to show and then runs once.
      if (!this.gitStatusOptions.visible()) { for (const id of threads) this.refreshesOwed.add(id); return }
      const round: RefreshRound = { firedAt: performance.now(), inspections: new Map() }
      for (const id of threads) void this.refreshWorktreeRecord(id, round)
    }, this.worktreeRefreshDelayMs)
    timer.unref?.()
    this.worktreeRefreshes.set(key, { timer, threads })
  }
  /** The folder a thread's re-read reads, as one key for every thread in it; a thread with none yet has a key of its own. */
  private refreshKey(threadId: string): string {
    const folder = this.statusFolder(threadId)
    if (folder === undefined) return `thread\0${threadId}`
    return `folder\0${folderKey(folder)}`
  }
  /**
   * Reads the folder on the thread's own lane and publishes only a record that actually changed. A folder problem
   * found here is left for the next send to report: a background read refuses nothing. The threads of one round in
   * one folder share its reads, each begun after the round's timer fired: the inspection of a shared folder the first
   * of them started, unless a Git action has run since it began, and the status read (`GitStatusSource.read`'s
   * `startedAfter`), unless a Git action has run in its repository since.
   */
  private refreshWorktreeRecord(threadId: string, round: RefreshRound): Promise<void> {
    return this.onLane(threadId, async () => {
      try { await this.discoverWorkingCopy(threadId) } catch { return }
      if (!await this.reinspect(threadId, round)) return
      // Finished work may have committed, so the counts are read again; the remote waits for the timer or a refresh.
      await this.readGitStatus(threadId, false, { startedAfter: round.firedAt })
    })
  }
  /** `inspect` of a ready record, sharing the round's inspection of its folder when it is a shared folder. */
  private inspectInRound(worktree: AgentWorktree, round: RefreshRound | undefined): Promise<AgentWorktree> {
    if (!round || worktree.mode !== 'shared' || !worktree.path) return this.worktrees.inspect(worktree)
    const key = folderKey(worktree.path)
    let shared = round.inspections.get(key)
    if (!shared || shared.changes !== this.gitChanges) {
      shared = { changes: this.gitChanges, reads: this.worktrees.inspectSharedFolder(worktree.path) }
      round.inspections.set(key, shared)
    }
    return shared.reads.then(record => record(worktree))
  }
  /**
   * A send that checked its folder from the files on disk owes the folder Git's own inspection, made once the
   * prompt is out. It is queued in the thread's lane behind the send, so it never reads the folder inside it, and a
   * send already waiting in the lane when it is queued needs no second one.
   */
  private inspectAfterSend(threadId: string): void {
    if (this.inspectionsQueued.has(threadId)) return
    this.inspectionsQueued.add(threadId)
    void this.onLane(threadId, () => { this.inspectionsQueued.delete(threadId); return this.reinspect(threadId) })
      .catch(() => undefined)
      .finally(() => this.inspectionsQueued.delete(threadId))
  }
  /**
   * Git's inspection of a ready folder after a send or a turn, made in the thread's lane: what changed (its branch,
   * its uncommitted-changes flag) goes onto the record, which keeps its sent branch. A folder Git will not confirm
   * is left as it is, and the next send to the thread asks Git before its prompt instead of reading the folder's
   * files. False when there was nothing to inspect or Git would not confirm it.
   */
  private async reinspect(threadId: string, round?: RefreshRound): Promise<boolean> {
    const worktree = this.threadById(threadId)?.worktree
    if (!worktree || worktree.status !== 'ready' || this.stopping) return false
    let inspected: AgentWorktree
    try { inspected = await this.inspectInRound(worktree, round) }
    catch { this.fullCheckDue.add(threadId); return false }
    this.fullCheckDue.delete(threadId)
    const current = this.threadById(threadId)
    if (current?.worktree?.status !== 'ready') return true
    if (inspected.branch !== current.worktree.branch || inspected.dirty !== current.worktree.dirty) {
      this.touched(current).worktree = { ...inspected, ...(current.worktree.sentBranch !== undefined ? { sentBranch: current.worktree.sentBranch } : {}) }
      this.dirty = true
      try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
      this.publish()
    }
    return true
  }
  /** Serializes work for one thread or project without holding up unrelated provider work. */
  private onLane<T>(key: string, work: () => Promise<T>, lanes = this.lanes): Promise<T> {
    const pending = (lanes.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
    lanes.set(key, pending)
    void pending.finally(() => { if (lanes.get(key) === pending) lanes.delete(key) }).catch(() => undefined)
    return pending
  }
  /**
   * The catalog's serialized form, remade only when the certified catalog array itself changes, so a
   * flush that changed nothing about it never serializes it again (#991).
   */
  private catalogText(): string {
    const models = this.state.snapshot.models
    if (this.catalogTextCache?.models === models) return this.catalogTextCache.text
    const text = JSON.stringify(catalogModelsForSave(models))
    this.catalogTextCache = { models, text }
    return text
  }
  /** Drain accepted history writes without closing stores still used by shutdown cleanup. */
  flush(): Promise<void> {
    // The write window is where held appends commit; a caller who asks for a flush gets them too.
    this.writeEvents(false, true)
    // This write covers whatever a waiting one would have written, so it takes its place.
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = undefined }
    this.flushWanted = true
    if (this.saving) return this.saving
    this.saving = Promise.resolve().then(async () => {
      try {
        // A state dirtied again while a write was in flight is written again only for a caller who asked; a
        // provider that kept publishing during a slow write waits for the window like any other burst, so a
        // slow disk cannot turn one flush into a run of back-to-back writes.
        while (this.dirty && this.flushWanted) {
          this.flushWanted = false
          this.dirty = false
          let rosterSafe = true
          // Messages live in the thread store, never here: `workspace.json` keeps organization alone,
          // so what it costs to write follows the number of threads rather than what they said (#119).
          try {
            // Task words moved into the roster from records this save strips (#918), or from workspace.json's legacy
            // activity, are the roster's only copy once the strip or the JSON write lands, so the roster reaches the disk
            // first; a power cut between them would otherwise lose the words.
            // Otherwise the records keep their words, so every held list still reaches the store before any is let go.
            // An activity save reads the message reset it follows from the store, so what was posted, and what waited
            // behind it, commits first.
            if (this.writes.unconfirmed()) await this.settled(undefined, true)
            rosterSafe = this.rosterOnDisk()
            // workspace.json drops the records this save puts in the store, so it is written once the writer confirms them.
            await this.waited(this.saveActivities(!rosterSafe))
            if (rosterSafe) await this.waited(this.noteSubagentWordsMoved())
            // The coordinator holds the lists it was last handed, so a release is published for it to let them go too.
            if (this.releaseIdleActivities()) this.publishSoon()
          } catch (error) { this.dirty = true; throw error }
          const built: Workspace = { ...this.state,
            snapshot: { ...this.state.snapshot,
              ...(this.streamingPublishCostEnabled ? { models: CATALOG_PLACEHOLDER as unknown as AgentModel[] } : {}),
              threads: this.state.snapshot.threads.map(thread => this.preservedDormantThreads.get(thread.id) ?? this.withBabysitting(organizationOnly(thread, this.activityJsonFallbackAllowed && (this.storeUnavailable || this.activityStoreUnavailable), !rosterSafe))) } }
          const scrub = (saved: Workspace): void => {
            if (!this.historyEnabled()) for (const thread of saved.snapshot.threads.filter(thread => this.visible(thread))) {
              thread.requests = []
              delete thread.activities
              // The agent a thread was continued from is named by its title, which may be its task's words (#1028).
              if (thread.startedFrom?.agentTitle !== undefined) { const { agentTitle, ...start } = thread.startedFrom; void agentTitle; thread.startedFrom = start }
              if (thread.nativeSessionStarted) {
                thread.historyStatus = 'loading'
                delete thread.historyError
              }
            }
          }
          try {
            if (this.streamingPublishCostEnabled) {
              scrub(built)
              const text = JSON.stringify(built).replace(`"models":"${CATALOG_PLACEHOLDER}"`, `"models":${this.catalogText()}`)
              if (text !== this.savedOrganizationText) {
                await this.store.writeSerialized(text)
                this.savedOrganizationText = text
              }
            } else {
              const saved = structuredClone(built)
              scrub(saved)
              if (!isDeepStrictEqual(this.savedOrganization, saved)) {
                await this.store.write(saved)
                this.savedOrganization = saved
              }
            }
            if (!this.storeUnavailable && !this.subagentUnavailable && !this.activityStoreUnavailable && !this.rosterLacksWords) this.saveError = undefined
          }
          catch (error) { this.dirty = true; throw error }
        }
        if (this.dirty) this.writeSoon()
      } finally { this.saving = undefined }
    })
    return this.saving
  }
  /**
   * Keep local history changed. Turning it off takes the words out of `threads.sqlite` and moves this run
   * into memory, so the state on screen stays right while nothing said reaches the file again; turning it
   * back on hands the file over from here, and what was not kept is gone.
   */
  async privacyChanged(): Promise<void> {
    await this.applyHistoryPrivacy(true)
  }
  private async applyHistoryPrivacy(retryUnavailable: boolean): Promise<void> {
    try { await this.changeHistoryPrivacy(retryUnavailable) }
    finally { await this.checkpointHooks?.privacyChanged?.() }
  }
  private async changeHistoryPrivacy(retryUnavailable: boolean): Promise<void> {
    this.activityInputs.clear()
    this.touchAll()
    /** Whether stored threads lost their records with the file, which the coordinator must be told. */
    let dropped = false
    if (!this.historyEnabled()) {
      this.activityJsonFallbackAllowed = false
      this.pendingEventsPrivate = true
      this.historyRedactionPending ||= !this.threadStore.ephemeral
      if (!this.eventSourced) {
        for (const thread of this.state.snapshot.threads.filter(thread => this.visible(thread))) {
          this.legacyMessages(thread, thread.messages)
          const known = this.known.get(thread.id)
          const privateMessages = this.privateLegacyMessages.get(thread.id)!
          if (known && known.epoch === thread.historyEpoch) for (const message of known.messages) privateMessages.add(message.id)
        }
      }
    } else if (this.pendingEventsPrivate) {
      // Clear before either store switches: an earlier failed redaction may have left this one durable.
      this.pendingEvents.clear()
      this.inFlight.clear()
      this.failedEventThreads.clear()
      this.recordsFailed.clear()
      this.recordsOwed.clear()
      clearTimeout(this.historyRetryTimer)
      this.historyRetryTimer = undefined
      this.historyRetryDelay = 1_000
      this.pendingEventsPrivate = false
    }
    if (!this.subagentUnavailable && this.subagentStore.ephemeral === this.historyEnabled()) {
      try {
        const unsettled = new Map(this.state.snapshot.threads.filter(thread => this.visible(thread)).map(thread => {
          const observations = this.subagentStore.unsettled(thread.id)
          return [thread.id, { observations, activities: this.subagentStore.unsettledActivities(thread.id, observations) }]
        }))
        this.subagentStore.privacyChanged(this.historyEnabled())
        this.subagentChanges.clear()
        for (const thread of this.state.snapshot.threads.filter(thread => this.visible(thread))) {
          // Retention changes do not end native work. Restore only text-free live/uncertain metadata,
          // including children whose original activity already left the bounded provider window.
          const retained = unsettled.get(thread.id)
          const seeded = this.subagentStore.ingest(thread.id, retained?.observations ?? [], thread.historyEpoch, retained?.activities ?? [])
          const current = this.subagentStore.state(thread.id)
          thread.subagentSummary = current.summary
          this.subagentsChanged({ threadId: thread.id, ...current, rows: seeded?.rows ?? [], reset: true })
        }
      } catch { this.saveError = 'Saved agent history could not be removed. Restore access to local storage and try again.'; throw new Error(this.saveError) }
    }
    // Startup keeps its unavailable-store fallback; the coordinator retries once it exists.
    if (!this.storeUnavailable || (retryUnavailable && this.historyRedactionPending)) {
      const wanted = this.historyEnabled()
      if (wanted === this.threadStore.ephemeral || this.historyRedactionPending) {
        const redacting = !wanted || this.historyRedactionPending
        try {
          // Events held while history was off must never cross into the durable connection.
          // Turning history off instead carries failed durable events into this run's memory store.
          clearTimeout(this.historyRetryTimer)
          this.historyRetryTimer = undefined
          this.historyRetryDelay = 1_000
          if (redacting) {
            // A failed switch may have closed the connection, so the writer reopens it before retrying identity cleanup.
            // Identity suppression needs no output validation. Even if it fails, the durable text is erased. A stored
            // thread's identities are the ones the store holds.
            const off = this.commit({ kind: 'history-off', reopen: this.storeUnavailable, threads: this.state.snapshot.threads.filter(thread => this.visible(thread))
              .map(thread => this.storedActivity.has(thread.id) ? { threadId: thread.id } : { threadId: thread.id, activityIds: (thread.activities ?? []).map(activity => activity.id) }) })
            await this.waited(off)
            this.historyRedactionPending = false
            this.storeUnavailable = false
            this.activityStoreUnavailable = false
          }
          if (wanted) {
            await this.waited(this.saveActivities(!this.rosterOnDisk(), true))
            await this.waited(this.commit({ kind: 'history-on' }))
            this.seedWakeUps()
          }
        } catch {
          const redactionFailed = redacting && this.historyRedactionPending
          // A failed reopen can leave no connection. Keep the workspace usable until restart.
          this.storeUnavailable = true
          const failure = redactionFailed ? 'Thread messages could not be removed. Restore access to local storage and try again.' : HISTORY_OPEN_ERROR
          // Keep the transition retryable by the coordinator's privacy maintenance.
          // Scrub pending request words from workspace.json even while SQLite cleanup must retry.
          this.dirty = true
          await this.flush()
          this.saveError = failure
          throw new Error(failure)
        }
        // The switch emptied the store either way, so what mirrored it is no longer true.
        this.known.clear()
        this.hidden.clear()
        this.storedAnchors.clear()
        // A thread whose records were left in the store has none now, as a thread out of view has no messages (#918).
        for (const thread of this.state.snapshot.threads) if (this.storedActivity.has(thread.id) && thread.summary) thread.summary = { ...thread.summary, activityCount: 0 }
        dropped = this.storedActivity.size > 0
        this.storedActivity.clear()
        for (const threadId of [...this.activityReads.keys()]) this.letReadGo(threadId)
        this.storedInputs.clear()
        // A visual has no copy but the store's (ADR-0056), so the windows stop showing the ones it no longer holds.
        for (const thread of this.state.snapshot.threads.filter(thread => this.visible(thread))) {
          delete thread.earlierAvailable
          if (thread.messages.some(isVisualMessage)) thread.messages = thread.messages.filter(message => !isVisualMessage(message))
        }
      }
    }
    // Records, summaries and windows changed under every thread, and the activity inputs were let go.
    this.touchAll()
    this.dirty = true
    // The switch stopped the history retry, and what failed is tried again at once in the store that now writes, as a failed
    // batch is: a failed history held through the switch is compared now, and its answers follow it.
    for (const threadId of [...this.recordsFailed]) this.recordOwed(threadId)
    await this.flush()
    if (dropped) this.publish()
    if (retryUnavailable && this.storeUnavailable) {
      this.saveError = HISTORY_OPEN_ERROR
      throw new Error(HISTORY_OPEN_ERROR)
    }
  }
  async connect(provider?: ProviderId): Promise<AgentHostSnapshot> {
    await this.initialize(); this.accept(await this.inner.connect(provider)); await this.flush(); return this.workspaceSnapshot()
  }
  async snapshot(provider?: ProviderId): Promise<AgentHostSnapshot> {
    await this.initialize(); this.accept(await this.inner.snapshot(provider)); await this.flush(); return this.workspaceSnapshot()
  }
  async refreshThread(threadId: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    await this.initialize()
    const thread = this.thread(threadId)
    if (thread.nativeSessionStarted === false || !isThreadProviderConnected(this.state.snapshot, thread)) return this.workspaceSnapshot()
    // The read after an accepted send looks for the provider's echo, which reached this workspace as an event and
    // may be waiting for the end of a publish window. What is held here answers it; the caller reads whole when the
    // echo is not in it (#765).
    if (purpose?.afterSend) return this.workspaceSnapshot()
    const creation = this.creationOf(threadId)
    const read = await this.withProfileRefusal(threadId, () => creation && creation.phase !== 'started' ? this.inner.snapshot(thread.providerId)
      : this.inner.refreshThread?.(threadId, this.hostRead(purpose)) ?? this.inner.snapshot(thread.providerId))
    // Taken after the read, so whatever changed or marked the workspace while it was awaited is the baseline and is
    // kept. `accept` replaces the snapshot but edits the project aliases and creations in place, so those are copied.
    const before = { snapshot: this.state.snapshot, organization: structuredClone([this.state.projectAliases, this.state.creations]), dirty: this.dirty,
      marks: { remerge: [...this.remerge], remergeAll: this.remergeAll, unpublishedAll: this.unpublishedAll, unsavedAll: this.unsavedAll, releasableAll: this.releasableAll } }
    this.accept(read)
    // A read before a send that changed nothing writes and publishes nothing (#765): every send makes one.
    if (purpose?.beforeSend && sameSnapshot(before.snapshot, this.state.snapshot) && sameSnapshot(before.organization, [this.state.projectAliases, this.state.creations])) {
      // `accept` marks the workspace for writing whatever it was handed; nothing changed, so that mark is taken back.
      // A mark something else left is written in the usual window rather than on the way to the send.
      this.dirty = before.dirty
      // The state is what it was, so what the next accept, publication, save and release must look at is what it was too (#925).
      const { marks } = before
      for (const id of marks.remerge) this.remerge.add(id)
      this.remergeAll = marks.remergeAll; this.unpublishedAll = marks.unpublishedAll; this.unsavedAll = marks.unsavedAll; this.releasableAll = marks.releasableAll
      if (this.dirty) this.writeSoon()
      return this.workspaceSnapshot()
    }
    await this.flush(); this.publish(); return this.workspaceSnapshot()
  }
  /**
   * What the workspace asks of a thread refresh or a settings result from its host. A host that publishes events has
   * already said what each thread said, and `accept` keeps that history rather than the result's messages, so it is
   * asked to leave them out instead of copying every held thread's history only for it to be dropped (#368). A
   * host that publishes none is read whole, whatever the caller here asked of the workspace's own result.
   */
  private hostRead<T extends { historyFromEvents?: boolean }>(purpose: T): T
  private hostRead<T extends { historyFromEvents?: boolean }>(purpose: T | undefined): T | undefined
  private hostRead<T extends { historyFromEvents?: boolean }>(purpose: T | undefined): T | undefined {
    // A read with no purpose becomes `{ historyFromEvents: true }`, which is a purpose of its own.
    if (this.eventSourced) return { ...purpose, historyFromEvents: true } as T
    return purpose?.historyFromEvents ? { ...purpose, historyFromEvents: false } : purpose
  }
  async setWorkspaceSettled(kind: 'project' | 'thread', id: string, settled: boolean, options?: { expectedMergedTip: string; expectedMergedBranch: string }, watcherGuard?: () => void): Promise<AgentHostSnapshot> {
    if (kind === 'thread' && settled && options) return this.onLane(id, async () => {
      const thread = this.thread(id)
      const work = this.checkoutWorkHolder(thread, 'settle')
      if (work) throw checkoutMutationRefusal(work)
      const release = await this.checkoutMutations.acquire(this.threadCheckoutFolder(id), 'send', { kind: 'settle' })
      try {
        const worktree = this.thread(id).worktree
        const branch = worktree?.mode === 'independent' ? worktree.sentBranch ?? worktree.branch : worktree?.sentBranch
        if (!worktree?.repositoryRoot || branch !== options.expectedMergedBranch
          || (await runWorktreeGit(worktree.repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`])).trim() !== options.expectedMergedTip) {
          throw new Error('This branch changed after its merged pull request was checked. Its thread stays unsettled.')
        }
        return await this.setWorkspaceSettled(kind, id, settled)
      } finally { release() }
    })
    await this.initialize()
    if (kind === 'thread' && !this.threadVisible(id)) throw new WatcherProfileRefusal(WATCHER_DISABLED)
    const projectId = kind === 'project' ? id : this.threadById(id)?.projectId
    if (!projectId) throw new Error('That thread is unavailable.')
    return this.onLane(projectId, async () => {
      watcherGuard?.()
      const entity = (kind === 'project' ? this.state.snapshot.projects : this.state.snapshot.threads).find(item => item.id === id)
      if (!entity) throw new Error(`That ${kind} is unavailable.`)
      const previous = entity.workspaceSettledAt ?? null
      entity.workspaceSettledAt = settled ? previous ?? new Date().toISOString() : null
      if (kind === 'thread') this.touch(id)
      // A thread's delegated threads (ADR-0081) settle with it, under its timestamp, so none is left open on its own;
      // restoring it brings back those that timestamp still marks. One settled or restored by itself keeps its own, so
      // settling a thread that is already settled moves none of them. Stable leaves every thread to itself.
      const delegated = new Map<string, string | null>()
      if (kind === 'thread' && this.delegationEnabled && (settled ? previous === null : previous !== null)) {
        const below = new Set(delegatedThreadsBelow(this.state.snapshot.threads, id))
        for (const thread of this.state.snapshot.threads) {
          if (!below.has(thread.id) || thread.projectId !== projectId) continue
          const own = thread.workspaceSettledAt ?? null
          if (settled ? own !== null : own !== previous) continue
          delegated.set(thread.id, own); this.touched(thread).workspaceSettledAt = entity.workspaceSettledAt
        }
      }
      this.dirty = true
      try { await this.flush() }
      catch (error) {
        const current = (kind === 'project' ? this.state.snapshot.projects : this.state.snapshot.threads).find(item => item.id === id)
        if (current) current.workspaceSettledAt = previous
        if (kind === 'thread') this.touch(id)
        for (const [threadId, own] of delegated) { const thread = this.threadById(threadId); if (thread) this.touched(thread).workspaceSettledAt = own }
        throw error
      }
      this.publish(); return this.workspaceSnapshot()
    }, this.organizationLanes)
  }
  /**
   * New work reopens a settled thread before it goes (October 23, 2026), so no thread works while settled, where Settle
   * finished threads, a request's end and the cleanup's on-settle rule would take it for put aside. Its own settlement is
   * restored as Restore does, with the delegated threads settled with it. A settled project returns with this thread
   * alone, as a new thread there returns it: the project's other threads keep its timestamp as their own.
   */
  async reopenThreadForWork(threadId: string, guard?: () => void): Promise<AgentHostSnapshot> {
    await this.initialize()
    const projectId = this.thread(threadId).projectId
    let projectRestored = false
    await this.onLane(projectId, async () => {
      guard?.()
      const project = this.state.snapshot.projects.find(item => item.id === projectId)
      const projectSettledAt = project?.workspaceSettledAt ?? null
      if (!project || projectSettledAt === null) return
      const inherited = this.state.snapshot.threads.filter(thread => thread.projectId === projectId && thread.id !== threadId && thread.workspaceSettledAt == null)
      for (const thread of inherited) this.touched(thread).workspaceSettledAt = projectSettledAt
      project.workspaceSettledAt = null
      this.dirty = true
      try { await this.flush() }
      catch (error) {
        // A snapshot taken while the write waited replaced these records: the rollback finds them again by ID.
        const current = this.state.snapshot.projects.find(item => item.id === projectId)
        if (current) current.workspaceSettledAt = projectSettledAt
        const ids = new Set(inherited.map(thread => thread.id))
        for (const id of ids) { const thread = this.threadById(id); if (thread) this.touched(thread).workspaceSettledAt = null }
        throw error
      }
      projectRestored = true
      this.publish()
    }, this.organizationLanes)
    // The guard decides once: having let the project return, it does not stop the thread's own restore halfway.
    if (this.thread(threadId).workspaceSettledAt != null) return this.setWorkspaceSettled('thread', threadId, false, undefined, projectRestored ? undefined : guard)
    return this.workspaceSnapshot()
  }
  /**
   * The thread's new name, kept in Sotto's own workspace: the provider is never told, and its own
   * title stops overwriting this one. A blank name is the caller's to refuse before it gets here.
   */
  async renameThread(threadId: string, title: string, source: ThreadRenameSource = 'user'): Promise<AgentHostSnapshot> {
    await this.initialize()
    const thread = this.thread(threadId)
    const previous = { title: thread.title, titleSource: thread.titleSource, titledFromFirstMessage: thread.titledFromFirstMessage }
    this.touched(thread).title = title
    // A first-message title is still a `default` name to everything that reads one; only its flag tells it apart.
    thread.titleSource = source === 'first-message' ? 'default' : source
    if (source === 'first-message') thread.titledFromFirstMessage = true
    else delete thread.titledFromFirstMessage
    this.dirty = true
    try { await this.flush() }
    catch (error) {
      const restored = this.touched(this.thread(threadId))
      Object.assign(restored, { title: previous.title, titleSource: previous.titleSource })
      if (previous.titledFromFirstMessage) restored.titledFromFirstMessage = true
      else delete restored.titledFromFirstMessage
      throw error
    }
    this.publish(); return this.workspaceSnapshot()
  }
  private thread(id: string): AgentThread {
    const thread = this.threadById(id)
    if (!thread) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
    if (!this.visible(thread)) this.refuseDormantThread(thread)
    return thread
  }
  private refuseDormantThread(thread: AgentThread): never {
    const held = heldProviderOfThreadRecord(thread, this.held)
    if (held) throw new Error(heldProviderRefusal(held))
    throw new WatcherProfileRefusal(WATCHER_DISABLED)
  }
  /** Starts working-copy setup, or returns the setup already running for this thread.
   * The checkout runs after `create-thread` has returned, so the pane appears at once; the
   * promise is also this thread's lane, so every later command queues behind it. */
  private startWorkingCopy(thread: AgentThread): Promise<void> {
    const existing = this.preparations.get(thread.id)
    if (existing) return existing
    const pending = this.prepareWorkingCopy(thread).catch(() => {
      this.saveError = 'Working-copy setup could not be saved. Restore local storage and retry setup.'
      this.publish()
    })
    this.preparations.set(thread.id, pending)
    void pending.finally(() => {
      if (this.preparations.get(thread.id) === pending) this.preparations.delete(thread.id)
    }).catch(() => undefined)
    return pending
  }
  private async prepareWorkingCopy(thread: AgentThread): Promise<void> {
    if (!thread.worktree) return // Existing threads keep their native directory.
    // Native events can replace the thread object while Git is pending; always write the current one.
    const current = (): AgentThread => this.threadById(thread.id) ?? thread
    try {
      let metadata = current().worktree ?? thread.worktree
      if (!metadata.path) {
        const project = this.state.snapshot.projects.find(project => project.id === thread.projectId)
        if (!project) throw new Error('The original project is unavailable.')
        // The thread a moved branch came from stays on the record, so the worker can bring its commits back there (#1030).
        const madeFrom = metadata.madeFrom, check = metadata.check
        metadata = await this.worktrees.allocate(project.path, metadata.mode, { baseBranch: metadata.baseBranch, startFromOrigin: metadata.startFromOrigin, existingWorktreePath: metadata.existingWorktreePath,
          ...(metadata.checkoutBranch && metadata.branch ? { checkoutBranch: metadata.branch } : {}), ...(metadata.incomingRef ? { incomingRef: metadata.incomingRef } : {}) })
        if (madeFrom && metadata.incomingRef) metadata = { ...metadata, madeFrom }
        if (check) metadata = { ...metadata, check }
        this.touched(current()).worktree = metadata
        this.dirty = true
        await this.flush() // Allocation owns its exact path/branch before Git mutates anything.
      }
      const taken = await this.takeCheckWorktree(thread.id, metadata)
      try {
        if (taken) metadata = taken.worktree
        // An install a restart cut off is over: nothing was recorded as installed, so the next check installs again.
        if (metadata.check?.install === 'running') metadata = { ...metadata, check: { install: 'failed' } }
        metadata = await this.worktrees.ensure(metadata)
        const workingDirectory = await this.worktrees.workingDirectory(metadata)
        // The check worktree installs only under its reservation; a check's own worktree is its alone.
        if (taken || !metadata.reused) metadata = await this.checkPackages(thread.id, metadata, workingDirectory)
        const target = this.touched(current())
        target.worktree = metadata
        target.workingDirectory = workingDirectory
      } finally { taken?.release() }
    } catch (error) {
      const target = this.touched(current())
      target.worktree = { ...(target.worktree ?? thread.worktree), status: 'error', error: error instanceof Error ? error.message : 'Working-copy setup failed. Retry after restoring the folder and Git.' }
    }
    this.dirty = true; await this.flush(); this.publish()
  }
  async updateThreadWorktree(threadId: string, retry: boolean, options: { readonly background?: boolean } = {}): Promise<AgentHostSnapshot> {
    const recordRead = await this.onLane(threadId, async () => {
      await this.initialize()
      await this.discoverWorkingCopy(threadId)
      const thread = this.thread(threadId)
      if (retry && thread.nativeSessionStarted === false && thread.worktree?.status === 'error') { await this.prepareWorkingCopy(thread); return false }
      if (!thread.worktree?.path) return false
      // Native events can replace the thread object while Git is pending.
      let metadata = thread.worktree
      // A folder that was deleted is put back before it is read, so a refresh never turns a missing
      // folder into an error that the next send would then refuse to repair (ADR-0014).
      // A folder Sotto reclaimed is not put back by a refresh, only by the next send; a refresh reads it if it came back.
      if (metadata.reclaimedAt) { try { metadata = await this.worktrees.inspect(metadata) } catch { /* Still reclaimed; the record already says so. */ } }
      else {
        try {
          // A removal Sotto started and did not finish is finished, and like any reclaimed folder only a send puts it back;
          // one Git left half done before #1297 is repaired (#1297).
          const resumed = await this.worktrees.resumeRemoval(metadata)
          metadata = resumed.reclaimedAt ? resumed : await this.worktrees.inspect(await this.worktrees.restore(resumed))
        }
        catch (error) { metadata = { ...metadata, status: 'error', error: error instanceof Error ? error.message : 'The working folder is unavailable.' } }
      }
      this.touched(this.thread(threadId)).worktree = metadata
      // Git has just confirmed the folder, so the next send may check it from its files again.
      if (metadata.status === 'ready' && !metadata.reclaimedAt) this.fullCheckDue.delete(threadId)
      this.dirty = true; await this.flush(); this.publish()
      return true
    })
    // A refresh is the user's or the window's ask, so the remote is read too, fetching when the interval allows. The
    // refresh answers once the record is read: the fetch and the GitHub lookup run outside the thread's lane, so
    // neither the refresh nor a send waits for them (issue #766), and the status publishes when it lands. The window's
    // own ask (`background`) asks GitHub as the timer does, so regaining focus never spends the reserve or a pause (#820).
    if (recordRead) void this.readRemoteStatus(threadId, options.background ? { background: true } : {})
    return this.workspaceSnapshot()
  }
  /**
   * Switches this thread's worktree back to the branch of its last send, because the user pressed Restore
   * branch. `withUncommittedChanges` is their answer to the confirmation; without it a worktree with
   * uncommitted work is left exactly as it is.
   */
  async restoreThreadBranch(threadId: string, withUncommittedChanges: boolean): Promise<AgentHostSnapshot> {
    return this.onGitLane(threadId, async () => {
      await this.gitActionFolder(threadId)
      const worktree = this.thread(threadId).worktree
      if (worktree?.mode !== 'shared' || worktree.status !== 'ready') throw new Error('This thread has no project checkout to switch.')
      const target = worktree.sentBranch
      if (!target) throw new Error('Sotto has not sent to this thread yet, so there is no earlier branch to restore.')
      const inspected = await this.worktrees.inspect(worktree)
      if (inspected.dirty && !withUncommittedChanges && inspected.branch !== target) {
        this.touched(this.thread(threadId)).worktree = { ...inspected, sentBranch: target }
        this.dirty = true; await this.flush().catch(() => undefined); this.publish()
        throw new Error(RESTORE_BRANCH_NEEDS_CONFIRMATION)
      }
      const switched = await this.worktrees.switchBranch(inspected, target)
      // The branch moved under any status read of the folder begun before now, so the read below is one of its own.
      this.invalidateGitStatus(threadId)
      this.touched(this.thread(threadId)).worktree = { ...switched, sentBranch: target }
      this.dirty = true
      try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
      this.publish()
      await this.readGitStatus(threadId, false)
      return this.workspaceSnapshot()
    })
  }
  /** The branch this thread's work went to, so the pane can say what changed under it afterwards. */
  private async recordSentBranch(threadId: string): Promise<void> {
    const worktree = this.thread(threadId).worktree
    if (!worktree || worktree.status !== 'ready' || worktree.sentBranch === worktree.branch) return
    worktree.sentBranch = worktree.branch
    this.touch(threadId)
    this.dirty = true
    // The prompt is about to go out; a cache write that fails must not refuse the send.
    try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
    this.publish()
  }
  async threadWorkingDirectory(threadId: string): Promise<string> {
    await this.initialize()
    await this.preparations.get(threadId) // A folder question asked during setup waits for its answer.
    await this.discoverWorkingCopy(threadId)
    const thread = this.thread(threadId)
    const worktree = thread.worktree
    if (worktree?.path && (worktree.status === 'ready' || worktree.status === 'error')) {
      // A folder that was deleted is put back on its recorded branch before the turn (ADR-0014). A record
      // an earlier read marked as an error gets the same chance; when it cannot be put back, the error it
      // already carries is the one reported below.
      let inspected: AgentWorktree | undefined
      try { inspected = await this.worktrees.inspect(await this.worktrees.restore(worktree)) }
      catch (error) { if (worktree.status === 'ready') throw error }
      // A branch switched inside the worktree is adopted, so the pane's label follows it (ADR-0014).
      // A newer working-copy choice or refresh wins; provider snapshots preserve the worktree object.
      if (inspected && this.thread(threadId).worktree === worktree) {
        // Setup can fail after Git creates the checkout but before its verified folder is recorded.
        const workingDirectory = this.thread(threadId).workingDirectory ?? await this.worktrees.workingDirectory(inspected)
        const current = this.thread(threadId)
        if (current.worktree === worktree && (inspected.branch !== worktree.branch || worktree.status !== 'ready' || worktree.reclaimedAt || current.workingDirectory === undefined)) {
          this.touched(current).worktree = inspected; current.workingDirectory ??= workingDirectory; this.dirty = true
          // The folder was just verified; a cache write that fails must not refuse the send.
          try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
          this.publish()
        }
      }
    }
    const folder = await existingWorkingDirectory(this.threadFolder(this.thread(threadId)))
    this.fullCheckDue.delete(threadId)
    return folder
  }
  /**
   * The folder a send's prompt goes to, with `threadWorkingDirectory`'s guarantee: never a deleted or failed working
   * copy, and a branch switched inside it is adopted (ADR-0014). For a ready folder that is there, the common case,
   * the check reads the checkout's own files rather than starting Git (issue #766), and `inspectAfter` says Git's
   * own inspection is still owed once the prompt is out. Anything the files do not settle (a missing, reclaimed or
   * failed folder, one never verified, one an earlier inspection could not confirm, or files only Git can read)
   * takes `threadWorkingDirectory`'s path, which puts a missing folder back and inspects with Git.
   */
  private async sendWorkingDirectory(threadId: string): Promise<{ folder: string; inspectAfter: boolean }> {
    await this.initialize()
    await this.preparations.get(threadId)
    await this.discoverWorkingCopy(threadId)
    const thread = this.thread(threadId)
    const worktree = thread.worktree
    if (worktree?.path && worktree.status === 'ready' && !worktree.reclaimedAt && thread.workingDirectory !== undefined && !this.fullCheckDue.has(threadId)) {
      const seen = await this.worktrees.readyOnDisk(worktree)
      // A record replaced while the files were read (a choice made outside the thread's lane) is newer, and the
      // send takes the path that asks Git, as `threadWorkingDirectory` does.
      if (seen.kind === 'ready' && this.thread(threadId).worktree === worktree) {
        // The folder's own branch is the one this send goes to, recorded as `inspect` would record it.
        if (seen.worktree.branch !== worktree.branch) {
          this.touched(this.thread(threadId)).worktree = seen.worktree
          this.dirty = true
          try { await this.flush() } catch { this.saveError = BRANCH_SAVE_ERROR }
          this.publish()
        }
        const folder = await existingWorkingDirectory(this.threadFolder(this.thread(threadId)))
        // A project folder outside any repository has nothing for Git to add.
        return { folder, inspectAfter: worktree.mode !== 'shared' || worktree.repositoryRoot !== undefined }
      }
    }
    return { folder: await this.threadWorkingDirectory(threadId), inspectAfter: false }
  }
  private readonly watcherDispatchGuards = new WeakMap<object, () => void>()
  /** Delegation (ADR-0081) sends its guarded commands the way Watcher does, whether or not Watcher is on. */
  private delegationGuards = false
  admitDelegationCommands(): void { this.delegationGuards = true }
  /** Delegation is on (the Owl list's `thread-delegation`), so settling a thread settles the threads it delegated to. */
  private delegationEnabled = false
  enableDelegation(): void { this.delegationEnabled = true }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> {
    if (!this.watcherEnabled && !this.delegationGuards) throw new Error(WATCHER_DISABLED)
    this.watcherDispatchGuards.set(command, guard); guard(); return this.execute(command)
  }
  execute(command: AgentHostCommand): Promise<AgentHostResult> {
    // Cancellation passes a held prompt, but remains tracked so shutdown drains its final publication.
    if (command.type === 'interrupt') return this.onLane(command.threadId, () => this.executeOne(command), this.interruptLanes)
    const key = 'threadId' in command ? command.threadId : command.projectId
    // Creation changes older threads' settlement too. Keep that transaction apart from
    // settlement edits in the same project so failed writes cannot cross their rollbacks.
    return this.onLane(key, () => command.type === 'create-thread'
      ? this.onLane(command.projectId, () => this.executeCreationGuarded(command), this.organizationLanes)
      : this.executeGuarded(command))
  }
  private async executeCreationGuarded(command: Extract<AgentHostCommand, { type: 'create-thread' }>): Promise<AgentHostResult> {
    await this.initialize()
    const selection = { ...command, workingCopy: command.workingCopy ?? this.workingCopyDefault(command.projectId) }
    const release = await this.reserveWorkingCopySelection(command.projectId, selection, { kind: 'preparation', threadId: command.threadId, title: command.title })
    try { return await this.executeOne(command) } finally { release?.() }
  }
  private async executeGuarded(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type !== 'send' && command.type !== 'steer') return this.executeOne(command)
    await this.initialize()
    const thread = this.thread(command.threadId)
    if (thread.worktree?.mode === 'independent' && (!thread.worktree.path && !thread.worktree.existingWorktreePath || thread.worktree.reclaimedAt)) return this.executeOne(command)
    const release = await this.checkoutMutations.acquire(this.threadCheckoutFolder(thread.id), 'send', this.checkoutThreadHolder(thread.id, 'send'))
    try { return await this.executeOne(command, true) } finally { release() }
  }
  private async withProfileRefusal<T>(threadId: string | undefined, work: () => Promise<T>): Promise<T> {
    const refuse = threadId ? this.inner.profileRefusalHandler?.(threadId) : undefined
    try { return await work() }
    catch (error) {
      if (threadId && error instanceof WatcherProfileRefusal) {
        try { await refuse?.(error.message) }
        catch { /* Preserve the definitive refusal even if shutdown cleanup fails. */ }
      }
      throw error
    }
  }
  private executeOne(command: AgentHostCommand, checkoutHeld = false): Promise<AgentHostResult> {
    return this.withProfileRefusal('threadId' in command ? command.threadId : undefined, () => this.executeWithProfile(command, checkoutHeld))
  }
  private async executeWithProfile(command: AgentHostCommand, checkoutHeld: boolean): Promise<AgentHostResult> {
    const watcherGuard = this.watcherDispatchGuards.get(command)
    await this.initialize(); watcherGuard?.()
    const heldCreation = this.heldProviderCreatedBy(command)
    if (heldCreation) throw new Error(heldProviderRefusal(heldCreation))
    const commandProfile = 'threadId' in command ? await this.launchProfiles.profileFor(command.threadId) : undefined
    if ('threadId' in command) {
      if (commandProfile) {
        assertWatcherPermission(command)
      }
      if (commandProfile && (command.type === 'create-thread' && (command.workingCopy === 'independent' || command.existingWorktreePath !== undefined))) {
        throw new Error('Watcher’s asking mode and working folder cannot be changed. Choose only its model and effort.')
      }
      if (commandProfile && command.type === 'configure-thread') {
        const thread = this.thread(command.threadId)
        const model = resolveModel(this.state.snapshot.models, command.modelId ?? thread.modelId)
        if (model?.providerId !== thread.providerId) throw new Error('Changing Watcher’s provider needs a new watcher conversation. This conversation was kept.')
      }
    }
    let preparedSkills: AgentSkillReference[] | undefined
    let firstSend = false
    if ('threadId' in command && command.type !== 'create-thread' && command.type !== 'interrupt' && await this.checkpointHooks?.isBlocked(command.threadId)) throw new Error('Wait for Git changes or resolve the interrupted checkpoint revert before changing this thread.')
    if ((command.type === 'send' || command.type === 'steer') && command.skills?.length) {
      const thread = this.thread(command.threadId)
      const capabilities = this.state.snapshot.providers?.find(provider => provider.id === thread.providerId)?.capabilities ?? this.state.snapshot.capabilities
      if (!capabilities.skills && thread.providerId) throw providerTakesNoSkills(thread.providerId)
      if (!capabilities.skills || !this.inner.listThreadSkills) throw new Error('Selected skills are unavailable or belong to another provider. Refresh this draft’s skill catalog.')
      const catalog = await this.listThreadSkills(command.threadId, true)
      if (thread.nativeSessionStarted === false && thread.worktree?.path && thread.workingDirectory) {
        const projectPath = await existingWorkingDirectory(this.state.snapshot.projects.find(item => item.id === thread.projectId)!.path)
        preparedSkills = await Promise.all(command.skills.map(selected => skillInWorkingCopy(selected, projectPath, thread.workingDirectory!)))
      }
      if (catalog.status !== 'ready' || catalog.providerId !== thread.providerId || (preparedSkills ?? command.skills).some(selected => !catalog.skills.some(skill => skill.name === selected.name && skill.path === selected.path && skill.enabled !== false && skill.userInvocable !== false))) {
        throw new Error('Selected skills are unavailable or belong to another provider. Refresh this draft’s skill catalog.')
      }
    }
    if (command.type === 'create-project') {
      const result = await this.inner.execute(command)
      // The existing coordinator reconciles creation; a cache failure cannot change
      // an acknowledged/uncertain native result into a definitive rejection.
      try { this.accept(await this.inner.snapshot(command.provider)); await this.flush() }
      catch { this.saveError = 'Refresh to confirm the project and save workspace history.' }
      return result
    }
    if (command.type === 'create-thread') {
      if (this.threadById(command.threadId) !== undefined) throw new Error('This thread already exists. Select it instead of creating it again.')
      if (!this.state.snapshot.projects.some(project => project.id === command.projectId)) throw new Error('Choose an available project.')
      validateThreadOptions(this.state.snapshot, command)
      const model = resolveModel(this.state.snapshot.models, command.modelId)!
      if (commandProfile) {
        await this.launchProfiles.assertCreationBinding(command.threadId, command.projectId, model.providerId)
      }
      this.requireCreation(model.providerId)
      const thread: AgentThread = { hostId: this.hostId, id: command.threadId, projectId: command.projectId, title: command.title, modelId: command.modelId,
        ...(commandProfile ? { kind: 'watcher' } : {}),
        titleSource: command.titleSource ?? 'default',
        ...(model.providerId ? { providerId: model.providerId } : {}),
        ...(command.reasoningEffort ?? model.defaultReasoningEffort ? { reasoningEffort: command.reasoningEffort ?? model.defaultReasoningEffort! } : {}),
        ...(command.runtimeMode ? { runtimeMode: command.runtimeMode } : {}),
        ...(command.providerMode ? { providerMode: command.providerMode } : {}),
        worktree: await this.selectedWorkingCopy(command.projectId, { ...command, workingCopy: command.workingCopy ?? this.workingCopyDefault(command.projectId) }),
        status: 'idle', messages: [], requests: [], workspaceSettledAt: null, nativeSessionStarted: false }
      if (thread.worktree?.mode === 'shared') thread.workingDirectory = thread.worktree.path
      // New work reopens the folder, while the work put aside stays settled.
      // Re-read after working-copy preparation, which can accept a fresh snapshot.
      const project = this.state.snapshot.projects.find(item => item.id === command.projectId)!
      const projectSettledAt = project.workspaceSettledAt ?? null
      const previousSettlement = new Map<string, string | null | undefined>()
      if (projectSettledAt !== null) {
        for (const existing of this.state.snapshot.threads) {
          if (existing.projectId !== project.id || existing.workspaceSettledAt != null) continue
          previousSettlement.set(existing.id, existing.workspaceSettledAt)
          this.touched(existing).workspaceSettledAt = projectSettledAt
        }
        project.workspaceSettledAt = null
      }
      this.state.snapshot.threads.push(thread)
      this.touch(thread.id)
      this.state.creations.push({ threadId: thread.id, projectId: thread.projectId, commandId: randomUUID(), phase: 'unstarted' })
      this.dirty = true
      try { await this.flush() }
      catch (error) {
        this.removeThread(thread.id)
        this.privateLegacyMessages.delete(thread.id)
        this.state.creations = this.state.creations.filter(item => item.threadId !== thread.id)
        const currentProject = this.state.snapshot.projects.find(item => item.id === command.projectId)
        if (currentProject && projectSettledAt !== null) currentProject.workspaceSettledAt = projectSettledAt
        for (const existing of this.state.snapshot.threads) {
          if (previousSettlement.has(existing.id)) this.touched(existing).workspaceSettledAt = previousSettlement.get(existing.id)
        }
        throw error
      }
      this.publish()
      // Opening a thread never allocates a worktree. Its choice remains editable until first send. A check's is the
      // exception (#1312): its setup, packages installed first included, starts now, and its first message waits for it.
      if (thread.worktree?.check && this.checkInstaller) void this.startWorkingCopy(thread)
      return { accepted: true }
    }
    let thread = this.thread(command.threadId)
    const creation = this.creationOf(thread.id)
    if (command.type === 'configure-thread' && creation?.phase === 'unstarted') {
      validateThreadOptions(this.state.snapshot, command, thread.modelId)
      const model = resolveModel(this.state.snapshot.models, command.modelId ?? thread.modelId)!
      this.requireCreation(model.providerId)
      const previous = structuredClone(thread)
      this.touch(thread.id)
      if (command.modelId !== undefined) {
        thread.modelId = model.id
        if (model.providerId) thread.providerId = model.providerId
        delete thread.reasoningEffort
        if (model.defaultReasoningEffort) thread.reasoningEffort = model.defaultReasoningEffort
        if (thread.runtimeMode && !model.runtimeModes?.includes(thread.runtimeMode)) delete thread.runtimeMode
        if (thread.providerMode && !model.providerModes?.some(mode => mode.id === thread.providerMode)) delete thread.providerMode
      }
      if (command.reasoningEffort !== undefined) thread.reasoningEffort = command.reasoningEffort
      if (command.runtimeMode !== undefined) thread.runtimeMode = command.runtimeMode
      if (command.providerMode !== undefined) thread.providerMode = command.providerMode
      // The choice stays through a change of model (ADR-0143); only the toggle itself sets it.
      if (command.fastMode === true) thread.fastMode = true
      else if (command.fastMode === false) delete thread.fastMode
      this.dirty = true
      try { await this.flush() }
      catch (error) { Object.keys(thread).forEach(key => { delete (thread as unknown as Record<string, unknown>)[key] }); Object.assign(this.touched(thread), previous); throw error }
      // No provider holds these settings yet; the workspace is where they took effect.
      this.publish(); return { accepted: true, snapshot: this.workspaceSnapshot() }
    }
    if (command.type === 'send' && creation && creation.phase !== 'started') {
      firstSend = true
      if (creation.phase === 'starting') {
        await this.refreshThread(thread.id)
        if (this.creationOf(thread.id)?.phase !== 'started') throw new Error('Native thread creation is not confirmed. Reconnect its original provider and refresh; Sotto will not create it twice. Your prompt has not been sent.')
      } else {
        // Waits for setup already running from creation; only an unstarted or failed one starts here.
        if (thread.worktree?.status !== 'ready') await this.startWorkingCopy(thread)
        thread = this.thread(command.threadId)
        const workingDirectory = await this.threadWorkingDirectory(thread.id)
        if (command.skills?.length) {
          const projectPath = await existingWorkingDirectory(this.state.snapshot.projects.find(project => project.id === thread.projectId)!.path)
          const catalog = await this.listThreadSkills(thread.id, true)
          const skills = await Promise.all((preparedSkills ?? command.skills).map(selected => skillInWorkingCopy(selected, projectPath, workingDirectory)))
          if (catalog.status !== 'ready' || skills.some(selected => !catalog.skills.some(skill => skill.name === selected.name && skill.path === selected.path && skill.enabled !== false && skill.userInvocable !== false))) {
            throw new Error('A selected skill is unavailable in the chosen working copy. Refresh the skill catalog and select it again. Your prompt has not been sent.')
          }
          preparedSkills = skills
        }
        validateThreadOptions(this.state.snapshot, thread)
        this.requireCreation(thread.providerId)
        const priorPhase = creation.phase
        creation.phase = 'starting'; this.touched(thread).nativeSessionStarted = true; this.dirty = true
        try { await this.flush() }
        catch (error) { creation.phase = priorPhase; this.touched(thread).nativeSessionStarted = priorPhase !== 'unstarted'; throw error }
        this.publish()
        const project = this.state.snapshot.projects.find(project => project.id === thread.projectId)!
        // This creation intent is durable separately from AgentControl's prompt outbox.
        // A failure here precedes prompt dispatch; retry may observe but never replay creation.
        const rejected = async (): Promise<void> => {
          // A definitive rejection permits another attempt. Preserve any identity
          // already reserved by the registry; only an entirely unbound thread unlocks.
          const current = this.thread(thread.id)
          if (this.creationOf(thread.id)?.phase === 'started') return
          creation.phase = this.inner.providerForThread?.(thread.id) ? 'retryable' : 'unstarted'
          this.touched(current).nativeSessionStarted = creation.phase !== 'unstarted'
          this.dirty = true; await this.flush(); this.publish()
        }
        let result: AgentHostResult
        try {
          watcherGuard?.()
          const createCommand: AgentHostCommand = { type: 'create-thread', commandId: creation.commandId, threadId: thread.id,
            projectId: thread.projectId, project, title: thread.title, modelId: thread.modelId,
            workingDirectory,
            ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
            ...(thread.runtimeMode ? { runtimeMode: thread.runtimeMode } : {}),
            ...(thread.providerMode ? { providerMode: thread.providerMode } : {}),
            ...(thread.fastMode ? { fastMode: true } : {}) }
          result = await (watcherGuard && this.inner.executeFromWatcher ? this.inner.executeFromWatcher(createCommand, watcherGuard) : this.inner.execute(createCommand))
        } catch (error) { await rejected(); throw error }
        if (!result.accepted && !result.uncertain) { await rejected(); throw new Error('The provider rejected thread creation. Check its connection and settings, then retry your prompt.') }
        this.accept(await this.inner.snapshot(thread.providerId)); await this.flush()
        if (!result.accepted || this.creationOf(thread.id)?.phase !== 'started') throw new Error('Native thread creation is not confirmed. Refresh its original provider; your prompt has not been sent.')
      }
      thread = this.thread(command.threadId)
    }
    if (thread.nativeSessionStarted === false) throw new Error('This thread has no native work yet.')
    if (command.type === 'configure-thread') {
      if (creation && creation.phase !== 'started') throw new Error('Native thread creation is not confirmed. Refresh or retry the first prompt with its original provider before changing settings.')
      const capabilities = this.state.snapshot.providers?.find(provider => provider.id === thread.providerId)?.capabilities ?? this.state.snapshot.capabilities
      if (!capabilities.configureThread) throw new Error('This provider does not support changing thread settings.')
      if (thread.status === 'running' || thread.requests.length) throw new Error('Wait for this thread to finish and answer its pending requests before changing settings.')
      validateThreadOptions(this.state.snapshot, command, thread.modelId)
      if (command.modelId && resolveModel(this.state.snapshot.models, command.modelId)?.providerId !== thread.providerId) throw new Error('Existing sessions cannot move between providers.')
    }
    // Native command uncertainty belongs to the existing outbox; do not add a failing
    // history read after dispatch that could turn unknown delivery into a rejection.
    // Never send into a deleted/failed working copy, even if the native client is still live.
    let dispatchFolder: string | undefined
    let inspectAfter = false
    if (command.type === 'send' || command.type === 'steer') {
      ({ folder: dispatchFolder, inspectAfter } = await this.sendWorkingDirectory(thread.id))
      // The folder was just read, so this is the branch the prompt goes to; the pane compares against it afterwards.
      await this.recordSentBranch(thread.id)
    }
    const releaseSend = !checkoutHeld && dispatchFolder
      ? await this.checkoutMutations.acquire(dispatchFolder, 'send', this.checkoutThreadHolder(thread.id, 'send')) : undefined
    try {
      if (command.type === 'send') await this.checkpointHooks?.beforeTurn(thread.id)
      if (command.type === 'send' && command.wakeUp) await this.recordWakeUp(thread.id, command.messageId, command.watcherAsks, command.hiddenWakeUp === true)
      const dispatched = command.type === 'send' ? withoutWakeUp(preparedSkills ? { ...command, skills: preparedSkills } : command)
        : command.type === 'configure-thread' ? this.hostRead(command) : command
      if (command.type === 'send') markSendStage(command.commandId, 'prepared')
      watcherGuard?.()
      const result = await (watcherGuard && this.inner.executeFromWatcher ? this.inner.executeFromWatcher(dispatched, watcherGuard) : this.inner.execute(dispatched))
      // A continued thread's first message begins with its handover; its branch is named from the user's words (ADR-0089).
      if (command.type === 'send' && firstSend && result.accepted) this.nameBranch(thread.id, continuedPromptWords(thread, command.text))
      if (command.type === 'configure-thread') {
        const [confirmed, snapshot] = confirmedSettingsSnapshot(result)
        if (!snapshot || this.deliveryStopped) return confirmed
        // Taken in as a provider snapshot is, and handed back as the workspace's view of it.
        this.accept(snapshot); this.writeSoon(); this.publishSoon()
        return { ...confirmed, snapshot: this.workspaceSnapshot() }
      }
      return result
    } finally {
      releaseSend?.()
      if (inspectAfter) this.inspectAfterSend(thread.id)
    }
  }
  private requireCreation(provider?: ProviderId): void {
    const status = this.state.snapshot.providers?.find(item => item.id === provider)
    if (!(status ? status.connection === 'connected' && status.capabilities.threads : this.state.snapshot.connected && this.state.snapshot.capabilities.threads)) throw new Error('Choose a ready provider that can create threads.')
  }
  createProjectId(provider: ProviderId): string { return this.inner.createProjectId?.(provider) ?? randomUUID() }
  resolveProjectId(id: string): string { return this.inner.resolveProjectId?.(id) ?? id }
  resolveModelId(id: string): string { return this.inner.resolveModelId?.(id) ?? id }
  providerForThread(id: string): ProviderId | undefined { return this.threadById(id)?.providerId ?? this.inner.providerForThread?.(id) }
  /**
   * A side call on the thread's own client (ADR-0026). A thread whose native session has not started has
   * no client, model or folder to ask yet, so it gets nothing rather than a session started for it.
   */
  async writeShortText(threadId: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    const thread = this.threadById(threadId)
    if (!thread || !this.visible(thread) || thread.nativeSessionStarted === false || !this.inner.writeShortText) return null
    return this.withProfileRefusal(threadId, () => this.inner.writeShortText!(threadId, prompt, signal))
  }
  /**
   * The threads a window says it is looking at. Only those hold their messages in memory: one leaving the
   * set drops to its summary, one joining it is given the first window of its history from the store.
   */
  observeThreads(ids: readonly string[]): void {
    if (this.stopping) return
    if ((!this.watcherEnabled || this.held.size) && !this.ready) { void this.initialize().then(() => this.observeThreads(ids)).catch(() => undefined); return }
    ids = ids.filter(id => { const thread = this.threadById(id); return !thread || this.visible(thread) })
    // A thread coming into view reads its stored records back before its provider hears of it, so a provider reading the
    // thread's history merges onto them (#918). Read on the store worker, they arrive a moment after the pane's first
    // publish, and only then is its provider told; the other threads' provider is told now (ADR-0016, October 26).
    for (const id of ids) {
      const thread = this.storedActivity.has(id) ? this.threadById(id) : undefined
      if (thread) this.readBack(thread)
    }
    this.observation = new Set(ids)
    this.observedReads = 0
    for (const id of this.observation) if (this.activityReads.has(id)) this.observedReads++
    this.tellObservation()
    if (!this.ready) return
    const wanted = new Set(ids)
    let changed = !this.declared
    // A thread that leaves view, or every thread nobody asked for when a window first says what it shows, lets its records
    // go at the next save, so one is asked for even when nothing else changed (#918).
    let left = !this.declared
    if (!this.declared) {
      this.declared = true
      // Nothing was let go while every thread counted as in view; now any thread out of view may be.
      this.releasableAll = true
      // Everything held only because nobody had said otherwise goes back to its summary now.
      for (const thread of this.state.snapshot.threads.filter(thread => this.visible(thread))) if (!wanted.has(thread.id)) {
        this.storedAnchors.delete(thread.id)
        if (thread.messages.length) this.unloadWindow(thread.id)
      }
    }
    for (const id of [...this.watched.keys()]) if (!wanted.has(id)) {
      this.watched.delete(id)
      this.hidden.delete(id)
      this.storedAnchors.delete(id)
      this.unloadWindow(id)
      changed = true
      left = true
    }
    if (left) { this.dirty = true; this.writeSoon() }
    for (const id of wanted) if (!this.watched.has(id) && this.threadById(id) !== undefined) {
      this.watched.set(id, FIRST_WINDOW_TURNS)
      this.loadWindow(id)
      // A thread just come into view reads its folder at once, locally, so its toolbar has a branch to show
      // before the timer's next remote round; the timer keeps it fresh from there.
      if (this.gitStatus && !this.threadById(id)?.worktree?.git) void this.onLane(id, () => this.readGitStatus(id, false)).catch(() => undefined)
      changed = true
    }
    if (changed) this.publish()
  }
  /**
   * Early start (#769), on the thread's own lane so it orders with its sends. A started thread's provider session is
   * started the way its next action would. A thread whose native session has not started gets its first send's client,
   * and the draft names the thread's folder only when that folder already exists and is the one the send would use,
   * the project checkout it shares. A new worktree is made by the first send and by nothing before it (ADR-0014), so
   * that thread's draft names no folder: a client that runs outside the thread's folder still starts, one that runs in
   * it does not. When the send would fetch that worktree's origin base, typing starts the fetch (`prefetchOriginBase`).
   */
  startThreadSession(threadId: string): Promise<void> {
    const start = this.inner.startThreadSession
    return this.onLane(threadId, () => this.withProfileRefusal(threadId, async () => {
      await this.initialize()
      const thread = this.threadById(threadId)
      if (!thread || thread.archivedAt || thread.providerSessionOpen) return
      if (!this.visible(thread)) this.refuseDormantThread(thread)
      if (thread.nativeSessionStarted !== false) return start?.call(this.inner, threadId)
      const creation = this.creationOf(threadId)
      if (creation?.phase !== 'unstarted') return
      const project = this.state.snapshot.projects.find(item => item.id === thread.projectId)
      this.prefetchOriginBase(thread, project)
      if (!start) return
      const shared = thread.worktree?.mode === 'shared' && thread.worktree.status === 'ready'
      const workingDirectory = shared ? await existingWorkingDirectory(resolveThreadWorkingDirectory(thread, project)) : undefined
      return start.call(this.inner, threadId, { modelId: thread.modelId, ...(workingDirectory ? { workingDirectory } : {}),
        ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
        ...(thread.runtimeMode ? { runtimeMode: thread.runtimeMode } : {}), ...(thread.fastMode ? { fastMode: true } : {}) })
    }))
  }
  /**
   * A new worktree set to start from origin fetches its base while the first message is typed, outside the thread's
   * lane so the send queues behind nothing; the send uses that fetch while it runs and for two minutes after. A fetch
   * that fails says nothing here: the send fetches again and reports its own failure. With the Git fetch interval
   * Off, Sotto fetches nothing it was not asked for, so only the send fetches. It runs in the project's folder under
   * the status reader's hold, so a folder being removed gets none and its removal waits for one running (ADR-0027).
   */
  private prefetchOriginBase(thread: AgentThread, project: AgentProject | undefined): void {
    const worktree = thread.worktree
    if (this.gitStatusOptions.pollIntervalMs() <= 0 || !project || worktree?.mode !== 'independent' || worktree.path || !worktree.startFromOrigin || worktree.existingWorktreePath || worktree.checkoutBranch) return
    const fetch = (): Promise<void> => this.worktrees.prefetchOriginBase(project.path, worktree.baseBranch)
    void (this.gitStatus?.runInFolder ? this.gitStatus.runInFolder(project.path, fetch) : fetch())?.catch(() => undefined)
  }
  async clientUpdated(provider: ProviderId): Promise<void> { await this.inner.clientUpdated?.(provider) }
  disconnect(provider?: ProviderId): void {
    this.inner.disconnect(provider)
    if (!this.ready) return
    const snapshot = this.state.snapshot
    // The provider rows and the catalog are shared with the layers either side and never edited in place.
    if (snapshot.providers) snapshot.providers = snapshot.providers.map(item => !provider || item.id === provider ? { ...item, connection: 'disconnected' as const } : item)
    snapshot.models = snapshot.models.map(model => model.ready && (!provider || model.providerId === provider) ? { ...model, ready: false } : model)
    snapshot.connected = snapshot.providers?.some(item => item.connection === 'connected') ?? false
    for (const thread of snapshot.threads.filter(thread => this.visible(thread))) if (!provider || thread.providerId === provider) {
      dropLiveThreadState(thread)
      this.trackSubagents(thread, false)
      thread.subagentSummary = this.subagentSummaries.get(thread.id) ?? EMPTY_SUBAGENT_SUMMARY
    }
    // The providers, the catalog and the connection are the workspace's own now, until the next accept takes them in whole.
    this.touchAll()
    this.restTouched = true
    this.dirty = true
    void this.flush().catch(() => { this.saveError = 'Workspace history could not be saved. Restore access to local storage and refresh.'; this.publish() })
    this.publish()
  }
  /** The thread as `workspace.json` keeps it: what it babysits carries what it was last told, and its kept wake-ups go with it. */
  private withBabysitting(thread: AgentThread): AgentThread {
    const records = this.babysitRecords.get(thread.id)
    if (records?.length) thread.babysitting = records
    else delete thread.babysitting
    const wakeUps = this.wakeUpRecords.get(thread.id)
    const asks = this.wakeUpAskRecords.get(thread.id)
    const hidden = this.hiddenWakeUpRecords.get(thread.id)
    return wakeUps?.length ? Object.assign(thread, { wakeUps },
      asks?.size ? { wakeUpAsks: [...asks].map(([messageId, kept]) => ({ messageId, asks: kept })) } : {}, hidden?.length ? { hiddenWakeUps: hidden } : {}) : thread
  }
  private babysitView(thread: AgentThread): BabysitThread {
    const project = this.state.snapshot.projects.find(item => item.id === thread.projectId)
    return {
      id: thread.id,
      closed: isThreadArchived(thread) ? 'archived' : isThreadSettled(thread) || isWorkspaceThreadSettled(thread, project) ? 'settled' : null,
      knows: url => this.knowsPullRequest(thread, url),
      records: this.babysitRecords.get(thread.id) ?? [],
    }
  }
  /** One thread as babysitting sees it (`BabysitStore`), or null when it is not known here. */
  babysitThread(threadId: string): BabysitThread | null {
    const thread = this.threadById(threadId)
    return thread && this.visible(thread) ? this.babysitView(thread) : null
  }
  /** Calls `listener` after the user unlinks a pull request from a thread (`BabysitStore`). */
  onPullRequestUnlinked(listener: (threadId: string, url: string) => Promise<void>): () => void {
    this.unlinkListeners.add(listener)
    return () => { this.unlinkListeners.delete(listener) }
  }
  /** Calls `listener` when a thread that babysits is settled or archived (`BabysitStore`). */
  onBabysatThreadClosed(listener: () => void): () => void {
    this.babysatClosedListeners.add(listener)
    return () => { this.babysatClosedListeners.delete(listener) }
  }
  /** Whether a thread that babysits is settled or archived now: a handful of threads at most, so cheap at every publish. */
  private babysatThreadClosed(): boolean {
    for (const threadId of this.babysitRecords.keys()) {
      const thread = this.threadById(threadId)
      if (thread && this.visible(thread) && this.babysitView(thread).closed) return true
    }
    return false
  }
  /** Every thread here that babysits a pull request. A thread that is gone took its records with it. */
  babysatThreads(): BabysitThread[] {
    return this.state.snapshot.threads.filter(thread => this.visible(thread) && this.babysitRecords.get(thread.id)?.length).map(thread => this.babysitView(thread))
  }
  /**
   * Changes what a thread babysits, then saves and publishes it. The change applies at once to the records as they
   * stand, so babysitting's own writes never undo a stop or a start that landed while it read GitHub.
   */
  async changeBabysitting(threadId: string, change: (records: readonly BabysitRecord[]) => readonly BabysitRecord[]): Promise<void> {
    await this.initialize()
    const thread = this.threadById(threadId)
    if (!thread || !this.visible(thread)) return
    const current = this.babysitRecords.get(threadId) ?? []
    const next = change(current)
    if (next === current) return
    this.touch(threadId)
    if (next.length) { this.babysitRecords.set(threadId, [...next]); thread.babysitting = babysittingSummary(next) }
    else { this.babysitRecords.delete(threadId); delete thread.babysitting }
    // A pull request babysat again is no longer one whose babysitting ended.
    const babysat = new Set(next.map(record => pullRequestKey(record.url)))
    const ended = thread.babysitEnded?.filter(item => !babysat.has(pullRequestKey(item.url)))
    if (ended?.length) thread.babysitEnded = ended; else delete thread.babysitEnded
    this.dirty = true
    try { await this.flush() } finally { this.publish() }
  }
  /**
   * Records why babysitting a pull request ended, where it ended on its own or with the switch, on the thread's record,
   * so every client's Pull request surface can say so and why (ADR-0061, #825). One per pull request, the newest kept.
   */
  async recordBabysitEnded(threadId: string, url: string, reason: BabysitEndedReason): Promise<void> {
    await this.initialize()
    const thread = this.threadById(threadId)
    const number = pullRequestAddress(url)?.number
    if (!thread || !this.visible(thread) || number === undefined) return
    const key = pullRequestKey(url)
    const kept = (thread.babysitEnded ?? []).filter(item => pullRequestKey(item.url) !== key)
    this.touched(thread).babysitEnded = [...kept, { url, number, reason, endedAt: new Date().toISOString() }].slice(-BABYSITTING_PER_THREAD_MAX)
    this.dirty = true
    try { await this.flush() } finally { this.publish() }
  }
  private settledThreadIds(): readonly string[] {
    const projects = new Map(this.state.snapshot.projects.map(project => [project.id, project]))
    return this.state.snapshot.threads.filter(thread => this.visible(thread) && isWorkspaceThreadSettled(thread, projects.get(thread.projectId))).map(thread => thread.id)
  }
  /** Settlement metadata, immediately and on publication, without materializing thread histories. */
  subscribeSettledThreads(listener: (ids: readonly string[]) => void): () => void {
    this.settledThreadListeners.add(listener)
    listener(this.settledThreadIds())
    return () => this.settledThreadListeners.delete(listener)
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.activityListeners.add(listener); return () => this.activityListeners.delete(listener) }
  /**
   * The activity publications as thread changes (ADR-0016, #925): the threads whose record changed, the provider's changes
   * and the workspace's own alike, and the threads that went, from the same publish as the activity snapshots. The records
   * are those the snapshots carry. One form for every subscriber, as the snapshots are.
   */
  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    void options
    return this.changes.subscribe(listener)
  }
}
