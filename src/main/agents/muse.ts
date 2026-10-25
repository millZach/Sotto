import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { version as appVersion } from '../../../package.json'
import { attachmentReferences, agentProjectSchema, type AgentHostSnapshot, type AgentMessage, type AgentRuntimeMode, type AgentThread, type ProviderId } from '../../shared/agents'
import type { UsageTokens } from '../../shared/threadUsage'
import type { UsageQuotaRead, UsageTokenObservation } from '../../shared/usageDashboard'
import { mergeAgentActivities, type AgentActivity } from '../../shared/agentActivity'
import { orderReasoningEfforts } from '../../shared/reasoningEfforts'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ActivitySubscribers, certifyActivityView, cloneActivitySnapshot } from './activitySnapshots'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { compareClientVersions } from './clientVersions'
import { museVersionForExecutable } from './museClientInstall'
import type { ActivitySubscriptionOptions, AgentHost, AgentHostCommand, AgentHostResult, ShortTextPrompt, ThreadHistorySource, ThreadHostEvent, ThreadLaunchProfiles, ThreadReadPurpose, ThreadSessionDraft, WatcherLaunchProfile } from './host'
import { preserveLegacyAliases } from './legacyAliases'
import { museItemActivity, museItemDeltaSchema, museItemEventSchema, museItemSchema, musePlanActivity, museTerminal, museTurnCompletedSchema, museTurnEventSchema, type MuseItem } from './museActivity'
import { museApprovalChoice, museApprovalDecidedSchema, museApprovalPending, museApprovalRefreshed, museApprovalSchema, museApprovalUpdatedSchema, museServerSuffix, museSessionServerName, museToolAdmission, museToolName, museUserInputAnswers, museUserInputPending, museUserInputSchema, type MuseApproval, type MusePending } from './museRequests'
import { MUSE_CLI_VERSION, MUSE_MSP_VERSION, MuseRejected, MuseRpc, MuseTooOld, MuseUncertain, MuseUnreadable, MuseUnsupported, findMuseExecutable, museCommandId, museEnvironment, type MuseFrame } from './museRpc'
import { needsPerson, unreadableRequest } from './nativeRequests'
import { tokenCount } from './nativeUsage'
import { ObservedUsage } from './observedUsage'
import { parseMuseQuota, unavailableProviderQuota } from './providerQuota'
import { OpenSessions } from './openSessions'
import { verifyFileMentions } from './promptFiles'
import { ProviderUnavailable } from './providerProblem'
import { providerTakesNoSkills } from './providerSwitch'
import { adapterItemCount, ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { AdapterThreadChanges, restOf } from './adapterThreadChanges'
import type { ActivityChangesListener, ActivityChangesSubscription } from './threadChanges'
import { ReadsBeforeSend } from './readsBeforeSend'
import { holdTurnEnd, markSendStage, type TurnEndTimings } from './sendStages'
import { SessionReaper } from './sessionReaper'
import type { BrowserAgentTools } from './browserAgentServer'
import { ThreadMessageLog } from './threadMessageLog'
import { scopedThreadServers, TOOL_WAIT_HEADER, type ScopedThreadTools, type ThreadMcpServer } from './threadToolServer'
import { deliverAttachments, readBackUserText, withAttachedFilesNote } from './attachedFiles'
import { effortAfterChange, validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { existingWorkingDirectory } from './threadWorktrees'
import { markTurnActivity } from './turnActivity'
import { WatcherProfileRefusal, validateWatcherProfile } from './watcherProfile'
import { WATCHER_SYSTEM_PROMPT } from './watcherPrompt'
import { assertWatcherPermission, assertWatcherPermissionChoice, watcherThreadTools } from './watcherProviderTools'
import { WATCHER_COMPACTED_NOTE, watcherRequestLine } from './watcherRequestNote'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const THREAD_PROCESS_LOST = 'Muse stopped before this reply finished, so it may be cut short. Send a message to carry on.'
/** MSP's reasoning tiers, least to most thorough. The vocabulary is closed, so every model offers the same list. */
const MUSE_EFFORTS = orderReasoningEfforts(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const MUSE_DEFAULT_EFFORT = 'high'
/**
 * Sotto's permission modes in MSP's approval modes. A serve host seals a ceiling at startup and refuses a mode
 * above or beside it, so only the modes a probe could actually select are offered (see `probeModes`).
 */
const museRuntimeModes = ['approval-required', 'auto', 'full-access'] as const
type MuseRuntimeMode = typeof museRuntimeModes[number]
const museRuntimeModeSchema = z.enum(museRuntimeModes)
const MSP_MODE: Readonly<Record<MuseRuntimeMode, string>> = { 'approval-required': 'promptUnmatched', auto: 'onRequest', 'full-access': 'allowAll' }
function runtimeModeOf(mspMode: string | undefined): MuseRuntimeMode {
  return mspMode === 'allowAll' ? 'full-access' : mspMode === 'onRequest' ? 'auto' : 'approval-required'
}
/**
 * The status of a thread with no turn running, as far as its settings go. Only a permission mode Muse has not
 * confirmed holds a send back, so only that reads as an error; a model Muse has not confirmed never blocks a send or a
 * queued follow-up (ADR-0079).
 */
function settledStatus(alias: { readonly pendingRuntimeMode?: MuseRuntimeMode | undefined }): 'idle' | 'error' {
  return alias.pendingRuntimeMode ? 'error' : 'idle'
}
function museRuntimeMode(mode: AgentRuntimeMode): MuseRuntimeMode {
  const parsed = museRuntimeModeSchema.safeParse(mode)
  if (!parsed.success) throw new Error('That permission mode is not supported by this provider.')
  return parsed.data
}
const attachmentRefSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), sizeBytes: z.number() })
const originSchema = z.object({
  messageId: z.string(), commandId: z.string(), nativeCommandId: z.string(), digest: z.string(),
  createdAt: z.string(), confirmed: z.boolean().default(false), attachments: z.array(attachmentRefSchema).default([]),
})
type Origin = z.infer<typeof originSchema>
const aliasSchema = z.object({
  museSessionId: z.string().optional(), startCommandId: z.string().optional(), kind: z.literal('personal').optional(), projectId: z.string(), cwd: z.string(),
  title: z.string(), modelId: z.string(), nativeModelId: z.string().optional(), settingsConfirmed: z.boolean().default(false),
  createdAt: z.string(), origins: z.array(originSchema), reasoningEffort: z.string().optional(),
  runtimeMode: museRuntimeModeSchema.optional(), pendingRuntimeMode: museRuntimeModeSchema.optional(),
  answeredRequestIds: z.array(z.string()).default([]),
  endedTurn: z.object({ turnId: z.string(), outcome: z.enum(['failed', 'interrupted']) }).optional(),
  /** The command of a fork Sotto asked for and has not seen answered, so asking again cannot make a second copy. */
  forkCommandId: z.string().optional(),
  /** The messages Muse rebuilt into the history of the copy this thread runs on; already in Sotto's log, never read again. */
  forkedMessages: z.array(z.string()).optional(),
})
type Alias = z.infer<typeof aliasSchema>
const initializeSchema = z.looseObject({
  serverInfo: z.looseObject({ name: z.string(), version: z.string().min(1).max(64) }),
  schema: z.looseObject({ version: z.number() }),
  grantedCapabilities: z.array(z.string()).default([]),
})
type MuseClient = z.infer<typeof initializeSchema>
const modelEntrySchema = z.looseObject({
  modelId: z.string().min(1), displayLabel: z.string().min(1), providerId: z.string().min(1),
  isDefault: z.boolean().default(false),
})
const modelListSchema = z.looseObject({ models: z.array(modelEntrySchema), source: z.string().default('') })
/**
 * Whether an empty catalog means no sign-in. A signed-out client answers with its bundled catalog, which ships empty; a
 * signed-in one answers with its provider's catalog, even offline (checked against 1.4.8 and 1.4.9). MSP 1 requires the
 * source, so any other empty catalog, a missing source included, is the client's setup, which signing in would not change.
 */
const signedOutCatalog = (catalog: z.infer<typeof modelListSchema>): boolean => !catalog.models.length && catalog.source === 'bundledCatalog'
const museSessionSchema = z.looseObject({
  sessionId: z.string().min(1), status: z.string().default('idle'), modelId: z.string().nullable().default(null),
  providerId: z.string().nullable().default(null), activeTurnId: z.string().nullable().default(null),
  approvalMode: z.looseObject({ mode: z.string() }).optional(),
  /** The session's permission profile as Muse committed it, where the client says (ADR-0079): who reviews its approvals. */
  permissionState: z.looseObject({ reviewerAuthority: z.string().optional() }).optional(),
})
type MuseSession = z.infer<typeof museSessionSchema>
const sessionStartSchema = z.looseObject({ session: museSessionSchema, viewCursor: z.string().default('') })
const sessionReadSchema = z.looseObject({ session: museSessionSchema })
const historySchema = z.looseObject({
  mode: z.string(), items: z.array(museItemSchema).nullable().default(null),
  snapshot: z.looseObject({ state: z.looseObject({ items: z.array(museItemSchema).default([]) }) }).nullable().default(null),
})
const sessionResumeSchema = z.looseObject({
  session: museSessionSchema, history: historySchema, viewCursor: z.string().default(''),
  pendingRequests: z.array(z.looseObject({ kind: z.string() })).default([]),
})
const sessionForkSchema = z.looseObject({ session: museSessionSchema, history: historySchema })
const turnStartSchema = z.looseObject({ turnId: z.string().min(1), disposition: z.string().default('started') })
const listPendingSchema = z.looseObject({ approvals: z.array(museApprovalSchema).default([]), userInputs: z.array(museUserInputSchema).default([]) })
const approvalResolvedSchema = z.looseObject({ sessionId: z.string().min(1), approvalId: z.string().min(1) })
const userInputSettledSchema = z.looseObject({ sessionId: z.string().min(1), userInputId: z.string().min(1) })
const modelChangedSchema = z.looseObject({ sessionId: z.string().min(1), modelId: z.string().min(1) })
const approvalModeChangedSchema = z.looseObject({ sessionId: z.string().min(1), mode: z.string().min(1) })
const tokenUsageSchema = z.looseObject({
  sessionId: z.string().min(1), modelId: z.string().optional(),
  usage: z.looseObject({ inputTokens: z.number().default(0), outputTokens: z.number().default(0), cachedTokens: z.number().default(0) }),
  cumulative: z.looseObject({ promptTokens: z.number().default(0), outputTokens: z.number().default(0) }),
})
/**
 * What Usage reads of one `session/tokenUsage`: one model completion (MSP sends one per completion), named by the durable
 * records Muse folded it from, so a completion seen live and again later is one call. Read apart from `tokenUsageSchema`
 * and never required, so a shape Usage cannot read leaves the thread's own readout as it was.
 */
const tokenCallSchema = z.looseObject({
  turnId: z.string().min(1).max(256).optional(), promptTokens: z.number().optional(),
  sourceRange: z.looseObject({ first: z.looseObject({ id: z.string().min(1).max(256) }), last: z.looseObject({ id: z.string().min(1).max(256) }) }).optional(),
  usage: z.looseObject({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), cachedTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional() }),
  cumulative: z.looseObject({ promptTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
})
/** A refusal that says the client has no such method: a Muse from before `usage/read`. */
const methodMissing = (error: unknown): boolean => error instanceof MuseRejected && (error.code === -32601 || error.kind === 'methodNotFound')
/** How long Usage waits on one thread host's `usage/read`, a local read that makes no model call. */
const MUSE_USAGE_READ_MS = 5_000
const contextUsageSchema = z.looseObject({ sessionId: z.string().min(1), usedTokens: z.number(), windowTokens: z.number().optional() })
const todoChangedSchema = z.looseObject({
  sessionId: z.string().min(1),
  items: z.array(z.looseObject({ text: z.string(), status: z.string() })).default([]),
})


/** Why Sotto will not drive this client, or undefined when it will. The floor is not a pin (ADR-0042). */
function clientRefusal(client: MuseClient): MuseUnsupported | undefined {
  if (client.schema.version !== MUSE_MSP_VERSION) return new MuseUnsupported(`Sotto speaks MSP ${MUSE_MSP_VERSION}, and this client answered MSP ${client.schema.version}.`)
  if (compareClientVersions(client.serverInfo.version, MUSE_CLI_VERSION) < 0) return new MuseTooOld(`Muse ${MUSE_CLI_VERSION} or newer is required, and this client is ${client.serverInfo.version}.`, client.serverInfo.version)
  return undefined
}

/** How Sotto spawns the native client: one MSP host per thread (`muse serve`, ADR-0038, ADR-0079). */
export function museServeArguments(disableSandbox = false): string[] { return disableSandbox ? ['serve', '--disable-sandbox'] : ['serve'] }

/** The capability a host grants before it takes tool servers on `session/start` and `session/resume` (ADR-0079). */
const SESSION_MCP = 'sessionMcp'
/**
 * How long Muse waits for one tool call, in seconds. It has no per-session setting and `muse serve -c` takes no key for
 * it, so each of Sotto's servers is told instead, and a tool that waits returns inside it (ADR-0079): the browser for the
 * user's answer, Watcher's tools for a start or send still under way.
 */
const MUSE_TOOL_WAIT_SECONDS = 300
/** One of Sotto's servers in MSP's form: loopback streamable HTTP with its bearer token, required for the session to run. */
function museToolServer(server: Readonly<Pick<ThreadMcpServer, 'name' | 'url'>> & { readonly headers: readonly { readonly name: string; readonly value: string }[] }, waitSeconds: number): Record<string, unknown> {
  return { transport: 'streamableHttp', url: server.url, mode: 'required',
    headers: { ...Object.fromEntries(server.headers.map(header => [header.name, header.value])), [TOOL_WAIT_HEADER]: String(waitSeconds) } }
}
/**
 * The permission profile Watcher's session starts on (ADR-0079): Muse's **Ask me**, the same access as its default
 * Auto-review with no automated reviewer, so a request Muse asks about in Watcher's session reaches the user and no model
 * of Muse's decides it. MSP selects a profile only when a session starts; a resume keeps the one it committed.
 */
const MUSE_WATCHER_PROFILE = ':ask-me'
/** Why Muse refuses a profile it does not know or cannot offer; Watcher is then refused rather than started reviewed. */
const MUSE_PROFILE_REFUSALS: ReadonlySet<string> = new Set(['permission_profile_unknown', 'permission_profile_unavailable', 'permission_profile_ephemeral_fixed'])
const MUSE_WATCHER_WITHOUT_TOOLS = 'This Muse cannot give Watcher its Sotto tools, so Watcher did not start. Nothing was sent. Update Muse to 1.4.7 or newer and connect it again, or choose a Codex, Claude Code or Grok Build model for Watcher.'
const MUSE_WATCHER_REVIEWED = 'This Muse would let its own reviewer decide Watcher’s approvals instead of you, so Watcher did not start. Nothing was sent. Update Muse and connect it again, or choose a Codex, Claude Code or Grok Build model for Watcher.'
const MUSE_WATCHER_UNPROVEN = 'This Muse cannot show that Watcher’s approvals stay with you, so Watcher did not start. Nothing was sent. Update Muse and connect it again, or choose a Codex, Claude Code or Grok Build model for Watcher.'
const MUSE_COPYING_CONVERSATION = 'Muse could not give this thread its tools after its conversation was compacted, so Sotto is moving the thread onto a copy of the conversation. Nothing was lost. Send your message again.'
const MUSE_COPY_FAILED = 'Muse could not give this thread its tools after its conversation was compacted, and Sotto could not copy the conversation. Nothing was lost. Start a new thread to carry on.'
/** Muse 1.4.12's refusal of a compacted session's tool servers on a new host, from its turn's error. */
const MUSE_TOOL_AUDIT_FAILED = 'MCP startup audit failed'
/**
 * Watcher's instructions on Muse: `instructions` is the profile's own, with the worker-role lines when that feature is on,
 * or the base prompt (#1417). MSP takes no system prompt or instructions from a client, so they travel as a text part,
 * marked as Sotto's, ahead of the first message Sotto sends Watcher's session on a host and again after its conversation
 * was compacted (#1418). The turn's `displayText` is the message alone, so Muse's transcript and Sotto's show only what
 * was sent; the model reads both (ADR-0073).
 */
export function museWatcherInstructions(instructions: string = WATCHER_SYSTEM_PROMPT): string {
  return `[Sotto: Watcher's instructions. Muse takes no instructions from Sotto any other way, so they come with Sotto's first message to you, and again after this conversation is compacted or resumed. They are not the user's words.]\n${instructions}\n[End of Watcher's instructions. The message follows.]\n\n`
}
export const MUSE_WATCHER_INSTRUCTIONS = museWatcherInstructions()
/**
 * Watcher's instructions at the start of a message, in any wording Sotto has sent them: with or without the worker-role
 * lines, and the opening line that said they came ahead of every message.
 */
const MUSE_WATCHER_BLOCK = /^\[Sotto: Watcher's instructions\.[^\n]*\]\n[\s\S]*?\n\[End of Watcher's instructions\. The message follows\.\]/u
/** The request note's line as `watcherRequestLine` writes it, at the end of a message Sotto sent Watcher. */
const MUSE_WATCHER_NOTE = /\n\n\[Sotto Watcher request: [^\]\n]{1,500}\]$/u
/**
 * A message Sotto sent, as it was typed, from the wire text when Muse kept no whole display text: Watcher's instructions
 * ahead of it and the note after it come off (ADR-0079). Only a message that begins with the instructions or ends with
 * the note is touched. The words are proved by the digest Sotto kept when it sent them, so words the user typed that look
 * like instructions or a note stay; when Muse cut the message short there is nothing to prove them by, and only Sotto's
 * own parts come off.
 */
