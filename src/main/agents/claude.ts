import { preserveLegacyAliases } from './legacyAliases'
import type { BrowserAgentTools } from './browserAgentServer'
import { scopedThreadServers, type ScopedThreadTools, type ThreadMcpServer } from './threadToolServer'
import { ClaudeHistory } from './claudeHistory'
import { adapterItemCount, ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { AdapterThreadChanges, restOf } from './adapterThreadChanges'
import type { ActivityChangesListener, ActivityChangesSubscription } from './threadChanges'
import { isDeepStrictEqual } from 'node:util'
import { existingWorkingDirectory } from './threadWorktrees'
import { NativeUsage, type NativeUsageContext } from './nativeUsage'
import { scanClaudeHistory } from './usageHistory/claudeHistory'
import type { UsageHistorySink } from './usageHistory/sink'
import type { UsageQuotaRead, UsageTokenObservation } from '../../shared/usageDashboard'
import { unavailableProviderQuota } from './providerQuota'
import { ClaudeLimits, type ClaudeControl } from './claudeLimits'
import { compactionPending, compactionSchema, idleMark } from '../../shared/compaction'
import { randomUUID } from 'node:crypto'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { attachmentReferences, agentAttachmentReferenceSchema, agentProjectSchema, agentRuntimeModeSchema, PROVIDER_LABELS, type AgentHostSnapshot, type AgentMessage, type AgentRuntimeMode, type AgentThread, type ProviderId } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ClaudeOriginJournal } from './claudeOriginJournal'
import type { ActivitySubscriptionOptions, AgentHost, AgentHostCommand, AgentHostResult, AgentSkillScope, WatcherLaunchProfile, ThreadLaunchProfiles, RestoredThreadHistory, ShortTextPrompt, ThreadHistorySource, ThreadHostEvent, ThreadForkRequest, ThreadReadPurpose, ThreadSessionDraft, WorkerRoleSource } from './host'
import { claudeSubagents, narrowerMode } from './subagentRoles'
import { subagentRoleInstructions } from '../../shared/workerRoles'
import { DELEGATE_MCP_SERVER } from '../../shared/delegation'
import { resolveModel } from '../../shared/modelCatalog'
import { DEFAULT_ULTRACODE_EFFORT, ULTRACODE, ultracodeRunsAt, type UltracodeEffort } from '../../shared/ultracode'
import { WatcherProfileRefusal, validateWatcherProfile } from './watcherProfile'
import { WATCHER_SYSTEM_PROMPT } from './watcherPrompt'
import { questionInstructions } from './questionInstructions'
import { assertWatcherPermission, assertWatcherPermissionChoice, watcherThreadTools } from './watcherProviderTools'
import { SIDE_WRITING_TIMEOUT_MS, sideWritingEffort } from './sideWriting'
import { ThreadMessageLog } from './threadMessageLog'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { ActivitySubscribers, certifyActivityView, cloneActivitySnapshot } from './activitySnapshots'
import type { AgentSkillCatalog } from '../../shared/agentSkills'
import type { AgentBackgroundWork } from '../../shared/agentMonitoring'
import { claudeSkillPrompt, discoverClaudeSkills } from './claudeSkills'
import { verifyFileMentions } from './promptFiles'
import { ClaudeSubscriptionClient } from './subscriptionClaude'
import { ClaudeProtocol, ClaudeRejected, ClaudeWritePending, object, type ClaudeFrame } from './claudeProtocol'
import { claudeLimitStop, claudeTurnAborted, claudeTurnFailure } from './claudeTurnFailure'
import { authoredClaudeUser, claudeDigest, claudeReadBack, ClaudeSessionLog, claudeText, firstUnread, type OriginBucket } from './claudeSessionLog'
import { carriesAttachedFiles, deliverAttachments } from './attachedFiles'
import { claudeAnswer, claudeDenial, claudePending, type ClaudePending } from './claudeRequests'
import { unreadableRequest } from './nativeRequests'
import { effortAfterChange, fastModeRuns, validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { ClaudeActivity } from './claudeActivity'
import { ClaudeSubagentModels } from './claudeSubagentModels'
import { ClaudeMonitoring } from './claudeMonitoring'
import { SessionReaper } from './sessionReaper'
import { markCompactionActivity } from './compactionActivity'
import { markTurnActivity } from './turnActivity'
import { CLAUDE_RESUME_FAILED, CLAUDE_RESUME_FAILED_SESSION } from '../../shared/threadFailures'
import { ReadsBeforeSend } from './readsBeforeSend'
import { MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../shared/agentActivity'
import { markSendStage } from './sendStages'

/**
 * `delivered`: for a prompt Sotto sent with notes after the user's words (an attached file's, Point at something's;
 * ADR-0131, ADR-0154), the digest of the whole text it delivered, flattened as the session log reads it back, and the
 * length of the notes at its end. A digest and a length only, never the text. Records written before it have none.
 */
/**
 * A thread's origins by digest: of the text Sotto delivered with notes (`byDelivered`), of the user's words for every
 * origin (`byWords`), and of the words for origins recorded before the delivered digest existed that carry notes
 * (`legacyByWords`).
 */
type Bucket = OriginBucket<Alias['origins'][number]>
interface OriginIndex { indexed: number; byDelivered: Map<string, Bucket>; byWords: Map<string, Bucket>; legacyByWords: Map<string, Bucket> }
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), uuid: z.string().uuid(), digest: z.string(), createdAt: z.string(), attachments: z.array(agentAttachmentReferenceSchema).optional(),
  delivered: z.object({ digest: z.string(), suffixLength: z.number().int().nonnegative() }).optional() })
/**
 * Transcript cursor: how far a thread's native transcript had been read when Sotto last stopped, whose
 * file that was, and what the reader had already matched there. Reconnecting seeks to it instead of
 * reading the whole file again, and it is only trusted alongside the messages it accounted for.
 */
const cursorSchema = z.object({ sessionId: z.string().uuid(), offset: z.number().int().nonnegative(), size: z.number().int().nonnegative(),
  ino: z.string().optional(), birthtimeMs: z.number().optional(), consumedOriginIds: z.array(z.string()).default([]), lastDigest: z.string().optional() })
const aliasSchema = z.object({ sessionId: z.string().uuid(), historyEpoch: z.string().uuid().optional(), projectId: z.string().optional(), kind: z.literal('personal').optional(), cwd: z.string(), title: z.string(), modelId: z.string(), createdAt: z.string(),
  compaction: compactionSchema.optional(), compactStartedAt: z.string().datetime().optional(), compactInputIds: z.array(z.string().uuid()).optional(), resumeCompactionDismissed: z.boolean().optional(),
  forkMessageIds: z.record(z.string(), z.string()).optional(), lineage: z.array(z.object({ sessionId: z.string().uuid(), boundary: z.string().uuid().optional() })).optional(), rollbackPending: z.object({ sourceSessionId: z.string().uuid(), sourceDigest: z.string(), boundary: z.string().uuid().optional(), targetSessionId: z.string().uuid().optional() }).optional(),
  reasoningEffort: z.string().optional(), runtimeMode: agentRuntimeModeSchema.optional(), transcriptCursor: cursorSchema.optional(), origins: z.array(originSchema).default([]), answeredRequestIds: z.array(z.string()).default([]),
  /** The user turned fast mode on for this thread (ADR-0143); kept on a model without it, which then runs at normal speed. */
  fastMode: z.boolean().optional(),
  /** The journal generation of the whole write that wrote this record; see `ClaudeOriginJournal`. A record written before there was one has none. */
  journalGeneration: z.number().int().nonnegative().optional() }).refine(alias => alias.kind === 'personal' ? alias.projectId === undefined : !!alias.projectId, 'A personal chat cannot have a project; a project thread requires one.')
type Alias = z.infer<typeof aliasSchema>
/** One folder however it is spelled: resolved, and on Windows without regard to case. */
const pathKey = (path: string): string => { const full = resolve(path); return process.platform === 'win32' ? full.toLowerCase() : full }
// Native CLI permission modes. Aliases without a stored mode keep the original
// approval-required behaviour.
const nativePermissionModes = { 'approval-required': 'default', 'auto-accept-edits': 'acceptEdits', auto: 'auto', 'full-access': 'bypassPermissions' } as const satisfies Record<AgentRuntimeMode, string>
/**
 * The tool the CLI offers only where someone can answer it. Its absence from a session's tool list is
 * how Sotto reads "this CLI has no approval surface", because the CLI reports no other sign of it.
 */
const APPROVAL_SURFACE_TOOL = 'AskUserQuestion'
/** Shown under a reply whose Claude Code process ended on its own; the next message starts the process again. */
const SESSION_ENDED = 'Claude Code stopped before this reply finished, so it may be cut short. Send a message to carry on.'
const APPROVAL_SURFACE_LOST = 'Claude Code is not letting Sotto answer its permission prompts, so it denies them itself and nothing reaches you. No work was lost. Answer in Claude Code until this is fixed, and check for a Sotto or Claude Code update.'
/**
 * Rewinding, and a settings change the running CLI cannot take in place, restart the CLI, and a restart ends
 * the agents a thread still has running (ADR-0023), so both wait for them rather than end work the user
 * started without saying so.
 */
/** Names what is still running, because a command such as a dev server may never finish on its own. */
const backgroundWorkRunning = (work: readonly AgentBackgroundWork[], action: string): string =>
  `${work.length === 1 ? `"${work[0]!.label}" is` : `${work.length} background tasks are`} still running for this thread. Nothing was changed. Wait for ${work.length === 1 ? 'it' : 'them'} to finish, or ask Claude to stop ${work.length === 1 ? 'it' : 'them'}, before ${action}.`
/**
 * Stopping a thread's CLI ends the background work and watches it was running, so a stop Sotto makes on its own
 * account names what ended with it: the user started that work, and it does not come back by itself.
 */
function workStopped(reason: string, work: readonly { label: string }[], next = 'The provider session starts again with the new settings the next time you use the thread.'): string {
  const what = work.length === 1 ? `"${work[0]!.label}"` : `${work.length} background tasks`
  const them = work.length === 1 ? 'it' : 'them'
  return `${reason}, so Sotto stopped this provider session, and ${what} stopped with it. ${next} Ask Claude to start ${them} again if you still need ${them}.`
}
type ConfigureCommand = Extract<AgentHostCommand, { type: 'configure-thread' }>
const SETTINGS_UNCONFIRMED = 'Claude Code did not confirm the settings change'
const SETTINGS_PART_TAKEN = 'Claude Code took only part of the settings change and would not undo it'
/**
 * A thread's settings as its CLI runs them: what `--model`, `--effort` and `--permission-mode` said at launch, and whether
 * `--settings` turned fast mode on. `fastMode` is what runs, not the user's choice: a thread that chose fast mode on a
 * model without it runs at normal speed (ADR-0143), and the choice stays on the alias.
 */
type ClaudeSettings = { modelId: string; reasoningEffort: string | undefined; runtimeMode: AgentRuntimeMode; fastMode: boolean }
/**
 * One control request and the setting it changes once the CLI answers success. An effort step also says the level the
 * CLI then runs Ultracode at, or null for a level that turns Ultracode off.
 */
type ClaudeSettingsStep = { field: keyof ClaudeSettings; request: ClaudeFrame; ultracodeEffort?: UltracodeEffort | null }
/**
 * How a settings change reached the CLI, for the operational log: applied over the control channel, applied
 * by starting the CLI again, refused by the CLI (a restart or a refusal follows), or left unconfirmed. Event
 * names only; a model, a level or a mode never reaches the log.
 */
export type ClaudeAdapterEvent = 'claude-mcp-config-cleanup-failed' | 'claude-origin-journal-clear-failed' | 'claude-origin-journal-fold-failed' | 'claude-settings-applied-live' | 'claude-settings-applied-restart' | 'claude-settings-live-rejected' | 'claude-settings-unconfirmed'
  | 'claude-ultracode-effort-unconfirmed'
/**
 * What an alias, or the thread that shows it, says the settings are; one saved without a mode runs approval-required.
 * Fast mode runs only where the user chose it and `models`, the catalog, says the model offers it.
 */
const settingsOf = (value: Pick<Alias, 'modelId' | 'reasoningEffort' | 'runtimeMode' | 'fastMode'>, models: AgentHostSnapshot['models']): ClaudeSettings =>
  ({ modelId: value.modelId, reasoningEffort: value.reasoningEffort, runtimeMode: value.runtimeMode ?? 'approval-required', fastMode: fastModeRuns({ models }, value.modelId, value.fastMode) })
const sameSettings = (first: ClaudeSettings, second: ClaudeSettings): boolean =>
  first.modelId === second.modelId && first.reasoningEffort === second.reasoningEffort && first.runtimeMode === second.runtimeMode && first.fastMode === second.fastMode
/**
 * Fast mode's and Ultracode's launch flag: `--settings` as a flag layer, which leaves the user's own saved settings alone.
 * Both are sent on every launch, off as well as on: a `fastMode` the user saved with `/fast` would otherwise run a thread
 * fast, and bill it so, while its bolt shows off, and would carry over when a live model change moves the thread onto a
 * model with it; an `ultracode` saved in the user's Claude Code settings would run every thread as a workflow (ADR-0148).
 */
export const flagSettingsArguments = (fastMode: boolean, ultracode: boolean): readonly string[] => ['--settings', JSON.stringify({ fastMode, ultracode })]
/**
 * The effort the CLI is told for a thread's level (ADR-0148): Ultracode is no effort of Claude Code's, so it is sent as
 * the level it runs at, `at`, with `ultracode` on; every other level is sent as itself with `ultracode` off.
 */
export function nativeEffort(level: string | undefined, at: UltracodeEffort | undefined): { effortLevel: string | undefined; ultracode: boolean } {
  return level === ULTRACODE ? { effortLevel: at, ultracode: true } : { effortLevel: level, ultracode: false }
}
/** Whether a spare that is still running was started in this folder with these settings. */
const spareFits = (spare: Spare, cwd: string, settings: ClaudeSettings): boolean =>
  !spare.exited && spare.cwd === cwd && sameSettings(spare.settings, settings)
/**
 * The control requests that take a running CLI from one set of settings to another, in the order they are
 * sent. A model and its effort are one change: a model change always sends the effort that goes with it, the
 * way `--effort` goes with `--model` at launch, and no effort is sent as none, which the CLI reads as the
 * model's own default. Undefined when only a restart can make the change. The CLI takes `bypassPermissions`
 * only when bypassing was allowed at launch, and a CLI started with that allowance keeps it, so full access
 * is entered and left by starting the CLI again: its launch arguments stay the ones a fresh start in that
 * mode would have.
 */
export function settingsSteps(from: ClaudeSettings, to: ClaudeSettings, ultracodeAt?: UltracodeEffort): ClaudeSettingsStep[] | undefined {
  if ((from.runtimeMode === 'full-access') !== (to.runtimeMode === 'full-access')) return undefined
  const steps: ClaudeSettingsStep[] = []
  const model = from.modelId !== to.modelId
  // Fast mode goes off before a model change and comes on after one, so the CLI never holds it on a model without it.
  // Off is `false` rather than none: the flag layer then outranks a `fastMode` in the user's own settings.
  const fast = (on: boolean): ClaudeSettingsStep => ({ field: 'fastMode', request: { subtype: 'apply_flag_settings', settings: { fastMode: on } } })
  if (from.fastMode && !to.fastMode) steps.push(fast(false))
  if (model) steps.push({ field: 'modelId', request: { subtype: 'set_model', model: to.modelId } })
  if (from.reasoningEffort !== to.reasoningEffort || model && to.reasoningEffort !== undefined) {
    // Ultracode goes with the effort in one request, so the CLI never runs a workflow at a level the thread does not show.
    // It is named only on a change to or from it: between other levels the launch's flag layer already holds it off.
    const { effortLevel, ultracode } = nativeEffort(to.reasoningEffort, ultracodeAt)
    const switching = ultracode || from.reasoningEffort === ULTRACODE
    steps.push({ field: 'reasoningEffort', request: { subtype: 'apply_flag_settings', settings: { effortLevel: effortLevel ?? null, ...(switching ? { ultracode } : {}) } },
      ...(switching ? { ultracodeEffort: ultracode ? effortLevel as UltracodeEffort : null } : {}) })
  }
  if (!from.fastMode && to.fastMode) steps.push(fast(true))
  if (from.runtimeMode !== to.runtimeMode) steps.push({ field: 'runtimeMode', request: { subtype: 'set_permission_mode', mode: nativePermissionModes[to.runtimeMode] } })
  return steps
}
/** Appended to Claude Code's own system prompt on every thread process, Watcher's included (ADR-0080). */
const CLAUDE_QUESTIONS = questionInstructions('AskUserQuestion', false)
/**
 * Claude Code asks the API by default for thinking shown as updates, under which the server may swap the prose a model
 * writes between tool calls for a short summary filed as a thinking block. A reply written just before AskUserQuestion
 * then reached Sotto only as a Thinking row and its card showed with no reply above it (October 28, 2026). Off, the
 * model's prose comes back as text and becomes its message.
 */
const PROSE_STAYS_TEXT = { CLAUDE_CODE_THINKING_DISPLAY_UPDATES: '0' }
function permissionArguments(mode: AgentRuntimeMode = 'approval-required'): string[] {
  // Two flags, and both are needed. `--permission-prompts host` only says prompts are not force-denied;
  // `--permission-prompt-tool stdio` is what makes this process the surface that answers them, the way
  // the native SDK spells it. Without the second the CLI has no approval surface, so it answers every
  // prompt with a local deny and never offers AskUserQuestion: approvals and questions silently stop
  // reaching the user, in every mode. Every mode passes it, full-access included: bypassPermissions
  // prompts for very little, but what it does prompt for is the user's to answer rather than the client's.
  return ['--permission-mode', nativePermissionModes[mode], '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
    // The CLI only accepts bypassPermissions when bypassing is explicitly allowed at launch.
    ...(mode === 'full-access' ? ['--allow-dangerously-skip-permissions'] : [])]
}
// Sotto's own browser tools carry no native prompt. Admission is not authority: opening a page,
// navigating, clicking and typing still need the user's one-time answer in Tools (ADR-0020), and
// the native prompt asked the same question a second time without naming the browser. The names are
// listed one by one because the CLI does not match a wildcard against a tool added at launch, and
// the flag is variadic, so it is only ever followed here by another option.
/** Sotto's own tools carry no native prompt: the answer that matters is Sotto's (ADR-0020, ADR-0035). */
function toolAllowance(servers: readonly { server: Pick<ThreadMcpServer, 'name'>; definitions: readonly { name: string }[] }[]): string[] {
  const names = servers.flatMap(({ server, definitions }) => definitions.map(tool => `mcp__${server.name}__${tool.name}`))
  return names.length ? ['--allowedTools', ...names] : []
}
export interface ClaudeStreamJsonHostOptions {
  usageEnabled?: boolean
  /** Restart stopped threads (ADR-0144), the Owl answer read once at start: a turn stopped at a usage limit says so on its `lastTurn`. */
  limitStops?: boolean
  /** Test-only admission override. Production wiring never supplies it. */
  userDataPath: string; executable?: string; args?: string[]; claudeHome?: string; environment?: NodeJS.ProcessEnv; requestTimeoutMs?: number; pollIntervalMs?: number
  /** Desktop supplies its packaged SDK resource; Node resolves the installed development SDK. */
  historyModulePath?: string
  /** Session reaper cadence and idle threshold; see `sessionReaper.ts`. */
  reaperSweepMs?: number; sessionIdleMs?: number
  /**
   * How many of the watched set's CLIs a connect starts at once, `CONNECT_STARTS` when absent. Production never sets
   * it; the opt-in live check (`claudeEarlyStartLive.test.ts`) does, to time one at a time against the default.
   */
  connectStarts?: number
  /** Stable event names only; never a model, a level, a mode or anything a thread said. */
  logEvent?: (event: ClaudeAdapterEvent) => void
  /** The effort Ultracode runs at on this machine (ADR-0148), read at every launch and send; Extra high when absent. */
  ultracodeEffort?: () => UltracodeEffort
}
/**
 * How many CLIs a connect starts at once for the watched set. Each is a process of its own that takes about a second
 * to answer `initialize`; a few at a time keeps a send to the last of them from waiting on all the others, without a
 * burst of processes on a machine with many open panes.
 */
const CONNECT_STARTS = 4
/** The frames a spare may say before its thread's first send adopts it. A fresh CLI says two or three; more is not kept. */
const SPARE_FRAMES = 64
/**
 * A spare (#769): the CLI a thread's first send would start, started early because the user began typing. It is
 * keyed by the session ID that send will create the thread under, holds the Claude session ID and the settings it was
 * started with, and is the thread's only once that send adopts it.
 */
type Spare = { sessionId: string; cwd: string; settings: ClaudeSettings; frames: ClaudeFrame[]; scopedTools: string; exited: boolean
  runtime?: Runtime; ready?: Promise<{ runtime: Runtime; initialized: ClaudeFrame }> }
