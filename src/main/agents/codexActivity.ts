import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MAX_ACTIVITY_TEXT, mergeAgentActivities, isTerminalActivity, planSteps, type AgentActivity } from '../../shared/agentActivity'
import type { AgentThread } from '../../shared/agents'
type ActivityConversation = Pick<AgentThread, 'id' | 'messages' | 'activities'>

// Display fields selected from installed codex-cli 0.154.0's generated schema.
// Only displayable fields survive this
// boundary; reasoning.content, encrypted content and raw protocol objects do not.
const displayFields: Readonly<Record<string, readonly string[]>> = {
  userMessage: ['clientId', 'content'], agentMessage: ['text'],
  commandExecution: ['command', 'cwd', 'aggregatedOutput', 'exitCode'],
  fileChange: ['changes'], mcpToolCall: ['server', 'tool', 'result', 'error'],
  dynamicToolCall: ['tool', 'contentItems'], reasoning: ['summary'], plan: ['text'],
  collabAgentToolCall: ['tool', 'prompt', 'receiverThreadIds', 'agentsStates'],
  webSearch: ['query'], contextCompaction: [],
}
export const codexItemSchema = z.preprocess(value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const item = value as Record<string, unknown>
  const fields = typeof item.type === 'string' && Object.hasOwn(displayFields, item.type) ? displayFields[item.type] : undefined
  // Native item variants reuse field names with different shapes (imageGeneration.result
  // is a string). Unsupported presentation must not break the shared transport or retain its payload.
  const keys = fields === undefined ? ['id', 'type'] : ['id', 'type', 'status', 'durationMs', ...fields]
  return Object.fromEntries(keys.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]))
}, z.object({
  id: z.string(), type: z.string(), clientId: z.string().nullish(), text: z.string().optional(),
  content: z.unknown().optional(), status: z.string().optional(), summary: z.array(z.string()).optional(),
  command: z.string().optional(), cwd: z.string().optional(), aggregatedOutput: z.string().nullish(),
  exitCode: z.number().int().nullish(), durationMs: z.number().nonnegative().nullish(),
  changes: z.array(z.object({ path: z.string(), kind: z.object({ type: z.string() }).optional(), diff: z.string().optional() })).optional(),
  tool: z.string().optional(), server: z.string().optional(), prompt: z.string().nullish(),
  receiverThreadIds: z.array(z.string()).optional(),
  agentsStates: z.record(z.string(), z.object({ status: z.string(), message: z.string().nullish() })).optional(),
  result: z.object({ content: z.array(z.unknown()).optional() }).nullish(),
  contentItems: z.array(z.unknown()).nullish(), error: z.object({ message: z.string() }).nullish(),
  query: z.string().optional(),
}))
type Item = z.infer<typeof codexItemSchema>
type Context = { turnId: string; afterMessageId?: string | undefined; phase: 'started' | 'completed' | 'history'; startedAtMs?: number | undefined; completedAtMs?: number | undefined; terminal?: boolean | undefined }
const opaque = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
export const codexActivityId = (turnId: string, itemId: string): string => `codex-activity-${opaque(turnId, itemId)}`
const agentId = (id: string): string => `codex-agent-${opaque(id)}`
const iso = (ms: number | undefined): string | undefined => ms !== undefined && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined
const mappedStatus = (status: string | undefined, fallback: AgentActivity['status']): AgentActivity['status'] =>
  status === 'inProgress' || status === 'running' ? 'running'
    : status === 'completed' ? 'completed' : status === 'failed' || status === 'errored' || status === 'declined' ? 'failed'
      : status === 'interrupted' ? 'interrupted' : fallback
const contentText = (value: unknown[] | null | undefined): string | undefined => {
  if (!value) return undefined
  return value.flatMap(part => {
    const parsed = z.object({ type: z.enum(['text', 'inputText', 'input_text']), text: z.string() }).safeParse(part)
    return parsed.success ? [parsed.data.text] : []
  }).join('\n')
}

/** Observational native activity. Never sends commands, reads child transcripts or creates threads. */
export class CodexActivityProjection {
  private readonly summaries = new Map<string, Map<number, string>>()
  private readonly children = new Map<string, { thread: ActivityConversation; turnId: string }>()
  private readonly terminalTurns = new WeakMap<ActivityConversation, Set<string>>()
  private readonly seen = new WeakMap<ActivityConversation, Set<string>>()
  private readonly turnAnchors = new WeakMap<ActivityConversation, Map<string, string>>()
  constructor(private readonly now: () => number = Date.now) {}

  anchor(thread: ActivityConversation, turnId: string, messageId: string): void {
    const anchors = this.turnAnchors.get(thread) ?? new Map<string, string>()
    if (anchors.has(turnId)) return
    anchors.set(turnId, messageId); this.turnAnchors.set(thread, anchors)
    const record = thread.activities?.find(activity => activity.id === codexActivityId(turnId, '$turn'))
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
    // One total detail budget per record, including file diffs and tool output.
    for (const key of ['title', 'command', 'cwd', 'text', 'error', 'output'] as const) {
      if (activity[key] !== undefined) activity[key] = bounded(activity[key]!)
    }
    if (activity.changes) {
      if (activity.changes.length > 200) activity.truncated = true
      activity.changes = activity.changes.slice(0, 200).map(change => ({ path: bounded(change.path), kind: bounded(change.kind), ...(change.diff !== undefined ? { diff: bounded(change.diff) } : {}) }))
    }
    if (activity.agents) {
      if (activity.agents.length > 200) activity.truncated = true
      activity.agents = activity.agents.slice(0, 200).map(agent => ({ ...agent, status: bounded(agent.status), ...(agent.message !== undefined ? { message: bounded(agent.message) } : {}) }))
    }
    thread.activities = mergeAgentActivities(thread.activities, [activity])
  }

