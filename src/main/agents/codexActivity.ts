import { picturesIn, rasterTypeOf, type MediaCapture, type MediaFileCapture } from './threadMedia'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MAX_ACTIVITY_TEXT, MAX_AGENT_ACTIVITIES, REASONING_SUMMARY_TITLE, compactAgentIdentity, wordlessReasoningSummary, mergeAgentActivities, isTerminalActivity, planSteps, type AgentActivity, type ObservedAgent } from '../../shared/agentActivity'
import type { AgentThread } from '../../shared/agents'
type ActivityConversation = Pick<AgentThread, 'id' | 'messages' | 'activities'> & { runtimeMode?: AgentThread['runtimeMode'] }

// Display fields selected from installed codex-cli 0.154.0's generated schema; `subAgentActivity` from 0.162.1's.
// Only displayable fields survive this
// boundary; reasoning.content, encrypted content and raw protocol objects do not.
const displayFields: Readonly<Record<string, readonly string[]>> = {
  userMessage: ['clientId', 'content'], agentMessage: ['text'],
  commandExecution: ['command', 'cwd', 'aggregatedOutput', 'exitCode'],
  fileChange: ['changes'], mcpToolCall: ['server', 'tool', 'result', 'error'],
  dynamicToolCall: ['tool', 'contentItems'], reasoning: ['summary'], plan: ['text'],
  collabAgentToolCall: ['tool', 'prompt', 'model', 'senderThreadId', 'receiverThreadIds', 'agentsStates'],
  subAgentActivity: ['kind', 'agentThreadId', 'agentPath', 'model'],
  webSearch: ['query'], contextCompaction: [],
  imageGeneration: ['result', 'savedPath', 'revisedPrompt', 'failure'],
}
/**
 * Codex's Computer Use runs as MCP tool calls: `cua_repl`, or the general `node_repl` JavaScript tool with its
 * `@oai/sky` library, which the computer-use skill imports on its first call and uses as `sky` after. The item
 * carries no surface marker of its own (codex app-server 0.157.0), so this reads the server and the code.
 */
function isComputerUse(server: unknown, args: unknown): boolean {
  if (server === 'cua_repl') return true
  if (server !== 'node_repl') return false
  const code = typeof args === 'object' && args !== null ? (args as { code?: unknown }).code : undefined
  return typeof code === 'string' && /@oai\/sky|(?<![\w.$])sky\.\w+\(/u.test(code)
}
/**
 * What Sotto can say about a Computer Use call that failed for a reason it recognises: Codex's sandbox stopped
 * it, or the connection to the Codex app helper is unavailable. A missing native pipe does not establish
 * that the app is closed: a running app may have restarted and replaced its pipe. The
 * sandbox texts are Windows Codex's own; "trusted Node process exited" also names other crashes, so it counts as
 * the sandbox's doing only outside Full access, where the advice to switch can be right.
 */
export function computerUseNeeds(text: string | undefined, sandboxed: boolean): string | undefined {
  if (!text) return undefined
  if (/windows sandbox failed/iu.test(text) || sandboxed && /trusted Node process exited unexpectedly/iu.test(text)) return 'Computer Use cannot run in this thread\'s sandbox. Nothing was changed. Switch the thread to Full access to use it.'
  if (/native pipe/iu.test(text)) return 'Computer Use connection is unavailable. Open Codex if it is closed. Keep it open and try again. If this continues, restart Sotto when your other threads are idle.'
  return undefined
}
export const codexItemSchema = z.preprocess(value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const item = value as Record<string, unknown>
  const fields = typeof item.type === 'string' && Object.hasOwn(displayFields, item.type) ? displayFields[item.type] : undefined
  // Native item variants reuse field names with different shapes (imageGeneration.result
  // is a string). Unsupported presentation must not break the shared transport or retain its payload.
  const keys = fields === undefined ? ['id', 'type'] : ['id', 'type', 'status', 'durationMs', ...fields]
  const kept: Record<string, unknown> = Object.fromEntries(keys.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]))
  // A generated image's `result` is its base64 bytes, read once for its handle (ADR-0170) under a name of its own.
  if (item.type === 'imageGeneration' && Object.hasOwn(kept, 'result')) {
    if (typeof kept.result === 'string' && kept.result) kept.imageData = kept.result
    delete kept.result
  }
  // The call's arguments are not kept; only whether it is Codex's Computer Use survives.
  return item.type === 'mcpToolCall' && isComputerUse(item.server, item.arguments) ? { ...kept, computerUse: true } : kept
}, z.object({
  id: z.string(), type: z.string(), clientId: z.string().nullish(), text: z.string().optional(),
  content: z.unknown().optional(), status: z.string().optional(), summary: z.array(z.string()).optional(),
  command: z.string().optional(), cwd: z.string().optional(), aggregatedOutput: z.string().nullish(),
  exitCode: z.number().int().nullish(), durationMs: z.number().nonnegative().nullish(),
  changes: z.array(z.object({ path: z.string(), kind: z.object({ type: z.string() }).optional(), diff: z.string().optional() })).optional(),
  tool: z.string().optional(), server: z.string().optional(), prompt: z.string().nullish(),
  receiverThreadIds: z.array(z.string()).optional(), senderThreadId: z.string().optional(), model: z.string().nullish(),
  agentsStates: z.record(z.string(), z.object({ status: z.string(), message: z.string().nullish() })).optional(),
  result: z.object({ content: z.array(z.unknown()).optional() }).nullish(),
  contentItems: z.array(z.unknown()).nullish(), error: z.object({ message: z.string() }).nullish(),
  query: z.string().optional(), computerUse: z.literal(true).optional(),
  kind: z.string().optional(), agentThreadId: z.string().optional(), agentPath: z.string().optional(),
  imageData: z.string().optional(), savedPath: z.string().nullish(), revisedPrompt: z.string().nullish(),
  failure: z.object({ type: z.string() }).nullish().catch(null),
}))
type Item = z.infer<typeof codexItemSchema>
/**
 * A sub-agent's own notifications, parsed for every one Codex sends while sub-agents work. Built once here: a zod schema
 * built per notification cost main 1.4 s a minute (October 2026), and `zodSchemaSites.test.ts` keeps it that way.
 */
