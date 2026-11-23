import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { version as appVersion } from '../../../package.json'
import { agentProjectSchema, attachmentReferences, type AgentHostSnapshot, type AgentModel, type AgentThread } from '../../shared/agents'
import { mergeAgentActivities, settleSubagentSteps, type AgentActivity } from '../../shared/agentActivity'
import { BACKGROUND_WORK_LABELS, type AgentBackgroundWork } from '../../shared/agentMonitoring'
import { compactionPending, idleMark } from '../../shared/compaction'
import type { AgentSkillCatalog } from '../../shared/agentSkills'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ActivitySubscribers, certifyActivityView, cloneActivitySnapshot } from './activitySnapshots'
import { AdapterThreadChanges, restOf } from './adapterThreadChanges'
import { antigravityActivities, antigravityToolCallSignal, antigravityToolId, ANTIGRAVITY_THINKING_ID_PREFIX, parseAntigravitySystemWakeup } from './antigravityActivity'
import { AntigravityBackgroundTasks, antigravityBackgroundCommand, mergeAntigravityBackgroundWork, sanitizeAntigravityWorkLabel } from './antigravityBackgroundWork'
import { antigravityEdits, placeAntigravityEdits, type AntigravityEdit } from './antigravityEditLines'
import { antigravityChildReading, CHILD_PASS_FILES, readAntigravityChild, type AntigravityChild, type AntigravityChildReading } from './antigravityChildren'
import { classifyAntigravityTurnOutcome, watchAntigravityTurnOutcome, type AntigravityOutcomeWatcher } from './antigravityTurnOutcome'
import { antigravityFolders, type AntigravityFolders } from './antigravityFolders'
import { leaseAntigravityRuntime } from './antigravityInstall'
import { antigravityUsageHooks, type AntigravityUsageHooks } from './antigravityUsage'
import { findAntigravityExecutable, type AntigravityLookup } from './antigravityLookup'
import { antigravityCatalog, antigravityCurrentMode, antigravityCurrentModel, antigravityGeminiModel, antigravityModeIsOption, antigravityModelChoices, antigravityOffersAuto, antigravityRuntimeMode,
  antigravitySessionMode, antigravitySessionSettingsSchema, antigravityThinking, leastEffort, ANTIGRAVITY_RUNTIME_MODES, type AntigravityModelFacts, type AntigravityModelThinking,
  type AntigravityRuntimeMode, type AntigravitySessionSettings } from './antigravityModels'
import { ANTIGRAVITY_QUESTION, antigravityAnswer, antigravityAutoAnswer, antigravityDecline, antigravityPending, antigravityWatcherAdmission, type AntigravityPending } from './antigravityRequests'
import { countAntigravityAnswer, countAntigravityFullness, forgetAntigravityFullness } from './antigravityThreadUsage'
import { antigravityArguments, antigravityEnvironment, antigravitySignInIssue, AntigravityRejected, AntigravityRpc, AntigravityUncertain, meetsAntigravityFloor, readAntigravityVersion,
  writeAntigravitySettings, ANTIGRAVITY_ACP_VERSION, ANTIGRAVITY_CLI_FLOOR, GOOGLE_ACCOUNT, type AntigravityFrame, type AntigravitySignIn } from './antigravityRpc'
import { acpImageBlocks, deliverAttachments, withAttachedFilesNote } from './attachedFiles'
import { BackgroundCommandWatch } from './backgroundCommandWatch'
import type { BrowserAgentTools } from './browserAgentServer'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { markCompactionActivity, type CompactionMark } from './compactionActivity'
import { childProcesses, type ChildProcessRow } from './detachedRunScan'
import type { ActivitySubscriptionOptions, AgentHostCommand, AgentHostResult, AgentSkillScope, PromptImage, ProviderHost, ShortTextPrompt, ThreadHistorySource, ThreadHostEvent,
  ThreadLaunchProfiles, ThreadReadPurpose, ThreadSessionDraft, WatcherLaunchProfile } from './host'
import { watcherMayWrite } from './host'
import { needsPerson, unreadableRequest } from './nativeRequests'
import { OpenSessions } from './openSessions'
import { verifyFileMentions } from './promptFiles'
import { ProviderUnavailable } from './providerProblem'
import { adapterItemCount, ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { questionInstructions } from './questionInstructions'
import { markSendStage } from './sendStages'
import { busyHolds, SessionReaper, type HeldSession } from './sessionReaper'
import { SIDE_WRITING_TIMEOUT_MS } from './sideWriting'
import { settledThinking, thinkingSettledAs } from './thinkingActivity'
import type { ActivityChangesListener, ActivityChangesSubscription } from './threadChanges'
import type { UsageHistorySink } from './usageHistory/sink'
import type { MediaCapture } from './threadMedia'
import { ThreadMessageLog } from './threadMessageLog'
import { effortAfterChange, validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { scopedThreadServers, type ScopedThreadTools } from './threadToolServer'
import { readAntigravityUserServers, type AntigravitySessionServer, type AntigravityStdioServer } from './antigravityUserServers'
import { existingWorkingDirectory } from './threadWorktrees'
import { markTurnActivity } from './turnActivity'
import { validateWatcherProfile, WatcherHistoryRefusal, WatcherProfileRefusal } from './watcherProfile'
import { assertWatcherPermission, assertWatcherPermissionChoice, watcherThreadTools } from './watcherProviderTools'
import { watcherRequestLine } from './watcherRequestNote'
import { WATCHER_SYSTEM_PROMPT } from './watcherPrompt'

/**
 * Google Antigravity as a thread provider, the way T3 Code runs it (docs/research/2026-11-20-antigravity-in-t3code.md,
 * and the ADR): one `agy acp` process per thread, started with Sotto's own Gemini folder, speaking ACP on stdio. `agy`
 * keeps the sign-in, the sessions and the tools; Sotto keeps each thread's session ID, its settings and what it sent, by
 * digest, never by its words.
 *
 * A thread resumes with `session/resume`, which replays nothing, so a thread's history is Sotto's event store's and the
 * adapter's log of what the process said live, as DeepSeek's is. Sotto's own instructions for Watcher go where T3 puts
 * its own, in `_meta.antigravity.systemPrompt.append` when a session starts, never into the user's words.
 */

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const attachmentSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), sizeBytes: z.number() })
/** One message Sotto sent: its identities, the digest of what `agy` was given, and its turn's place. */
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), turn: z.number().int().nonnegative(),
  attachments: z.array(attachmentSchema).default([]) })
type Origin = z.infer<typeof originSchema>
const childWatchSchema = z.object({
  rowId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  afterMessageId: z.string().max(256).optional(),
  sequence: z.number().int().nonnegative().default(0),
  title: z.string().max(512),
  agentId: z.string().min(1).max(256),
  agentTitle: z.string().max(512),
  model: z.string().max(256).optional(),
  startedAt: z.string().max(64).optional(),
  toolCallId: z.string().min(1).max(512),
  until: z.number().int().nonnegative(),
  childConversation: z.string().regex(/^[A-Za-z0-9-]{1,64}$/u).optional(),
  answeredAt: z.string().max(64).optional(),
  answerDigest: z.string().max(64).optional(),
})
type SavedChildWatch = z.infer<typeof childWatchSchema>
const aliasSchema = z.object({
  antigravitySessionId: z.string().min(1).max(512).optional(), projectId: z.string(), cwd: z.string(), title: z.string(), createdAt: z.string(),
  modelId: z.string(), reasoningEffort: z.string().optional(), runtimeMode: z.enum(ANTIGRAVITY_RUNTIME_MODES).default('approval-required'),
  /** How many user turns the session holds, as Sotto last counted them: the place the next prompt takes. */
  turns: z.number().int().nonnegative().default(0),
  origins: z.array(originSchema).default([]), answeredRequestIds: z.array(z.string()).default([]),
  childWatches: z.array(childWatchSchema).max(64).default([]),
})
type Alias = z.infer<typeof aliasSchema>
const aliasesSchema = z.record(z.string(), aliasSchema)
const projectsSchema = z.array(agentProjectSchema)
/** How many origins and answered request IDs a thread keeps: enough for every retry and every open request, no more. */
const KEPT = 128
/** A thread's saved origins and answered requests, indexed once, so a send or an answer never scans the thread's history. */
class ThreadIndex {
  private readonly byCommand = new Map<string, Origin>()
  private readonly byMessage = new Map<string, Origin>()
  private readonly answered: Set<string>
  constructor(readonly alias: Alias) {
    if (alias.origins.length > KEPT) alias.origins = alias.origins.slice(-KEPT)
    for (const origin of alias.origins) { this.byCommand.set(origin.commandId, origin); this.byMessage.set(origin.messageId, origin) }
    if (alias.answeredRequestIds.length > KEPT) alias.answeredRequestIds = alias.answeredRequestIds.slice(-KEPT)
    this.answered = new Set(alias.answeredRequestIds)
  }
  sent(commandId: string, messageId: string): Origin | undefined { return this.byCommand.get(commandId) ?? this.byMessage.get(messageId) }
  add(origin: Origin): void {
    this.alias.origins.push(origin); this.byCommand.set(origin.commandId, origin); this.byMessage.set(origin.messageId, origin)
    while (this.alias.origins.length > KEPT) { const gone = this.alias.origins.shift()!; this.byCommand.delete(gone.commandId); this.byMessage.delete(gone.messageId) }
  }
  remove(origin: Origin): void {
    const at = this.alias.origins.lastIndexOf(origin)
    if (at >= 0) this.alias.origins.splice(at, 1)
    if (this.byCommand.get(origin.commandId) === origin) this.byCommand.delete(origin.commandId)
    if (this.byMessage.get(origin.messageId) === origin) this.byMessage.delete(origin.messageId)
  }
  wasAnswered(requestId: string): boolean { return this.answered.has(requestId) }
  answer(requestId: string): void {
    if (this.answered.has(requestId)) return
    this.answered.add(requestId); this.alias.answeredRequestIds.push(requestId)
    while (this.alias.answeredRequestIds.length > KEPT) this.answered.delete(this.alias.answeredRequestIds.shift()!)
  }
  unanswer(requestId: string): void {
    if (!this.answered.delete(requestId)) return
    const at = this.alias.answeredRequestIds.lastIndexOf(requestId)
    if (at >= 0) this.alias.answeredRequestIds.splice(at, 1)
  }
}
const initializeSchema = z.object({ protocolVersion: z.number(),
  agentCapabilities: z.object({
    mcpCapabilities: z.object({ http: z.boolean().optional() }).passthrough().optional(),
    promptCapabilities: z.object({ image: z.boolean().optional() }).passthrough().optional(),
    sessionCapabilities: z.object({ resume: z.unknown().optional() }).passthrough().optional(),
    _meta: z.object({ antigravity: z.object({ systemPrompt: z.object({ append: z.boolean().optional() }).passthrough().optional() }).passthrough().optional() }).passthrough().optional(),
  }).passthrough().default({}),
  agentInfo: z.object({ version: z.string().max(64).optional() }).passthrough().optional(),
}).passthrough()
type AntigravityClient = z.infer<typeof initializeSchema>
const sessionNewSchema = antigravitySessionSettingsSchema.extend({ sessionId: z.string().min(1).max(512) })
const promptAnswerSchema = z.object({ stopReason: z.string() }).passthrough()
const commandsSchema = z.array(z.object({ name: z.string().min(1).max(256), description: z.string().max(4096).nullish() }).passthrough()).max(500)

/** Google's terms allow other makers' models only in its own apps (ADR-0212), so a thread on one is not sent. */
const ANTIGRAVITY_GEMINI_ONLY = 'Antigravity threads in Sotto run Gemini models only, under Google’s terms. Nothing was sent, and your thread and draft are kept. Choose a Gemini model, then send.'
/** How often a child still at work is read, and how long it is watched before Sotto stops reading it. */
const CHILD_READ_MS = 1_000
const CHILD_WATCH_MS = 4 * 60 * 60 * 1_000
const CHILD_WATCHES_KEPT = 64
const CONVERSATION_ID = /^[A-Za-z0-9-]{1,64}$/u
const TYPED_ONLY_OUTCOME: AntigravityOutcomeWatcher = { check: async stopReason => classifyAntigravityTurnOutcome(stopReason) }
/**
 * One child at work: its thread and its row as launched, the launching tool call, the parent's session, and what the
 * reading has learned. The row is kept so a child whose row has left the thread's newest records still settles.
 */
interface ChildWatch { readonly backgroundId: string; readonly threadId: string; row: AgentActivity; readonly toolCallId: string; readonly parent: string; readonly until: number; readonly reading: AntigravityChildReading
  /** When the newest answer read so far was sent: a child that has answered is waiting, no longer at work. */
  answeredAt?: string
  /** SHA-256 of the newest answer text seen so far, so restarts neither drop newer answers nor store message text. */
  answerDigest?: string
  /** SHA-256 of the newest child steps + model seen so far, so unchanged polls emit nothing. */
  stepsDigest?: string }
function serializeChildWatch(watch: ChildWatch): SavedChildWatch | undefined {
  const agent = watch.row.agents?.[0]
  if (!agent) return undefined
  const childConversation = watch.reading.childConversation && CONVERSATION_ID.test(watch.reading.childConversation)
    ? watch.reading.childConversation : undefined
  const candidate = {
    rowId: watch.row.id,
    turnId: watch.row.turnId,
    ...(watch.row.afterMessageId ? { afterMessageId: watch.row.afterMessageId } : {}),
    sequence: watch.row.sequence,
    title: watch.row.title.slice(0, 512),
    agentId: agent.id,
    agentTitle: (agent.title ?? watch.row.title).slice(0, 512),
    ...(agent.model ? { model: agent.model.slice(0, 256) } : {}),
    ...(agent.startedAt ? { startedAt: agent.startedAt.slice(0, 64) } : {}),
    toolCallId: watch.toolCallId,
    until: watch.until,
    ...(childConversation ? { childConversation } : {}),
    ...(watch.answeredAt ? { answeredAt: watch.answeredAt.slice(0, 64) } : {}),
    ...(watch.answerDigest ? { answerDigest: watch.answerDigest.slice(0, 64) } : {}),
  }
  // Never persist anything aliasesSchema would refuse to reload on the next startup.
  const parsed = childWatchSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}
function restoreChildRow(saved: SavedChildWatch, cwd: string): AgentActivity {
  return {
    id: saved.rowId,
    turnId: saved.turnId,
    ...(saved.afterMessageId ? { afterMessageId: saved.afterMessageId } : {}),
    sequence: saved.sequence,
    kind: 'subagent',
    status: 'completed',
    title: saved.title,
    cwd,
    ...(saved.startedAt ? { startedAt: saved.startedAt, timingSource: 'observed' as const } : {}),
    agents: [{
      id: saved.agentId,
      status: saved.answeredAt ? 'completed' : 'running',
      title: saved.agentTitle,
      ...(saved.model ? { model: saved.model } : {}),
      ...(saved.answeredAt
        ? { completedAt: saved.answeredAt }
        : saved.startedAt ? { observedAt: saved.startedAt, startedAt: saved.startedAt, timingSource: 'observed' as const } : {}),
    }],
  }
}
const COMPACTING = 'Antigravity is compacting this thread. Wait for it to finish, then send.'
const COMPACTION_LOST = 'Antigravity stopped before it confirmed whether it compacted this thread. Nothing was lost. Its next reply shows how full the context is; compact again then if it still needs it.'
const COMPACTION_ANSWERED = 'Antigravity answered /compact in words rather than compacting this thread. Nothing was lost. Update Antigravity, then compact again.'
const COMPACTION_UNCONFIRMED = 'Antigravity did not confirm whether it compacted this thread. Nothing was lost. Its next reply shows how full the context is; compact again then if it still needs it.'
const PROCESS_LOST = 'Antigravity stopped before this reply finished, so it may be cut short. Send a message to carry on.'
const WATCHER_WITHOUT_TOOLS = 'This Antigravity client cannot give Watcher its Sotto tools or instructions, so Watcher did not start. Nothing was sent. Update Antigravity, then connect it again, or choose another model for Watcher.'
const LOOK_BEFORE_END_MS = 5_000
const REACTIVE_TURN_SETTLE_MS = 2_000
const REACTIVE_TURN_WAIT_MS = 30_000
const REACTIVE_TURN_MAX_MS = 120_000
const MAX_INHERITED_TOOL_KEYS = 256
const ANTIGRAVITY_QUESTIONS = questionInstructions('ask_question', false)