  item(thread: ActivityConversation, item: Item, context: Context): void {
    const kinds: Record<string, [AgentActivity['kind'], string]> = {
      commandExecution: ['command', 'Command'], fileChange: ['file-change', 'File changes'],
      mcpToolCall: ['tool', [item.server, item.tool].filter(Boolean).join(' / ') || 'Tool'],
      dynamicToolCall: ['tool', item.tool ?? 'Tool'], reasoning: ['reasoning', 'Reasoning summary'],
      plan: ['plan', 'Plan'], collabAgentToolCall: ['subagent', item.tool ?? 'Subagent'],
      webSearch: ['tool', 'Web search'], contextCompaction: ['status', 'Context compaction'],
    }
    const kind = kinds[item.type]
    if (!kind) return
    const id = codexActivityId(context.turnId, item.id)
    const previous = thread.activities?.find(record => record.id === id)
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
    if (item.type === 'reasoning' && item.summary) activity.text = item.summary.join('\n\n')
    if (item.type === 'plan') activity.text = item.text ?? ''
    if (item.type === 'webSearch') activity.text = item.query
    const output = contentText(item.result?.content ?? item.contentItems)
    if (output !== undefined) activity.output = output
    if (item.type === 'collabAgentToolCall') {
      if (item.prompt != null) activity.text = item.prompt
      const ids = [...new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])]
      activity.agents = ids.map(child => ({ id: agentId(child), status: item.agentsStates?.[child]?.status ?? 'unknown',
        ...(item.agentsStates?.[child]?.message != null ? { message: item.agentsStates[child]!.message! } : {}) }))
      for (const child of ids) this.children.set(child, { thread, turnId: context.turnId })
    }
    this.put(thread, activity)
    if (isTerminalActivity(status)) this.summaries.delete(id)
  }

  delta(thread: ActivityConversation, method: string, params: { turnId?: string | undefined; itemId?: string | undefined; delta?: string | undefined; summaryIndex?: number | undefined; message?: string | undefined }): void {
    if (!params.turnId || !params.itemId) return
    if (this.terminalTurns.get(thread)?.has(params.turnId)) return
    const id = codexActivityId(params.turnId, params.itemId)
    const previous = thread.activities?.find(record => record.id === id)
    if (previous && isTerminalActivity(previous.status)) return
    const kind = method === 'item/reasoning/summaryTextDelta' ? 'reasoning' : method === 'item/plan/delta' ? 'plan'
      : method === 'item/fileChange/outputDelta' ? 'file-change' : method === 'item/mcpToolCall/progress' ? 'tool' : 'command'
    const record: AgentActivity = { id, turnId: params.turnId, sequence: 0, kind, title: kind === 'reasoning' ? 'Reasoning summary' : kind === 'plan' ? 'Plan' : kind === 'tool' ? 'Tool' : kind === 'file-change' ? 'File changes' : 'Command',
      status: 'running', afterMessageId: thread.messages.at(-1)?.id, ...previous }
    if (method === 'item/reasoning/summaryTextDelta') {
      const index = params.summaryIndex
      if (index === undefined || !Number.isInteger(index) || index < 0 || index >= 200) return
      const parts = this.summaries.get(id) ?? new Map<number, string>()
      parts.set(index, ((parts.get(index) ?? '') + (params.delta ?? '')).slice(0, MAX_ACTIVITY_TEXT))
      this.summaries.set(id, parts)
      record.text = [...parts].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n\n')
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

  childNotification(child: string, method: string, params: unknown): ActivityConversation | undefined {
    const owner = this.children.get(child)
    if (!owner) return undefined
    const payload = z.object({ turn: z.object({ status: z.string(), error: z.object({ message: z.string() }).nullish() }).optional(), status: z.object({ type: z.string() }).optional() }).safeParse(params)
    if (!payload.success) return undefined
    const status = method === 'turn/started' ? 'running' : method === 'turn/completed' ? payload.data.turn?.status
      : method === 'thread/status/changed' ? ({ active: 'running', idle: 'unknown', systemError: 'errored', notLoaded: 'unknown' } as Record<string, string>)[payload.data.status?.type ?? ''] : undefined
    if (!status) return undefined
    for (const record of owner.thread.activities ?? []) if (record.agents?.some(agent => agent.id === agentId(child))) {
      this.put(owner.thread, { ...record, agents: record.agents.map(agent => agent.id === agentId(child) ? { ...agent, status,
        ...(payload.data.turn?.error ? { message: payload.data.turn.error.message } : {}) } : agent) })
    }
    return owner.thread
  }
}