const childItemNotificationSchema = z.object({ turnId: z.string(), item: codexItemSchema, startedAtMs: z.number().nullish(), completedAtMs: z.number().nullish() })
const childTurnNotificationSchema = z.object({ turn: z.object({ id: z.string().optional(), status: z.string(), startedAt: z.number().nullish(), completedAt: z.number().nullish(), durationMs: z.number().nonnegative().nullish(), error: z.object({ message: z.string() }).nullish() }).optional(), status: z.object({ type: z.string() }).optional() })
/** One agent as a conversation observed it: where it was last reported, and its compact identity. */
type Child = { thread: ActivityConversation; turnId: string; activityId: string; agent: ObservedAgent; path?: string }
type Context = { turnId: string; afterMessageId?: string | undefined; phase: 'started' | 'completed' | 'history'; startedAtMs?: number | undefined; completedAtMs?: number | undefined; terminal?: boolean | undefined }
const opaque = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const codexActivityId = (turnId: string, itemId: string): string => `codex-activity-${opaque(turnId, itemId)}`
const agentId = (id: string): string => `codex-agent-${opaque(id)}`
/** How many of one agent's assignments a conversation remembers having opened, so a reread recognises them. */
const OPENED_KEPT = 200
/** How many messages held live a conversation remembers the time of. */
const MESSAGES_TIMED = 200
/** Multi-agent v2 addresses agents by path: `/root` is the thread Sotto drives and `/root/review/tests` a child of `review`. */
const ROOT_PATH = '/root'
const parentPath = (path: string): string => path.slice(0, path.lastIndexOf('/')) || ROOT_PATH
const iso = (ms: number | undefined): string | undefined => ms !== undefined && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined
const mappedStatus = (status: string | undefined, fallback: AgentActivity['status']): AgentActivity['status'] =>
  status === 'inProgress' || status === 'running' || status === 'pendingInit' ? 'running'
    : status === 'completed' ? 'completed' : status === 'failed' || status === 'errored' || status === 'declined' || status === 'notFound' ? 'failed'
      : status === 'interrupted' || status === 'shutdown' ? 'interrupted' : fallback
const textPartSchema = z.object({ type: z.enum(['text', 'inputText', 'input_text']), text: z.string() })
const contentText = (value: unknown[] | null | undefined): string | undefined => {
  if (!value) return undefined
  return value.flatMap(part => {
    const parsed = textPartSchema.safeParse(part)
    return parsed.success ? [parsed.data.text] : []
  }).join('\n')
}

