import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { version as appVersion } from '../../../package.json'
import { agentProjectSchema, type AgentHostSnapshot, type AgentMessage, type AgentModel, type AgentThread } from '../../shared/agents'
import { mergeAgentActivities, type AgentActivity } from '../../shared/agentActivity'
import type { AgentSkillCatalog } from '../../shared/agentSkills'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ActivitySubscribers, certifyActivityView, cloneActivitySnapshot } from './activitySnapshots'
import { BROWSER_MCP_SERVER, type BrowserAgentTools } from './browserAgentServer'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { cursorActivities, cursorImage, cursorTask, cursorTodos, CURSOR_THINKING_ID_PREFIX, type CursorPlace } from './cursorActivity'
import { cursorCatalog, cursorModeArguments, cursorModelListSchema, cursorRuntimeMode, leastEffort, CURSOR_RUNTIME_MODES, type CursorModelFacts, type CursorRuntimeMode } from './cursorModels'
import { cursorAnswer, cursorDecline, cursorPending, type CursorPending } from './cursorRequests'
import { compareCursorVersions, cursorEnvironment, CursorRejected, CursorRpc, CursorUncertain, CURSOR_ACP_VERSION, CURSOR_CLI_VERSION, findCursorProgram,
  readCursorSignIn, readCursorVersion, writeCursorConfig, writeCursorSideConfig, type CursorFrame, type CursorProgram } from './cursorRpc'
import type { ActivitySubscriptionOptions, AgentHost, AgentHostCommand, AgentHostResult, AgentSkillScope, ShortTextPrompt, ThreadHistorySource, ThreadHostEvent,
  ThreadLaunchProfiles, ThreadReadPurpose, ThreadSessionDraft, WatcherLaunchProfile } from './host'
import { needsPerson, unreadableRequest } from './nativeRequests'
import { OpenSessions } from './openSessions'
import { verifyFileMentions } from './promptFiles'
import { ProviderUnavailable } from './providerProblem'
import { adapterItemCount, ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { SessionReaper } from './sessionReaper'
import { markSendStage } from './sendStages'
import { SIDE_WRITING_TIMEOUT_MS } from './sideWriting'
import { settledThinking, thinkingSettledAs } from './thinkingActivity'
import { ThreadMessageLog } from './threadMessageLog'
import { effortAfterChange, validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { scopedThreadServers, type ScopedThreadTools, type ThreadMcpServer } from './threadToolServer'
import { existingWorkingDirectory } from './threadWorktrees'
import { markTurnActivity } from './turnActivity'
import { WatcherProfileRefusal, validateWatcherProfile } from './watcherProfile'
import { WATCHER_SYSTEM_PROMPT } from './watcherPrompt'
import { assertWatcherPermission, assertWatcherPermissionChoice, watcherThreadTools } from './watcherProviderTools'
import { WATCHER_COMPACTED_NOTE, watcherRequestLine } from './watcherRequestNote'

/**
 * Cursor as a thread provider (ADR-0128): one `agent acp` process per thread, started from Cursor's own program with
 * Sotto's own Cursor folder, speaking ACP on stdio. Cursor keeps the sign-in, the sessions and the tools; Sotto keeps
 * only each thread's session ID, its settings and what it sent, by digest, never by its words.
 *
 * Cursor's ACP agent sends no history except by `session/load`, which replays the whole conversation, so a thread is
 * read when its process loads its session and is kept up to date from its own stream after that. A replayed message has
 * no ID or time of Cursor's own, so a message's identity is its turn and its place in the turn, the same live and
 * replayed: a thread read back after a restart keeps the messages and rows it showed.
 */

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const attachmentSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), sizeBytes: z.number() })
/** One message Sotto sent: its identities, the digest of what Cursor was given, and its turn's place in the session. */
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), turn: z.number().int().nonnegative(),
  attachments: z.array(attachmentSchema).default([]),
  /**
   * How many characters Sotto put before and after the user's words on the wire, for a message to Watcher: its
   * instructions ahead and its request note's line after (ADR-0128). Counts only, never the words, so a message Cursor
   * replays is shown as it was typed.
   */
  sottoHead: z.number().int().nonnegative().optional(), sottoTail: z.number().int().nonnegative().optional(),
  /** Where Sotto's part ahead of the words starts: after the skills the user typed at the start, which Cursor reads only there. */
  sottoAt: z.number().int().nonnegative().optional() })
type Origin = z.infer<typeof originSchema>
const aliasSchema = z.object({
  cursorSessionId: z.string().min(1).max(256).optional(), projectId: z.string(), cwd: z.string(), title: z.string(), createdAt: z.string(),
  modelId: z.string(), reasoningEffort: z.string().optional(), runtimeMode: z.enum(CURSOR_RUNTIME_MODES).default('approval-required'),
  /** How many user turns the session holds, as Sotto last counted them: the place the next prompt takes. */
  turns: z.number().int().nonnegative().default(0),
  origins: z.array(originSchema).default([]), answeredRequestIds: z.array(z.string()).default([]),
})
type Alias = z.infer<typeof aliasSchema>
/**
 * How many answered request IDs a thread keeps. A request's ID carries the nonce of the process that asked, so one from
 * a process that has ended can never come again; the window covers every request a running process can hold open
 * (`pending` takes at most 128), and the rest are let go so a thread's record does not grow with its history.
 */
const ANSWERED_KEPT = 128
/**
 * A thread's saved origins and answered requests, indexed when the thread's record is read and kept beside the saved
 * arrays, so a send, an answer or a replayed message looks one up by its key rather than scanning the thread's history
 * (AGENTS.md: work per action must not grow with the user's history).
 */
class ThreadIndex {
  private readonly byCommand = new Map<string, Origin>()
  private readonly byMessage = new Map<string, Origin>()
  private readonly byTurn = new Map<string, Origin>()
  private readonly byDigest = new Map<string, Origin[]>()
  private readonly answered: Set<string>
  constructor(readonly alias: Alias) {
    for (const origin of alias.origins) this.index(origin)
    if (alias.answeredRequestIds.length > ANSWERED_KEPT) alias.answeredRequestIds = alias.answeredRequestIds.slice(-ANSWERED_KEPT)
    this.answered = new Set(alias.answeredRequestIds)
  }
  private index(origin: Origin): void {
    this.byCommand.set(origin.commandId, origin); this.byMessage.set(origin.messageId, origin)
    const turn = `${origin.turn}:${origin.digest}`
    if (!this.byTurn.has(turn)) this.byTurn.set(turn, origin)
    const same = this.byDigest.get(origin.digest)
    if (same) same.push(origin); else this.byDigest.set(origin.digest, [origin])
  }
  /** The origin a send names by its command or its message, if either was sent before. */
  sent(commandId: string, messageId: string): Origin | undefined { return this.byCommand.get(commandId) ?? this.byMessage.get(messageId) }
  /** The origin of a replayed user message: the one sent at that turn with that digest, else the first with that digest not yet placed. */
  replayed(turn: number, hash: string, placed: { has(messageId: string): boolean }): Origin | undefined {
    return this.byTurn.get(`${turn}:${hash}`) ?? this.byDigest.get(hash)?.find(origin => !placed.has(origin.messageId))
  }
  add(origin: Origin): void { this.alias.origins.push(origin); this.index(origin) }
  remove(origin: Origin): void {
    const at = this.alias.origins.lastIndexOf(origin)
    if (at >= 0) this.alias.origins.splice(at, 1)
    if (this.byCommand.get(origin.commandId) === origin) this.byCommand.delete(origin.commandId)
    if (this.byMessage.get(origin.messageId) === origin) this.byMessage.delete(origin.messageId)
    const turn = `${origin.turn}:${origin.digest}`
    if (this.byTurn.get(turn) === origin) this.byTurn.delete(turn)
    const same = this.byDigest.get(origin.digest)?.filter(item => item !== origin)
    if (same?.length) this.byDigest.set(origin.digest, same); else this.byDigest.delete(origin.digest)
  }
  wasAnswered(requestId: string): boolean { return this.answered.has(requestId) }
  answer(requestId: string): void {
    if (this.answered.has(requestId)) return
    this.answered.add(requestId); this.alias.answeredRequestIds.push(requestId)
    while (this.alias.answeredRequestIds.length > ANSWERED_KEPT) this.answered.delete(this.alias.answeredRequestIds.shift()!)
  }
  unanswer(requestId: string): void {
    if (!this.answered.delete(requestId)) return
    const at = this.alias.answeredRequestIds.lastIndexOf(requestId)
    if (at >= 0) this.alias.answeredRequestIds.splice(at, 1)
  }
}
const initializeSchema = z.object({ protocolVersion: z.number(), agentCapabilities: z.object({ loadSession: z.literal(true),
  mcpCapabilities: z.object({ http: z.boolean().optional() }).passthrough().optional(),
  promptCapabilities: z.object({ image: z.boolean().optional() }).passthrough().optional() }).passthrough() }).passthrough()
type CursorClient = z.infer<typeof initializeSchema>
const configOptionsSchema = z.object({ configOptions: z.array(z.object({ id: z.string(), category: z.string().optional(), currentValue: z.unknown().optional() }).passthrough()).optional() }).passthrough()
const sessionNewSchema = configOptionsSchema.extend({ sessionId: z.string().min(1).max(256) })
const promptAnswerSchema = z.object({ stopReason: z.string() }).passthrough()
const commandsSchema = z.array(z.object({ name: z.string().min(1).max(256), description: z.string().max(4096).optional() }).passthrough()).max(500)