function museWatcherTyped(text: string, typedDigest: string): string | undefined {
  const block = MUSE_WATCHER_BLOCK.exec(text)
  // MSP joins a turn's text parts in order; the separator it puts between them is Muse's.
  const body = block ? text.slice(block[0].length).replace(/^\n{1,2}/u, '') : text
  const note = MUSE_WATCHER_NOTE.exec(body)
  if (!block && !note) return undefined
  const candidates = [text, body, ...(note ? [body.slice(0, note.index)] : [])]
  return candidates.find(candidate => digest(candidate) === typedDigest) ?? (note ? body.slice(0, note.index) : body)
}

/**
 * The one `session/start` a thread makes, the same on every try: its replay after a lost acknowledgement must match the
 * first byte for byte, or Muse refuses it (`command_id_conflict`).
 */
function startParams(alias: Alias, tools: { config?: unknown }, watcher: boolean): Record<string, unknown> {
  return { commandId: alias.startCommandId, workspaceRoot: alias.cwd, modelId: alias.modelId,
    ...(alias.runtimeMode ? { approvalMode: MSP_MODE[alias.runtimeMode] } : {}), ...(watcher ? { permissionProfile: MUSE_WATCHER_PROFILE } : {}), ...tools }
}

interface ThreadProcess {
  rpc: MuseRpc; ready: Promise<ThreadProcess>; clientRevision: number; turnRevision: number; closing: boolean; lost: boolean; sessionId?: string; resync?: Promise<void>
  /** Whether this host granted `sessionMcp`, so its sessions may be given Sotto's tool servers. */
  sessionMcp?: boolean
  /** Started for Watcher's thread with its launch profile: its session gets Watcher's tools and instructions, never the browser. */
  watcher: boolean
  /** This host resumed a session it was given Sotto's tool servers for, rather than starting one. */
  resumedWithTools?: boolean
  /**
   * Watcher's instructions are in its session's conversation: a turn Muse started on this host carried them, and nothing
   * since says the conversation was compacted (#1418). A new host, after a restart, a lost process or an idle close,
   * starts without, so the session it resumes is told them again.
   */
  instructed?: boolean
  /**
   * The last note sent said the conversation is new or was compacted. That line stays in each note until Watcher reads
   * its state, so only the first note to carry it, after one that did not, asks for the instructions again.
   */
  reminded?: boolean
  /**
   * Set once this host has built the thread's session runtime, by a start or the first resume, with the names of the
   * Sotto tools it was given. Later resumes on the same host send no servers: Muse keeps the ones it was built with,
   * and refuses a different set (`session_configuration_conflict`).
   */
  tools?: ReadonlySet<string>
  /** Approvals for this session's own Sotto tools that Sotto is answering, or answered and Muse may ask again at a later stage. */
  admitting?: Set<string>
  admitted?: Map<string, MuseApproval>
}
type Pending = MusePending & { rpc: MuseRpc; answerCommandId?: string }
/**
 * When a thread's running turn showed itself on this connection (#1420), as monotonic times, so its send's record can
 * hold how long Muse took to its first output and from its last output to saying the turn finished. Numbers only.
 */
interface TurnTimes { turnId: string; startedAt?: number; firstOutputAt?: number; lastOutputAt?: number; report?: (timings: TurnEndTimings) => void }
interface Fold {
  /** The newest copy of each item, so a delta or an update folds onto what came before it. */
  readonly items: Map<string, MuseItem>
  /** Streaming replies by item: the message as it stands and how much of it the log already holds. */
  readonly streams: Map<string, { messageId: string; text: string; recordedLength?: number }>
  /** MSP turn ID to the Sotto ID of the user message that opened it: the identity activity records share. */
  readonly turnMessages: Map<string, string>
  viewCursor: string
}
const freshFold = (): Fold => ({ items: new Map(), streams: new Map(), turnMessages: new Map(), viewCursor: '' })

export interface MuseMspOptions {
  executable?: string
  /** Read at each connect: start this machine's `muse serve` hosts without Muse's shell sandbox. Absent keeps the sandbox. */
  disableSandbox?: () => boolean
  /** Arguments before `serve`, used by the scripted provider. */
  args?: string[]
  environment?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  /** How long Muse waits for one tool call, in seconds; the fixture shortens Muse's 300. */
  toolWaitSeconds?: number
  reaperSweepMs?: number
  sessionIdleMs?: number
  /** Usage's startup answer (ADR-0083): count this computer's Muse threads and read Muse's subscription window. */
  usageEnabled?: boolean
}