/** Observational native activity. Never sends commands, reads child transcripts or creates threads. */
export class CodexActivityProjection {
  private readonly summaries = new Map<string, Map<number, string>>()
  /**
   * Each conversation's agents, by native thread ID. A fork carries its source's history, which names the source's agents
   * too (#1028), so an agent is looked up in the conversation that is reading it, never in another.
   */
  private readonly agentsOf = new WeakMap<ActivityConversation, Map<string, Child>>()
  /**
   * The conversation each native agent's own notifications reach: the first to see it, or the one that saw it live. A
   * fork that reads its source's history later does not take the source's agents from it.
   */
  private readonly owners = new Map<string, Child>()
  /** Multi-agent v2 agent paths to native child thread IDs, per conversation, so a nested agent finds its parent. */
  private readonly paths = new WeakMap<ActivityConversation, Map<string, string>>()
  /**
   * Native agents whose own thread has a turn running, from their own notifications: started, until it ends or the
   * conversation's runtime does. Kept by the conversation those notifications reach, so a fork reading its source's
   * history never takes the source's live work for its own.
   */
  private readonly working = new WeakMap<ActivityConversation, Set<string>>()
  /**
   * A message to a finished multi-agent v2 agent, per conversation and native ID, not yet shown to be work: when it came,
   * and how. The newest one waits; the agent's own turn starting, or a later completion in the same conversation's items,
   * makes it the agent's next assignment (#1261).
   */
  private readonly messaged = new WeakMap<ActivityConversation, Map<string, { item: Item; context: Context; senderPath: string; at?: number }>>()
  /**
   * The multi-agent v2 assignments each conversation has opened live, by native agent ID, newest last and at most
   * OPENED_KEPT each: a reread of that conversation's history recognises one by these even once its record has left the
   * bounded activity window (#1261). A history read adds none, so replaying old assignments never pushes out new ones.
   */
  private readonly opened = new WeakMap<ActivityConversation, Map<string, Set<string>>>()
  /**
   * When each message held live came, by its item's activity ID, per conversation, the newest MESSAGES_TIMED kept: however
   * often history is read again before the agent starts, its assignment is timed from the message.
   */
  private readonly messageTimes = new WeakMap<ActivityConversation, Map<string, number>>()
  private readonly terminalTurns = new WeakMap<ActivityConversation, Set<string>>()
  private readonly seen = new WeakMap<ActivityConversation, Set<string>>()
  private readonly turnAnchors = new WeakMap<ActivityConversation, Map<string, string>>()
  /** The array `put` last installed on each thread. While the thread still holds it, it is in sequence order with one record per ID. */
  private readonly installed = new WeakMap<ActivityConversation, readonly AgentActivity[]>()
  /**
   * `capture` keeps a tool result's pictures in the thread media store and answers their handles (ADR-0170); absent while
   * the `inline-media` Owl feature is off, when a row carries none.
   */
  /**
   * Generated images whose saved file is being read, by thread and activity, so a replay meanwhile reads it no second
   * time, while a fork reading the same item reads its own.
   */
  private readonly reading = new Set<string>()
  /**
   * `capture` keeps a tool result's or a generated image's pictures (ADR-0170); `captureFile` reads one Codex saved to a
   * file, after which `changed` names the thread whose record gained it.
   */
  constructor(private readonly now: () => number = Date.now, private readonly capture?: MediaCapture,
    private readonly captureFile?: MediaFileCapture, private readonly changed?: (threadId: string) => void) {}

  anchor(thread: ActivityConversation, turnId: string, messageId: string): void {
    const anchors = this.turnAnchors.get(thread) ?? new Map<string, string>()
    if (anchors.has(turnId)) return
    anchors.set(turnId, messageId); this.turnAnchors.set(thread, anchors)
    // Hash the turn's activity ID once, not once for every record the search passes (#352).
    const turnActivityId = codexActivityId(turnId, '$turn')
    const record = thread.activities?.find(activity => activity.id === turnActivityId)
    if (record) this.put(thread, { ...record, afterMessageId: messageId })
  }

  private put(thread: ActivityConversation, activity: AgentActivity): void {
    const previous = thread.activities?.find(record => record.id === activity.id)
    const seen = this.seen.get(thread) ?? new Set<string>()
    // Keep tiny tombstones for evicted entries: rereading old native history
    // must not append the discarded prefix after the retained recent work.
    if (!previous && seen.has(activity.id)) return
    seen.add(activity.id); this.seen.set(thread, seen)
    activity = { ...previous, ...activity }
    let remaining = MAX_ACTIVITY_TEXT
    const bounded = (value: string): string => {
      const kept = value.slice(0, remaining); remaining -= kept.length
      if (kept.length < value.length) activity.truncated = true
      return kept
    }
    // Child lifecycle metadata survives detail truncation. Reserve its task/result before duplicate tool text.
    if (activity.agents) {
      if (activity.agents.length > 200) activity.truncated = true
      activity.agents = activity.agents.slice(0, 200).map(agent => {
        const result = { ...agent, status: agent.status.slice(0, 128),
          ...(agent.title !== undefined ? { title: agent.title.slice(0, 240) } : {}),
          ...(agent.model !== undefined ? { model: agent.model.slice(0, 512) } : {}),
        }
        for (const key of ['message', 'description', 'prompt'] as const) {
          if (result[key] !== undefined) result[key] = bounded(result[key]!)
        }
        return result
      })
    }
    // One total detail budget per record, including file diffs and tool output.
    for (const key of ['title', 'command', 'cwd', 'text', 'error', 'output'] as const) {
      if (activity[key] !== undefined) activity[key] = bounded(activity[key]!)
    }
    if (activity.changes) {
      if (activity.changes.length > 200) activity.truncated = true
      activity.changes = activity.changes.slice(0, 200).map(change => ({ path: bounded(change.path), kind: bounded(change.kind), ...(change.diff !== undefined ? { diff: bounded(change.diff) } : {}) }))
    }

    thread.activities = this.merged(thread, activity)
    this.installed.set(thread, thread.activities)
  }

  /**
   * `mergeAgentActivities(thread.activities, [activity])`. When the thread still holds the array `put` last
   * installed, that array is already the merge's output, so one record is placed without rebuilding and
   * re-sorting all of it: a whole read puts every item of every turn, and rebuilding it each time made applying
   * a long thread's activity grow with the square of the thread (#352). An array anything else installed takes
   * the full merge.
   */
  private merged(thread: ActivityConversation, activity: AgentActivity): AgentActivity[] {
    const current = thread.activities
    if (!current || this.installed.get(thread) !== current) return mergeAgentActivities(current, [activity])
    const index = current.findIndex(record => record.id === activity.id)
    if (index >= 0) {
      // The full merge's rule for a record it already holds, which keeps the record's place in the sequence.
      const next = current.slice(); next[index] = mergeAgentActivities([current[index]!], [activity])[0]!
      return next
    }
    const next = [...current, { ...activity, sequence: (current.at(-1)?.sequence ?? -1) + 1 }]
    if (next.length <= MAX_AGENT_ACTIVITIES) return next
    const bounded = next.slice(-MAX_AGENT_ACTIVITIES)
    bounded[0] = { ...bounded[0]!, truncated: true }
    return bounded
  }