/** What Sotto says once to a thread that came with Allow edits, which Cursor has not (ADR-0128). */
export const CURSOR_ALLOW_EDITS_NOTICE = 'Cursor has no Allow edits mode, so this thread asks for approval. Cursor still makes edits inside the project folder without asking.'
const PROCESS_LOST = 'Cursor stopped before this reply finished, so it may be cut short. Send a message to carry on.'
/**
 * Watcher's instructions on Cursor (ADR-0128): `instructions` is the profile's own, with the worker-role lines when that
 * feature is on, or the base prompt (#1417). Cursor's ACP agent takes no system prompt or instructions from a client, and
 * its rules are files one Cursor folder shares with every thread, so they travel in the message's text part, marked as
 * Sotto's, ahead of the first message Sotto sends Watcher's session on a process and again when the request note says the
 * conversation is new or was compacted (#1418). Cursor replays a message exactly as it was sent, so the counts Sotto keeps
 * take them off again, whichever wording they were sent in, and every surface shows the message as typed.
 */
export const cursorWatcherInstructions = (instructions: string = WATCHER_SYSTEM_PROMPT): string =>
  `[Sotto: Watcher's instructions. Cursor takes no instructions from Sotto any other way, so they come with Sotto's first message to you, and again when this conversation is resumed or may have lost them. They are not the user's words.]
${instructions}
[End of Watcher's instructions. The message follows.]

`
/** The name of Watcher's own tool server, which Sotto's rules in its Cursor folder allow once a Watcher has run on Cursor. */
const WATCHER_SERVER = 'sotto_threads'
const WATCHER_WITHOUT_TOOLS = 'This Cursor client cannot give Watcher its Sotto tools, so Watcher did not start. Nothing was sent. Update Cursor’s CLI and connect it again, or choose a Codex, Claude Code or Grok Build model for Watcher.'

/**
 * Where each update of one turn belongs (`CursorPlace`). Replies are counted by segment: a reply runs on until a tool or
 * a thought breaks it, live and replayed alike. Tools and thoughts are counted in order. A turn is keyed by its user message.
 */
class TurnPlaces {
  private replies = 0; private thoughts = 0; private tools = 0
  private readonly toolKeys = new Map<string, string>()
  private current: 'reply' | 'thought' | undefined
  constructor(readonly key: string) {}
  reply(): { id: string; opened: boolean } {
    const opened = this.current !== 'reply'
    if (opened) { this.current = 'reply'; this.replies++ }
    return { id: `cursor-reply-${this.key}-${this.replies - 1}`, opened }
  }
  thought(): string {
    if (this.current !== 'thought') { this.current = 'thought'; this.thoughts++ }
    return `${this.key}-${this.thoughts - 1}`
  }
  tool(nativeId: string, opens: boolean): string {
    let key = this.toolKeys.get(nativeId)
    if (!key) { key = `${this.key}-${this.tools++}`; this.toolKeys.set(nativeId, key) }
    if (opens) this.current = undefined
    return key
  }
}
/**
 * A thread's conversation as `session/load` replays it, built before it is handed to the log. `byId` holds the same
 * messages by ID, so a reply's next chunk finds its message without scanning the conversation.
 */
interface Replay { messages: AgentMessage[]; byId: Map<string, AgentMessage>; activities: AgentActivity[]; turns: number; turn: TurnPlaces | undefined; createdAt: string; userCreatedAt: string }
/** The turn a thread is on, as its own stream reports it. `taken` once Cursor showed it is working on a prompt Sotto sent. */
interface LiveTurn {
  readonly places: TurnPlaces
  readonly origin: Origin | undefined
  /** The process whose session this prompt gives Watcher's instructions: it holds them once Cursor shows it took the prompt. */
  readonly instructs?: Connection
  taken: boolean
  ended: boolean
  wake: (() => void) | undefined
}
/** One thread's own Cursor process. `clientRevision` is the client it started from; `closing` a close Sotto asked for. */
interface Connection {
  readonly rpc: CursorRpc
  readonly nonce: string
  readonly clientRevision: number
  readonly mode: CursorRuntimeMode
  /** Started for Watcher's thread with its launch profile: its session has Watcher's tools, never the browser (ADR-0073). */
  readonly watcher: boolean
  /**
   * Watcher's instructions are in this process's session: a prompt Cursor took on this process carried them, and no note
   * since said the conversation is new or was compacted (#1418). A new process, after a restart, a lost process, an idle
   * close, a mode change or a client update, starts without, so the session it loads is told them again: Cursor may have
   * compacted the conversation by itself, which it never says over ACP, so a replayed message that carried them is no
   * proof the model still has them.
   */
  instructed?: boolean
  /**
   * The last note sent to Watcher said the conversation is new or was compacted. That line stays in each note until Watcher
   * reads its state, so only the first note to carry it, after one that did not, asks for the instructions again.
   */
  reminded?: boolean
  closing: boolean
  /** The model and effort this process's session is on, as Cursor last said. */
  model: string | undefined
  effort: string | undefined
  replay: Replay | undefined
  commands: AgentSkillCatalog['skills'] | undefined
}
type Pending = CursorPending & { readonly connection: Connection }

export interface CursorAcpOptions {
  /** The program to start, in place of finding Cursor's own: a test's fake client. */
  program?: CursorProgram
  environment?: NodeJS.ProcessEnv
  /** Sotto's Cursor folder (ADR-0128): `<userData>/cursor/config` by default, and the data directory's on a headless host. */
  configDirectory?: string
  requestTimeoutMs?: number
  /**
   * How long a new Cursor process has to answer `initialize`: its start, which is not an acknowledgement of anything Sotto
   * sent, so a slow start is waited for rather than read as a lost answer. 30 seconds, as OpenCode's start.
   */
  startTimeoutMs?: number
  reaperSweepMs?: number
  sessionIdleMs?: number
}

