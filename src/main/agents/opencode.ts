import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { agentProjectSchema, type AgentHostSnapshot, type AgentMessage, type AgentModel, type AgentRuntimeMode, type AgentThread } from '../../shared/agents'
import { mergeAgentActivities, type AgentActivity } from '../../shared/agentActivity'
import { heldProvidersOf, type HeldProviders } from '../../shared/heldProviders'
import { orderReasoningEfforts } from '../../shared/reasoningEfforts'
import { watcherProvidersInWords } from '../../shared/workerRoles'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { BrowserAgentTools } from './browserAgentServer'
import { ActivitySubscribers, certifyActivityView, cloneActivitySnapshot } from './activitySnapshots'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { compareClientVersions } from './clientVersions'
import type { ActivitySubscriptionOptions, AgentHost, AgentHostCommand, AgentHostResult, ShortTextPrompt, ThreadHistorySource, ThreadHostEvent, ThreadLaunchProfiles, ThreadReadPurpose, ThreadSessionDraft } from './host'
import { opencodeReasoningActivity, opencodeStepFilesActivity, opencodeTextMessageId, opencodeToolActivity, opencodeToolOutput, opencodeToolStatus, type OpenCodeTool } from './opencodeActivity'
import { locationQuery, OpenCodeClient, OpenCodeRejected, type OpenCodeEvent } from './opencodeClient'
import { OPENCODE_DECLINED, OPENCODE_FORM_UNSHOWN, opencodeFormAnswer, opencodeFormPending, opencodeFormSchema, opencodePermissionDecision, opencodePermissionPending, opencodePermissionSchema, type OpenCodePending } from './opencodeRequests'
import { endServersLeftBehind, ensureOpenCodeFolders, findOpenCodeExecutable, OPENCODE_CLI_VERSION, opencodeEnvironment, opencodeFolders, opencodePassword, OpenCodeServer, OpenCodeTooOld, OpenCodeUncertain, OpenCodeUnsupported, opencodeVersionRefusal, readOpenCodeVersion, withFirstServerLock, type OpenCodeFolders, type OpenCodeServerEvent } from './opencodeServer'
import { connectedToolServers, opencodeToolActions, opencodeToolServers, type OpenCodeToolServer } from './opencodeTools'
import { OpenSessions } from './openSessions'
import { verifyFileMentions } from './promptFiles'
import { ProviderUnavailable } from './providerProblem'
import { providerTakesNoSkills } from './providerSwitch'
import { adapterItemCount, ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { ReadsBeforeSend } from './readsBeforeSend'
import { markSendStage } from './sendStages'
import { SessionReaper } from './sessionReaper'
import { SIDE_WRITING_TIMEOUT_MS, sideWritingEffort } from './sideWriting'
import type { ScopedThreadTools } from './threadToolServer'
import { ThreadMessageLog } from './threadMessageLog'
import { effortAfterChange, validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { existingWorkingDirectory } from './threadWorktrees'
import { markTurnActivity } from './turnActivity'
import { WatcherProfileRefusal } from './watcherProfile'

const SERVER_LOST = 'OpenCode stopped before this reply finished, so it may be cut short. Send a message to carry on.'
const TURN_FAILED = 'OpenCode could not finish this turn. Nothing else was lost. Send a message to carry on.'
const SOURCE_REFUSED = 'The model source refused this turn: it may need signing in to in OpenCode, or its free models may not allow it. Nothing else was lost. Choose another model or sign in, then send again.'
/** Watcher's refusal names the providers Watcher runs on this run, so a stable build never names a held one. */
const watcherRefused = (held: HeldProviders): string => `OpenCode cannot host Watcher. Nothing was sent. Choose a ${watcherProvidersInWords(held)} model for Watcher.`
/** OpenCode Zen's provider ID: the model source a folder with no sign-ins offers, its free models (ADR-0087). */
const ZEN = 'opencode'
const ZEN_NAME = 'OpenCode Zen'

/**
 * Sotto's permission modes as OpenCode session rule sets (ADR-0087). The last matching rule wins, and OpenCode's own
 * agent rules still apply, so **Ask for approval** asks for every command, edit, step outside the project folder, web
 * fetch, web search and subagent that those rules do not already decide, as Claude Code and Devin ask before reaching the
 * web; **Auto-accept edits** allows edits and asks the rest. A session's rules win over a project's own `opencode.json`
 * for the actions they name (checked against 2.0.31). There is no Automatic: OpenCode has no mode of its own that matches
 * it. Nothing is denied outright, since OpenCode Zen's free models refuse a session whose rules take a tool away.
 */
export const opencodeRuntimeModes = ['approval-required', 'auto-accept-edits', 'full-access'] as const
type OpenCodeMode = typeof opencodeRuntimeModes[number]
const modeSchema = z.enum(opencodeRuntimeModes)
export interface OpenCodeRule { readonly action: string; readonly resource: string; readonly effect: 'allow' | 'ask' | 'deny' }
const rule = (action: string, effect: OpenCodeRule['effect']): OpenCodeRule => ({ action, resource: '*', effect })
export function opencodeRules(mode: OpenCodeMode): OpenCodeRule[] {
  if (mode === 'full-access') return [rule('*', 'allow')]
  return [rule('shell', 'ask'), rule('edit', mode === 'auto-accept-edits' ? 'allow' : 'ask'), rule('external_directory', 'ask'),
    rule('webfetch', 'ask'), rule('websearch', 'ask'), rule('subagent', 'ask')]
}
/**
 * The rules after a mode's that let the model call Sotto's own tools with no prompt of OpenCode's, as Codex's `approve`,
 * Claude Code's allowed tools and Grok Build's one-time allow do (ADR-0020, ADR-0087): each by its own action name, so
 * nothing else is widened. They come last, since the last matching rule wins, and they take no tool away.
 */
export function opencodeToolRules(actions: readonly string[]): OpenCodeRule[] { return actions.map(action => rule(action, 'allow')) }
/** One of Sotto's tool allows, which says nothing of the thread's mode. Sotto's servers all go by `sotto_` names. */
const isToolRule = (candidate: { action: string; effect: string }): boolean => candidate.effect === 'allow' && candidate.action.startsWith('sotto_')
function modeOfRules(rules: readonly { action: string; resource: string; effect: string }[] | undefined): OpenCodeMode | undefined {
  if (!rules) return undefined
  const key = JSON.stringify(rules.filter(candidate => !isToolRule(candidate)).map(({ action, resource, effect }) => [action, resource, effect]))
  return opencodeRuntimeModes.find(mode => JSON.stringify(opencodeRules(mode).map(({ action, resource, effect }) => [action, resource, effect])) === key)
}
function opencodeMode(mode: AgentRuntimeMode): OpenCodeMode {
  const parsed = modeSchema.safeParse(mode)
  if (!parsed.success) throw new Error('That permission mode is not supported by this provider.')
  return parsed.data
}

/**
 * A message ID of Sotto's for a prompt, in OpenCode's ascending form, so history keeps its place by time (ADR-0087).
 * OpenCode answers a repeat of one with the prompt it already has, and names it on the stream and in history.
 */
let promptSerial = 0
function promptId(): string {
  const time = (BigInt(Date.now()) * 4096n + BigInt(promptSerial++ % 4096)).toString(16).padStart(12, '0').slice(-12)
  return `msg_${time}sotto${randomBytes(6).toString('hex')}`
}
/** Where Sotto marks a provider session it creates, so one whose creation answer was lost can be found again. */
const CREATE_MARK = 'sotto'

const attachmentRefSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), sizeBytes: z.number() })
const originSchema = z.object({
  messageId: z.string(), commandId: z.string(), inboxId: z.string(), createdAt: z.string(),
  confirmed: z.boolean().default(false), attachments: z.array(attachmentRefSchema).default([]),
  /** Sent as a steer, so it joined the execution that was running, and its turn, rather than starting one (ADR-0087). */
  steer: z.boolean().default(false),
})
type Origin = z.infer<typeof originSchema>
const aliasSchema = z.object({
  /**
   * The provider session's ID, once OpenCode has said it. OpenCode chooses it: its free models refuse a provider session
   * whose ID a client chose. Until then `createToken`, kept in the provider session's metadata, finds one whose creation
   * answer was lost.
   */
  sessionId: z.string().optional(), createToken: z.string(), sessionConfirmed: z.boolean().default(false), projectId: z.string(), cwd: z.string(), title: z.string(),
  modelId: z.string(), reasoningEffort: z.string().optional(), runtimeMode: modeSchema.default('approval-required'),
  createdAt: z.string(), origins: z.array(originSchema).default([]),
  endedTurn: z.object({ messageId: z.string(), outcome: z.enum(['failed', 'interrupted']) }).optional(),
})
type Alias = z.infer<typeof aliasSchema>