  /**
   * A finished generated image's picture (ADR-0170): its bytes when the item carries them, else the file Codex saved it
   * to, read off the update path and added to the record when it lands. A record that holds it already reads nothing.
   */
  private generated(thread: ActivityConversation, activity: AgentActivity, previous: AgentActivity | undefined, item: Item): void {
    if (previous?.media) { activity.media = previous.media; return }
    if (!this.capture) return
    const mimeType = item.imageData ? rasterTypeOf(Buffer.from(item.imageData.slice(0, 24), 'base64')) : undefined
    const media = item.imageData && mimeType ? this.capture([{ mimeType, data: item.imageData }], 'generated') : []
    if (media.length) { activity.media = media; return }
    const path = item.savedPath
    const key = `${thread.id}\n${activity.id}`
    if (!path || !this.captureFile || this.reading.has(key)) return
    this.reading.add(key)
    void this.captureFile(path, 'generated').then(found => {
      const current = thread.activities?.find(record => record.id === activity.id)
      if (!found.length || !current || current.media) return
      this.put(thread, { ...current, media: found })
      this.changed?.(thread.id)
    }).catch(() => undefined).finally(() => this.reading.delete(key))
  }

  item(thread: ActivityConversation, item: Item, context: Context, senderPath = ROOT_PATH): void {
    if (item.type === 'subAgentActivity') { this.subAgentActivity(thread, item, context, senderPath); return }
    const kinds: Record<string, [AgentActivity['kind'], string]> = {
      commandExecution: ['command', 'Command'], fileChange: ['file-change', 'File changes'],
      mcpToolCall: ['tool', item.computerUse ? 'Computer Use' : [item.server, item.tool].filter(Boolean).join(' / ') || 'Tool'],
      dynamicToolCall: ['tool', item.tool ?? 'Tool'], reasoning: ['reasoning', REASONING_SUMMARY_TITLE],
      plan: ['plan', 'Plan'], collabAgentToolCall: ['subagent', item.tool ?? 'Subagent'],
      webSearch: ['tool', 'Web search'], contextCompaction: ['compaction', 'Context compacted'],
      // A generated image is a step only while its picture can be kept (ADR-0170): `inline-media` gives the capture.
      ...this.capture ? { imageGeneration: ['tool', item.revisedPrompt?.trim() ? `Image: ${item.revisedPrompt.trim().split(/\r?\n/u)[0]}` : 'Image'] as [AgentActivity['kind'], string] } : {},
    }
    const kind = kinds[item.type]
    if (!kind) return
    const id = codexActivityId(context.turnId, item.id)
    const previous = thread.activities?.find(record => record.id === id)
    // Reasoning with no summary words has nothing to show (`wordlessReasoningSummary`), and each would be an empty
    // row holding a place in the bounded list. A row an earlier read kept for one goes here; the workspace drops its
    // own saved copy when it next merges. Streamed words make the row (`delta`).
    const summarized = item.type === 'reasoning' && !!item.summary?.some(part => part.trim())
    if (item.type === 'reasoning' && !summarized && (!previous || wordlessReasoningSummary(previous))) {
      if (previous) {
        const ordered = this.installed.get(thread) === thread.activities
        thread.activities = thread.activities!.filter(record => record !== previous)
        if (ordered) this.installed.set(thread, thread.activities)
      }
      return
    }
    const status = mappedStatus(item.status, context.phase === 'started' ? 'running' : context.phase === 'completed' || context.terminal ? 'completed' : 'unknown')
    if (this.terminalTurns.get(thread)?.has(context.turnId) && status === 'running') return
    if (previous && isTerminalActivity(previous.status) && !isTerminalActivity(status)) return
    const activity: AgentActivity = { id, turnId: context.turnId, sequence: 0, kind: kind[0], title: kind[1], status,
      ...(context.afterMessageId ? { afterMessageId: context.afterMessageId } : {}),
    }
    const startedAt = iso(context.startedAtMs) ?? (context.phase === 'started' ? iso(this.now()) : undefined)
    const completedAt = previous?.completedAt ?? iso(context.completedAtMs) ?? (context.phase === 'completed' ? iso(this.now()) : undefined)
    if (startedAt) { activity.startedAt = startedAt; activity.timingSource = context.startedAtMs === undefined ? 'observed' : 'provider' }
    if (completedAt) activity.completedAt = completedAt
    if (item.durationMs != null) activity.durationMs = item.durationMs
    else if (completedAt && (previous?.startedAt ?? startedAt)) activity.durationMs = Math.max(0, Date.parse(completedAt) - Date.parse((previous?.startedAt ?? startedAt)!))
    if (item.command !== undefined) activity.command = item.command
    if (item.cwd !== undefined) activity.cwd = item.cwd
    if (item.aggregatedOutput != null) activity.output = item.aggregatedOutput
    if (item.exitCode != null) activity.exitCode = item.exitCode
    if (item.error) activity.error = item.error.message
    if (item.changes) activity.changes = item.changes.map(change => ({ path: change.path, kind: change.kind?.type ?? 'change', ...(change.diff !== undefined ? { diff: change.diff } : {}) }))
    if (summarized) activity.text = item.summary!.join('\n\n')
    if (item.type === 'plan') activity.text = item.text ?? ''
    if (item.type === 'webSearch') activity.text = item.query
    const output = contentText(item.result?.content ?? item.contentItems)
    if (output !== undefined) activity.output = output
    // A finished tool's pictures (ADR-0170). A row that already holds them keeps them, so a replay hashes nothing again.
    if (this.capture && (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') && status !== 'running') {
      const media = previous?.media ?? this.capture(picturesIn(item.result?.content ?? item.contentItems), 'tool')
      if (media.length) activity.media = media
    }
    if (item.type === 'imageGeneration') {
      activity.generates = 'image'
      if (status === 'failed' && item.failure) activity.error = item.failure.type === 'usageLimitExceeded'
        ? 'Codex reached its image limit, so no image was made. Try again when the limit resets.' : 'Codex could not make the image. Ask for it again to try once more.'
      if (status === 'completed') this.generated(thread, activity, previous, item)
    }
    // A Computer Use call that failed for a known reason says what to do, above Codex's own words.
    const needs = item.computerUse ? computerUseNeeds([item.error?.message, output].filter(Boolean).join('\n'), thread.runtimeMode !== 'full-access') : undefined
    if (needs) activity.error = [needs, item.error?.message].filter(Boolean).join('\n')
    if (item.type === 'collabAgentToolCall') {
      if (item.prompt != null) activity.text = item.prompt
      const ids = [...new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])]
      const assignment = item.tool === 'spawnAgent' || (item.tool === 'sendInput' && item.prompt != null)
      activity.agents = ids.map(child => {
        const owner = this.child(thread, child)
        const prior = previous?.agents?.find(agent => agent.id === agentId(child)) ?? owner?.agent
        const assignmentId = assignment ? id : prior?.assignmentId
        const sameAssignment = prior?.assignmentId === assignmentId
        const childStatus = item.agentsStates?.[child]?.status ?? (assignment ? 'running' : prior?.status ?? 'unknown')
        // These timestamps describe observation of the child, never the duration of its spawn/wait tool.
        const observedAt = context.phase === 'history' ? prior?.observedAt : iso(this.now())
        const agent: ObservedAgent = { ...(sameAssignment ? prior : {}), id: agentId(child), status: childStatus,
          ...(assignmentId ? { assignmentId } : {}),
          ...(item.senderThreadId && this.child(thread, item.senderThreadId) ? { parentId: agentId(item.senderThreadId) } : {}),
          ...(assignment && item.prompt != null ? { prompt: item.prompt, title: item.prompt.split(/\r?\n/u)[0]!.slice(0, 1_000) } : {}),
          ...(assignment && item.model ? { model: item.model } : {}),
          ...(observedAt ? { observedAt } : {}),
          ...(assignment && (!sameAssignment || !prior?.startedAt) && observedAt ? { startedAt: observedAt, timingSource: 'observed' as const } : {}),
          ...(item.agentsStates?.[child]?.message != null ? { message: item.agentsStates[child]!.message! } : {}),
          ...(isTerminalActivity(mappedStatus(childStatus, 'unknown')) && observedAt ? { completedAt: sameAssignment && prior?.completedAt ? prior.completedAt : observedAt } : {}),
        }
        this.setChild(thread, child, { thread, turnId: context.turnId, activityId: id, agent: compactAgentIdentity(agent) }, context.phase !== 'history')
        return agent
      })
    }
    this.put(thread, activity)
    if (isTerminalActivity(status)) this.summaries.delete(id)
  }

  /**
   * Multi-agent v2 (codex-cli 0.162) reports each agent's life as `subAgentActivity` items instead of spawn and wait
   * tool calls: `started` once, then `interacted` when an agent sends it a message or a follow-up task, and `completed`
   * or `interrupted` each time it finishes. Every item for one assignment folds into one record in the turn the
   * assignment began, so a busy agent does not fill the bounded activity window. The task name the parent gave it is
   * its title; its task words reach Codex encrypted and are never seen. Items naming the reporting agent or one of its
   * ancestors are its own replies upward, not work it started. `held` is a message an agent was sent once it had finished,
   * shown since to have started work, with when it came; `live` when the agent's own turn starting showed it.
   */
  private subAgentActivity(thread: ActivityConversation, item: Item, context: Context, senderPath: string, held?: { readonly at: number | undefined; readonly live?: boolean }): void {
    const child = item.agentThreadId, path = item.agentPath
    if (!child || !path || !path.startsWith(`${ROOT_PATH}/`) || `${senderPath}/`.startsWith(`${path}/`)) return
    const status = item.kind === 'started' || item.kind === 'interacted' ? 'running' : item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'interrupted' : undefined
    if (!status) return
    if (!held) {
      // An agent that completes again after a message it was sent once finished ran a turn for it: that message is the
      // assignment this ends. A start or a newer message replaces a waiting one. A history read is in its own order, so
      // its items act only on a message it held itself: one held live waits for live evidence, and a reread's earlier
      // items come before it.
      const waiting = this.messaged.get(thread)?.get(child)
      if (waiting && (context.phase !== 'history' || waiting.context.phase === 'history')) {
        this.messaged.get(thread)!.delete(child)
        if (status !== 'running') this.subAgentActivity(thread, waiting.item, waiting.context, waiting.senderPath, { at: waiting.at })
      }
      if (status !== 'running' && context.phase !== 'history') this.working.get(thread)?.delete(child)
    }
    const paths = this.paths.get(thread) ?? new Map<string, string>()
    paths.set(path, child); this.paths.set(thread, paths)
    const prior = this.child(thread, child)?.agent
    const itemActivityId = codexActivityId(context.turnId, item.id)
    const priorFinished = !!prior && isTerminalActivity(mappedStatus(prior.status, 'unknown'))
    // The same item reported again, started and then completed, is the same assignment. Arriving after the agent
    // finished, it cannot make the agent working again, or the work handed to it next would not read as new.
    if (prior?.assignmentId === itemActivityId && status === 'running' && priorFinished) return
    // A message to an agent that has finished is no work by itself. Codex reports send_message, which leaves it in the
    // agent's mail, and followup_task, which also starts the agent's turn, both as `interacted` (codex-cli 0.163). It
    // waits until the agent is seen working: its own turn starting, as a follow-up's does at once, or a later completion.
    // One that starts nothing leaves the agent finished, so its parent's turn is not held for work that never began (#1261).
    // History says only what its items say: the agent's live state is evidence for a live item alone, and only in the
    // conversation its notifications reach.
    const working = context.phase !== 'history' && this.owners.get(child)?.thread === thread && this.working.get(thread)?.has(child) === true
    // A message this conversation already opened as one of the agent's assignments was shown to be work when it came: a
    // reread of the same history takes it as that assignment again, so its later completion ends it and not the one before.
    if (!held && item.kind === 'interacted' && priorFinished && !working && this.opened.get(thread)?.get(child)?.has(itemActivityId) !== true) {
      const waiting = this.messaged.get(thread) ?? new Map<string, { item: Item; context: Context; senderPath: string; at?: number }>()
      const existing = waiting.get(child)
      // A history read never replaces a message held live with an older one. Reaching that same message, it takes the
      // message over, keeping when it came, so the history's own later completion can end it, as after a runtime ended.
      if (context.phase === 'history' && existing && existing.context.phase !== 'history') {
        if (existing.item.id === item.id) waiting.set(child, { ...existing, context })
      } else {
        const times = this.messageTimes.get(thread) ?? new Map<string, number>()
        if (context.phase !== 'history') {
          times.delete(itemActivityId); times.set(itemActivityId, this.now())
          while (times.size > MESSAGES_TIMED) times.delete(times.keys().next().value!)
          this.messageTimes.set(thread, times)
        }
        const at = times.get(itemActivityId)
        waiting.set(child, { item, context, senderPath, ...at !== undefined ? { at } : {} })
      }
      this.messaged.set(thread, waiting)
      return
    }
    // A start, or work handed to an agent that had finished, is a new assignment; a message to a working agent is not.
    const assignment = prior?.assignmentId !== itemActivityId && (item.kind === 'started' || status === 'running' && (!prior?.assignmentId || priorFinished))
    const assignmentId = assignment || !prior?.assignmentId ? itemActivityId : prior.assignmentId
    if (assignment && (context.phase !== 'history' || held?.live === true)) {
      const opened = this.opened.get(thread) ?? new Map<string, Set<string>>(), ids = opened.get(child) ?? new Set<string>()
      ids.delete(assignmentId); ids.add(assignmentId)
      while (ids.size > OPENED_KEPT) ids.delete(ids.values().next().value!)
      opened.set(child, ids); this.opened.set(thread, opened)
    }
    const record = thread.activities?.find(activity => activity.id === assignmentId)
    // An assignment whose record left the bounded window still reports, under a record of its own.
    const id = record || !this.seen.get(thread)?.has(assignmentId) ? assignmentId : itemActivityId
    // History names no times. A reread keeps the times this assignment's record already holds, not the agent's latest.
    const recorded = record?.agents?.find(agent => agent.id === agentId(child))
    const observedAt = held ? iso(held.at) : context.phase === 'history' ? undefined : iso(this.now())
    const parent = paths.get(parentPath(path))
    const title = path.slice(path.lastIndexOf('/') + 1)
    const model = item.model ?? prior?.model
    const agent: ObservedAgent = { ...(recorded ?? (assignment ? {} : prior)), id: agentId(child), status, title, assignmentId,
      ...(parent ? { parentId: agentId(parent) } : {}),
      ...(model ? { model } : {}),
      ...(observedAt ? { observedAt } : {}),
      ...(assignment && observedAt ? { startedAt: observedAt, timingSource: 'observed' as const } : {}),
      ...(isTerminalActivity(status) && observedAt ? { completedAt: !assignment && prior?.completedAt ? prior.completedAt : observedAt } : {}),
    }
    this.setChild(thread, child, { thread, turnId: context.turnId, activityId: id, agent: compactAgentIdentity(agent), path }, context.phase !== 'history')
    this.put(thread, { id, turnId: record?.turnId ?? context.turnId, sequence: 0, kind: 'subagent', title, status,
      ...(context.afterMessageId ? { afterMessageId: context.afterMessageId } : {}),
      ...(observedAt && !record ? { startedAt: observedAt, timingSource: 'observed' as const } : {}),
      ...(isTerminalActivity(status) && observedAt ? { completedAt: observedAt } : {}),
      agents: [agent] })
  }

  delta(thread: ActivityConversation, method: string, params: { turnId?: string | undefined; itemId?: string | undefined; delta?: string | undefined; summaryIndex?: number | undefined; message?: string | undefined }): void {
    if (!params.turnId || !params.itemId) return
    if (this.terminalTurns.get(thread)?.has(params.turnId)) return
    const id = codexActivityId(params.turnId, params.itemId)
    const previous = thread.activities?.find(record => record.id === id)
    if (previous && isTerminalActivity(previous.status)) return
    const kind = method === 'item/reasoning/summaryTextDelta' ? 'reasoning' : method === 'item/plan/delta' ? 'plan'
      : method === 'item/fileChange/outputDelta' ? 'file-change' : method === 'item/mcpToolCall/progress' ? 'tool' : 'command'
    const record: AgentActivity = { id, turnId: params.turnId, sequence: 0, kind, title: kind === 'reasoning' ? REASONING_SUMMARY_TITLE : kind === 'plan' ? 'Plan' : kind === 'tool' ? 'Tool' : kind === 'file-change' ? 'File changes' : 'Command',
      status: 'running', afterMessageId: thread.messages.at(-1)?.id,
      // Reasoning's row starts with its first words, since the item that opened it had none.
      ...(kind === 'reasoning' && !previous ? { startedAt: iso(this.now())!, timingSource: 'observed' as const } : {}), ...previous }
    if (method === 'item/reasoning/summaryTextDelta') {
      const index = params.summaryIndex
      if (index === undefined || !Number.isInteger(index) || index < 0 || index >= 200) return
      const parts = this.summaries.get(id) ?? new Map<number, string>()
      parts.set(index, ((parts.get(index) ?? '') + (params.delta ?? '')).slice(0, MAX_ACTIVITY_TEXT))
      this.summaries.set(id, parts)
      record.text = [...parts].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n\n')
      if (!record.text.trim() && !previous) return
    } else if (method === 'item/mcpToolCall/progress') record.text = params.message
    else if (kind === 'plan') record.text = (record.text ?? '') + (params.delta ?? '')
    else record.output = (record.output ?? '') + (params.delta ?? '')
    this.put(thread, record)
  }

  turn(thread: ActivityConversation, turn: { id: string; status: string; startedAt?: number | null | undefined; completedAt?: number | null | undefined; durationMs?: number | null | undefined; error?: { message: string } | null | undefined }, live = false): void {
    const id = codexActivityId(turn.id, '$turn')
    const previous = thread.activities?.find(record => record.id === id)
    const status = mappedStatus(turn.status, 'unknown')
    const startedAt = iso(turn.startedAt == null ? undefined : turn.startedAt * 1000) ?? previous?.startedAt ?? (live && status === 'running' ? iso(this.now()) : undefined)
    const completedAt = iso(turn.completedAt == null ? undefined : turn.completedAt * 1000) ?? (live && isTerminalActivity(status) ? iso(this.now()) : undefined)
    this.put(thread, { id, turnId: turn.id, sequence: 0, kind: 'turn', title: status === 'running' ? 'Working' : status === 'failed' ? 'Turn failed' : status === 'interrupted' ? 'Turn interrupted' : 'Turn completed', status,
      ...(this.turnAnchors.get(thread)?.get(turn.id) ? { afterMessageId: this.turnAnchors.get(thread)!.get(turn.id)! } : {}),
      ...(startedAt ? { startedAt, timingSource: turn.startedAt == null ? previous?.timingSource ?? 'observed' : 'provider' } : {}),
      ...(completedAt ? { completedAt } : {}), ...(turn.durationMs != null ? { durationMs: turn.durationMs } : {}), ...(turn.error ? { error: turn.error.message } : {}),
    })
    if (isTerminalActivity(status)) {
      const terminal = this.terminalTurns.get(thread) ?? new Set<string>()
      terminal.add(turn.id); this.terminalTurns.set(thread, terminal)
      for (const record of thread.activities ?? []) if (record.turnId === turn.id && record.status === 'running') {
        // A completed turn does not prove an unacknowledged tool succeeded.
        this.put(thread, { ...record, status: status === 'completed' ? 'unknown' : status })
        this.summaries.delete(record.id)
      }
    }
  }

  plan(thread: ActivityConversation, turnId: string, plan: { step: string; status: string }[], explanation?: string | null): void {
    if (this.terminalTurns.get(thread)?.has(turnId)) return
    this.put(thread, { id: codexActivityId(turnId, '$plan'), turnId, sequence: 0, kind: 'plan', title: 'Plan', status: 'running',
      afterMessageId: thread.messages.at(-1)?.id, steps: planSteps(plan.map(step => ({ text: step.step, status: step.status }))),
      ...(explanation ? { text: explanation } : {}) })
  }

  error(thread: ActivityConversation, turnId: string, message: string, willRetry: boolean): void {
    this.put(thread, { id: codexActivityId(turnId, `$error:${opaque(message)}`), turnId, sequence: 0, kind: 'status',
      title: willRetry ? 'Codex is retrying' : 'Codex error', status: 'failed', error: message, afterMessageId: thread.messages.at(-1)?.id })
  }

  /**
   * This conversation's runtime ended: what its agents' own notifications said of them is no longer live, so none of them
   * is taken as working from it. A message one was sent after it finished then waits for a completion, as history's does.
   */
  runtimeEnded(thread: ActivityConversation): void { this.working.delete(thread) }

  /** The native thread of one of this conversation's agents, by its roster identity (#1028); undefined when its history names none. */
  agentThread(thread: ActivityConversation, id: string): string | undefined {
    for (const native of this.agentsOf.get(thread)?.keys() ?? []) if (agentId(native) === id) return native
    return undefined
  }
  private child(thread: ActivityConversation, native: string): Child | undefined { return this.agentsOf.get(thread)?.get(native) }
  private setChild(thread: ActivityConversation, native: string, entry: Child, live: boolean): void {
    const own = this.agentsOf.get(thread) ?? new Map<string, Child>()
    own.set(native, entry); this.agentsOf.set(thread, own)
    const owner = this.owners.get(native)
    if (!owner || owner.thread === thread || live) this.owners.set(native, entry)
  }

  childNotification(child: string, method: string, params: unknown): ActivityConversation | undefined {
    let owner = this.owners.get(child)
    if (!owner) return undefined
    if (method === 'item/started' || method === 'item/completed') {
      const nested = childItemNotificationSchema.safeParse(params)
      if (!nested.success || nested.data.item.type !== 'collabAgentToolCall' && nested.data.item.type !== 'subAgentActivity') return undefined
      this.item(owner.thread, { ...nested.data.item, senderThreadId: child }, { turnId: nested.data.turnId,
        phase: method === 'item/started' ? 'started' : 'completed', startedAtMs: nested.data.startedAtMs ?? undefined, completedAtMs: nested.data.completedAtMs ?? undefined }, owner.path)
      return owner.thread
    }
    const payload = childTurnNotificationSchema.safeParse(params)
    if (!payload.success) return undefined
    const status = method === 'turn/started' ? 'running' : method === 'turn/completed' ? payload.data.turn?.status
      : method === 'thread/status/changed' ? ({ active: 'running', idle: 'unknown', systemError: 'errored', notLoaded: 'unknown' } as Record<string, string>)[payload.data.status?.type ?? ''] : undefined
    if (!status) return undefined
    if (status === 'running') {
      const working = this.working.get(owner.thread) ?? new Set<string>()
      working.add(child); this.working.set(owner.thread, working)
      // Its own turn starting shows a message it was sent once finished handed it work: that is its next assignment.
      const waiting = this.messaged.get(owner.thread)?.get(child)
      this.messaged.get(owner.thread)?.delete(child)
      if (waiting) { this.subAgentActivity(owner.thread, waiting.item, waiting.context, waiting.senderPath, { at: waiting.at ?? this.now(), live: true }); owner = this.owners.get(child)! }
    } else this.working.get(owner.thread)?.delete(child)
    const prior = owner.agent
    // A late status notification cannot restart a completed assignment. A new input item can.
    if (isTerminalActivity(mappedStatus(prior.status, 'unknown')) && !isTerminalActivity(mappedStatus(status, 'unknown'))) return owner.thread
    const observedAt = iso(this.now())!
    const turn = payload.data.turn
    const startedAt = iso(turn?.startedAt == null ? undefined : turn.startedAt * 1_000)
    const completedAt = iso(turn?.completedAt == null ? undefined : turn.completedAt * 1_000)
    const agent: ObservedAgent = { ...prior, status, observedAt,
      ...(startedAt ? { startedAt, timingSource: 'provider' } : !prior.startedAt && status === 'running' ? { startedAt: observedAt, timingSource: 'observed' } : {}),
      ...(isTerminalActivity(mappedStatus(status, 'unknown')) ? { completedAt: prior.completedAt ?? completedAt ?? observedAt } : {}),
      ...(turn?.durationMs != null ? { durationMs: turn.durationMs } : {}),
      ...(turn?.error ? { message: turn.error.message } : {}),
    }
    owner.agent = compactAgentIdentity(agent)
    const record = owner.thread.activities?.find(activity => activity.id === owner.activityId)
    // A current child remains observable after its spawn has left the bounded activity window.
    this.put(owner.thread, record ? { ...record, agents: record.agents?.map(child => child.id === prior.id ? agent : child) }
      : { id: `codex-child-state-${opaque(child, prior.assignmentId ?? '')}`, turnId: owner.turnId, sequence: 0, kind: 'subagent', title: 'Subagent', status: 'unknown', agents: [agent] })
    return owner.thread
  }
}