export class CursorAcpHost implements AgentHost {
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  /** Each thread's origins and answered requests by key, built from its saved record once (`ThreadIndex`). */
  private readonly indexes = new Map<string, ThreadIndex>()
  private readonly threads = new Map<string, AgentThread>()
  private readonly connections = new Map<string, Connection>()
  private readonly loading = new Map<string, Promise<Connection>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly turns = new Map<string, LiveTurn>()
  private readonly pending = new Map<string, Pending>()
  private readonly dispatching = new Set<string>()
  private readonly observed = new Set<string>()
  private readonly outdated = new Set<string>()
  private readonly processes = new Set<CursorRpc>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly activityListeners = new ActivitySubscribers()
  private readonly log = new ThreadMessageLog()
  private readonly loaded = new OpenSessions(id => this.threads.get(id))
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    for (const listener of this.listeners) listener(this.current())
    this.activityListeners.publish(historyFromEvents => this.activitySnapshot(historyFromEvents))
  }, () => adapterItemCount(this.log, this.threads.values()))
  private readonly reaper: SessionReaper
  private history: ThreadHistorySource | undefined
  private launchProfiles: ThreadLaunchProfiles | undefined
  /** The last profile main gave each Watcher thread: evidence for stopping it when main no longer resolves one, never a grant. */
  private readonly knownLaunchProfiles = new Map<string, WatcherLaunchProfile>()
  private browserTools: BrowserAgentTools | undefined
  private threadTools: readonly ScopedThreadTools[] = []
  private facts = new Map<string, CursorModelFacts>()
  /** The skills the newest session listed, for a thread whose own session has not said yet. */
  private commands: AgentSkillCatalog['skills'] | undefined
  private program: CursorProgram | undefined
  private clientRevision = 0
  private httpToolServers = false
  private generation = 0
  private writing = Promise.resolve()
  private state: AgentHostSnapshot = { connected: false, name: 'Cursor', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true,
      reconcile: true, configureThread: true, configureThreadModel: true, skills: true, steer: false, compact: false } }
  private readonly configDirectory: string

  constructor(private readonly userDataDirectory: string, private readonly options: CursorAcpOptions = {}) {
    this.configDirectory = options.configDirectory ?? join(userDataDirectory, 'cursor', 'config')
    this.aliasStore = new AtomicJsonStore(join(userDataDirectory, 'cursor-threads.json'), z.record(z.string(), aliasSchema).parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(userDataDirectory, 'cursor-projects.json'), z.array(agentProjectSchema).parse, () => [])
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs === undefined ? {} : { sweepEveryMs: options.reaperSweepMs }),
      ...(options.sessionIdleMs === undefined ? {} : { idleAfterMs: options.sessionIdleMs }),
      isWatched: id => this.observed.has(id),
      isBusy: id => this.busy(id),
      stop: id => this.stopSession(id),
    })
  }

  // ---- What the adapter publishes ------------------------------------------------------------------------------------

  private current(historyFromEvents = false): AgentHostSnapshot {
    if (historyFromEvents) return cloneActivitySnapshot(this.activitySnapshot(true))
    return cloneHostSnapshot({ ...this.state, threads: [...this.threads.values()].map(thread => this.log.publishedThread(thread)) })
  }
  private activitySnapshot(historyFromEvents: boolean): AgentHostSnapshot {
    certifyActivityView(this.state, this.threads.values())
    return { ...this.state, threads: [...this.threads.values()].map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
  private emit(streaming = false): void { this.publisher.publish(streaming); this.stopOutdated() }
  /** The program this adapter starts, and Sotto's Cursor folder it runs with, so the tile's sign-in uses the same client. */
  async clientProgram(): Promise<CursorProgram | undefined> { return this.program ?? this.options.program ?? findCursorProgram(this.options.environment) }
  get folder(): string { return this.configDirectory }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  useThreadHistory(source: ThreadHistorySource): void { this.history = source }
  useLaunchProfiles(profiles: ThreadLaunchProfiles): void { this.launchProfiles = profiles }
  useBrowserTools(tools: BrowserAgentTools): void { this.browserTools = tools }
  useThreadTools(tools: readonly ScopedThreadTools[]): void { this.threadTools = tools }
  /** The store serializes what it is given before it returns, so the aliases are written as they are, never copied. */
  private persist(): Promise<void> { this.writing = this.aliasStore.write(this.aliases); return this.writing }
  /** The thread's origins and answered requests by key, indexed from its saved record the first time they are needed. */
  private indexOf(id: string, alias: Alias): ThreadIndex {
    let index = this.indexes.get(id)
    if (!index || index.alias !== alias) { index = new ThreadIndex(alias); this.indexes.set(id, index) }
    return index
  }
  private thread(id: string): AgentThread {
    const alias = this.aliases[id]
    if (!alias) throw new Error('This Cursor thread does not exist.')
    let thread = this.threads.get(id)
    if (!thread) {
      thread = { id, projectId: alias.projectId, title: alias.title, workingDirectory: alias.cwd, modelId: alias.modelId, runtimeMode: alias.runtimeMode,
        ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}),
        status: alias.cursorSessionId ? 'idle' : 'error', messages: [], requests: [] }
      this.threads.set(id, thread)
      if (this.connections.has(id) && !this.loading.has(id)) this.loaded.add(id)
    }
    return thread
  }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new CursorUncertain('Cursor’s connection changed before this could finish.')
  }

  /**
   * Watcher's launch profile for this thread, or undefined for every other thread (ADR-0073, ADR-0128). A Watcher thread
   * whose profile main can no longer verify is stopped and its tools revoked, and nothing is sent.
   */
  private async launchProfile(id: string, rpc?: CursorRpc): Promise<WatcherLaunchProfile | undefined> {
    const generation = this.generation, resolver = this.launchProfiles, connection = this.connections.get(id)
    const current = (): boolean => generation === this.generation && resolver === this.launchProfiles && (!rpc || this.connections.get(id)?.rpc === rpc)
    try {
      const profile = await resolver?.profileFor(id)
      if (!current()) throw new CursorUncertain('Cursor’s connection changed while the thread’s profile was checked.')
      if (profile) { validateWatcherProfile(profile); this.knownLaunchProfiles.set(id, profile) }
      else if (this.knownLaunchProfiles.has(id)) throw new WatcherProfileRefusal('Watcher’s tools are no longer admitted. Its session was stopped. Reopen Watcher to recover.')
      return profile
    } catch (error) {
      if (!current()) throw new CursorUncertain('Cursor’s connection changed while the thread’s profile was checked.')
      const refusal = error instanceof WatcherProfileRefusal ? error : new WatcherProfileRefusal('Watcher’s saved profile could not be verified. Its session was stopped. Reopen Watcher to recover.')
      if (this.connections.get(id) === connection) {
        try { this.revokeProfile(id, this.knownLaunchProfiles.get(id), refusal.message) } catch { /* A broken server cleanup never keeps the process alive. */ }
      }
      throw refusal
    }
  }
  /** The profile, checked against the process already running the thread: one started without Watcher's tools is stopped. */
  private async checkLaunchProfile(id: string): Promise<WatcherLaunchProfile | undefined> {
    const generation = this.generation, connection = this.connections.get(id)
    const profile = await this.launchProfile(id)
    this.assertGeneration(generation)
    if (profile && connection && !connection.watcher) {
      const reason = 'This Cursor process started without Watcher’s tools. Nothing was sent. Reopen Watcher.'
      this.revokeProfile(id, profile, reason)
      throw new WatcherProfileRefusal(reason)
    }
    return profile
  }
  /**
   * A profile failure ends the thread's process, even if closing it would fail, and revokes Watcher's tools. Every request
   * still waiting is declined on the way out, which grants nothing.
   */
  private revokeProfile(id: string, profile: WatcherLaunchProfile | undefined, reason: string): void {
    this.endTurn(id, 'failed')
    const connection = this.connections.get(id)
    this.connections.delete(id); this.loaded.delete(id); this.outdated.delete(id); this.log.release(id); this.reaper.forget(id)
    for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id) {
      this.pending.delete(requestId)
      if (!pending.answering) void pending.connection.rpc.reply(pending.wireId, cursorDecline(pending)).catch(() => undefined)
    }
    const thread = this.threads.get(id)
    if (thread) { thread.requests = []; thread.status = 'error'; thread.requestNotice = reason }
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
   * The names of every Sotto tool server, which Sotto's rules in its Cursor folder allow (ADR-0128), and Watcher's own once
   * a Watcher has run on Cursor in this run of Sotto. One folder serves every thread; a thread still reaches only the
   * servers it was given, and no ordinary thread is given Watcher's.
   */
  private serverNames(): string[] {
    return [...(this.browserTools ? [BROWSER_MCP_SERVER] : []), ...this.threadTools.map(tools => tools.name), ...(this.knownLaunchProfiles.size ? [WATCHER_SERVER] : [])]
  }
  /**
   * Sotto's own tool servers for this thread, each with the thread's bearer token, as Grok Build and Muse get them. Watcher's
   * thread gets its own `sotto_threads` server and the scoped servers Watcher takes, never the browser (ADR-0073).
   */
  private async toolServers(id: string, watcher: boolean): Promise<ThreadMcpServer[]> {
    if (watcher) {
      const profile = await this.launchProfile(id)
      if (!profile) throw new WatcherProfileRefusal('Watcher’s tools are no longer admitted. Nothing was sent. Reopen Watcher to recover.')
      if (!this.httpToolServers) throw new WatcherProfileRefusal(WATCHER_WITHOUT_TOOLS)
      return [{ name: profile.server.name, type: profile.server.type, url: profile.server.url, headers: profile.server.headers.map(header => ({ ...header })) },
        ...(await scopedThreadServers(watcherThreadTools(this.threadTools), id)).map(({ server }) => server)]
    }
    if (!this.httpToolServers) return []
    const servers: ThreadMcpServer[] = []
    if (this.browserTools) servers.push(await this.browserTools.mcpServer(id))
    for (const { server } of await scopedThreadServers(this.threadTools, id)) servers.push(server)
    return servers
  }

  // ---- Processes -----------------------------------------------------------------------------------------------------

  private environment(configDirectory = this.configDirectory): NodeJS.ProcessEnv { return cursorEnvironment(configDirectory, this.options.environment) }
  /** Sotto's side-call Cursor folder, beside its Cursor folder: every tool denied, so a side call can use none (ADR-0026). */
  private get sideConfigDirectory(): string { return join(dirname(this.configDirectory), 'side-config') }
  private spawn(program: CursorProgram, args: readonly string[], cwd: string, receive: (frame: CursorFrame, rpc: CursorRpc) => Promise<void> | void, lost: () => void,
    configDirectory = this.configDirectory): CursorRpc {
    const rpc: CursorRpc = new CursorRpc(program, args, cwd, this.environment(configDirectory), this.options.requestTimeoutMs ?? 30_000, frame => receive(frame, rpc), lost)
    this.processes.add(rpc); void rpc.closed.then(() => this.processes.delete(rpc))
    return rpc
  }
  private async handshake(rpc: CursorRpc): Promise<CursorClient> {
    let client: CursorClient | undefined
    await rpc.request('initialize', { protocolVersion: CURSOR_ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
      _meta: { parameterizedModelPicker: true } }, clientInfo: { name: 'sotto', version: appVersion } }, value => { client = initializeSchema.parse(value) }, false, this.options.startTimeoutMs ?? 30_000)
    if (client!.protocolVersion !== CURSOR_ACP_VERSION) throw new ProviderUnavailable('cannot-start', `Sotto speaks ACP ${CURSOR_ACP_VERSION}, and this Cursor client answered ACP ${client!.protocolVersion}.`)
    return client!
  }
  /** This thread's own process, started in the thread's permission mode and ready for a session. */
  private async startProcess(id: string, alias: Alias, cwd: string, watcher: boolean): Promise<Connection> {
    const program = this.program
    if (!program || !this.state.connected) throw new Error('Connect Cursor before using its threads.')
    await writeCursorConfig(this.configDirectory, this.serverNames())
    const connection: Connection = { rpc: undefined as unknown as CursorRpc, nonce: randomUUID(), clientRevision: this.clientRevision, mode: alias.runtimeMode, watcher,
      closing: false, model: undefined, effort: undefined, replay: undefined, commands: undefined }
    const rpc = this.spawn(program, [...cursorModeArguments(alias.runtimeMode), 'acp'], cwd, frame => this.frame(id, connection, frame), () => this.processLost(id, connection))
    ;(connection as { rpc: CursorRpc }).rpc = rpc
    try { await this.handshake(rpc) }
    catch (error) { connection.closing = true; rpc.close(); throw error }
    return connection
  }
  private close(connection: Connection): void { connection.closing = true; connection.rpc.close() }

  // ---- Connecting ----------------------------------------------------------------------------------------------------

  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    try {
      await mkdir(this.configDirectory, { recursive: true })
      const program = this.options.program ?? await findCursorProgram(this.options.environment)
      if (!program || !isAbsolute(program.executable)) throw new ProviderUnavailable('not-installed', 'Install Cursor’s CLI, then connect Cursor again. Your threads are kept.')
      const [version, signIn] = await Promise.all([readCursorVersion(program, this.environment()), readCursorSignIn(program, this.environment())])
      this.assertGeneration(generation)
      if (compareCursorVersions(version, CURSOR_CLI_VERSION) < 0) throw new ProviderUnavailable('too-old', `Cursor’s CLI ${CURSOR_CLI_VERSION} or newer is needed, and this one is ${version}. Run agent update, then connect again. Your threads are kept.`, version, CURSOR_CLI_VERSION)
      if (signIn === 'signed-out') throw new ProviderUnavailable('signed-out', 'Cursor is not signed in on this computer. Sign in to Cursor, then connect it again. Your threads are kept.', version)
      await writeCursorConfig(this.configDirectory, this.serverNames())
      await this.readCatalog(program, generation)
      if (!this.state.models.length) throw new ProviderUnavailable('signed-out', 'Cursor listed no models. Sign in to Cursor, then connect it again. Your threads are kept.', version)
      const [aliases, projects] = await Promise.all([this.aliasStore.read(), this.projectStore.read()])
      this.assertGeneration(generation)
      this.aliases = aliases; this.indexes.clear(); this.state.projects = projects; this.program = program
      this.threads.clear(); this.log.forgetAll()
      for (const id of Object.keys(this.aliases)) { this.thread(id); this.log.seed(id, this.history?.messageIdentities(id) ?? []) }
      this.state.connected = true; this.state.version = `${version} / ACP ${CURSOR_ACP_VERSION}`
      delete this.state.error; delete this.state.problem; delete this.state.requiredVersion
      if (compareCursorVersions(version, CURSOR_CLI_VERSION) > 0) this.state.verifiedVersion = CURSOR_CLI_VERSION
      else delete this.state.verifiedVersion
      // A thread that cannot open is that thread's error, not the provider's: the rest stay usable.
      await Promise.all([...this.observed].filter(id => this.aliases[id]?.cursorSessionId).map(id => this.open(id).catch((error: unknown) => {
        if (generation !== this.generation) return
        this.markOpenFailed(id, error)
      })))
      this.assertGeneration(generation)
      this.reaper.start(); this.emit(); return this.current()
    } catch (error) {
      if (generation === this.generation) this.disconnect()
      if (error instanceof WatcherProfileRefusal) throw error
      const refused = error instanceof ProviderUnavailable
      const detail = refused || error instanceof CursorUncertain ? error.message : error instanceof Error && /^Sotto could not read/u.test(error.message) ? error.message : ''
      const message = ['Could not connect Cursor.', detail, refused ? '' : 'Connect again to retry.'].filter(Boolean).join(' ')
      if (refused) throw new ProviderUnavailable(error.problem, message, error.version, error.requiredVersion)
      throw new Error(message, { cause: error })
    }
  }
  /** Read Cursor's models on a process of its own, which makes no session and ends once it has answered. */
  private async readCatalog(program: CursorProgram, generation: number): Promise<void> {
    const probe = this.spawn(program, ['acp'], this.configDirectory, (frame, rpc) => { if (frame.method && frame.id !== undefined) rpc.refuse(frame.id) }, () => undefined)
    try {
      const client = await this.handshake(probe)
      this.httpToolServers = client.agentCapabilities.mcpCapabilities?.http === true
      const images = client.agentCapabilities.promptCapabilities?.image === true
      let facts: CursorModelFacts[] = []
      await probe.request('cursor/list_available_models', {}, value => { facts = cursorCatalog(cursorModelListSchema.parse(value), images) })
      this.assertGeneration(generation)
      this.facts = new Map(facts.map(entry => [entry.model.id, entry]))
      this.state.models = facts.map(entry => entry.model)
    } finally { probe.close() }
  }
  private markOpenFailed(id: string, error: unknown): void {
    if (!this.aliases[id]) return
    this.thread(id).status = 'error'
    this.state.error = error instanceof Error && error.message ? error.message : 'A Cursor thread could not be opened. Your thread is kept. Reconnect Cursor to try again.'
    this.emit()
  }

  /**
   * Cursor's client on disk was updated while Sotto stayed connected (ADR-0042, ADR-0038). Find it again and hold it to
   * the floor; every new process starts from it, and each thread moves onto it as it goes idle. Nothing is cancelled or
   * answered here, and a client Sotto cannot find or would refuse leaves everything as it was.
   */
  async clientUpdated(): Promise<void> {
    if (!this.state.connected) return
    const generation = this.generation
    const program = this.options.program ?? await findCursorProgram(this.options.environment).catch(() => undefined)
    if (generation !== this.generation || !this.state.connected) return
    if (!program) throw new Error('Cursor was updated, but Sotto cannot find it now. Threads that are working carry on and nothing was lost. Check Cursor’s CLI, then connect Cursor again.')
    let version: string
    try { version = await readCursorVersion(program, this.environment()) }
    catch (error) {
      if (generation !== this.generation || !this.state.connected) return
      throw new Error('Cursor was updated, but the new version did not answer. Threads that are working carry on and nothing was lost. Connect Cursor again to try the new version.', { cause: error })
    }
    if (generation !== this.generation || !this.state.connected) return
    if (compareCursorVersions(version, CURSOR_CLI_VERSION) < 0) throw new Error(`Cursor was updated, but Sotto cannot run ${version}: ${CURSOR_CLI_VERSION} or newer is needed. Threads that are working carry on and nothing was lost.`)
    this.program = program; this.clientRevision++
    this.state.version = `${version} / ACP ${CURSOR_ACP_VERSION}`
    if (compareCursorVersions(version, CURSOR_CLI_VERSION) > 0) this.state.verifiedVersion = CURSOR_CLI_VERSION
    else delete this.state.verifiedVersion
    for (const [id, connection] of this.connections) if (connection.clientRevision < this.clientRevision) this.outdated.add(id)
    this.emit()
  }
  /** Stop each outdated process whose thread is not busy; a watched one opens again at once on the new client. */
  private stopOutdated(): void {
    if (!this.outdated.size) return
    for (const id of [...this.outdated]) {
      const connection = this.connections.get(id)
      if (!connection || connection.clientRevision === this.clientRevision) { this.outdated.delete(id); continue }
      if (this.busy(id)) continue
      this.outdated.delete(id)
      const generation = this.generation
      void this.stopSession(id).then(() => {
        if (generation === this.generation && this.observed.has(id) && this.aliases[id]?.cursorSessionId) return this.open(id).then(() => undefined)
      }).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
    }
  }

  // ---- Sessions ------------------------------------------------------------------------------------------------------

  /** A thread being created or sent to, a prompt in flight, a session opening or an unanswered request hold a session open. */
  private busy(id: string): boolean {
    const turn = this.turns.get(id)
    return this.dispatching.has(id) || this.loading.has(id) || this.stopping.has(id) || (turn !== undefined && !turn.ended)
      || (this.threads.get(id)?.requests.length ?? 0) > 0
  }
  /** This thread's session, opened on its own process when it has none: a thread is read by opening it. */
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
    if (!alias?.cursorSessionId) throw new Error('Cursor did not confirm this thread’s session. Your thread is kept. Start a new thread to carry on.')
    const cwd = await existingWorkingDirectory(alias.cwd)
    this.assertGeneration(generation)
    const connection = await this.startProcess(id, alias, cwd, profile !== undefined)
    if (generation !== this.generation) { this.close(connection); throw new CursorUncertain('Cursor’s connection changed while the thread was opening.') }
    this.connections.set(id, connection)
    try {
      const mcpServers = await this.toolServers(id, connection.watcher)
      this.assertGeneration(generation)
      connection.replay = { messages: [], byId: new Map(), activities: [], turns: 0, turn: undefined, createdAt: alias.createdAt, userCreatedAt: alias.createdAt }
      await connection.rpc.request('session/load', { sessionId: alias.cursorSessionId, cwd: alias.cwd, mcpServers }, value => { this.readSettings(connection, value) })
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new CursorUncertain('Cursor’s connection changed while the thread was opening.')
      const replay = connection.replay
      connection.replay = undefined
      this.mergeReplay(id, replay)
      if (alias.turns !== replay.turns) { alias.turns = replay.turns; await this.persist() }
      this.log.pin(id); this.reaper.touch(id)
      const thread = this.thread(id)
      if (!this.turns.get(id) || this.turns.get(id)!.ended) thread.status = 'idle'
      return connection
    } catch (error) {
      if (this.connections.get(id) === connection) this.connections.delete(id)
      this.close(connection)
      if (error instanceof CursorRejected) throw new Error('Cursor could not open this thread’s saved session. Your Sotto history is kept. Start a new thread to carry on; Sotto will not resend earlier work.', { cause: error })
      throw error
    }
  }
  /** Stop this thread's session: its process ends, and the next action starts one and loads the session again. */
  private stopSession(id: string): Promise<void> {
    const previous = this.stopping.get(id); if (previous) return previous
    const connection = this.connections.get(id)
    if (!connection) return Promise.resolve()
    const work = (async () => {
      this.connections.delete(id); this.outdated.delete(id)
      if (this.loaded.delete(id)) this.emit()
      this.log.release(id); this.reaper.forget(id)
      this.close(connection); await connection.rpc.closed
    })().finally(() => { if (this.stopping.get(id) === work) this.stopping.delete(id) })
    this.stopping.set(id, work)
    return work
  }
  /**
   * A thread's process ended without Sotto asking. Only that thread is affected: its requests can no longer be
   * answered, and a turn it was running failed. The next action starts a new process.
   */
  private processLost(id: string, connection: Connection): void {
    if (connection.closing || this.connections.get(id) !== connection) return
    this.connections.delete(id); this.outdated.delete(id); this.loaded.delete(id); this.log.release(id); this.reaper.forget(id)
    this.clearRequests(id)
    this.endTurn(id, 'failed', PROCESS_LOST)
    this.emit()
  }
  async startThreadSession(id: string, draft?: ThreadSessionDraft): Promise<void> {
    void draft
    const generation = this.generation
    await this.checkLaunchProfile(id)
    this.assertGeneration(generation)
    // A thread whose first send has not happened has no session to open; making one is the send's to do.
    if (!this.state.connected || !this.aliases[id]?.cursorSessionId) return
    await this.open(id)
    this.reaper.touch(id)
  }
  observeThreads(ids: readonly string[]): void {
    this.observed.clear(); for (const id of ids) this.observed.add(id)
    this.log.observe(ids)
    if (!this.state.connected) return
    const generation = this.generation
    for (const id of ids) if (this.aliases[id]?.cursorSessionId) void this.open(id).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
  }
  async snapshot(): Promise<AgentHostSnapshot> { return this.current() }
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]?.cursorSessionId) throw new Error('This Cursor thread has no confirmed session.')
    const generation = this.generation
    await this.checkLaunchProfile(id)
    this.assertGeneration(generation)
    await this.open(id)
    return this.current(purpose?.historyFromEvents)
  }

  // ---- What Cursor says ----------------------------------------------------------------------------------------------

  /** The model and effort a session answer names: its `model` option, and that model's effort option. */
  private readSettings(connection: Connection, value: unknown): void {
    const options = configOptionsSchema.parse(value).configOptions ?? []
    const model = options.find(option => option.id === 'model')?.currentValue
    if (typeof model === 'string') connection.model = model
    const effortId = typeof model === 'string' ? this.facts.get(model)?.effortOption : undefined
    const effort = effortId ? options.find(option => option.id === effortId)?.currentValue : undefined
    connection.effort = typeof effort === 'string' ? effort : undefined
  }
  /** Every frame from one thread's process. A request is answered on the process that asked, never another. */
  private async frame(id: string, connection: Connection, frame: CursorFrame): Promise<void> {
    const alias = this.aliases[id]
    if (!alias || connection.closing) return
    const params = record(frame.params)
    if (frame.method === 'session/update') {
      if (!params || (alias.cursorSessionId && params.sessionId !== alias.cursorSessionId)) return
      const update = record(params.update)
      if (!update) return
      if (connection.replay) { this.replayUpdate(id, alias, connection.replay, update); return }
      if (this.connections.get(id) !== connection) return
      this.liveUpdate(id, alias, connection, update)
      return
    }
    if (!frame.method || frame.id === undefined) return
    if (this.connections.get(id) !== connection) { connection.rpc.refuse(frame.id); return }
    this.taken(id)
    const turn = this.turns.get(id)
    const place = (toolCallId: unknown, opens: boolean): CursorPlace => ({ turnId: turn?.places.key ?? this.log.lastUserMessageId(id) ?? 'cursor-history',
      afterMessageId: this.log.lastMessageId(id), cwd: alias.cwd, ...(typeof toolCallId === 'string' && turn ? { key: turn.places.tool(toolCallId, opens) } : {}) })
    if (['cursor/update_todos', 'cursor/task', 'cursor/generate_image'].includes(frame.method)) {
      // Cursor tells the client about these and waits for nothing but an acknowledgement.
      const thread = this.thread(id), previous = thread.activities ?? []
      const rows = frame.method === 'cursor/update_todos' ? cursorTodos(frame.params, place(undefined, false), previous)
        : frame.method === 'cursor/task' ? cursorTask(frame.params, place(params?.toolCallId, false), previous, true)
        : cursorImage(frame.params, place(params?.toolCallId, false), previous)
      if (rows.length) { thread.activities = mergeAgentActivities(previous, rows); this.emit(true) }
      void connection.rpc.reply(frame.id, {}).catch(() => undefined)
      return
    }
    if (frame.method === 'session/request_permission' && alias.cursorSessionId && params?.sessionId !== alias.cursorSessionId) { connection.rpc.refuse(frame.id); return }
    const asked = cursorPending(frame.id, frame.method, frame.params, id)
    if (!asked) {
      connection.rpc.refuse(frame.id)
      // Cursor reads the refusal as an answer and keeps going, so a reshaped question must not pass as the user declining.
      if (needsPerson(frame.method) || frame.method.startsWith('cursor/ask') || frame.method.startsWith('cursor/create')) {
        const notice = unreadableRequest('Cursor'); const thread = this.thread(id)
        thread.requestNotice = notice; this.state.error = notice; this.emit()
      }
      return
    }
    const requestId = `cursor-request-${digest(JSON.stringify([id, connection.nonce, frame.id]))}`
    const pending: Pending = { ...asked, request: { ...asked.request, id: requestId }, connection }
    if (this.pending.has(requestId)) return
    // Watcher's profile is checked again before anything of its session is shown: one main no longer verifies stops it.
    if (connection.watcher) {
      try { await this.launchProfile(id, connection.rpc) } catch { return }
      if (this.connections.get(id) !== connection || connection.closing) return
    }
    if (this.indexOf(id, alias).wasAnswered(requestId)) { void connection.rpc.reply(frame.id, cursorDecline(pending)).catch(() => undefined); return }
    if (this.pending.size >= 128) { void connection.rpc.reply(frame.id, cursorDecline(pending)).catch(() => undefined); return }
    this.pending.set(requestId, pending)
    this.thread(id).requests.push(pending.request)
    this.reaper.touch(id); this.emit()
  }
  /** A live update from the thread's own stream: its reply, its work, or something typed into the session elsewhere. */
  private liveUpdate(id: string, alias: Alias, connection: Connection, update: Record<string, unknown>): void {
    this.reaper.touch(id)
    const kind = String(update.sessionUpdate)
    if (kind === 'available_commands_update') {
      const parsed = commandsSchema.safeParse(update.availableCommands)
      if (parsed.success) { connection.commands = cursorSkills(parsed.data); this.commands = connection.commands }
      return
    }
    if (kind === 'config_option_update') { this.readSettings(connection, update); return }
    if (!['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(kind)) { this.taken(id); return }
    const content = record(update.content)
    const words = content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined
    if (kind === 'user_message_chunk') {
      if (words === undefined) return
      const turn = this.turns.get(id)
      // Cursor does not echo a prompt; one that comes back anyway is the prompt Sotto sent, not new input.
      if (turn?.origin && !turn.taken && digest(words) === turn.origin.digest) { this.taken(id); return }
      // Something typed into this session elsewhere starts a turn of its own.
      const index = alias.turns; alias.turns++
      void this.persist().catch(() => undefined)
      const key = `cursor-user-${index}-${digest(words).slice(0, 16)}`
      this.log.add(id, { id: key, role: 'user', text: words, createdAt: new Date().toISOString() })
      // Sotto never sees that turn's prompt answered, so it holds nothing open: its work is placed under it as it comes.
      this.turns.set(id, { places: new TurnPlaces(key), origin: undefined, taken: true, ended: true, wake: undefined })
      this.emit()
      return
    }
    this.taken(id)
    let turn = this.turns.get(id)
    if (!turn) {
      // Work with no turn Sotto knows of belongs to the newest user message.
      turn = { places: new TurnPlaces(this.log.lastUserMessageId(id) ?? 'cursor-history'), origin: undefined, taken: true, ended: true, wake: undefined }
      this.turns.set(id, turn)
    }
    const thread = this.thread(id)
    if (kind === 'agent_message_chunk') {
      if (words === undefined) return
      const reply = turn.places.reply()
      if (reply.opened || !this.log.has(id, reply.id)) {
        this.log.add(id, { id: reply.id, role: 'assistant', text: words, createdAt: new Date().toISOString(), turnMessageId: turn.places.key })
        const settled = settledThinking(CURSOR_THINKING_ID_PREFIX, thread.activities ?? [], 'completed', true)
        if (settled.length) thread.activities = mergeAgentActivities(thread.activities, settled)
        this.emit()
      } else { this.log.appendText(id, reply.id, words); this.emit(true) }
      return
    }
    const key = kind === 'agent_thought_chunk' ? turn.places.thought()
      : typeof update.toolCallId === 'string' && (kind === 'tool_call' || kind === 'tool_call_update') ? turn.places.tool(update.toolCallId, kind === 'tool_call') : undefined
    const rows = cursorActivities(update, { turnId: turn.places.key, afterMessageId: this.log.lastMessageId(id), cwd: alias.cwd, key }, thread.activities, true)
    if (rows.length) { thread.activities = mergeAgentActivities(thread.activities, rows); this.emit(kind === 'agent_thought_chunk') }
  }
  /** One update of a `session/load` replay: whole messages and finished work, in order, with no time or ID of Cursor's own. */
  private replayUpdate(id: string, alias: Alias, replay: Replay, update: Record<string, unknown>): void {
    const kind = String(update.sessionUpdate)
    const content = record(update.content)
    const words = content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined
    if (kind === 'user_message_chunk') {
      if (words === undefined) return
      const index = replay.turns++
      const hash = digest(words)
      const origin = this.indexOf(id, alias).replayed(index, hash, replay.byId)
      const key = origin?.messageId ?? `cursor-user-${index}-${hash.slice(0, 16)}`
      const createdAt = origin?.createdAt ?? replay.userCreatedAt
      replay.userCreatedAt = createdAt
      // A message to Watcher comes back as it was sent, its digest proving it: Sotto's own parts come off by their counts.
      const at = origin?.sottoAt ?? 0, head = origin?.sottoHead ?? 0, tail = origin?.sottoTail ?? 0
      const typed = head + tail > 0 && words.length >= at + head + tail ? words.slice(0, at) + words.slice(at + head, words.length - tail) : words
      const message: AgentMessage = { id: key, role: 'user', text: typed, createdAt, ...(origin ? { commandId: origin.commandId } : {}),
        ...(origin?.attachments.length ? { attachments: origin.attachments.map(ref => ({ ...ref })) } : {}) }
      replay.messages.push(message); replay.byId.set(key, message)
      replay.turn = new TurnPlaces(key)
      return
    }
    const turn = replay.turn ?? (replay.turn = new TurnPlaces('cursor-history'))
    if (kind === 'agent_message_chunk') {
      if (words === undefined) return
      const reply = turn.reply()
      const held = replay.byId.get(reply.id)
      if (held) held.text += words
      else { const message: AgentMessage = { id: reply.id, role: 'assistant', text: words, createdAt: replay.userCreatedAt, turnMessageId: turn.key }; replay.messages.push(message); replay.byId.set(reply.id, message) }
      return
    }
    const key = kind === 'agent_thought_chunk' ? turn.thought()
      : typeof update.toolCallId === 'string' && (kind === 'tool_call' || kind === 'tool_call_update') ? turn.tool(update.toolCallId, kind === 'tool_call') : undefined
    const rows = cursorActivities(update, { turnId: turn.key, afterMessageId: replay.messages.at(-1)?.id, cwd: alias.cwd, key }, replay.activities, false)
    if (rows.length) replay.activities = mergeAgentActivities(replay.activities, rows)
  }
  /** A replay into the thread's log: what the store holds is recognised, and a reply streamed longer than its replay is kept. */
  private mergeReplay(id: string, replay: Replay): void {
    for (const message of replay.messages) {
      const previous = this.log.message(id, message.id)
      if (message.role === 'assistant' && previous && previous.text.length > message.text.length && previous.text.startsWith(message.text)) continue
      this.log.add(id, message)
    }
    // A thought the replay ends on was not seen to end, and nothing more will come for it now.
    const settled = settledThinking(CURSOR_THINKING_ID_PREFIX, replay.activities, 'completed', false)
    const rows = settled.length ? mergeAgentActivities(replay.activities, settled) : replay.activities
    if (rows.length) { const thread = this.thread(id); thread.activities = mergeAgentActivities(thread.activities ?? [], rows) }
  }
  /** Cursor has shown it is working on the prompt Sotto sent: the send waiting on it is woken. */
  private taken(id: string): void {
    const turn = this.turns.get(id)
    if (turn && !turn.taken) { turn.taken = true; if (turn.instructs) turn.instructs.instructed = true; turn.wake?.() }
  }
  /** A turn ended: how, its thoughts settled, and the thread ready for the next prompt. */
  private endTurn(id: string, status: 'completed' | 'interrupted' | 'failed', error?: string): void {
    const turn = this.turns.get(id)
    if (!turn || turn.ended) return
    turn.ended = true; turn.taken = true; turn.wake?.()
    const thread = this.threads.get(id); if (!thread) return
    thread.status = status === 'failed' ? 'error' : 'idle'
    thread.lastTurn = { id: turn.places.key, status }
    const thoughts = settledThinking(CURSOR_THINKING_ID_PREFIX, thread.activities ?? [], thinkingSettledAs(status), true)
    const settled = thoughts.length ? mergeAgentActivities(thread.activities, thoughts) : thread.activities
    // Work still running when its turn ended has an outcome nobody saw, unless the turn was stopped.
    const closed = settled?.map(row => row.status === 'running' && row.kind !== 'turn' && row.kind !== 'plan' && row.turnId === turn.places.key
      ? { ...row, status: status === 'completed' ? 'completed' as const : status === 'interrupted' ? 'interrupted' as const : 'unknown' as const } : row)
    thread.activities = markTurnActivity(closed, { provider: 'cursor', turnId: turn.places.key, status, ...(error ? { error } : {}) })
    this.reaper.touch(id)
  }

  // ---- Commands ------------------------------------------------------------------------------------------------------

  async execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.executeGuarded(command) }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> { return this.executeGuarded(command, guard) }
  private async executeGuarded(command: AgentHostCommand, watcherGuard?: () => void): Promise<AgentHostResult> {
    const generation = this.generation
    let profile: WatcherLaunchProfile | undefined
    if ('threadId' in command) {
      try { profile = await this.checkLaunchProfile(command.threadId) }
      catch (error) { if (error instanceof CursorUncertain) return { accepted: false, uncertain: true }; throw error }
      this.assertGeneration(generation)
      if (profile) assertWatcherPermission(command)
    }
    if (command.type === 'steer') throw new Error('Cursor takes no message while it works. Queue this follow-up instead.')
    if (command.type === 'compact-thread') throw new Error('Cursor cannot compact a thread.')
    if (!this.state.connected) throw new Error('Connect Cursor before managing threads.')
    if (command.type !== 'send' && command.type !== 'create-thread') return this.run(command, generation, profile, watcherGuard)
    if (this.dispatching.has(command.threadId)) throw new Error('Cursor is already receiving work for this thread. Wait for its delivery result.')
    this.dispatching.add(command.threadId)
    try { return await this.run(command, generation, profile, watcherGuard) } finally { this.dispatching.delete(command.threadId); this.stopOutdated() }
  }
  private async run(command: AgentHostCommand, generation: number, profile: WatcherLaunchProfile | undefined, watcherGuard?: () => void): Promise<AgentHostResult> {
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('Cursor projects need an absolute folder.')
        if (!this.state.projects.some(project => project.id === command.projectId)) {
          this.state.projects.push({ id: command.projectId, title: command.title, path: command.path })
          await this.projectStore.write(this.state.projects)
        }
        this.emit(); return { accepted: true }
      }
      if (command.type === 'create-thread') return await this.create(command, generation, profile, watcherGuard)
      if (command.type === 'configure-thread') return await this.configure(command, generation, watcherGuard)
      const id = command.threadId, alias = this.aliases[id]
      if (!alias?.cursorSessionId) throw new Error('Cursor did not confirm this thread’s session. Your thread is kept. Do not repeat its creation automatically.')
      if (command.type === 'interrupt') return await this.interrupt(id, alias, watcherGuard)
      const connection = await this.open(id)
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new CursorUncertain('Cursor’s connection changed.')
      this.reaper.touch(id)
      if (command.type === 'send') return await this.send(command, alias, connection, generation, profile, watcherGuard)
      if (command.type === 'answer') return await this.answer(command, alias, connection, profile)
      throw new Error('Cursor does not take that action.')
    } catch (error) {
      if (error instanceof CursorUncertain) return { accepted: false, uncertain: true }
      throw error
    }
  }
  private async create(command: Extract<AgentHostCommand, { type: 'create-thread' }>, generation: number, profile: WatcherLaunchProfile | undefined, watcherGuard?: () => void): Promise<AgentHostResult> {
    const saved = this.aliases[command.threadId]
    if (saved) return saved.cursorSessionId ? { accepted: true } : { accepted: false, uncertain: true }
    const allowEdits = command.runtimeMode === 'auto-accept-edits'
    const runtimeMode = cursorRuntimeMode(command.runtimeMode)
    validateThreadOptions(this.state, { ...command, runtimeMode })
    const project = this.state.projects.find(item => item.id === command.projectId)
    if (!project) throw new Error('Choose a Cursor project first.')
    // A create that names no effort starts on the model's default and says so to Cursor, so the chip names the effort it runs at.
    const reasoningEffort = command.reasoningEffort ?? this.model(command.modelId)?.defaultReasoningEffort
    const alias: Alias = { projectId: project.id, cwd: await existingWorkingDirectory(command.workingDirectory ?? project.path), title: command.title, createdAt: new Date().toISOString(),
      modelId: command.modelId, ...(reasoningEffort ? { reasoningEffort } : {}), runtimeMode, turns: 0, origins: [], answeredRequestIds: [] }
    this.assertGeneration(generation)
    const connection = await this.startProcess(command.threadId, alias, alias.cwd, profile !== undefined)
    if (generation !== this.generation) { this.close(connection); throw new CursorUncertain('Cursor’s connection changed.') }
    // The process is the thread's from here, so what it says while its session is made reaches the thread.
    this.connections.set(command.threadId, connection)
    try {
      this.aliases[command.threadId] = alias; await this.persist()
      const mcpServers = await this.toolServers(command.threadId, connection.watcher)
      this.assertGeneration(generation)
      watcherGuard?.()
      await connection.rpc.request('session/new', { cwd: alias.cwd, mcpServers }, async value => {
        const answer = sessionNewSchema.parse(value)
        alias.cursorSessionId = answer.sessionId; this.readSettings(connection, answer); await this.persist()
      })
      this.assertGeneration(generation)
      await this.applySettings(alias, connection)
    } catch (error) {
      if (this.connections.get(command.threadId) === connection) this.connections.delete(command.threadId)
      this.close(connection)
      if (this.aliases[command.threadId] === alias && alias.cursorSessionId) this.thread(command.threadId).status = 'error'
      throw error
    }
    const thread = this.thread(command.threadId)
    thread.status = 'idle'; thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode
    if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort
    if (allowEdits) thread.requestNotice = CURSOR_ALLOW_EDITS_NOTICE
    // A session made just now has nothing to replay: it is open and up to date.
    this.loaded.add(command.threadId); this.log.pin(command.threadId); this.reaper.touch(command.threadId)
    this.emit(); return { accepted: true }
  }
  private model(modelId: string): AgentModel | undefined { return this.facts.get(modelId)?.model }
  /**
   * Put the session on the thread's model and effort before a prompt that needs them, and read both back from
   * Cursor's answer (ADR-0128). Cursor applies a model to every session in its process, which is only this thread's.
   */
  private async applySettings(alias: Alias, connection: Connection, rpc: CursorRpc = connection.rpc, sessionId = alias.cursorSessionId, modelId = alias.modelId, effort = alias.reasoningEffort): Promise<void> {
    if (connection.model !== modelId) {
      await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: modelId }, value => { this.readSettings(connection, value) })
      if (connection.model !== modelId) throw new Error('Cursor did not confirm this thread’s model. Your thread and draft are kept. Choose the model again, then send.')
    }
    const option = this.facts.get(modelId)?.effortOption
    if (option && effort && connection.effort !== effort) {
      await rpc.request('session/set_config_option', { sessionId, configId: option, value: effort }, value => { this.readSettings(connection, value) })
      if (connection.effort !== effort) throw new Error('Cursor did not confirm this thread’s effort. Your thread and draft are kept. Choose the effort again, then send.')
    }
  }
  private async configure(command: Extract<AgentHostCommand, { type: 'configure-thread' }>, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const id = command.threadId, alias = this.aliases[id]
    if (!alias?.cursorSessionId) throw new Error('Cursor did not confirm this thread’s session. Your thread is kept.')
    if (command.providerMode !== undefined) throw new Error('That permission mode is not supported by this provider.')
    const runtimeMode = command.runtimeMode === undefined ? undefined : cursorRuntimeMode(command.runtimeMode)
    const modelId = command.modelId ?? alias.modelId
    const reasoningEffort = effortAfterChange(this.state, command, alias.reasoningEffort)
    validateThreadOptions(this.state, { modelId, ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}), ...(runtimeMode ? { runtimeMode } : {}) }, alias.modelId)
    const thread = this.thread(id)
    const modeChanges = runtimeMode !== undefined && runtimeMode !== alias.runtimeMode
    // A change Watcher's room or a phone asked for is checked before anything changes, and again at the write: a phone
    // that let go of Watcher meanwhile changes nothing (ADR-0073).
    watcherGuard?.()
    // A session still opening or stopping, as one does after the last mode change, is not work: the change waits for it.
    if (modeChanges) { await this.loading.get(id)?.catch(() => undefined); await this.stopping.get(id); this.assertGeneration(generation) }
    // A process takes its approval mode when it starts, so a new mode means a new process, once the thread is quiet.
    if (modeChanges && this.busy(id)) throw new Error('Cursor is working on this thread. Its permission mode is unchanged. Change it once the thread is idle.')
    watcherGuard?.()
    alias.modelId = modelId
    if (reasoningEffort) alias.reasoningEffort = reasoningEffort; else delete alias.reasoningEffort
    if (runtimeMode) alias.runtimeMode = runtimeMode
    await this.persist()
    this.assertGeneration(generation)
    thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode
    if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort; else delete thread.reasoningEffort
    if (command.runtimeMode === 'auto-accept-edits') thread.requestNotice = CURSOR_ALLOW_EDITS_NOTICE
    // The model and effort reach Cursor before the next prompt that needs them. The mode starts a fresh process, which
    // loads the session there straight away for a thread someone is looking at.
    if (modeChanges && this.connections.has(id)) {
      await this.stopSession(id)
      this.assertGeneration(generation)
      if (this.observed.has(id)) void this.open(id).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
    }
    this.emit()
    return { accepted: true, snapshot: this.current(command.historyFromEvents) }
  }
  private async send(command: Extract<AgentHostCommand, { type: 'send' }>, alias: Alias, connection: Connection, generation: number, profile: WatcherLaunchProfile | undefined, watcherGuard?: () => void): Promise<AgentHostResult> {
    const id = command.threadId
    const current = (): void => {
      if (generation !== this.generation || this.connections.get(id) !== connection || !this.state.connected) throw new CursorUncertain('Cursor’s connection changed. Delivery has not been confirmed.')
    }
    const index = this.indexOf(id, alias)
    const previous = index.sent(command.commandId, command.messageId)
    if (previous) {
      if (previous.messageId !== command.messageId || previous.commandId !== command.commandId) throw new Error('This Cursor message identity is already in use.')
      return this.log.has(id, previous.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
    }
    if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(id) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
    const running = this.turns.get(id)
    if (running && !running.ended) throw new Error('Cursor is still working on this thread. Queue this follow-up.')
    if (this.thread(id).requests.length) throw new Error('Answer Cursor’s pending request before sending another message.')
    const attachments = validatePromptAttachments(this.state, alias.modelId, command.attachments)
    verifyFileMentions(command.text, command.files)
    // A skill is Cursor's own `/name`, read at the start of the prompt. One the user typed at the start of the words stays
    // there, ahead of anything Sotto adds; one chosen and not typed goes first.
    const skills = (command.skills ?? []).map(skill => `/${skill.name}`).filter(token => !new RegExp(`(^|\\s)${escapeRegExp(token)}(\\s|$)`, 'u').test(command.text))
    const lead = leadingSkills(command.text, [...(command.skills ?? []).map(skill => skill.name), ...(connection.commands ?? []).map(skill => skill.name)])
    // Watcher's request note's line goes after the words, and its instructions, when its session needs them, ahead of
    // them, in the one text part Cursor replays as it was sent (ADR-0128); a wake-up's news for Watcher goes the same way
    // as the note. An ordinary thread is sent the words alone, even when a command carried a note.
    const note = profile ? command.watcherRequestNote ?? command.watcherNews : undefined
    // Once per conversation, not with every message (#1418): with the first message on this process, and again when the
    // note says the conversation is new or was compacted. The line stays until Watcher reads its state, so only its first
    // note asks again.
    if (profile) {
      const reminder = note?.includes(WATCHER_COMPACTED_NOTE) === true
      if (reminder && !connection.reminded) connection.instructed = false
      connection.reminded = reminder
    }
    const instructing = profile !== undefined && !connection.instructed
    // The skills go first and Watcher's instructions after them, since Cursor reads a skill only at the start; then the
    // words. Sotto keeps where its own part starts and how long it is, never the words.
    const head = (skills.length ? `${skills.join(' ')} ` : '') + (instructing ? cursorWatcherInstructions(profile.instructions) : '')
    const tail = note ? watcherRequestLine(note) : ''
    const nativeText = lead + head + command.text.slice(lead.length) + tail
    const images: { type: 'image'; mimeType: string; data: string }[] = []
    for (const attachment of attachments) images.push({ type: 'image', mimeType: attachment.mimeType, data: Buffer.from(await attachment.read()).toString('base64') })
    await this.applySettings(alias, connection)
    current()
    const origin: Origin = { messageId: command.messageId, commandId: command.commandId, digest: digest(nativeText), createdAt: new Date().toISOString(), turn: alias.turns,
      attachments: attachments.map(({ id: attachmentId, name, mimeType, sizeBytes }) => ({ id: attachmentId, name, mimeType, sizeBytes })),
      ...(profile ? { ...(lead.length ? { sottoAt: lead.length } : {}), sottoHead: head.length, sottoTail: tail.length } : {}) }
    index.add(origin); alias.turns++
    await this.persist()
    current()
    try { watcherGuard?.() } catch (error) { index.remove(origin); alias.turns--; await this.persist(); throw error }
    const thread = this.thread(id)
    delete thread.requestNotice
    // A prompt Cursor did not take keeps the instructions owed.
    const turn: LiveTurn = { places: new TurnPlaces(origin.messageId), origin, ...(instructing ? { instructs: connection } : {}), taken: false, ended: false, wake: undefined }
    this.turns.set(id, turn)
    // Running goes out before the prompt's own message. The workspace publishes that message as soon as it hears of it,
    // and the coordinator takes the send it settles as answered and reads nothing after (#765), so a thread published
    // running only after it could answer its send idle until the next publish.
    thread.status = 'running'; thread.lastTurn = { id: origin.messageId, status: 'running' }
    thread.activities = markTurnActivity(thread.activities, { provider: 'cursor', turnId: origin.messageId, status: 'running', afterMessageId: origin.messageId })
    this.emit()
    this.log.add(id, { id: origin.messageId, role: 'user', text: command.text, commandId: origin.commandId, createdAt: origin.createdAt,
      ...(origin.attachments.length ? { attachments: origin.attachments.map(ref => ({ ...ref })) } : {}) })
    this.emit()
    markSendStage(command.commandId, 'written')
    const superseded = (): boolean => generation !== this.generation || this.turns.get(id) !== turn
    void connection.rpc.request('session/prompt', { sessionId: alias.cursorSessionId, prompt: [{ type: 'text', text: nativeText }, ...images] }, value => {
      if (superseded()) return
      const stop = promptAnswerSchema.parse(value).stopReason
      // Cursor answered the prompt, so its session holds what the prompt carried.
      if (instructing) connection.instructed = true
      this.endTurn(id, stop === 'end_turn' ? 'completed' : stop === 'cancelled' ? 'interrupted' : stop === 'refusal' ? 'failed' : 'completed',
        stop === 'refusal' ? 'Cursor refused this turn. Nothing else was lost.' : undefined)
      this.emit()
    }, true).catch((error: unknown) => {
      if (superseded() || turn.ended) return
      this.endTurn(id, 'failed', connection.rpc.alive ? error instanceof CursorRejected ? 'Cursor refused this message. Nothing else was lost. Check the thread’s model, then send again.' : undefined : PROCESS_LOST)
      this.emit()
    })
    return this.awaitTaken(command.commandId, turn, generation)
  }
  /**
   * Whether Cursor took the prompt. ACP sends no acknowledgement, so the evidence is the thread's own process working:
   * any update or request it sends after the prompt went out, or the prompt's own answer. A prompt with no evidence by
   * the deadline stays uncertain, and is never sent again.
   */
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
  private async answer(command: Extract<AgentHostCommand, { type: 'answer' }>, alias: Alias, connection: Connection, profile: WatcherLaunchProfile | undefined): Promise<AgentHostResult> {
    const pending = this.pending.get(command.requestId)
    if (!pending || pending.threadId !== command.threadId) throw new Error('That Cursor request is no longer waiting.')
    // Watcher keeps no remembered grant on any provider; Cursor offers none, and this holds if it ever does.
    if (profile) assertWatcherPermissionChoice(pending.request, command.permissionChoice)
    if (pending.connection !== connection) return { accepted: false, uncertain: true }
    if (pending.answering) return { accepted: false, uncertain: true }
    const result = cursorAnswer(pending, command.answer, command.approved, command.questionAnswers, command.permissionChoice)
    pending.answering = true
    const index = this.indexOf(command.threadId, alias)
    index.answer(pending.request.id)
    try { await this.persist() } catch (error) { index.unanswer(pending.request.id); pending.answering = false; throw error }
    if (this.pending.get(command.requestId) !== pending || this.connections.get(command.threadId) !== connection) return { accepted: false, uncertain: true }
    try { await connection.rpc.reply(pending.wireId, result); this.removeRequest(command.requestId) }
    catch { pending.request.delivery = 'uncertain'; this.emit(); return { accepted: false, uncertain: true } }
    this.emit(); return { accepted: true }
  }
  private async interrupt(id: string, alias: Alias, watcherGuard?: () => void): Promise<AgentHostResult> {
    const connection = this.connections.get(id)
    // Every request still waiting is declined, which grants nothing, before Cursor is told to stop.
    if (!watcherGuard) for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id && !pending.answering) {
      this.removeRequest(requestId); await pending.connection.rpc.reply(pending.wireId, cursorDecline(pending)).catch(() => undefined)
    }
    watcherGuard?.()
    if (connection) connection.rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: alias.cursorSessionId } })
    this.emit(); return { accepted: true }
  }
  private removeRequest(requestId: string): void {
    const pending = this.pending.get(requestId); if (!pending) return
    this.pending.delete(requestId)
    const thread = this.threads.get(pending.threadId)
    if (thread) thread.requests = thread.requests.filter(request => request.id !== requestId)
  }
  private clearRequests(id: string): void {
    for (const [requestId, pending] of this.pending) if (pending.threadId === id) this.pending.delete(requestId)
    const thread = this.threads.get(id); if (thread) thread.requests = []
  }

  // ---- Skills and short text -----------------------------------------------------------------------------------------

  /** Cursor's skills, as `/name`, from what the thread's session listed (`available_commands_update`). */
  async listThreadSkills(threadId: string, forceReload = false, scope?: AgentSkillScope): Promise<AgentSkillCatalog> {
    void forceReload // Cursor lists its skills afresh whenever a session opens.
    if (this.aliases[threadId]) await this.checkLaunchProfile(threadId)
    const alias = this.aliases[threadId]
    const cwd = alias?.cwd ?? (scope?.providerId === 'cursor' ? scope.workingDirectory : undefined) ?? ''
    if (!this.state.connected) return { threadId, providerId: 'cursor', cwd, status: 'error', skills: [], errors: [], error: 'Connect Cursor to read its skills.' }
    let skills = this.connections.get(threadId)?.commands
    if (!skills && alias?.cursorSessionId) {
      const connection = await this.open(threadId).catch(() => undefined)
      // Cursor lists them just after the session opens.
      for (let waited = 0; connection && !connection.commands && waited < 3_000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100))
      skills = connection?.commands
    }
    skills ??= this.commands
    if (!skills) return { threadId, providerId: 'cursor', cwd, status: 'error', skills: [], errors: [], error: 'Cursor has not listed its skills yet. Open a Cursor thread, then try again.' }
    return { threadId, providerId: 'cursor', cwd, status: 'ready', errors: [], skills: skills.map(skill => ({ ...skill })) }
  }
  /**
   * Sotto's short text on Cursor (ADR-0026): one prompt in a session of its own, on a process of its own, in Cursor's
   * `ask` mode, on the thread's model at its least effort. The thread's session never hears of it. A side call uses no
   * tools, and Cursor's `ask` mode still reads the project, so its process runs with Sotto's side-call Cursor folder,
   * whose rules deny every tool, and the side session stays there; every request it makes is answered `cancelled`; and
   * a tool call that shows anyway stops the call, which then writes nothing.
   */
  async writeShortText(id: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    const generation = this.generation
    if (await this.launchProfiles?.profileFor(id).catch(() => undefined)) return null
    const alias = this.aliases[id], program = this.program
    if (!this.state.connected || !program || !alias?.cursorSessionId) return null
    const cwd = await existingWorkingDirectory(alias.cwd)
    this.assertGeneration(generation)
    await writeCursorSideConfig(this.sideConfigDirectory)
    this.assertGeneration(generation)
    let text = ''
    let sessionId: string | undefined
    /** The model reached for a tool: the call is stopped once, and writes nothing. */
    let tooled = false
    const stop = (rpc: CursorRpc): void => {
      if (tooled) return
      tooled = true
      if (sessionId) { try { rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }) } catch { /* A closed pipe runs nothing more. */ } }
    }
    const writer = this.spawn(program, ['acp'], cwd, (frame, rpc) => {
      if (frame.method && frame.id !== undefined) { void rpc.reply(frame.id, { outcome: { outcome: 'cancelled' } }).catch(() => undefined); if (sessionId) stop(rpc); return }
      const params = record(frame.params), update = record(params?.update), content = record(update?.content)
      if (frame.method !== 'session/update' || !sessionId || params?.sessionId !== sessionId) return
      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') { stop(rpc); return }
      if (!tooled && update?.sessionUpdate === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') text += content.text
    }, () => undefined, this.sideConfigDirectory)
    const abort = (): void => writer.close()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, SIDE_WRITING_TIMEOUT_MS); timer.unref()
    try {
      if (signal?.aborted) return null
      await this.handshake(writer)
      await writer.request('session/new', { cwd, mcpServers: [] }, value => { sessionId = sessionNewSchema.parse(value).sessionId })
      const side: Connection = { rpc: writer, nonce: '', clientRevision: this.clientRevision, mode: 'approval-required', watcher: false, closing: false, model: undefined, effort: undefined, replay: undefined, commands: undefined }
      await this.applySettings(alias, side, writer, sessionId, alias.modelId, leastEffort(this.model(alias.modelId)))
      await writer.request('session/set_config_option', { sessionId, configId: 'mode', value: 'ask' })
      let ended = ''
      await writer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${prompt.instruction}\n\n${prompt.material}` }] }, value => { ended = promptAnswerSchema.parse(value).stopReason }, true)
      if (tooled || ended !== 'end_turn') return null
      return text.trim() || null
    } catch (error) {
      if (signal?.aborted) return null
      throw new Error('Cursor could not write this text. Nothing else changed.', { cause: error })
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); writer.close() }
  }

  // ---- Disconnecting -------------------------------------------------------------------------------------------------

  disconnect(): void {
    this.generation++; this.reaper.dispose()
    // Nothing the user did not answer is approved: every waiting request is declined on its way out.
    for (const pending of this.pending.values()) if (!pending.answering) {
      try { pending.connection.rpc.write({ jsonrpc: '2.0', id: pending.wireId, result: cursorDecline(pending) }) } catch { /* A closed pipe grants nothing. */ }
    }
    this.pending.clear()
    for (const id of this.turns.keys()) this.endTurn(id, 'interrupted')
    this.turns.clear()
    for (const thread of this.threads.values()) thread.requests = []
    for (const connection of this.connections.values()) this.close(connection)
    for (const rpc of this.processes) rpc.close()
    this.connections.clear(); this.loading.clear(); this.loaded.clear(); this.outdated.clear()
    this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> { await Promise.all([...this.processes].map(rpc => rpc.closed)); await Promise.all([...this.stopping.values()].map(work => work.catch(() => undefined))); await this.writing }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
/** The skills the words start with, as typed, with the space after them: `/name` for any of the names given, one after another. */
export function leadingSkills(text: string, names: readonly string[]): string {
  if (!names.length) return ''
  const tokens = [...new Set(names)].map(name => escapeRegExp(`/${name}`)).join('|')
  return new RegExp(`^(?:\\s*(?:${tokens})(?=\\s|$))+\\s*`, 'u').exec(text)?.[0] ?? ''
}

/** Cursor's listed commands as Sotto's skills: each one is invoked as `/name`. "(global)" in a description marks the user's own. */
function cursorSkills(commands: z.infer<typeof commandsSchema>): AgentSkillCatalog['skills'] {
  return commands.map(command => ({ name: command.name, path: `cursor:/${command.name}`, description: command.description ?? '',
    scope: /\(global\)\s*$/u.test(command.description ?? '') ? 'user' as const : 'system' as const, enabled: true, userInvocable: true, invocation: `/${command.name}`, nativeSource: 'cursor' }))
}