/** Which of Sotto's scoped servers answered for a session, in order: a spare is adopted only by a start that gets the same. */
const scopedNames = (servers: readonly { tools: ScopedThreadTools }[]): string => servers.map(({ tools }) => tools.name).join('\n')
/** `client` is the client generation the CLI was launched from: see `clientUpdated`. */
type Runtime = { protocol: ClaudeProtocol; requests: Map<string, ClaudePending>; answered: Set<string>; answerWrites: Map<string, 'pending' | 'failed'>; clientRevision: number; watcher: boolean
  /**
   * A Watcher's request note, or a wake-up's news for it, and the words of the prompt it was written with. Only that
   * prompt's UserPromptSubmit hook takes it as context: a steer, or a turn Claude Code starts itself, never does.
   */
  requestNote?: { readonly note: string; readonly text: string } | undefined
  /**
   * The widest permission this CLI's role agents were given at launch (#1042). The thread's permission narrowing below it
   * starts the CLI again, so no agent keeps more than its thread.
   */
  subagentMode?: AgentRuntimeMode | undefined
  /** The level this CLI runs Ultracode at, from its launch or its last confirmed change; undefined while Ultracode is off (ADR-0148). */
  ultracodeEffort?: UltracodeEffort | undefined }
/**
 * The one hook a Watcher's CLI is started with (ADR-0073): UserPromptSubmit, answered on this process's own control
 * channel with the request note as the prompt's additional context, so the note never joins the user's words.
 */
const WATCHER_REQUEST_HOOK = 'sotto_watcher_request'

/** A read of a thread's transcript from its first byte into a seeded log (`ClaudeStreamJsonHost.replays`). */
interface Replay {
  /** True until a read has run to the end of the transcript. */
  reading: boolean
  /** The user messages the read has reached, the newest of which is `userId`. */
  readonly seen: Set<string>
  userId?: string
  /** The newest message with words the read has reached. */
  textId?: string
  /** The stored words of each message, when the store handed them over, while the read runs. */
  words?: ReadonlyMap<string, string>
}