/**
 * Where each update of one turn belongs. Replies are counted by segment: a reply runs on until a tool or a thought breaks
 * it. Tools and thoughts are counted in order. A turn is keyed by its user message.
 */
class TurnPlaces {
  private replies = 0; private thoughts = 0; private tools = 0
  private readonly toolKeys = new Map<string, string>()
  private readonly toolTurns = new Map<string, string>()
  private current: 'reply' | 'thought' | undefined
  constructor(readonly key: string, inherited?: TurnPlaces) {
    if (inherited) {
      const entries = [...inherited.toolKeys].slice(-MAX_INHERITED_TOOL_KEYS)
      for (const [nativeId, key] of entries) {
        this.toolKeys.set(nativeId, key)
        this.toolTurns.set(nativeId, inherited.toolTurn(nativeId))
      }
    }
  }
  reply(): { id: string; opened: boolean } {
    const opened = this.current !== 'reply'
    if (opened) { this.current = 'reply'; this.replies++ }
    return { id: `antigravity-reply-${this.key}-${this.replies - 1}`, opened }
  }
  thought(): string {
    if (this.current !== 'thought') { this.current = 'thought'; this.thoughts++ }
    return `${this.key}-${this.thoughts - 1}`
  }
  peekTool(nativeId: string): string | undefined { return this.toolKeys.get(nativeId) }
  toolTurn(nativeId: string): string { return this.toolTurns.get(nativeId) ?? this.key }
  tool(nativeId: string, opens: boolean): string {
    let key = this.toolKeys.get(nativeId)
    if (!key) {
      key = `${this.key}-${this.tools++}`
      this.toolKeys.set(nativeId, key)
      this.toolTurns.set(nativeId, this.key)
    }
    if (opens) this.current = undefined
    return key
  }
}
/** The turn a thread is on. `taken` once `agy` showed it is working on a prompt Sotto sent; `prompts` the prompts it holds, steers included. */
interface LiveTurn {
  readonly places: TurnPlaces
  readonly origin: Origin | undefined
  taken: boolean
  ended: boolean
  prompts: number
  wake: (() => void) | undefined
  readonly outcome: AntigravityOutcomeWatcher
  reactive: boolean
  ranCommand: boolean
  readonly reactiveTools: Set<string>
  sawReactiveContent: boolean
  reactiveRev: number
  reactiveTimer: NodeJS.Timeout | undefined
  reactiveMaxTimer: NodeJS.Timeout | undefined
}
/** One thread's own `agy` process. */
interface Connection {
  readonly rpc: AntigravityRpc
  readonly nonce: string
  readonly clientRevision: number
  /** Started for Watcher's thread with its launch profile: its session has Watcher's tools and instructions, never the browser. */
  readonly watcher: boolean
  watcherToolTitles?: ReadonlySet<string>
  stdioMcpServers?: readonly AntigravityStdioServer[]
  readonly client: AntigravityClient
  closing: boolean
  /** The model, effort and session mode this process's session is on, as `agy` last said. */
  model: string | undefined
  effort: string | undefined
  mode: string | undefined
  /** The option the effort is set by and whether the mode is an option, as the session last said. */
  effortOption: string | undefined
  modeIsOption: boolean
  offersAuto: boolean
  commands: AgentSkillCatalog['skills'] | undefined
}
type Pending = AntigravityPending & { readonly connection: Connection }

export interface AntigravityAcpOptions {
  /** The program to start, in place of finding `agy`: a test's fake client, with the arguments it takes before `agy`'s own. */
  executable?: string
  executableArgs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  /** Where `agy` is looked for: the binary path from Settings and Sotto's downloaded copy. */
  lookup?: () => Promise<AntigravityLookup>
  /** The sign-in `agy` starts with: a Google account unless Settings names another. Read before every start. */
  signIn?: () => Promise<AntigravitySignIn>
  requestTimeoutMs?: number
  /** How long a new `agy` has to answer `initialize`: it unpacks itself first, which takes a while on a cold start. */
  startTimeoutMs?: number
  reaperSweepMs?: number
  sessionIdleMs?: number
  captureMedia?: MediaCapture
  /** Usage on: `agy`'s token counts from its conversation files (`antigravityUsage.ts`). Never the account's limits (ADR-0212). */
  usageEnabled?: boolean
  /** How long a child agent is read before Sotto stops (`antigravityChildren.ts`); four hours unless a test says otherwise. */
  childWatchMs?: number
  /** The user's own `agy` MCP file (`antigravityUserServers.ts`), whose servers a thread gets beside Sotto's. None when unset. */
  userMcpConfig?: string
  /** Process-children reader override for testing background command detection cleanly. */
  childProcesses?: (parentPid: number) => Promise<readonly ChildProcessRow[]>
  /** How long a reactive continuation turn waits after reply content before closing (`endTurn`). */
  reactiveTurnSettleMs?: number
  /** How long a reactive continuation turn waits before initial reply content (or after a tool/answer) before closing (`endTurn`). */
  reactiveTurnWaitMs?: number
  /** Maximum lifetime of a reactive continuation turn before it settles regardless of lingering tools. */
  reactiveTurnMaxMs?: number
  /** Maximum time to wait for the pre-end OS child process check. */
  lookBeforeEndMs?: number
}