const infoSchema = z.looseObject({ version: z.string().min(1).max(64) })
const modelSchema = z.looseObject({
  id: z.string().min(1), providerID: z.string().min(1), name: z.string().min(1),
  capabilities: z.looseObject({ input: z.array(z.string()).default([]) }).default({ input: [] }),
  variants: z.array(z.looseObject({ id: z.string().min(1) })).default([]),
  enabled: z.boolean().optional(), status: z.string().optional(),
})
type NativeModel = z.infer<typeof modelSchema>
const modelListSchema = z.looseObject({ data: z.array(modelSchema) })
const defaultModelSchema = z.looseObject({ data: modelSchema.nullable().optional() })
const providerListSchema = z.looseObject({ data: z.array(z.looseObject({ id: z.string().min(1), name: z.string().min(1), activation: z.string().optional() })) })
const ruleSchema = z.looseObject({ action: z.string(), resource: z.string(), effect: z.string() })
const modelRefSchema = z.looseObject({ id: z.string().min(1), providerID: z.string().min(1), variant: z.string().optional() })
const sessionSchema = z.looseObject({
  id: z.string().min(1), model: modelRefSchema.optional(), outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(),
  permissions: z.array(ruleSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional().transform(value => (value ?? undefined) as Readonly<Record<string, { thread?: unknown } | undefined>> | undefined),
})
type NativeSession = z.infer<typeof sessionSchema>
const sessionListSchema = z.looseObject({ data: z.array(sessionSchema), cursor: z.looseObject({ next: z.string().nullable().optional() }).optional() })
const sessionReplySchema = z.looseObject({ data: sessionSchema })
const promptReplySchema = z.looseObject({ data: z.looseObject({ id: z.string().min(1) }) })
const toolPartSchema = z.looseObject({
  type: z.literal('tool'), id: z.string().min(1), name: z.string().min(1),
  state: z.looseObject({ status: z.string().optional(), input: z.record(z.string(), z.unknown()).optional(), content: z.unknown().optional(),
    error: z.looseObject({ message: z.string().optional() }).optional() }).default({}),
  time: z.looseObject({ created: z.number().optional(), completed: z.number().optional() }).optional(),
})
const historyEntrySchema = z.looseObject({
  id: z.string().min(1), type: z.string().min(1), text: z.string().optional(),
  time: z.looseObject({ created: z.number().optional(), completed: z.number().optional() }).optional(),
  content: z.array(z.looseObject({ type: z.string() })).optional(),
  outcome: z.string().optional(),
  /** The files the step changed, relative to the provider session's folder. */
  snapshot: z.looseObject({ files: z.array(z.string()).optional() }).optional(),
})
type HistoryEntry = z.infer<typeof historyEntrySchema>
const historyPageSchema = z.looseObject({ data: z.array(historyEntrySchema), cursor: z.looseObject({ next: z.string().nullable().optional() }).optional() })
const ofSession = z.looseObject({ sessionID: z.string() })
const inboxEnqueuedSchema = ofSession.extend({ inboxID: z.string().min(1), item: z.looseObject({ payload: z.looseObject({ text: z.string().default('') }).optional() }).optional() })
const blockSchema = ofSession.extend({ assistantMessageID: z.string().min(1), ordinal: z.number().int().nonnegative().default(0), delta: z.string().optional(), text: z.string().optional() })
const toolEventSchema = ofSession.extend({ id: z.string().min(1), name: z.string().optional(), input: z.record(z.string(), z.unknown()).optional(),
  content: z.unknown().optional(), error: z.looseObject({ type: z.string().optional(), message: z.string().optional() }).optional() })
const stepStartedSchema = ofSession.extend({ assistantMessageID: z.string().min(1), started: z.number().optional() })
const executionEndSchema = ofSession.extend({ error: z.looseObject({ type: z.string().optional() }).optional() })
const tokensSchema = z.looseObject({ input: z.number().default(0), output: z.number().default(0), cache: z.looseObject({ read: z.number().default(0) }).optional() })
const usageSchema = ofSession.extend({ tokens: tokensSchema })
/** A finished step: what it cost, and the files it changed, relative to the provider session's folder (2.0.31). */
const stepEndedSchema = ofSession.extend({ assistantMessageID: z.string().min(1), tokens: tokensSchema.optional(), files: z.array(z.string()).default([]) })
const repliedSchema = ofSession.extend({ requestID: z.string().min(1) })
const formSettledSchema = ofSession.extend({ id: z.string().min(1) })
const permissionsChangedSchema = ofSession.extend({ permissions: z.array(ruleSchema) })
const modelSelectedSchema = ofSession.extend({ model: modelRefSchema })

interface ThreadServer {
  ready: Promise<ThreadServer>
  server?: OpenCodeServer
  client?: OpenCodeClient
  readonly abort: AbortController
  closing: boolean
  /** This server took a creation whose answer was lost, and may still be making that provider session. */
  createUnsettled?: boolean
  /** Sotto's tool servers being given to this server, for the folder `toolsFolder`; it never rejects. */
  tools?: Promise<void>
  toolsFolder?: string
  /** The names of the tool servers this server was given, which are taken off again when the thread's session ends. */
  toolServers?: readonly string[]
}
type Pending = OpenCodePending
interface Fold {
  /** Each reply block's words so far, by the message ID it is recorded under. */
  readonly texts: Map<string, string>
  /** Each run of reasoning so far, by its activity ID. */
  readonly reasoning: Map<string, string>
  readonly tools: Map<string, OpenCodeTool>
  /** When each assistant message began, which history reports as its creation, so live and resumed replies match. */
  readonly started: Map<string, number>
}
const freshFold = (): Fold => ({ texts: new Map(), reasoning: new Map(), tools: new Map(), started: new Map() })
/** Where a record from OpenCode goes in a thread: its Sotto turn, and the message it follows. */
interface Placement { readonly turnId: string; readonly afterMessageId: string | undefined }
const iso = (at: number | undefined): string => at !== undefined && Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString()
/** How long OpenCode may take to connect one of Sotto's tool servers: it holds the request while it connects. */
const TOOL_CONNECT_TIMEOUT_MS = 45_000
/**
 * How long a send waits for its server's tool servers before it goes without them. Sotto's servers answer at once, so they
 * are in place well inside this; a connect that hangs never holds a prompt longer, and the tools join a later step.
 */
const TOOL_SEND_GRACE_MS = 2_000
/** How long taking a tool server off may take as a thread's session ends; its server is stopped whatever the answer. */
const TOOL_REMOVE_TIMEOUT_MS = 3_000
const generatedSchema = z.looseObject({ data: z.looseObject({ text: z.string() }) })

export interface OpenCodeHostOptions {
  executable?: string
  /** Arguments before `serve` and `--version`, used by the scripted provider. */
  args?: string[]
  environment?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  /** How long a server may take to say where it listens. */
  startTimeoutMs?: number
  reaperSweepMs?: number
  sessionIdleMs?: number
  /** Stable event names only: nothing OpenCode prints or sends reaches it. */
  log?: (event: OpenCodeServerEvent) => void
  /** The providers held to Owl on this run, read once at start (ADR-0072). Absent holds every one. */
  heldProviders?: HeldProviders
}

/**
 * OpenCode 2 as a thread provider (ADR-0087): one `opencode serve` per thread (ADR-0038) on Sotto's own OpenCode folder,
 * spoken to over HTTP with that server's own password, its work followed on its event stream. OpenCode owns its
 * sign-ins, tools and provider sessions; Sotto keeps only which provider session each thread is and what it sent.
 */
export class OpenCodeHost implements AgentHost {
  private launchProfiles: ThreadLaunchProfiles | undefined
  useLaunchProfiles(profiles: ThreadLaunchProfiles): void { this.launchProfiles = profiles }
  private readonly folders: OpenCodeFolders
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  private readonly threads = new Map<string, AgentThread>()
  private readonly pending = new Map<string, Pending>()
  private readonly activePrompts = new Set<string>()
  /** The turn each thread is running, by the Sotto ID of the user message that opened it. */
  private readonly activeTurns = new Map<string, { messageId: string }>()
  private readonly folds = new Map<string, Fold>()
  private readonly revisions = new Map<string, number>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly activityListeners = new ActivitySubscribers()
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    for (const listener of this.listeners) listener(this.current())
    this.activityListeners.publish(historyFromEvents => this.activitySnapshot(historyFromEvents))
  }, () => adapterItemCount(this.log, this.threads.values()))
  private readonly processes = new Map<string, ThreadServer>()
  private readonly holds = new Map<string, number>()
  private readonly exits = new Set<Promise<void>>()
  /** Servers whose thread's session is ending: out of `processes`, and still taking their tool servers off. */
  private readonly stopping = new Set<ThreadServer>()
  private executable: string | undefined
  /** The connect check's short-lived server while it starts or answers, so a disconnect stops it too. */
  private probe: Promise<{ server: OpenCodeServer }> | undefined
  /** Aborted when Sotto disconnects, which ends the connect check's requests with its server. */
  private probeClosed = new AbortController()
  private writing = Promise.resolve()
  private readonly log = new ThreadMessageLog()
  private history: ThreadHistorySource | undefined
  private readonly observed = new Set<string>()
  private readonly loaded = new OpenSessions(id => this.threads.get(id))
  private readonly loading = new Map<string, Promise<void>>()
  /** Each thread's creation while it runs, so opening the thread meanwhile waits for it rather than making another session. */
  private readonly creating = new Map<string, Promise<void>>()
  private readonly readsBeforeSend = new ReadsBeforeSend(id => this.readState(id))
  private readonly reaper: SessionReaper
  private generation = 0
  private state: AgentHostSnapshot = {
    connected: false, name: 'OpenCode', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true, configureThreadModel: true, skills: false, steer: true, compact: false },
  }
  constructor(private readonly userDataDirectory: string, private readonly options: OpenCodeHostOptions = {}) {
    this.folders = opencodeFolders(join(userDataDirectory, 'opencode'))
    this.aliasStore = new AtomicJsonStore(join(userDataDirectory, 'opencode-threads.json'), z.record(z.string(), aliasSchema).parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(userDataDirectory, 'opencode-projects.json'), z.array(agentProjectSchema).parse, () => [])
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs !== undefined ? { sweepEveryMs: options.reaperSweepMs } : {}),
      ...(options.sessionIdleMs !== undefined ? { idleAfterMs: options.sessionIdleMs } : {}),
      isWatched: id => this.observed.has(id),
      isBusy: id => this.busy(id),
      stop: id => this.stopSession(id),
    })
  }
  private get timeoutMs(): number { return this.options.requestTimeoutMs ?? 15_000 }
  private get environment(): NodeJS.ProcessEnv { return this.options.environment ?? process.env }
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
  private emit(streaming = false): void { this.publisher.publish(streaming) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  useThreadHistory(source: ThreadHistorySource): void { this.history = source }
  private persist(): Promise<void> { this.writing = this.aliasStore.write(structuredClone(this.aliases)); return this.writing }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new OpenCodeUncertain('The OpenCode connection changed before the operation could continue.')
  }
  private thread(id: string): AgentThread {
    const alias = this.aliases[id]; if (!alias) throw new Error('The OpenCode thread does not exist.')
    if (!this.threads.has(id)) this.threads.set(id, {
      id, projectId: alias.projectId, workingDirectory: alias.cwd, title: alias.title, modelId: alias.modelId,
      runtimeMode: alias.runtimeMode, ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}),
      status: alias.sessionConfirmed ? 'idle' : 'error', messages: [], requests: [],
      ...(this.toolsWithheld.has(id) ? { sottoToolsWithheld: true as const } : {}),
    })
    return this.threads.get(id)!
  }
  private fold(id: string): Fold {
    let fold = this.folds.get(id)
    if (!fold) { fold = freshFold(); this.folds.set(id, fold) }
    return fold
  }
  private touched(id: string): void { this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1) }
  private readState(id: string): string { return `${this.generation}:${this.revisions.get(id) ?? 'unread'}` }
  private markTurn(id: string, status: AgentActivity['status'], turnId?: string, error?: string): void {
    const thread = this.threads.get(id); if (!thread) return
    const last = this.log.lastUserMessageId(id)
    const turn = turnId ?? last
    if (turn === undefined) return
    thread.activities = markTurnActivity(thread.activities, {
      provider: 'opencode', turnId: turn, status, ...(last === turn ? { afterMessageId: turn } : {}), ...(error !== undefined ? { error } : {}),
    })
  }
  /** The Sotto turn a record from OpenCode belongs to: the running turn's, or the newest user message's. */
  private turnOf(id: string): string { return this.activeTurns.get(id)?.messageId ?? this.log.lastUserMessageId(id) ?? 'native-history' }

  /**
   * Watcher is refused before any OpenCode process starts (ADR-0087): OpenCode cannot yet take Watcher's tools or keep
   * its approvals with the user the way Watcher needs, so a thread main gives Watcher's profile starts nothing.
   */
  private async refuseWatcher(id: string): Promise<void> {
    const generation = this.generation
    let profile
    try { profile = await this.launchProfiles?.profileFor(id) }
    catch (error) {
      this.assertGeneration(generation)
      throw error instanceof WatcherProfileRefusal ? error : new WatcherProfileRefusal('Watcher’s saved profile could not be verified. Nothing was sent.')
    }
    this.assertGeneration(generation)
    if (!profile) return
    const refused = watcherRefused(this.options.heldProviders ?? heldProvidersOf({}))
    try { profile.revoke(refused) } catch { /* The refusal stands whatever the revocation does. */ }
    throw new WatcherProfileRefusal(refused)
  }

  private browserTools: BrowserAgentTools | undefined
  useBrowserTools(tools: BrowserAgentTools): void { this.browserTools = tools }
  private threadTools: readonly ScopedThreadTools[] = []
  useThreadTools(tools: readonly ScopedThreadTools[]): void { this.threadTools = tools }
  /** Threads whose server could not be given every one of Sotto's tool servers it was offered. Never saved. */
  private readonly toolsWithheld = new Set<string>()
  /** A thread's rule set: its mode's, then the allows for Sotto's own tools (ADR-0087). */
  private rulesFor(mode: OpenCodeMode): OpenCodeRule[] { return [...opencodeRules(mode), ...opencodeToolRules(opencodeToolActions(this.browserTools, this.threadTools))] }
  /**
   * Give a thread's server Sotto's tool servers for the folder its provider session works in, unless it has them for that
   * folder already. It runs beside whatever the thread does next, since OpenCode holds the request while it connects.
   */
  private giveTools(id: string, entry: ThreadServer, folder: string): void {
    if (entry.toolsFolder === folder || entry.closing) return
    entry.toolsFolder = folder
    entry.tools = this.addToolServers(id, entry, folder).catch(() => { if (!entry.closing) this.withholdTools(id, true) })
  }
  /**
   * Sotto's tool servers reach an OpenCode thread as remote MCP servers on that thread's own server, each with the thread's
   * bearer token (ADR-0087), as Grok Build and Muse get them: the same servers, asked for at each start, so a renewed token
   * reaches a new server. OpenCode keeps them for the folder until the process ends and writes nothing down. A server it
   * refuses or does not list as connected leaves the thread marked as without Sotto's tools, as a Muse thread is.
   */
  private async addToolServers(id: string, entry: ThreadServer, folder: string): Promise<void> {
    const generation = this.generation
    const servers: OpenCodeToolServer[] = await opencodeToolServers(this.browserTools, this.threadTools, id)
    if (entry.closing || generation !== this.generation || !entry.client) return
    if (!servers.length) { this.withholdTools(id, false); return }
    const client = entry.client, location = locationQuery(folder)
    entry.toolServers = [...new Set([...entry.toolServers ?? [], ...servers.map(server => server.name)])]
    const added = await Promise.all(servers.map(server => client.request('PUT', `/api/experimental/mcp/${encodeURIComponent(server.name)}`,
      { query: location, body: { config: server.config }, timeoutMs: TOOL_CONNECT_TIMEOUT_MS }).then(() => true, () => false)))
    if (entry.closing || generation !== this.generation) return
    const connected = added.every(Boolean) ? connectedToolServers(await client.request('GET', '/api/mcp', { query: location }).catch(() => undefined)) : new Set<string>()
    if (entry.closing || generation !== this.generation) return
    this.withholdTools(id, !servers.every(server => connected.has(server.name)))
  }
  private withholdTools(id: string, withheld: boolean): void {
    if (withheld === this.toolsWithheld.has(id)) return
    if (withheld) this.toolsWithheld.add(id); else this.toolsWithheld.delete(id)
    const thread = this.threads.get(id)
    if (thread) { if (withheld) thread.sottoToolsWithheld = true; else delete thread.sottoToolsWithheld; this.emit() }
  }
  /** A send waits a moment for its server's tool servers, never longer: a connect that hangs does not hold the prompt. */
  private async toolsGiven(entry: ThreadServer): Promise<void> {
    if (!entry.tools) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([entry.tools, new Promise<void>(resolve => { timer = setTimeout(resolve, TOOL_SEND_GRACE_MS); timer.unref() })])
    clearTimeout(timer)
  }
  /** Take Sotto's tool servers off a thread's server as its session ends; the server stops whatever OpenCode answers. */
  private async removeToolServers(entry: ThreadServer): Promise<void> {
    const client = entry.client, folder = entry.toolsFolder
    if (!client || !folder || !entry.toolServers?.length || entry.closing) return
    await Promise.all(entry.toolServers.map(name => client.request('DELETE', `/api/experimental/mcp/${encodeURIComponent(name)}`,
      { query: locationQuery(folder), timeoutMs: TOOL_REMOVE_TIMEOUT_MS }).catch(() => undefined)))
  }

  /**
   * Start one server and prove it is OpenCode 2 at the floor or newer; one that is not is stopped again. Its requests end
   * when `closed` aborts, as the server is being stopped.
   */
  private async startServer(cwd: string, closed: AbortSignal): Promise<{ server: OpenCodeServer; client: OpenCodeClient; version: string }> {
    const executable = this.executable
    if (!executable) throw new Error('Connect OpenCode before managing threads.')
    await ensureOpenCodeFolders(this.folders)
    return withFirstServerLock(this.folders, async () => {
      const password = opencodePassword()
      const server = await OpenCodeServer.start({ executable, ...(this.options.args ? { args: this.options.args } : {}), cwd,
        env: opencodeEnvironment(this.environment, this.folders, password), timeoutMs: this.options.startTimeoutMs ?? 30_000, log: this.options.log,
        ledger: this.folders.servers })
      try {
        const client = new OpenCodeClient(server.url, password, this.timeoutMs, closed)
        const info = infoSchema.parse(await client.request('GET', '/api/info'))
        const refusal = opencodeVersionRefusal(info.version)
        if (refusal) throw refusal
        this.options.log?.('opencode-server-ready')
        return { server, client, version: info.version }
      } catch (error) { await server.stop(); throw error }
    })
  }

  private threadProcess(id: string, cwd?: string): Promise<ThreadServer> {
    const current = this.processes.get(id); if (current) return current.ready
    if (!this.state.connected || !this.executable) return Promise.reject(new Error('Connect OpenCode before managing threads.'))
    const generation = this.generation
    const entry = { abort: new AbortController(), closing: false } as ThreadServer
    // Tracked from its start, so a server no thread goes on to use is stopped once it has sat idle.
    this.reaper.touch(id)
    entry.ready = (async () => {
      await this.refuseWatcher(id)
      this.assertGeneration(generation)
      const folder = cwd ?? this.aliases[id]?.cwd ?? this.folders.data
      const started = await this.startServer(folder, entry.abort.signal)
      if (entry.closing || generation !== this.generation || this.processes.get(id) !== entry) {
        await started.server.stop()
        throw new OpenCodeUncertain('The OpenCode connection changed while the thread was starting.')
      }
      entry.server = started.server; entry.client = started.client
      void started.server.closed.then(() => this.processLost(id, entry))
      const stream = started.client.events(event => this.event(id, entry, event), entry.abort.signal)
      void stream.ended.then(error => { if (error) this.processLost(id, entry) })
      await stream.connected
      this.giveTools(id, entry, folder)
      return entry
    })()
    this.processes.set(id, entry)
    entry.ready.catch(() => {
      if (this.processes.get(id) === entry) this.processes.delete(id)
      // A server that started but never became ready, such as one whose event stream failed first, is stopped too.
      if (!entry.closing) this.closeProcess(entry)
    })
    return entry.ready
  }
  /** Stop a thread's server, whether its start finished or failed after it was allocated. Resolves once it is gone. */
  private closeProcess(entry: ThreadServer): Promise<void> {
    entry.closing = true; entry.abort.abort()
    const exit: Promise<void> = entry.ready.then(() => undefined, () => undefined).then(() => entry.server?.stop()).finally(() => { this.exits.delete(exit) })
    this.exits.add(exit)
    return exit
  }
  /** A thread's server ended without Sotto stopping it: a running turn ends as interrupted, and nothing is answered. */
  private processLost(id: string, entry: ThreadServer): void {
    if (entry.closing) return
    this.closeProcess(entry)
    if (this.processes.get(id) !== entry) return
    this.processes.delete(id); this.loaded.delete(id); this.folds.delete(id); this.log.release(id); this.reaper.forget(id)
    for (const pending of [...this.pending.values()]) if (pending.threadId === id) this.pending.delete(pending.request.id)
    const sending = this.activePrompts.delete(id)
    const active = this.activeTurns.get(id); this.activeTurns.delete(id)
    const thread = this.threads.get(id), alias = this.aliases[id]
    if (thread) {
      thread.requests = []
      if (active) {
        if (alias) { alias.endedTurn = { messageId: active.messageId, outcome: 'interrupted' }; void this.persist().catch(() => undefined) }
        this.endTurn(id, active.messageId, 'interrupted', SERVER_LOST)
      } else if (sending) thread.status = 'idle'
    }
    this.emit()
  }
  private async stopSession(id: string): Promise<void> {
    const entry = this.processes.get(id)
    if (this.loaded.delete(id)) this.emit()
    this.folds.delete(id); this.log.release(id)
    if (!entry) return
    this.processes.delete(id)
    // Tracked whole, so a disconnect while the tool servers are being taken off stops the server and waits for it.
    this.stopping.add(entry)
    const stopped = this.removeToolServers(entry).then(() => this.closeProcess(entry))
    const exit: Promise<void> = stopped.catch(() => undefined).finally(() => { this.stopping.delete(entry); this.exits.delete(exit) })
    this.exits.add(exit)
    await stopped
  }
  /** Stop the server a thread that was never made started, unless another has taken its place. */
  private dropServer(id: string, entry: ThreadServer): void {
    if (this.processes.get(id) === entry) void this.stopSession(id)
  }
  private hold(id: string): () => void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1)
    let held = true
    return () => {
      if (!held) return
      held = false
      const left = (this.holds.get(id) ?? 1) - 1
      if (left > 0) this.holds.set(id, left); else this.holds.delete(id)
    }
  }

  /**
   * Connecting checks the client and reads its catalog on a server of its own, which stops once it has answered, as Grok's
   * check keeps no process between connects. Threads start their own servers as they are needed.
   */
  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    await mkdir(this.userDataDirectory, { recursive: true })
    // Servers a Sotto that crashed left running on this folder are ended before any of this run's start (ADR-0087).
    await endServersLeftBehind(this.folders.servers, this.options.log)
    this.assertGeneration(generation)
    const executable = this.options.executable ?? await findOpenCodeExecutable(this.environment)
    if (!executable || !isAbsolute(executable)) throw new ProviderUnavailable('not-installed', 'Install OpenCode 2, then connect again. Your threads and drafts are kept.')
    let tooOld: string | undefined
    try {
      const said = await readOpenCodeVersion(executable, this.options.args ?? [], opencodeEnvironment(this.environment, this.folders, opencodePassword()))
      const refusal = opencodeVersionRefusal(said ?? '')
      if (refusal instanceof OpenCodeTooOld) tooOld = refusal.version
      if (refusal) throw refusal
      this.aliases = await this.aliasStore.read(); this.state.projects = await this.projectStore.read()
      this.threads.clear(); this.activePrompts.clear(); this.activeTurns.clear(); this.folds.clear(); this.readsBeforeSend.clear()
      this.assertGeneration(generation)
      this.executable = executable
      this.probeClosed = new AbortController()
      const starting = this.startServer(this.folders.data, this.probeClosed.signal)
      this.probe = starting
      // Its exit is tracked with the thread servers', so `closed()` waits for it however it ends.
      const exit: Promise<void> = starting.then(started => started.server.closed.then(() => started.server.stop()), () => undefined).finally(() => { this.exits.delete(exit) })
      this.exits.add(exit)
      const probe = await starting
      try {
        const location = locationQuery(this.folders.data)
        const models = modelListSchema.parse(await probe.client.request('GET', '/api/model', { query: location })).data
        const fallback = await probe.client.request('GET', '/api/model/default', { query: location }).then(value => defaultModelSchema.parse(value).data ?? undefined, () => undefined)
        const providers = providerListSchema.parse(await probe.client.request('GET', '/api/provider', { query: location })).data
        this.assertGeneration(generation)
        this.applyCatalog(probe.version, models, providers, fallback)
      } finally {
        if (this.probe === starting) this.probe = undefined
        await probe.server.stop()
      }
      if (!this.state.models.length) throw new ProviderUnavailable('cannot-start', 'OpenCode is set up but listed no models, so there is nothing to start a thread with. Your threads and drafts are kept. Run opencode in a terminal to see why, then connect it again.', this.state.version)
      this.log.forgetAll()
      for (const id of Object.keys(this.aliases)) { this.thread(id); this.log.seed(id, this.history?.messageIdentities(id) ?? []) }
      this.state.connected = true; delete this.state.error
      await Promise.all(Object.keys(this.aliases).filter(id => this.aliases[id]?.sessionConfirmed && this.observed.has(id)).map(id => this.open(id).catch(() => undefined)))
      this.assertGeneration(generation)
      this.reaper.start()
      this.emit(); return this.current()
    } catch (error) {
      if (generation === this.generation) this.disconnect()
      const refused = error instanceof OpenCodeUnsupported || error instanceof ProviderUnavailable
      const detail = refused ? error.message : ''
      const message = ['Could not connect OpenCode.', detail, refused ? '' : 'Connect again to retry.'].filter(Boolean).join(' ')
      if (error instanceof ProviderUnavailable) throw new ProviderUnavailable(error.problem, `Could not connect OpenCode. ${error.message}`, error.version, error.requiredVersion)
      if (tooOld) throw new ProviderUnavailable('too-old', message, tooOld, OPENCODE_CLI_VERSION)
      if (error instanceof OpenCodeUnsupported) throw new ProviderUnavailable('cannot-start', message)
      throw new Error(message, { cause: error })
    }
  }
  /**
   * The catalog as Sotto offers it (ADR-0087). A model's Sotto ID is `<providerID>/<modelID>`; its source is where it
   * runs, OpenCode Zen for the free models; the provider label stays OpenCode, so no model reads as another provider.
   */
  private applyCatalog(version: string, models: readonly NativeModel[], providers: readonly { id: string; name: string }[], fallback: NativeModel | undefined): void {
    this.state.version = version
    if (compareClientVersions(version, OPENCODE_CLI_VERSION) > 0) this.state.verifiedVersion = OPENCODE_CLI_VERSION
    else delete this.state.verifiedVersion
    const names = new Map(providers.map(provider => [provider.id, provider.name]))
    const sourceOf = (providerId: string): string => providerId === ZEN ? ZEN_NAME : names.get(providerId) ?? providerId
    const shown = models.filter(model => model.enabled !== false && model.status !== 'deprecated')
    this.state.models = shown.map((model): AgentModel => {
      const efforts = orderReasoningEfforts(model.variants.map(variant => variant.id))
      const preferred = ['medium', 'high'].find(level => efforts.includes(level)) ?? efforts[0]
      return {
        id: `${model.providerID}/${model.id}`, name: model.name, provider: 'OpenCode', source: sourceOf(model.providerID), ready: true,
        runtimeModes: [...opencodeRuntimeModes], supportsImages: model.capabilities.input.includes('image'),
        ...(efforts.length ? { reasoningEfforts: efforts, ...(preferred ? { defaultReasoningEffort: preferred } : {}) } : {}),
        ...(fallback && fallback.id === model.id && fallback.providerID === model.providerID ? { recommended: true } : {}),
      }
    })
    // Sotto's OpenCode folder starts with no sign-ins: until the user signs in to a model source inside it, only Zen's free
    // models are listed. A source is named only for models Sotto offers, so the line never names one the list leaves out.
    const signedIn = [...new Set(shown.map(model => model.providerID).filter(id => id !== ZEN))].map(sourceOf)
    const account = signedIn.length ? `Signed in to ${signedIn.join(', ')}` : 'No model source signed in yet; OpenCode Zen’s free models only'
    this.state.account = account.length > 80 ? `${account.slice(0, 79)}…` : account
  }

  /** Early start (#769): a thread OpenCode already has opens its session; a draft gets the server its first send would use. */
  async startThreadSession(id: string, draft?: ThreadSessionDraft): Promise<void> {
    const generation = this.generation
    await this.refuseWatcher(id)
    this.assertGeneration(generation)
    if (!this.state.connected) return
    if (this.aliases[id]) { await this.open(id); return }
    if (!draft) return
    await this.threadProcess(id, draft.workingDirectory)
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
      if (!this.aliases[id]) continue
      if (before.has(id) && this.loaded.has(id)) continue
      void this.open(id).catch(() => {
        if (generation === this.generation) { this.state.error = 'An OpenCode thread could not be loaded. Check OpenCode, then connect it again.'; this.emit() }
      })
    }
  }
  async snapshot(): Promise<AgentHostSnapshot> { return this.current() }
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]) throw new Error('This OpenCode thread has no provider session.')
    await this.open(id)
    if (purpose?.retryUncertainAnswers) await this.retryUncertainAnswers(id, purpose.retryUncertainAnswerId)
    this.readsBeforeSend.mark(id, purpose)
    return this.current(purpose?.historyFromEvents)
  }
  /** An answer whose acknowledgement was lost is checked against what the server still holds open; nothing is resent. */
  private async retryUncertainAnswers(id: string, only?: string): Promise<void> {
    const entry = this.processes.get(id), alias = this.aliases[id]
    if (!entry?.client || !alias) return
    const uncertain = [...this.pending.values()].filter(pending => pending.threadId === id && pending.request.delivery === 'uncertain' && (!only || pending.request.id === only))
    if (!uncertain.length) return
    const listed = z.looseObject({ data: z.array(z.looseObject({ id: z.string() })) })
    const permissions = new Set(listed.parse(await entry.client.request('GET', `/api/session/${this.sid(alias)}/permission`)).data.map(item => item.id))
    const forms = new Set(listed.parse(await entry.client.request('GET', `/api/session/${this.sid(alias)}/form`)).data.map(item => item.id))
    for (const pending of uncertain) {
      const open = pending.kind === 'permission' ? permissions.has(pending.permission.id) : forms.has(pending.form.id)
      if (!open) this.removeRequest(pending)
      else { pending.answering = false; delete pending.request.delivery; pending.request.answerRetryReady = true }
    }
    this.emit()
  }

  /** Open this thread's provider session on its own server, once per connection, and read its history back. */
  private open(id: string): Promise<void> {
    const generation = this.generation
    if (!this.aliases[id] || !this.state.connected) return Promise.resolve()
    this.reaper.touch(id)
    if (this.loaded.has(id)) return Promise.resolve()
    const pending = this.loading.get(id); if (pending) return pending
    const work = (async () => {
      // A creation still running is waited for, never repeated: a thread's provider session is made once (ADR-0087).
      await this.creating.get(id)?.then(() => undefined, () => undefined)
      this.assertGeneration(generation)
      const alias = this.aliases[id]
      if (!alias || this.loaded.has(id)) return
      let entry = await this.threadProcess(id)
      this.assertGeneration(generation)
      let session: NativeSession | undefined
      if (alias.sessionId) {
        try { session = sessionReplySchema.parse(await entry.client!.request('GET', `/api/session/${alias.sessionId}`)).data }
        catch (error) { if (!(error instanceof OpenCodeRejected && error.status === 404)) throw error }
        if (!session) throw new Error('OpenCode no longer has this thread’s provider session. Nothing was changed.')
      } else {
        // A creation whose answer was lost: the provider session it made, if it made one, carries this thread's mark.
        session = await this.markedSession(entry, alias)
        if (!session && entry.createUnsettled) {
          // The server that took it may still be making it, so only a server that never saw it can say it was not made.
          // The thread has no provider session yet, so nothing else runs on the server that is stopped for this.
          if (this.processes.get(id) === entry) this.processes.delete(id)
          await this.closeProcess(entry)
          this.assertGeneration(generation)
          entry = await this.threadProcess(id)
          this.assertGeneration(generation)
          session = await this.markedSession(entry, alias)
        }
        if (session) { alias.sessionId = session.id; alias.sessionConfirmed = true; await this.persist() }
        else session = await this.createSession(entry, alias)
      }
      this.assertGeneration(generation)
      if (this.processes.get(id) !== entry) throw new OpenCodeUncertain('The thread’s OpenCode server changed before its session could open.')
      const client = entry.client!
      const entries: HistoryEntry[] = []
      let cursor: string | undefined
      for (let page = 0; page < 500; page++) {
        const read = historyPageSchema.parse(await client.request('GET', `/api/session/${this.sid(alias)}/message`, { query: cursor ? { cursor } : { order: 'asc' } }))
        entries.push(...read.data)
        const next = read.cursor?.next ?? undefined
        if (!read.data.length || !next || next === cursor) break
        cursor = next
      }
      this.assertGeneration(generation)
      if (this.processes.get(id) !== entry) return
      const ended = this.foldHistory(id, entries)
      this.confirmSession(id, alias, session)
      this.settleEndedTurn(id, session, ended)
      await this.persist()
      this.loaded.add(id); this.log.pin(id); this.reaper.touch(id); this.touched(id); this.emit()
    })().finally(() => { if (this.loading.get(id) === work) this.loading.delete(id) })
    this.loading.set(id, work)
    return work
  }
  private async createSession(entry: ThreadServer, alias: Alias): Promise<NativeSession> {
    const body = {
      title: alias.title, model: this.modelRef(alias.modelId, alias.reasoningEffort), location: { directory: alias.cwd },
      permissions: this.rulesFor(alias.runtimeMode), metadata: { [CREATE_MARK]: { thread: alias.createToken } },
    }
    let session: NativeSession
    try { session = sessionReplySchema.parse(await entry.client!.request('POST', '/api/session', { body })).data }
    catch (error) {
      // A refusal made nothing. Anything else was sent and its answer lost or unreadable: the session may exist, or yet be made.
      if (error instanceof OpenCodeRejected) throw error
      entry.createUnsettled = true
      throw error instanceof OpenCodeUncertain ? error : new OpenCodeUncertain('OpenCode sent a reply Sotto cannot read.')
    }
    alias.sessionId = session.id; alias.sessionConfirmed = true
    await this.persist()
    return session
  }
  /** The provider session in the thread's folder that carries its creation mark, newest first, if one exists. */
  private async markedSession(entry: ThreadServer, alias: Alias): Promise<NativeSession | undefined> {
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const read = sessionListSchema.parse(await entry.client!.request('GET', '/api/session', { query: cursor ? { cursor } : { directory: alias.cwd } }))
      const found = read.data.find(session => session.metadata?.[CREATE_MARK]?.thread === alias.createToken)
      if (found) return found
      const next = read.cursor?.next ?? undefined
      if (!read.data.length || !next || next === cursor) return undefined
      cursor = next
    }
    return undefined
  }
  /** The thread's provider session ID, which every request after its opening names. */
  private sid(alias: Alias): string {
    if (!alias.sessionId) throw new OpenCodeUncertain('OpenCode has not confirmed this thread’s provider session.')
    return alias.sessionId
  }
  private modelRef(modelId: string, effort: string | undefined): { id: string; providerID: string; variant?: string } {
    const at = modelId.indexOf('/')
    if (at <= 0) throw new Error('That model is not an OpenCode model.')
    const offered = this.state.models.find(model => model.id === modelId)?.reasoningEfforts ?? []
    return { providerID: modelId.slice(0, at), id: modelId.slice(at + 1), ...(effort && offered.includes(effort) ? { variant: effort } : {}) }
  }
  /** What a provider session reports settles the thread's model, effort and mode. */
  private confirmSession(id: string, alias: Alias, session: NativeSession): void {
    if (session.model) {
      alias.modelId = `${session.model.providerID}/${session.model.id}`
      if (session.model.variant && session.model.variant !== 'default') alias.reasoningEffort = session.model.variant
    }
    const mode = modeOfRules(session.permissions)
    if (mode) alias.runtimeMode = mode
    const thread = this.thread(id)
    thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode
    if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort; else delete thread.reasoningEffort
    if (thread.status === 'error' && !this.activeTurns.has(id)) thread.status = 'idle'
  }
  /**
   * A turn whose server died never records its end: the provider session has no outcome and its tool still reads as
   * running (ADR-0087). The new server does not repair it, so Sotto shows it stopped rather than running for good.
   */
  private settleEndedTurn(id: string, session: NativeSession, unfinished: string | undefined): void {
    const alias = this.aliases[id], thread = this.threads.get(id)
    if (!alias || !thread || this.activeTurns.has(id) || this.activePrompts.has(id)) return
    const messageId = alias.endedTurn?.messageId ?? (session.outcome === undefined ? unfinished : undefined)
    if (messageId) {
      const outcome = alias.endedTurn?.outcome ?? 'interrupted'
      this.endTurn(id, messageId, outcome, outcome === 'failed' ? TURN_FAILED : undefined)
    } else if (thread.status === 'running') thread.status = 'idle'
    delete alias.endedTurn
  }
  /** Settle a turn: its record, the thread's state, and any work it left showing as running. */
  private endTurn(id: string, messageId: string, outcome: 'completed' | 'failed' | 'interrupted', error?: string): void {
    const thread = this.thread(id)
    if (this.activeTurns.get(id)?.messageId === messageId || outcome !== 'completed') this.activeTurns.delete(id)
    for (const pending of [...this.pending.values()]) if (pending.threadId === id) this.removeRequest(pending)
    this.log.dropEmpty(id)
    thread.status = outcome === 'failed' ? 'error' : 'idle'
    thread.lastTurn = { id: messageId, status: outcome }
    if (thread.activities?.length) thread.activities = thread.activities.map(record => record.kind !== 'turn' && record.status === 'running' && record.turnId === messageId
      ? { ...record, status: outcome === 'completed' ? 'unknown' : outcome } : record)
    this.markTurn(id, outcome, messageId, error)
  }

  /** A user's message as Sotto records it, the same whether it came live or from history, so a resume matches. */
  private userMessage(alias: Alias, inboxId: string, text: string, at: number | undefined): AgentMessage {
    const origin = alias.origins.find(candidate => candidate.inboxId === inboxId)
    return {
      id: origin?.messageId ?? `opencode-msg-${inboxId}`, role: 'user', text, createdAt: origin?.createdAt ?? iso(at),
      ...(origin ? { commandId: origin.commandId } : {}),
      ...(origin?.attachments.length ? { attachments: origin.attachments.map(ref => ({ ...ref })) } : {}),
    }
  }
  /** Record a user's message; returns the Sotto message ID it is recorded under. */
  private recordUser(id: string, inboxId: string, text: string, at: number | undefined): string | undefined {
    const alias = this.aliases[id]; if (!alias) return undefined
    const message = this.userMessage(alias, inboxId, text, at)
    this.log.add(id, message)
    const origin = alias.origins.find(candidate => candidate.inboxId === inboxId)
    if (origin && !origin.confirmed) { origin.confirmed = true; void this.persist().catch(() => undefined) }
    return message.id
  }
  /** Record a block of a reply; returns the message ID it is recorded under. */
  private recordText(id: string, assistantMessageId: string, ordinal: number, text: string, at?: number): string {
    const messageId = opencodeTextMessageId(assistantMessageId, ordinal)
    this.fold(id).texts.set(messageId, text)
    const started = this.fold(id).started.get(assistantMessageId)
    this.log.add(id, { id: messageId, role: 'assistant', text, createdAt: started !== undefined ? iso(started) : this.log.message(id, messageId)?.createdAt ?? iso(at) })
    return messageId
  }
  /** Where a live record goes: the running turn, after the newest message. History says its own place instead. */
  private placed(id: string, placement?: Placement): Placement {
    return placement ?? { turnId: this.turnOf(id), afterMessageId: this.log.lastMessageId(id) }
  }
  private recordTool(id: string, tool: OpenCodeTool, placement?: Placement): void {
    const thread = this.thread(id)
    const { turnId, afterMessageId } = this.placed(id, placement)
    this.fold(id).tools.set(tool.id, tool)
    thread.activities = mergeAgentActivities(thread.activities, [opencodeToolActivity(tool, turnId, afterMessageId)])
  }
  private recordReasoning(id: string, assistantMessageId: string, ordinal: number, text: string, done: boolean, at?: number, placement?: Placement): void {
    const thread = this.thread(id)
    const { turnId, afterMessageId } = this.placed(id, placement)
    const activity = opencodeReasoningActivity(assistantMessageId, ordinal, text, done, turnId, iso(at), afterMessageId)
    this.fold(id).reasoning.set(activity.id, text)
    thread.activities = mergeAgentActivities(thread.activities, [activity])
  }
  /**
   * The files one step changed, as OpenCode lists them when the step ends (ADR-0087): one file-change record per step,
   * under the same ID live and in history. A file an edit tool in the same turn already reported is not shown twice.
   */
  private recordStepFiles(id: string, assistantMessageId: string, files: readonly string[], at: number | undefined, placement?: Placement): void {
    const alias = this.aliases[id]
    if (!alias || !files.length) return
    const thread = this.thread(id)
    const { turnId, afterMessageId } = this.placed(id, placement)
    const key = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
    const reported = new Set((thread.activities ?? []).filter(record => record.kind === 'file-change' && record.turnId === turnId && record.id.startsWith('opencode-tool-'))
      .flatMap(record => (record.changes ?? []).map(change => key(resolve(alias.cwd, change.path)))))
    const paths = [...new Set(files.map(file => resolve(alias.cwd, file)))].filter(path => !reported.has(key(path)))
    if (!paths.length) return
    thread.activities = mergeAgentActivities(thread.activities, [opencodeStepFilesActivity(assistantMessageId, paths, turnId, iso(at), afterMessageId)])
  }

  /**
   * A provider session's history into what the thread said, through the same append path as the live stream. Returns
   * the user message of a turn the history shows unfinished: no idle entry after it.
   */
  private foldHistory(id: string, entries: readonly HistoryEntry[]): string | undefined {
    let unfinished: string | undefined
    // Each record goes under the user message it follows in the history, never under the newest one the log knows:
    // Sotto's own store may already hold every message of the thread before the history is read.
    let turnId = 'native-history', afterMessageId: string | undefined
    // One execution can carry several prompts, as a steer joins the running one, and history does not say where an
    // execution began. So a turn opens, as it does live, at a prompt Sotto sent as a send, which only ever starts one, or
    // at any prompt after an idle entry or before the first; Sotto's steers and prompts typed in OpenCode meanwhile join it.
    let open = false
    const placement = (): Placement => ({ turnId, afterMessageId })
    for (const entry of entries) {
      const at = entry.time?.created
      if (entry.type === 'user') {
        const messageId = this.recordUser(id, entry.id, entry.text ?? '', at)
        if (!messageId) continue
        afterMessageId = messageId
        const origin = this.aliases[id]?.origins.find(candidate => candidate.inboxId === entry.id)
        if (!open || (origin !== undefined && !origin.steer)) { turnId = messageId; unfinished = messageId; open = true }
      } else if (entry.type === 'assistant') {
        const ordinals = { text: 0, reasoning: 0 }
        if (at !== undefined) this.fold(id).started.set(entry.id, at)
        for (const part of entry.content ?? []) {
          const text = typeof part.text === 'string' ? part.text : undefined
          if (part.type === 'text' && text !== undefined) afterMessageId = this.recordText(id, entry.id, ordinals.text++, text, at)
          else if (part.type === 'reasoning' && text !== undefined) this.recordReasoning(id, entry.id, ordinals.reasoning++, text, true, at, placement())
          else if (part.type === 'tool') {
            const tool = toolPartSchema.safeParse(part)
            if (!tool.success) continue
            const status = opencodeToolStatus(tool.data.state.status)
            const output = opencodeToolOutput(tool.data.state.content)
            this.recordTool(id, { id: tool.data.id, name: tool.data.name, input: tool.data.state.input, status,
              ...(output ? { output } : {}), ...(tool.data.state.error?.message ? { error: tool.data.state.error.message } : {}),
              startedAt: iso(tool.data.time?.created ?? at), ...(status !== 'running' && tool.data.time?.completed ? { completedAt: iso(tool.data.time.completed) } : {}) }, placement())
          }
        }
        this.recordStepFiles(id, entry.id, entry.snapshot?.files ?? [], entry.time?.completed ?? at, placement())
      } else if (entry.type === 'idle') { unfinished = undefined; open = false }
    }
    return unfinished
  }

  private showRequest(pending: Pending): void {
    if (this.pending.has(pending.request.id)) return
    this.pending.set(pending.request.id, pending)
    this.thread(pending.threadId).requests.push(pending.request)
    this.emit()
  }
  private removeRequest(pending: Pending): void {
    this.pending.delete(pending.request.id)
    const thread = this.threads.get(pending.threadId)
    if (thread) thread.requests = thread.requests.filter(request => request.id !== pending.request.id)
    this.emit()
  }

  /** One event from one thread's server. Only this thread's provider session is read; everything else is skipped. */
  private event(id: string, entry: ThreadServer, event: OpenCodeEvent): void {
    if (entry.closing || this.processes.get(id) !== entry) return
    const alias = this.aliases[id]
    const data = (event.data ?? {}) as Record<string, unknown>
    const session = typeof data.sessionID === 'string' ? data.sessionID
      : typeof (data.form as { sessionID?: unknown } | undefined)?.sessionID === 'string' ? (data.form as { sessionID: string }).sessionID : undefined
    if (!alias || session === undefined || session !== alias.sessionId) return
    this.reaper.touch(id); this.touched(id)
    const thread = this.thread(id)
    try {
      switch (event.type) {
        case 'session.inbox.enqueued': {
          const parsed = inboxEnqueuedSchema.parse(data)
          this.recordUser(id, parsed.inboxID, parsed.item?.payload?.text ?? '', event.created)
          this.emit(true); return
        }
        case 'session.step.started': {
          const parsed = stepStartedSchema.safeParse(data)
          if (parsed.success && parsed.data.started !== undefined) this.fold(id).started.set(parsed.data.assistantMessageID, parsed.data.started)
          return
        }
        case 'session.execution.started': {
          if (!this.activeTurns.has(id)) {
            const messageId = this.log.lastUserMessageId(id)
            if (messageId) this.activeTurns.set(id, { messageId })
          }
          const messageId = this.activeTurns.get(id)?.messageId
          thread.status = 'running'
          if (messageId) { thread.lastTurn = { id: messageId, status: 'running' }; this.markTurn(id, 'running', messageId) }
          this.emit(); return
        }
        case 'session.text.delta': case 'session.text.ended': {
          const parsed = blockSchema.parse(data)
          const messageId = opencodeTextMessageId(parsed.assistantMessageID, parsed.ordinal)
          const before = this.fold(id).texts.get(messageId) ?? ''
          const text = event.type === 'session.text.ended' ? parsed.text ?? before : before + (parsed.delta ?? '')
          if (event.type === 'session.text.delta' && this.log.lastMessageId(id) === messageId && this.log.has(id, messageId) && parsed.delta) {
            this.fold(id).texts.set(messageId, text); this.log.appendText(id, messageId, parsed.delta)
          } else this.recordText(id, parsed.assistantMessageID, parsed.ordinal, text, event.created)
          this.emit(true); return
        }
        case 'session.reasoning.started': case 'session.reasoning.delta': case 'session.reasoning.ended': {
          const parsed = blockSchema.parse(data)
          const key = `opencode-reasoning-${parsed.assistantMessageID}-${parsed.ordinal}`
          const before = this.fold(id).reasoning.get(key) ?? ''
          const text = event.type === 'session.reasoning.ended' ? parsed.text ?? before : before + (parsed.delta ?? '')
          this.recordReasoning(id, parsed.assistantMessageID, parsed.ordinal, text, event.type === 'session.reasoning.ended', event.created)
          this.emit(true); return
        }
        case 'session.tool.input.started': case 'session.tool.called': case 'session.tool.success': case 'session.tool.failed': {
          const parsed = toolEventSchema.parse(data)
          const known = this.fold(id).tools.get(parsed.id)
          const output = opencodeToolOutput(parsed.content)
          const done = event.type === 'session.tool.success' || event.type === 'session.tool.failed'
          this.recordTool(id, {
            id: parsed.id, name: parsed.name ?? known?.name ?? 'Tool', input: parsed.input ?? known?.input,
            status: event.type === 'session.tool.success' ? 'completed' : event.type === 'session.tool.failed' ? 'failed' : 'running',
            ...(output ?? known?.output ? { output: output ?? known?.output } : {}),
            ...(parsed.error?.message ? { error: parsed.error.message } : {}),
            startedAt: known?.startedAt ?? iso(event.created), ...(done ? { completedAt: iso(event.created) } : {}),
          })
          this.emit(true); return
        }
        case 'session.step.ended': {
          const parsed = stepEndedSchema.safeParse(data)
          if (parsed.success) {
            if (parsed.data.tokens) this.usage(thread, parsed.data.tokens, 'latest')
            this.recordStepFiles(id, parsed.data.assistantMessageID, parsed.data.files, event.created)
          }
          this.emit(true); return
        }
        case 'session.usage.updated': this.usage(thread, usageSchema.parse(data).tokens, 'total'); this.emit(true); return
        case 'session.execution.succeeded': case 'session.execution.failed': case 'session.execution.interrupted': {
          const parsed = executionEndSchema.parse(data)
          const outcome = event.type === 'session.execution.succeeded' ? 'completed' : event.type === 'session.execution.failed' ? 'failed' : 'interrupted'
          const messageId = this.activeTurns.get(id)?.messageId ?? this.log.lastUserMessageId(id)
          this.activeTurns.delete(id)
          if (messageId) this.endTurn(id, messageId, outcome, outcome === 'failed' ? parsed.error?.type === 'provider.auth' ? SOURCE_REFUSED : TURN_FAILED : undefined)
          else thread.status = outcome === 'failed' ? 'error' : 'idle'
          this.emit(); return
        }
        case 'permission.asked': {
          const parsed = opencodePermissionSchema.parse(data)
          this.showRequest(opencodePermissionPending(id, parsed)); return
        }
        case 'permission.replied': {
          const parsed = repliedSchema.parse(data)
          const pending = this.pending.get(`opencode-permission-${parsed.requestID}`)
          if (pending) this.removeRequest(pending)
          return
        }
        case 'form.created': {
          const form = opencodeFormSchema.parse((data as { form?: unknown }).form)
          const pending = opencodeFormPending(id, form)
          if (pending) { this.showRequest(pending); return }
          // A form Sotto cannot draw is cancelled with a sentence the model reads, rather than left to wait forever.
          void entry.client?.request('DELETE', `/api/session/${this.sid(alias)}/form/${form.id}`, { query: { message: OPENCODE_FORM_UNSHOWN } }).catch(() => undefined)
          return
        }
        case 'form.replied': case 'form.cancelled': {
          const parsed = formSettledSchema.parse(data)
          const pending = this.pending.get(`opencode-form-${parsed.id}`)
          if (pending) this.removeRequest(pending)
          return
        }
        case 'session.permissions': {
          const mode = modeOfRules(permissionsChangedSchema.parse(data).permissions)
          if (mode) { alias.runtimeMode = mode; thread.runtimeMode = mode; void this.persist().catch(() => undefined); this.emit() }
          return
        }
        case 'session.model.selected': {
          const model = modelSelectedSchema.parse(data).model
          alias.modelId = `${model.providerID}/${model.id}`; thread.modelId = alias.modelId
          if (model.variant && model.variant !== 'default') { alias.reasoningEffort = model.variant; thread.reasoningEffort = model.variant }
          void this.persist().catch(() => undefined); this.emit(); return
        }
        default:
          // Steps, instructions, compaction notices and the rest change nothing Sotto keeps for the thread.
          return
      }
    } catch {
      // An event Sotto cannot read ends this thread's server rather than half of its turn: the next action starts a new
      // one and reads the session back whole.
      this.processLost(id, entry)
    }
  }
  private usage(thread: AgentThread, tokens: z.infer<typeof tokensSchema>, which: 'latest' | 'total'): void {
    const before = thread.usage
    const latest = which === 'latest' ? { input: tokens.input, output: tokens.output, cached: tokens.cache?.read ?? 0 } : before?.latest
    const total = which === 'total' ? { input: tokens.input, output: tokens.output } : before?.total
    thread.usage = { ...(latest ? { latest } : {}), ...(total ? { total } : {}), rateVersions: [], partial: true, updatedAt: new Date().toISOString(),
      ...(before?.contextUsed !== undefined ? { contextUsed: before.contextUsed } : {}), ...(before?.contextWindow !== undefined ? { contextWindow: before.contextWindow } : {}) }
  }

  async execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.executeNative(command) }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> { return this.executeNative(command, guard) }
  private async executeNative(command: AgentHostCommand, watcherGuard?: () => void): Promise<AgentHostResult> {
    const generation = this.generation
    if ('threadId' in command && command.type !== 'interrupt') await this.refuseWatcher(command.threadId)
    this.assertGeneration(generation)
    if (!this.state.connected) throw new Error('Connect OpenCode before managing threads.')
    let settled = false
    const historyFromEvents = command.type === 'configure-thread' && command.historyFromEvents === true
    let release: (() => void) | undefined
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('OpenCode projects require an absolute working directory.')
        if (!this.state.projects.some(project => project.id === command.projectId)) { this.state.projects.push({ id: command.projectId, title: command.title, path: command.path }); await this.projectStore.write(this.state.projects) }
      } else if (command.type === 'create-thread') {
        if (this.aliases[command.threadId]) return this.aliases[command.threadId]!.sessionConfirmed ? { accepted: true } : { accepted: false, uncertain: true }
        validateThreadOptions(this.state, command)
        const project = this.state.projects.find(candidate => candidate.id === command.projectId); if (!project) throw new Error('Choose an OpenCode project first.')
        const reasoningEffort = command.reasoningEffort ?? this.state.models.find(model => model.id === command.modelId)?.defaultReasoningEffort
        const alias: Alias = {
          createToken: randomUUID(), sessionConfirmed: false, projectId: project.id, cwd: await existingWorkingDirectory(command.workingDirectory ?? project.path),
          title: command.title, modelId: command.modelId, createdAt: new Date().toISOString(), origins: [],
          runtimeMode: command.runtimeMode ? opencodeMode(command.runtimeMode) : 'approval-required', ...(reasoningEffort ? { reasoningEffort } : {}),
        }
        this.assertGeneration(generation)
        const id = command.threadId
        release = this.hold(id)
        const entry = await this.threadProcess(id, alias.cwd)
        try {
          this.assertGeneration(generation)
          // Checked before anything is saved or sent, so a refusal leaves no record of a thread that never was.
          watcherGuard?.()
        } catch (error) { this.dropServer(id, entry); throw error }
        // A server an early start made for the draft's folder is given the tools again if the thread's folder reads otherwise.
        this.giveTools(id, entry, alias.cwd)
        this.aliases[id] = alias
        // From here the thread exists: opening it meanwhile waits for this creation rather than making a second session.
        const creation = (async () => {
          await this.persist()
          const session = await this.createSession(entry, alias)
          this.confirmSession(id, alias, session)
          await this.persist()
          this.loaded.add(id); this.log.pin(id); this.reaper.touch(id)
        })()
        this.creating.set(id, creation)
        const settledCreation = (): void => { if (this.creating.get(id) === creation) this.creating.delete(id) }
        void creation.then(settledCreation, settledCreation)
        try { await creation } catch (error) {
          // A lost answer keeps the record: the next read finds the session by its mark, or makes the one never made.
          if (error instanceof OpenCodeUncertain) { this.thread(id); this.emit(); throw error }
          delete this.aliases[id]; await this.persist().catch(() => undefined)
          // Nothing was created, so the server started for it has nothing to serve.
          this.dropServer(id, entry)
          if (error instanceof OpenCodeRejected) throw new Error('OpenCode refused to create this thread. Nothing was created. Check the model and folder, then try again.', { cause: error })
          throw error
        }
      } else {
        const alias = this.aliases[command.threadId]
        if (!alias) throw new Error('This OpenCode thread has no provider session. Do not repeat its creation automatically.')
        const readForSend = this.readsBeforeSend.take(command.threadId, command)
        this.reaper.touch(command.threadId)
        if (command.type === 'configure-thread') {
          await this.open(command.threadId); this.assertGeneration(generation)
          const entry = await this.threadProcess(command.threadId)
          const modelId = command.modelId ?? alias.modelId
          const reasoningEffort = effortAfterChange(this.state, command, alias.reasoningEffort)
          const mode = command.runtimeMode !== undefined ? opencodeMode(command.runtimeMode) : undefined
          validateThreadOptions(this.state, {
            modelId, ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}),
            ...(command.providerMode !== undefined ? { providerMode: command.providerMode } : {}),
          }, alias.modelId)
          const thread = this.thread(command.threadId)
          const modelChange = modelId !== alias.modelId || reasoningEffort !== alias.reasoningEffort
          const modeChange = mode !== undefined && mode !== alias.runtimeMode
          if (modelChange || modeChange) {
            if (this.activePrompts.has(command.threadId) || this.activeTurns.has(command.threadId) || thread.status === 'running' || thread.requests.length) {
              throw new Error('Wait for this OpenCode thread to finish and answer its pending requests before changing its settings.')
            }
            watcherGuard?.()
            // Both apply to the live provider session in place: its rule set by PATCH, its model and effort by a model switch.
            if (modeChange) {
              await entry.client!.request('PATCH', `/api/session/${this.sid(alias)}`, { body: { permissions: this.rulesFor(mode) } })
              alias.runtimeMode = mode; thread.runtimeMode = mode
            }
            if (modelChange) {
              watcherGuard?.()
              await entry.client!.request('POST', `/api/session/${this.sid(alias)}/model`, { body: { model: this.modelRef(modelId, reasoningEffort) } })
              alias.modelId = modelId; thread.modelId = modelId
              if (reasoningEffort) { alias.reasoningEffort = reasoningEffort; thread.reasoningEffort = reasoningEffort }
              else { delete alias.reasoningEffort; delete thread.reasoningEffort }
            }
            await this.persist()
          }
          settled = true
        } else if (command.type === 'send' || command.type === 'steer') {
          release = this.hold(command.threadId)
          if (command.skills?.length) throw providerTakesNoSkills('opencode')
          await this.open(command.threadId); this.assertGeneration(generation)
          const attachments = validatePromptAttachments(this.state, alias.modelId, command.attachments)
          readForSend()
          const thread = this.thread(command.threadId)
          if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(command.threadId) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
          const previous = alias.origins.find(origin => origin.messageId === command.messageId || origin.commandId === command.commandId)
          if (previous) return previous.confirmed ? { accepted: true } : { accepted: false, uncertain: true }
          const active = this.activeTurns.get(command.threadId)
          if (command.type === 'send' && (this.activePrompts.has(command.threadId) || active || thread.status === 'running')) throw new Error('OpenCode is already running a prompt in this thread.')
          if (command.type === 'steer' && !active) throw new Error('There is no running turn to steer. Queue a follow-up instead.')
          if (thread.requests.length) throw new Error('Answer the pending OpenCode request before sending another prompt.')
          verifyFileMentions(command.text, command.files)
          // Images go as data URIs, which OpenCode stores with the provider session and hands the model itself (ADR-0087).
          const files: { uri: string; name: string }[] = []
          for (const attachment of attachments) files.push({ uri: `data:${attachment.mimeType};base64,${Buffer.from(await attachment.read()).toString('base64')}`, name: attachment.name })
          this.assertGeneration(generation)
          const origin: Origin = {
            messageId: command.messageId, commandId: command.commandId, inboxId: promptId(), createdAt: new Date().toISOString(), confirmed: false,
            attachments: attachments.map(({ id, name, mimeType, sizeBytes }) => ({ id, name, mimeType, sizeBytes })), steer: command.type === 'steer',
          }
          const entry = await this.threadProcess(command.threadId)
          await this.toolsGiven(entry)
          this.assertGeneration(generation)
          alias.origins.push(origin)
          this.activePrompts.add(command.threadId)
          try {
            await this.persist()
            if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(command.threadId) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
            if (generation !== this.generation || !this.state.connected || !this.loaded.has(command.threadId)) throw new Error('The OpenCode prompt was cancelled before it was sent.')
            watcherGuard?.()
          } catch (error) {
            alias.origins = alias.origins.filter(item => item !== origin); this.activePrompts.delete(command.threadId); await this.persist()
            throw error
          }
          markSendStage(command.commandId, 'written')
          try {
            // The inbox ID is Sotto's, so the prompt is recognised in the stream and in history even when this answer is lost.
            const ack = promptReplySchema.parse(await entry.client!.request('POST', `/api/session/${this.sid(alias)}/prompt`, { body: {
              id: origin.inboxId, text: command.text, ...(files.length ? { files } : {}), ...(command.type === 'steer' ? { delivery: 'steer' } : {}),
            } }))
            if (ack.data.id !== origin.inboxId) throw new OpenCodeUncertain('OpenCode answered for another prompt.')
          } catch (error) {
            this.activePrompts.delete(command.threadId)
            if (error instanceof OpenCodeRejected) {
              alias.origins = alias.origins.filter(item => item !== origin); await this.persist()
              throw new Error(command.type === 'steer' ? 'OpenCode could not steer this turn. Nothing was sent; queue it as a follow-up instead.' : 'OpenCode refused this prompt. Nothing was sent. Review the thread before retrying.', { cause: error })
            }
            throw error
          }
          this.activePrompts.delete(command.threadId)
          this.recordUser(command.threadId, origin.inboxId, command.text, undefined)
          // One execution may carry several prompts, and a quick one may end before this answer arrives: the turn is this
          // prompt's unless the execution that took it has already been seen to end.
          if (command.type === 'send' && !this.activeTurns.has(command.threadId) && thread.lastTurn?.id !== command.messageId) {
            this.activeTurns.set(command.threadId, { messageId: command.messageId })
            thread.status = 'running'; thread.lastTurn = { id: command.messageId, status: 'running' }
            this.markTurn(command.threadId, 'running', command.messageId)
          }
          markSendStage(command.commandId, 'acknowledged')
          this.reaper.touch(command.threadId)
        } else if (command.type === 'answer') {
          await this.open(command.threadId); this.assertGeneration(generation)
          const pending = this.pending.get(command.requestId)
          if (!pending || pending.threadId !== command.threadId) throw new Error('That OpenCode request is no longer pending.')
          if (pending.answering) return { accepted: false, uncertain: true }
          const entry = this.processes.get(command.threadId)
          if (!entry?.client) return { accepted: false, uncertain: true }
          // Checked before anything is sent: a bad answer sends nothing and leaves the request answerable.
          const decision = pending.kind === 'permission' ? opencodePermissionDecision(pending, command.approved, command.permissionChoice) : undefined
          const answer = pending.kind === 'form' && command.approved !== false ? opencodeFormAnswer(pending, command.answer, command.questionAnswers) : undefined
          pending.answering = true; delete pending.request.answerRetryReady
          try {
            if (pending.kind === 'permission') {
              await entry.client.request('POST', `/api/session/${this.sid(alias)}/permission/${pending.permission.id}/reply`, { body: decision === 'once' ? { decision } : { decision, message: OPENCODE_DECLINED } })
            } else if (answer === undefined) {
              await entry.client.request('DELETE', `/api/session/${this.sid(alias)}/form/${pending.form.id}`, { query: { message: 'The user chose not to answer.' } })
            } else await entry.client.request('POST', `/api/session/${this.sid(alias)}/form/${pending.form.id}/reply`, { body: { answer } })
            this.removeRequest(pending)
          } catch (error) {
            if (error instanceof OpenCodeRejected && (error.status === 404 || error.status === 409)) { this.removeRequest(pending); return { accepted: true } }
            if (error instanceof OpenCodeRejected) { pending.answering = false; throw new Error('OpenCode refused that answer. Nothing was sent. Review the request and answer again.', { cause: error }) }
            pending.request.delivery = 'uncertain'; this.emit()
            return { accepted: false, uncertain: true }
          }
        } else if (command.type === 'interrupt') {
          await this.open(command.threadId); this.assertGeneration(generation)
          const entry = await this.threadProcess(command.threadId)
          watcherGuard?.()
          const reply = z.looseObject({ interrupted: z.boolean().optional() }).parse(await entry.client!.request('POST', `/api/session/${this.sid(alias)}/interrupt`) ?? {})
          // Nothing was running on this server, so nothing will say the turn ended: Sotto settles what it shows itself.
          const active = this.activeTurns.get(command.threadId)
          if (reply.interrupted === false && active) this.endTurn(command.threadId, active.messageId, 'interrupted')
        }
      }
      this.emit()
      return settled ? { accepted: true, snapshot: this.current(historyFromEvents) } : { accepted: true }
    } catch (error) { if (error instanceof OpenCodeUncertain) return { accepted: false, uncertain: true }; throw error }
    finally { release?.() }
  }

  /**
   * Sotto's side writing (ADR-0026) as one stateless generation on the thread's own server (`POST
   * /api/experimental/generate`), with the thread's model at its least effort. It is no turn: the model is offered no tools
   * and no provider session is made, which the live suite checks on OpenCode itself (ADR-0087). The session list is read
   * before and after as well, and a call after which a provider session Sotto did not make appeared writes nothing. A
   * model source that refuses the route, as OpenCode Zen's free models do, writes nothing either, and the stand-ins stay.
   * There is no fallback to a session.
   */
  async writeShortText(id: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    const generation = this.generation
    const alias = this.aliases[id]
    if (!this.state.connected || !alias) return null
    // Watcher's thread is never an OpenCode one (ADR-0087), and it is given no side text.
    if (await this.launchProfiles?.profileFor(id).catch(() => true)) return null
    this.assertGeneration(generation)
    const release = this.hold(id)
    try {
      const entry = await this.threadProcess(id)
      this.assertGeneration(generation)
      const client = entry.client!
      const before = await this.unmarkedSessions(client)
      let text: string
      try {
        const answer = await client.request('POST', '/api/experimental/generate', {
          body: { prompt: `${prompt.instruction}\n\n${prompt.material}`, model: this.modelRef(alias.modelId, sideWritingEffort(this.state.models, alias.modelId)) },
          timeoutMs: SIDE_WRITING_TIMEOUT_MS, ...(signal ? { signal } : {}),
        })
        const parsed = generatedSchema.safeParse(answer)
        if (!parsed.success) throw new Error('OpenCode sent side text Sotto cannot read.')
        text = parsed.data.data.text
      } catch (error) {
        // Refused: the model source does not take the route, or no longer offers the model. Nothing is written.
        if (error instanceof OpenCodeRejected) return null
        throw error
      }
      const after = await this.unmarkedSessions(client)
      this.assertGeneration(generation)
      if ([...after].some(session => !before.has(session))) return null
      return text
    } finally { release(); this.reaper.touch(id) }
  }
  /** The provider sessions in Sotto's OpenCode folder that carry no thread's creation mark, by ID. */
  private async unmarkedSessions(client: OpenCodeClient): Promise<ReadonlySet<string>> {
    const found = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const read = sessionListSchema.parse(await client.request('GET', '/api/session', { query: cursor ? { cursor } : {} }))
      for (const session of read.data) if (typeof session.metadata?.[CREATE_MARK]?.thread !== 'string') found.add(session.id)
      const next = read.cursor?.next ?? undefined
      if (!read.data.length || !next || next === cursor) break
      cursor = next
    }
    return found
  }
  private disconnecting = false
  disconnect(): void {
    if (this.disconnecting) return
    this.disconnecting = true
    try { this.finishDisconnect() } finally { this.disconnecting = false }
  }
  private finishDisconnect(): void {
    this.generation++; this.reaper.dispose(); this.loaded.clear(); this.loading.clear(); this.creating.clear()
    // A pending permission is OpenCode's to settle when its server ends; Sotto sends no decision for it here.
    this.pending.clear()
    for (const thread of this.threads.values()) thread.requests = []
    this.activePrompts.clear()
    let ended = false
    for (const [id, active] of this.activeTurns) {
      const alias = this.aliases[id]
      if (alias) { alias.endedTurn = { messageId: active.messageId, outcome: 'interrupted' }; ended = true }
    }
    this.activeTurns.clear()
    if (ended) void this.persist().catch(() => undefined)
    for (const entry of [...this.processes.values(), ...this.stopping]) void this.closeProcess(entry)
    this.processes.clear()
    this.probeClosed.abort()
    if (this.probe) { void this.probe.then(probe => probe.server.stop(), () => undefined); this.probe = undefined }
    this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> { await Promise.all([...this.exits]); await Promise.allSettled(this.loading.values()); await this.writing }
}