/** One native coding CLI per thread. Credentials and transcript persistence remain native. */
export class ClaudeStreamJsonHost implements AgentHost {
  readonly subscribeUsage?: (listener: (record: UsageTokenObservation) => void) => () => void
  readonly visitUsage?: (id: string, visitor: (record: UsageTokenObservation) => void) => void
  readonly readProviderQuota?: (providerId: ProviderId, refresh: boolean) => Promise<UsageQuotaRead>
  readonly scanUsageHistory?: (sink: UsageHistorySink, signal: AbortSignal) => Promise<void>
  /** Claude's account limits: read on demand through get_usage, with Claude Code's passive events between reads (ADR-0083). */
  private readonly limits = new ClaudeLimits()
  /** Runtimes whose CLI has answered initialize, so get_usage can go over a live thread's channel. */
  private readonly initializedRuntimes = new WeakSet<Runtime>()
  private readonly usageGroups = new Map<string, { id: string; startedAt?: string | undefined }>()
  private readonly usageEnabled: boolean
  private launchProfiles: ThreadLaunchProfiles | undefined
  private readonly resolvedWatcherProfiles = new Map<string, WatcherLaunchProfile>()
  private readonly checkingProfileRequests = new WeakMap<Runtime, Set<string>>()
  useLaunchProfiles(profiles: ThreadLaunchProfiles): void { this.launchProfiles = profiles }
  profileRefusalHandler(id: string) {
    const generation = this.generation, runtime = this.runtimes.get(id), spare = this.spares.get(id)
    if (!runtime && !spare) return undefined
    return (reason: string) => {
      if (generation !== this.generation || this.runtimes.get(id) !== runtime || this.spares.get(id) !== spare) return
      return this.stopWatcher(id, this.resolvedWatcherProfiles.get(id), reason, generation, runtime)
    }
  }
  private browserTools: BrowserAgentTools | undefined
  useBrowserTools(tools: BrowserAgentTools): void { this.browserTools = tools }
  private threadTools: readonly ScopedThreadTools[] = []
  useThreadTools(tools: readonly ScopedThreadTools[]): void { this.threadTools = tools }
  private workerRoles: WorkerRoleSource | undefined
  useWorkerRoles(roles: WorkerRoleSource): void { this.workerRoles = roles }
  /** A launch's role agents and the instructions that name them, or nothing while worker roles are off. */
  private subagentRoles(threadMode: AgentRuntimeMode, canDelegate: boolean) {
    if (!this.workerRoles) return undefined
    const table = this.workerRoles.table()
    const subagents = claudeSubagents(table, threadMode, this.state.models, nativePermissionModes)
    const instructions = subagentRoleInstructions(table, { provider: 'claude', agents: subagents?.kinds ?? new Set(), agentTool: 'claude', canDelegate })
    return { subagents, instructions }
  }
  /** Resolve main's durable identity before even reusing a live process; permission preferences confer no profile. */
  private checkProfileContinuation(id: string, generation: number, runtime?: Runtime): void {
    if (generation !== this.generation || runtime && this.runtimes.get(id) !== runtime) throw new Error('Claude connection was cancelled.')
  }
  private async watcherProfile(id: string, _modelId?: string, generation = this.generation,
    runtime?: Runtime): Promise<WatcherLaunchProfile | undefined> {
    const profile = await this.resolveWatcherProfile(id, generation, runtime)
    this.checkProfileContinuation(id, generation, runtime)
    if (!profile) return undefined
    validateWatcherProfile(profile)
    return profile
  }
  private async resolveWatcherProfile(id: string, generation = this.generation, runtime?: Runtime): Promise<WatcherLaunchProfile | undefined> {
    if (!this.launchProfiles) return undefined
    try {
      const profile = await this.launchProfiles.profileFor(id)
      this.checkProfileContinuation(id, generation, runtime)
      if (!profile && this.resolvedWatcherProfiles.has(id)) {
        throw new WatcherProfileRefusal('Watcher’s profile is no longer available. Its session and tools were stopped. Reopen Watcher to recover.')
      }
      if (profile) this.resolvedWatcherProfiles.set(id, profile)
      return profile
    } catch (error) {
      this.checkProfileContinuation(id, generation, runtime)
      const reason = error instanceof WatcherProfileRefusal ? error.message : 'Watcher’s saved profile could not be verified. Its session was stopped. Reopen Watcher to recover.'
      await this.stopWatcher(id, this.resolvedWatcherProfiles.get(id), reason, generation, runtime)
      throw error instanceof WatcherProfileRefusal ? error : new WatcherProfileRefusal(reason)
    }
  }
  private async stopWatcher(id: string, profile: WatcherLaunchProfile | undefined, reason: string,
    generation = this.generation, expectedRuntime?: Runtime): Promise<void> {
    this.checkProfileContinuation(id, generation, expectedRuntime)
    try { profile?.revoke(reason) } catch { /* A broken tool-server cleanup must still stop its provider process. */ }
    const spare = this.spares.get(id)
    if (spare) {
      spare.exited = true
      // Drain startup without awaiting it here: spawn's own profile lookup can be the refusal.
      void this.discardSpare(id)
      if (spare.runtime) { spare.runtime.protocol.stop(); this.trackClosure(spare.runtime.protocol.closed) }
    }
    const runtime = expectedRuntime ?? this.runtimes.get(id)
    if (runtime) await this.stopRuntime(id, runtime)
    if (generation !== this.generation || this.runtimes.has(id) && this.runtimes.get(id) !== runtime) return
    const thread = this.threads.get(id)
    if (thread) {
      thread.status = 'error'; thread.requests = []
      if (thread.lastTurn?.status === 'running') {
        this.acknowledgements.get(thread.lastTurn.id)?.(false)
        thread.lastTurn = { ...thread.lastTurn, status: 'failed' }; this.markTurn(id, 'failed', undefined, reason)
      }
      this.changed(id)
    }
    this.state.error = reason; this.emit()
  }
  private readonly usage: NativeUsage
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  /** Origins recorded since `claude-threads.json` was last written whole; see `ClaudeOriginJournal`. */
  private readonly originJournal: ClaudeOriginJournal<Alias['origins'][number]>
  /** The journal generation the next origin line is appended under; every whole write of the store moves it on. */
  private journalGeneration = 0
  /** Every write of the thread store and of the origin journal, in order: a clear never passes an append it did not write. */
  private aliasWrites: Promise<void> = Promise.resolve()
  /** The whole-store write queued behind `aliasWrites` and not yet started, which later calls share. */
  private queuedAliasWrite: Promise<void> | undefined
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private readonly client: ClaudeSubscriptionClient
  private aliases: Record<string, Alias> = {}
  /** Whether `this.aliases` reflects the store: false until a `connect()` has loaded it once (ADR-0140). */
  private aliasesLoaded = false
  /** Threads `forgetThread` removed, kept so a `connect()` racing its disk write cannot bring one back. */
  private readonly forgottenAliasIds = new Set<string>()
  private readonly threads = new Map<string, AgentThread>()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly starting = new Map<string, Promise<Runtime>>()
  /** Early-started CLIs for threads whose first send has not happened yet: see `startThreadSession`. */
  private readonly spares = new Map<string, Spare>()
  /**
   * Per thread: a CLI Sotto let go, until it has exited. It can take half a second, and background work may still
   * be writing to the session meanwhile, so a start waits for it: one session never has two CLIs.
   */
  private readonly closing = new Map<string, Promise<void>>()
  private readonly logs = new Map<string, ClaudeSessionLog>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly activityListeners = new ActivitySubscribers()
  /** Thread changes (ADR-0016, #925), published beside the activity snapshots from the same view. */
  private readonly threadChanges = new AdapterThreadChanges({
    view: historyFromEvents => this.activityView(historyFromEvents),
    thread: (id, historyFromEvents) => this.activityThread(id, historyFromEvents),
    rest: () => { certifyActivityView(this.state, []); return restOf(this.state) },
  })
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    for (const listener of this.listeners) listener(this.view())
    this.activityListeners.publish(historyFromEvents => this.activityView(historyFromEvents))
    this.threadChanges.publish()
  }, () => adapterItemCount(this.messageLog, this.threads.values()))
  private readonly acknowledgements = new Map<string, (delivered?: boolean) => void>()
  /** For each origin whose send is waiting: records the prompt from what was sent and acknowledges it, for when Claude Code takes it before or without an echo. */
  private readonly recordUnechoed = new Map<string, () => void>()
  /**
   * Steers Claude Code holds and has not read, by origin. It queues a prompt sent while a turn runs. One sent now cuts
   * the turn and starts the next; one sent while a tool call runs is read into the turn once the call returns, and is
   * part of that turn. `carried` once the turn ended first, a cut or a stop included, so it starts the next turn.
   * `unconfirmed` once its acknowledgement never came: still told apart from a turn's prompt, but not waited for.
   */
  private readonly steers = new Map<string, { readonly threadId: string; readonly now: boolean; carried: boolean; unconfirmed?: true }>()
  /** Steers read into a running turn: part of that turn, never the prompt it answers. */
  private readonly foldedSteers = new Set<string>()
  /** Per thread: the tool calls of the running turn's own messages still waiting for their results (see `steerTurn`). */
  private readonly toolsRunning = new Map<string, Set<string>>()
  private readonly dispatching = new Set<string>()
  /** Threads whose stop has gone out: the error result that closes the turn may arrive before the stop is acknowledged. */
  private readonly interrupting = new Set<string>()
  /** The threads whose settings change is being dispatched now: the part of `dispatching` a refusal names as such. */
  private readonly configuring = new Set<string>()
  private readonly configurationGuards = new Map<string, () => void>()
  private readonly configurationLaunches = new Set<string>()
  /** The error each thread's failed turn put on the provider, so that thread's next finished turn can take it down again. */
  private readonly turnFailures = new Map<string, string>()
  /** The classification on a turn's last assistant message, when Claude Code gave one for a failed API call. */
  private readonly assistantErrors = new Map<string, string>()
  private readonly logOrigins = new Map<string, Set<string>>()
  /** Each thread's origins by the digest of the text Sotto delivered with notes, keyed by the origin list it indexes. */
  private readonly deliveredIndex = new WeakMap<Alias['origins'], OriginIndex>()
  private readonly lastLogDigest = new Map<string, string>()
  /**
   * Threads whose transcript is read from its first byte into a log already told what the store holds.
   * The seeded log knows every stored user message before the read reaches it, so while the read runs a
   * replayed record takes its turn and anchor from how far the read has got, as it would from an empty log.
   * The note stays `reading` until a read of the transcript has run to its end; after that it only remembers
   * the message the read ended on, for a record that comes before any new message says something.
   */
  private readonly replays = new Map<string, Replay>()
  /** Threads the coordinator just read for a send (#765): that read stands for the send's own first one. */
  private readonly readsBeforeSend = new ReadsBeforeSend(id => this.readState(id))
  private readonly nativeTakeovers = new Set<string>()
  private readonly completedOrigins = new Set<string>()
  /** The prompt each thread's running turn answers when Claude Code gave it to itself; its result need not name it. */
  private readonly selfTurns = new Map<string, string>()
  /** Threads whose CLI has opened a query since its last result; Claude Code opens every turn with `system/init`. */
  private readonly queries = new Set<string>()
  private readonly assistantBlocks = new Map<string, Map<string, string>>()
  /** Watched set: the threads the coordinator asked for. Their CLIs are started eagerly and never reaped. */
  private readonly observed = new Set<string>()
  private readonly reaper: SessionReaper
  private readonly activity = new Map<string, ClaudeActivity>()
  /** Per thread: the subagent transcripts still being read for a model the stream never named. */
  private readonly subagentModels = new Map<string, ClaudeSubagentModels>()
  private readonly monitoring = new Map<string, ClaudeMonitoring>()
  private readonly restoredHistory = new Map<string, RestoredThreadHistory>()
  /** This adapter's append path: every change to what a thread said leaves through it as an event. */
  private readonly messageLog = new ThreadMessageLog(id => this.threadChanges.mark(id))
  /** What the host's event store already holds, asked per thread before its transcript is read. */
  private history: ThreadHistorySource | undefined
  /**
   * Threads whose cursor resumed on the store's word that it holds their records, which are not read yet. Whatever first
   * changes such a thread's activity reads them (`ensureActivityHistory`), so a thread nothing changes this run costs nothing (#918).
   */
  private readonly activityHistoryPending = new Set<string>()
  /** The assistant message a stream has opened per thread, so its deltas are recorded as appends. */
  private readonly streaming = new Map<string, string>()
  /** The CLI each thread's /compact was written to, until that CLI's result for it or its exit. */
  private readonly compacting = new Map<string, Runtime>()
  private cursorTimer: ReturnType<typeof setTimeout> | undefined
  /** The transcript cursor each thread's saved record last carried, so a write can hold an advanced one back. */
  private readonly savedCursors = new Map<string, NonNullable<Alias['transcriptCursor']>>()
  private executable = ''
  private generation = 0
  /** Which client new CLIs start from, moved on by each client update; a thread's CLI keeps the one it started with. */
  private clientRevision = 0
  /** Threads whose CLI is an outdated process (CONTEXT.md): each stops as soon as its thread is not busy. */
  private readonly outdated = new Set<string>()
  private outdatedTimer: ReturnType<typeof setImmediate> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private polling: Promise<void> | undefined
  private queuedPoll: Promise<void> | undefined
  private readonly closures = new Set<Promise<void>>()
  private trackClosure(work: Promise<void>): void {
    this.closures.add(work)
    void work.then(() => this.closures.delete(work), () => this.closures.delete(work))
  }
  private state: AgentHostSnapshot = { connected: false, name: 'Claude Code', version: '', models: [], projects: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true, skills: true, steer: true, compact: true } }
  constructor(private readonly options: ClaudeStreamJsonHostOptions) {
    this.usageEnabled = options.usageEnabled === true
    this.usage = new NativeUsage(options.userDataPath, 'claude', options.usageEnabled)
    if (options.usageEnabled) {
      this.subscribeUsage = listener => this.usage.subscribeUsage(listener)
      this.visitUsage = (id, visitor) => this.usage.visitUsage(id, visitor)
      this.scanUsageHistory = (sink, signal) => this.scanHistory(sink, signal)
      this.readProviderQuota = async (providerId, refresh) => {
        if (providerId !== 'claude') return unavailableProviderQuota(providerId, 'unsupported')
        if (!this.state.connected) return unavailableProviderQuota('claude', 'not-connected')
        const control = this.limitsControl()
        return this.limits.read(refresh, {
          ...(control ? { control } : {}), ...(this.executable ? { executable: this.executable } : {}),
          prefixArgs: this.options.args ?? [], environment: this.client.environment(), workingDirectory: this.options.userDataPath,
        })
      }
    }
    // Compact: it holds every thread's record and every origin, and is rewritten whole.
    this.aliasStore = AtomicJsonStore.compact(join(options.userDataPath, 'claude-threads.json'), preserveLegacyAliases(z.record(z.string(), aliasSchema).parse), () => ({}))
    const journalLine = z.object({ threadId: z.string(), origin: originSchema, generation: z.number().int().nonnegative().optional() })
    this.originJournal = new ClaudeOriginJournal(join(options.userDataPath, 'claude-origins.jsonl'), value => {
      const entry = journalLine.safeParse(value)
      return entry.success ? entry.data : undefined
    })
    this.projectStore = new AtomicJsonStore(join(options.userDataPath, 'claude-projects.json'), z.array(agentProjectSchema).parse, () => [])
    this.client = new ClaudeSubscriptionClient(options.userDataPath, { ...(options.executable ? { executable: options.executable } : {}), ...(options.args ? { prefixArgs: options.args } : {}), ...(options.environment ? { environment: options.environment } : {}) })
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs !== undefined ? { sweepEveryMs: options.reaperSweepMs } : {}),
      ...(options.sessionIdleMs !== undefined ? { idleAfterMs: options.sessionIdleMs } : {}),
      isWatched: id => this.observed.has(id),
      isBusy: id => this.busy(id),
      stop: id => this.stopSession(id),
    })
  }
  /**
   * A turn, live watch, background work, unanswered request, compaction or command mid-dispatch holds a
   * session open: stopping the CLI would end the workflow, subagent or command the thread is still running.
   */
  private busy(id: string): boolean {
    const thread = this.threads.get(id)
    return this.dispatching.has(id) || this.starting.has(id) || !!thread && (thread.status === 'running' || thread.requests.length > 0 || !!thread.monitoring?.length || !!thread.backgroundWork?.length)
      || compactionPending(this.aliases[id]?.compaction) || !!this.aliases[id]?.rollbackPending
  }
  /**
   * End this thread's CLI and flush its transcript cursor, the way disconnecting does (ADR-0015). Nothing
   * the user can see changes: the thread keeps its messages and its idle status, its transcript is still
   * read, and the next action launches the CLI again from the stored session.
   */
  private async stopSession(id: string): Promise<void> {
    if (this.spares.has(id)) { this.discardSpare(id); return }
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    this.messageLog.release(id)
    await this.stopRuntime(id, runtime)
    this.flushCursors()
  }
  /**
   * Let this thread's CLI go and wait until it has exited; a start that comes in meanwhile waits too. Returns the
   * background work and watches the CLI was still running for the thread, which ended with it: the CLI's own
   * exit handler does not see a stop Sotto made, so a caller that may stop work says so itself.
   */
  private async stopRuntime(id: string, runtime: Runtime): Promise<{ label: string }[]> {
    const thread = this.threads.get(id)
    let ended: { label: string }[] = []
    if (this.runtimes.get(id) === runtime) {
      ended = thread?.backgroundWork?.length ? [...thread.backgroundWork] : [...thread?.monitoring ?? []]
      this.runtimes.delete(id); this.clearMonitoring(id); this.dropSteers(id)
      const wasOpen = !!thread && 'providerSessionOpen' in thread
      if (thread && wasOpen) { delete thread.providerSessionOpen; this.changed(id) }
      if (this.thinkingEnded(id) || wasOpen) this.emit()
    }
    runtime.protocol.stop()
    const closed = runtime.protocol.closed
    this.closing.set(id, closed)
    try { await closed } finally { if (this.closing.get(id) === closed) this.closing.delete(id) }
    return ended
  }
  /**
   * The thread's CLI is ending, by its own exit or by a stop Sotto made. A thinking block it was writing gets nothing
   * more, so its row stops running with it. Says whether any row changed.
   */
  private thinkingEnded(id: string): boolean {
    const projector = this.activity.get(id); const thread = projector ? this.ensureActivityHistory(id) : undefined
    if (!thread || !projector) return false
    const activities = projector.runtimeEnded(thread.activities)
    if (activities === thread.activities) return false
    thread.activities = activities; this.changed(id); return true
  }
  /** Write the cursors a pending cadence still owes, rather than losing them with the session. */
  private flushCursors(): void {
    if (!this.cursorTimer) return
    clearTimeout(this.cursorTimer); this.cursorTimer = undefined
    this.trackClosure(this.persist().catch(() => undefined))
  }
  async connect(): Promise<AgentHostSnapshot> {
    if (this.usageEnabled) { this.limits.clear(); this.usageGroups.clear() }
    this.disconnect(); await this.closed()
    const generation = this.generation
    await this.removeLeftoverConfigs()
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    await this.usage.load()
    const [account, executable, aliases, projects] = await Promise.all([this.client.status(), this.client.findExecutable(), this.readAliases(), this.projectStore.read()])
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    this.state.error = undefined; this.turnFailures.clear(); this.assistantErrors.clear(); this.state.models = account.models.map(model => ({ ...model, provider: PROVIDER_LABELS.claude, ready: account.ready, runtimeModes: [...agentRuntimeModeSchema.options], supportsImages: true,
      ...(account.defaultModelId && model.id === account.defaultModelId ? { recommended: true } : {}) }))
    delete this.state.problem; delete this.state.account
    if (!account.ready || !executable) {
      this.state.error = account.detail
      // What a host's provider tile says and offers (ADR-0037), with the installed version where there is one.
      this.state.problem = !executable ? 'not-installed' : account.problem ?? 'cannot-start'
      if (executable) this.state.version = await this.client.version(executable) || this.state.version
      this.emit(); return this.view()
    }
    if (account.account) this.state.account = account.account
    // Without this the version is only known once a session runs, so an idle provider could not be
    // compared against what its channel publishes (ADR-0042).
    this.state.version = await this.client.version(executable) || this.state.version
    for (const id of this.forgottenAliasIds) delete aliases[id]
    this.executable = executable; this.aliases = aliases; this.aliasesLoaded = true; this.state.projects = projects
    this.savedCursors.clear()
    for (const [id, alias] of Object.entries(aliases)) if (alias.transcriptCursor) this.savedCursors.set(id, alias.transcriptCursor)
    for (const alias of Object.values(this.aliases)) if (alias.kind !== 'personal' && alias.compaction?.status === 'running') alias.compaction = { ...alias.compaction, status: 'uncertain', error: 'Native compaction was interrupted by disconnection. Reconnecting observes its result without retrying.' }
    // Reconnecting keeps what this process already projected, so its stored cursor stays usable.
    const held = new Map([...this.threads].map(([id, thread]) => [id, {
      threadId: id, messages: this.messageLog.messages(id), ...(this.activityHistoryPending.has(id) ? {} : { activities: thread.activities ?? [] }), ...(thread.historyEpoch ? { historyEpoch: thread.historyEpoch } : {}),
    }]))
    this.messageLog.forgetAll()
    this.threads.clear(); this.threadChanges.markAll(); this.activityHistoryPending.clear(); this.logs.clear(); this.activity.clear(); this.subagentModels.clear(); this.logOrigins.clear(); this.lastLogDigest.clear(); this.replays.clear(); this.readsBeforeSend.clear(); this.nativeTakeovers.clear(); this.completedOrigins.clear(); this.steers.clear(); this.foldedSteers.clear(); this.toolsRunning.clear(); this.selfTurns.clear(); this.queries.clear(); this.interrupting.clear(); this.assistantBlocks.clear()
    for (const [id, stored] of Object.entries(aliases)) {
      if (stored.kind === 'personal') continue
      let alias = stored
      if (alias.rollbackPending?.targetSessionId) {
        try { alias = await this.finishRollback(id, alias) }
        catch { this.state.error = 'Claude rollback could not be reconciled. Review its native sessions; it will not be replayed.' }
      }
      this.ensureThread(id, alias)
      this.seedHistory(id, alias, held.get(id) ?? this.restoredHistory.get(id))
      // Handed back for this connect only; a later one is seeded again or reads from the first byte.
      this.restoredHistory.delete(id)
      await this.readLog(id)
      // A connect that another one replaced stops here, before it seeds or reads anything the new one owns.
      if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    }
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    this.state.connected = true
    this.reaper.start()
    // Lazy sessions: connecting starts a CLI only for the watched set. Every other known thread is in the snapshot
    // from its alias, and starts on its first action. The watched set's start a few at a time, so a send to the last
    // of them does not wait for every other to start first (#769).
    const watched = [...this.observed].filter(id => aliases[id] && aliases[id].kind !== 'personal' && !aliases[id].rollbackPending)
    const startNext = async (): Promise<void> => {
      for (let id = watched.shift(); id !== undefined && generation === this.generation; id = watched.shift()) {
        try { await this.start(id) } catch (error) { if (generation === this.generation) { this.threads.get(id)!.status = 'error'; this.changed(id); this.state.error = error instanceof WatcherProfileRefusal ? error.message : CLAUDE_RESUME_FAILED_SESSION } }
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, this.options.connectStarts ?? CONNECT_STARTS), watched.length) }, startNext))
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    this.pollTimer = setInterval(() => { void this.pollSessionLogs().catch(() => { this.state.error = 'Claude history is unavailable. Check the native client before continuing.'; this.emit() }) }, this.options.pollIntervalMs ?? 1000)
    this.pollTimer.unref(); this.emit(); return this.view()
  }
  /**
   * The client on disk was replaced while Sotto stayed connected (ADR-0042). Every thread runs its own CLI, so
   * nothing is disconnected: the client is found again (an update may have moved it), its version is read from
   * the binary, and each CLI moves to it as its thread goes idle. An idle CLI stops now the way the reaper stops
   * one, and the thread's next action starts the new client; a busy one finishes on the old client first. No turn
   * is cancelled and no request is answered. A new client Sotto cannot find or that does not answer is refused
   * with the sentence the update reports, and nothing moves to it.
   */
  async clientUpdated(): Promise<void> {
    if (!this.state.connected) return
    const generation = this.generation
    const executable = await this.client.findExecutable()
    if (generation !== this.generation || !this.state.connected) return
    if (!executable) throw new Error('Claude Code was updated, but Sotto cannot find it now. Threads that are working carry on and nothing was lost. Check the Claude Code install, then connect Claude Code again.')
    const version = await this.client.version(executable)
    if (generation !== this.generation || !this.state.connected) return
    if (!version) throw new Error('Claude Code was updated, but the new version did not answer. Threads that are working carry on and nothing was lost. Connect Claude Code again to try the new version.')
    // Set together, so a CLI is launched either from the old client and counted old, or from the new one.
    this.executable = executable; this.clientRevision++
    this.limits.clientChanged()
    this.state.version = version
    for (const id of this.runtimes.keys()) this.outdated.add(id)
    // A spare nobody has used yet runs the old client too; the thread's first send starts the new one.
    for (const id of [...this.spares.keys()]) this.discardSpare(id)
    this.emit()
    await Promise.all(this.stopOutdated())
  }
  /**
   * Stop each CLI still running a replaced client whose thread is not busy, as the reaper would. A watched thread
   * keeps a CLI, so it is started again on the new client straight away.
   */
  private stopOutdated(): Promise<void>[] {
    const stops: Promise<void>[] = []
    for (const id of [...this.outdated]) {
      const runtime = this.runtimes.get(id)
      if (!runtime || runtime.clientRevision === this.clientRevision) { this.outdated.delete(id); continue }
      if (this.busy(id)) continue
      this.outdated.delete(id)
      const generation = this.generation
      stops.push(this.stopSession(id).catch(() => undefined).then(() => {
        if (generation !== this.generation || !this.state.connected || !this.observed.has(id) || !this.aliases[id] || this.aliases[id].rollbackPending) return
        void this.start(id).catch(() => {
          if (generation !== this.generation) return
          const thread = this.threads.get(id); if (thread) { thread.status = 'error'; this.changed(id) }
          this.state.error = CLAUDE_RESUME_FAILED; this.emit()
        })
      }))
    }
    return stops
  }
  /** Look again once the current work has settled: a turn, request or dispatch that just ended may free an outdated CLI to stop. */
  private scheduleOutdatedStop(): void {
    if (!this.outdated.size || this.outdatedTimer) return
    this.outdatedTimer = setImmediate(() => { this.outdatedTimer = undefined; void Promise.all(this.stopOutdated()) })
  }
  async snapshot(): Promise<AgentHostSnapshot> { await this.pollSessionLogs(); return this.view() }
  async listThreadSkills(threadId: string, _forceReload = false, scope?: AgentSkillScope): Promise<AgentSkillCatalog> {
    const generation = this.generation
    await this.watcherProfile(threadId)
    this.checkProfileContinuation(threadId, generation)
    if (this.aliases[threadId]?.kind === 'personal') throw new Error('That thread is unavailable.')
    void _forceReload // Native discovery is always fresh; no account/directory cache can leak across threads.
    const cwd = this.aliases[threadId]?.cwd ?? (scope?.providerId === 'claude' ? scope.workingDirectory : undefined)
    if (!this.state.connected || !cwd) throw new Error('Reconnect this Claude thread before browsing skills.')
    try {
      const catalog = await discoverClaudeSkills(threadId, await existingWorkingDirectory(cwd), this.executable, this.options.args ?? [], this.client.environment(), this.options.requestTimeoutMs ?? 15000)
      if (generation !== this.generation) throw new Error('Claude connection changed while discovering skills.')
      return catalog
    } catch { return { threadId, providerId: 'claude', cwd, status: 'error', skills: [], errors: [], error: 'Claude native skill discovery failed. Reconnect or check the installed client.' } }
  }
  /**
   * A side call on this thread's client, account and model, in its folder (ADR-0026). It is a separate
   * print run with no session file, so the thread's own CLI is neither started nor resumed for it and
   * its transcript never sees the prompt.
   */
  async writeShortText(id: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    const generation = this.generation
    const profile = await this.watcherProfile(id)
    this.checkProfileContinuation(id, generation)
    if (profile || this.aliases[id]?.kind === 'personal') return null
    const alias = this.aliases[id]
    if (!this.state.connected || !alias || !this.executable) return null
    const effort = sideWritingEffort(this.state.models, alias.modelId)
    const workingDirectory = await existingWorkingDirectory(alias.cwd)
    this.checkProfileContinuation(id, generation)
    return this.client.write({ ...prompt, model: alias.modelId, ...(effort ? { effort } : {}), workingDirectory,
      executable: this.executable, timeoutMs: SIDE_WRITING_TIMEOUT_MS, ...(signal ? { signal } : {}) })
  }
  /**
   * Read a thread back from Claude Code: bring it up to date, then hand back the snapshot. The read before a send
   * (`beforeSend`) is the same read, and it stands for the send's own first read (#765).
   */
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    await this.sync(id, purpose)
    this.readsBeforeSend.mark(id, purpose)
    return this.view(purpose?.historyFromEvents)
  }
  /** How far this thread has been read, as a send's first read compares it with the read the coordinator made for it. */
  private readState(id: string): string { return `${this.generation}:${this.aliases[id]?.sessionId}:${this.messageLog.count(id)}` }
  /**
   * Bring a thread up to date from its transcript: start its session when it has none, read what is new in the
   * transcript, and reopen an uncertain answer when asked. It builds no snapshot; a caller that wants one asks
   * `refreshThread`.
   */
  private async sync(id: string, purpose?: ThreadReadPurpose): Promise<void> {
    if (this.aliases[id]?.kind === 'personal') throw new Error('That thread is unavailable.')
    if (!this.aliases[id]) throw new Error('That Claude thread is unavailable.')
    const generation = this.generation
    // Reading a thread is opening it, so a reaped or never-started session starts here. A start that
    // cannot happen is reported by the action that needs it, not by a read.
    await this.start(id).catch(error => { if (error instanceof WatcherProfileRefusal) throw error })
    await this.readLog(id)
    if (generation !== this.generation || !this.state.connected) throw new Error('Claude connection changed while reading the thread.')
    if (purpose?.retryUncertainAnswers) {
      const runtime = this.runtimes.get(id)
      for (const pending of runtime?.requests.values() ?? []) if ((!purpose.retryUncertainAnswerId || pending.request.id === purpose.retryUncertainAnswerId) && pending.request.delivery === 'uncertain' && runtime!.answerWrites.get(pending.id) !== 'pending') {
        delete pending.request.delivery
        pending.request.answerRetryReady = true
        runtime!.answered.delete(pending.id)
      }
      this.changed(id); this.emit()
    }
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    return this.threadChanges.subscribeActivityChanges(listener, options)
  }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.messageLog.subscribeEvents(listener) }
  useThreadHistory(source: ThreadHistorySource): void { this.history = source }
  observeThreads(ids: readonly string[]): void {
    this.observed.clear(); for (const id of ids) if (this.aliases[id]?.kind !== 'personal') this.observed.add(id)
    this.messageLog.observe([...this.observed])
    if (!this.state.connected) return
    const generation = this.generation
    for (const id of this.observed) if (this.aliases[id]) void this.start(id).catch(error => {
      if (generation !== this.generation) return
      const thread = this.threads.get(id); if (thread) { thread.status = 'error'; this.changed(id) }
      this.state.error = error instanceof WatcherProfileRefusal ? error.message : CLAUDE_RESUME_FAILED; this.emit()
    })
  }
  rollbackCapability(id: string): { supported: boolean; reason?: string } {
    const alias = this.aliases[id]
    if (!alias || !this.threads.has(id)) return { supported: false, reason: 'Choose an owned Claude project thread.' }
    return alias.rollbackPending ? { supported: false, reason: 'Claude rollback is unconfirmed. Review its native sessions before continuing.' }
      : { supported: true }
  }
  async rollbackThread(id: string, removeTurns: number, expectedUserMessageIds: readonly string[]): Promise<AgentHostResult> {
    const generation = this.generation
    await this.watcherProfile(id)
    this.checkProfileContinuation(id, generation)
    const alias = this.aliases[id], thread = this.threads.get(id)
    if (!alias || !thread || !this.state.connected) throw new Error('Connect this Claude thread before rewinding.')
    if (alias.rollbackPending) throw new Error('Claude rollback is unconfirmed; it will not be replayed.')
    if (!Number.isSafeInteger(removeTurns) || removeTurns < 1 || removeTurns > expectedUserMessageIds.length) throw new Error('Choose an exact Claude turn boundary.')
    if (thread.status === 'running' || thread.requests.length || this.dispatching.has(id)) throw new Error('Wait for Claude and answer its requests before rewinding.')
    // Rewinding restarts the CLI, which would end the agents or commands it is still running for this thread.
    if (thread.backgroundWork?.length) throw new Error(backgroundWorkRunning(thread.backgroundWork, 'rewinding it'))
    const history = new ClaudeHistory(this.client.environment(), this.options.claudeHome ?? join(homedir(), '.claude'), alias.cwd, this.options.historyModulePath)
    await this.sync(id)
    const matches = (): boolean => isDeepStrictEqual([...this.messageLog.userMessageIds(id)], [...expectedUserMessageIds])
    if (!matches()) throw new Error('Claude conversation changed. Refresh the checkpoint preview.')
    const messages = await history.read(alias.sessionId)
    const nativeUsers = messages.filter(message => authoredClaudeUser(message))
    const ids = nativeUsers.map(message => alias.origins.find(origin => origin.uuid === message.uuid)?.messageId ?? alias.forkMessageIds?.[message.uuid] ?? message.uuid)
    if (!isDeepStrictEqual(ids, expectedUserMessageIds)) throw new Error('The exact Claude history boundary is unavailable, possibly after compaction. No files or conversation were changed.')
    const retainedCount = ids.length - removeTurns
    const firstRemoved = messages.findIndex(message => message.uuid === nativeUsers[retainedCount]!.uuid)
    const retained = retainedCount ? messages.slice(0, firstRemoved) : []
    const boundary = retained.at(-1)?.uuid
    if (retainedCount > 0 && (!boundary || firstRemoved < 1)) throw new Error('Claude retained history is unavailable.')
    await this.sync(id)
    if (generation !== this.generation || !this.state.connected || !matches() || this.threads.get(id)?.status === 'running' || thread.requests.length || thread.backgroundWork?.length) throw new Error('Claude changed before rewind. Refresh the preview.')
    this.dispatching.add(id)
    const sourceSessionId = alias.sessionId
    let forkDispatched = false
    try {
      alias.rollbackPending = { sourceSessionId, sourceDigest: claudeDigest(JSON.stringify(messages)), ...(boundary ? { boundary } : {}) }
      try { await this.persist() } catch (error) { delete alias.rollbackPending; throw error }
      const runtime = this.runtimes.get(id)
      if (runtime) await this.stopRuntime(id, runtime)
      forkDispatched = true
      const targetSessionId = boundary ? await history.fork(sourceSessionId, boundary) : randomUUID()
      alias.rollbackPending.targetSessionId = targetSessionId; await this.persist()
      const next = await this.finishRollback(id, alias)
      // A confirmed rewind is the one change that takes words back: the thread's record starts again.
      this.messageLog.reset(id, next.historyEpoch)
      this.logs.delete(id); this.activity.delete(id); this.subagentModels.delete(id); this.logOrigins.delete(id); this.lastLogDigest.delete(id); this.replays.delete(id); this.nativeTakeovers.delete(id)
      for (const key of this.assistantBlocks.keys()) if (key.startsWith(`${id}:`)) this.assistantBlocks.delete(key)
      this.ensureThread(id, next); await this.readLog(id)
      if (generation !== this.generation || !this.state.connected) return { accepted: false, uncertain: true }
      await this.start(id); this.emit(); return { accepted: true }
    } catch (error) {
      this.state.error = 'Claude rewind could not be confirmed. Review its native sessions; Sotto will not replay it.'; this.emit()
      if (forkDispatched) return { accepted: false, uncertain: true }
      delete alias.rollbackPending
      await this.persist()
      throw error
    } finally { this.dispatching.delete(id) }
  }
  /** Reconcile only the durably recorded native fork. Never create another fork
   * on restart, and never accept a changed source or partial retained history. */
  private async finishRollback(id: string, alias: Alias): Promise<Alias> {
    const pending = alias.rollbackPending
    if (!pending?.targetSessionId) throw new Error('Claude rollback has no confirmed native fork identity.')
    const history = new ClaudeHistory(this.client.environment(), this.options.claudeHome ?? join(homedir(), '.claude'), alias.cwd, this.options.historyModulePath)
    const source = await history.read(pending.sourceSessionId)
    if (claudeDigest(JSON.stringify(source)) !== pending.sourceDigest) throw new Error('Claude source history changed during rewind.')
    const boundaryIndex = pending.boundary ? source.findIndex(message => message.uuid === pending.boundary) : -1
    if (pending.boundary && boundaryIndex < 0) throw new Error('Claude retained history boundary is unavailable.')
    const retained = source.slice(0, boundaryIndex + 1)
    const fork = await history.read(pending.targetSessionId)
    if (!isDeepStrictEqual(retained.map(message => [message.type, message.message]), fork.map(message => [message.type, message.message]))) throw new Error('Claude fork did not preserve the exact retained history.')
    const remap = new Map(retained.map((message, index) => [message.uuid, fork[index]!.uuid]))
    const next = structuredClone(alias)
    next.sessionId = pending.targetSessionId
    next.historyEpoch = randomUUID()
    next.lineage = [...(alias.lineage ?? []), { sessionId: pending.sourceSessionId, ...(pending.boundary ? { boundary: pending.boundary } : {}) }]
    next.forkMessageIds = Object.fromEntries(retained.filter(message => message.type === 'user').map(message => [remap.get(message.uuid)!, alias.origins.find(origin => origin.uuid === message.uuid)?.messageId ?? alias.forkMessageIds?.[message.uuid] ?? message.uuid]))
    next.origins = alias.origins.filter(origin => remap.has(origin.uuid)).map(origin => ({ ...origin, uuid: remap.get(origin.uuid)! }))
    next.answeredRequestIds = []; delete next.rollbackPending
    this.aliases[id] = next
    try { await this.persist() } catch (error) { this.aliases[id] = alias; throw error }
    return next
  }
  /**
   * Fork from here on a Claude Code thread (#1028, E5b): Claude Code's own session fork, the one rewind uses, copies the
   * conversation up to a reply into a new session, which the new thread is bound to when it is made (ADR-0002). The source
   * thread and its session stay as they are, and files are not rewound. The new session lives where its source's does,
   * so it starts in the same folder. Claude Code keeps an agent's working history inside its own session, so an agent is
   * never forked here; it continues from a thin handover instead. The model is asked nothing.
   */
  async forkThread(request: ThreadForkRequest): Promise<AgentHostResult> {
    const generation = this.generation
    if (!this.state.connected) throw new Error('Connect Claude Code before continuing.')
    if (this.aliases[request.threadId]) return { accepted: true }
    if (request.source.agentId !== undefined || request.source.messageId === undefined) throw new Error('Claude Code keeps an agent’s working history inside its own session, so it can’t be forked, and nothing was made.')
    const sourceId = request.source.threadId, source = this.aliases[sourceId], thread = this.threads.get(sourceId)
    if (!source || !thread || source.kind === 'personal' || await this.watcherProfile(sourceId)) throw new Error('That Claude thread is unavailable.')
    if (source.rollbackPending) throw new Error('Claude rollback is unconfirmed. Review its native sessions before forking; nothing was made.')
    if (request.workingDirectory !== undefined && pathKey(request.workingDirectory) !== pathKey(source.cwd)) throw new Error('A Claude Code fork starts in its thread’s own folder, so it can’t start in another, and nothing was made. Fork into the same folder.')
    validateThreadOptions(this.state, request)
    const busy = (): boolean => { const current = this.threads.get(sourceId); return !current || current.status === 'running' || current.requests.length > 0 || this.dispatching.has(sourceId) }
    if (busy()) throw new Error('Wait for this turn to finish, or stop it, before forking. A fork carries finished turns, and nothing was made.')
    await this.sync(sourceId)
    const history = new ClaudeHistory(this.client.environment(), this.options.claudeHome ?? join(homedir(), '.claude'), source.cwd, this.options.historyModulePath)
    const messages = await history.read(source.sessionId)
    const reply = request.source.messageId
    // A reply is shown under its own message ID, or its line's when the transcript names none (`addMessage`).
    const boundary = messages.findLastIndex(message => message.type === 'assistant' && (typeof object(message.message)?.id === 'string' ? object(message.message)!.id === reply : message.uuid === reply))
    if (boundary < 0) throw new Error('Claude Code doesn’t have that reply in this thread any more, so nothing was made. Refresh the thread and try again.')
    if (generation !== this.generation || busy()) throw new Error('Claude changed before the fork, so nothing was made. Try again.')
    const retained = messages.slice(0, boundary + 1)
    const sessionId = await history.fork(source.sessionId, messages[boundary]!.uuid)
    const fork = await history.read(sessionId)
    if (!isDeepStrictEqual(retained.map(message => [message.type, message.message]), fork.map(message => [message.type, message.message]))) {
      throw new Error('Claude Code’s copy did not match the conversation up to that reply, so Sotto made no thread for it. It may have kept the copy, which Sotto leaves alone.')
    }
    const remap = new Map(retained.map((message, index) => [message.uuid, fork[index]!.uuid]))
    const alias: Alias = { sessionId, projectId: source.projectId, cwd: source.cwd, title: request.title, modelId: request.modelId,
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}), ...(request.runtimeMode ? { runtimeMode: request.runtimeMode } : {}),
      createdAt: new Date().toISOString(), origins: [], answeredRequestIds: [],
      // The user's messages keep the IDs they have in the source thread; the replies keep Claude Code's own.
      forkMessageIds: Object.fromEntries(retained.filter(message => message.type === 'user').map(message => [remap.get(message.uuid)!,
        source.origins.find(origin => origin.uuid === message.uuid)?.messageId ?? source.forkMessageIds?.[message.uuid] ?? message.uuid])) }
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    this.aliases[request.threadId] = alias
    try { await this.persist() } catch (error) { delete this.aliases[request.threadId]; throw error }
    this.ensureThread(request.threadId, alias)
    // The copy is made and bound; a history that can't be read yet is said on the thread, and a refresh reads it.
    try { await this.readLog(request.threadId) }
    catch {
      const thread = this.threads.get(request.threadId)
      if (thread) { thread.historyStatus = 'error'; thread.historyError = 'Claude Code made the copy, but its history could not be read yet. Refresh this thread to read it.'; this.changed(request.threadId) }
    }
    this.emit()
    return { accepted: true }
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.executeNative(command) }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> { return this.executeNative(command, guard) }
  private async executeNative(command: AgentHostCommand, watcherGuard?: () => void): Promise<AgentHostResult> {
    const generation = this.generation
    if ('threadId' in command && await this.watcherProfile(command.threadId, 'modelId' in command ? command.modelId : undefined)) {
      assertWatcherPermission(command)
    }
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    // A command that ends (an answer, a stop, a dispatch let go) may leave an outdated CLI free to stop.
    try { return await this.dispatchNative(command, watcherGuard) } finally { this.scheduleOutdatedStop() }
  }
  private async dispatchNative(command: AgentHostCommand, watcherGuard?: () => void): Promise<AgentHostResult> {
    if ('threadId' in command && this.aliases[command.threadId]?.kind === 'personal') throw new Error('That thread is unavailable.')
    if (!this.state.connected) throw new Error('Connect Claude Code before continuing.')
    if (command.type === 'create-project') {
      if (!isAbsolute(command.path)) throw new Error('Choose an absolute project folder.')
      const projects = this.state.projects.filter(project => project.id !== command.projectId)
      projects.push({ id: command.projectId, title: command.title, path: command.path })
      await this.projectStore.write(projects); this.state.projects = projects; this.emit(); return { accepted: true }
    }
    if (command.type === 'create-thread') {
      if (this.aliases[command.threadId]) return { accepted: true }
      validateThreadOptions(this.state, command)
      const project = this.state.projects.find(candidate => candidate.id === command.projectId)
      if (!project) throw new Error('Choose an existing project.')
      const cwd = await existingWorkingDirectory(command.workingDirectory ?? project.path)
      watcherGuard?.()
      // A spare started for exactly this thread hands it the session ID its CLI already runs (#769); any other spare goes.
      const spare = this.spareFor(command.threadId, cwd, settingsOf(command, this.state.models))
      if (!spare) void this.discardSpare(command.threadId)
      const alias: Alias = { sessionId: spare?.sessionId ?? randomUUID(), projectId: project.id, cwd, title: command.title, modelId: command.modelId,
        reasoningEffort: command.reasoningEffort, ...(command.runtimeMode ? { runtimeMode: command.runtimeMode } : {}), ...(command.fastMode ? { fastMode: true } : {}),
        createdAt: new Date().toISOString(), origins: [], answeredRequestIds: [] }
      this.aliases[command.threadId] = alias
      try { await this.persist() } catch (error) { delete this.aliases[command.threadId]; throw error }
      this.ensureThread(command.threadId, alias); this.emit()
      // Creating a durable local identity does not require a paid model turn.
      try { await this.start(command.threadId) } catch (error) {
        this.threads.get(command.threadId)!.status = 'error'; this.changed(command.threadId); this.emit()
        if (error instanceof WatcherProfileRefusal) throw error
        return { accepted: false, uncertain: true }
      }
      return { accepted: true }
    }
    const id = command.threadId; const alias = this.aliases[id]; const thread = this.threads.get(id)
    if (!alias || !thread) throw new Error('That Claude thread is unavailable.')
    // The coordinator's read before this send stands for its first read (#765).
    const readForSend = this.readsBeforeSend.take(id, command)
    this.reaper.touch(id)
    if (alias.rollbackPending) throw new Error('Claude rollback is unconfirmed. Review the original and forked native sessions before continuing; Sotto will not replay it.')
    if (compactionPending(alias.compaction) && command.type !== 'interrupt' && command.type !== 'answer') throw new Error('Native compaction is still running or unconfirmed. Wait for its result; it will not be sent twice.')
    if (command.type === 'compact-thread') {
      if (this.dispatching.has(id) || thread.status === 'running' || thread.requests.length) throw new Error('Wait for the Claude thread and its requests before compacting.')
      this.dispatching.add(id)
      try {
        const runtime = await this.start(id)
        if (!thread.manualCompactionSupported) throw new Error('This Claude client does not expose native manual compaction.')
        if (this.threads.get(id)?.status === 'running' || thread.requests.length) throw new Error('Claude started working before compaction.')
        // A machine compaction, such as Sotto's idle one (ADR-0127), asks its guard again once the CLI is up: starting it
        // can take long enough for the user to type, send or turn the setting off.
        watcherGuard?.()
        const inputId = randomUUID()
        alias.compaction = { commandId: command.commandId, status: 'running', ...(command.idle ? { idle: true } : {}) }
        alias.compactStartedAt = new Date().toISOString()
        alias.compactInputIds = [...(alias.compactInputIds ?? []), inputId]
        try { await this.persist() } catch (error) { delete alias.compaction; throw error }
        thread.compaction = alias.compaction; thread.status = 'running'; this.changed(id); this.compacting.set(id, runtime); this.emit()
        try { await runtime.protocol.write({ type: 'user', uuid: inputId, session_id: alias.sessionId, parent_tool_use_id: null, message: { role: 'user', content: '/compact' } }) }
        catch {
          alias.compaction = { commandId: command.commandId, status: 'uncertain', error: 'Native compaction is unconfirmed. Reconnect to observe its result; it will not be retried.', ...idleMark(alias.compaction) }
          thread.compaction = alias.compaction; this.changed(id); await this.persist(); this.emit(); return { accepted: false, uncertain: true }
        }
        return { accepted: true }
      } finally { this.dispatching.delete(id) }
    }
    if (command.type === 'configure-thread') return this.configure(id, command, watcherGuard)
    if (command.type === 'send') {
      validatePromptAttachments(this.state, alias.modelId, command.attachments, { workingDirectory: alias.cwd })
      const checkLatestUserMessage = (): void => {
        if (command.expectedLastUserMessageId !== undefined && (this.messageLog.lastUserMessageId(id) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
      }
      if (!readForSend()) await this.sync(id)
      checkLatestUserMessage()
      if (alias.origins.some(origin => origin.messageId === command.messageId)) return this.messageLog.has(id, command.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
      if (this.dispatching.has(id) || thread.status === 'running') throw new Error('Claude is already running a turn.')
      if (thread.requests.length) throw new Error('Answer the pending Claude request before sending another prompt.')
      this.dispatching.add(id)
      try {
        if (this.nativeTakeovers.has(id)) {
          const stale = this.runtimes.get(id)
          if (stale) {
            await this.denyPending(id, stale)
            const ended = await this.stopRuntime(id, stale)
            if (ended.length) this.report(workStopped('The native conversation changed', ended,
              'The provider session resumes with the updated context before this message is sent.'))
          }
          this.nativeTakeovers.delete(id)
        }
        const runtime = await this.start(id)
        await this.applyUltracodeEffort(runtime, alias)
        const { content, nativeText, origin } = await this.nativePrompt(id, command)
        await this.addOrigin(id, alias, origin)
        // Resume and durable origin writes can yield while the user takes over.
        // Recheck at the dispatch boundary; an undispatched origin is safe to remove.
        try {
          await this.sync(id); checkLatestUserMessage()
          if (thread.requests.length || this.threads.get(id)?.status === 'running') throw new Error('The Claude thread started working or needs an answer before another prompt.')
          if (this.runtimes.get(id) !== runtime) throw new Error('Claude Code stopped before this message was sent. Nothing was sent; send it again.')
          watcherGuard?.()
        }
        catch (error) {
          alias.origins = alias.origins.filter(candidate => candidate.uuid !== origin.uuid)
          await this.persist(); throw error
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const forget = (): void => { clearTimeout(timer); this.acknowledgements.delete(origin.uuid); this.recordUnechoed.delete(origin.uuid) }
        const acknowledged = new Promise<boolean>(resolve => {
          timer = setTimeout(() => { forget(); resolve(false) }, this.options.requestTimeoutMs ?? 15000)
          this.acknowledgements.set(origin.uuid, (delivered = true) => { forget(); resolve(delivered) })
        })
        // Claude Code echoes the prompt only as the model's reply begins, and never echoes a slash command it cannot run
        // here, such as /chrome, which it answers with a reply of its own. So once it takes the prompt without its echo,
        // the prompt is recorded from what was sent.
        this.recordUnechoed.set(origin.uuid, () => {
          this.addMessage(id, { id: origin.messageId, role: 'user', text: nativeText, createdAt: origin.createdAt, commandId: origin.commandId, ...(origin.attachments ? { attachments: origin.attachments } : {}) })
          if (!this.completedOrigins.has(origin.uuid)) { thread.status = 'running'; this.markTurn(id, 'running'); this.changed(id) }
          this.acknowledgements.get(origin.uuid)?.()
        })
        thread.status = 'running'; thread.lastTurn = { id: origin.uuid, status: 'running', messageId: origin.messageId }; this.changed(id)
        try {
          markSendStage(command.commandId, 'written')
          if (this.usageEnabled) this.usageGroups.set(id, { id: origin.uuid, startedAt: new Date().toISOString() })
          // Only this prompt's own note, or none: a send never carries an earlier request's note or news.
          const note = command.watcherRequestNote ?? command.watcherNews
          runtime.requestNote = runtime.watcher && note ? { note, text: nativeText } : undefined
          const delivery = runtime.protocol.write({ type: 'user', uuid: origin.uuid, session_id: alias.sessionId, parent_tool_use_id: null, message: { role: 'user', content } })
          this.emit(); await delivery
        }
        catch { forget(); return { accepted: false, uncertain: true } }
        if (!await acknowledged) return { accepted: false, uncertain: true }
        markSendStage(command.commandId, 'acknowledged')
        return { accepted: true }
      } finally { this.dispatching.delete(id) }
    }
    if (command.type === 'steer') return this.steerTurn(id, alias, thread, command, readForSend, watcherGuard)
    // Answering and interrupting start the session too, so a reaped thread behaves like a live one.
    let runtime: Runtime
    try { runtime = await this.start(id) }
    catch { throw new Error('Claude is not attached to this thread. Reconnect before continuing.') }
    if (command.type === 'answer') {
      const pending = runtime.requests.get(command.requestId)
      if (!pending) throw new Error('That request is no longer pending.')
      if (runtime.answerWrites.get(pending.id) === 'pending' || runtime.answered.has(pending.id) && runtime.answerWrites.get(pending.id) !== 'failed') return { accepted: false, uncertain: true }
      if (runtime.watcher) assertWatcherPermissionChoice(pending.request, command.permissionChoice)
      const answer = claudeAnswer(pending, command.answer, command.approved, command.questionAnswers, command.permissionChoice, command.skipped)
      // Only another explicit user answer retries uncertain delivery. Clearing the marker while
      // it is in flight keeps a concurrent answer from sending a second response.
      const retry = pending.request.delivery === 'uncertain' || pending.request.answerRetryReady === true
      delete pending.request.answerRetryReady
      delete pending.request.delivery
      this.changed(id)
      runtime.answerWrites.delete(pending.id)
      runtime.answered.add(pending.id)
      if (!alias.answeredRequestIds.includes(pending.id)) alias.answeredRequestIds.push(pending.id)
      try { await this.persist() } catch (error) {
        if (retry) { pending.request.delivery = 'uncertain'; this.changed(id); runtime.answerWrites.set(pending.id, 'failed') }
        else { alias.answeredRequestIds = alias.answeredRequestIds.filter(id => id !== pending.id); runtime.answered.delete(pending.id) }
        throw error
      }
      if (this.runtimes.get(id) !== runtime || !runtime.requests.has(pending.id)) return { accepted: false, uncertain: true }
      const settle = async (): Promise<void> => {
        runtime.answerWrites.delete(pending.id)
        runtime.answered.add(pending.id)
        if (this.runtimes.get(id) === runtime && runtime.requests.get(pending.id) === pending) {
          runtime.requests.delete(pending.id); thread.requests = thread.requests.filter(request => request.id !== pending.id); this.changed(id); this.emit()
        }
        if (pending.resumeDialog && answer.result === 'never') {
          alias.resumeCompactionDismissed = true
          for (const current of this.threads.values()) current.resumeCompactionDismissed = true
          this.threadChanges.markAll()
          await this.persist()
        }
      }
      const failed = (): void => {
        runtime.answerWrites.set(pending.id, 'failed')
        if (this.runtimes.get(id) === runtime && runtime.requests.get(pending.id) === pending) {
          pending.request.delivery = 'uncertain'; this.changed(id); this.emit()
        }
      }
      runtime.answerWrites.set(pending.id, 'pending')
      try { await this.reply(runtime, pending.id, answer) }
      catch (error) {
        pending.request.delivery = 'uncertain'; this.changed(id)
        if (error instanceof ClaudeWritePending) {
          const answerCompletion = error.completion.then(async () => { await settle(); return true }, () => { failed(); return false })
          this.trackClosure(answerCompletion.then(() => undefined, () => undefined))
          this.emit(); return { accepted: false, uncertain: true, answerCompletion }
        }
        failed(); return { accepted: false, uncertain: true }
      }
      await settle(); return { accepted: true }
    }
    if (command.type === 'interrupt') {
      if (!watcherGuard) await this.denyPending(id, runtime)
      watcherGuard?.()
      this.interrupting.add(id)
      const stopping = thread.lastTurn
      try {
        await runtime.protocol.control({ subtype: 'interrupt' }); this.interrupting.delete(id); this.clearMonitoring(id)
        // A steer Claude Code still holds runs next, so the thread goes on to it, or has already; the stop names the turn it stopped.
        const next = thread.lastTurn?.id !== stopping?.id || [...this.steers.values()].some(steer => steer.threadId === id && !steer.unconfirmed)
        if (!next) { thread.status = 'idle'; thread.lastTurn = { id: thread.lastTurn?.id ?? command.commandId, status: 'interrupted', ...(stopping?.messageId ? { messageId: stopping.messageId } : {}) } }
        this.markTurn(id, 'interrupted', stopping && alias.origins.find(origin => origin.uuid === stopping.id)?.messageId)
        this.changed(id); this.emit(); return { accepted: true }
      }
      catch { this.interrupting.delete(id); return { accepted: false, uncertain: true } }
    }
    throw new Error('Unsupported Claude command.')
  }
  /**
   * A settings change reaches a running CLI over its control channel, so the session, its transcript and any
   * background work carry on. Only what the CLI answers success to is saved and shown. A CLI that refuses a
   * request, or no CLI running, falls back to starting the CLI again with the new settings, which is the one
   * path that waits for background work. Accepted means the CLI confirmed the change or the restart finished.
   */
  private async configure(id: string, command: ConfigureCommand, watcherGuard?: () => void): Promise<AgentHostResult> {
    const alias = this.aliases[id]!, thread = this.threads.get(id)!
    validateThreadOptions(this.state, command, alias.modelId)
    if (this.configuring.has(id)) throw new Error('Wait for this thread’s settings change to finish.')
    if (this.dispatching.has(id) || thread.status === 'running' || thread.requests.length) throw new Error('Wait for this Claude turn to finish before changing settings.')
    const before = settingsOf(alias, this.state.models)
    const modelId = command.modelId ?? before.modelId
    const after: ClaudeSettings = { modelId, reasoningEffort: effortAfterChange(this.state, command, before.reasoningEffort),
      runtimeMode: command.runtimeMode ?? before.runtimeMode, fastMode: fastModeRuns(this.state, modelId, command.fastMode ?? alias.fastMode) }
    watcherGuard?.()
    this.dispatching.add(id); this.configuring.add(id)
    if (watcherGuard) this.configurationGuards.set(id, () => { watcherGuard(); this.configurationLaunches.add(id) })
    try {
      // A CLI still starting is the one the change should reach, once it has.
      const runtime = this.starting.has(id) ? await this.starting.get(id)!.catch(() => undefined) : this.runtimes.get(id)
      // Role agents keep the permission they launched with, so a thread narrowing below it starts its CLI again (#1042).
      const steps = runtime && this.runtimes.get(id) === runtime && !(runtime.subagentMode && narrowerMode(after.runtimeMode, runtime.subagentMode))
        ? settingsSteps(before, after, this.ultracodeAt(after.modelId)) : undefined
      if (runtime && steps) {
        const live = await this.applySteps(runtime, before, after, steps, watcherGuard)
        if (live.outcome === 'applied') return await this.settleSettings(id, command, after)
        if (live.outcome === 'uncertain') return await this.unconfirmedSettings(id, runtime, command, after, SETTINGS_UNCONFIRMED)
        this.options.logEvent?.('claude-settings-live-rejected')
        // A CLI that will not turn fast mode on is the account or organisation saying no (ADR-0143). A restart with the
        // flag would only hide that, so the refusal stands as it does under background work, and the warm CLI is kept.
        const fastRefused = live.stopped === 'fastMode'
        // A model change that carried the kept choice onto a model with fast mode, refused only that last step, goes
        // through: the thread is on the new model at normal speed, and its choice is off, as after a refused toggle.
        if (fastRefused && after.fastMode && command.fastMode === undefined && command.runtimeMode === undefined) {
          return await this.settleSettings(id, { ...command, fastMode: false }, live.reached)
        }
        // A restart would end the background work, so the refusal below stands. Whatever the CLI already took
        // is put back first, because the refusal says nothing was changed. When the CLI will not take it back
        // either, that is no longer true, and the CLI is stopped as it is for a lost answer.
        if ((fastRefused || thread.backgroundWork?.length) && !sameSettings(live.reached, before)) {
          const back = await this.applySteps(runtime, live.reached, before, settingsSteps(live.reached, before, this.ultracodeAt(before.modelId))!)
          if (back.outcome !== 'applied') {
            return await this.unconfirmedSettings(id, runtime, command, after, back.outcome === 'rejected' ? SETTINGS_PART_TAKEN : SETTINGS_UNCONFIRMED)
          }
        }
        if (fastRefused) return { accepted: false }
      }
      return await this.restartWithSettings(id, command, after, watcherGuard)
    } finally { this.dispatching.delete(id); this.configuring.delete(id); this.configurationGuards.delete(id); this.configurationLaunches.delete(id) }
  }
  /**
   * Send each step in turn and stop at the first the CLI does not confirm; `reached` is what it confirmed and `stopped`
   * the setting it did not.
   */
  private async applySteps(runtime: Runtime, from: ClaudeSettings, to: ClaudeSettings, steps: readonly ClaudeSettingsStep[], watcherGuard?: () => void): Promise<{ outcome: 'applied' | 'rejected' | 'uncertain'; reached: ClaudeSettings; stopped?: keyof ClaudeSettings }> {
    let reached = from
    for (const step of steps) {
      watcherGuard?.()
      try { await runtime.protocol.control(step.request) }
      catch (error) { return { outcome: error instanceof ClaudeRejected ? 'rejected' : 'uncertain', reached, stopped: step.field } }
      reached = { ...reached, [step.field]: to[step.field] }
      if (step.ultracodeEffort !== undefined) runtime.ultracodeEffort = step.ultracodeEffort ?? undefined
    }
    return { outcome: 'applied', reached }
  }
  /** The level Ultracode runs at on this model, as this machine's setting asks and the model offers (ADR-0148). */
  private ultracodeAt(modelId: string): UltracodeEffort | undefined {
    return ultracodeRunsAt(resolveModel(this.state.models, modelId)?.reasoningEfforts ?? [], this.options.ultracodeEffort?.() ?? DEFAULT_ULTRACODE_EFFORT)
  }
  /**
   * Before each prompt on a thread at Ultracode, a steer included, the CLI is brought to the level this machine's setting now asks for
   * (ADR-0148): the setting may have changed since the CLI started or last changed level, and Claude Code keeps its
   * session's level until told. Ultracode itself stays on, so a CLI that does not confirm the change still runs the
   * thread's workflow at the level it had, and the prompt goes ahead; the log says so by name.
   */
  private async applyUltracodeEffort(runtime: Runtime, alias: Alias): Promise<void> {
    if (alias.reasoningEffort !== ULTRACODE) return
    const at = this.ultracodeAt(alias.modelId)
    if (!at || runtime.ultracodeEffort === at) return
    try {
      await runtime.protocol.control({ subtype: 'apply_flag_settings', settings: { effortLevel: at, ultracode: true } })
      runtime.ultracodeEffort = at
    } catch { this.options.logEvent?.('claude-ultracode-effort-unconfirmed') }
  }
  /** Make these the settings the alias records; a thread saved without a mode keeps none until one is chosen. */
  private recordSettings(alias: Alias, command: ConfigureCommand, settings: ClaudeSettings): void {
    alias.modelId = settings.modelId; alias.reasoningEffort = settings.reasoningEffort
    if (command.runtimeMode) alias.runtimeMode = settings.runtimeMode
    // The choice, not what runs: a model without fast mode keeps it for the next model that has it.
    if (command.fastMode === true) alias.fastMode = true
    else if (command.fastMode === false) delete alias.fastMode
  }
  private showSettings(id: string): void {
    const alias = this.aliases[id]!, shown = settingsOf(alias, this.state.models), thread = this.threads.get(id)!
    thread.modelId = shown.modelId; thread.reasoningEffort = shown.reasoningEffort; thread.runtimeMode = shown.runtimeMode
    if (alias.fastMode) thread.fastMode = true
    else delete thread.fastMode
    this.changed(id)
  }
  /** The running CLI confirmed every step: save, show and hand back the snapshot that says so. */
  private async settleSettings(id: string, command: ConfigureCommand, settings: ClaudeSettings): Promise<AgentHostResult> {
    this.recordSettings(this.aliases[id]!, command, settings)
    let saved = true
    try { await this.persist() } catch { saved = false }
    this.showSettings(id); this.emit()
    this.options.logEvent?.('claude-settings-applied-live')
    // The CLI runs these whether or not the write landed, and the next write carries them. An unsaved change
    // is not confirmed: the coordinator reconciles it from the thread, which shows what the CLI runs.
    return saved ? { accepted: true, snapshot: this.view(command.historyFromEvents) } : { accepted: false, uncertain: true }
  }
  /**
   * The CLI may be running either set of settings, so it is stopped: nothing runs on settings the thread does
   * not show. The change becomes the one the next launch carries, and the thread shows it from that launch,
   * which is when the coordinator's saved intent reconciles. Until then the thread shows what it had.
   * Stopping ends any background work the CLI was still running. The thread shows that as it shows a CLI that
   * exited under running work, and the result carries an error naming what stopped, which `reason` begins.
   */
  private async unconfirmedSettings(id: string, runtime: Runtime, command: ConfigureCommand, settings: ClaudeSettings, reason: string): Promise<AgentHostResult> {
    this.options.logEvent?.('claude-settings-unconfirmed')
    // Recorded before the CLI is let go, so a start that comes in while it closes launches with the change.
    this.recordSettings(this.aliases[id]!, command, settings)
    const ended = await this.stopRuntime(id, runtime)
    if (ended.length) { this.threads.get(id)!.status = 'error'; this.changed(id) }
    await this.persist().catch(() => undefined)
    this.emit()
    return ended.length ? { accepted: false, uncertain: true, error: workStopped(reason, ended) } : { accepted: false, uncertain: true }
  }
  /**
   * Start the CLI again with the new settings: the path when no CLI is running or the running one refused a
   * request. A restart ends the agents or commands the CLI is still running for this thread, so it waits for them.
   */
  private async restartWithSettings(id: string, command: ConfigureCommand, settings: ClaudeSettings, watcherGuard?: () => void): Promise<AgentHostResult> {
    const alias = this.aliases[id]!, thread = this.threads.get(id)!
    if (thread.backgroundWork?.length) throw new Error(backgroundWorkRunning(thread.backgroundWork, 'changing its settings'))
    const runtime = this.runtimes.get(id)
    // Recorded before the old CLI is let go. Once it leaves `runtimes`, anything that opens the thread (the
    // window watching it, a read) starts a CLI once the old one has exited, and that CLI must launch with these
    // settings: the start below joins it rather than launching another, and accepted has to mean the CLI runs them.
    watcherGuard?.()
    const before = { modelId: alias.modelId, reasoningEffort: alias.reasoningEffort, runtimeMode: alias.runtimeMode, fastMode: alias.fastMode }
    try {
      this.recordSettings(alias, command, settings)
      if (runtime) await this.stopRuntime(id, runtime)
      await this.persist(); this.showSettings(id)
      await this.start(id); this.emit()
    } catch (error) {
      if (watcherGuard && !this.configurationLaunches.has(id)) {
        Object.assign(alias, before); await this.persist(); this.showSettings(id); this.emit()
      }
      throw error
    }
    this.options.logEvent?.('claude-settings-applied-restart')
    return { accepted: true, snapshot: this.view(command.historyFromEvents) }
  }
  async pollSessionLogs(): Promise<void> {
    if (this.queuedPoll) return this.queuedPoll
    const previous = this.polling
    // Arrivals during one read share the next read. Each caller finishes after its
    // own pass, even if the timer queues another pass while that one is running.
    const work = previous ? previous.catch(() => undefined).then(() => {
      if (this.queuedPoll === work) this.queuedPoll = undefined
      return this.readSessionLogs()
    }) : this.readSessionLogs()
    this.polling = work
    if (previous) this.queuedPoll = work
    try { await work } finally {
      if (this.polling === work) this.polling = undefined
      if (this.queuedPoll === work) this.queuedPoll = undefined
    }
  }
  private async readSessionLogs(): Promise<void> { for (const [id, log] of this.logs) { await this.readLog(id, log); await this.readSubagentModels(id, log) } }
  /**
   * Read the rest of a thread's transcript. A replay ends once a read has run to the end of the file: not when the
   * read found no transcript yet or failed partway, since the next read still starts from where this one stopped,
   * and not when a later connect has put a note of its own in place of the one this read began with.
   */
  private async readLog(id: string, log = this.log(id)): Promise<void> {
    // A rejected process cannot smuggle turn frames back through its native transcript.
    const replay = this.replays.get(id)
    await log.poll()
    if (!replay?.reading || this.replays.get(id) !== replay || log.cursor() === undefined) return
    replay.reading = false; replay.seen.clear(); delete replay.words
  }
  /**
   * A subagent's model from its own transcript, for the workflow and background agents the stream never
   * named one for. Read on the transcript's cadence, bounded per thread, and only until each row has one.
   */
  private async readSubagentModels(id: string, log: ClaudeSessionLog): Promise<void> {
    const projector = this.activity.get(id)
    const targets = projector?.modelTargets()
    if (!projector || !targets?.length) return
    const folder = await log.sessionFolder(); if (!folder) return
    let reader = this.subagentModels.get(id)
    if (!reader) { reader = new ClaudeSubagentModels(); this.subagentModels.set(id, reader) }
    const models = await reader.read(folder, targets)
    // A reconnect or a changed session replaced the projector while the files were read; its rows are not these.
    if (!models.size || this.activity.get(id) !== projector) return
    const thread = this.ensureActivityHistory(id)
    if (!thread) return
    const before = thread.activities ?? []
    let rows = before
    for (const [agent, model] of models) rows = projector.applyModel(rows, agent, model)
    if (rows !== before) { thread.activities = rows; this.changed(id); this.emit() }
  }
  /** Messages the workspace still holds; a thread whose history is handed back may resume its cursor. */
  restoreThreadHistory(threads: readonly RestoredThreadHistory[]): Promise<void> {
    for (const thread of threads) if (thread.messages.length) this.restoredHistory.set(thread.threadId, thread)
    return Promise.resolve()
  }
  disconnect(): void {
    this.generation++; clearInterval(this.pollTimer); this.pollTimer = undefined; this.state.connected = false
    for (const id of this.threads.keys()) this.clearMonitoring(id)
    this.reaper.dispose()
    this.flushCursors()
    // Every thread's monitoring, open session and running thinking go with the connection.
    this.threadChanges.markAll()
    for (const [id, runtime] of this.runtimes) {
      this.thinkingEnded(id)
      const closure = this.denyPending(id, runtime).catch(() => undefined).then(() => { runtime.protocol.stop(); return runtime.protocol.closed })
      this.trackClosure(closure)
      const thread = this.threads.get(id); if (thread) delete thread.providerSessionOpen
    }
    for (const id of [...this.spares.keys()]) this.discardSpare(id)
    this.runtimes.clear(); this.starting.clear(); this.outdated.clear(); this.emit()
  }
  async closed(): Promise<void> { while (this.closures.size) await Promise.all(this.closures); await this.usage.flushed() }
  private async start(id: string): Promise<Runtime> {
    const generation = this.generation
    const profile = await this.watcherProfile(id)
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    if (this.aliases[id]?.kind === 'personal') throw new Error('That thread is unavailable.')
    this.reaper.touch(id)
    const pending = this.starting.get(id)
    if (pending) {
      const started = await pending
      this.checkProfileContinuation(id, generation)
      if (!profile || started.watcher) return started
      await this.stopRuntime(id, started)
      this.checkProfileContinuation(id, generation)
    }
    const runtime = this.runtimes.get(id)
    if (runtime) {
      if (!profile || runtime.watcher) return runtime
      await this.stopRuntime(id, runtime)
      this.checkProfileContinuation(id, generation)
    }
    this.checkProfileContinuation(id, generation)
    const work = this.launch(id); this.starting.set(id, work)
    try {
      const started = await work; this.messageLog.pin(id)
      const thread = this.threads.get(id)
      if (thread && this.runtimes.get(id) === started && !thread.providerSessionOpen) { thread.providerSessionOpen = true; this.changed(id); this.emit() }
      return started
    } finally { if (this.starting.get(id) === work) this.starting.delete(id); this.scheduleOutdatedStop() }
  }
  private async launch(id: string): Promise<Runtime> {
    const generation = this.generation
    // A CLI Sotto let go may still be exiting, and this one resumes the same session, so it waits.
    await this.closing.get(id)
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    const alias = this.aliases[id]!
    if (alias.rollbackPending) throw new Error('Claude rollback is unconfirmed; reconnect to reconcile its native history.')
    const resume = await this.log(id).exists()
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    if (!resume && alias.origins.length) throw new Error('Claude native history is unavailable. Restore its session before continuing; Sotto will not recreate or resend an uncertain turn.')
    if (resume) {
      // A session file means a spare's session may be this one already, so the spare exits before the thread resumes it.
      await this.discardSpare(id)
      if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    }
    const adopted = resume ? undefined : await this.adoptSpare(id, alias)
    if (adopted) return adopted
    if (!resume) {
      // A spare on this session that was let go while this start passed the wait above is exiting now; it is waited for too.
      await this.closing.get(id)
      if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    }
    const { runtime, initialized } = await this.spawn(id, alias, resume)
    this.settleStart(id, runtime, alias, initialized)
    return runtime
  }
  /**
   * Start a CLI for this session and answer its `initialize`. A thread's own CLI is its runtime from the moment it
   * starts, so what it says while starting is applied as it comes. A spare's is held, with what it said, until the
   * thread's first send adopts it (`adoptSpare`); until then it is nobody's, and its exit only lets it go.
   */
  private async spawn(id: string, alias: Pick<Alias, 'sessionId' | 'cwd' | 'modelId' | 'reasoningEffort' | 'runtimeMode' | 'fastMode'>, resume: boolean, spare?: Spare): Promise<{ runtime: Runtime; initialized: ClaudeFrame }> {
    const generation = this.generation
    const profile = await this.watcherProfile(id, alias.modelId)
    this.checkProfileContinuation(id, generation)
    const browser = profile ? undefined : await this.browserTools?.mcpServer(id)
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    // Each of Sotto's scoped servers that answers for this thread: the host setup tools while its setup runs, and the
    // visual tool while visuals are on.
    const scoped = await scopedThreadServers(profile ? watcherThreadTools(this.threadTools) : this.threadTools, id)
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    if (spare) spare.scopedTools = scopedNames(scoped)
    const servers = [...(profile ? [{ server: profile.server, definitions: profile.toolNames.map(name => ({ name })) }] : []), ...(browser ? [{ server: browser, definitions: this.browserTools?.definitions ?? [] }] : []),
      ...scoped.map(({ server, tools }) => ({ server, definitions: tools.definitions }))]
    // The longest wait any offered server needs: a host setup check can wait 5 minutes, a browser action 6.
    const toolTimeoutMs = Math.max(0, ...(browser ? [360_000] : []), ...scoped.map(({ tools }) => tools.timeoutMs ?? 0))
    const mcpConfig = servers.length ? join(this.options.userDataPath, `claude-mcp-${randomUUID()}.json`) : undefined
    if (mcpConfig) {
      try {
        await writeFile(mcpConfig, JSON.stringify({ mcpServers: Object.fromEntries(servers.map(({ server }) => [server.name, {
          type: server.type, url: server.url, headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])),
        }])) }), { mode: 0o600, flag: 'wx' })
      } catch (error) { await this.removeConfig(mcpConfig); throw error }
    }
    if (generation !== this.generation || spare?.exited) { if (mcpConfig) await this.removeConfig(mcpConfig); throw new Error('Claude connection was cancelled.') }
    const toolArguments = mcpConfig ? ['--mcp-config', mcpConfig, ...toolAllowance(servers)] : []
    // The worker roles (#1042), read once for this launch: one agent per role on Claude, each held to the thread's own
    // permission, and the table in the instructions. Watcher starts its workers through its own tools instead.
    const roles = profile ? undefined : this.subagentRoles(alias.runtimeMode ?? 'approval-required', scoped.some(({ tools }) => tools.name === DELEGATE_MCP_SERVER))
    const effort = nativeEffort(alias.reasoningEffort, this.ultracodeAt(alias.modelId))
    const args = [...(this.options.args ?? []), ...toolArguments, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages', ...permissionArguments(alias.runtimeMode),
      '--append-system-prompt', profile ? `${CLAUDE_QUESTIONS}\n\n${profile.instructions ?? WATCHER_SYSTEM_PROMPT}` : roles?.instructions ? `${CLAUDE_QUESTIONS}\n\n${roles.instructions}` : CLAUDE_QUESTIONS,
      resume ? '--resume' : '--session-id', alias.sessionId, '--model', alias.modelId, ...(effort.effortLevel ? ['--effort', effort.effortLevel] : []),
      ...flagSettingsArguments(fastModeRuns(this.state, alias.modelId, alias.fastMode), effort.ultracode)]
    let runtime: Runtime
    try {
      this.configurationGuards.get(id)?.()
      runtime = { requests: new Map(), answered: new Set(), answerWrites: new Map(), clientRevision: this.clientRevision, watcher: !!profile, subagentMode: roles?.subagents?.widest,
        ...(effort.ultracode && effort.effortLevel ? { ultracodeEffort: effort.effortLevel as UltracodeEffort } : {}), protocol: new ClaudeProtocol(this.executable, args, alias.cwd, { ...this.client.environment(), ...PROSE_STAYS_TEXT, ...(toolTimeoutMs ? { MCP_TOOL_TIMEOUT: String(toolTimeoutMs) } : {}) }, this.options.requestTimeoutMs ?? 15000,
      frame => {
        if (this.runtimes.get(id) === runtime) this.frame(id, frame)
        // A spare keeps a bounded handful of frames for the send that adopts it; one that says more is let go.
        else if (spare?.runtime === runtime && this.spares.get(id) === spare && spare.frames.push(frame) > SPARE_FRAMES) this.discardSpare(id)
      }, () => {
        const ownedSpare = spare?.runtime === runtime && this.spares.get(id) === spare
        if (spare?.runtime === runtime) { spare.exited = true; if (ownedSpare) this.spares.delete(id) }
        if (this.runtimes.get(id) !== runtime) return
        // Each thread has its own CLI, so one ending is this thread's failure, not the provider's: the others
        // keep running, and this one starts again from its native session on its next action.
        const thread = this.threads.get(id)!; const saved = this.aliases[id]; const running = thread.status === 'running'; const turn = running ? thread.lastTurn : undefined
        // Work still going in the background is lost with the session too, so the thread asks for attention.
        const cut = running || !!thread.monitoring?.length || !!thread.backgroundWork?.length
        this.clearMonitoring(id)
        this.thinkingEnded(id)
        this.runtimes.delete(id); this.selfTurns.delete(id); this.queries.delete(id); this.interrupting.delete(id); this.toolsRunning.delete(id); this.reaper.forget(id); this.messageLog.dropEmpty(id); this.messageLog.release(id); this.streaming.delete(id); this.flushCursors(); thread.requests = []
        delete thread.providerSessionOpen
        this.compacting.delete(id)
        if (saved?.compaction?.status === 'running') {
          saved.compaction = { ...saved.compaction, status: 'uncertain', error: 'Native compaction was interrupted when Claude Code stopped. Its result is read from the native session; it will not be retried.' }
          thread.compaction = saved.compaction; this.trackClosure(this.persist().catch(() => undefined))
        }
        if (cut) thread.status = 'error'
        this.dropSteers(id)
        if (turn?.status === 'running') {
          thread.lastTurn = { ...turn, status: 'failed' }; this.completedOrigins.add(turn.id)
          // A prompt still waiting for its echo was not confirmed, so its send reports uncertain now rather than at the deadline.
          this.acknowledgements.get(turn.id)?.(false)
          this.markTurn(id, 'failed', saved?.origins.find(origin => origin.uuid === turn.id)?.messageId, SESSION_ENDED)
        }
        this.changed(id)
        this.emit()
      }) } } catch (error) { if (mcpConfig) await this.removeConfig(mcpConfig); throw error }
    if (spare) spare.runtime = runtime; else this.runtimes.set(id, runtime)
    this.trackClosure(runtime.protocol.closed.then(async () => { if (mcpConfig) await this.removeConfig(mcpConfig) }))
    let initialized: ClaudeFrame
    try { initialized = await runtime.protocol.control({ subtype: 'initialize', hooks: profile ? { UserPromptSubmit: [{ hookCallbackIds: [WATCHER_REQUEST_HOOK] }] } : {},
      sdkMcpServers: [], promptSuggestions: false, supportedDialogKinds: ['resume_return'], ...(roles?.subagents ? { agents: roles.subagents.agents } : {}) }) }
    // A spare is not the thread's CLI, so it is stopped as one: only a thread on its session ID waits for its exit.
    catch (error) {
      void (spare ? this.stopSpare(id, spare, runtime) : this.stopRuntime(id, runtime))
      throw error
    }
    if (generation !== this.generation) { await (spare ? this.stopSpare(id, spare, runtime) : this.stopRuntime(id, runtime)); throw new Error('Claude connection was cancelled.') }
    this.initializedRuntimes.add(runtime)
    return { runtime, initialized }
  }
  /**
   * What a thread takes from its CLI's answer to `initialize`, once that CLI is the thread's. A start that fails here
   * stops the CLI it was settling, as a failed `initialize` does, so no half-started CLI stays the thread's.
   */
  private settleStart(id: string, runtime: Runtime, alias: Alias, initialized: ClaudeFrame): void {
    try {
      this.threads.get(id)!.manualCompactionSupported = Array.isArray(initialized.commands) && initialized.commands.some(command => object(command)?.name === 'compact')
      this.changed(id)
      for (const pending of Array.isArray(initialized.pending_user_dialog_requests) ? initialized.pending_user_dialog_requests : []) {
        if (object(pending)) this.frame(id, pending as ClaudeFrame)
      }
      // A change left unconfirmed is shown from the launch that carries it (see `unconfirmedSettings`).
      const thread = this.threads.get(id)!
      if (!sameSettings(settingsOf(thread, this.state.models), settingsOf(alias, this.state.models)) || (thread.fastMode === true) !== (alias.fastMode === true)) { this.showSettings(id); this.emit() }
    } catch (error) { void this.stopRuntime(id, runtime); throw error }
  }
  /**
   * Early start (#769). A thread Claude Code already has starts its CLI the way its next action would, which the
   * reaper counts as activity. A thread whose first send has not happened gets a spare: the CLI that send would
   * start, on the session ID it will be created with and in the folder it will run in, started and answered
   * `initialize` and nothing more. Claude Code writes no session file until a prompt arrives (checked against 2.1.289),
   * so a spare that is never used leaves nothing behind; the reaper stops it once idle, as it would a session.
   */
  async startThreadSession(id: string, draft?: ThreadSessionDraft): Promise<void> {
    const generation = this.generation
    await this.watcherProfile(id, draft?.modelId)
    this.checkProfileContinuation(id, generation)
    if (!this.state.connected) return
    if (this.aliases[id]) { await this.start(id); return }
    // A spare runs in the thread's folder, so a thread whose worktree its first send makes gets none.
    if (!draft?.workingDirectory || this.spares.has(id) || !this.state.models.some(model => model.id === draft.modelId && model.ready)) return
    const cwd = await existingWorkingDirectory(draft.workingDirectory)
    if (generation !== this.generation || this.aliases[id] || this.spares.has(id)) return
    const settings = settingsOf(draft, this.state.models)
    const spare: Spare = { sessionId: randomUUID(), cwd, settings, frames: [], scopedTools: '', exited: false }
    this.spares.set(id, spare)
    this.reaper.touch(id)
    spare.ready = this.spawn(id, { sessionId: spare.sessionId, cwd, ...settings }, false, spare)
    try { await spare.ready } catch (error) {
      if (this.spares.get(id) === spare) this.spares.delete(id)
      if (error instanceof WatcherProfileRefusal) throw error
    }
  }
  /** The spare a thread's first send may run on, when it was started for exactly what that send creates. */
  private spareFor(id: string, cwd: string, settings: ClaudeSettings): Spare | undefined {
    const spare = this.spares.get(id)
    return spare && spareFits(spare, cwd, settings) ? spare : undefined
  }
  /**
   * Make a spare this thread's CLI, as if the start had launched it now: what it said while it waited is applied,
   * then its answer to `initialize`. One that no longer fits (it ended, it runs a client an update replaced, the
   * thread was created with other settings, or it now needs the host setup tools) is stopped instead, and the thread
   * starts a CLI of its own the usual way.
   */
  private async adoptSpare(id: string, alias: Alias): Promise<Runtime | undefined> {
    const generation = this.generation
    const profile = await this.watcherProfile(id, alias.modelId)
    this.checkProfileContinuation(id, generation)
    const spare = this.spares.get(id)
    if (!spare) return undefined
    // It stays the spare while it finishes starting, so what it says meanwhile is kept for this thread too.
    const started = await spare.ready?.catch(() => undefined)
    if (this.spares.get(id) !== spare) return undefined
    this.spares.delete(id)
    if (!started) return undefined
    let scoped: string
    // A tool server closed meanwhile, as Sotto quitting closes them, throws; the spare, in neither map now, is stopped first.
    try { scoped = scopedNames(await scopedThreadServers(profile ? watcherThreadTools(this.threadTools) : this.threadTools, id)) }
    catch (error) { await this.stopSpare(id, spare, started.runtime); throw error }
    // It is in neither map now, so a disconnect meanwhile did not stop it; this does, and the start then reports the cancel.
    if (generation !== this.generation) { await this.stopSpare(id, spare, started.runtime); return undefined }
    // Checked again: a client update, or one of Sotto's scoped servers coming or going for the thread, can make a spare unfit after creation chose it.
    if (started.runtime.watcher !== !!profile || spare.sessionId !== alias.sessionId || !spareFits(spare, alias.cwd, settingsOf(alias, this.state.models)) || scoped !== spare.scopedTools
      || started.runtime.clientRevision !== this.clientRevision || this.runtimes.has(id)) {
      await this.stopSpare(id, spare, started.runtime)
      return undefined
    }
    this.runtimes.set(id, started.runtime)
    for (const frame of spare.frames) if (this.runtimes.get(id) === started.runtime) this.frame(id, frame)
    if (this.runtimes.get(id) !== started.runtime) return undefined
    this.settleStart(id, started.runtime, alias, started.initialized)
    return started.runtime
  }
  /** Let a spare go; its CLI is stopped once it has started. Resolves when `stopSpare` has nothing left to wait for. */
  private discardSpare(id: string): Promise<void> {
    const spare = this.spares.get(id)
    if (!spare) return Promise.resolve()
    this.spares.delete(id)
    const stopped = (spare.ready ?? Promise.resolve(undefined)).catch(() => undefined).then(started => started ? this.stopSpare(id, spare, started.runtime) : undefined)
    this.trackClosure(stopped)
    // A thread already created on the spare's session ID waits from now, not only once the spare has finished starting,
    // so its own start cannot run before `stopSpare` has its exit to wait for.
    if (this.aliases[id]?.sessionId === spare.sessionId) {
      this.closing.set(id, stopped)
      const release = () => { if (this.closing.get(id) === stopped) this.closing.delete(id) }
      void stopped.then(release, release)
    }
    return stopped
  }
  /**
   * Stop a spare's CLI. Only a thread whose own CLI will run on the spare's session ID waits for it to exit, since one
   * session never has two CLIs; a spare on a session ID of its own holds up nothing, so a send that did not adopt it
   * starts its CLI without waiting the half second an exit can take.
   */
  private async stopSpare(id: string, spare: Spare, runtime: Runtime): Promise<void> {
    runtime.protocol.stop()
    const closed = runtime.protocol.closed
    if (this.aliases[id]?.sessionId !== spare.sessionId) { this.trackClosure(closed); return }
    this.closing.set(id, closed)
    try { await closed } finally { if (this.closing.get(id) === closed) this.closing.delete(id) }
  }
  private async removeConfig(path: string): Promise<void> {
    // Node applies maxRetries only to recursive removal. These are individual files, so
    // retry transient Windows locks here without allowing recursive removal.
    for (let attempt = 0; ; attempt++) {
      try { await rm(path, { force: true, maxRetries: 3 }); return }
      catch (error) {
        if (attempt < 3 && ['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { await delay(100 * (attempt + 1)); continue }
        this.options.logEvent?.('claude-mcp-config-cleanup-failed'); return
      }
    }
  }
  private async removeLeftoverConfigs(): Promise<void> {
    let names: string[]
    try { names = await readdir(this.options.userDataPath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.logEvent?.('claude-mcp-config-cleanup-failed')
      return
    }
    await Promise.all(names.filter(name => /^claude-mcp-.*\.json$/.test(name)).map(name => this.removeConfig(join(this.options.userDataPath, name))))
  }
  private frame(id: string, frame: ClaudeFrame): void {
    const currentRuntime = this.runtimes.get(id)
    if (currentRuntime && frame.type === 'control_cancel_request' && typeof frame.request_id === 'string') {
      this.checkingProfileRequests.get(currentRuntime)?.delete(frame.request_id)
    }
    if (currentRuntime?.watcher && frame.type === 'control_request') {
      const runtime = currentRuntime
      const requestId = typeof frame.request_id === 'string' ? frame.request_id : undefined
      let checking = runtime ? this.checkingProfileRequests.get(runtime) : undefined
      if (runtime && !checking) { checking = new Set(); this.checkingProfileRequests.set(runtime, checking) }
      if (requestId) checking?.add(requestId)
      if (!runtime) return
      void this.guardWatcherRequest(id, frame, runtime).then(allowed => {
        const pending = !requestId || checking?.delete(requestId)
        if (allowed && pending && runtime && this.runtimes.get(id) === runtime) this.frameAfterProfileCheck(id, frame)
      }).catch(() => {
        if (requestId) checking?.delete(requestId)
        // A prompt waits on its hook's answer: one Sotto no longer vouches for still gets one, without the note.
        if (requestId && object(frame.request)?.subtype === 'hook_callback') void this.reply(runtime, requestId, {}).catch(() => undefined)
      })
      return
    }
    this.frameAfterProfileCheck(id, frame)
  }
  /** Recheck identity before a request reaches the normal card path. Its own requests are allowed. */
  private async guardWatcherRequest(id: string, _frame: ClaudeFrame, runtime: Runtime): Promise<boolean> {
    const generation = this.generation
    await this.resolveWatcherProfile(id, generation, runtime)
    this.checkProfileContinuation(id, generation, runtime)
    return true
  }
  /** A live thread's control channel for get_usage: a current-client runtime that has answered initialize. Spares are not threads' CLIs. */
  private limitsControl(): ClaudeControl | undefined {
    for (const runtime of this.runtimes.values()) {
      if (runtime.clientRevision === this.clientRevision && this.initializedRuntimes.has(runtime)) return request => runtime.protocol.control(request)
    }
    return undefined
  }
  /**
   * A frame writes into its thread's record in many places, and may publish partway (a request, a sub-agent's step), so
   * the thread is marked before the frame is applied, for a publication it makes itself, and again after, for anything
   * written once that publication had gone.
   */
  private frameAfterProfileCheck(id: string, frame: ClaudeFrame): void {
    this.changed(id)
    try { this.applyFrame(id, frame) } finally { this.changed(id) }
  }
  private applyFrame(id: string, frame: ClaudeFrame): void {
    this.reaper.touch(id)
    const runtime = this.runtimes.get(id)!; const thread = this.threads.get(id)!; const alias = this.aliases[id]!
    if (typeof frame.session_id === 'string' && frame.session_id !== alias.sessionId) return
    if (this.usageEnabled && frame.type === 'rate_limit_event') {
      this.limits.observe(frame); return
    }
    let monitoring = this.monitoring.get(id)
    if (!monitoring) { monitoring = new ClaudeMonitoring(); this.monitoring.set(id, monitoring) }
    monitoring.apply(frame); thread.monitoring = monitoring.current
    const working = monitoring.working
    if (working.length) thread.backgroundWork = working; else delete thread.backgroundWork
    if (frame.type === 'system' && frame.subtype === 'init') {
      // A CLI still running a replaced client names the old version; the provider's is the one on disk.
      if (typeof frame.claude_code_version === 'string' && runtime.clientRevision === this.clientRevision) this.state.version = frame.claude_code_version
      this.checkApprovalSurface(frame)
      this.queries.add(id)
    }
    const hook = frame.type === 'control_request' ? object(frame.request) : undefined
    if (hook?.subtype === 'hook_callback' && typeof frame.request_id === 'string') {
      // Only a Watcher's CLI registers a hook, and its note goes once, as context for the prompt it was written with.
      const input = object(hook.input), pending = runtime.requestNote
      const note = runtime.watcher && pending && hook.callback_id === WATCHER_REQUEST_HOOK && input?.hook_event_name === 'UserPromptSubmit'
        && (typeof input.prompt !== 'string' || input.prompt.trim() === pending.text.trim()) ? pending.note : undefined
      if (note !== undefined) runtime.requestNote = undefined
      void this.reply(runtime, frame.request_id, note ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } } : {}).catch(() => undefined)
      return
    }
    if (frame.type === 'control_request') {
      if (typeof frame.request_id === 'string' && runtime.answered.has(frame.request_id)) return
      // A thread holding this many unanswered requests is a flood, and denying it is the defence. That is
      // a different thing from a request this adapter could not read, so it is not reported as one.
      const flooded = runtime.requests.size >= 256
      const pending = flooded ? undefined : claudePending(frame)
      if (pending) {
        if (alias.answeredRequestIds.includes(pending.id)) { pending.request.delivery = 'uncertain'; runtime.answered.add(pending.id) }
        runtime.requests.set(pending.id, pending); thread.requests = [...runtime.requests.values()].map(value => value.request); this.emit()
      }
      else if (typeof frame.request_id === 'string') {
        const requestId = frame.request_id
        let response: Promise<void>
        if (!flooded) this.report(unreadableRequest('Claude Code'))
        if (object(frame.request)?.subtype === 'can_use_tool') {
          // can_use_tool is the CLI asking for the user. Denying one Sotto could not read is the only safe
          // answer, and Claude reads that denial as the user's own, so the thread is told what happened.
          response = this.reply(runtime, requestId, claudeDenial())
        } else response = runtime.protocol.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Unsupported Claude control request.' } })
        void response.catch(() => undefined)
      }
      return
    }
    if (frame.type === 'control_cancel_request' && typeof frame.request_id === 'string') { runtime.requests.delete(frame.request_id); thread.requests = [...runtime.requests.values()].map(value => value.request) }
    // A waiting prompt is taken once Claude Code says its turn started, which it says as it takes the prompt. Its echo
    // comes only as the model's reply begins, and the first reply after a restart can begin past the deadline (#1511).
    // Recorded now, the prompt sits above anything its turn says. One held behind Claude Code's own turn starts only once
    // that turn ends. A result naming a prompt is the last word, for a client that never said the prompt started.
    if (frame.type === 'command_lifecycle' && frame.state === 'started' && typeof frame.command_uuid === 'string') this.recordUnechoed.get(frame.command_uuid)?.()
    // Any word of a steer's place in Claude Code's own queue means it holds the steer.
    if (frame.type === 'command_lifecycle' && typeof frame.command_uuid === 'string' && this.steers.has(frame.command_uuid)) this.acknowledgements.get(frame.command_uuid)?.()
    if (frame.type === 'result' && !frame.parent_tool_use_id && typeof frame.user_message_uuid === 'string') this.recordUnechoed.get(frame.user_message_uuid)?.()
    // A result ends its turn, and the turn's own outcome is decided before its activity settles, so a block the turn
    // left open settles the way the turn ended. A turn the user stopped is no failure of Claude Code's, nor finished.
    const ending = frame.type === 'result' && !frame.parent_tool_use_id ? this.resultEnding(id, frame) : undefined
    this.projectActivity(id, frame, true, ending?.status)
    if (frame.parent_tool_use_id) { this.emit(true); return }
    this.trackTools(id, frame)
    this.observeCompaction(id, frame, false)
    if (frame.type === 'user' && authoredClaudeUser(frame)) {
      this.message(id, frame, false)
      const uuid = typeof frame.uuid === 'string' ? frame.uuid : ''
      if (alias.origins.some(origin => origin.uuid === uuid)) {
        // A steer read into the running turn is part of it. One held past that turn's end starts the next, as any prompt does.
        const steer = this.steers.get(uuid); this.steers.delete(uuid)
        const messageId = steer ? alias.origins.find(origin => origin.uuid === uuid)?.messageId : undefined
        if (steer && !steer.carried) this.foldedSteers.add(uuid)
        // Its turn is its own message's, though a later steer may already be shown.
        else if (!this.completedOrigins.has(uuid)) { thread.status = 'running'; if (steer) thread.lastTurn = { id: uuid, status: 'running', ...(messageId ? { messageId } : {}) }; this.markTurn(id, 'running', messageId) }
        this.acknowledgements.get(uuid)?.()
      }
    }
    // Claude Code answers some prompts it gives itself, such as a report once background work ends. It sends no
    // prompt for these, so the turn first shows as a query it opened and a model request made while the thread was
    // not running; Sotto's own prompts set the thread running before they go out, and a prompt held behind such a
    // turn keeps it running (see the result below). Its result ends the turn the way it ends one Sotto sent, and a
    // stop ends it without reading as a failure. A prompt sent while it runs is refused rather than queued behind it.
    if (frame.type === 'system' && frame.subtype === 'status' && frame.status === 'requesting' && this.queries.has(id) && thread.status !== 'running' && !compactionPending(alias.compaction)) {
      thread.status = 'running'
      if (typeof frame.uuid === 'string' && frame.uuid) { thread.lastTurn = { id: frame.uuid, status: 'running' }; this.selfTurns.set(id, frame.uuid) }
    }
    if (frame.type === 'assistant') {
      if (typeof frame.error === 'string' && !frame.parent_tool_use_id) this.assistantErrors.set(id, frame.error)
      this.message(id, frame, false)
    }
    if (frame.type === 'stream_event') {
      this.usage.claude(id, frame, thread.modelId, this.usageContext(id, frame, false)); thread.usage = this.usage.get(id)
      const event = object(frame.event)
      if (event?.type === 'message_start') {
        const message = object(event.message)
        if (typeof message?.id === 'string') {
          this.streaming.set(id, message.id)
          const turnMessageId = !this.nativeTakeovers.has(id) && thread.lastTurn?.status === 'running' ? thread.lastTurn.messageId : undefined
          this.addMessage(id, { id: message.id, role: 'assistant', text: '', createdAt: new Date().toISOString(),
            ...(turnMessageId === undefined ? {} : { turnMessageId }) })
        }
      }
      const delta = object(event?.delta)
      if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        // A streamed reply grew by a suffix, which is what the record says about it.
        const last = this.messageLog.lastMessage(id)
        const streaming = this.streaming.get(id) ?? (last?.role === 'assistant' ? last.id : undefined)
        if (streaming !== undefined) this.messageLog.appendText(id, streaming, delta.text)
      }
    }
    if (frame.type === 'result') {
      this.compacting.delete(id)
      if (compactionPending(alias.compaction)) {
        alias.compaction = { commandId: alias.compaction!.commandId, ...idleMark(alias.compaction), status: frame.is_error === true ? 'failed' : 'uncertain',
          error: frame.is_error === true ? 'Claude native compaction failed.' : 'Claude finished without confirming a compaction boundary. The operation will not be retried.' }
        thread.compaction = alias.compaction
        void this.persist().catch(() => { this.state.error = 'The native compaction result could not be saved.'; this.emit() })
      }
      this.usage.claudeResult(id, frame)
      thread.usage = this.usage.get(id)
      this.messageLog.dropEmpty(id); this.streaming.delete(id)
      const { origin, stopped, steered, status } = ending!
      const selfTurn = origin !== undefined && this.selfTurns.get(id) === origin
      this.selfTurns.delete(id); this.queries.delete(id)
      this.interrupting.delete(id)
      const failure = frame.is_error === true && !stopped ? claudeTurnFailure(frame, this.assistantErrors.get(id)) : null
      const limitStop = failure !== null && this.options.limitStops === true ? claudeLimitStop(frame, this.assistantErrors.get(id)) : undefined
      if (origin) {
        this.completedOrigins.add(origin)
        const messageId = !selfTurn ? alias.origins.find(value => value.uuid === origin)?.messageId : undefined
        thread.lastTurn = { id: origin, status, ...(messageId ? { messageId } : {}), ...(limitStop && status === 'failed' ? { limitStop } : {}) }
        // A turn Claude Code gave itself answers no message of Sotto's. The newest message may be a steer whose own
        // turn has not begun, so it has no record to settle here.
        if (!selfTurn) this.markTurn(id, status, messageId, failure ?? undefined, steered)
      }
      this.assistantErrors.delete(id)
      // A prompt of Sotto's that Claude Code held behind its own turn starts next, so the thread goes straight on to it,
      // and so does a steer the turn ended before reading or was cut for.
      const steers = [...this.steers.values()].filter(steer => steer.threadId === id)
      for (const steer of steers) steer.carried = true
      const held = steers.some(steer => !steer.unconfirmed) || alias.origins.some(value => this.acknowledgements.has(value.uuid))
      thread.status = failure !== null ? 'error' : held ? 'running' : 'idle'
      // A cut for a steer drops only the step Claude was on, so background work goes on with the session.
      if (frame.is_error === true && !steered) this.clearMonitoring(id)
      if (failure !== null) { this.turnFailures.set(id, failure); this.state.error = failure }
      else if (frame.is_error !== true) this.clearTurnFailure(id)
    }
    this.emit(frame.type === 'stream_event' || frame.type === 'assistant'
      || frame.type === 'system' && ['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(String(frame.subtype)))
  }
  /**
   * A thread's next finished turn takes down the error its failed turn left, and nothing else the provider is saying.
   * Another thread's failure that is still standing takes its place.
   */
  private clearTurnFailure(id: string): void {
    const failure = this.turnFailures.get(id)
    if (failure === undefined) return
    this.turnFailures.delete(id)
    if (this.state.error === failure) this.state.error = [...this.turnFailures.values()].at(-1)
  }
  private clearMonitoring(id: string): void {
    this.monitoring.delete(id)
    const thread = this.threads.get(id)
    if (thread) { delete thread.monitoring; delete thread.backgroundWork; this.changed(id) }
  }
  /**
   * A sent prompt the transcript has not yet given back, found by the digest of the whole text Sotto delivered with its
   * notes. One map lookup per frame: the index follows the thread's origins, adding the ones pushed since it was last
   * read and rebuilt only when the list itself is replaced, so a frame's work does not grow with the thread's history.
   */
  private deliveredOrigin(id: string, digest: string): Alias['origins'][number] | undefined {
    return this.indexedOrigin(id, 'byDelivered', digest)
  }
  /**
   * An origin recorded before the delivered digest existed, with notes Sotto appended, found by its words' digest: how
   * such a prompt was read back before, kept for those origins alone. One map lookup, as for the delivered digest.
   */
  private legacyOrigin(id: string, digest: string): Alias['origins'][number] | undefined {
    return this.indexedOrigin(id, 'legacyByWords', digest)
  }
  /** A sent prompt the transcript has not yet given back, found by its words' digest, the first sent first. */
  private unreadOrigin(id: string, digest: string): Alias['origins'][number] | undefined {
    return this.indexedOrigin(id, 'byWords', digest)
  }
  private indexedOrigin(id: string, map: 'byDelivered' | 'byWords' | 'legacyByWords', digest: string): Alias['origins'][number] | undefined {
    const origins = this.aliases[id]?.origins
    if (!origins) return undefined
    let index = this.deliveredIndex.get(origins)
    if (!index) { index = { indexed: 0, byDelivered: new Map(), byWords: new Map(), legacyByWords: new Map() }; this.deliveredIndex.set(origins, index) }
    const add = (into: Map<string, Bucket>, key: string, origin: Alias['origins'][number]): void => {
      const bucket = into.get(key)
      if (bucket) bucket.origins.push(origin); else into.set(key, { origins: [origin], start: 0, consumed: undefined })
    }
    for (; index.indexed < origins.length; index.indexed++) {
      const origin = origins[index.indexed]!
      add(index.byWords, origin.digest, origin)
      if (origin.delivered) add(index.byDelivered, origin.delivered.digest, origin)
      else if (carriesAttachedFiles(origin.attachments)) add(index.legacyByWords, origin.digest, origin)
    }
    // Origins only ever leave a thread by the list being replaced, so every origin indexed for this list is still in it.
    const bucket = index[map].get(digest)
    return bucket ? firstUnread(bucket, this.logOrigins.get(id)) : undefined
  }
  /** Claude Code writes a slash command it ran itself into the transcript as a local command, not as a prompt. One
   * Sotto sent is read back as that prompt. Any other stays out of the record, as its reply does. */
  private asSentPrompt(id: string, frame: ClaudeFrame): ClaudeFrame {
    if (frame.type !== 'system' || frame.subtype !== 'local_command' || typeof frame.content !== 'string') return frame
    if (!this.unreadOrigin(id, claudeDigest(frame.content))) return frame
    return { type: 'user', uuid: frame.uuid, timestamp: frame.timestamp, message: { role: 'user', content: frame.content } }
  }
  private message(id: string, frame: ClaudeFrame, fromLog: boolean): void {
    if (typeof frame.uuid === 'string' && this.aliases[id]?.compactInputIds?.includes(frame.uuid)) return
    if (this.usageEnabled && frame.type === 'user' && authoredClaudeUser(frame) && typeof frame.uuid === 'string') {
      const at = typeof frame.timestamp === 'string' && Number.isFinite(Date.parse(frame.timestamp)) ? new Date(frame.timestamp).toISOString()
        : this.aliases[id]?.origins.find(origin => origin.uuid === frame.uuid)?.createdAt
          ?? (this.usageGroups.get(id)?.id === frame.uuid ? this.usageGroups.get(id)?.startedAt : undefined)
      this.usageGroups.set(id, { id: frame.uuid, startedAt: at })
    }
    this.usage.claude(id, frame, this.threads.get(id)!.modelId, this.usageContext(id, frame, fromLog))
    this.threads.get(id)!.usage = this.usage.get(id)
    this.changed(id)
    if (frame.parent_tool_use_id || frame.isSidechain === true) return
    const message = object(frame.message); let text = claudeText(message?.content)
    if ((!text && frame.type !== 'user') || !['user', 'assistant'].includes(String(frame.type))) return
    if (frame.type === 'user' && !authoredClaudeUser(frame)) return
    const alias = this.aliases[id]!; const uuid = typeof frame.uuid === 'string' ? frame.uuid : ''
    let origin = alias.origins.find(value => value.uuid === uuid)
    // A prompt's words without the notes Sotto appended, only when the origin it matches recorded an attached file or
    // a Point at something picture, and only the notes Sotto appended for that origin (ADR-0131, ADR-0154).
    if (frame.type === 'user') {
      const read = claudeReadBack(message?.content, origin, fromLog ? {
        delivered: digest => this.deliveredOrigin(id, digest), words: digest => this.unreadOrigin(id, digest), legacy: digest => this.legacyOrigin(id, digest),
      } : {})
      text = read.text; origin = read.origin
    }
    const digest = claudeDigest(text)
    if (fromLog && frame.type === 'user') {
      const consumed = this.logOrigins.get(id) ?? new Set<string>(); this.logOrigins.set(id, consumed)
      origin ??= this.unreadOrigin(id, digest)
      if (origin) { consumed.add(origin.uuid); this.lastLogDigest.set(id, digest) }
      else if (this.lastLogDigest.get(id) === digest) return
      else { this.lastLogDigest.delete(id); this.nativeTakeovers.add(id) }
    }
    const providerId = frame.type === 'assistant' && typeof message?.id === 'string' ? message.id : uuid || `native-${digest}`
    if (frame.type === 'assistant') {
      const blockKey = `${id}:${providerId}`; const blocks = this.assistantBlocks.get(blockKey) ?? new Map<string, string>()
      blocks.set(uuid || digest, text); this.assistantBlocks.set(blockKey, blocks); text = [...blocks.values()].join('\n')
    }
    // Only a live root reply proves its owner from the running turn. Replay may describe an older reply while another
    // turn runs; the message log retains its already-proved owner instead of assigning it to that newer turn.
    const turn = this.threads.get(id)!.lastTurn
    const turnMessageId = !fromLog && !this.nativeTakeovers.has(id) && frame.type === 'assistant' && turn?.status === 'running' ? turn.messageId : undefined
    this.addMessage(id, { id: origin?.messageId ?? alias.forkMessageIds?.[uuid] ?? providerId, role: frame.type as 'user' | 'assistant', text,
      ...(turnMessageId === undefined ? {} : { turnMessageId }),
      createdAt: origin?.createdAt ?? (typeof frame.timestamp === 'string' ? frame.timestamp : new Date().toISOString()), ...(origin ? { commandId: origin.commandId, ...(origin.attachments ? { attachments: origin.attachments } : {}) } : {}) })
  }
  private usageContext(id: string, frame: ClaudeFrame, replay: boolean): NativeUsageContext {
    const group = this.usageGroups.get(id)
    return { phase: replay ? 'replay' : 'live',
      ...(typeof frame.timestamp === 'string' && Number.isFinite(Date.parse(frame.timestamp)) ? { at: new Date(frame.timestamp).toISOString() } : {}),
      ...(group ? { groupId: group.id, ...(group.startedAt ? { groupStartedAt: group.startedAt } : {}) } : {}) }
  }
  private log(id: string): ClaudeSessionLog {
    let log = this.logs.get(id)
    if (!log) {
      const alias = this.aliases[id]!
      const generation = this.generation
      // One publish per read, not per entry: a connect reads the whole transcript, and a snapshot per line
      // is a snapshot clone and a workspace write per line, which ran the main process out of heap.
      const current = (): boolean => generation === this.generation && this.aliases[id]?.sessionId === alias.sessionId
      log = new ClaudeSessionLog(this.options.claudeHome ?? join(homedir(), '.claude'), alias.cwd, alias.sessionId, frame => {
        if (current()) { this.observeCompaction(id, frame, true); this.projectActivity(id, frame); this.message(id, this.asSentPrompt(id, frame), true); this.changed(id) }
      }, () => { if (current()) { this.noteCursor(id); this.emit() } })
      this.logs.set(id, log)
    }
    return log
  }
  /**
   * A stored cursor stands for both authored messages and activity classification behind it.
   * Missing activity evidence requires a full replay, even when message identities are available.
   */
  private seedHistory(id: string, alias: Alias, restored: RestoredThreadHistory | undefined): void {
    const cursor = alias.transcriptCursor
    const matching = restored?.historyEpoch === alias.historyEpoch ? restored : undefined
    const stored = matching?.messages.length ? matching.messages : this.history?.messageIdentities(id) ?? []
    // Without a usable cursor the transcript is read from its first byte. The log still learns which messages the
    // store holds, so that read recognises them instead of recording each one a second time: a restart before the
    // first read of a new turn's transcript had saved a cursor showed its prompt twice. Its records are still
    // placed by how far the read has got (`replays`), not by the newest stored message.
    const replayAll = (): void => {
      delete alias.transcriptCursor
      if (!stored.length) return
      this.messageLog.seed(id, stored)
      const words = new Map<string, string>()
      for (const message of stored) if ('text' in message && typeof message.text === 'string') words.set(message.id, message.text)
      this.replays.set(id, { reading: true, seen: new Set(), ...(words.size ? { words } : {}) })
    }
    if (!cursor || cursor.sessionId !== alias.sessionId) { replayAll(); return }
    // The store saying it holds this epoch's records is evidence enough to resume. They are read when something first
    // changes this thread's activity, rather than for every saved thread at connect (#918).
    const evidence = matching?.activities === undefined && this.history?.hasActivities?.(id, alias.historyEpoch) === true
    const activities = matching?.activities ?? (evidence ? undefined : this.history?.activities?.(id, alias.historyEpoch))
    if (!stored.length || activities === undefined && !evidence) { replayAll(); return }
    this.messageLog.seed(id, stored)
    if (activities) { this.threads.get(id)!.activities = structuredClone(activities.slice(-MAX_AGENT_ACTIVITIES)); this.changed(id) }
    else this.activityHistoryPending.add(id)
    // A later block of an assistant message already projected must add to its text, not replace it.
    for (const message of matching?.messages ?? []) if (message.role === 'assistant') this.assistantBlocks.set(`${id}:${message.id}`, new Map([['restored', message.text]]))
    this.logOrigins.set(id, new Set(cursor.consumedOriginIds))
    if (cursor.lastDigest) this.lastLogDigest.set(id, cursor.lastDigest)
    this.log(id).resume(cursor)
  }
  /** Record where this thread's transcript has been read to; the write itself waits for the cadence below. */
  private noteCursor(id: string): void {
    const alias = this.aliases[id]; const cursor = this.logs.get(id)?.cursor()
    if (!alias || !cursor) return
    const lastDigest = this.lastLogDigest.get(id)
    alias.transcriptCursor = { sessionId: alias.sessionId, offset: cursor.offset, size: cursor.size, ...(cursor.ino ? { ino: cursor.ino } : {}),
      ...(cursor.birthtimeMs === undefined ? {} : { birthtimeMs: cursor.birthtimeMs }),
      consumedOriginIds: [...(this.logOrigins.get(id) ?? [])], ...(lastDigest ? { lastDigest } : {}) }
    this.saveCursors()
  }
  /** Cursors ride a slow shared write, never one per line, so reading a transcript stays a read. */
  private saveCursors(): void {
    if (this.cursorTimer) return
    this.cursorTimer = setTimeout(() => { this.cursorTimer = undefined; void this.persist().catch(() => undefined) }, 5000)
    this.cursorTimer.unref()
  }
  /** The thread, with its stored records read first if nothing has read them yet: every change builds on them. */
  private ensureActivityHistory(id: string): AgentThread | undefined {
    const thread = this.threads.get(id)
    if (thread && this.activityHistoryPending.delete(id)) {
      const activities = this.history?.activities?.(id, this.aliases[id]?.historyEpoch)
      if (activities) { thread.activities = structuredClone(activities.slice(-MAX_AGENT_ACTIVITIES)); this.changed(id) }
    }
    return thread
  }
  private ensureThread(id: string, alias: Alias): void {
    this.activityHistoryPending.delete(id)
    this.threads.set(id, { id, projectId: alias.projectId!, ...(alias.historyEpoch ? { historyEpoch: alias.historyEpoch } : {}), workingDirectory: alias.cwd, title: alias.title, modelId: alias.modelId, reasoningEffort: alias.reasoningEffort, runtimeMode: alias.runtimeMode ?? 'approval-required', ...(alias.fastMode ? { fastMode: true } : {}), status: 'idle', messages: [], requests: [], activities: [] })
    this.threads.get(id)!.usage = this.usage.get(id)
    this.threads.get(id)!.compaction = alias.compaction
    this.threads.get(id)!.resumeCompactionDismissed = Object.values(this.aliases).some(value => value.kind !== 'personal' && value.resumeCompactionDismissed)
    this.changed(id)
  }
  private observeCompaction(id: string, frame: ClaudeFrame, fromLog: boolean): void {
    if (frame.parent_tool_use_id || frame.isSidechain || frame.type !== 'system' || !(frame.subtype === 'compact_boundary' || frame.subtype === 'status' && ['success', 'failed'].includes(String(frame.compact_result)))) return
    const alias = this.aliases[id]!, thread = this.threads.get(id)!
    const timestamp = typeof frame.timestamp === 'string' ? Date.parse(frame.timestamp) : NaN
    // Persisted history may replay older compactions. Only evidence after this
    // durable request can reconcile an operation whose live acknowledgement was lost.
    if (compactionPending(alias.compaction) && (!fromLog || timestamp >= Date.parse(alias.compactStartedAt ?? ''))) {
      // A CLI that took the /compact still answers it with a result, and that result ends the thread's work: it names
      // the compaction as the turn the thread rests on. Going idle at the boundary showed a thread with no finished turn
      // until then, so a follow-up queued during the compaction paused instead of going (and right after a restart,
      // when Sotto has read no turn of the thread, always). A /compact whose write went unconfirmed but arrived late is
      // answered the same way. Only a compaction no CLI will answer settles here, and so does a failed one, as it did.
      const answering = this.compacting.has(id) && this.compacting.get(id) === this.runtimes.get(id)
      alias.compaction = { commandId: alias.compaction!.commandId, ...idleMark(alias.compaction), status: frame.compact_result === 'failed' ? 'failed' : 'completed',
        ...(frame.compact_result === 'failed' ? { error: typeof frame.compact_error === 'string' ? frame.compact_error : 'Claude native compaction failed.' } : {}) }
      thread.compaction = alias.compaction
      if (!answering || frame.compact_result === 'failed') thread.status = frame.compact_result === 'failed' ? 'error' : 'idle'
      this.changed(id)
      void this.persist().catch(() => { this.state.error = 'The native compaction result could not be saved.'; this.emit() })
    }
    if (frame.subtype === 'compact_boundary' && (!fromLog || Number.isFinite(timestamp) && timestamp > Date.parse(thread.usage?.contextUpdatedAt ?? '1970-01-01'))) {
      const metadata = object(frame.compact_metadata) ?? object(frame.compactMetadata)
      const tokens = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
      // The size Sotto last saw is the honest stand-in when the boundary omits its own before-count.
      const before = tokens(metadata?.pre_tokens ?? metadata?.preTokens) ?? thread.usage?.contextUsed
      const after = tokens(metadata?.post_tokens ?? metadata?.postTokens)
      this.markCompaction(id, String(frame.uuid ?? timestamp), before, after, Number.isFinite(timestamp) ? timestamp : undefined)
      this.usage.compacted(id, metadata?.post_tokens ?? metadata?.postTokens, Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined)
      thread.usage = this.usage.get(id)
      this.changed(id)
    }
  }
  /** A compaction is not a turn and not a tool: the transcript says so on its own line. */
  private markCompaction(id: string, key: string, before: number | undefined, after: number | undefined, at: number | undefined): void {
    const thread = this.ensureActivityHistory(id); if (!thread) return
    const anchor = this.lastTextMessageId(id)
    thread.activities = markCompactionActivity(thread.activities, { provider: 'claude', key,
      turnId: this.lastUserMessageId(id) ?? 'native-history',
      ...(anchor !== undefined ? { afterMessageId: anchor } : {}),
      ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), ...(at !== undefined ? { at } : {}) })
    this.changed(id)
  }
  /**
   * Claude reports no turn lifecycle, so Sotto records the turn it watched. The turn is identified by
   * its user message, the same identity the projected activity rows already carry.
   */
  /** Adds a prompt's origin and makes it durable before the prompt goes; one that could not be made durable is taken back. */
  private async addOrigin(id: string, alias: Alias, origin: Alias['origins'][number]): Promise<void> {
    alias.origins.push(origin)
    try { await this.recordOrigin(id, origin) } catch (error) {
      alias.origins = alias.origins.filter(candidate => candidate.uuid !== origin.uuid)
      // The line may be on disk though its sync or close failed. A whole write moves the generation past it, so
      // the next connect never folds back the origin of a prompt that was not sent.
      await this.persist().catch(() => undefined)
      throw error
    }
  }
  /** A turn's tool call goes out in its assistant message and is done when its result comes back; a result ends them all. */
  private trackTools(id: string, frame: ClaudeFrame): void {
    if (frame.type === 'result') { this.toolsRunning.delete(id); return }
    if (frame.type !== 'assistant' && frame.type !== 'user') return
    const content = object(frame.message)?.content
    if (!Array.isArray(content)) return
    const running = this.toolsRunning.get(id) ?? new Set<string>()
    for (const block of content.map(object)) {
      if (frame.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') running.add(block.id)
      if (frame.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') running.delete(block.tool_use_id)
    }
    if (running.size) this.toolsRunning.set(id, running); else this.toolsRunning.delete(id)
  }
  /** A steer the CLI held unread ends with the CLI; one still unacknowledged reports uncertain now rather than at the deadline. */
  private dropSteers(id: string): void {
    for (const [uuid, steer] of this.steers) if (steer.threadId === id) { this.steers.delete(uuid); this.acknowledgements.get(uuid)?.(false) }
  }
  /**
   * A prompt's native content and the origin that names it. Each staged image is read from the store here, at the protocol
   * boundary (ADR-0031). Any other attached file is saved into the thread's folder and named in a text block of its own,
   * after the user's words, and a PDF that passes the native rule goes as a `document` block too (ADR-0131). The origin's
   * digest is the user's words alone, which is what `claudeUserText` reads back.
   */
  private async nativePrompt(id: string, command: Extract<AgentHostCommand, { type: 'send' | 'steer' }>): Promise<{ content: unknown; nativeText: string; origin: Alias['origins'][number] }> {
    verifyFileMentions(command.text, command.files)
    const delivered = await deliverAttachments(this.aliases[id]?.cwd, command.attachments, { nativePdf: true })
    const images: unknown[] = await Promise.all(delivered.images.map(async image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType,
      data: Buffer.from(await image.read()).toString('base64') } })))
    for (const pdf of delivered.nativePdfs) images.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(pdf.bytes).toString('base64') }, title: pdf.name })
    const nativePrompt = command.skills?.length ? claudeSkillPrompt(command.text, command.skills, await this.listThreadSkills(id, true)) : command.text
    const nativeText = typeof nativePrompt === 'string' ? nativePrompt : claudeText(nativePrompt)
    const origin = { messageId: command.messageId, commandId: command.commandId, uuid: randomUUID(), digest: claudeDigest(nativeText), createdAt: new Date().toISOString(),
      ...(command.attachments?.length ? { attachments: attachmentReferences(command.attachments) } : {}) }
    const content: unknown = images.length || delivered.note ? [
      ...images,
      ...(typeof nativePrompt === 'string' ? (nativePrompt ? [{ type: 'text', text: nativePrompt }] : []) : nativePrompt),
      ...(delivered.note ? [{ type: 'text', text: delivered.note }] : []),
    ] : nativePrompt
    // With notes after the user's words, the whole delivered text is what the log gives back, so its digest finds this
    // origin exactly and the notes' length says what to take off; nothing is guessed from a block's shape.
    const flattened = claudeText(content)
    const notes = delivered.note && flattened.startsWith(nativeText) ? { delivered: { digest: claudeDigest(flattened), suffixLength: flattened.length - nativeText.length } } : {}
    return { content, nativeText, origin: { ...origin, ...notes } }
  }
  /**
   * Steering: a prompt written to the CLI while its turn runs. Claude Code queues it and says so at once, which is the
   * acknowledgement, so the thread shows it from then as it shows a Codex steer. While Claude thinks or writes, it goes
   * as Claude Code's own send now (`priority: 'now'`, ADR-0075): the CLI drops the step and ends the turn, so the steer
   * runs as the next; left to the next model step, it could wait minutes behind a long reply. While one of the turn's
   * tool calls runs it goes as a plain prompt, read into the turn once the call returns, which is as soon: sent now, it
   * would wait for the call too, and the CLI would hold a stop until the call ended. One the turn ends before reading,
   * a stop included, starts the next turn (see `steers`).
   */
  private async steerTurn(id: string, alias: Alias, thread: AgentThread, command: Extract<AgentHostCommand, { type: 'steer' }>, readForSend: () => boolean, watcherGuard?: () => void): Promise<AgentHostResult> {
    validatePromptAttachments(this.state, alias.modelId, command.attachments, { workingDirectory: alias.cwd })
    if (alias.origins.some(origin => origin.messageId === command.messageId)) return this.messageLog.has(id, command.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
    const runtime = this.runtimes.get(id)
    const validate = (): void => {
      if (!runtime || this.runtimes.get(id) !== runtime || this.nativeTakeovers.has(id) || thread.status !== 'running') throw new Error('The Claude turn ended before steering. Queue this follow-up instead.')
      if (thread.requests.length) throw new Error('Answer the pending Claude request explicitly before steering.')
      if (command.expectedLastUserMessageId !== undefined && (this.messageLog.lastUserMessageId(id) ?? null) !== command.expectedLastUserMessageId) throw new Error('The thread changed in Claude Code. Review it before steering.')
    }
    if (!readForSend()) await this.sync(id)
    validate()
    if (this.dispatching.has(id)) throw new Error('A Claude prompt is already being submitted.')
    this.dispatching.add(id)
    try {
      await this.applyUltracodeEffort(runtime!, alias)
      const { content, nativeText, origin } = await this.nativePrompt(id, command)
      await this.addOrigin(id, alias, origin)
      try { await this.sync(id); validate(); watcherGuard?.() }
      catch (error) { alias.origins = alias.origins.filter(candidate => candidate.uuid !== origin.uuid); await this.persist(); throw error }
      let timer: ReturnType<typeof setTimeout> | undefined
      const forget = (): void => { clearTimeout(timer); this.acknowledgements.delete(origin.uuid) }
      // Unconfirmed, a steer is not counted on to start a turn, and an echo that still comes is read as a steer's.
      const unconfirmed = (): void => { const steer = this.steers.get(origin.uuid); if (steer) steer.unconfirmed = true }
      const acknowledged = new Promise<boolean>(resolve => {
        timer = setTimeout(() => { forget(); unconfirmed(); resolve(false) }, this.options.requestTimeoutMs ?? 15000)
        this.acknowledgements.set(origin.uuid, (delivered = true) => {
          forget()
          if (delivered && !this.messageLog.has(id, origin.messageId)) this.addMessage(id, { id: origin.messageId, role: 'user', text: nativeText, createdAt: origin.createdAt, commandId: origin.commandId, ...(origin.attachments ? { attachments: origin.attachments } : {}) })
          resolve(delivered)
        })
      })
      const now = !this.toolsRunning.has(id)
      this.steers.set(origin.uuid, { threadId: id, now, carried: false })
      try { await runtime!.protocol.write({ type: 'user', uuid: origin.uuid, session_id: alias.sessionId, parent_tool_use_id: null, ...(now ? { priority: 'now' } : {}), message: { role: 'user', content } }) }
      catch { forget(); unconfirmed(); return { accepted: false, uncertain: true } }
      if (!await acknowledged) return { accepted: false, uncertain: true }
      this.emit()
      return { accepted: true }
    } finally { this.dispatching.delete(id) }
  }
  private markTurn(id: string, status: AgentActivity['status'], turnId?: string, error?: string, steered?: boolean): void {
    const thread = this.ensureActivityHistory(id); if (!thread) return
    const last = this.messageLog.lastUserMessageId(id)
    const turn = turnId ?? last
    if (turn === undefined) return
    thread.activities = markTurnActivity(thread.activities, { provider: 'claude', turnId: turn, status,
      ...(last === turn ? { afterMessageId: turn } : {}), ...(error !== undefined ? { error } : {}), ...(steered ? { steered } : {}) })
    this.changed(id)
  }
  /** The turn a `result` ends, and how it ended. */
  private resultEnding(id: string, frame: ClaudeFrame): { origin: string | undefined; stopped: boolean; steered: boolean; status: 'interrupted' | 'failed' | 'completed' } {
    const alias = this.aliases[id]!; const thread = this.threads.get(id)!
    // Claude Code leaves its own prompt's identity off the result of a turn it gave itself and says where that prompt
    // came from instead, so such a result never ends a prompt of Sotto's still waiting to go out.
    // Without a name, the turn answers the latest prompt that started one: a steer read into it or still held started none.
    const origin = typeof frame.user_message_uuid === 'string' ? frame.user_message_uuid : this.selfTurns.get(id)
      ?? (object(frame.origin) ? undefined : alias.origins.findLast(value => !this.foldedSteers.has(value.uuid) && !this.steers.has(value.uuid))?.uuid)
    // A turn the user stopped ends in an error result, which is no failure of Claude Code's.
    const stopping = this.interrupting.has(id) || thread.lastTurn?.status === 'interrupted' && (!origin || thread.lastTurn.id === origin)
    // So does one a steer cut, said by an aborted ending while the CLI still holds a steer sent now. A turn that
    // finished as the steer came is finished, and the steer runs next all the same.
    const aborted = claudeTurnAborted(frame)
    const steered = !stopping && aborted && [...this.steers.values()].some(steer => steer.threadId === id && steer.now && !steer.carried)
    // Claude Code cuts a turn only for a stop or a prompt sent now, so any other cut is a stop, one whose word came
    // while the turn before it was ending included.
    const stopped = !steered && (stopping || aborted)
    return { origin, stopped, steered, status: stopped || steered ? 'interrupted' : frame.is_error === true ? 'failed' : 'completed' }
  }
  private projectActivity(id: string, frame: ClaudeFrame, live = false, turnEnd?: AgentActivity['status']): void {
    const thread = this.ensureActivityHistory(id)!
    let projector = this.activity.get(id)
    if (!projector) { projector = new ClaudeActivity(activityId => this.history?.activity?.(id, activityId, this.aliases[id]?.historyEpoch)); this.activity.set(id, projector) }
    const watcherTurn = live && this.runtimes.get(id)?.watcher && thread.lastTurn?.status === 'running' ? thread.lastTurn.messageId : undefined
    const turnId = watcherTurn ?? this.lastUserMessageId(id) ?? 'native-history'
    const rows = projector.apply(thread.activities ?? [], frame, turnId, this.lastTextMessageId(id), this.aliases[id]!.cwd, live, turnEnd)
    if (rows.length) {
      // Transcript replay may place a tool after a folded steer. Its already-observed tool identity
      // still belongs to the native turn that wrote it; replay must not move it to the steer.
      if (!live && this.resolvedWatcherProfiles.has(id)) {
        const observed = new Map((thread.activities ?? []).map(activity => [activity.id, activity]))
        thread.activities = rows.map(activity => {
          const previous = observed.get(activity.id) ?? this.history?.activity?.(id, activity.id, this.aliases[id]?.historyEpoch)
          return activity.kind === 'file-change' && previous?.kind === 'file-change' && previous.turnId !== 'native-history'
            && previous.turnId !== activity.turnId ? { ...activity, turnId: previous.turnId } : activity
        })
      } else thread.activities = rows
      this.changed(id)
    }
  }
  /** The turn a record read now belongs to: the newest user message, or the newest one a replay has reached. */
  private lastUserMessageId(id: string): string | undefined {
    const replay = this.replays.get(id)
    return replay?.reading ? replay.userId : this.messageLog.lastUserMessageId(id)
  }
  /**
   * The message a record read now follows: the newest with words, or the newest a replay has reached. A log seeded
   * with identities alone learns no newest message from a replay, so once it ends the replay's own last one stands
   * until a new message says something.
   */
  private lastTextMessageId(id: string): string | undefined {
    const replay = this.replays.get(id)
    return replay?.reading ? replay.textId : this.messageLog.lastTextMessageId(id) ?? replay?.textId
  }
  /** The one place a Claude message reaches the record: the transcript tail, a streamed reply, or a
   * takeover typed into the CLI. The log works out whether it is an addition, an append or a change. */
  private addMessage(id: string, message: AgentMessage): void {
    const replay = this.replays.get(id)
    if (replay?.reading) {
      // What an empty log would have made of the same message: a user message is a turn the first time it is
      // read, and any message with words becomes the one the next record follows; an empty reply is not yet.
      if (message.role === 'user' && !replay.seen.has(message.id)) { replay.seen.add(message.id); replay.userId = message.id }
      if (message.text.length) replay.textId = message.id
      // An assistant message written over several transcript lines is read back a block at a time. While the store
      // holds it whole, an earlier block is not a change to it: recording one would shrink the reply on screen.
      const held = replay.words?.get(message.id)
      if (held !== undefined && held.length > message.text.length && held.startsWith(message.text)) return
    }
    this.messageLog.add(id, message)
  }
  private reply(runtime: Runtime, id: string, response: ClaudeFrame): Promise<void> {
    return runtime.protocol.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
  }
  private async denyPending(id: string, runtime: Runtime): Promise<void> {
    const pending = [...runtime.requests.values()].filter(request => !runtime.answered.has(request.id)); runtime.requests.clear()
    const thread = this.threads.get(id); if (thread) { thread.requests = []; this.changed(id) }
    await Promise.all(pending.map(request => this.reply(runtime, request.id, request.resumeDialog ? { behavior: 'cancelled' } : claudeDenial())))
  }
  /**
   * ADR-0140: stop the thread's own CLI if it has one, remove its alias and every per-thread record this adapter
   * keeps, and persist. Guarded with `forgottenAliasIds` against a `connect()` that reads the alias store before
   * this removal reaches disk (see there); `inAliasOrder` already serializes this against `persist()`/`readAliases()`.
   */
  async forgetThread(id: string): Promise<void> {
    this.forgottenAliasIds.add(id)
    if (!this.aliasesLoaded) {
      await this.inAliasOrder(async () => {
        const current = await this.aliasStore.read()
        if (!(id in current)) return
        const next = { ...current }
        delete next[id]
        await this.aliasStore.write(next)
      })
      return
    }
    if (!this.aliases[id]) return
    await this.stopSession(id)
    this.reaper.forget(id)
    this.observed.delete(id)
    this.clearMonitoring(id)
    this.dropSteers(id)
    this.selfTurns.delete(id); this.queries.delete(id); this.interrupting.delete(id); this.toolsRunning.delete(id)
    this.streaming.delete(id); this.compacting.delete(id)
    this.activityHistoryPending.delete(id); this.logs.delete(id); this.activity.delete(id)
    this.subagentModels.delete(id); this.logOrigins.delete(id); this.lastLogDigest.delete(id); this.replays.delete(id)
    this.nativeTakeovers.delete(id); this.completedOrigins.delete(id); this.assistantBlocks.delete(id)
    this.configuring.delete(id); this.configurationGuards.delete(id); this.configurationLaunches.delete(id)
    this.dispatching.delete(id); this.outdated.delete(id); this.savedCursors.delete(id)
    this.turnFailures.delete(id); this.assistantErrors.delete(id); this.usageGroups.delete(id)
    this.restoredHistory.delete(id)
    this.messageLog.forget(id)
    this.threads.delete(id)
    delete this.aliases[id]
    await this.persist()
    if (this.state.connected) this.emit()
  }
  /**
   * Writes every thread's record whole, then clears the origin journal, whose origins that write now holds. Calls
   * made before a queued write starts share it, and it writes the records as they are when it starts.
   */
  private persist(): Promise<void> {
    if (this.queuedAliasWrite) return this.queuedAliasWrite
    const queued = this.inAliasOrder(async () => {
      if (this.queuedAliasWrite === queued) this.queuedAliasWrite = undefined
      // No cursor is saved past text the event store has not committed: streamed appends commit on
      // the workspace's write window, so an advanced cursor first asks for that flush, and one the
      // store could not take is written as it last was saved while its thread keeps the newer one
      // in memory for the next write (ADR-0016). Everything else in the record writes as it is.
      const heldBack: { alias: Alias; cursor: NonNullable<Alias['transcriptCursor']>; written: Alias['transcriptCursor'] }[] = []
      if (this.history?.flushEvents) {
        for (const [id, alias] of Object.entries(this.aliases)) {
          const cursor = alias.transcriptCursor
          if (!cursor || cursor === this.savedCursors.get(id)) continue
          if (this.history.flushEvents(id)) continue
          const saved = this.savedCursors.get(id)
          if (saved) alias.transcriptCursor = saved
          else delete alias.transcriptCursor
          heldBack.push({ alias, cursor, written: saved })
        }
      }
      // The store serializes what it is handed before the write waits, so the cursors this write
      // carries are the ones named here. A transcript read during the wait can advance a live
      // alias further; that newer cursor was not written, must not count as saved, and must not
      // be put back to the held one it replaced.
      const writing = new Map(Object.entries(this.aliases).map(([id, alias]) => [id, alias.transcriptCursor]))
      try {
        await this.writeWhole(this.aliases)
        for (const [id, cursor] of writing) {
          if (cursor) this.savedCursors.set(id, cursor)
          else this.savedCursors.delete(id)
        }
        for (const id of this.savedCursors.keys()) if (!(id in this.aliases)) this.savedCursors.delete(id)
      } finally {
        for (const { alias, cursor, written } of heldBack) {
          if (alias.transcriptCursor === written) alias.transcriptCursor = cursor
        }
      }
    })
    this.queuedAliasWrite = queued
    return queued
  }
  /**
   * Writes the thread store whole under a new journal generation and clears the journal, which the store now holds.
   * Run in alias order only. The store holding the state is what the caller waits for: a journal left behind by a
   * failed clear is harmless, because its lines are of an older generation than the store, which a connect never
   * folds, and the next whole write clears it.
   */
  private async writeWhole(aliases: Record<string, Alias>): Promise<void> {
    // Moved on before the write rather than after it succeeds: lines appended after a write that failed are then
    // newer than the store whichever way it failed, so a connect folds them.
    const generation = ++this.journalGeneration
    // A retired personal record is kept on disk exactly as it was read, so it never takes a generation.
    for (const alias of Object.values(aliases)) if (alias.kind !== 'personal') alias.journalGeneration = generation
    await this.aliasStore.write(aliases)
    try { await this.originJournal.clear() }
    catch { this.options.logEvent?.('claude-origin-journal-clear-failed') }
  }
  /**
   * Makes one new origin durable before its prompt is written to the CLI: a synced line in the journal rather than
   * a rewrite of every thread's record.
   */
  private recordOrigin(threadId: string, origin: Alias['origins'][number]): Promise<void> {
    return this.inAliasOrder(() => this.originJournal.append({ threadId, origin, generation: this.journalGeneration }))
  }
  /**
   * The thread store with the journal's origins over it, read in order with the writes of both. Only lines of the
   * store's journal generation or later are folded: an older one was in the store's hands when it was written whole.
   * A store with no generation, from before there was one, folds every line once.
   */
  /**
   * Claude Code's own transcripts on this computer, for Usage (ADR-0083). Every session this adapter ever ran for a
   * thread, its rewound lineage included, reports under that thread; any other session under a hashed identity.
   * Reads the saved thread records without changing them, so it never waits on or starts a connection.
   */
  private async scanHistory(sink: UsageHistorySink, signal: AbortSignal): Promise<void> {
    const owned = new Map<string, string>()
    const own = (aliases: Record<string, Alias>): void => {
      for (const [id, alias] of Object.entries(aliases)) {
        if (alias.kind === 'personal') continue
        owned.set(alias.sessionId, id)
        for (const earlier of alias.lineage ?? []) if (!owned.has(earlier.sessionId)) owned.set(earlier.sessionId, id)
        if (alias.rollbackPending?.targetSessionId && !owned.has(alias.rollbackPending.targetSessionId)) owned.set(alias.rollbackPending.targetSessionId, id)
      }
    }
    try { own(await this.aliasStore.read()) } catch { /* What this process holds still counts. */ }
    own(this.aliases)
    const home = this.options.claudeHome ?? (this.options.environment ?? process.env).CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    await scanClaudeHistory({ home, owned }, sink, signal)
  }

  private async readAliases(): Promise<Record<string, Alias>> {
    const { aliases, journal, stored } = await this.inAliasOrder(async () => {
      const aliases = await this.aliasStore.read()
      const stored = Object.values(aliases).reduce((newest, alias) => Math.max(newest, alias.journalGeneration ?? 0), 0)
      this.journalGeneration = Math.max(this.journalGeneration, stored)
      return { aliases, journal: await this.originJournal.read(), stored }
    })
    let merged = false
    for (const { threadId, origin, generation } of journal.entries) {
      const alias = aliases[threadId]
      if (!alias || (generation ?? 0) < stored || alias.origins.some(candidate => candidate.uuid === origin.uuid)) continue
      alias.origins.push(origin); merged = true
    }
    // Folded into the store and cleared at once, so this connection's appends never follow a line a crash cut short.
    // A fold that cannot be written still connects: the journal keeps its lines for the next whole write.
    if (merged) {
      try { await this.inAliasOrder(() => this.writeWhole(aliases)) }
      catch { this.options.logEvent?.('claude-origin-journal-fold-failed') }
    } else if (journal.present) {
      // As in a whole write, a journal that cannot be cleared is harmless: every origin in it is already in the store.
      try { await this.inAliasOrder(() => this.originJournal.clear()) }
      catch { this.options.logEvent?.('claude-origin-journal-clear-failed') }
    }
    return aliases
  }
  private inAliasOrder<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = this.aliasWrites.then(operation)
    this.aliasWrites = run.then(() => undefined, () => undefined)
    return run
  }
  /** The public snapshot: a copy of everything, held threads' messages included. A caller that keeps history
   * from this adapter's events is handed every thread with its summary and no messages, as an activity
   * subscriber that asks for it is (#368). */
  private view(historyFromEvents = false): AgentHostSnapshot {
    if (historyFromEvents) return cloneActivitySnapshot(this.activityView(true))
    return cloneHostSnapshot({ ...this.state, threads: [...this.threads.values()]
      .filter((thread): thread is AgentThread => 'projectId' in thread).map(thread => this.messageLog.publishedThread(thread)) })
  }
  /** What activity subscribers are handed. One that keeps history from this adapter's events gets each
   * thread's summary and no messages: those already left as events (#322). */
  private activityView(historyFromEvents: boolean): AgentHostSnapshot {
    certifyActivityView(this.state, this.threads.values())
    return { ...this.state, threads: [...this.threads.values()]
      .filter((thread): thread is AgentThread => 'projectId' in thread).map(thread => this.messageLog.activityThread(thread, historyFromEvents)) }
  }
  /** One thread as `activityView` lists it, for the thread changes of the threads marked changed. */
  private activityThread(id: string, historyFromEvents: boolean): AgentThread | undefined {
    const thread = this.threads.get(id)
    if (!thread || !('projectId' in thread)) return undefined
    certifyActivityView(this.state, [thread])
    return this.messageLog.activityThread(thread, historyFromEvents)
  }
  /**
   * This thread's state changed (ADR-0016, #925): its next thread changes carry it. Every path that writes into a thread
   * record, or into a request it lists, marks the thread once it has; one that writes into many marks them all
   * (`markAll`). What goes through the message log is marked by the log.
   */
  private changed(id: string): void { this.threadChanges.mark(id) }
  /**
   * Read a starting session's tool list for the approval surface Sotto asked for. The CLI does not report
   * a refused surface any other way: it keeps working, answers every prompt that needed a person with a
   * local deny, and drops AskUserQuestion from the list. That looks like a model choosing not to ask, so
   * this says plainly that nothing can reach the user until the client is fixed.
   */
  private checkApprovalSurface(frame: ClaudeFrame): void {
    // No tool list is not the same as a tool list without the surface: it says nothing either way, and
    // telling the user their client is refusing Sotto on that would be a guess dressed as a fact.
    if (!Array.isArray(frame.tools) || frame.tools.includes(APPROVAL_SURFACE_TOOL)) return
    this.report(APPROVAL_SURFACE_LOST)
  }
  /**
   * Put a message about lost requests on the provider. It is said again whenever an ordinary error has
   * replaced it since, because silence about requests that never reached the user is the fault being
   * fixed here, and a failed turn in between must not be what buries it.
   */
  private report(message: string): void {
    if (this.state.error === message) return
    this.state.error = message
    this.emit()
  }
  private emit(streaming = false): void { this.publisher.publish(streaming); this.scheduleOutdatedStop() }
}