export class AntigravityAcpHost implements ProviderHost {
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  private aliasesLoaded = false
  private readonly forgottenAliasIds = new Set<string>()
  private readonly indexes = new Map<string, ThreadIndex>()
  private readonly threads = new Map<string, AgentThread>()
  private readonly connections = new Map<string, Connection>()
  private readonly loading = new Map<string, Promise<Connection>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly turns = new Map<string, LiveTurn>()
  private readonly pending = new Map<string, Pending>()
  private readonly dispatching = new Set<string>()
  /** Each thread's `/compact` in flight, by its command, and the boundary each thread's next context size closes. */
  private readonly compactions = new Map<string, string>()
  private readonly compactedSince = new Map<string, CompactionMark>()
  /** Threads whose `/compact` drew a reply: `agy` compacts without one, so a reply means it took the words as a prompt. */
  private readonly compactionAnswered = new Set<string>()
  /** Children `agy` launched that are still at work, by their row: read from its records until they are done (`antigravityChildren.ts`). */
  private readonly children = new Map<string, ChildWatch>()
  private childTimer: NodeJS.Timeout | undefined
  private readingChildren = false
  private readonly backgroundCommands = new Map<string, BackgroundCommandWatch>()
  private readonly backgroundTasks = new Map<string, AntigravityBackgroundTasks>()
  private readonly lookingBeforeEnd = new Map<string, { depth: number; changed: boolean }>()
  private readonly reactiveTurnCounts = new Map<string, number>()
  private readonly observed = new Set<string>()
  private readonly outdated = new Set<string>()
  private readonly processes = new Set<AntigravityRpc>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly activityListeners = new ActivitySubscribers()
  private readonly threadChanges = new AdapterThreadChanges({
    view: historyFromEvents => this.activitySnapshot(historyFromEvents),
    thread: (id, historyFromEvents) => this.activityThread(id, historyFromEvents),
    rest: () => { certifyActivityView(this.state, []); return restOf(this.state) },
  })
  private readonly log = new ThreadMessageLog(id => this.threadChanges.mark(id))
  private readonly loaded = new OpenSessions(id => this.threads.get(id), id => this.threadChanges.mark(id))
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    for (const listener of this.listeners) listener(this.current())
    this.activityListeners.publish(historyFromEvents => this.activitySnapshot(historyFromEvents))
    this.threadChanges.publish()
  }, () => adapterItemCount(this.log, this.threads.values()))
  private readonly reaper: SessionReaper
  private history: ThreadHistorySource | undefined
  private launchProfiles: ThreadLaunchProfiles | undefined
  private readonly knownLaunchProfiles = new Map<string, WatcherLaunchProfile>()
  private browserTools: BrowserAgentTools | undefined
  private threadTools: readonly ScopedThreadTools[] = []
  private facts = new Map<string, AntigravityModelFacts>()
  private commands: AgentSkillCatalog['skills'] | undefined
  private executable: string | undefined
  private clientRevision = 0
  private httpToolServers = false
  private appendsSystemPrompt = false
  private generation = 0
  private writing = Promise.resolve()
  private state: AgentHostSnapshot = { connected: false, name: 'Antigravity', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true,
      reconcile: true, configureThread: true, configureThreadModel: true, skills: true, steer: true, compact: true } }
  readonly folders: AntigravityFolders
  private readonly usage: AntigravityUsageHooks | undefined
  readonly scanUsageHistory?: (sink: UsageHistorySink, signal: AbortSignal) => Promise<void>

  constructor(directory: string, private readonly options: AntigravityAcpOptions = {}) {
    this.folders = antigravityFolders(directory)
    // Usage knows each session Sotto owns by its `agy` session ID, so Sotto's own threads count as Sotto's, not Antigravity's app.
    this.usage = options.usageEnabled ? antigravityUsageHooks({ directory, owned: () => new Map(Object.entries(this.aliases).flatMap(([id, alias]) => alias.antigravitySessionId ? [[alias.antigravitySessionId, id] as const] : [])) }) : undefined
    if (this.usage) { const usage = this.usage; this.scanUsageHistory = (sink, signal) => usage.scanUsageHistory(sink, signal) }
    this.aliasStore = new AtomicJsonStore(join(directory, 'antigravity-threads.json'), aliasesSchema.parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(directory, 'antigravity-projects.json'), projectsSchema.parse, () => [])
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs === undefined ? {} : { sweepEveryMs: options.reaperSweepMs }),
      ...(options.sessionIdleMs === undefined ? {} : { idleAfterMs: options.sessionIdleMs }),
      isWatched: id => this.observed.has(id),
      isBusy: id => this.busy(id),
      whyBusy: id => busyHolds({ busy: this.foregroundWorking(id), request: this.asking(id), background: this.backgroundWorking(id) }),
      stop: id => this.stopSession(id),
    })
  }
  heldSessions(): HeldSession[] { return this.reaper.held(id => this.connections.get(id)?.rpc.pid) }

  // ---- What the adapter publishes ------------------------------------------------------------------------------------

  private current(historyFromEvents = false): AgentHostSnapshot {
    if (historyFromEvents) return cloneActivitySnapshot(this.activitySnapshot(true))
    return cloneHostSnapshot({ ...this.state, threads: [...this.threads.values()].map(thread => this.log.publishedThread(thread)) })
  }
  private activitySnapshot(historyFromEvents: boolean): AgentHostSnapshot {
    certifyActivityView(this.state, this.threads.values())
    return { ...this.state, threads: [...this.threads.values()].map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
  private activityThread(id: string, historyFromEvents: boolean): AgentThread | undefined {
    const thread = this.threads.get(id)
    if (!thread) return undefined
    certifyActivityView(this.state, [thread])
    return this.log.activityThread(thread, historyFromEvents)
  }
  private changed(id: string): void { this.threadChanges.mark(id) }
  private emit(streaming = false): void { this.publisher.publish(streaming); this.stopOutdated() }
  /** The program this adapter starts, so the row's sign-in uses the same client with the same folder. */
  async clientExecutable(): Promise<string | undefined> { return this.executable ?? this.options.executable ?? findAntigravityExecutable(this.options.environment, await this.options.lookup?.()) }
  async signInNow(): Promise<AntigravitySignIn> { return await this.options.signIn?.() ?? GOOGLE_ACCOUNT }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    return this.threadChanges.subscribeActivityChanges(listener, options)
  }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  useThreadHistory(source: ThreadHistorySource): void { this.history = source }
  useLaunchProfiles(profiles: ThreadLaunchProfiles): void { this.launchProfiles = profiles }
  useBrowserTools(tools: BrowserAgentTools): void { this.browserTools = tools }
  useThreadTools(tools: readonly ScopedThreadTools[]): void { this.threadTools = tools }
  private persist(): Promise<void> { this.writing = this.aliasStore.write(this.aliases); return this.writing }
  /** ADR-0140: stop the thread's process, remove its alias and every per-thread record, and persist. */
  async forgetThread(id: string): Promise<void> {
    this.forgottenAliasIds.add(id)
    if (!this.aliasesLoaded) {
      const current = await this.aliasStore.read()
      if (!(id in current)) return
      const next = { ...current }
      delete next[id]
      await this.aliasStore.write(next)
      return
    }
    if (!this.aliases[id]) return
    await this.loading.get(id)?.catch(() => undefined)
    await this.stopSession(id)
    this.reaper.forget(id)
    this.observed.delete(id); this.outdated.delete(id); this.dispatching.delete(id); this.loaded.delete(id)
    this.backgroundGone(id)
    this.endTurn(id, 'interrupted')
    this.turns.delete(id)
    this.reactiveTurnCounts.delete(id)
    this.backgroundCommands.delete(id)
    this.backgroundTasks.delete(id)
    this.lookingBeforeEnd.delete(id)
    this.compactions.delete(id); this.compactedSince.delete(id); this.compactionAnswered.delete(id)
    for (const [rowId, watch] of [...this.children]) if (watch.threadId === id) this.children.delete(rowId)
    if (!this.children.size && !this.readingChildren && this.childTimer) { clearInterval(this.childTimer); this.childTimer = undefined }
    for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id) this.pending.delete(requestId)
    this.knownLaunchProfiles.delete(id)
    this.indexes.delete(id)
    this.log.forget(id)
    this.threads.delete(id)
    delete this.aliases[id]
    await this.persist()
    if (this.state.connected) this.emit()
  }
  private indexOf(id: string, alias: Alias): ThreadIndex {
    let index = this.indexes.get(id)
    if (!index || index.alias !== alias) { index = new ThreadIndex(alias); this.indexes.set(id, index) }
    return index
  }
  private thread(id: string): AgentThread {
    const alias = this.aliases[id]
    if (!alias) throw new Error('This Antigravity thread does not exist.')
    let thread = this.threads.get(id)
    if (!thread) {
      thread = { id, projectId: alias.projectId, title: alias.title, workingDirectory: alias.cwd, modelId: alias.modelId, runtimeMode: alias.runtimeMode,
        ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}),
        status: alias.antigravitySessionId ? 'idle' : 'error', messages: [], requests: [] }
      this.threads.set(id, thread)
      if (this.connections.has(id) && !this.loading.has(id)) this.loaded.add(id)
    }
    this.changed(id)
    return thread
  }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new AntigravityUncertain('Antigravity’s connection changed before this could finish.')
  }

  // ---- Watcher -------------------------------------------------------------------------------------------------------

  /** Watcher's launch profile for this thread, or undefined for every other thread (ADR-0073). */
  private async launchProfile(id: string, rpc?: AntigravityRpc): Promise<WatcherLaunchProfile | undefined> {
    const generation = this.generation, resolver = this.launchProfiles, connection = this.connections.get(id)
    const current = (): boolean => generation === this.generation && resolver === this.launchProfiles && (!rpc || this.connections.get(id)?.rpc === rpc)
    try {
      const profile = await resolver?.profileFor(id)
      if (!current()) throw new AntigravityUncertain('Antigravity’s connection changed while the thread’s profile was checked.')
      if (profile) { validateWatcherProfile(profile); this.knownLaunchProfiles.set(id, profile) }
      else if (this.knownLaunchProfiles.has(id)) throw new WatcherProfileRefusal('Watcher’s tools are no longer admitted. Its session was stopped. Reopen Watcher to recover.')
      return profile
    } catch (error) {
      if (!current()) throw new AntigravityUncertain('Antigravity’s connection changed while the thread’s profile was checked.')
      const refusal = error instanceof WatcherProfileRefusal ? error : new WatcherProfileRefusal('Watcher’s saved profile could not be verified. Its session was stopped. Reopen Watcher to recover.')
      if (this.connections.get(id) === connection) {
        try { this.revokeProfile(id, this.knownLaunchProfiles.get(id), refusal.message) } catch { /* A broken server cleanup never keeps the process alive. */ }
      }
      throw refusal
    }
  }
  private async checkLaunchProfile(id: string): Promise<WatcherLaunchProfile | undefined> {
    const generation = this.generation, connection = this.connections.get(id)
    const profile = await this.launchProfile(id)
    this.assertGeneration(generation)
    if (profile && connection && !connection.watcher) {
      const reason = 'This Antigravity process started without Watcher’s tools. Nothing was sent. Reopen Watcher.'
      this.revokeProfile(id, profile, reason)
      throw new WatcherProfileRefusal(reason)
    }
    return profile
  }
  private revokeProfile(id: string, profile: WatcherLaunchProfile | undefined, reason: string): void {
    this.endTurn(id, 'failed')
    const connection = this.connections.get(id)
    this.connections.delete(id); this.loaded.delete(id); this.outdated.delete(id); this.log.release(id); this.reaper.forget(id)
    for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id) {
      this.pending.delete(requestId)
      if (!pending.answering) void pending.connection.rpc.reply(pending.wireId, antigravityDecline(pending)).catch(() => undefined)
    }
    const thread = this.threads.get(id)
    if (thread) { thread.requests = []; thread.status = 'error'; thread.requestNotice = reason; this.changed(id) }
    if (connection) this.close(connection)
    try { profile?.revoke(reason) } finally { this.emit() }
  }
  profileRefusalHandler(id: string) {
    const generation = this.generation, connection = this.connections.get(id)
    if (!connection) return undefined
    return (reason: string): void => {
      if (generation === this.generation && this.connections.get(id) === connection) this.revokeProfile(id, this.knownLaunchProfiles.get(id), reason)
    }
  }
  /**
   * Sotto's tool servers for this thread, each with the thread's bearer token, then the user's own from their `agy` setup.
   * Watcher's thread gets its own only: never the browser, never the user's.
   */
  private async toolServers(id: string, connection: Connection): Promise<AntigravitySessionServer[]> {
    if (connection.watcher) {
      const profile = await this.launchProfile(id)
      if (!profile) throw new WatcherProfileRefusal('Watcher’s tools are no longer admitted. Nothing was sent. Reopen Watcher to recover.')
      if (!this.httpToolServers || !this.appendsSystemPrompt) throw new WatcherProfileRefusal(WATCHER_WITHOUT_TOOLS)
      const scoped = await scopedThreadServers(watcherThreadTools(this.threadTools), id)
      // agy 1.5.14 names an MCP permission "Run mcp_<server>_<tool>". Bind those exact names to this launch or resume.
      connection.watcherToolTitles = new Set([
        ...profile.toolNames.map(name => `Run mcp_${profile.server.name}_${name}`),
        ...scoped.flatMap(({ server, tools }) => (tools.definitionsFor?.(id) ?? tools.definitions)
          .map(tool => `Run mcp_${server.name}_${tool.name}`)),
      ])
      return [{ name: profile.server.name, type: profile.server.type, url: profile.server.url, headers: profile.server.headers.map(header => ({ ...header })) },
        ...scoped.map(({ server }) => server)]
    }
    const servers: AntigravitySessionServer[] = []
    if (this.httpToolServers) {
      if (this.browserTools) servers.push(await this.browserTools.mcpServer(id))
      for (const { server } of await scopedThreadServers(this.threadTools, id)) servers.push(server)
    }
    if (!this.options.userMcpConfig) { connection.stdioMcpServers = []; return servers }
    // Sotto's own keep their names: a server of the user's with one of them is left out.
    const taken = new Set(servers.map(server => server.name))
    for (const server of await readAntigravityUserServers(this.options.userMcpConfig, this.httpToolServers)) if (!taken.has(server.name)) servers.push(server)
    connection.stdioMcpServers = servers.filter((server): server is AntigravityStdioServer => 'command' in server)
    return servers
  }
  /** What a session starts with besides its folder and tools: Watcher's instructions, or Sotto's question panel reminder. */
  private async sessionMeta(id: string, watcher: boolean): Promise<Record<string, unknown> | undefined> {
    if (!watcher) {
      return this.appendsSystemPrompt ? { antigravity: { systemPrompt: { append: ANTIGRAVITY_QUESTIONS } } } : undefined
    }
    const profile = await this.launchProfile(id)
    if (!profile) throw new WatcherProfileRefusal('Watcher’s tools are no longer admitted. Nothing was sent. Reopen Watcher to recover.')
    return { antigravity: { systemPrompt: { append: profile.instructions ?? WATCHER_SYSTEM_PROMPT } } }
  }

  // ---- Processes -----------------------------------------------------------------------------------------------------

  /** The arguments a test's fake client takes before `agy`'s own; none for `agy` itself. */
  private prefix(executable: string): readonly string[] { return executable === this.options.executable ? this.options.executableArgs ?? [] : [] }
  private spawn(executable: string, args: readonly string[], cwd: string, signIn: AntigravitySignIn, receive: (frame: AntigravityFrame, rpc: AntigravityRpc) => Promise<void> | void, lost: () => void): AntigravityRpc {
    const rpc: AntigravityRpc = new AntigravityRpc(executable, [...this.prefix(executable), ...args], cwd, antigravityEnvironment(this.folders, signIn, this.options.environment), this.options.requestTimeoutMs ?? 30_000, frame => receive(frame, rpc), lost)
    const release = leaseAntigravityRuntime(executable)
    this.processes.add(rpc); void rpc.closed.then(() => { this.processes.delete(rpc); release() })
    return rpc
  }
  /**
   * `initialize`, then `authenticate` with the sign-in method, as T3 does on every start. A method `agy` does not offer,
   * or no sign-in, is refused in words. `forms` is a thread's own process, other than Watcher's, which takes `agy`'s questions.
   */
  private async handshake(rpc: AntigravityRpc, signIn: AntigravitySignIn, forms = false): Promise<AntigravityClient> {
    let client: AntigravityClient | undefined
    await this.sendInitialize(rpc, value => { client = initializeSchema.parse(value) }, forms)
    if (client!.protocolVersion !== ANTIGRAVITY_ACP_VERSION) throw new ProviderUnavailable('cannot-start', `Sotto speaks ACP ${ANTIGRAVITY_ACP_VERSION}, and this Antigravity client answered ACP ${client!.protocolVersion}.`)
    const version = client!.agentInfo?.version
    if (!version || !meetsAntigravityFloor(version)) {
      throw new ProviderUnavailable('too-old', `Antigravity ${ANTIGRAVITY_CLI_FLOOR} or newer is needed${version ? `, and this one is ${version}` : ''}. Update Antigravity, then connect again. Your threads are kept.`, version, ANTIGRAVITY_CLI_FLOOR)
    }
    try { await rpc.request('authenticate', { methodId: signIn.method }) }
    catch (error) {
      if (error instanceof AntigravityRejected) throw new ProviderUnavailable('signed-out', 'Antigravity is not signed in. Sign in from Antigravity’s row in Settings › Providers, then connect again. Your threads are kept.', version)
      throw error
    }
    return client!
  }
  private async startProcess(id: string, alias: Alias, cwd: string, watcher: boolean): Promise<Connection> {
    const executable = this.executable
    if (!executable || !this.state.connected) throw new Error('Connect Antigravity before using its threads.')
    const signIn = await this.signInNow()
    await writeAntigravitySettings(this.folders, signIn)
    const connection = { rpc: undefined as unknown as AntigravityRpc, nonce: randomUUID(), clientRevision: this.clientRevision, watcher,
      client: undefined as unknown as AntigravityClient, closing: false, model: undefined, effort: undefined, mode: undefined, effortOption: undefined,
      modeIsOption: false, offersAuto: false, commands: undefined } as Connection
    const rpc = this.spawn(executable, antigravityArguments(this.folders), cwd, signIn, frame => this.frame(id, connection, frame), () => this.processLost(id, connection))
    ;(connection as { rpc: AntigravityRpc }).rpc = rpc
    try { (connection as { client: AntigravityClient }).client = await this.handshake(rpc, signIn, !watcher) }
    catch (error) { connection.closing = true; rpc.close(); throw error }
    void alias
    return connection
  }
  private close(connection: Connection): void { connection.closing = true; connection.rpc.close() }

  // ---- Connecting ----------------------------------------------------------------------------------------------------

  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    try {
      await mkdir(this.folders.gemini, { recursive: true })
      const executable = this.options.executable ?? await findAntigravityExecutable(this.options.environment, await this.options.lookup?.())
      if (!executable || !isAbsolute(executable)) throw new ProviderUnavailable('not-installed', 'Install Antigravity from its row in Settings › Providers, then connect again. Your threads are kept.')
      const signIn = await this.signInNow()
      const issue = antigravitySignInIssue(signIn)
      if (issue) throw new ProviderUnavailable('signed-out', `${issue} Your threads are kept.`)
      await writeAntigravitySettings(this.folders, signIn)
      const version = await this.readCatalog(executable, signIn, generation)
      if (!this.state.models.length) throw new ProviderUnavailable('signed-out', 'Antigravity listed no models for this account. Sign in again, then connect. Your threads are kept.', version)
      const [aliases, projects] = await Promise.all([this.aliasStore.read(), this.projectStore.read()])
      this.assertGeneration(generation)
      for (const id of this.forgottenAliasIds) delete aliases[id]
      this.aliases = aliases; this.aliasesLoaded = true; this.indexes.clear(); this.state.projects = projects; this.executable = executable
      this.threads.clear(); this.threadChanges.markAll(); this.log.forgetAll()
      for (const id of Object.keys(this.aliases)) { this.thread(id); this.log.seed(id, this.history?.messageIdentities(id) ?? []) }
      this.state.connected = true; this.state.version = `${version ?? 'unknown'} / ACP ${ANTIGRAVITY_ACP_VERSION}`
      delete this.state.error; delete this.state.problem; delete this.state.requiredVersion
      await Promise.all([...this.observed].filter(id => this.aliases[id]?.antigravitySessionId).map(id => this.open(id).catch((error: unknown) => {
        if (generation !== this.generation) return
        this.markOpenFailed(id, error)
      })))
      this.assertGeneration(generation)
      this.restoreChildWatches()
      this.reaper.start(); this.emit(); return this.current()
    } catch (error) {
      if (generation === this.generation) this.disconnect()
      if (error instanceof WatcherProfileRefusal) throw error
      const refused = error instanceof ProviderUnavailable
      const detail = refused || error instanceof AntigravityUncertain ? error.message : ''
      const message = ['Could not connect Antigravity.', detail, refused ? '' : 'Connect again to retry.'].filter(Boolean).join(' ')
      if (refused) throw new ProviderUnavailable(error.problem, message, error.version, error.requiredVersion)
      throw new Error(message, { cause: error })
    }
  }
  /**
   * The account's models, read the way T3 reads them: a session of its own in a scratch folder, its `model` option, and
   * each model chosen in turn to read the thinking it offers. The scratch session's files are removed once it ends.
   * Answers the client's version.
   */
  private async readCatalog(executable: string, signIn: AntigravitySignIn, generation: number): Promise<string | undefined> {
    const scratch = join(this.folders.scratch, randomUUID())
    let probe: AntigravityRpc | undefined
    let sessionId: string | undefined
    try {
      await mkdir(scratch, { recursive: true })
      probe = this.spawn(executable, antigravityArguments(this.folders), scratch, signIn, (frame, rpc) => {
        if (frame.method && frame.id !== undefined) void rpc.reply(frame.id, antigravityDecline()).catch(() => undefined)
      }, () => undefined)
      const client = await this.handshake(probe, signIn)
      // agy 1.5.13 advertises no mcpCapabilities, yet takes HTTP MCP servers in session/new and calls them, as T3 hands them
      // over (checked live, November 21, 2026). So Sotto's tools go to agy unless it says it cannot take them.
      this.httpToolServers = client.agentCapabilities.mcpCapabilities?.http !== false
      this.appendsSystemPrompt = client.agentCapabilities._meta?.antigravity?.systemPrompt?.append === true
      const images = client.agentCapabilities.promptCapabilities?.image === true
      let settings: AntigravitySessionSettings = {}
      await probe.request('session/new', { cwd: scratch, mcpServers: [] }, value => { const answer = sessionNewSchema.parse(value); sessionId = answer.sessionId; settings = answer })
      const current = antigravityCurrentModel(settings)
      const offersAuto = antigravityOffersAuto(settings)
      const choices = antigravityModelChoices(settings)
      const models: AntigravityModelThinking[] = []
      for (const choice of choices) {
        let thinking = choice.id === current ? antigravityThinking(settings) : undefined
        if (choice.id !== current) {
          await probe.request('session/set_config_option', { sessionId, configId: 'model', value: choice.id }, value => { thinking = antigravityThinking(antigravitySessionSettingsSchema.parse(value)) })
            .catch(() => undefined)
        }
        models.push({ id: choice.id, name: choice.name, ...(thinking ? { thinking } : {}) })
      }
      this.assertGeneration(generation)
      const facts = antigravityCatalog(models, { images, offersAuto, current })
      this.facts = new Map(facts.map(entry => [entry.model.id, entry]))
      this.state.models = facts.map(entry => entry.model)
      return client.agentInfo?.version
    } finally {
      // The scratch folder goes even when `agy` could not be started at all.
      if (probe) { probe.close(); await probe.closed }
      await this.removeScratchSession(scratch, sessionId)
    }
  }
  /** A scratch session's own files in Sotto's folder, as T3 removes its helpers': the conversation and its brain. Nothing else. */
  private async removeScratchSession(scratch: string | undefined, sessionId: string | undefined): Promise<void> {
    const safe = sessionId && /^[A-Za-z0-9-]{8,128}$/u.test(sessionId) ? sessionId : undefined
    await Promise.all([
      ...(scratch ? [rm(scratch, { recursive: true, force: true })] : []),
      ...(safe ? [rm(join(this.folders.appData, 'brain', safe), { recursive: true, force: true }),
        ...['', '-wal', '-shm', '-journal'].map(suffix => rm(join(this.folders.appData, 'conversations', `${safe}.db${suffix}`), { force: true }))] : []),
    ].map(work => work.catch(() => undefined)))
  }
  /**
   * ACP `initialize`: no file or terminal capability, Sotto's name, and the start's own deadline, since `agy` unpacks
   * itself first. A thread's own process, never Watcher's, also takes forms, which `agy`'s own questions need
   * (`antigravityRequests.ts`); without them `agy` asks in its reply, and Watcher asks with Sotto's `ask_user` (ADR-0073).
   */
  private sendInitialize(rpc: AntigravityRpc, read: (value: unknown) => void, forms = false): Promise<void> {
    return rpc.request('initialize', { protocolVersion: ANTIGRAVITY_ACP_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(forms ? { elicitation: { form: {} } } : {}) },
      clientInfo: { name: 'sotto', title: 'Sotto', version: appVersion } }, read, false, this.options.startTimeoutMs ?? 90_000)
  }
  /** One `agy acp` of its own, for a sign-in or a sign-out, in a scratch folder: initialized, then handed to `work`, then closed. */
  private async accountProcess<T>(work: (rpc: AntigravityRpc, signIn: AntigravitySignIn) => Promise<T>): Promise<T> {
    const executable = this.options.executable ?? await findAntigravityExecutable(this.options.environment, await this.options.lookup?.())
    if (!executable) throw new Error('Install Antigravity from its row in Settings › Providers first. Nothing was signed in.')
    const signIn = await this.signInNow()
    await writeAntigravitySettings(this.folders, signIn)
    const scratch = join(this.folders.scratch, randomUUID())
    let rpc: AntigravityRpc | undefined
    try {
      await mkdir(scratch, { recursive: true })
      rpc = this.spawn(executable, antigravityArguments(this.folders), scratch, signIn, (frame, process) => {
        if (frame.method && frame.id !== undefined) void process.reply(frame.id, antigravityDecline()).catch(() => undefined)
      }, () => undefined)
      await this.sendInitialize(rpc, () => undefined)
      return await work(rpc, signIn)
    } finally {
      if (rpc) { rpc.close(); await rpc.closed }
      await this.removeScratchSession(scratch, undefined)
    }
  }
  /**
   * Gemini Enterprise's sign-in, as T3 runs it: ACP `authenticate` with `oauth-business`, which `agy` finishes in a
   * browser on this computer and its own callback on this computer. It runs only on a press of Sign in in Settings, and
   * the user has up to fifteen minutes. The caller connects Antigravity once it has signed in.
   */
  async signInWithBrowser(): Promise<void> {
    const signIn = await this.signInNow()
    if (signIn.method !== 'oauth-business') throw new Error('Choose Gemini Enterprise first. Nothing was signed in.')
    const issue = antigravitySignInIssue(signIn)
    if (issue) throw new Error(`${issue} Nothing was signed in.`)
    await this.accountProcess(rpc => rpc.request('authenticate', { methodId: 'oauth-business' }, () => undefined, false, 15 * 60_000))
      .catch((error: unknown) => { throw new Error('Gemini Enterprise did not finish signing in. Nothing was signed in. Try Sign in again.', { cause: error }) })
  }
  /**
   * Sign out, as T3 does it: Antigravity's processes stop and `agy` is told to log out of Sotto's own folder. Threads and
   * their history are kept. A key is the credential store's to clear.
   */
  async signOut(): Promise<void> {
    this.disconnect(); await this.closed()
    await this.accountProcess(rpc => rpc.request('logout', {}))
      .catch((error: unknown) => { throw new Error('Antigravity could not sign out. Your threads are kept. Try Sign out again.', { cause: error }) })
  }
  private markOpenFailed(id: string, error: unknown): void {
    if (!this.aliases[id]) return
    this.thread(id).status = 'error'
    if (error instanceof WatcherHistoryRefusal) { this.emit(); return }
    this.state.error = error instanceof Error && error.message ? error.message : 'An Antigravity thread could not be opened. Your thread is kept. Reconnect Antigravity to try again.'
    this.emit()
  }
  /**
   * `agy` on disk was updated while Sotto stayed connected (ADR-0042): each thread moves onto it as it goes idle, and the
   * account's models are read again from the new client (parity slice 8), as a connect reads them, so the menus offer what
   * it offers. A read that fails keeps the list from before, as it was: the update itself still holds, and the next
   * connect reads the list again.
   */
  async clientUpdated(): Promise<void> {
    if (!this.state.connected) return
    const generation = this.generation
    const executable = this.options.executable ?? await findAntigravityExecutable(this.options.environment, await this.options.lookup?.()).catch(() => undefined)
    if (generation !== this.generation || !this.state.connected) return
    if (!executable) throw new Error('Antigravity was updated, but Sotto cannot find it now. Threads that are working carry on and nothing was lost. Connect Antigravity again.')
    const version = await readAntigravityVersion(executable, this.prefix(executable), antigravityEnvironment(this.folders, await this.signInNow(), this.options.environment))
    if (generation !== this.generation || !this.state.connected) return
    if (!version) throw new Error('Antigravity was updated, but the new version did not answer. Threads that are working carry on and nothing was lost. Connect Antigravity again to try the new version.')
    if (!meetsAntigravityFloor(version)) throw new Error(`Antigravity was updated, but Sotto cannot run ${version}: ${ANTIGRAVITY_CLI_FLOOR} or newer is needed. Threads that are working carry on and nothing was lost.`)
    await this.readCatalog(executable, await this.signInNow(), generation).catch(() => undefined)
    if (generation !== this.generation || !this.state.connected) return
    this.executable = executable; this.clientRevision++
    this.state.version = `${version} / ACP ${ANTIGRAVITY_ACP_VERSION}`
    for (const [id, connection] of this.connections) if (connection.clientRevision < this.clientRevision) this.outdated.add(id)
    this.emit()
  }
  private stopOutdated(): void {
    if (!this.outdated.size) return
    for (const id of [...this.outdated]) {
      const connection = this.connections.get(id)
      if (!connection || connection.clientRevision === this.clientRevision) { this.outdated.delete(id); continue }
      if (this.busy(id)) continue
      this.outdated.delete(id)
      const generation = this.generation
      void this.stopSession(id).then(() => {
        if (generation === this.generation && this.observed.has(id) && this.aliases[id]?.antigravitySessionId) return this.open(id).then(() => undefined)
      }).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
    }
  }

  // ---- Sessions ------------------------------------------------------------------------------------------------------

  private busy(id: string): boolean { return this.working(id) || this.asking(id) }
  private foregroundWorking(id: string): boolean {
    const turn = this.turns.get(id)
    return this.dispatching.has(id) || this.loading.has(id) || this.stopping.has(id) || this.compactions.has(id) || (turn !== undefined && !turn.ended)
  }
  private backgroundWorking(id: string): boolean {
    return [...this.children.values()].some(watch => watch.threadId === id && watch.answeredAt === undefined)
      || Boolean(this.threads.get(id)?.backgroundWork?.length)
  }
  private working(id: string): boolean { return this.foregroundWorking(id) || this.backgroundWorking(id) }
  private backgroundWatch(id: string): BackgroundCommandWatch {
    let watch = this.backgroundCommands.get(id)
    if (!watch) {
      watch = new BackgroundCommandWatch({
        children: this.options.childProcesses ?? childProcesses,
        command: row => antigravityBackgroundCommand(this.connections.get(id)?.stdioMcpServers ?? [], row),
        changed: () => {
          if (!this.syncBackgroundWork(id)) return
          const looking = this.lookingBeforeEnd.get(id)
          if (looking) { looking.changed = true; return }
          this.emit()
        },
        admitting: () => { const turn = this.turns.get(id); return turn === undefined || turn.ended },
      })
      this.backgroundCommands.set(id, watch)
    }
    return watch
  }
  private backgroundTasksFor(id: string): AntigravityBackgroundTasks {
    let tasks = this.backgroundTasks.get(id)
    if (!tasks) { tasks = new AntigravityBackgroundTasks(); this.backgroundTasks.set(id, tasks) }
    return tasks
  }
  private syncBackgroundWork(id: string): boolean {
    const thread = this.threads.get(id)
    if (!thread) return false
    const activeSubagents = new Set<string>()
    const subagents: AgentBackgroundWork[] = []
    for (const watch of this.children.values()) {
      if (watch.threadId !== id || watch.answeredAt !== undefined) continue
      activeSubagents.add(watch.toolCallId)
      const label = sanitizeAntigravityWorkLabel(watch.row.agents?.[0]?.title ?? watch.row.title) ?? BACKGROUND_WORK_LABELS.subagent
      const startedAt = watch.row.agents?.[0]?.startedAt ?? watch.row.startedAt
      subagents.push({ id: watch.backgroundId, label, type: 'subagent', ...(startedAt ? { startedAt } : {}) })
    }
    const turn = this.turns.get(id), turnRunning = turn !== undefined && !turn.ended
    const commands = this.backgroundCommands.get(id)?.working ?? []
    const tasks = this.backgroundTasks.get(id)?.working(activeSubagents, commands, turnRunning) ?? []
    const work = mergeAntigravityBackgroundWork([...subagents, ...commands, ...tasks])
    const before = thread.backgroundWork ?? []
    if (before.length === work.length && before.every((item, index) => item.id === work[index]!.id && item.label === work[index]!.label)) return false
    if (work.length) thread.backgroundWork = work; else delete thread.backgroundWork
    this.changed(id)
    return true
  }
  private watchBackground(id: string): void {
    const pid = this.connections.get(id)?.rpc.pid
    if (pid !== undefined) this.backgroundWatch(id).turnEnded(pid)
  }
  private async lookBeforeEnd(id: string, turn: LiveTurn): Promise<boolean> {
    const pid = this.connections.get(id)?.rpc.pid
    if (pid === undefined || (!turn.ranCommand && !this.backgroundTasks.get(id)?.hasAny)) return false
    let entry = this.lookingBeforeEnd.get(id)
    if (!entry) { entry = { depth: 0, changed: false }; this.lookingBeforeEnd.set(id, entry) }
    entry.depth++
    try {
      await this.backgroundWatch(id).lookNow(pid, this.options.lookBeforeEndMs ?? LOOK_BEFORE_END_MS)
      return entry.changed
    } finally {
      entry.depth--
      if (entry.depth <= 0 && this.lookingBeforeEnd.get(id) === entry) this.lookingBeforeEnd.delete(id)
    }
  }
  private backgroundGone(id: string): void {
    const watch = this.backgroundCommands.get(id)
    if (watch) { this.backgroundCommands.delete(id); watch.stop() }
    this.backgroundTasks.get(id)?.clear()
    this.syncBackgroundWork(id)
  }
  private clearReactiveTimers(turn: LiveTurn): void {
    if (turn.reactiveTimer) { clearTimeout(turn.reactiveTimer); turn.reactiveTimer = undefined }
    if (turn.reactiveMaxTimer) { clearTimeout(turn.reactiveMaxTimer); turn.reactiveMaxTimer = undefined }
  }
  private createTurn(placesKey: string, origin: Origin | undefined, outcome: AntigravityOutcomeWatcher, reactive: boolean, inheritedPlaces?: TurnPlaces): LiveTurn {
    return { places: new TurnPlaces(placesKey, inheritedPlaces), origin, taken: origin === undefined, ended: false, prompts: 0, wake: undefined, outcome,
      reactive, ranCommand: false, reactiveTools: new Set(), sawReactiveContent: false, reactiveRev: 0, reactiveTimer: undefined, reactiveMaxTimer: undefined }
  }
  private nextReactiveTurnId(id: string, turn: LiveTurn | undefined): string {
    const current = this.threads.get(id)?.lastTurn?.id ?? turn?.places.key ?? ''
    const suffixMatch = current.match(/:wakeup:(\d+)$/u)
    const parsedSuffix = suffixMatch ? Number(suffixMatch[1]) : 0
    const next = Math.max(this.reactiveTurnCounts.get(id) ?? 0, Number.isSafeInteger(parsedSuffix) ? parsedSuffix : 0) + 1
    this.reactiveTurnCounts.set(id, next)
    const baseRaw = turn?.origin?.messageId ?? this.log.lastUserMessageId(id) ?? 'antigravity-history'
    const base = baseRaw.replace(/:wakeup:\d+$/u, '')
    return `${base}:wakeup:${next}`
  }
  private startReactiveTurn(id: string, currentTurn: LiveTurn | undefined): LiveTurn {
    if (currentTurn) this.clearReactiveTimers(currentTurn)
    const turnKey = this.nextReactiveTurnId(id, currentTurn)
    const turn = this.createTurn(turnKey, undefined, TYPED_ONLY_OUTCOME, true, currentTurn?.places)
    this.turns.set(id, turn)
    const thread = this.thread(id)
    thread.status = 'running'
    thread.lastTurn = { id: turnKey, status: 'running' }
    thread.activities = markTurnActivity(thread.activities, { provider: 'antigravity', turnId: turnKey, status: 'running' })
    this.changed(id)
    this.armReactiveSettle(id, turn)
    this.armReactiveMaxTimer(id, turn)
    return turn
  }
  private armReactiveMaxTimer(id: string, turn: LiveTurn): void {
    if (!turn.reactive || turn.ended || turn.reactiveMaxTimer || this.asking(id)) return
    const generation = this.generation
    turn.reactiveMaxTimer = setTimeout(() => { turn.reactiveMaxTimer = undefined; void this.settleReactiveTurn(id, turn, generation, true) },
      this.options.reactiveTurnMaxMs ?? REACTIVE_TURN_MAX_MS)
    turn.reactiveMaxTimer.unref?.()
  }
  private armReactiveSettle(id: string, turn: LiveTurn): void {
    if (turn.reactiveTimer) { clearTimeout(turn.reactiveTimer); turn.reactiveTimer = undefined }
    if (!turn.reactive || turn.ended || turn.reactiveTools.size > 0 || this.asking(id)) return
    const generation = this.generation
    const settleMs = this.options.reactiveTurnSettleMs ?? REACTIVE_TURN_SETTLE_MS
    const waitMs = this.options.reactiveTurnWaitMs
      ?? (this.options.reactiveTurnSettleMs !== undefined ? Math.min(REACTIVE_TURN_WAIT_MS, Math.max(settleMs * 4, settleMs)) : REACTIVE_TURN_WAIT_MS)
    const delayMs = turn.sawReactiveContent ? settleMs : waitMs
    turn.reactiveTimer = setTimeout(() => { turn.reactiveTimer = undefined; void this.settleReactiveTurn(id, turn, generation, false) }, delayMs)
    turn.reactiveTimer.unref?.()
  }
  private async settleReactiveTurn(id: string, turn: LiveTurn, generation: number, force = false): Promise<void> {
    if (generation !== this.generation || this.turns.get(id) !== turn || !turn.reactive || turn.ended || (!force && turn.reactiveTools.size > 0) || this.asking(id)) return
    const rev = turn.reactiveRev
    const bgChanged = await this.lookBeforeEnd(id, turn)
    if (generation !== this.generation || this.turns.get(id) !== turn || !turn.reactive || turn.ended || this.asking(id)) {
      if (bgChanged && generation === this.generation) this.emit()
      return
    }
    if (!force && (turn.reactiveRev !== rev || turn.reactiveTools.size > 0)) {
      if (bgChanged) this.emit()
      if (!turn.reactiveTimer) this.armReactiveSettle(id, turn)
      return
    }
    this.closeForms(id)
    this.endTurn(id, 'completed')
    this.emit()
  }
  private asking(id: string): boolean { return (this.threads.get(id)?.requests.length ?? 0) > 0 }
  private open(id: string): Promise<Connection> {
    const stopping = this.stopping.get(id)
    if (stopping) return stopping.then(() => this.open(id))
    const loading = this.loading.get(id); if (loading) return loading
    const existing = this.connections.get(id); if (existing) return Promise.resolve(existing)
    const work = this.load(id).finally(() => { if (this.loading.get(id) === work) { this.loading.delete(id); if (this.connections.has(id)) { this.loaded.add(id); this.emit() } } })
    this.loading.set(id, work)
    return work
  }
  private async load(id: string): Promise<Connection> {
    const generation = this.generation
    const profile = await this.launchProfile(id)
    this.assertGeneration(generation)
    const alias = this.aliases[id]
    if (!alias?.antigravitySessionId) throw new Error('Antigravity did not confirm this thread’s session. Your thread is kept. Start a new thread to carry on.')
    const cwd = await existingWorkingDirectory(alias.cwd)
    this.assertGeneration(generation)
    const connection = await this.startProcess(id, alias, cwd, profile !== undefined)
    if (generation !== this.generation) { this.close(connection); throw new AntigravityUncertain('Antigravity’s connection changed while the thread was opening.') }
    this.connections.set(id, connection)
    try {
      const mcpServers = await this.toolServers(id, connection)
      const meta = await this.sessionMeta(id, connection.watcher)
      this.assertGeneration(generation)
      // T3 resumes rather than loads: a resumed session replays nothing, so no earlier tool call runs or shows again.
      await connection.rpc.request('session/resume', { sessionId: alias.antigravitySessionId, cwd: alias.cwd, mcpServers, ...(meta ? { _meta: meta } : {}) },
        value => { this.readSettings(connection, value) })
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new AntigravityUncertain('Antigravity’s connection changed while the thread was opening.')
      await this.applySettings(alias, connection)
      this.log.pin(id); this.reaper.touch(id)
      const thread = this.thread(id)
      if (!this.turns.get(id) || this.turns.get(id)!.ended) thread.status = 'idle'
      return connection
    } catch (error) {
      if (this.connections.get(id) === connection) this.connections.delete(id)
      this.close(connection)
      if (error instanceof AntigravityRejected) throw new Error('Antigravity could not open this thread’s saved session. Your Sotto history is kept. Start a new thread to carry on; Sotto will not resend earlier work.', { cause: error })
      throw error
    }
  }
  private stopSession(id: string): Promise<void> {
    const previous = this.stopping.get(id); if (previous) return previous
    const connection = this.connections.get(id)
    if (!connection) return Promise.resolve()
    const work = (async () => {
      this.connections.delete(id); this.outdated.delete(id)
      this.backgroundGone(id)
      if (this.loaded.delete(id)) this.emit()
      this.log.release(id); this.reaper.forget(id)
      this.close(connection); await connection.rpc.closed
    })().finally(() => { if (this.stopping.get(id) === work) this.stopping.delete(id) })
    this.stopping.set(id, work)
    return work
  }
  private processLost(id: string, connection: Connection): void {
    if (connection.closing || this.connections.get(id) !== connection) return
    this.connections.delete(id); this.outdated.delete(id); this.loaded.delete(id); this.log.release(id); this.reaper.forget(id)
    this.backgroundGone(id)
    this.clearRequests(id)
    this.endTurn(id, 'failed', PROCESS_LOST)
    this.emit()
  }
  async startThreadSession(id: string, draft?: ThreadSessionDraft): Promise<void> {
    void draft
    const generation = this.generation
    await this.checkLaunchProfile(id)
    this.assertGeneration(generation)
    if (!this.state.connected || !this.aliases[id]?.antigravitySessionId) return
    await this.open(id)
    this.reaper.touch(id)
  }
  observeThreads(ids: readonly string[]): void {
    this.observed.clear(); for (const id of ids) this.observed.add(id)
    this.log.observe(ids)
    if (!this.state.connected) return
    const generation = this.generation
    for (const id of ids) if (this.aliases[id]?.antigravitySessionId) void this.open(id).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
  }
  async snapshot(): Promise<AgentHostSnapshot> { return this.current() }
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]?.antigravitySessionId) throw new Error('This Antigravity thread has no confirmed session.')
    const generation = this.generation
    await this.checkLaunchProfile(id)
    this.assertGeneration(generation)
    await this.open(id)
    return this.current(purpose?.historyFromEvents)
  }

  // ---- What Antigravity says -----------------------------------------------------------------------------------------

  /** The model, effort and mode a session answer names, and how its effort and mode are set. */
  private readSettings(connection: Connection, value: unknown): void {
    const settings = antigravitySessionSettingsSchema.parse(value ?? {})
    const model = antigravityCurrentModel(settings)
    if (model) connection.model = model
    if (settings.configOptions) {
      const thinking = antigravityThinking(settings)
      connection.effortOption = thinking?.id
      connection.effort = thinking?.current
      connection.modeIsOption = antigravityModeIsOption(settings)
    }
    if (settings.configOptions || settings.modes) {
      const mode = antigravityCurrentMode(settings)
      if (mode) connection.mode = mode
      if (antigravityOffersAuto(settings)) connection.offersAuto = true
    }
  }
  private async frame(id: string, connection: Connection, frame: AntigravityFrame): Promise<void> {
    const alias = this.aliases[id]
    if (!alias || connection.closing) return
    const params = record(frame.params)
    if (frame.method === 'session/update') {
      const update = record(params?.update)
      if (!params || !update || (alias.antigravitySessionId && params.sessionId !== alias.antigravitySessionId)) return
      if (this.connections.get(id) !== connection) return
      this.liveUpdate(id, alias, connection, update)
      return
    }
    if (!frame.method || frame.id === undefined) return
    if (this.connections.get(id) !== connection) { connection.rpc.refuse(frame.id); return }
    this.taken(id)
    if ((frame.method === 'session/request_permission' || frame.method === ANTIGRAVITY_QUESTION) && alias.antigravitySessionId && params?.sessionId !== alias.antigravitySessionId) { connection.rpc.refuse(frame.id); return }
    // Watcher's process is offered no forms, so one that comes anyway is refused: its questions are Sotto's `ask_user`.
    const asked = connection.watcher && frame.method === ANTIGRAVITY_QUESTION ? undefined : antigravityPending(frame.id, frame.method, frame.params, id)
    if (!asked) {
      connection.rpc.refuse(frame.id)
      if (needsPerson(frame.method)) { const notice = unreadableRequest('Antigravity'); const thread = this.thread(id); thread.requestNotice = notice; this.state.error = notice; this.emit() }
      return
    }
    const requestId = `antigravity-request-${digest(JSON.stringify([id, connection.nonce, frame.id]))}`
    const pending: Pending = { ...asked, request: { ...asked.request, id: requestId }, connection }
    if (this.pending.has(requestId)) return
    if (connection.watcher) {
      try { await this.launchProfile(id, connection.rpc) } catch { return }
      if (this.connections.get(id) !== connection || connection.closing) return
    }
    const index = this.indexOf(id, alias)
    if (index.wasAnswered(requestId) || this.pending.size >= 128) { void connection.rpc.reply(frame.id, antigravityDecline(pending)).catch(() => undefined); return }
    // Watcher's scoped Sotto tools are admitted once on every mode (ADR-0073); its own permission mode answers
    // native permissions the same way an ordinary thread's mode does (ADR-0212, November 21, 2026 amendment).
    const automatic = (connection.watcher ? antigravityWatcherAdmission(connection.watcherToolTitles, pending) : undefined)
      ?? antigravityAutoAnswer(alias.runtimeMode, pending)
    if (automatic) { void connection.rpc.reply(frame.id, { outcome: { outcome: 'selected', optionId: automatic } }).catch(() => undefined); return }
    this.pending.set(requestId, pending)
    this.thread(id).requests.push(pending.request)
    const activeTurn = this.turns.get(id)
    if (activeTurn?.reactive && !activeTurn.ended) {
      activeTurn.reactiveRev++
      this.clearReactiveTimers(activeTurn)
    }
    this.reaper.touch(id); this.emit()
  }
  private liveUpdate(id: string, alias: Alias, connection: Connection, update: Record<string, unknown>): void {
    this.reaper.touch(id)
    const kind = String(update.sessionUpdate)
    if (kind === 'available_commands_update') {
      const parsed = commandsSchema.safeParse(update.availableCommands)
      if (parsed.success) {
        connection.commands = antigravitySkills(parsed.data); this.commands = connection.commands
        // Whether this client compacts is its own `/compact`, so Compact context is offered only where it is listed.
        const thread = this.threads.get(id), compacts = connection.commands.some(skill => skill.name === 'compact')
        if (thread && thread.manualCompactionSupported !== compacts) { thread.manualCompactionSupported = compacts; this.changed(id); this.emit() }
      }
      return
    }
    if (kind === 'config_option_update' || kind === 'current_mode_update') {
      if (kind === 'current_mode_update' && typeof update.currentModeId === 'string') connection.mode = update.currentModeId
      else this.readSettings(connection, update)
      return
    }
    if (kind === 'usage_update') {
      this.taken(id)
      if (this.compactions.has(id) || !countAntigravityFullness(this.thread(id), update)) return
      const boundary = this.compactedSince.get(id), after = this.thread(id).usage?.contextUsed
      // Only a reading with the size closes the boundary, and only its own: one that did not shrink is a later turn's growth, as for Codex.
      if (boundary && typeof update.used === 'number' && after !== undefined) {
        this.compactedSince.delete(id)
        if (boundary.before === undefined || after < boundary.before) { const thread = this.thread(id); thread.activities = markCompactionActivity(thread.activities, { ...boundary, after }); this.changed(id) }
      }
      this.emit(true); return
    }
    // A compaction is not a turn: anything `agy` says while it folds the conversation is not shown as the last turn's.
    if (this.compactions.has(id) && kind !== 'user_message_chunk') { if (kind === 'agent_message_chunk') this.compactionAnswered.add(id); return }
    if (!['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(kind)) { this.taken(id); return }
    const content = record(update.content)
    const words = content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined
    if (kind === 'user_message_chunk') {
      if (words === undefined) return
      const turn = this.turns.get(id)
      // `agy` may echo a prompt Sotto sent; Sotto already holds it. Anything else was typed into the session elsewhere.
      if (turn?.origin && !turn.ended && digest(words) === turn.origin.digest) { this.taken(id); return }
      // Out-of-turn background task completion notifications arrive from `agy`'s runtime, never from the user.
      const wakeup = parseAntigravitySystemWakeup(words)
      if (wakeup.isWakeup) {
        let settled = false
        const tasks = this.backgroundTasks.get(id)
        if (tasks) for (const taskId of wakeup.completedTaskIds) if (tasks.settleNativeTask(taskId)) settled = true
        if (settled && this.syncBackgroundWork(id)) this.emit()
        return
      }
      if (turn) this.clearReactiveTimers(turn)
      const index = alias.turns; alias.turns++
      void this.persist().catch(() => undefined)
      const key = `antigravity-user-${index}-${digest(words).slice(0, 16)}`
      this.log.add(id, { id: key, role: 'user', text: words, createdAt: new Date().toISOString() })
      this.turns.set(id, { ...this.createTurn(key, undefined, TYPED_ONLY_OUTCOME, false, turn?.places), ended: true })
      this.emit()
      return
    }
    this.taken(id)
    const thread = this.thread(id)
    let turn = this.turns.get(id)
    const wasEnded = !turn || turn.ended
    if (kind === 'agent_message_chunk') {
      if (words === undefined || !words.length) return
      if (wasEnded) turn = this.startReactiveTurn(id, turn)
      if (turn!.reactive && !turn!.ended) {
        turn!.reactiveRev++
        turn!.sawReactiveContent = true
      }
      const reply = turn!.places.reply()
      if (reply.opened || !this.log.has(id, reply.id)) {
        this.log.add(id, { id: reply.id, role: 'assistant', text: words, createdAt: new Date().toISOString(), turnMessageId: turn!.places.key })
        const settled = settledThinking(ANTIGRAVITY_THINKING_ID_PREFIX, thread.activities ?? [], 'completed', true)
        if (settled.length) thread.activities = mergeAgentActivities(thread.activities, settled)
        this.emit()
      } else { this.log.appendText(id, reply.id, words); this.emit(true) }
      if (turn!.reactive && !turn!.ended) this.armReactiveSettle(id, turn!)
      return
    }
    // A `tool_call_update` that closes a prior-turn tool/task, or emits progress for an already-outlived task,
    // settles/updates quietly without reopening a turn; subsequent thinking/tool/reply opens a reactive continuation.
    const isTool = (kind === 'tool_call' || kind === 'tool_call_update') && typeof update.toolCallId === 'string'
    if (wasEnded) {
      if (kind === 'tool_call_update' && isTool && turn) {
        const toolCallId = update.toolCallId as string
        const priorKey = turn.places.peekTool(toolCallId)
        if (priorKey !== undefined) {
          const priorTurnId = turn.places.toolTurn(toolCallId)
          const priorOld = thread.activities?.find(item => item.id === antigravityToolId(priorKey))
          const priorSignal = antigravityToolCallSignal(update, priorKey, priorOld)
          const alreadyOutlived = this.backgroundTasks.get(id)?.isOutlived(toolCallId) ?? false
          if (priorSignal && ((!priorSignal.backgroundLaunch && priorSignal.status !== 'running') || alreadyOutlived)) {
            const rows = antigravityActivities(update, { turnId: priorTurnId, afterMessageId: this.log.lastMessageId(id), cwd: alias.cwd, key: priorKey }, thread.activities, this.options.captureMedia)
            if (rows.length) { thread.activities = mergeAgentActivities(thread.activities, rows); this.changed(id) }
            this.backgroundTasksFor(id).observe(priorSignal, priorTurnId)
            this.syncBackgroundWork(id)
            this.emit()
            return
          }
        }
      }
      if (kind === 'agent_thought_chunk' || kind === 'plan' || kind === 'tool_call' || isTool) {
        turn = this.startReactiveTurn(id, turn)
      } else {
        return
      }
    }
    const key = kind === 'agent_thought_chunk' ? turn!.places.thought()
      : isTool ? turn!.places.tool(update.toolCallId as string, kind === 'tool_call') : undefined
    const rowTurnId = isTool ? turn!.places.toolTurn(update.toolCallId as string) : turn!.places.key
    const previousRow = key ? thread.activities?.find(item => item.id === antigravityToolId(key)) : undefined
    const signal = key && isTool ? antigravityToolCallSignal(update, key, previousRow) : undefined
    const rows = antigravityActivities(update, { turnId: rowTurnId, afterMessageId: this.log.lastMessageId(id), cwd: alias.cwd, key }, thread.activities, this.options.captureMedia)
    if (rows.length) { thread.activities = mergeAgentActivities(thread.activities, rows); this.emit(kind === 'agent_thought_chunk') }
    const edits = antigravityEdits(update), row = key ? rows.find(item => item.id === antigravityToolId(key)) : undefined
    if (edits.length && row?.kind === 'file-change' && row.changes?.length === edits.length) void this.placeEdits(id, row.id, edits, row.changes.map(change => change.diff), alias.cwd)
    if ((row?.kind === 'command' || signal?.isCommand) && !signal?.pending) turn!.ranCommand = true
    const wasOutlived = signal ? (this.backgroundTasks.get(id)?.isOutlived(signal.toolCallId) ?? false) : false
    if (signal && this.backgroundTasksFor(id).observe(signal, rowTurnId)) {
      if (this.syncBackgroundWork(id)) this.emit()
    }
    if (turn!.reactive && !turn!.ended) {
      const quietOutlivedProgress = wasOutlived && signal?.status === 'running'
      if (!quietOutlivedProgress) turn!.reactiveRev++
      if (signal) {
        if (signal.status === 'running' && !wasOutlived && !signal.pending && !signal.isControlTool) turn!.reactiveTools.add(signal.toolCallId)
        else if (signal.status !== 'unknown') turn!.reactiveTools.delete(signal.toolCallId)
      }
      if (kind === 'agent_thought_chunk' || kind === 'plan' || (isTool && !wasOutlived)) turn!.sawReactiveContent = false
      this.armReactiveSettle(id, turn!)
    }
    // A launch that finished with its child still at work: watched until `agy`'s records say the child is done.
    if (row?.kind === 'subagent' && row.agents?.[0]?.status === 'running' && update.status === 'completed' && typeof update.toolCallId === 'string' && alias.antigravitySessionId) {
      this.watchChild({ backgroundId: randomUUID(), threadId: id, row, toolCallId: update.toolCallId, parent: alias.antigravitySessionId, until: Date.now() + (this.options.childWatchMs ?? CHILD_WATCH_MS), reading: antigravityChildReading() })
    }
  }
  private watchChild(watch: ChildWatch): void {
    this.children.set(watch.row.id, watch)
    if (this.saveChildWatch(watch)) void this.persist().catch(() => undefined)
    if (this.syncBackgroundWork(watch.threadId)) this.emit()
    this.ensureChildTimer()
  }
  private ensureChildTimer(): void {
    if (!this.childTimer) { this.childTimer = setInterval(() => { void this.readChildren() }, CHILD_READ_MS); this.childTimer.unref?.() }
  }
  private saveChildWatch(watch: ChildWatch): boolean {
    const alias = this.aliases[watch.threadId]
    if (!alias) return false
    const entry = serializeChildWatch(watch)
    if (!entry) return false
    const at = alias.childWatches.findIndex(item => item.rowId === entry.rowId)
    if (at >= 0) alias.childWatches[at] = entry
    else {
      alias.childWatches.push(entry)
      while (alias.childWatches.length > CHILD_WATCHES_KEPT) {
        const dropped = alias.childWatches.shift()
        if (dropped) {
          const evicted = this.children.get(dropped.rowId)
          this.children.delete(dropped.rowId)
          if (evicted && evicted.answeredAt === undefined) {
            this.syncBackgroundWork(evicted.threadId)
            this.settleChild(evicted, { conversationId: evicted.reading.childConversation ?? '', status: 'unknown' })
          }
        }
      }
    }
    return true
  }
  private dropSavedChildWatch(threadId: string, rowId: string): boolean {
    const alias = this.aliases[threadId]
    if (!alias || !alias.childWatches.length) return false
    const before = alias.childWatches.length
    alias.childWatches = alias.childWatches.filter(item => item.rowId !== rowId)
    return alias.childWatches.length !== before
  }
  private restoreChildWatches(): void {
    const restoredThreads = new Set<string>()
    for (const [id, alias] of Object.entries(this.aliases)) {
      if (!alias.antigravitySessionId || !alias.childWatches.length) continue
      for (const saved of alias.childWatches) {
        const reading = antigravityChildReading()
        if (saved.childConversation) reading.childConversation = saved.childConversation
        this.children.set(saved.rowId, {
          backgroundId: randomUUID(),
          threadId: id,
          row: restoreChildRow(saved, alias.cwd),
          toolCallId: saved.toolCallId,
          parent: alias.antigravitySessionId,
          until: saved.until,
          reading,
          ...(saved.answeredAt ? { answeredAt: saved.answeredAt } : {}),
          ...(saved.answerDigest ? { answerDigest: saved.answerDigest } : {}),
        })
        restoredThreads.add(id)
      }
    }
    for (const id of restoredThreads) this.syncBackgroundWork(id)
    if (this.children.size) {
      this.ensureChildTimer()
      void this.readChildren()
    }
  }
  /** Each watched child read once: one that is done settles its row, and one past its watch is left as it is. */
  private async readChildren(): Promise<void> {
    if (this.readingChildren) return
    this.readingChildren = true
    // One budget for the whole pass, whatever the number of children: what it does not reach, the next pass reads.
    const generation = this.generation, budget = { left: CHILD_PASS_FILES }
    let dirty = false
    try {
      for (const [rowId, watch] of [...this.children]) {
        // A disconnect or a forgotten thread ends the reading before its next file, not only after it.
        if (generation !== this.generation || budget.left <= 0) break
        if (this.children.get(rowId) !== watch) continue
        const beforeConversation = watch.reading.childConversation
        const beforeAnsweredAt = watch.answeredAt
        const beforeDigest = watch.answerDigest
        const child = await readAntigravityChild(this.folders.appData, watch.parent, watch.toolCallId, watch.reading, budget)
        if (generation !== this.generation || this.children.get(rowId) !== watch) continue
        // agy 1.5.14 marks no final answer: its record stays alive after the child answers, and an interim message ends
        // its transcript as a last one does. So, as T3 reads it, an answer shows the child done or waiting for guidance,
        // and the watch goes on to the end of its time, each newer answer taking the place of the one before.
        if (child?.status === 'interrupted') {
          this.children.delete(rowId)
          if (this.dropSavedChildWatch(watch.threadId, rowId)) dirty = true
          this.syncBackgroundWork(watch.threadId)
          this.settleChild(watch, child)
          continue
        }
        const nextStepsDigest = child && (child.steps?.length || child.model)
          ? digest(JSON.stringify([child.model ?? null, child.stepsTotal ?? 0, child.steps ?? []]))
          : undefined
        if (child?.status === 'completed') {
          const nextDigest = child.message !== undefined ? digest(child.message) : undefined
          const answerChanged = watch.answeredAt === undefined
            || (nextDigest !== undefined && nextDigest !== watch.answerDigest
              && (child.completedAt === undefined || child.completedAt >= watch.answeredAt))
          const stepsChanged = nextStepsDigest !== undefined && nextStepsDigest !== watch.stepsDigest
          if (answerChanged || stepsChanged) {
            if (answerChanged) {
              watch.answeredAt = child.completedAt ?? new Date().toISOString()
              if (nextDigest !== undefined) watch.answerDigest = nextDigest
            }
            if (nextStepsDigest !== undefined) watch.stepsDigest = nextStepsDigest
            this.syncBackgroundWork(watch.threadId)
            this.settleChild(watch, child)
          }
        } else if (child?.status === 'running' && nextStepsDigest !== undefined && nextStepsDigest !== watch.stepsDigest) {
          watch.stepsDigest = nextStepsDigest
          // Once the child has already answered, readAntigravityChild marks the answer file as read so later polls
          // return `running` while a >256 KiB transcript finishes catching up. Keep applying those steps as settled
          // without reopening the finished assignment.
          if (watch.answeredAt !== undefined) this.settleChild(watch, { ...child, status: 'completed', completedAt: watch.answeredAt })
          else this.updateChildProgress(watch, child)
        }
        if (this.children.get(rowId) === watch && Date.now() > watch.until) {
          this.children.delete(rowId)
          if (this.dropSavedChildWatch(watch.threadId, rowId)) dirty = true
          // One never heard from in all that time is last seen working, never left looking live.
          if (watch.answeredAt === undefined) {
            this.syncBackgroundWork(watch.threadId)
            this.settleChild(watch, { conversationId: watch.reading.childConversation ?? '', status: 'unknown' })
          }
        } else if (this.children.get(rowId) === watch
          && (watch.reading.childConversation !== beforeConversation || watch.answeredAt !== beforeAnsweredAt || watch.answerDigest !== beforeDigest)) {
          if (this.saveChildWatch(watch)) dirty = true
        }
      }
      if (dirty && generation === this.generation) void this.persist().catch(() => undefined)
    } finally {
      this.readingChildren = false
      if (!this.children.size && this.childTimer) { clearInterval(this.childTimer); this.childTimer = undefined }
    }
  }
  private updateChildProgress(watch: ChildWatch, child: AntigravityChild): void {
    const thread = this.threads.get(watch.threadId), row = thread?.activities?.find(item => item.id === watch.row.id) ?? watch.row, agent = row.agents?.[0]
    if (!thread || !agent || agent.status !== 'running') return
    const now = new Date().toISOString()
    const nextRow: AgentActivity = {
      ...row,
      agents: [{
        ...agent,
        observedAt: now,
        ...(child.model ? { model: child.model } : {}),
        ...(child.steps?.length ? { steps: [...child.steps], ...(child.stepsTotal !== undefined ? { stepsTotal: child.stepsTotal } : {}) } : {}),
      }],
    }
    watch.row = nextRow
    thread.activities = mergeAgentActivities(thread.activities, [nextRow])
    this.changed(watch.threadId); this.emit(true)
  }
  private settleChild(watch: ChildWatch, child: AntigravityChild): void {
    // A row no longer among the thread's newest records is put back from the watch, so its answer is never lost.
    const thread = this.threads.get(watch.threadId), row = thread?.activities?.find(item => item.id === watch.row.id) ?? watch.row, agent = row.agents?.[0]
    const workChanged = this.syncBackgroundWork(watch.threadId)
    // A running child takes what was read; one that answered takes only a newer answer, newly read steps, or a resolved model.
    const newer = agent?.status === 'completed' && child.status === 'completed'
      && ((child.message !== undefined && child.message !== agent?.message)
        || Boolean(child.steps?.length)
        || Boolean(child.model && child.model !== agent.model))
    if (!thread || !agent || (agent.status !== 'running' && !newer)) { if (workChanged) this.emit(); return }
    const settledSteps = child.steps?.length
      ? (child.status === 'running' ? [...child.steps] : settleSubagentSteps(child.steps, child.status, child.completedAt ?? watch.answeredAt))
      : undefined
    const settledRow: AgentActivity = {
      ...row,
      agents: [{ ...agent, status: child.status,
        ...(child.model ? { model: child.model } : {}),
        ...(settledSteps?.length ? { steps: settledSteps, ...(child.stepsTotal !== undefined ? { stepsTotal: child.stepsTotal } : {}) } : {}),
        ...(child.message !== undefined ? { message: child.message } : {}), ...(child.completedAt ? { completedAt: child.completedAt } : {}) }],
    }
    watch.row = settledRow
    thread.activities = mergeAgentActivities(thread.activities, [settledRow])
    this.changed(watch.threadId); this.emit()
  }
  /** A finished edit's changes placed on their lines once the file is read (`antigravityEditLines.ts`); each one that cannot be stays as reported. */
  private async placeEdits(id: string, rowId: string, edits: readonly AntigravityEdit[], reported: readonly (string | undefined)[], cwd: string): Promise<void> {
    const generation = this.generation
    const placed = await placeAntigravityEdits(edits, cwd, this.folders.root)
    const thread = generation === this.generation ? this.threads.get(id) : undefined, row = thread?.activities?.find(item => item.id === rowId)
    // The row must still hold exactly what was reported when the read began, so a later report never takes an earlier read's lines.
    if (!thread || !row?.changes || row.changes.length !== placed.length || !placed.some(Boolean) || row.changes.some((change, index) => change.diff !== reported[index])) return
    thread.activities = mergeAgentActivities(thread.activities, [{ ...row, changes: row.changes.map((change, index) => placed[index] ? { ...change, diff: placed[index] } : change) }])
    this.changed(id); this.emit()
  }
  private taken(id: string): void {
    const turn = this.turns.get(id)
    if (turn && !turn.taken) { turn.taken = true; turn.wake?.() }
  }
  private endTurn(id: string, status: 'completed' | 'interrupted' | 'failed', error?: string): void {
    const turn = this.turns.get(id)
    if (!turn || turn.ended) return
    this.clearReactiveTimers(turn)
    turn.ended = true; turn.taken = true; turn.wake?.()
    if (status === 'completed') this.backgroundTasks.get(id)?.turnEnded(turn.places.key, turn.reactive, this.backgroundCommands.get(id)?.holds ?? false)
    else this.backgroundTasks.get(id)?.clear()
    this.syncBackgroundWork(id)
    const thread = this.threads.get(id); if (!thread) return
    thread.status = status === 'failed' ? 'error' : 'idle'
    thread.lastTurn = { id: turn.places.key, status }
    const thoughts = settledThinking(ANTIGRAVITY_THINKING_ID_PREFIX, thread.activities ?? [], thinkingSettledAs(status), true)
    const settled = thoughts.length ? mergeAgentActivities(thread.activities, thoughts) : thread.activities
    const activeChildRow = (rowId: string): boolean => [...this.children.values()].some(watch => watch.threadId === id && watch.row.id === rowId && watch.answeredAt === undefined)
    const closed = settled?.map(row => row.status === 'running' && row.kind !== 'turn' && row.kind !== 'plan' && row.turnId === turn.places.key
      && !(status === 'completed' && ((row.kind === 'subagent' && activeChildRow(row.id)) || this.backgroundTasks.get(id)?.isToolActive(row.id)))
      ? { ...row, status: status === 'completed' ? 'completed' as const : status === 'interrupted' ? 'interrupted' as const : 'unknown' as const } : row)
    thread.activities = markTurnActivity(closed, { provider: 'antigravity', turnId: turn.places.key, status, ...(error ? { error } : {}) })
    this.changed(id)
    this.reaper.touch(id)
    if (status === 'completed' && (turn.ranCommand || this.backgroundCommands.get(id)?.holds || this.backgroundTasks.get(id)?.hasAny)) this.watchBackground(id)
  }

  // ---- Commands ------------------------------------------------------------------------------------------------------

  async execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.executeGuarded(command) }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> { return this.executeGuarded(command, guard) }
  private async executeGuarded(command: AgentHostCommand, watcherGuard?: () => void): Promise<AgentHostResult> {
    const generation = this.generation
    let profile: WatcherLaunchProfile | undefined
    if ('threadId' in command) {
      try { profile = await this.checkLaunchProfile(command.threadId) }
      catch (error) { if (error instanceof AntigravityUncertain) return { accepted: false, uncertain: true }; throw error }
      this.assertGeneration(generation)
      if (profile) assertWatcherPermission(command)
    }
    if (!this.state.connected) throw new Error('Connect Antigravity before managing threads.')
    if (command.type !== 'send' && command.type !== 'create-thread' && command.type !== 'compact-thread') return this.run(command, generation, profile, watcherGuard)
    if (this.dispatching.has(command.threadId)) throw new Error('Antigravity is already receiving work for this thread. Wait for its delivery result.')
    this.dispatching.add(command.threadId)
    try { return await this.run(command, generation, profile, watcherGuard) } finally { this.dispatching.delete(command.threadId); this.stopOutdated() }
  }
  private async run(command: AgentHostCommand, generation: number, profile: WatcherLaunchProfile | undefined, watcherGuard?: () => void): Promise<AgentHostResult> {
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('Antigravity projects need an absolute folder.')
        if (!this.state.projects.some(project => project.id === command.projectId)) {
          this.state.projects.push({ id: command.projectId, title: command.title, path: command.path })
          await this.projectStore.write(this.state.projects)
        }
        this.emit(); return { accepted: true }
      }
      if (command.type === 'create-thread') return await this.create(command, generation, profile, watcherGuard)
      if (command.type === 'configure-thread') return await this.configure(command, generation, watcherGuard)
      const id = command.threadId, alias = this.aliases[id]
      if (!alias?.antigravitySessionId) throw new Error('Antigravity did not confirm this thread’s session. Your thread is kept. Do not repeat its creation automatically.')
      if (command.type === 'interrupt') return await this.interrupt(id, alias, watcherGuard)
      if (command.type === 'steer') return await this.steer(command, alias, generation, profile, watcherGuard)
      const connection = await this.open(id)
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new AntigravityUncertain('Antigravity’s connection changed.')
      this.reaper.touch(id)
      if (command.type === 'send') return await this.send(command, alias, connection, generation, profile, watcherGuard)
      if (command.type === 'answer') return await this.answer(command, alias, connection, profile)
      if (command.type === 'compact-thread') return await this.compact(command, alias, connection, generation, watcherGuard)
      throw new Error('Antigravity does not take that action.')
    } catch (error) {
      if (error instanceof AntigravityUncertain) return { accepted: false, uncertain: true }
      throw error
    }
  }
  private async create(command: Extract<AgentHostCommand, { type: 'create-thread' }>, generation: number, profile: WatcherLaunchProfile | undefined, watcherGuard?: () => void): Promise<AgentHostResult> {
    const saved = this.aliases[command.threadId]
    if (saved) return saved.antigravitySessionId ? { accepted: true } : { accepted: false, uncertain: true }
    const runtimeMode = this.allowedMode(command.runtimeMode)
    validateThreadOptions(this.state, { ...command, runtimeMode })
    const project = this.state.projects.find(item => item.id === command.projectId)
    if (!project) throw new Error('Choose an Antigravity project first.')
    const reasoningEffort = command.reasoningEffort ?? this.model(command.modelId)?.defaultReasoningEffort
    const alias: Alias = { projectId: project.id, cwd: await existingWorkingDirectory(command.workingDirectory ?? project.path), title: command.title, createdAt: new Date().toISOString(),
      modelId: command.modelId, ...(reasoningEffort ? { reasoningEffort } : {}), runtimeMode, turns: 0, origins: [], answeredRequestIds: [], childWatches: [] }
    this.assertGeneration(generation)
    const connection = await this.startProcess(command.threadId, alias, alias.cwd, profile !== undefined)
    if (generation !== this.generation) { this.close(connection); throw new AntigravityUncertain('Antigravity’s connection changed.') }
    this.connections.set(command.threadId, connection)
    try {
      this.aliases[command.threadId] = alias; await this.persist()
      const mcpServers = await this.toolServers(command.threadId, connection)
      const meta = await this.sessionMeta(command.threadId, connection.watcher)
      this.assertGeneration(generation)
      watcherGuard?.()
      await connection.rpc.request('session/new', { cwd: alias.cwd, mcpServers, ...(meta ? { _meta: meta } : {}) }, async value => {
        const answer = sessionNewSchema.parse(value)
        alias.antigravitySessionId = answer.sessionId; this.readSettings(connection, answer); await this.persist()
      })
      this.assertGeneration(generation)
      await this.applySettings(alias, connection)
    } catch (error) {
      if (this.connections.get(command.threadId) === connection) this.connections.delete(command.threadId)
      this.close(connection)
      if (this.aliases[command.threadId] === alias && alias.antigravitySessionId) this.thread(command.threadId).status = 'error'
      throw error
    }
    const thread = this.thread(command.threadId)
    thread.status = 'idle'; thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode
    if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort
    this.loaded.add(command.threadId); this.log.pin(command.threadId); this.reaper.touch(command.threadId)
    this.emit(); return { accepted: true }
  }
  /** A mode the account offers: Auto only where `agy`'s own Auto is offered, else Ask for approval, as T3 runs it. */
  private allowedMode(mode: Parameters<typeof antigravityRuntimeMode>[0]): AntigravityRuntimeMode {
    const wanted = antigravityRuntimeMode(mode)
    return wanted === 'auto' && !this.state.models.some(model => model.runtimeModes?.includes('auto')) ? 'approval-required' : wanted
  }
  private model(modelId: string): AgentModel | undefined { return this.facts.get(modelId)?.model }
  /**
   * Put the session on the thread's model, effort and session mode before a prompt that needs them, and read each back.
   * A permission mode changes no process: `agy` takes a new session mode at once, and Sotto's own answers follow the
   * thread's mode as each request arrives.
   */
  private async applySettings(alias: Alias, connection: Connection, rpc: AntigravityRpc = connection.rpc, sessionId = alias.antigravitySessionId, modelId = alias.modelId,
    effort = alias.reasoningEffort, mode: AntigravityRuntimeMode = alias.runtimeMode): Promise<void> {
    // A thread made before Sotto kept to Gemini may still name a Claude or GPT model; agy is never switched to one (ADR-0212).
    if (!antigravityGeminiModel(modelId)) throw new Error(ANTIGRAVITY_GEMINI_ONLY)
    if (connection.model !== modelId) {
      await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: modelId }, value => { this.readSettings(connection, value) })
      if (connection.model !== modelId) throw new Error('Antigravity did not confirm this thread’s model. Your thread and draft are kept. Choose the model again, then send.')
    }
    const option = connection.effortOption ?? this.facts.get(modelId)?.effortOption
    if (option && effort && connection.effort !== effort) {
      await rpc.request('session/set_config_option', { sessionId, configId: option, value: effort }, value => { this.readSettings(connection, value) })
      if (connection.effort !== effort) throw new Error('Antigravity did not confirm this thread’s effort. Your thread and draft are kept. Choose the effort again, then send.')
    }
    await this.applyMode(connection, rpc, sessionId, mode)
  }
  /** Put the session in the session mode the thread's permission mode runs in, and read it back. */
  private async applyMode(connection: Connection, rpc: AntigravityRpc, sessionId: string | undefined, mode: AntigravityRuntimeMode): Promise<void> {
    const sessionMode = antigravitySessionMode(mode, connection.offersAuto)
    if (connection.mode === undefined || connection.mode === sessionMode) return
    if (connection.modeIsOption) await rpc.request('session/set_config_option', { sessionId, configId: 'mode', value: sessionMode }, value => { this.readSettings(connection, value) })
    else { await rpc.request('session/set_mode', { sessionId, modeId: sessionMode }); connection.mode = sessionMode }
    if (connection.mode !== sessionMode) throw new Error('Antigravity did not confirm this thread’s permission mode. Your thread and draft are kept. Choose the mode again, then send.')
  }
  private async configure(command: Extract<AgentHostCommand, { type: 'configure-thread' }>, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const id = command.threadId, alias = this.aliases[id]
    if (!alias?.antigravitySessionId) throw new Error('Antigravity did not confirm this thread’s session. Your thread is kept.')
    if (command.providerMode !== undefined) throw new Error('That permission mode is not supported by this provider.')
    const runtimeMode = command.runtimeMode === undefined ? undefined : this.allowedMode(command.runtimeMode)
    const modelId = command.modelId ?? alias.modelId
    const reasoningEffort = effortAfterChange(this.state, command, alias.reasoningEffort)
    validateThreadOptions(this.state, { modelId, ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}), ...(runtimeMode ? { runtimeMode } : {}) }, alias.modelId)
    watcherGuard?.()
    alias.modelId = modelId
    if (reasoningEffort) alias.reasoningEffort = reasoningEffort; else delete alias.reasoningEffort
    if (runtimeMode) alias.runtimeMode = runtimeMode
    await this.persist()
    this.assertGeneration(generation)
    const thread = this.thread(id)
    thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode
    if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort; else delete thread.reasoningEffort
    this.changed(id)
    // A new mode reaches agy at once, even mid-turn, so leaving Auto takes agy's own approvals away now rather than at the
    // next prompt. If agy will not take it, the turn is stopped rather than left running on the wider mode.
    const live = this.connections.get(id)
    if (runtimeMode && live && !live.closing) {
      try { await this.applyMode(live, live.rpc, alias.antigravitySessionId, alias.runtimeMode) }
      catch {
        try { live.rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: alias.antigravitySessionId } }) } catch { /* A closed pipe runs nothing more. */ }
        thread.requestNotice = 'Antigravity did not take the new permission mode, so its turn was stopped. Nothing else was lost. Send a message to carry on in the new mode.'
      }
    }
    // A request waiting now is answered by the new mode where it would be: Full access or Allow edits takes it off the user.
    for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id && !pending.answering && !pending.connection.closing && this.pending.get(requestId) === pending) {
      const automatic = antigravityAutoAnswer(alias.runtimeMode, pending)
      if (!automatic) continue
      pending.answering = true
      try { await pending.connection.rpc.reply(pending.wireId, { outcome: { outcome: 'selected', optionId: automatic } }); this.removeRequest(requestId) }
      catch { pending.answering = false }
    }
    this.emit()
    return { accepted: true, snapshot: this.current(command.historyFromEvents) }
  }
  /** The prompt's content: the words as one text part, then images `agy` takes natively. */
  private async promptOf(alias: Alias, command: { text: string; attachments?: readonly PromptImage[] }, tail: string): Promise<{ text: string; blocks: unknown[]; attachments: PromptImage[] }> {
    const attachments = validatePromptAttachments(this.state, alias.modelId, command.attachments, { workingDirectory: alias.cwd })
    const delivered = await deliverAttachments(alias.cwd, attachments)
    const text = withAttachedFilesNote(command.text + tail, delivered.note)
    const images = await acpImageBlocks(delivered.images)
    return { text, blocks: [{ type: 'text', text }, ...images], attachments }
  }
  private async send(command: Extract<AgentHostCommand, { type: 'send' }>, alias: Alias, connection: Connection, generation: number, profile: WatcherLaunchProfile | undefined, watcherGuard?: () => void): Promise<AgentHostResult> {
    const id = command.threadId
    const current = (): void => {
      if (generation !== this.generation || this.connections.get(id) !== connection || !this.state.connected) throw new AntigravityUncertain('Antigravity’s connection changed. Delivery has not been confirmed.')
    }
    const index = this.indexOf(id, alias)
    const previous = index.sent(command.commandId, command.messageId)
    if (previous) {
      if (previous.messageId !== command.messageId || previous.commandId !== command.commandId) throw new Error('This Antigravity message identity is already in use.')
      return this.log.has(id, previous.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
    }
    if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(id) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
    const running = this.turns.get(id)
    if (running && !running.ended) throw new Error('Antigravity is still working on this thread. Steer it, or queue this follow-up.')
    if (this.compactions.has(id)) throw new Error(COMPACTING)
    if (this.thread(id).requests.length) throw new Error('Answer Antigravity’s pending request before sending another message.')
    verifyFileMentions(command.text, command.files)
    // A skill is `agy`'s own `/name`, read at the start of the prompt; one chosen and not typed goes first.
    const skills = (command.skills ?? []).map(skill => `/${skill.name}`).filter(token => !new RegExp(`(^|\\s)${escapeRegExp(token)}(\\s|$)`, 'u').test(command.text))
    const note = profile ? command.watcherRequestNote ?? command.watcherNews : undefined
    const words = (skills.length ? `${skills.join(' ')} ` : '') + command.text
    const prompt = await this.promptOf(alias, { text: words, ...(command.attachments ? { attachments: command.attachments } : {}) }, note ? watcherRequestLine(note) : '')
    await this.applySettings(alias, connection)
    current()
    const outcome = await watchAntigravityTurnOutcome(this.folders.appData, alias.antigravitySessionId)
    current()
    const origin: Origin = { messageId: command.messageId, commandId: command.commandId, digest: digest(prompt.text), createdAt: new Date().toISOString(), turn: alias.turns,
      attachments: attachmentReferences(prompt.attachments) }
    index.add(origin); alias.turns++
    await this.persist()
    current()
    try { watcherGuard?.() } catch (error) { index.remove(origin); alias.turns--; await this.persist(); throw error }
    const thread = this.thread(id)
    delete thread.requestNotice
    const turn = this.createTurn(origin.messageId, origin, outcome, false, this.turns.get(id)?.places)
    this.turns.set(id, turn)
    thread.status = 'running'; thread.lastTurn = { id: origin.messageId, status: 'running' }
    thread.activities = markTurnActivity(thread.activities, { provider: 'antigravity', turnId: origin.messageId, status: 'running', afterMessageId: origin.messageId })
    this.emit()
    this.log.add(id, { id: origin.messageId, role: 'user', text: command.text, commandId: origin.commandId, createdAt: origin.createdAt,
      ...(origin.attachments.length ? { attachments: origin.attachments.map(ref => ({ ...ref })) } : {}) })
    this.emit()
    markSendStage(command.commandId, 'written')
    this.prompt(id, alias, connection, turn, generation, prompt.blocks)
    return this.awaitTaken(command.commandId, turn, generation)
  }
  /**
   * One `session/prompt` into the turn's session: the first, or a steer. `agy` 1.5 steers a running turn by the next
   * prompt, as T3 relies on, so the turn ends with the answer to its newest prompt; an earlier one's answer only says it
   * was folded in.
   */
  private prompt(id: string, alias: Alias, connection: Connection, turn: LiveTurn, generation: number, blocks: unknown[]): void {
    const serial = ++turn.prompts
    const superseded = (): boolean => generation !== this.generation || this.turns.get(id) !== turn || serial !== turn.prompts
    void connection.rpc.request('session/prompt', { sessionId: alias.antigravitySessionId, prompt: blocks }, async value => {
      // A steered prompt's answer still carries the tokens its part of the turn spent.
      const counted = generation === this.generation && this.threads.has(id) && countAntigravityAnswer(this.thread(id), value, !superseded())
      if (superseded()) { if (counted) this.emit(true); return }
      const stop = promptAnswerSchema.parse(value).stopReason
      const settled = await turn.outcome.check(stop).catch(() => classifyAntigravityTurnOutcome(stop))
      if (superseded() || turn.ended) return
      const bgChanged = settled.status === 'completed' ? await this.lookBeforeEnd(id, turn) : false
      if (superseded() || turn.ended) { if (bgChanged && generation === this.generation) this.emit(); return }
      this.closeForms(id)
      this.endTurn(id, settled.status, settled.error)
      this.emit()
    }, true).catch((error: unknown) => {
      if (superseded() || turn.ended) return
      this.closeForms(id)
      this.endTurn(id, 'failed', connection.rpc.alive ? error instanceof AntigravityRejected ? 'Antigravity refused this message. Nothing else was lost. Check the thread’s model, then send again.' : undefined : PROCESS_LOST)
      this.emit()
    })
  }
  private async awaitTaken(commandId: string, turn: LiveTurn, generation: number): Promise<AgentHostResult> {
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 30_000)
    while (!turn.taken) {
      if (generation !== this.generation) return { accepted: false, uncertain: true }
      const left = deadline - Date.now()
      if (left <= 0) return { accepted: false, uncertain: true }
      await new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(timer); if (turn.wake === done) turn.wake = undefined; resolve() }
        const timer = setTimeout(done, left); timer.unref()
        turn.wake = done
      })
    }
    markSendStage(commandId, 'acknowledged')
    return { accepted: true }
  }
  /** A message into the running turn, as T3 steers `agy` 1.5: a new prompt in the same session. */
  private async steer(command: Extract<AgentHostCommand, { type: 'steer' }>, alias: Alias, generation: number, profile: WatcherLaunchProfile | undefined, watcherGuard?: () => void): Promise<AgentHostResult> {
    void profile
    const id = command.threadId, turn = this.turns.get(id), connection = this.connections.get(id)
    if (this.compactions.has(id)) throw new Error(COMPACTING)
    if (!turn || turn.ended || !connection) throw new Error('Antigravity is not working on this thread. Send a follow-up instead.')
    const index = this.indexOf(id, alias), previous = index.sent(command.commandId, command.messageId)
    if (previous) return this.log.has(id, previous.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
    if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (this.log.lastUserMessageId(id) ?? null)) throw new Error('The latest user message changed. Review the thread before steering.')
    if (this.thread(id).requests.length) throw new Error('Answer Antigravity’s pending request before steering.')
    verifyFileMentions(command.text, command.files)
    const prompt = await this.promptOf(alias, { text: command.text, ...(command.attachments ? { attachments: command.attachments } : {}) }, '')
    this.assertGeneration(generation)
    if (this.turns.get(id) !== turn || turn.ended || this.connections.get(id) !== connection) throw new Error('This turn has ended. Send a follow-up instead.')
    watcherGuard?.()
    const origin: Origin = { messageId: command.messageId, commandId: command.commandId, digest: digest(prompt.text), createdAt: new Date().toISOString(), turn: alias.turns, attachments: [] }
    index.add(origin)
    try { await this.persist() } catch (error) { index.remove(origin); throw error }
    this.assertGeneration(generation)
    this.log.add(id, { id: origin.messageId, role: 'user', text: command.text, commandId: origin.commandId, createdAt: origin.createdAt })
    this.clearReactiveTimers(turn)
    turn.reactive = false
    turn.reactiveTools.clear()
    this.emit()
    this.prompt(id, alias, connection, turn, generation, prompt.blocks)
    return { accepted: true }
  }
  /**
   * `agy` 1.5 compacts its conversation on its own `/compact`, which T3 sends as a prompt too. It is a quiet turn: no
   * reply, an `end_turn`, and the next turn's context is the smaller one (checked on 1.5.13, November 21, 2026). The
   * compaction is held in memory, like the token count, so a restart forgets its record but not what `agy` folded.
   */
  private async compact(command: Extract<AgentHostCommand, { type: 'compact-thread' }>, alias: Alias, connection: Connection, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const id = command.threadId, thread = this.thread(id), running = this.turns.get(id)
    if (thread.compaction?.commandId === command.commandId) return { accepted: true }
    if ((running && !running.ended) || this.compactions.has(id) || compactionPending(thread.compaction)) throw new Error('Antigravity is still working on this thread. Wait for it to finish before compacting.')
    if (thread.requests.length) throw new Error('Answer Antigravity’s pending request before compacting.')
    // `agy` takes an unknown `/name` as words, so `/compact` goes only to a client that lists it. Its list comes just
    // after the session opens, so it is waited for, as the skills are.
    for (let waited = 0; !connection.commands && waited < 3_000 && this.connections.get(id) === connection; waited += 100) await new Promise(resolve => setTimeout(resolve, 100))
    if (!connection.commands) throw new Error('Antigravity has not yet said whether it can compact this thread. Nothing was changed. Try again in a moment.')
    if (!connection.commands.some(skill => skill.name === 'compact')) throw new Error('This Antigravity client does not offer /compact. Nothing was changed. Update Antigravity to compact its threads.')
    await this.applySettings(alias, connection)
    if (generation !== this.generation || this.connections.get(id) !== connection) throw new AntigravityUncertain('Antigravity’s connection changed.')
    // A request may have come while the settings were applied; it is answered first, as before a send.
    if (thread.requests.length) throw new Error('Answer Antigravity’s pending request before compacting.')
    if (this.turns.get(id)?.ended === false) throw new Error('Antigravity is still working on this thread. Wait for it to finish before compacting.')
    watcherGuard?.()
    const before = thread.usage?.contextUsed
    this.compactions.set(id, command.commandId); this.compactionAnswered.delete(id)
    thread.compaction = { commandId: command.commandId, status: 'running', ...(command.idle ? { idle: true } : {}) }
    thread.status = 'running'; this.changed(id); this.emit()
    void connection.rpc.request('session/prompt', { sessionId: alias.antigravitySessionId, prompt: [{ type: 'text', text: '/compact' }] }, value => {
      if (generation !== this.generation || this.compactions.get(id) !== command.commandId) return
      // Its tokens were spent, so they count toward the thread's total, but the last turn's stay the latest.
      countAntigravityAnswer(this.thread(id), value, false)
      const stop = promptAnswerSchema.parse(value).stopReason
      if (stop === 'end_turn') this.settleCompaction(id, command.commandId, before, this.compactionAnswered.has(id) ? COMPACTION_ANSWERED : undefined)
      else this.settleCompaction(id, command.commandId, before, stop === 'cancelled' ? 'The compaction was stopped. Nothing was lost. Compact the thread again when you want to.'
        : 'Antigravity did not compact this thread. Nothing was lost. Try again later.')
    }, true).catch((error: unknown) => {
      this.settleCompaction(id, command.commandId, before, !connection.rpc.alive ? COMPACTION_LOST
        : error instanceof AntigravityRejected ? 'Antigravity refused to compact this thread. Nothing was lost. Try again later.' : COMPACTION_UNCONFIRMED)
    })
    return { accepted: true }
  }
  /** The end of a `/compact`: its record, and on success a boundary in the transcript and no stale context size. */
  private settleCompaction(id: string, commandId: string, before: number | undefined, error?: string, publish = true): void {
    if (this.compactions.get(id) !== commandId) return
    this.compactions.delete(id); this.compactionAnswered.delete(id)
    const thread = this.threads.get(id); if (!thread) return
    thread.compaction = { commandId, status: error ? 'failed' : 'completed', ...idleMark(thread.compaction), ...(error ? { error } : {}) }
    thread.status = error ? 'error' : 'idle'
    if (!error) {
      const anchor = this.log.lastMessageId(id)
      const boundary: CompactionMark = { provider: 'antigravity', key: commandId, turnId: this.log.lastUserMessageId(id) ?? 'antigravity-history', at: Date.now(),
        ...(anchor !== undefined ? { afterMessageId: anchor } : {}), ...(before !== undefined ? { before } : {}) }
      thread.activities = markCompactionActivity(thread.activities, boundary)
      forgetAntigravityFullness(thread); this.compactedSince.set(id, boundary)
    }
    this.changed(id); this.reaper.touch(id)
    if (publish) this.emit()
  }
  private async answer(command: Extract<AgentHostCommand, { type: 'answer' }>, alias: Alias, connection: Connection, profile: WatcherLaunchProfile | undefined): Promise<AgentHostResult> {
    const pending = this.pending.get(command.requestId)
    if (!pending || pending.threadId !== command.threadId) throw new Error('That Antigravity request is no longer waiting.')
    if (profile) assertWatcherPermissionChoice(pending.request, command.permissionChoice)
    if (pending.connection !== connection || pending.answering) return { accepted: false, uncertain: true }
    const result = antigravityAnswer(pending, command.answer, command.approved, command.questionAnswers, command.permissionChoice, command.skipped)
    pending.answering = true
    const index = this.indexOf(command.threadId, alias)
    index.answer(pending.request.id)
    try { await this.persist() } catch (error) { index.unanswer(pending.request.id); pending.answering = false; throw error }
    if (this.pending.get(command.requestId) !== pending || this.connections.get(command.threadId) !== connection) return { accepted: false, uncertain: true }
    try { await connection.rpc.reply(pending.wireId, result); this.removeRequest(command.requestId) }
    catch { pending.request.delivery = 'uncertain'; this.changed(command.threadId); this.emit(); return { accepted: false, uncertain: true } }
    const thread = this.threads.get(command.threadId)
    if (thread && !thread.requests.length && thread.status !== 'running') {
      const turn = this.turns.get(command.threadId)
      if (turn && !turn.ended) {
        thread.status = 'running'
        thread.lastTurn = { id: turn.places.key, status: 'running' }
      } else {
        this.startReactiveTurn(command.threadId, turn)
      }
      this.changed(command.threadId)
    }
    this.emit(); return { accepted: true }
  }
  private async interrupt(id: string, alias: Alias, watcherGuard?: () => void): Promise<AgentHostResult> {
    const connection = this.connections.get(id)
    if (!watcherGuard) for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id && !pending.answering) {
      this.removeRequest(requestId); await pending.connection.rpc.reply(pending.wireId, antigravityDecline(pending)).catch(() => undefined)
    }
    watcherGuard?.()
    if (connection) connection.rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: alias.antigravitySessionId } })
    const turn = this.turns.get(id)
    if (turn?.reactive && !turn.ended) this.endTurn(id, 'interrupted')
    this.emit(); return { accepted: true }
  }
  /** `agy`'s forms still open when the thread's turn ended, as on a Stop that only cancelled: cancelled, their cards gone. */
  private closeForms(id: string): void {
    for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id && pending.form && !pending.answering) {
      this.removeRequest(requestId); void pending.connection.rpc.reply(pending.wireId, antigravityDecline(pending)).catch(() => undefined)
    }
  }
  private removeRequest(requestId: string): void {
    const pending = this.pending.get(requestId); if (!pending) return
    this.pending.delete(requestId)
    const thread = this.threads.get(pending.threadId)
    if (thread) { thread.requests = thread.requests.filter(request => request.id !== requestId); this.changed(pending.threadId) }
    const turn = this.turns.get(pending.threadId)
    if (turn?.reactive && !turn.ended && !this.asking(pending.threadId)) {
      this.armReactiveSettle(pending.threadId, turn)
      this.armReactiveMaxTimer(pending.threadId, turn)
    }
  }
  private clearRequests(id: string): void {
    for (const [requestId, pending] of this.pending) if (pending.threadId === id) this.pending.delete(requestId)
    const thread = this.threads.get(id); if (thread) { thread.requests = []; this.changed(id) }
  }

  // ---- Skills and short text -----------------------------------------------------------------------------------------

  /** Antigravity's skills and commands, as `/name`, from what the thread's session listed (`available_commands_update`). */
  async listThreadSkills(threadId: string, forceReload = false, scope?: AgentSkillScope): Promise<AgentSkillCatalog> {
    void forceReload
    if (this.aliases[threadId]) await this.checkLaunchProfile(threadId)
    const alias = this.aliases[threadId]
    const cwd = alias?.cwd ?? (scope?.providerId === 'antigravity' ? scope.workingDirectory : undefined) ?? ''
    if (!this.state.connected) return { threadId, providerId: 'antigravity', cwd, status: 'error', skills: [], errors: [], error: 'Connect Antigravity to read its skills.' }
    let skills = this.connections.get(threadId)?.commands
    if (!skills && alias?.antigravitySessionId) {
      const connection = await this.open(threadId).catch(() => undefined)
      for (let waited = 0; connection && !connection.commands && waited < 3_000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100))
      skills = connection?.commands
    }
    skills ??= this.commands
    if (!skills) return { threadId, providerId: 'antigravity', cwd, status: 'error', skills: [], errors: [], error: 'Antigravity has not listed its skills yet. Open an Antigravity thread, then try again.' }
    return { threadId, providerId: 'antigravity', cwd, status: 'ready', errors: [], skills: skills.map(skill => ({ ...skill })) }
  }
  /**
   * Sotto's short text on Antigravity (ADR-0026), as T3's text helper runs it: one prompt in a session of its own, with
   * no tool servers, in `default` mode, on the thread's model at its least effort. It runs in the thread's own folder, as
   * every provider's side call does (T3 uses a scratch folder; Sotto's contract asks for the thread's). A side call uses
   * no tools: every request is answered `cancelled`, and a tool call that shows anyway stops the call, which then writes
   * nothing. The side session's own files are removed afterwards, so `agy` keeps no conversation of it.
   */
  async writeShortText(id: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    const generation = this.generation
    if (await this.checkLaunchProfile(id) && !watcherMayWrite(prompt.purpose)) return null
    const alias = this.aliases[id], executable = this.executable
    if (!this.state.connected || !executable || !alias?.antigravitySessionId) return null
    const cwd = await existingWorkingDirectory(alias.cwd)
    this.assertGeneration(generation)
    const signIn = await this.signInNow()
    let text = ''
    let sessionId: string | undefined
    let tooled = false
    const stop = (rpc: AntigravityRpc): void => {
      if (tooled) return
      tooled = true
      if (sessionId) { try { rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }) } catch { /* A closed pipe runs nothing more. */ } }
    }
    const writer = this.spawn(executable, antigravityArguments(this.folders), cwd, signIn, (frame, rpc) => {
      if (frame.method && frame.id !== undefined) { void rpc.reply(frame.id, antigravityDecline()).catch(() => undefined); stop(rpc); return }
      const params = record(frame.params), update = record(params?.update), content = record(update?.content)
      if (frame.method !== 'session/update' || !sessionId || params?.sessionId !== sessionId) return
      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') { stop(rpc); return }
      if (!tooled && update?.sessionUpdate === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') text += content.text
    }, () => undefined)
    const abort = (): void => writer.close()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, SIDE_WRITING_TIMEOUT_MS); timer.unref()
    try {
      if (signal?.aborted) return null
      await this.handshake(writer, signIn)
      const side = { rpc: writer, nonce: '', clientRevision: this.clientRevision, watcher: false, client: undefined as unknown as AntigravityClient, closing: false,
        model: undefined, effort: undefined, mode: undefined, effortOption: undefined, modeIsOption: false, offersAuto: false, commands: undefined } as Connection
      await writer.request('session/new', { cwd, mcpServers: [] }, value => { const answer = sessionNewSchema.parse(value); sessionId = answer.sessionId; this.readSettings(side, answer) })
      await this.applySettings(alias, side, writer, sessionId, alias.modelId, leastEffort(this.model(alias.modelId)), 'approval-required')
      let ended = ''
      await writer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${prompt.instruction}\n\n${prompt.material}` }] }, value => { ended = promptAnswerSchema.parse(value).stopReason }, true)
      if (tooled || ended !== 'end_turn') return null
      return text.trim() || null
    } catch (error) {
      if (signal?.aborted) return null
      throw new Error('Antigravity could not write this text. Nothing else changed.', { cause: error })
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); writer.close()
      await writer.closed; await this.removeScratchSession(undefined, sessionId)
    }
  }

  // ---- Disconnecting -------------------------------------------------------------------------------------------------

  disconnect(): void {
    this.generation++; this.reaper.dispose()
    for (const pending of this.pending.values()) if (!pending.answering) {
      try { pending.connection.rpc.write({ jsonrpc: '2.0', id: pending.wireId, result: antigravityDecline(pending) }) } catch { /* A closed pipe grants nothing. */ }
    }
    this.pending.clear()
    for (const turn of this.turns.values()) this.clearReactiveTimers(turn)
    for (const watch of this.backgroundCommands.values()) watch.stop()
    this.backgroundCommands.clear(); this.backgroundTasks.clear(); this.lookingBeforeEnd.clear(); this.reactiveTurnCounts.clear()
    for (const id of this.turns.keys()) this.endTurn(id, 'interrupted')
    // Published once, with the rest of the disconnect.
    for (const [id, commandId] of [...this.compactions]) this.settleCompaction(id, commandId, undefined, COMPACTION_LOST, false)
    this.compactedSince.clear(); this.compactionAnswered.clear()
    this.children.clear(); if (this.childTimer) { clearInterval(this.childTimer); this.childTimer = undefined }
    this.turns.clear()
    for (const thread of this.threads.values()) { thread.requests = []; delete thread.backgroundWork }
    this.threadChanges.markAll()
    for (const connection of this.connections.values()) this.close(connection)
    for (const rpc of this.processes) rpc.close()
    this.connections.clear(); this.loading.clear(); this.loaded.clear(); this.outdated.clear()
    this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> { await Promise.all([...this.processes].map(rpc => rpc.closed)); await Promise.all([...this.stopping.values()].map(work => work.catch(() => undefined))); await this.writing }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
/** `agy`'s listed commands and skills as Sotto's skills: each one is invoked as `/name`. */
function antigravitySkills(commands: z.infer<typeof commandsSchema>): AgentSkillCatalog['skills'] {
  return commands.map(command => ({ name: command.name, path: `antigravity:/${command.name}`, description: command.description ?? '',
    scope: 'system' as const, enabled: true, userInvocable: true, invocation: `/${command.name}`, nativeSource: 'antigravity' }))
}