/** Muse owns its sign-in, tools and durable sessions. Only alias and origin metadata belongs to Sotto. */
export class MuseMspHost implements AgentHost {
  private launchProfiles: ThreadLaunchProfiles | undefined
  /** The last profile main gave each Watcher thread: evidence for stopping it when main no longer resolves one, never a grant. */
  private readonly knownLaunchProfiles = new Map<string, WatcherLaunchProfile>()
  useLaunchProfiles(profiles: ThreadLaunchProfiles): void { this.launchProfiles = profiles }
  profileRefusalHandler(id: string) {
    const generation = this.generation, entry = this.processes.get(id)
    if (!entry) return undefined
    return (reason: string): void => {
      if (generation === this.generation && this.processes.get(id) === entry) this.revokeProfile(id, this.knownLaunchProfiles.get(id), reason)
    }
  }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new MuseUncertain('Muse connection changed before the operation could continue.')
  }
  /**
   * Watcher's launch profile for this thread, or undefined for every other thread (ADR-0073). A Watcher thread whose profile
   * main can no longer verify is stopped, its tools revoked, rather than left running without them.
   */
  private async launchProfile(id: string, rpc?: MuseRpc): Promise<WatcherLaunchProfile | undefined> {
    const generation = this.generation, resolver = this.launchProfiles, entry = this.processes.get(id)
    const current = (): boolean => generation === this.generation && resolver === this.launchProfiles && (!rpc || this.processes.get(id)?.rpc === rpc)
    try {
      const profile = await resolver?.profileFor(id)
      if (!current()) throw new MuseUncertain('Muse connection changed while checking the thread profile.')
      if (profile) { validateWatcherProfile(profile); this.knownLaunchProfiles.set(id, profile) }
      else if (this.knownLaunchProfiles.has(id)) throw new WatcherProfileRefusal('Watcher’s tools are no longer admitted. Its session was stopped. Reopen Watcher to recover.')
      return profile
    } catch (error) {
      if (!current()) throw new MuseUncertain('Muse connection changed while checking the thread profile.')
      const refusal = error instanceof WatcherProfileRefusal ? error : new WatcherProfileRefusal('Watcher’s saved profile could not be verified. Its session was stopped. Reopen Watcher to recover.')
      if (this.processes.get(id) === entry) {
        try { this.revokeProfile(id, this.knownLaunchProfiles.get(id), refusal.message) } catch { /* A broken server cleanup never keeps the process alive. */ }
      }
      throw refusal
    }
  }
  /** The profile, checked against the host already running the thread: one started without Watcher's tools is stopped. */
  private async checkLaunchProfile(id: string): Promise<WatcherLaunchProfile | undefined> {
    const generation = this.generation, entry = this.processes.get(id)
    const profile = await this.launchProfile(id)
    this.assertGeneration(generation)
    if (profile && entry && !entry.watcher) {
      const reason = 'This Muse host started without Watcher’s tools. Nothing was sent. Reopen Watcher.'
      this.revokeProfile(id, profile, reason)
      throw new WatcherProfileRefusal(reason)
    }
    return profile
  }
  /**
   * Watcher's session must leave its approvals to the user, and Muse must show it: every session it reports for Watcher
   * names the user as its reviewer, read back with `session/read` when the reply leaves its permission state out. A
   * session reviewed by anyone else, or one Muse cannot show, has its host stopped before anything is sent (ADR-0079).
   * Watcher's tools stay admitted, so the same start, replayed by its command ID, is checked again after Muse is updated.
   */
  private async proveReviewer(id: string, entry: ThreadProcess, session: MuseSession): Promise<void> {
    let authority = session.permissionState?.reviewerAuthority
    if (authority === undefined) {
      try { authority = sessionReadSchema.parse(await entry.rpc.request('session/read', { sessionId: session.sessionId, excludeItems: true })).session.permissionState?.reviewerAuthority }
      catch (error) { if (error instanceof MuseUncertain) throw error /* A refused or unreadable read proves nothing. */ }
    }
    if (authority === 'human') return
    const reason = authority === undefined ? MUSE_WATCHER_UNPROVEN : MUSE_WATCHER_REVIEWED
    this.revokeProfile(id, undefined, reason)
    throw new WatcherProfileRefusal(reason)
  }
  /** A start Muse refused because it cannot leave Watcher's approvals to the user, said as the refusal it is. */
  private watcherStartRefusal(id: string, error: unknown): unknown {
    if (!(error instanceof MuseRejected) || !error.reason || !MUSE_PROFILE_REFUSALS.has(error.reason)) return error
    this.revokeProfile(id, undefined, MUSE_WATCHER_REVIEWED)
    return new WatcherProfileRefusal(MUSE_WATCHER_REVIEWED)
  }
  /** A refusal ends the thread's host and, given the profile, revokes Watcher's tools, even if closing the host would fail. */
  private revokeProfile(id: string, profile: WatcherLaunchProfile | undefined, reason: string): void {
    const entry = this.processes.get(id)
    this.processes.delete(id); this.loaded.delete(id); this.outdated.delete(id); this.folds.delete(id); this.reaper.forget(id)
    this.requestChanges.delete(id); this.requestReads.delete(id)
    this.activePrompts.delete(id); this.activeTurns.delete(id); this.turnTimes.delete(id); this.log.release(id)
    for (const [requestId, pending] of this.pending) if (pending.threadId === id) this.pending.delete(requestId)
    const thread = this.threads.get(id)
    if (thread) { thread.requests = []; thread.status = 'error'; thread.requestNotice = reason; this.changed(id) }
    if (entry) this.closeProcess(entry)
    try { profile?.revoke(reason) } finally { this.emit() }
  }
  private browserTools: BrowserAgentTools | undefined
  useBrowserTools(tools: BrowserAgentTools): void { this.browserTools = tools }
  private threadTools: readonly ScopedThreadTools[] = []
  useThreadTools(tools: readonly ScopedThreadTools[]): void { this.threadTools = tools }
  /**
   * What the next `session/start` or `session/resume` on this host carries: Sotto's own tool servers for the thread
   * (the browser's, and each scoped server that answers for it, ADR-0056) the first time the host builds the session's
   * runtime, as Claude Code, Codex and Grok Build get them. Watcher's thread gets its own `sotto_threads` server and the
   * scoped servers Watcher takes, never the browser (ADR-0073). Nothing when the host did not grant `sessionMcp`, for a
   * personal chat, or once the runtime is built: a cold resume needs them again, because Muse keeps none across hosts.
   */
  private async sessionTools(id: string, entry: ThreadProcess): Promise<{ params: { config?: { mcpServers: Record<string, unknown> } }; tools: ReadonlySet<string> }> {
    if (entry.tools) return { params: {}, tools: entry.tools }
    if (!entry.sessionMcp || this.aliases[id]?.kind === 'personal') return { params: {}, tools: new Set() }
    const generation = this.generation
    const servers: { server: Parameters<typeof museToolServer>[0]; names: readonly string[] }[] = []
    if (entry.watcher) {
      const profile = await this.launchProfile(id, entry.rpc)
      if (!profile) throw new WatcherProfileRefusal('Watcher’s tools are no longer admitted. Nothing was sent. Reopen Watcher to recover.')
      servers.push({ server: profile.server, names: profile.toolNames })
      for (const { server, tools } of await scopedThreadServers(watcherThreadTools(this.threadTools), id)) servers.push({ server, names: tools.definitions.map(tool => tool.name) })
    } else {
      if (this.browserTools) servers.push({ server: await this.browserTools.mcpServer(id), names: this.browserTools.definitions.map(tool => tool.name) })
      for (const { server, tools } of await scopedThreadServers(this.threadTools, id)) servers.push({ server, names: tools.definitions.map(tool => tool.name) })
    }
    this.assertGeneration(generation)
    if (!servers.length) return { params: {}, tools: new Set() }
    // Each server goes by a name only this run's thread knows, so a user's own server cannot show its tool names (ADR-0079).
    let suffix = this.serverSuffixes.get(id)
    if (!suffix) { suffix = museServerSuffix(); this.serverSuffixes.set(id, suffix) }
    const named = servers.map(({ server, names }) => ({ server, names, name: museSessionServerName(server.name, suffix) }))
    return {
      params: { config: { mcpServers: Object.fromEntries(named.map(({ server, name }) => [name, museToolServer(server, this.options.toolWaitSeconds ?? MUSE_TOOL_WAIT_SECONDS)])) } },
      tools: new Set(named.flatMap(({ name, names }) => names.map(tool => museToolName(name, tool)))),
    }
  }
  /**
   * The suffix each thread's Sotto tool servers carry on Muse, for this run. It stays the same for the run, so a start
   * replayed after a lost acknowledgement matches the first, and is never saved: a new run names them afresh.
   */
  private readonly serverSuffixes = new Map<string, string>()
  /**
   * What a host built a thread's session runtime with. A thread on a host that did not grant session tool servers says
   * so, and Sotto offers no control that would need its tools; a personal chat never takes them and says nothing.
   */
  private builtWith(id: string, entry: ThreadProcess, tools: ReadonlySet<string>): void {
    entry.tools = tools
    if (!this.aliases[id]) return
    const thread = this.thread(id)
    if (!entry.sessionMcp && this.aliases[id]?.kind !== 'personal') thread.sottoToolsWithheld = true
    else delete thread.sottoToolsWithheld
  }
  /** An approval as it reaches the thread: one for this session's own Sotto tools is answered here, every other is shown. */
  private present(pending: MusePending, entry: ThreadProcess): void {
    if (pending.kind === 'approval' && this.admitOwnTool(pending, entry)) return
    this.showRequest(pending, entry)
  }
  /**
   * Answer Muse's prompt before a call to one of this session's own Sotto tools with its one-time allow (ADR-0079), as
   * Grok's adapter answers Grok's (ADR-0020, ADR-0035). It admits the agent to Sotto's own endpoint and nothing more; the
   * tools still ask the user wherever they always do. A request already shown is the user's to answer, and one Sotto
   * could not answer is shown after all. The decision is not awaited here: its reply comes on the frame queue.
   */
  private admitOwnTool(pending: Extract<MusePending, { kind: 'approval' }>, entry: ThreadProcess): boolean {
    const alias = this.aliases[pending.threadId]
    if (!alias?.museSessionId || alias.kind === 'personal' || !entry.tools?.size || this.pending.has(pending.request.id)) return false
    const choiceId = museToolAdmission(pending.approval, entry.tools)
    if (!choiceId) return false
    const admitting = entry.admitting ??= new Set(), admitted = entry.admitted ??= new Map()
    if (admitting.has(pending.request.id)) return true
    admitting.add(pending.request.id)
    admitted.set(pending.approval.approvalId, pending.approval)
    const generation = this.generation, threadId = pending.threadId, approvalId = pending.approval.approvalId
    void entry.rpc.request('approval/decide', {
      commandId: museCommandId(), sessionId: alias.museSessionId, approvalId,
      choiceId, requirementId: pending.approval.currentRequirementId,
    }).then(ack => { museApprovalDecidedSchema.parse(ack) }).catch(error => {
      if (generation !== this.generation || this.processes.get(threadId) !== entry) return
      if (error instanceof MuseRejected && error.kind === 'approvalAlreadyResolved') return
      // The approval moved on before this answer reached it, perhaps by an update Sotto had no stage for yet: read
      // what Muse holds now, which admits the current stage or shows it.
      if (error instanceof MuseRejected && error.kind === 'approvalRequirementStale') { void this.resync(threadId, entry).catch(() => undefined); return }
      // Resolved meanwhile, or a later stage took over this approval: there is nothing left to show.
      if (admitted.get(approvalId) !== pending.approval) return
      admitted.delete(approvalId); this.showRequest(pending, entry)
    }).finally(() => { admitting.delete(pending.request.id) })
    return true
  }
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  /** Whether `this.aliases` reflects the store: false until a `connect()` has loaded it once (ADR-0126). */
  private aliasesLoaded = false
  /** Threads `forgetThread` removed, kept so a `connect()` racing its disk write cannot bring one back. */
  private readonly forgottenAliasIds = new Set<string>()
  private readonly threads = new Map<string, AgentThread>()
  private readonly pending = new Map<string, Pending>()
  /** Only the current processes' request facts; a pending-list reply cannot overwrite a newer stream fact. */
  private readonly requestChanges = new Map<string, Map<string, number>>()
  private readonly requestReads = new Map<string, { count: number }>()
  private requestRevision = 0
  private readonly deliveries = new Map<string, { threadId: string; resolve(): void; reject(error: Error): void }>()
  private readonly activePrompts = new Set<string>()
  /**
   * How many times Muse has said each thread's session changed model. Muse's own word is newer than an answer to a
   * session/setModel that was waiting when it came, so that answer leaves the model alone.
   */
  private readonly modelChanges = new Map<string, number>()
  /**
   * How many times each thread's wanted model has been chosen, by the user or by Muse. An accepted session/setModel
   * makes its model the thread's own only if nothing chose another while it waited: a re-apply a resync started for
   * an older choice must not undo a newer one.
   */
  private readonly modelWants = new Map<string, number>()
  /** The turn each thread is running, by MSP turn ID, with the Sotto ID of the message that opened it. */
  private readonly activeTurns = new Map<string, { turnId: string; messageId?: string }>()
  private readonly turnTimes = new Map<string, TurnTimes>()
  private readonly folds = new Map<string, Fold>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly activityListeners = new ActivitySubscribers()
  /** Thread changes (ADR-0016, #925), published beside the activity snapshots from the same view. */
  private readonly threadChanges = new AdapterThreadChanges({
    view: historyFromEvents => this.activitySnapshot(historyFromEvents),
    thread: (id, historyFromEvents) => this.activityThread(id, historyFromEvents),
    rest: () => { certifyActivityView(this.state, []); return restOf(this.state) },
  })
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    for (const listener of this.listeners) listener(this.current())
    this.activityListeners.publish(historyFromEvents => this.activitySnapshot(historyFromEvents))
    this.threadChanges.publish()
  }, () => adapterItemCount(this.log, this.threads.values()))
  /** One `muse serve` process per thread session (ADR-0038): one ending fails only its own thread. */
  private readonly processes = new Map<string, ThreadProcess>()
  private readonly outdated = new Set<string>()
  private readonly holds = new Map<string, number>()
  private readonly exits = new Set<Promise<void>>()
  private executable: string | undefined
  private clientRevision = 0
  /** The sandbox posture captured at the last connect; every host this connection spawns keeps it, so a changed setting applies on reconnect. */
  private serveSandboxDisabled = false
  /** The permission modes this machine's client let a probe select, which is all its threads may be offered. */
  private offeredModes: readonly MuseRuntimeMode[] = ['approval-required']
  private writing = Promise.resolve()
  private readonly log = new ThreadMessageLog(id => this.threadChanges.mark(id))
  private history: ThreadHistorySource | undefined
  private readonly observed = new Set<string>()
  private readonly loaded = new OpenSessions(id => this.threads.get(id), id => this.threadChanges.mark(id))
  private readonly loading = new Map<string, Promise<void>>()
  private readonly readsBeforeSend = new ReadsBeforeSend(id => this.readState(id))
  private readonly reaper: SessionReaper
  private generation = 0
  private state: AgentHostSnapshot = {
    connected: false, name: 'Muse', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true, configureThreadModel: true, skills: false, steer: true, compact: true },
  }
  /** Present only where Usage is on: each model call's tokens, under the thread's own ID. */
  readonly subscribeUsage?: (listener: (record: UsageTokenObservation) => void) => () => void
  readonly readProviderQuota?: (providerId: ProviderId, refresh: boolean) => Promise<UsageQuotaRead>
  private readonly observedUsage: ObservedUsage | undefined
  /**
   * The freshest subscription window any of this computer's Muse hosts reported. Muse keeps it in each serve host's memory
   * and reports it after a model call, so Sotto keeps the newest it was told for as long as it runs.
   */
  private quota: UsageQuotaRead | undefined
  private quotaReading: Promise<UsageQuotaRead> | undefined
  /** When each running turn was seen to start, by MSP turn ID: a live start is what lets its work count after Clear usage. */
  private readonly usageTurnStarts = new Map<string, string>()
  constructor(private readonly userDataDirectory: string, private readonly options: MuseMspOptions = {}) {
    if (options.usageEnabled === true) {
      const observed = new ObservedUsage('muse')
      this.observedUsage = observed
      this.subscribeUsage = listener => observed.subscribe(listener)
      this.readProviderQuota = async (providerId, refresh) => {
        if (providerId !== 'muse') return unavailableProviderQuota(providerId, 'unsupported')
        if (!this.state.connected) return unavailableProviderQuota('muse', 'not-connected')
        if (this.quota && !refresh) return { ...this.quota, refreshable: this.liveHosts().length > 0 }
        this.quotaReading ??= this.readQuota().finally(() => { this.quotaReading = undefined })
        return this.quotaReading
      }
    }
    this.aliasStore = new AtomicJsonStore(join(userDataDirectory, 'muse-threads.json'), preserveLegacyAliases(z.record(z.string(), aliasSchema).parse), () => ({}))
    this.projectStore = new AtomicJsonStore(join(userDataDirectory, 'muse-projects.json'), z.array(agentProjectSchema).parse, () => [])
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs !== undefined ? { sweepEveryMs: options.reaperSweepMs } : {}),
      ...(options.sessionIdleMs !== undefined ? { idleAfterMs: options.sessionIdleMs } : {}),
      isWatched: id => this.observed.has(id),
      isBusy: id => this.busy(id),
      stop: id => this.stopSession(id),
    })
  }
  private busy(id: string): boolean {
    const thread = this.threads.get(id)
    return this.holds.has(id) || this.activePrompts.has(id) || this.activeTurns.has(id) || this.loading.has(id)
      || !!thread && (thread.status === 'running' || thread.requests.length > 0)
  }
  private current(historyFromEvents = false): AgentHostSnapshot {
    if (historyFromEvents) return cloneActivitySnapshot(this.activitySnapshot(true))
    return cloneHostSnapshot({ ...this.state, threads: [...this.threads.values()].map(thread => this.log.publishedThread(thread)) })
  }
  private activitySnapshot(historyFromEvents: boolean): AgentHostSnapshot {
    certifyActivityView(this.state, this.threads.values())
    return { ...this.state, threads: [...this.threads.values()].map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
  /** One thread as `activitySnapshot` lists it, for the thread changes of the threads marked changed. */
  private activityThread(id: string, historyFromEvents: boolean): AgentThread | undefined {
    const thread = this.threads.get(id)
    if (!thread) return undefined
    certifyActivityView(this.state, [thread])
    return this.log.activityThread(thread, historyFromEvents)
  }
  /**
   * This thread's state changed (ADR-0016, #925): its next thread changes carry it. `thread`, which most paths that
   * write into a thread take it from, marks it; a frame from the thread's host marks it again once applied; and a path
   * that writes without it, or after a publication may have gone, marks it where it writes. One that writes into every
   * thread marks them all. What goes through the message log and the open-session set is marked by them.
   */
  private changed(id: string): void { this.threadChanges.mark(id) }
  private emit(streaming = false): void { this.publisher.publish(streaming); this.stopOutdated() }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    return this.threadChanges.subscribeActivityChanges(listener, options)
  }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  useThreadHistory(source: ThreadHistorySource): void { this.history = source }
  private persist(): Promise<void> { this.writing = this.aliasStore.write(structuredClone(this.aliases)); return this.writing }
  /**
   * ADR-0126: stop the thread's own `muse serve` host if it has one, remove its alias and every per-thread record
   * this adapter keeps, and persist. Guarded with `forgottenAliasIds` against a `connect()` that reads the alias
   * store before this removal reaches disk (see there).
   */
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
    await this.stopSession(id)
    this.reaper.forget(id)
    this.observed.delete(id)
    this.outdated.delete(id)
    this.holds.delete(id)
    this.activePrompts.delete(id)
    this.modelChanges.delete(id)
    this.modelWants.delete(id)
    this.activeTurns.delete(id)
    this.turnTimes.delete(id)
    for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id) this.pending.delete(requestId)
    for (const [messageId, delivery] of [...this.deliveries]) {
      if (delivery.threadId !== id) continue
      delivery.reject(new MuseUncertain('The thread was deleted.'))
      this.deliveries.delete(messageId)
    }
    this.log.forget(id)
    this.threads.delete(id)
    delete this.aliases[id]
    await this.persist()
    if (this.state.connected) this.emit()
  }
  private thread(id: string): AgentThread {
    const alias = this.aliases[id]; if (!alias) throw new Error('The Muse thread does not exist.')
    if (!this.threads.has(id)) this.threads.set(id, {
      id, projectId: alias.projectId, workingDirectory: alias.cwd, title: alias.title,
      // The model Muse last accepted; until Muse has named one, the thread's own, which its status marks unconfirmed.
      modelId: alias.nativeModelId ?? alias.modelId,
      runtimeMode: alias.runtimeMode ?? 'approval-required',
      ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}),
      status: alias.museSessionId ? settledStatus(alias) : 'error',
      messages: [], requests: [], manualCompactionSupported: true,
    })
    this.changed(id)
    return this.threads.get(id)!
  }
  private fold(id: string): Fold {
    let fold = this.folds.get(id)
    if (!fold) { fold = freshFold(); this.folds.set(id, fold) }
    return fold
  }
  private markTurn(id: string, status: AgentActivity['status'], turnId?: string, error?: string): void {
    const thread = this.threads.get(id); if (!thread) return
    const last = this.log.lastUserMessageId(id)
    const turn = turnId ?? last
    if (turn === undefined) return
    thread.activities = markTurnActivity(thread.activities, {
      provider: 'muse', turnId: turn, status,
      ...(last === turn ? { afterMessageId: turn } : {}), ...(error !== undefined ? { error } : {}),
    })
    this.changed(id)
  }
  private spawn(executable: string, lost: () => void, ephemeral = false): MuseRpc {
    const rpc: MuseRpc = new MuseRpc(executable, [...(this.options.args ?? []), ...museServeArguments(this.serveSandboxDisabled), ...(ephemeral ? ['--no-session-log'] : [])],
      this.userDataDirectory, museEnvironment(this.options.environment), this.options.requestTimeoutMs ?? 15_000,
      frame => this.frame(frame, rpc), lost)
    const exit = rpc.closed.finally(() => { this.exits.delete(exit) }); this.exits.add(exit)
    return rpc
  }
  /**
   * Ask a host which client it is, and for session tool servers: a client that does not know the capability simply
   * leaves it out of its grant, so asking costs nothing at the floor. Whether Sotto will drive it is `clientRefusal`'s answer.
   */
  private async identify(rpc: MuseRpc, watcher = false): Promise<MuseClient> {
    // Watcher's host also asks for the experimental surface, where a session reports who reviews its approvals (ADR-0079).
    const client = initializeSchema.parse(await rpc.request('initialize', { clientInfo: { name: 'sotto', title: 'Sotto', version: appVersion },
      capabilities: { requestedCapabilities: [SESSION_MCP], ...(watcher ? { experimentalApi: true } : {}) } }))
    rpc.notify('initialized')
    return client
  }
  private applyClient(client: MuseClient, models: z.infer<typeof modelListSchema>['models'], nativeVersion?: string): void {
    this.state.version = `${nativeVersion ?? client.serverInfo.version} / MSP ${MUSE_MSP_VERSION}`
    if (compareClientVersions(client.serverInfo.version, MUSE_CLI_VERSION) > 0) this.state.verifiedVersion = MUSE_CLI_VERSION
    else delete this.state.verifiedVersion
    // The posture the running hosts were spawned with, so Settings can tell a saved change from a live one.
    this.state.sandboxDisabled = this.serveSandboxDisabled
    this.state.models = models.map(model => ({
      id: model.modelId, name: model.displayLabel, provider: 'Muse', ready: true,
      runtimeModes: [...this.offeredModes], supportsImages: true,
      reasoningEfforts: [...MUSE_EFFORTS], defaultReasoningEffort: MUSE_DEFAULT_EFFORT,
      ...(model.isDefault ? { recommended: true } : {}),
    }))
  }
  /**
   * Which permission modes this host lets a session select. The startup mode is sealed, and a mode above or
   * beside it is refused, so the only honest catalog is a probe: one throwaway session per candidate, on a
   * memory-only host, where nothing is kept. The asking mode needs no probe; it is what a session starts on.
   */
  private async probeModes(rpc: MuseRpc): Promise<void> {
    const offered: MuseRuntimeMode[] = ['approval-required']
    for (const mode of ['auto', 'full-access'] as const) {
      try {
        sessionStartSchema.parse(await rpc.request('session/start', { commandId: museCommandId(), workspaceRoot: this.userDataDirectory, approvalMode: MSP_MODE[mode] }))
        offered.push(mode)
      } catch { /* A refusal of any kind leaves the mode unoffered rather than promised. */ }
    }
    this.offeredModes = offered
  }
  private async threadProcess(id: string): Promise<ThreadProcess> {
    const generation = this.generation
    const profile = await this.checkLaunchProfile(id)
    this.assertGeneration(generation)
    const current = this.processes.get(id); if (current) return current.ready
    const executable = this.executable
    if (!this.state.connected || !executable) return Promise.reject(new Error('Connect Muse before managing threads.'))
    const replacement = this.processes.get(id); if (replacement) return replacement.ready
    const entry = { clientRevision: this.clientRevision, turnRevision: 0, closing: false, lost: false, watcher: profile !== undefined } as ThreadProcess
    entry.rpc = this.spawn(executable, () => this.processLost(id, entry))
    entry.ready = (async () => {
      try {
        const client = await this.identify(entry.rpc, entry.watcher)
        const refusal = clientRefusal(client)
        if (refusal) throw refusal
        entry.sessionMcp = client.grantedCapabilities.includes(SESSION_MCP)
        // Watcher works only through its tools, so a host that cannot take them never starts it (ADR-0079).
        if (entry.watcher && !entry.sessionMcp) throw new WatcherProfileRefusal(MUSE_WATCHER_WITHOUT_TOOLS)
      } catch (error) {
        if (this.processes.get(id) === entry) this.processes.delete(id)
        this.closeProcess(entry)
        if (error instanceof MuseUnsupported) throw new Error(`Muse could not start this thread. ${error.message} Nothing was sent to it.`, { cause: error })
        throw error
      }
      if (generation !== this.generation || this.processes.get(id) !== entry) throw new MuseUncertain('Muse connection changed while starting the thread.')
      return entry
    })()
    this.processes.set(id, entry)
    return entry.ready
  }
  private processLost(id: string, entry: ThreadProcess): void {
    if (entry.closing) return
    entry.lost = true
    if (this.processes.get(id) !== entry) return
    this.processes.delete(id); this.outdated.delete(id); this.requestChanges.delete(id); this.requestReads.delete(id)
    this.loaded.delete(id); this.folds.delete(id); this.log.release(id); this.reaper.forget(id)
    for (const pending of [...this.pending.values()]) if (pending.threadId === id) this.pending.delete(pending.request.id)
    const sending = this.activePrompts.delete(id)
    for (const [messageId, delivery] of this.deliveries) {
      if (delivery.threadId !== id) continue
      delivery.reject(new MuseUncertain('Muse stopped before confirming this prompt.'))
      this.deliveries.delete(messageId)
    }
    const active = this.activeTurns.get(id); this.activeTurns.delete(id); this.turnTimes.delete(id)
    const thread = this.threads.get(id), alias = this.aliases[id]
    if (thread) {
      thread.requests = []
      if (active) {
        if (alias) alias.endedTurn = { turnId: active.turnId, outcome: 'failed' }
        void this.persist().catch(() => undefined)
        thread.status = 'error'; this.markTurn(id, 'failed', active.messageId, THREAD_PROCESS_LOST)
        if (active.messageId) thread.lastTurn = { id: active.messageId, status: 'failed' }
      } else if (sending) thread.status = 'error'
      this.changed(id)
    }
    // This also handles an unreadable notification: it must end the host, not just forget a live child.
    this.closeProcess(entry)
    this.emit()
  }
  private closeProcess(entry: ThreadProcess): void { entry.closing = true; entry.rpc.close() }
  private async stopSession(id: string): Promise<void> {
    const entry = this.processes.get(id)
    if (this.loaded.delete(id)) this.emit()
    this.folds.delete(id); this.log.release(id)
    if (!entry) return
    this.processes.delete(id); this.outdated.delete(id); this.requestChanges.delete(id); this.requestReads.delete(id)
    // Ending the host ends its session with it; Muse's own log keeps the conversation for the next resume.
    this.closeProcess(entry)
    await entry.rpc.closed
  }
  private hold(id: string): () => void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1)
    let held = true
    return () => {
      if (!held) return
      held = false
      const left = (this.holds.get(id) ?? 1) - 1
      if (left > 0) this.holds.set(id, left); else this.holds.delete(id)
      this.stopOutdated()
    }
  }
  private stopOutdated(): void {
    if (!this.outdated.size) return
    for (const id of [...this.outdated]) {
      const entry = this.processes.get(id)
      if (!entry || entry.clientRevision === this.clientRevision) { this.outdated.delete(id); continue }
      if (this.busy(id)) continue
      this.outdated.delete(id)
      const generation = this.generation
      void this.stopSession(id).then(() => {
        if (generation !== this.generation || !this.observed.has(id) || !this.aliases[id]?.museSessionId) return
        return this.open(id)
      }).catch(() => { if (generation === this.generation && this.processes.get(id) === entry) this.outdated.add(id) })
    }
  }
  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    await mkdir(this.userDataDirectory, { recursive: true })
    const executable = this.options.executable ?? await findMuseExecutable(this.options.environment)
    if (!executable || !isAbsolute(executable)) throw new ProviderUnavailable('not-installed', 'Install Muse and run muse login, then connect again. Your threads and drafts are kept.')
    const readAliases = await this.aliasStore.read()
    for (const id of this.forgottenAliasIds) delete readAliases[id]
    this.aliases = readAliases; this.aliasesLoaded = true; this.state.projects = await this.projectStore.read()
    this.threads.clear(); this.threadChanges.markAll(); this.activePrompts.clear(); this.activeTurns.clear(); this.folds.clear(); this.readsBeforeSend.clear()
    if (generation !== this.generation) throw new Error('Muse connection was cancelled.')
    this.executable = executable
    // The sandbox posture for everything this connection spawns, probes included: sealed by each host at
    // startup, so it is captured here and a changed setting applies on the next connect.
    this.serveSandboxDisabled = this.options.disableSandbox?.() === true
    let tooOld: string | undefined
    // Connecting checks the client, its catalog and its mode ceiling on a memory-only host of its own, which
    // ends once it has answered. Threads start their own durable hosts as they are needed.
    const probe: MuseRpc = new MuseRpc(executable, [...(this.options.args ?? []), ...museServeArguments(this.serveSandboxDisabled), '--no-session-log'],
      this.userDataDirectory, museEnvironment(this.options.environment), this.options.requestTimeoutMs ?? 15_000,
      frame => this.unsupported(probe, frame), () => undefined)
    const probeExit = probe.closed.finally(() => { this.exits.delete(probeExit) }); this.exits.add(probeExit)
    try {
      const client = await this.identify(probe)
      const refusal = clientRefusal(client)
      if (refusal instanceof MuseTooOld) tooOld = refusal.version
      if (refusal) throw refusal
      const catalog = modelListSchema.parse(await probe.request('model/list', {}))
      // A client with no sign-in resolves no catalog: that is the refusal a host's tile offers the sign-in command for.
      if (signedOutCatalog(catalog)) throw new ProviderUnavailable('signed-out', 'Sign in to Muse on this machine with muse login, then connect it again.', client.serverInfo.version)
      if (!catalog.models.length) throw new ProviderUnavailable('cannot-start', 'Muse is set up but listed no models, so there is nothing to start a thread with. Your threads and drafts are kept. Run muse in a terminal on this machine to see why, then connect it again.', client.serverInfo.version)
      await this.probeModes(probe)
      const nativeVersion = await museVersionForExecutable(executable, client.serverInfo.version)
      if (generation !== this.generation) throw new Error('Muse connection was cancelled.')
      this.applyClient(client, catalog.models, nativeVersion)
      this.log.forgetAll()
      for (const id of Object.keys(this.aliases)) { this.thread(id); this.log.seed(id, this.history?.messageIdentities(id) ?? []) }
      this.state.connected = true; delete this.state.error
      await Promise.all(Object.keys(this.aliases).filter(id => this.aliases[id]?.museSessionId && this.observed.has(id)).map(id => this.open(id).catch(() => undefined)))
      if (generation !== this.generation) throw new Error('Muse connection was cancelled.')
      this.reaper.start()
      this.emit(); return this.current()
    } catch (error) {
      if (generation === this.generation) this.disconnect()
      if (error instanceof WatcherProfileRefusal) throw error
      const refused = error instanceof MuseUnsupported || error instanceof ProviderUnavailable
      const detail = refused || error instanceof MuseUncertain ? error.message : ''
      const message = ['Could not connect Muse.', detail, refused ? '' : 'Connect again to retry.'].filter(Boolean).join(' ')
      if (error instanceof ProviderUnavailable) throw new ProviderUnavailable(error.problem, message, error.version, error.requiredVersion)
      if (tooOld) throw new ProviderUnavailable('too-old', message, tooOld, MUSE_CLI_VERSION)
      throw new Error(message, { cause: error })
    } finally { probe.close() }
  }
  async clientUpdated(): Promise<void> {
    if (!this.state.connected) return
    const generation = this.generation
    const executable = await Promise.resolve(this.options.executable ?? findMuseExecutable(this.options.environment)).catch(() => undefined)
    if (generation !== this.generation || !this.state.connected) return
    if (!executable || !isAbsolute(executable)) throw new Error('Muse was updated, but Sotto cannot find it now. Threads that are working carry on and nothing was lost. Check the Muse install, then connect Muse again.')
    const probe: MuseRpc = new MuseRpc(executable, [...(this.options.args ?? []), ...museServeArguments(this.serveSandboxDisabled), '--no-session-log'],
      this.userDataDirectory, museEnvironment(this.options.environment), this.options.requestTimeoutMs ?? 15_000,
      frame => this.unsupported(probe, frame), () => undefined)
    const probeExit = probe.closed.finally(() => { this.exits.delete(probeExit) }); this.exits.add(probeExit)
    let client: MuseClient, catalog: z.infer<typeof modelListSchema>
    try {
      client = await this.identify(probe)
      const refusal = clientRefusal(client)
      if (refusal) throw new Error(`Muse was updated, but Sotto cannot run the new version. ${refusal.message} Threads that are working carry on and nothing was lost. Install a Muse version Sotto supports, then connect Muse again.`, { cause: refusal })
      catalog = modelListSchema.parse(await probe.request('model/list', {}))
      if (signedOutCatalog(catalog)) throw new Error('Muse was updated, but its new client is not signed in. Working threads carry on and nothing was lost. Run muse login, then connect Muse again.')
      if (!catalog.models.length) throw new Error('Muse was updated, but its new client listed no models. Working threads carry on and nothing was lost. Run muse in a terminal to see why, then connect Muse again.')
      await this.probeModes(probe)
    } catch (error) {
      if (generation !== this.generation || !this.state.connected) return
      throw error instanceof Error && error.message.startsWith('Muse was updated') ? error
        : new Error('Muse was updated, but the new version did not answer. Threads that are working carry on and nothing was lost. Connect Muse again to try the new version.', { cause: error })
    } finally { probe.close() }
    if (generation !== this.generation || !this.state.connected) return
    const nativeVersion = await museVersionForExecutable(executable, client.serverInfo.version)
    if (generation !== this.generation || !this.state.connected) return
    this.executable = executable; this.clientRevision++
    this.applyClient(client, catalog.models, nativeVersion)
    for (const [id, entry] of this.processes) if (entry.clientRevision < this.clientRevision) this.outdated.add(id)
    this.emit()
  }
  private unsupported(rpc: MuseRpc, frame: MuseFrame): void {
    if (frame.method && frame.id !== undefined) rpc.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported client method' } })
  }
  /** Thread hosts with a session, the only ones that can have seen a model call. */
  private liveHosts(): ThreadProcess[] {
    return [...this.processes.values()].filter(entry => entry.sessionId !== undefined && !entry.closing && !entry.lost)
  }
  /** A reading replaces the kept one only when it is at least as new: each host reports the same account at its own time. */
  private keepQuota(value: unknown): void {
    const quota = parseMuseQuota(value)
    if (!quota?.observedAt) return
    if (this.quota?.observedAt && Date.parse(this.quota.observedAt) > Date.parse(quota.observedAt)) return
    this.quota = quota
  }
  /**
   * Ask every running thread host for the window it last saw (`usage/read`, MSP Developer Preview). It makes no model call
   * and starts nothing; with no host running, the last reading kept stands. A client without the method is `unsupported`.
   */
  private async readQuota(): Promise<UsageQuotaRead> {
    const hosts = this.liveHosts()
    const answers = await Promise.all(hosts.map(async entry => {
      try { this.keepQuota(await entry.rpc.request('usage/read', {}, MUSE_USAGE_READ_MS)); return 'read' as const }
      catch (error) { return methodMissing(error) ? 'missing' as const : 'failed' as const }
    }))
    if (!this.state.connected) return unavailableProviderQuota('muse', 'not-connected')
    if (this.quota) return { ...this.quota, refreshable: hosts.length > 0 }
    if (answers.length > 0 && answers.every(answer => answer === 'missing')) return unavailableProviderQuota('muse', 'unsupported')
    // Nothing seen yet: a host reports the window only after a model call, and only while it runs.
    return unavailableProviderQuota('muse', 'not-reported', hosts.length > 0)
  }
  /** The host that ran a turn has seen the window, which it would take with it when it stops. */
  private readQuotaAfterTurn(rpc: MuseRpc): void {
    if (!this.readProviderQuota) return
    void rpc.request('usage/read', {}, MUSE_USAGE_READ_MS).then(value => this.keepQuota(value), () => undefined)
  }
  /** One model completion's tokens for Usage. The thread's own readout is `session/tokenUsage`'s as before. */
  private observeTokenCall(owner: string, params: unknown, modelId: string | undefined): void {
    if (!this.observedUsage) return
    const parsed = tokenCallSchema.safeParse(params)
    if (!parsed.success) return
    const call = parsed.data
    const identity = call.sourceRange ? JSON.stringify(['records', call.sourceRange.first.id, call.sourceRange.last.id])
      : call.turnId !== undefined && call.cumulative ? JSON.stringify(['turn', call.turnId, call.cumulative.promptTokens ?? null, call.cumulative.outputTokens ?? null]) : undefined
    // A completion Muse gives no way to recognise again could be counted twice, so it is left out.
    if (identity === undefined) return
    const tokens: UsageTokens = {
      // Prompt tokens are counted once under the provider's cache convention, cache reads among them.
      input: tokenCount(call.promptTokens) ?? tokenCount(call.usage.inputTokens), output: tokenCount(call.usage.outputTokens),
      cached: tokenCount(call.usage.cacheReadTokens) ?? tokenCount(call.usage.cachedTokens), cacheWrite: tokenCount(call.usage.cacheWriteTokens),
    }
    this.observedUsage.publish(owner, identity, modelId ?? this.threads.get(owner)?.modelId ?? '', tokens,
      { phase: 'live', at: new Date().toISOString(), ...(call.turnId !== undefined ? { group: call.turnId, groupStartedAt: this.usageTurnStarts.get(call.turnId) } : {}) })
  }
  /**
   * Early start (#769): a thread Muse already has opens its session, as a send would. A thread whose first
   * send has not happened gets the host that send would start, identified and nothing more.
   */
  async startThreadSession(id: string, draft?: ThreadSessionDraft): Promise<void> {
    const generation = this.generation
    await this.checkLaunchProfile(id)
    this.assertGeneration(generation)
    if (!this.state.connected) return
    if (this.aliases[id]) { await this.open(id); return }
    if (!draft) return
    await this.threadProcess(id)
    this.assertGeneration(generation)
    this.reaper.touch(id)
  }
  observeThreads(ids: readonly string[]): void {
    const generation = this.generation
    const before = new Set(this.observed)
    this.observed.clear(); for (const id of ids) this.observed.add(id)
    this.log.observe([...this.observed])
    if (!this.state.connected) return
    for (const id of this.observed) {
      if (!this.aliases[id]?.museSessionId) continue
      if (before.has(id) && this.loaded.has(id)) continue
      void this.open(id).catch(() => {
        if (generation === this.generation) { this.state.error = 'A Muse thread could not be loaded. Check the native client.'; this.emit() }
      })
    }
  }
  async snapshot(): Promise<AgentHostSnapshot> { return this.current() }
  private readState(id: string): string { return `${this.generation}:${this.folds.get(id)?.viewCursor ?? 'unread'}` }
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    await this.sync(id, purpose)
    this.readsBeforeSend.mark(id, purpose)
    return this.current(purpose?.historyFromEvents)
  }
  /** Bring a thread up to date: open its session if this connection has not, since a loaded one streams live. */
  private async sync(id: string, purpose?: ThreadReadPurpose): Promise<void> {
    const alias = this.aliases[id]
    if (!alias?.museSessionId && !alias?.startCommandId) throw new Error('This Muse thread has no confirmed provider session.')
    await this.open(id)
    if (purpose?.retryUncertainAnswers) await this.retryUncertainAnswers(id, purpose.retryUncertainAnswerId)
  }
  /**
   * An answer whose acknowledgement was lost is checked against what Muse still holds open: a request it no
   * longer lists was settled by that answer, and one it still lists may be answered afresh. Nothing is resent.
   */
  private async retryUncertainAnswers(id: string, only?: string): Promise<void> {
    const entry = this.processes.get(id), alias = this.aliases[id]
    if (!entry || !alias?.museSessionId) return
    const releaseRead = this.holdPendingRead(id)
    try {
      const generation = this.generation, revision = this.requestRevision
      const held = [...this.pending.values()].filter(pending => pending.threadId === id)
      const listed = listPendingSchema.parse(await entry.rpc.request('approval/listPending', { sessionId: alias.museSessionId }))
      if (generation !== this.generation || this.processes.get(id) !== entry) return
      const restored = listed.approvals.map(approval => museApprovalPending(id, approval)).filter(pending => this.requestUnchanged(pending, revision))
      const unchanged = held.filter(pending => this.pending.get(pending.request.id) === pending && this.requestUnchanged(pending, revision))
      const open = new Set([...listed.approvals.map(item => museApprovalPending(id, item).request.id), ...listed.userInputs.map(item => item.userInputId)])
      let changed = false
      for (const pending of unchanged) {
        if (pending.request.delivery !== 'uncertain') continue
        if (only && pending.request.id !== only) continue
        changed = true
        if (!open.has(pending.request.id)) this.removeRequest(pending)
        else {
          pending.answering = false; delete pending.answerCommandId; delete pending.request.delivery; pending.request.answerRetryReady = true
          this.changed(pending.threadId)
          this.recordRequestChange(pending)
        }
      }
      for (const approval of restored) this.present(approval, entry)
      if (changed) this.emit()
    } finally { releaseRead() }
  }
  /**
   * Open this thread's session on its own host, once per connection. A creation whose acknowledgement was
   * lost is finished first: `session/start` is idempotent by command ID, so asking again with the same one
   * returns the session it made instead of making another.
   */
  private open(id: string): Promise<void> {
    const generation = this.generation
    const alias = this.aliases[id]
    if (!alias || !this.state.connected) return Promise.resolve()
    this.reaper.touch(id)
    if (this.loaded.has(id)) return Promise.resolve()
    const pending = this.loading.get(id); if (pending) return pending
    const work = (async () => {
      const entry = await this.threadProcess(id)
      this.assertGeneration(generation)
      if (this.processes.get(id) !== entry) throw new MuseUncertain('Muse thread process changed before its session could open.')
      if (!alias.museSessionId && alias.startCommandId) {
        const tools = await this.sessionTools(id, entry)
        this.assertGeneration(generation)
        const start = () => entry.rpc.request('session/start', startParams(alias, tools.params, entry.watcher))
        let reply: unknown
        try { reply = await start() } catch (error) {
          if (!(error instanceof MuseRejected && error.reason === 'command_id_conflict')) throw entry.watcher ? this.watcherStartRefusal(id, error) : error
          // The first start reached Muse carrying tool servers this run cannot repeat: a restart gives them a new
          // address and token, and Muse refuses a changed replay. Sotto never learned that session, so no turn ran in
          // it; a fresh start loses nothing and leaves an empty session behind in Muse.
          alias.startCommandId = museCommandId(); await this.persist()
          try { reply = await start() } catch (retry) { throw entry.watcher ? this.watcherStartRefusal(id, retry) : retry }
        }
        const started = sessionStartSchema.parse(reply)
        if (entry.watcher) await this.proveReviewer(id, entry, started.session)
        this.builtWith(id, entry, tools.tools)
        alias.museSessionId = started.session.sessionId
        entry.sessionId = alias.museSessionId
        this.confirmSession(id, alias, started.session)
        await this.persist()
      }
      if (!alias.museSessionId) return
      entry.sessionId = alias.museSessionId
      const turnRevision = entry.turnRevision
      const tools = await this.sessionTools(id, entry)
      this.assertGeneration(generation)
      const beforeResume = this.modelRevisions(id)
      const resumed = sessionResumeSchema.parse(await entry.rpc.request('session/resume', {
        commandId: museCommandId(), sessionId: alias.museSessionId, excludeItems: false, ...tools.params,
      }))
      if (entry.watcher) await this.proveReviewer(id, entry, resumed.session)
      if (tools.tools.size) entry.resumedWithTools = true
      this.builtWith(id, entry, tools.tools)
      if (this.processes.get(id) !== entry) return
      this.assertGeneration(generation)
      const items = resumed.history.items ?? resumed.history.snapshot?.state.items
      if (!items) throw new MuseUnreadable('Muse did not serve this thread’s history.')
      const fold = this.fold(id)
      fold.viewCursor = resumed.viewCursor
      this.foldHistory(id, alias, items)
      // Nothing is held back while the model is set again, and a running turn is left alone: the next send asks again.
      // A turn can start while the resume is answered, so the live turn counts as well as the session's description.
      const running = resumed.session.status === 'running' || this.activeTurns.has(id) || this.activePrompts.has(id)
      if (this.confirmSession(id, alias, resumed.session, true) && !running) {
        await this.reapplyModel(id, alias, entry, resumed.session, beforeResume)
        if (this.processes.get(id) !== entry) return
        this.assertGeneration(generation)
      }
      if (entry.turnRevision === turnRevision) this.reconcileLiveSession(id, resumed.session)
      this.settleEndedTurn(id, resumed.session)
      await this.persist()
      // Requests Muse still holds open are shown again, except one an uncertain answer may have settled.
      if (resumed.pendingRequests.length) {
        const releaseRead = this.holdPendingRead(id)
        try {
          const revision = this.requestRevision
          const listed = listPendingSchema.parse(await entry.rpc.request('approval/listPending', { sessionId: alias.museSessionId }))
          if (generation !== this.generation || this.processes.get(id) !== entry) return
          const restored = [...listed.approvals.map(approval => museApprovalPending(id, approval)),
            ...listed.userInputs.map(input => museUserInputPending(id, input))].filter(pending => this.requestUnchanged(pending, revision))
          for (const pending of restored) this.present(pending, entry)
        } finally { releaseRead() }
      }
      this.loaded.add(id); this.log.pin(id); this.reaper.touch(id); this.emit()
    })().finally(() => { if (this.loading.get(id) === work) this.loading.delete(id); this.stopOutdated() })
    this.loading.set(id, work)
    return work
  }
  /**
   * What a session Muse reported settles: its model, its mode, and whether the wanted settings are its own. Muse runs a
   * session on the model it started on or was last set to, and says so in its start reply and with session/modelChanged,
   * but 1.4.10 describes a resumed or read session by its catalog's default model. So a reopened session's description
   * never sets the thread's model; it returns whether to set the model again, because the description names another
   * model or Muse has not accepted the thread's own.
   */
  private confirmSession(id: string, alias: Alias, session: MuseSession, reopened = false): boolean {
    const reapply = reopened && (alias.nativeModelId !== alias.modelId || Boolean(session.modelId && session.modelId !== alias.modelId))
    if (session.modelId && !reopened) alias.nativeModelId = session.modelId
    const reported = runtimeModeOf(session.approvalMode?.mode)
    if (alias.pendingRuntimeMode && reported === alias.pendingRuntimeMode) { alias.runtimeMode = alias.pendingRuntimeMode; delete alias.pendingRuntimeMode }
    else if (!alias.pendingRuntimeMode && session.approvalMode) alias.runtimeMode = reported
    this.thread(id).runtimeMode = alias.runtimeMode ?? 'approval-required'
    this.settleSettings(id, alias)
    return reapply
  }
  /** How many model changes Muse has announced for the thread, and how many times its wanted model was chosen. */
  private modelRevisions(id: string): { readonly changes: number; readonly wants: number } {
    return { changes: this.modelChanges.get(id) ?? 0, wants: this.modelWants.get(id) ?? 0 }
  }
  /** Makes `modelId` the model the thread wants, and counts the choice (see `modelWants`). */
  private want(id: string, alias: Alias, modelId: string): void {
    alias.modelId = modelId
    this.modelWants.set(id, (this.modelWants.get(id) ?? 0) + 1)
  }
  /**
   * Sets the session's model and counts it as Muse's once Muse accepts it, never from a session's description (see
   * `confirmSession`). Muse also says so with session/modelChanged.
   */
  private async applyModel(id: string, alias: Alias, entry: ThreadProcess, modelId: string): Promise<void> {
    const changes = this.modelChanges.get(id) ?? 0, wants = this.modelWants.get(id) ?? 0
    await entry.rpc.request('session/setModel', { commandId: museCommandId(), sessionId: alias.museSessionId, model: { modelId } })
    // Muse runs what it accepted unless it named another since; the thread wants it unless something chose another since.
    if ((this.modelChanges.get(id) ?? 0) === changes) alias.nativeModelId = modelId
    if ((this.modelWants.get(id) ?? 0) === wants) alias.modelId = modelId
    this.settleSettings(id, alias)
  }
  /**
   * Sets a reopened session's model again (see `confirmSession`). When Muse refuses, the model Muse last accepted is
   * still the best word on the one it runs, since Muse 1.4.10 describes a reopened session by its default; the
   * description stands in only when Sotto has none. The thread's own stays unconfirmed, for the next send to ask again.
   * The description is as old as the resume that carried it, so a model Muse announced, or the user chose, after
   * `beforeResume` is newer, and it stands.
   */
  private async reapplyModel(id: string, alias: Alias, entry: ThreadProcess, session: MuseSession, beforeResume: { readonly changes: number; readonly wants: number }): Promise<void> {
    try { await this.applyModel(id, alias, entry, alias.modelId) } catch (error) {
      const now = this.modelRevisions(id)
      if (!(error instanceof MuseRejected) || now.changes !== beforeResume.changes || now.wants !== beforeResume.wants) return
      if (!alias.nativeModelId && session.modelId && session.modelId !== alias.modelId) alias.nativeModelId = session.modelId
      this.settleSettings(id, alias)
    }
  }
  /**
   * Whether the thread runs on the settings the user chose, as far as Muse has confirmed them, and what its chip and
   * status show. The chip shows the model Muse last accepted. A model Muse has not confirmed leaves the thread idle,
   * since nothing waits for it (ADR-0079); only a permission mode Muse has not confirmed reads as an error.
   */
  private settleSettings(id: string, alias: Alias): void {
    alias.settingsConfirmed = alias.nativeModelId === alias.modelId && !alias.pendingRuntimeMode
    const thread = this.thread(id)
    if (alias.nativeModelId) thread.modelId = alias.nativeModelId
    if (thread.status !== 'running') thread.status = settledStatus(alias)
  }
  /**
   * A turn whose host ended before it finished may never record its end. If the resumed session is idle and
   * Sotto saw that turn's process go, the thread settles the way Sotto saw it rather than running for good.
   */
  private settleEndedTurn(id: string, session: MuseSession): void {
    const alias = this.aliases[id], thread = this.threads.get(id)
    if (!alias?.endedTurn || !thread) return
    const active = this.activeTurns.get(id)
    if (session.status === 'running' || active) return
    const messageId = this.fold(id).turnMessages.get(alias.endedTurn.turnId)
    thread.status = alias.endedTurn.outcome === 'failed' ? 'error' : 'idle'
    thread.lastTurn = { id: messageId ?? alias.endedTurn.turnId, status: alias.endedTurn.outcome }
    this.markTurn(id, alias.endedTurn.outcome, messageId, alias.endedTurn.outcome === 'failed' ? THREAD_PROCESS_LOST : undefined)
    this.changed(id)
    delete alias.endedTurn
  }
  private requestKey(pending: MusePending): string {
    return JSON.stringify([pending.kind, pending.kind === 'approval' ? pending.approval.approvalId : pending.input.userInputId])
  }
  private holdPendingRead(id: string): () => void {
    const reads = this.requestReads.get(id) ?? { count: 0 }
    reads.count++; this.requestReads.set(id, reads)
    return () => {
      if (this.requestReads.get(id) !== reads || --reads.count !== 0) return
      this.requestReads.delete(id)
      const changes = this.requestChanges.get(id)
      if (!changes) return
      const live = new Set([...this.pending.values()].filter(pending => pending.threadId === id).map(pending => this.requestKey(pending)))
      for (const key of changes.keys()) if (!live.has(key)) changes.delete(key)
      if (!changes.size) this.requestChanges.delete(id)
    }
  }
  private recordNativeRequestChange(id: string, kind: MusePending['kind'], nativeId: string): void {
    const key = JSON.stringify([kind, nativeId])
    if (!this.requestReads.has(id) && ![...this.pending.values()].some(pending => pending.threadId === id && this.requestKey(pending) === key)) {
      const changes = this.requestChanges.get(id)
      changes?.delete(key)
      if (!changes?.size) this.requestChanges.delete(id)
      return
    }
    let changes = this.requestChanges.get(id)
    if (!changes) { changes = new Map(); this.requestChanges.set(id, changes) }
    changes.set(key, ++this.requestRevision)
  }
  private recordRequestChange(pending: MusePending): void {
    this.recordNativeRequestChange(pending.threadId, pending.kind, pending.kind === 'approval' ? pending.approval.approvalId : pending.input.userInputId)
  }
  private requestUnchanged(pending: MusePending, revision: number): boolean {
    return (this.requestChanges.get(pending.threadId)?.get(this.requestKey(pending)) ?? 0) <= revision
  }
  private showRequest(pending: MusePending, entry: ThreadProcess): void {
    const alias = this.aliases[pending.threadId]; if (!alias) return
    if (pending.kind === 'approval') {
      const previous = [...this.pending.values()].find(candidate => candidate.kind === 'approval'
        && candidate.threadId === pending.threadId && candidate.approval.approvalId === pending.approval.approvalId)
      if (previous?.kind === 'approval') {
        if (previous.approval.currentRequirementId.sourceIndex > pending.approval.currentRequirementId.sourceIndex) return
        if (previous.request.id === pending.request.id) {
          previous.approval = pending.approval
          previous.request = { ...pending.request, ...(previous.request.delivery ? { delivery: previous.request.delivery } : {}),
            ...(previous.request.answerRetryReady !== undefined ? { answerRetryReady: previous.request.answerRetryReady } : {}) }
          this.thread(pending.threadId).requests = this.thread(pending.threadId).requests.map(request => request.id === previous.request.id ? previous.request : request)
          this.recordRequestChange(previous)
          this.emit(); return
        }
        this.removeRequest(previous)
      }
    }
    const held: Pending = { ...pending, rpc: entry.rpc }
    if (alias.answeredRequestIds.includes(held.request.id)) { held.answering = true; held.request.delivery = 'uncertain' }
    if (this.pending.has(held.request.id)) return
    this.pending.set(held.request.id, held)
    this.recordRequestChange(held)
    this.thread(held.threadId).requests.push(held.request)
    this.changed(held.threadId)
    this.emit()
  }
  private removeRequest(pending: Pending): void {
    if (this.pending.delete(pending.request.id)) this.recordRequestChange(pending)
    const thread = this.threads.get(pending.threadId)
    if (thread) { thread.requests = thread.requests.filter(request => request.id !== pending.request.id); this.changed(pending.threadId) }
    this.emit()
  }
  /**
   * One item into what the thread said. This is the adapter's one append path: resume history and the live
   * stream both come through here, and the log works out what is new, so reading the same history twice
   * records nothing twice. Older revisions are ignored; an equal-revision reply may still restate its stream.
   */
  private foldItem(id: string, item: MuseItem, turnOnly = false): void {
    const alias = this.aliases[id]; if (!alias) return
    const fold = this.fold(id)
    const previous = fold.items.get(item.itemId)
    if (previous && (previous.revision > item.revision || previous.revision === item.revision && item.kind !== 'agentMessage')) return
    // A streamed reply's item is re-stated whole at its end; the stream's accumulated words are the newer copy.
    const stream = fold.streams.get(item.itemId)
    const merged: MuseItem = stream && item.kind === 'agentMessage' && (item.text ?? '').length < stream.text.length && stream.text.startsWith(item.text ?? '')
      ? { ...item, text: stream.text } : item
    fold.items.set(item.itemId, merged)
    const thread = this.thread(id)
    if (merged.kind === 'userMessage') {
      const origin = merged.commandId ? alias.origins.find(candidate => candidate.nativeCommandId === merged.commandId) : undefined
      const messageId = origin?.messageId ?? `muse-msg-${merged.itemId}`
      if (merged.turnId && !merged.steered && !fold.turnMessages.has(merged.turnId)) {
        fold.turnMessages.set(merged.turnId, messageId)
        const active = this.activeTurns.get(id)
        if (active?.turnId === merged.turnId) active.messageId = messageId
      }
      if (turnOnly) return
      // A message Sotto sent with a display text is shown as that: Watcher's instructions and note are the model's alone.
      // When Muse kept none whole, the words come from the wire text with Sotto's own parts off.
      // The note naming attached files comes off first, when the origin recorded one: it is the last thing Sotto put in
      // the words (ADR-0131).
      const wire = merged.text === undefined ? undefined : readBackUserText(merged.text, () => origin).text
      const text = !origin ? wire : merged.displayText !== undefined && !merged.truncated ? merged.displayText
        : museWatcherTyped(wire ?? '', origin.digest) ?? wire
      const message: AgentMessage = {
        id: messageId, role: 'user', text: text ?? '',
        createdAt: origin?.createdAt ?? (merged.recordedAt ?? new Date().toISOString()),
        ...(origin ? { commandId: origin.commandId } : {}),
        ...(origin?.attachments.length ? { attachments: origin.attachments.map(ref => ({ ...ref })) } : {}),
      }
      this.log.add(id, message)
      if (origin && !origin.confirmed) { origin.confirmed = true; void this.persist().catch(() => undefined) }
      if (origin) this.deliveries.get(origin.messageId)?.resolve()
      if (!museTerminal(merged.status) || this.activeTurns.has(id)) {
        thread.status = 'running'
        this.markTurn(id, 'running', (merged.turnId ? fold.turnMessages.get(merged.turnId) : undefined) ?? messageId)
      }
      return
    }
    if (merged.kind === 'agentMessage') {
      if (turnOnly) return
      const messageId = `muse-msg-${merged.itemId}`
      const message: AgentMessage = { id: messageId, role: 'assistant', text: merged.text ?? '', createdAt: merged.recordedAt ?? new Date().toISOString() }
      if (museTerminal(merged.status)) {
        fold.streams.delete(merged.itemId)
        this.log.add(id, message)
      } else {
        fold.streams.set(merged.itemId, { messageId, text: message.text })
        this.log.add(id, message)
        const held = fold.streams.get(merged.itemId)!
        if (this.log.has(id, messageId)) held.recordedLength = message.text.length
      }
      return
    }
    const turnId = (merged.turnId ? fold.turnMessages.get(merged.turnId) : undefined) ?? this.log.lastUserMessageId(id) ?? 'native-history'
    const activity = museItemActivity(merged, turnId, this.log.lastMessageId(id))
    if (activity) thread.activities = mergeAgentActivities(thread.activities, [activity])
  }
  /** A streamed suffix on an open item: the reply's words, a thought's next part, or a tool's output. */
  private foldDelta(id: string, delta: z.infer<typeof museItemDeltaSchema>): void {
    const fold = this.fold(id)
    const item = fold.items.get(delta.itemId)
    const field = delta.field ?? 'text'
    if (item?.kind === 'agentMessage' && field === 'text') {
      const messageId = `muse-msg-${delta.itemId}`
      let stream = fold.streams.get(delta.itemId)
      if (!stream) { stream = { messageId, text: item.text ?? '' }; fold.streams.set(delta.itemId, stream) }
      stream.text += delta.delta
      fold.items.set(delta.itemId, { ...item, text: stream.text })
      if (stream.recordedLength !== undefined && stream.recordedLength === stream.text.length - delta.delta.length
        && this.log.lastMessageId(id) === messageId && this.log.has(id, messageId)) {
        this.log.appendText(id, messageId, delta.delta)
        stream.recordedLength = stream.text.length
      } else {
        this.log.add(id, { id: messageId, role: 'assistant', text: stream.text, createdAt: item.recordedAt ?? new Date().toISOString() })
        if (this.log.has(id, messageId)) stream.recordedLength = stream.text.length
      }
      return
    }
    if (!item) return
    if (field.startsWith('summary.')) {
      const index = Number(field.slice('summary.'.length))
      if (!Number.isInteger(index) || index < 0) return
      const summary = [...(item.summary ?? [])]
      summary[index] = (summary[index] ?? '') + delta.delta
      const next = { ...item, summary }
      fold.items.set(delta.itemId, next)
      const turnId = (next.turnId ? fold.turnMessages.get(next.turnId) : undefined) ?? this.log.lastUserMessageId(id) ?? 'native-history'
      const activity = museItemActivity(next, turnId, this.log.lastMessageId(id))
      if (activity) this.thread(id).activities = mergeAgentActivities(this.thread(id).activities, [activity])
      return
    }
    if (field === 'output') {
      const next = { ...item, visibleOutput: (item.visibleOutput ?? '') + delta.delta }
      fold.items.set(delta.itemId, next)
      const turnId = (next.turnId ? fold.turnMessages.get(next.turnId) : undefined) ?? this.log.lastUserMessageId(id) ?? 'native-history'
      const activity = museItemActivity(next, turnId, this.log.lastMessageId(id))
      if (activity) this.thread(id).activities = mergeAgentActivities(this.thread(id).activities, [activity])
    }
  }
  /**
   * Muse 1.4.12 fails every turn of a compacted session whose runtime a new host built with tool servers, and nothing
   * on that session clears it; a fork of it builds cleanly. Only that failure, on a host that resumed the session with
   * Sotto's tools and whose history holds a compaction, moves the thread, once per thread in a run.
   */
  private toolsLostToCompaction(id: string, entry: ThreadProcess, error: { kind: string; message: string } | undefined): boolean {
    if (error?.kind !== 'configError' || !error.message.includes(MUSE_TOOL_AUDIT_FAILED)) return false
    const session = this.aliases[id]?.museSessionId
    // A move waits for the thread's open to finish, so the open cannot end on the session it leaves.
    if (!entry.resumedWithTools || !session || this.copied.has(session) || this.loading.has(id) || !this.loaded.has(id)) return false
    return [...this.fold(id).items.values()].some(item => item.kind === 'compaction')
  }
  /** Sessions this run is moving or has moved a thread off, so a failure the move did not clear is not moved again. */
  private readonly copied = new Set<string>()
  /**
   * Move the thread onto a fork of its session, then reopen it on a new host with its tools: the fork loaded its runtime
   * without them on the host that made it. The move is the thread's open, so a send waits for it rather than reaching the
   * old session. The fork's command is kept before it is asked for, so a lost answer is asked for again, not repeated.
   * Muse rebuilds the fork's history, reusing the old messages' items for other words, so those messages are kept out of
   * every later read of it; Sotto's log already holds what they said.
   */
  private moveToCopy(id: string, entry: ThreadProcess, messageId: string | undefined): void {
    const alias = this.aliases[id]!, from = alias.museSessionId!, generation = this.generation
    this.copied.add(from); this.loaded.delete(id)
    let moved = false
    // Set before its first await returns, so the end of the move finds itself in `loading`.
    const move: { work?: Promise<void> } = {}
    const work = move.work = (async () => {
      try {
        alias.forkCommandId ??= museCommandId(); await this.persist()
        const forked = sessionForkSchema.parse(await entry.rpc.request('session/fork', { commandId: alias.forkCommandId, sessionId: from, excludeItems: false }))
        this.assertGeneration(generation)
        const items = forked.history.items ?? forked.history.snapshot?.state.items
        if (!items) throw new MuseUnreadable('Muse did not serve the copy’s history.')
        if (this.processes.get(id) === entry) await this.stopSession(id)
        this.assertGeneration(generation)
        // Requests the old host raised while it forked end with it; the copy's own are listed when it opens.
        for (const pending of [...this.pending.values()]) if (pending.threadId === id) this.removeRequest(pending)
        const thread = this.threads.get(id)
        if (thread) { thread.requests = []; this.changed(id) }
        alias.museSessionId = forked.session.sessionId
        alias.forkedMessages = items.filter(item => item.kind === 'userMessage' || item.kind === 'agentMessage').map(item => item.itemId)
        delete alias.forkCommandId; delete alias.endedTurn
        moved = true
        await this.persist()
      } catch (error) {
        if (!moved) this.copied.delete(from)
        if (generation !== this.generation) throw error
        const thread = this.threads.get(id)
        // The failed turn said a copy was on its way; its record now says there is none.
        if (thread) {
          thread.status = 'error'
          thread.activities = thread.activities?.map(record => record.kind === 'turn' && record.turnId === messageId ? { ...record, error: MUSE_COPY_FAILED } : record)
          this.changed(id)
          this.emit()
        }
        throw error
      } finally { if (this.loading.get(id) === move.work) this.loading.delete(id) }
      await this.open(id)
    })()
    work.catch(() => undefined)
    this.loading.set(id, work)
  }
  /**
   * Fold a history Muse served. The messages it rebuilt when it made the thread's copy still name their turns, so the
   * activity of those turns keeps its place, but their words never reach the log: it already holds what was said.
   */
  private foldHistory(id: string, alias: Alias, items: readonly MuseItem[]): void {
    const forked = alias.forkedMessages?.length ? new Set(alias.forkedMessages) : undefined
    for (const item of items) this.foldItem(id, item, forked?.has(item.itemId) === true)
  }
  /** Settle a turn Muse ended: its record, the thread's state, and any work it left showing as running. */
  /** Output of the thread's running turn arrived: an item, a delta or a token record, never the user's own message. */
  private turnOutput(id: string, turnId?: string | null): void {
    const times = this.turnTimes.get(id)
    if (!times || (turnId && turnId !== times.turnId)) return
    const now = performance.now()
    times.firstOutputAt ??= now; times.lastOutputAt = now
  }
  /** Muse said the turn finished: its send's record gets how long Muse took to its first output and after its last. */
  private reportTurnTimes(id: string, turnId: string): void {
    const times = this.turnTimes.get(id)
    if (!times || times.turnId !== turnId) return
    this.turnTimes.delete(id)
    const now = performance.now()
    times.report?.({
      turnFirstOutputMs: times.startedAt !== undefined && times.firstOutputAt !== undefined ? times.firstOutputAt - times.startedAt : null,
      turnFinishWaitMs: times.lastOutputAt !== undefined ? now - times.lastOutputAt : null,
    })
  }
  private settleTurn(id: string, turnId: string, outcome: 'completed' | 'interrupted' | 'failed', error?: string): void {
    const thread = this.thread(id)
    const messageId = this.fold(id).turnMessages.get(turnId) ?? this.activeTurns.get(id)?.messageId
    this.activeTurns.delete(id); this.activePrompts.delete(id)
    for (const pending of [...this.pending.values()]) if (pending.threadId === id) this.removeRequest(pending)
    this.log.dropEmpty(id)
    thread.status = outcome === 'failed' ? 'error' : 'idle'
    thread.lastTurn = { id: messageId ?? turnId, status: outcome }
    if (thread.activities?.length) {
      thread.activities = thread.activities.map(record => record.kind !== 'turn' && record.status === 'running' && record.turnId === (messageId ?? turnId)
        ? { ...record, status: outcome === 'completed' ? 'unknown' : outcome } : record)
    }
    this.markTurn(id, outcome, messageId, error)
  }
  /** One frame from one thread's host. Its session is the only one that host holds, so the owner is its thread. */
  private async frame(frame: MuseFrame, rpc: MuseRpc): Promise<void> {
    const generation = this.generation
    const owner = [...this.processes].find(([, entry]) => entry.rpc === rpc)?.[0]
    if (owner === undefined) { this.unsupported(rpc, frame); return }
    const current = (): boolean => generation === this.generation && this.processes.get(owner)?.rpc === rpc
    const method = frame.method
    if (!method) return
    if (frame.id !== undefined) {
      // MSP v1 asks its questions as notifications; a request in this direction is not one Sotto can answer.
      rpc.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Sotto does not handle this request.' } })
      if (needsPerson(method) && this.aliases[owner]) {
        const notice = unreadableRequest('Muse'), thread = this.thread(owner)
        if (this.state.error !== notice || thread.requestNotice !== notice) { thread.requestNotice = notice; this.state.error = notice; this.emit() }
      }
      return
    }
    const entry = this.processes.get(owner)!
    const sessionOf = (params: unknown): boolean => {
      const sessionId = (params as { sessionId?: unknown } | null)?.sessionId
      return typeof sessionId !== 'string' || !entry.sessionId || sessionId === entry.sessionId
    }
    this.reaper.touch(owner)
    try {
      switch (method) {
        case 'item/started': case 'item/updated': case 'item/completed': {
          const parsed = museItemEventSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          if (parsed.item.kind !== 'userMessage') this.turnOutput(owner, parsed.item.turnId)
          // A compaction's summary may have dropped Watcher's instructions, so its next message carries them again (#1418).
          if (parsed.item.kind === 'compaction') entry.instructed = false
          this.fold(owner).viewCursor = parsed.viewCursor
          this.foldItem(owner, parsed.item)
          this.emit(true)
          return
        }
        case 'item/delta': {
          const parsed = museItemDeltaSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          this.turnOutput(owner)
          this.fold(owner).viewCursor = parsed.viewCursor
          this.foldDelta(owner, parsed)
          this.emit(true)
          return
        }
        case 'turn/started': {
          const parsed = museTurnEventSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          entry.turnRevision++
          this.fold(owner).viewCursor = parsed.viewCursor
          const messageId = this.fold(owner).turnMessages.get(parsed.turnId)
          this.activeTurns.set(owner, { turnId: parsed.turnId, ...(messageId ? { messageId } : {}) })
          const held = this.turnTimes.get(owner)
          this.turnTimes.set(owner, { turnId: parsed.turnId, startedAt: performance.now(), ...(held?.turnId === parsed.turnId && held.report ? { report: held.report } : {}) })
          if (this.observedUsage) this.usageTurnStarts.set(parsed.turnId, new Date().toISOString())
          const thread = this.thread(owner)
          thread.status = 'running'; thread.lastTurn = { id: messageId ?? parsed.turnId, status: 'running' }
          this.markTurn(owner, 'running', messageId)
          this.emit()
          return
        }
        case 'turn/completed': {
          const parsed = museTurnCompletedSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          entry.turnRevision++
          this.fold(owner).viewCursor = parsed.viewCursor
          const outcome = parsed.terminal === 'completed' ? 'completed' : parsed.terminal === 'cancelled' ? 'interrupted' : 'failed'
          // Before the turn shows finished, so its send's record has the times when the coordinator sees it end.
          this.reportTurnTimes(owner, parsed.turnId)
          this.usageTurnStarts.delete(parsed.turnId); this.readQuotaAfterTurn(rpc)
          const copying = outcome === 'failed' && this.toolsLostToCompaction(owner, entry, parsed.error)
          const said = parsed.error?.kind === 'authRequired' ? 'Muse is not signed in on this machine. Run muse login, then send again.'
            : copying ? MUSE_COPYING_CONVERSATION
            : outcome === 'failed' ? 'Muse could not finish this turn. Nothing else was lost. Send a message to carry on.' : undefined
          const messageId = this.fold(owner).turnMessages.get(parsed.turnId) ?? this.activeTurns.get(owner)?.messageId
          if (copying) this.moveToCopy(owner, entry, messageId)
          this.settleTurn(owner, parsed.turnId, outcome, said)
          this.emit()
          return
        }
        case 'approval/requested': {
          const parsed = museApprovalSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          if (entry.watcher) await this.launchProfile(owner, rpc)
          if (!current()) return
          this.present(museApprovalPending(owner, parsed), entry)
          return
        }
        case 'approval/updated': {
          const parsed = museApprovalUpdatedSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          const pending = [...this.pending.values()].find(candidate => candidate.kind === 'approval'
            && candidate.threadId === owner && candidate.approval.approvalId === parsed.approvalId)
          if (pending?.kind === 'approval') {
            this.showRequest(museApprovalRefreshed(pending, parsed), entry)
          } else {
            // A later stage of an approval Sotto admitted is admitted the same way, by the subject it now names.
            const admitted = entry.admitted?.get(parsed.approvalId)
            if (admitted) this.present(museApprovalRefreshed(museApprovalPending(owner, admitted), parsed), entry)
          }
          return
        }
        case 'approval/resolved': {
          const parsed = approvalResolvedSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          entry.admitted?.delete(parsed.approvalId)
          this.recordNativeRequestChange(owner, 'approval', parsed.approvalId)
          for (const pending of [...this.pending.values()]) if (pending.kind === 'approval'
            && pending.threadId === owner && pending.approval.approvalId === parsed.approvalId) this.removeRequest(pending)
          return
        }
        case 'userInput/requested': {
          const parsed = museUserInputSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          if (entry.watcher) await this.launchProfile(owner, rpc)
          if (!current()) return
          this.showRequest(museUserInputPending(owner, parsed), entry)
          return
        }
        case 'userInput/settled': {
          const parsed = userInputSettledSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          this.recordNativeRequestChange(owner, 'userInput', parsed.userInputId)
          const pending = this.pending.get(parsed.userInputId)
          if (pending) this.removeRequest(pending)
          return
        }
        case 'session/modelChanged': {
          const parsed = modelChangedSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          const alias = this.aliases[owner]; if (!alias) return
          // The model Muse moved the session to is the thread's model now, so no send sets the one before it back.
          this.modelChanges.set(owner, (this.modelChanges.get(owner) ?? 0) + 1)
          this.want(owner, alias, parsed.modelId)
          alias.nativeModelId = parsed.modelId
          alias.settingsConfirmed = !alias.pendingRuntimeMode
          this.thread(owner).modelId = parsed.modelId
          void this.persist().catch(() => undefined)
          this.emit()
          return
        }
        case 'session/approvalModeChanged': {
          const parsed = approvalModeChangedSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          const alias = this.aliases[owner]; if (!alias) return
          const reported = runtimeModeOf(parsed.mode)
          if (alias.pendingRuntimeMode && reported === alias.pendingRuntimeMode) { alias.runtimeMode = alias.pendingRuntimeMode; delete alias.pendingRuntimeMode }
          else if (!alias.pendingRuntimeMode) alias.runtimeMode = reported
          alias.settingsConfirmed = alias.nativeModelId === alias.modelId && !alias.pendingRuntimeMode
          this.thread(owner).runtimeMode = alias.runtimeMode ?? 'approval-required'
          void this.persist().catch(() => undefined)
          this.emit()
          return
        }
        case 'session/tokenUsage': {
          const parsed = tokenUsageSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          // A model call's token record is the last word of that call, so it counts as output for the turn's times.
          this.turnOutput(owner)
          this.observeTokenCall(owner, frame.params, parsed.modelId)
          const thread = this.thread(owner), before = thread.usage
          thread.usage = {
            latest: { input: parsed.usage.inputTokens, output: parsed.usage.outputTokens, cached: parsed.usage.cachedTokens },
            total: { input: parsed.cumulative.promptTokens, output: parsed.cumulative.outputTokens },
            ...(before?.contextUsed !== undefined ? { contextUsed: before.contextUsed } : {}),
            ...(before?.contextWindow !== undefined ? { contextWindow: before.contextWindow } : {}),
            // The context figure is unchanged, so it keeps the time it was reported; the compaction recommendation reads it.
            ...(before?.contextUpdatedAt !== undefined ? { contextUpdatedAt: before.contextUpdatedAt } : {}),
            rateVersions: [], partial: true, updatedAt: new Date().toISOString(),
            ...(parsed.modelId ? { modelId: parsed.modelId } : before?.modelId ? { modelId: before.modelId } : {}),
          }
          this.emit(true)
          return
        }
        case 'usage/changed': {
          // The host's subscription window changed (MSP Developer Preview); Usage reads it when it asks.
          if (this.readProviderQuota) this.keepQuota(frame.params)
          return
        }
        case 'session/contextUsage': {
          const parsed = contextUsageSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          const thread = this.thread(owner), before = thread.usage
          thread.usage = {
            ...(before?.latest ? { latest: before.latest } : {}), ...(before?.total ? { total: before.total } : {}),
            contextUsed: parsed.usedTokens, ...(parsed.windowTokens ? { contextWindow: parsed.windowTokens } : {}),
            rateVersions: [], partial: true, updatedAt: new Date().toISOString(), contextUpdatedAt: new Date().toISOString(),
            ...(before?.modelId ? { modelId: before.modelId } : {}),
          }
          this.emit(true)
          return
        }
        case 'session/todoListChanged': {
          const parsed = todoChangedSchema.parse(frame.params)
          if (!sessionOf(parsed)) return
          const turnId = this.log.lastUserMessageId(owner)
          if (!turnId) return
          const plan = musePlanActivity(turnId, parsed.items, this.log.lastMessageId(owner))
          if (plan) this.thread(owner).activities = mergeAgentActivities(this.thread(owner).activities, [plan])
          this.emit(true)
          return
        }
        case 'view/gap': {
          // The stream dropped events Sotto cannot reconstruct from deltas: read the session afresh. The
          // fold is the log's, so what was already recorded is recognised rather than recorded twice.
          if (!this.aliases[owner]?.museSessionId || !entry.sessionId) return
          // Replies share the transport's serial frame queue. Release this notification before awaiting
          // the resume reply, and coalesce gaps while the same host is already recovering.
          if (!entry.resync) {
            const recovery = this.resync(owner, entry).then(() => { if (current()) this.emit() })
              .catch(() => { if (current()) this.processLost(owner, entry) })
              .finally(() => { if (entry.resync === recovery) delete entry.resync })
            entry.resync = recovery
          }
          return
        }
        default:
          // Session lifecycle, branch, goal and retry notices change nothing Sotto keeps for the thread.
          return
      }
    } catch {
      // A frame Sotto cannot read ends this thread's host rather than half of its turn: the next action
      // starts a new one and resumes the session whole.
      if (current()) this.processLost(owner, entry)
    } finally {
      // Applied, whatever path the frame left by: anything it wrote reaches the next publication.
      if (this.threads.has(owner)) this.changed(owner)
    }
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.executeNative(command) }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> { return this.executeNative(command, guard) }
  private async executeNative(command: AgentHostCommand, watcherGuard?: () => void): Promise<AgentHostResult> {
    const generation = this.generation
    const watcherProfile = 'threadId' in command ? await this.checkLaunchProfile(command.threadId) : undefined
    this.assertGeneration(generation)
    if (watcherProfile) assertWatcherPermission(command)
    if (!this.state.connected) throw new Error('Connect Muse before managing threads.')
    let settled = false
    const historyFromEvents = command.type === 'configure-thread' && command.historyFromEvents === true
    let release: (() => void) | undefined
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('Muse projects require an absolute working directory.')
        if (!this.state.projects.some(project => project.id === command.projectId)) { this.state.projects.push({ id: command.projectId, title: command.title, path: command.path }); await this.projectStore.write(this.state.projects) }
      } else if (command.type === 'create-thread') {
        if (this.aliases[command.threadId]) return this.aliases[command.threadId]!.settingsConfirmed ? { accepted: true } : { accepted: false, uncertain: true }
        validateThreadOptions(this.state, command)
        const project = this.state.projects.find(candidate => candidate.id === command.projectId); if (!project) throw new Error('Choose a Muse project first.')
        const reasoningEffort = command.reasoningEffort ?? this.state.models.find(model => model.id === command.modelId)?.defaultReasoningEffort
        const alias: Alias = {
          projectId: project.id, cwd: await existingWorkingDirectory(command.workingDirectory ?? project.path),
          title: command.title, modelId: command.modelId, settingsConfirmed: false, createdAt: new Date().toISOString(),
          origins: [], answeredRequestIds: [], startCommandId: museCommandId(),
          ...(reasoningEffort ? { reasoningEffort } : {}), ...(command.runtimeMode ? { runtimeMode: museRuntimeMode(command.runtimeMode) } : {}),
        }
        this.assertGeneration(generation)
        const releaseCreate = this.hold(command.threadId)
        let entry: ThreadProcess
        try { entry = await this.threadProcess(command.threadId); this.assertGeneration(generation) } catch (error) { releaseCreate(); throw error }
        try { this.aliases[command.threadId] = alias; await this.persist() } catch (error) { releaseCreate(); throw error }
        try {
          const tools = await this.sessionTools(command.threadId, entry)
          this.assertGeneration(generation)
          watcherGuard?.()
          let reply: unknown
          try { reply = await entry.rpc.request('session/start', startParams(alias, tools.params, entry.watcher)) }
          catch (error) { throw entry.watcher ? this.watcherStartRefusal(command.threadId, error) : error }
          const started = sessionStartSchema.parse(reply)
          if (entry.watcher) await this.proveReviewer(command.threadId, entry, started.session)
          this.builtWith(command.threadId, entry, tools.tools)
          alias.museSessionId = started.session.sessionId
          entry.sessionId = alias.museSessionId
          this.confirmSession(command.threadId, alias, started.session)
          await this.persist(); this.emit()
          if (alias.nativeModelId !== alias.modelId) {
            await this.applyModel(command.threadId, alias, entry, alias.modelId)
            await this.persist()
          }
          if (alias.runtimeMode && runtimeModeOf(started.session.approvalMode?.mode) !== alias.runtimeMode) {
            await entry.rpc.request('session/setApprovalMode', { commandId: museCommandId(), sessionId: alias.museSessionId, mode: MSP_MODE[alias.runtimeMode] })
            await this.persist()
          }
          alias.settingsConfirmed = alias.nativeModelId === alias.modelId && !alias.pendingRuntimeMode
          await this.persist()
        } catch (error) {
          releaseCreate()
          if (!(error instanceof MuseUncertain) && this.processes.get(command.threadId) === entry) void this.stopSession(command.threadId)
          if (error instanceof MuseRejected && error.reason === 'approval_mode_ceiling') {
            delete this.aliases[command.threadId]; await this.persist().catch(() => undefined)
            throw new Error('Muse on this machine does not allow that permission mode. Nothing was created. Choose Ask for approval, or change Muse’s own approval settings and reconnect.', { cause: error })
          }
          throw error
        }
        this.loaded.add(command.threadId); this.log.pin(command.threadId); this.reaper.touch(command.threadId)
        const thread = this.thread(command.threadId); thread.modelId = alias.modelId; thread.status = settledStatus(alias)
        releaseCreate()
      } else {
        const alias = this.aliases[command.threadId]
        if (!alias?.museSessionId && !alias?.startCommandId) throw new Error('This Muse thread has no confirmed provider session. Do not repeat its creation automatically.')
        const readForSend = this.readsBeforeSend.take(command.threadId, command)
        this.reaper.touch(command.threadId)
        if (command.type === 'configure-thread') {
          await this.open(command.threadId); this.assertGeneration(generation)
          if (!alias.museSessionId) throw new MuseUncertain('Muse has not confirmed this thread’s session.')
          const entry = await this.threadProcess(command.threadId)
          const modelId = command.modelId ?? alias.modelId
          const reasoningEffort = effortAfterChange(this.state, command, alias.reasoningEffort)
          const mode = command.runtimeMode !== undefined ? museRuntimeMode(command.runtimeMode) : undefined
          validateThreadOptions(this.state, {
            modelId, ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}),
            ...(command.providerMode !== undefined ? { providerMode: command.providerMode } : {}),
          }, alias.modelId)
          const thread = this.thread(command.threadId)
          const wantsChange = modelId !== alias.modelId || reasoningEffort !== alias.reasoningEffort
            || (mode !== undefined && mode !== (alias.pendingRuntimeMode ?? alias.runtimeMode ?? 'approval-required'))
          if (wantsChange) {
            if (this.activePrompts.has(command.threadId) || this.activeTurns.has(command.threadId) || thread.status === 'running' || thread.requests.length) {
              throw new Error('Wait for this Muse thread to finish and answer its pending requests before changing its settings.')
            }
            // A change Watcher's room or a phone asked for is checked before anything changes, and again at each write: a
            // phone that let go of Watcher meanwhile changes nothing (ADR-0073).
            watcherGuard?.()
            if (mode !== undefined && mode !== (alias.runtimeMode ?? 'approval-required')) {
              const previousPending = alias.pendingRuntimeMode, previousConfirmed = alias.settingsConfirmed, previousStatus = thread.status
              alias.pendingRuntimeMode = mode; alias.settingsConfirmed = false; thread.status = 'error'; this.changed(command.threadId); await this.persist(); this.emit()
              try { watcherGuard?.() } catch (error) {
                if (previousPending) alias.pendingRuntimeMode = previousPending; else delete alias.pendingRuntimeMode
                alias.settingsConfirmed = previousConfirmed; thread.status = previousStatus; this.changed(command.threadId); await this.persist(); this.emit()
                throw error
              }
              try {
                await entry.rpc.request('session/setApprovalMode', { commandId: museCommandId(), sessionId: alias.museSessionId, mode: MSP_MODE[mode] })
                alias.runtimeMode = mode; delete alias.pendingRuntimeMode
                thread.runtimeMode = mode; this.changed(command.threadId)
              } catch (error) {
                if (error instanceof MuseRejected) {
                  delete alias.pendingRuntimeMode; this.settleSettings(command.threadId, alias); await this.persist(); this.emit()
                  throw new Error(error.reason === 'approval_mode_ceiling'
                    ? 'Muse on this machine does not allow that permission mode. Nothing changed. Change Muse’s own approval settings and reconnect to use it.'
                    : 'Muse rejected that permission mode. Nothing changed.', { cause: error })
                }
                throw error
              }
            }
            // Only a model the command names is set: a permission or effort change keeps whatever model the thread has
            // now, including one Muse moved it to while the permission was being set.
            if (command.modelId !== undefined && command.modelId !== alias.modelId) {
              watcherGuard?.()
              // Both are read before anything is awaited, so a model Muse announces from here on is newer than both.
              const previousModelId = alias.modelId, changes = this.modelChanges.get(command.threadId) ?? 0
              // The wanted model is saved before Muse is asked, so one whose answer is lost is still wanted after a reconnect.
              this.want(command.threadId, alias, modelId); alias.settingsConfirmed = false; await this.persist()
              try { await this.applyModel(command.threadId, alias, entry, modelId) } catch (error) {
                // Only an answer that may have reached Muse keeps the new model wanted, for the next send to ask for
                // again. A refusal leaves the thread on the model Muse last accepted, or the one Muse moved it to since.
                if (error instanceof MuseUncertain) throw error
                if ((this.modelChanges.get(command.threadId) ?? 0) === changes) this.want(command.threadId, alias, previousModelId)
                this.settleSettings(command.threadId, alias)
                await this.persist(); this.emit()
                if (!(error instanceof MuseRejected)) throw error
                const name = (candidate: string) => this.state.models.find(model => model.id === candidate)?.name ?? candidate
                throw new Error(`Muse rejected ${name(modelId)}. This thread stays on ${name(alias.nativeModelId ?? previousModelId)}.`, { cause: error })
              }
            }
            alias.reasoningEffort = reasoningEffort
            if (reasoningEffort) thread.reasoningEffort = reasoningEffort; else delete thread.reasoningEffort
            this.changed(command.threadId)
            this.settleSettings(command.threadId, alias)
            await this.persist()
            settled = alias.settingsConfirmed
          } else settled = alias.settingsConfirmed && !alias.pendingRuntimeMode
        } else if (command.type === 'send' || command.type === 'steer') {
          release = this.hold(command.threadId)
          if (command.skills?.length) throw providerTakesNoSkills('muse')
          await this.open(command.threadId); this.assertGeneration(generation)
          if (!alias.museSessionId) throw new MuseUncertain('Muse has not confirmed this thread’s session.')
          if (alias.pendingRuntimeMode) throw new Error('Muse has not confirmed this thread’s permission mode. Reconnect to check before sending.')
          const attachments = validatePromptAttachments(this.state, alias.modelId, command.attachments, { workingDirectory: alias.cwd })
          // A loaded session streams live on this connection, so what the log holds is current; only a
          // session this send had to open needed the read its resume just did. `readForSend` still consumed
          // the coordinator's read receipt, so a later send repays it the same way.
          readForSend()
          this.assertGeneration(generation)
          const thread = this.thread(command.threadId)
          if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(command.threadId) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
          const previous = alias.origins.find(origin => origin.messageId === command.messageId || origin.commandId === command.commandId)
          if (previous) return previous.confirmed ? { accepted: true } : { accepted: false, uncertain: true }
          const active = this.activeTurns.get(command.threadId)
          if (command.type === 'send' && (this.activePrompts.has(command.threadId) || active || thread.status === 'running')) throw new Error('Muse is already running a prompt in this thread.')
          if (command.type === 'steer' && !active) throw new Error('There is no running turn to steer. Queue a follow-up instead.')
          if (thread.requests.length) throw new Error('Answer the pending Muse request before sending another prompt.')
          verifyFileMentions(command.text, command.files)
          // Watcher's request note goes after the words as Grok's does, and its instructions, when its session needs them,
          // ahead of them: the two channels MSP offers. The turn's display text is the message alone (ADR-0073). A
          // wake-up's news for Watcher goes the same way as the note.
          const watcherNote = command.type === 'send' ? command.watcherRequestNote ?? command.watcherNews : undefined
          const note = watcherProfile && watcherNote ? watcherRequestLine(watcherNote) : ''
          // Any attached file that is not an image is saved into the thread's folder and named in a note after everything
          // else in the words (ADR-0131), which the display text leaves out as it leaves out Watcher's note.
          const delivered = await deliverAttachments(alias.cwd, attachments)
          const parts: Record<string, unknown>[] = [{ type: 'text', text: withAttachedFilesNote(command.text + note, delivered.note) }]
          const display = (watcherProfile || delivered.note) && command.type === 'send' ? { displayText: command.text } : {}
          for (const attachment of delivered.images) {
            const bytes = await attachment.read()
            parts.push({
              type: 'image', mediaType: attachment.mimeType, base64Data: Buffer.from(bytes).toString('base64'),
              ...(attachment.dimensions ? { width: attachment.dimensions.sent.width, height: attachment.dimensions.sent.height } : {}),
            })
          }
          this.assertGeneration(generation)
          if (alias.pendingRuntimeMode) throw new Error('Muse is applying new thread settings. Send again once they are confirmed.')
          const origin: Origin = {
            messageId: command.messageId, commandId: command.commandId, nativeCommandId: museCommandId(),
            digest: digest(command.text), createdAt: new Date().toISOString(), confirmed: false,
            attachments: attachmentReferences(attachments),
          }
          const entry = await this.threadProcess(command.threadId)
          // A model Muse has not confirmed is asked for again before a new turn; a refusal sends on the model Muse has.
          // What the prompt carries must suit the model the turn will run on.
          if (command.type === 'send' && alias.nativeModelId !== alias.modelId) {
            const wants = this.modelWants.get(command.threadId) ?? 0
            await this.applyModel(command.threadId, alias, entry, alias.modelId).catch((error: unknown) => {
              // A model Muse refuses outright is not asked for again: the thread takes the model Muse has. That also ends
              // a refused change a failed save or an exit left wanted, after asking for it once more.
              if (!(error instanceof MuseRejected) || !alias.nativeModelId || (this.modelWants.get(command.threadId) ?? 0) !== wants) return
              this.want(command.threadId, alias, alias.nativeModelId)
              this.settleSettings(command.threadId, alias)
              void this.persist().catch(() => undefined)
            })
            if (alias.nativeModelId && alias.nativeModelId !== alias.modelId) validatePromptAttachments(this.state, alias.nativeModelId, command.attachments)
          }
          this.assertGeneration(generation)
          // Once per conversation, not with every message (#1418): with the first send on this host, and again when the
          // note says the conversation is new or was compacted, which also catches a compaction Muse made by itself.
          const reminder = watcherNote?.includes(WATCHER_COMPACTED_NOTE) === true
          if (watcherProfile && command.type === 'send') {
            if (reminder && !entry.reminded) entry.instructed = false
            entry.reminded = reminder
          }
          const instructing = watcherProfile !== undefined && command.type === 'send' && !entry.instructed
          if (instructing) parts.unshift({ type: 'text', text: museWatcherInstructions(watcherProfile.instructions) })
          alias.origins.push(origin)
          this.activePrompts.add(command.threadId)
          release()
          try {
            await this.persist()
            if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(command.threadId) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
            if (generation !== this.generation || !this.state.connected || !this.loaded.has(command.threadId)) throw new Error('The Muse prompt was cancelled before dispatch.')
            watcherGuard?.()
          } catch (error) {
            alias.origins = alias.origins.filter(item => item !== origin); this.activePrompts.delete(command.threadId); await this.persist()
            throw error
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          const delivery = new Promise<void>((resolve, reject) => {
            this.deliveries.set(command.messageId, { threadId: command.threadId, resolve, reject })
            timer = setTimeout(() => reject(new MuseUncertain('Muse prompt delivery is uncertain.')), this.options.requestTimeoutMs ?? 15_000)
          })
          // The wait below may never be reached when the write itself fails; the rejection is still its answer.
          void delivery.catch(() => undefined)
          markSendStage(command.commandId, 'written')
          try {
            const effort = alias.reasoningEffort && MUSE_EFFORTS.includes(alias.reasoningEffort) ? { reasoningEffort: alias.reasoningEffort } : {}
            const ack = command.type === 'steer'
              ? await entry.rpc.request('turn/steer', { commandId: origin.nativeCommandId, sessionId: alias.museSessionId, expectedTurnId: active!.turnId, input: parts, ...effort })
              : await entry.rpc.request('turn/start', { commandId: origin.nativeCommandId, sessionId: alias.museSessionId, input: parts, ...display, ...effort })
            const started = turnStartSchema.parse(ack)
            if (instructing) entry.instructed = true
            if (command.type === 'send') {
              this.activeTurns.set(command.threadId, { turnId: started.turnId, messageId: command.messageId })
              const report = holdTurnEnd(command.commandId)
              const times = this.turnTimes.get(command.threadId)
              if (report && times?.turnId === started.turnId) times.report = report
              else if (report) this.turnTimes.set(command.threadId, { turnId: started.turnId, report })
            }
            thread.status = 'running'
            thread.lastTurn = { id: command.type === 'send' ? command.messageId : thread.lastTurn?.id ?? command.messageId, status: 'running' }
            if (command.type === 'send') this.markTurn(command.threadId, 'running', command.messageId)
            this.changed(command.threadId)
          } catch (error) {
            clearTimeout(timer); this.deliveries.delete(command.messageId)
            this.activePrompts.delete(command.threadId)
            if (error instanceof MuseRejected) {
              alias.origins = alias.origins.filter(item => item !== origin); await this.persist()
              throw new Error(command.type === 'steer' ? 'Muse could not steer this turn. Nothing was sent; queue it as a follow-up instead.' : 'Muse rejected this prompt. Nothing was sent. Review the thread before retrying.', { cause: error })
            }
            throw error
          }
          try { await delivery }
          catch (error) { this.activePrompts.delete(command.threadId); throw error }
          finally { clearTimeout(timer); this.deliveries.delete(command.messageId) }
          markSendStage(command.commandId, 'acknowledged')
          this.reaper.touch(command.threadId)
        } else if (command.type === 'answer') {
          await this.open(command.threadId); this.assertGeneration(generation)
          const pending = this.pending.get(command.requestId)
          if (!pending || pending.threadId !== command.threadId) throw new Error('That Muse request is no longer pending.')
          if (watcherProfile) assertWatcherPermissionChoice(pending.request, command.permissionChoice)
          if (pending.answering) return { accepted: false, uncertain: true }
          const entry = this.processes.get(command.threadId)
          if (!entry || pending.rpc !== entry.rpc || !alias.museSessionId) return { accepted: false, uncertain: true }
          // Validate the user's answer before recording a delivery attempt. A local validation failure
          // sends nothing and leaves the request immediately answerable.
          const decision = pending.kind === 'approval' ? museApprovalChoice(pending, command.approved, command.permissionChoice) : undefined
          const answers = pending.kind === 'userInput' && command.approved !== false
            ? museUserInputAnswers(pending, command.answer, command.questionAnswers) : undefined
          pending.answerCommandId ??= museCommandId()
          const remembered = alias.answeredRequestIds.includes(pending.request.id)
          if (!remembered) alias.answeredRequestIds.push(pending.request.id)
          pending.answering = true
          try { await this.persist() } catch (error) {
            if (!remembered) alias.answeredRequestIds = alias.answeredRequestIds.filter(item => item !== pending.request.id)
            pending.answering = false; throw error
          }
          delete pending.request.answerRetryReady; this.changed(command.threadId)
          try {
            if (pending.kind === 'approval') {
              const choiceId = decision!
              const choice = pending.approval.availableChoices.find(candidate => candidate.choiceId === choiceId)
              const decided = museApprovalDecidedSchema.parse(await entry.rpc.request('approval/decide', {
                commandId: pending.answerCommandId, sessionId: alias.museSessionId, approvalId: pending.approval.approvalId,
                choiceId, requirementId: pending.approval.currentRequirementId,
                ...(choice?.acceptsFeedback && command.answer.trim() ? { feedback: command.answer.trim() } : {}),
              }))
              if (!decided.terminal) {
                // This answer settled one requirement, not the entire approval. Read the next stage if
                // its update has not arrived yet; its new request ID requires another explicit answer.
                await this.resync(command.threadId)
                return { accepted: true }
              }
            } else if (command.approved === false) {
              await entry.rpc.request('userInput/cancel', { commandId: pending.answerCommandId, sessionId: alias.museSessionId, userInputId: pending.input.userInputId, ...(command.answer.trim() ? { reason: command.answer.trim() } : {}) })
            } else {
              await entry.rpc.request('userInput/answer', {
                commandId: pending.answerCommandId, sessionId: alias.museSessionId, userInputId: pending.input.userInputId,
                answers,
              })
            }
            this.removeRequest(pending)
          } catch (error) {
            if (error instanceof MuseRejected && (error.kind === 'approvalAlreadyResolved' || error.kind === 'userInputAlreadySettled')) { this.removeRequest(pending); return { accepted: true } }
            if (error instanceof MuseRejected && error.kind === 'approvalRequirementStale') {
              pending.answering = false
              delete pending.answerCommandId
              alias.answeredRequestIds = alias.answeredRequestIds.filter(id => id !== pending.request.id)
              await this.persist()
              await this.resync(command.threadId).catch(() => undefined)
              throw new Error('This request changed. Review it and answer again.', { cause: error })
            }
            if (error instanceof MuseRejected) {
              pending.answering = false; delete pending.answerCommandId
              alias.answeredRequestIds = alias.answeredRequestIds.filter(id => id !== pending.request.id)
              await this.persist(); throw error
            }
            pending.request.delivery = 'uncertain'; this.changed(command.threadId); this.emit()
            return { accepted: false, uncertain: true }
          }
        } else if (command.type === 'interrupt') {
          await this.open(command.threadId); this.assertGeneration(generation)
          if (!alias.museSessionId) throw new MuseUncertain('Muse has not confirmed this thread’s session.')
          const entry = await this.threadProcess(command.threadId)
          watcherGuard?.()
          const active = this.activeTurns.get(command.threadId)
          await entry.rpc.request('turn/interrupt', {
            commandId: museCommandId(), sessionId: alias.museSessionId, ...(active ? { turnId: active.turnId } : {}),
          })
        } else if (command.type === 'compact-thread') {
          await this.open(command.threadId); this.assertGeneration(generation)
          if (!alias.museSessionId) throw new MuseUncertain('Muse has not confirmed this thread’s session.')
          const entry = await this.threadProcess(command.threadId)
          watcherGuard?.()
          const before = this.thread(command.threadId).usage
          await entry.rpc.request('session/compact', { commandId: museCommandId(), sessionId: alias.museSessionId })
          // The summary may have dropped Watcher's instructions, so its next message carries them again (#1418).
          entry.instructed = false
          // Muse's new size comes only with its next session/contextUsage, so the figure from before the compaction would
          // outlive it: cleared, with a new time, unless a reading came in while it ran (ADR-0095).
          const thread = this.thread(command.threadId), usage = thread.usage
          if (usage?.contextUsed !== undefined && usage.contextUsed === before?.contextUsed && usage.contextUpdatedAt === before.contextUpdatedAt) {
            const { contextUsed: _compacted, ...rest } = usage
            void _compacted
            thread.usage = { ...rest, updatedAt: new Date().toISOString(), contextUpdatedAt: new Date().toISOString() }
          }
        }
      }
      this.emit()
      return settled ? { accepted: true, snapshot: this.current(historyFromEvents) } : { accepted: true }
    } catch (error) { if (error instanceof MuseUncertain) return { accepted: false, uncertain: true }; throw error }
    finally { release?.() }
  }
  /** Re-read a loaded session whole: the fold recognises what it already holds and records only what is new. */
  private async resync(id: string, expected?: ThreadProcess): Promise<void> {
    const generation = this.generation
    const entry = this.processes.get(id), alias = this.aliases[id]
    if (!entry || (expected && entry !== expected) || !alias?.museSessionId || (!expected && !this.loaded.has(id))) return
    const turnRevision = entry.turnRevision
    const beforeResume = this.modelRevisions(id)
    const resumed = sessionResumeSchema.parse(await entry.rpc.request('session/resume', {
      commandId: museCommandId(), sessionId: alias.museSessionId, excludeItems: false,
    }))
    if (generation !== this.generation || this.processes.get(id) !== entry) return
    if (entry.watcher) await this.proveReviewer(id, entry, resumed.session)
    const items = resumed.history.items ?? resumed.history.snapshot?.state.items
    if (!items) throw new MuseUnreadable('Muse did not serve this thread’s history.')
    this.foldHistory(id, alias, items)
    this.fold(id).viewCursor = resumed.viewCursor
    // A running turn is left alone: the next send asks for the thread's model again.
    const running = resumed.session.status === 'running' || this.activeTurns.has(id) || this.activePrompts.has(id)
    if (this.confirmSession(id, alias, resumed.session, true) && !running) {
      await this.reapplyModel(id, alias, entry, resumed.session, beforeResume)
      if (generation !== this.generation || this.processes.get(id) !== entry) return
    }
    if (entry.turnRevision === turnRevision) this.reconcileLiveSession(id, resumed.session)
    this.settleEndedTurn(id, resumed.session)
    const releaseRead = this.holdPendingRead(id)
    try {
      const revision = this.requestRevision
      const held = [...this.pending.values()].filter(pending => pending.threadId === id)
      const listed = listPendingSchema.parse(await entry.rpc.request('approval/listPending', { sessionId: alias.museSessionId }))
      if (generation !== this.generation || this.processes.get(id) !== entry) return
      const restored = [...listed.approvals.map(approval => museApprovalPending(id, approval)),
        ...listed.userInputs.map(input => museUserInputPending(id, input))].filter(pending => this.requestUnchanged(pending, revision))
      const unchanged = held.filter(pending => this.pending.get(pending.request.id) === pending && this.requestUnchanged(pending, revision))
      const openApprovals = new Set(listed.approvals.map(approval => approval.approvalId))
      const openInputs = new Set(listed.userInputs.map(input => input.userInputId))
      for (const pending of unchanged) {
        if (pending.kind === 'approval' ? !openApprovals.has(pending.approval.approvalId) : !openInputs.has(pending.input.userInputId)) this.removeRequest(pending)
      }
      for (const pending of restored) this.present(pending, entry)
    } finally { releaseRead() }
  }
  /** A resume can prove that work ended even when the stream lost its terminal event; its outcome remains unknown. */
  private reconcileLiveSession(id: string, session: MuseSession): void {
    const active = this.activeTurns.get(id), thread = this.thread(id)
    if (active && active.turnId !== session.activeTurnId) {
      this.activeTurns.delete(id); this.activePrompts.delete(id)
      if (thread.lastTurn?.status === 'running') delete thread.lastTurn
      const messageId = this.fold(id).turnMessages.get(active.turnId) ?? active.messageId
      if (messageId) {
        this.markTurn(id, 'unknown', messageId)
        thread.activities = thread.activities?.map(activity => activity.turnId === messageId && activity.status === 'running'
          ? { ...activity, status: 'unknown' } : activity)
      }
    }
    if (session.activeTurnId) {
      const messageId = this.fold(id).turnMessages.get(session.activeTurnId)
      this.activeTurns.set(id, { turnId: session.activeTurnId, ...(messageId ? { messageId } : {}) })
      thread.status = 'running'; thread.lastTurn = { id: messageId ?? session.activeTurnId, status: 'running' }
      this.markTurn(id, 'running', messageId ?? session.activeTurnId)
    } else if (!this.activePrompts.has(id)) thread.status = this.aliases[id] ? settledStatus(this.aliases[id]) : 'error'
  }
  /** MSP cannot disable all tools independently of native policy, so side writing stays unavailable (ADR-0079). */
  async writeShortText(id: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    void id; void prompt; void signal
    return null
  }
  private disconnecting = false
  disconnect(): void {
    if (this.disconnecting) return
    this.disconnecting = true
    try { this.finishDisconnect() } finally { this.disconnecting = false }
  }
  private finishDisconnect(): void {
    this.generation++; this.reaper.dispose(); this.loaded.clear(); this.loading.clear(); this.usageTurnStarts.clear()
    // A pending approval is Muse's to settle when its host ends; Sotto sends no decision for it here.
    this.pending.clear(); this.requestChanges.clear(); this.requestReads.clear(); this.requestRevision = 0
    for (const thread of this.threads.values()) thread.requests = []
    this.threadChanges.markAll()
    for (const delivery of this.deliveries.values()) delivery.reject(new MuseUncertain('Muse disconnected before acknowledgement.'))
    this.deliveries.clear()
    this.activePrompts.clear()
    let ended = false
    for (const [id, active] of this.activeTurns) {
      const alias = this.aliases[id]
      if (alias) { alias.endedTurn = { turnId: active.turnId, outcome: 'interrupted' }; ended = true }
    }
    this.activeTurns.clear()
    if (ended) void this.persist().catch(() => undefined)
    for (const entry of this.processes.values()) this.closeProcess(entry)
    this.processes.clear(); this.outdated.clear(); this.state.connected = false; delete this.state.sandboxDisabled; this.emit()
  }
  async closed(): Promise<void> { await Promise.all([...this.exits]); await Promise.allSettled(this.loading.values()); await this.writing }
}
