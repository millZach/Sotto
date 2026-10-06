import { MAX_ACTIVITY_TEXT, THINKING_TITLE, isTerminalActivity, planSteps, thinkingText, type AgentActivity } from '../../shared/agentActivity'
import { object } from './claudeProtocol'

type Context = { turnId: string; afterMessageId?: string | undefined; cwd: string }
/** What Grok's `_meta` says about the stream an update belongs to; history keeps it as the live notification had it. */
export type GrokStream = { promptId?: string | undefined; streamStartMs?: number | undefined }

const THOUGHT = 'grok-thought-'
/** Updates that say the model has moved on from a thought: its reply, a new tool, a plan, or the turn's end. */
const AFTER_THOUGHT = new Set(['agent_message_chunk', 'tool_call', 'plan', 'user_message_chunk', 'turn_completed', 'subagent_spawned'])

/**
 * Grok's activity for one update, live or read from its history. A thought (`agent_thought_chunk`) streams into one
 * Thinking row per stream: Grok gives a thought and the reply that follows it the same `streamStartMs`, and its history
 * keeps both, so the row a live thought made is the row a read of history finds.
 */
export function grokActivities(update: Record<string, unknown>, context: Context, previous: readonly AgentActivity[] = [], live = false, stream: GrokStream = {}): AgentActivity[] {
  if (update.sessionUpdate === 'agent_thought_chunk') return grokThought(update, context, previous, live, stream)
  const rows = grokWork(update, context, previous, live)
  if (!AFTER_THOUGHT.has(String(update.sessionUpdate))) return rows
  const stopped = update.sessionUpdate === 'turn_completed' && (update.stop_reason ?? update.stopReason) === 'cancelled'
  return [...settledThoughts(previous, stopped ? 'interrupted' : 'completed', live), ...rows]
}

function settledThoughts(previous: readonly AgentActivity[], status: AgentActivity['status'], live: boolean, except?: string): AgentActivity[] {
  const now = live ? new Date().toISOString() : undefined
  return previous.filter(row => row.status === 'running' && row.kind === 'reasoning' && row.id.startsWith(THOUGHT) && row.id !== except)
    .map(row => ({ ...row, status, ...(now ? { completedAt: now } : {}) }))
}

function grokThought(update: Record<string, unknown>, context: Context, previous: readonly AgentActivity[], live: boolean, stream: GrokStream): AgentActivity[] {
  const content = object(update.content)
  const words = content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
  // Without a stream time, a thought continues the turn's running one, or starts the turn's next.
  const running = stream.streamStartMs === undefined
    ? previous.findLast(row => row.status === 'running' && row.kind === 'reasoning' && row.turnId === context.turnId && row.id.startsWith(THOUGHT)) : undefined
  const id = stream.streamStartMs !== undefined ? `${THOUGHT}${stream.promptId ?? context.turnId}-${stream.streamStartMs}`
    : running?.id ?? `${THOUGHT}${context.turnId}-${previous.filter(row => row.turnId === context.turnId && row.id.startsWith(THOUGHT)).length}`
  const old = previous.find(row => row.id === id)
  if (old && isTerminalActivity(old.status)) return []
  const startedAt = live && !old?.startedAt ? new Date().toISOString() : undefined
  return [...settledThoughts(previous, 'completed', live, id), { turnId: context.turnId, ...(context.afterMessageId ? { afterMessageId: context.afterMessageId } : {}), ...old,
    id, sequence: old?.sequence ?? 0, kind: 'reasoning', title: THINKING_TITLE, status: 'running',
    ...thinkingText((old?.text ?? '') + words), ...(startedAt ? { startedAt, timingSource: 'observed' as const } : {}) }]
}

/**
 * A history read can trail the live stream it describes. Its copy of a thought still being written is a prefix of the
 * one the stream has shown, and must not take the stream's later words back.
 */
export function keepStreamedThoughts(history: readonly AgentActivity[], shown: readonly AgentActivity[] | undefined): AgentActivity[] {
  if (!shown?.length) return [...history]
  const streamed = new Map(shown.filter(row => row.id.startsWith(THOUGHT) && row.text).map(row => [row.id, row.text!]))
  return history.map(row => {
    const longer = streamed.get(row.id)
    return longer !== undefined && longer.length > (row.text?.length ?? 0) && longer.startsWith(row.text ?? '') ? { ...row, text: longer } : row
  })
}

function grokWork(update: Record<string, unknown>, context: Context, previous: readonly AgentActivity[], live: boolean): AgentActivity[] {
  let truncated = false
  const bounded = (value: string) => { if (value.length > MAX_ACTIVITY_TEXT) truncated = true; return value.slice(0, MAX_ACTIVITY_TEXT) }
  if (['subagent_spawned', 'subagent_progress', 'subagent_finished'].includes(String(update.sessionUpdate)) && typeof update.subagent_id === 'string') {
    const childId = `grok-child-${update.subagent_id}`
    const attempt = typeof update.attempt_id === 'string' ? update.attempt_id : update.sessionUpdate === 'subagent_spawned' && typeof update.parent_prompt_id === 'string' ? update.parent_prompt_id : undefined
    const prior = previous.findLast(row => row.kind === 'subagent' && row.agents?.some(agent => agent.id === childId))
    const id = attempt ? `grok-agent-${update.subagent_id}-${attempt}` : update.sessionUpdate === 'subagent_spawned' ? `grok-agent-${update.subagent_id}-${context.turnId}` : prior?.id ?? `grok-agent-${update.subagent_id}`
    const old = previous.find(row => row.id === id)
    const oldAgent = old?.agents?.[0]
    const status = update.sessionUpdate === 'subagent_finished' ? update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : update.status === 'cancelled' ? 'interrupted' : 'unknown' : 'running'
    const observedAt = live ? new Date().toISOString() : oldAgent?.observedAt
    const title = typeof update.description === 'string' ? bounded(update.description) : typeof update.prompt === 'string' ? bounded(update.prompt.split(/\r?\n/u)[0]!) : oldAgent?.title
    const model = typeof update.model === 'string' ? update.model : typeof update.model_id === 'string' ? update.model_id : undefined
    const durationMs = typeof update.duration_ms === 'number' && Number.isFinite(update.duration_ms) && update.duration_ms >= 0 ? update.duration_ms : undefined
    return [{ ...context, ...old, id, sequence: old?.sequence ?? 0, kind: 'subagent', status, title: title ?? old?.title ?? 'Subagent',
      agents: [{ ...oldAgent, id: childId, ...(attempt || oldAgent?.assignmentId || update.sessionUpdate === 'subagent_spawned' ? { assignmentId: oldAgent?.assignmentId ?? id } : {}), status,
        ...(title ? { title } : {}), ...(typeof update.description === 'string' ? { description: bounded(update.description) } : {}),
        ...(typeof update.prompt === 'string' ? { prompt: bounded(update.prompt) } : {}), ...(model ? { model: bounded(model) } : {}),
        ...(typeof update.parent_subagent_id === 'string' ? { parentId: `grok-child-${update.parent_subagent_id}` } : {}),
        ...(observedAt ? { observedAt } : {}),
        ...(update.sessionUpdate === 'subagent_spawned' && !oldAgent?.startedAt && observedAt ? { startedAt: observedAt, timingSource: 'observed' as const } : {}),
        ...(update.sessionUpdate === 'subagent_finished' && status !== 'unknown' && observedAt ? { completedAt: oldAgent?.completedAt ?? observedAt } : {}),
        ...(typeof update.output === 'string' ? { message: bounded(update.output) } : typeof update.error === 'string' ? { message: bounded(update.error) } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      }], ...(typeof update.output === 'string' ? { output: bounded(update.output) } : {}),
      ...(typeof update.error === 'string' ? { error: bounded(update.error) } : {}),
      ...(durationMs !== undefined ? { durationMs, timingSource: 'provider' as const } : {}), ...(truncated ? { truncated: true } : {}) }]
  }
  // Grok replaces its whole plan on every update, so the turn keeps one plan row rather than a row per revision.
  if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
    const steps = planSteps(update.entries.map(entry => ({ text: object(entry)?.content, status: object(entry)?.status })))
    if (!steps.length) return []
    const id = `grok-plan-${context.turnId}`
    return [{ ...context, ...previous.find(row => row.id === id), id, sequence: 0, kind: 'plan', status: 'running', title: 'Plan', steps }]
  }
  if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string') return []
  const id = `grok-tool-${update.toolCallId}`; const old = previous.find(row => row.id === id)
  const input = object(update.rawInput); const output = object(update.rawOutput)
  const content = Array.isArray(update.content) ? update.content.map(object).filter(value => value !== undefined) : undefined
  const texts = content?.flatMap(value => { const part = object(value.content); return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [] })
  const changes = content?.flatMap(value => value.type === 'diff' && typeof value.path === 'string' ? [{ path: bounded(value.path), kind: 'edit', diff: bounded(`--- before\n${value.oldText ?? ''}\n+++ after\n${value.newText ?? ''}`) }] : [])
  const locations = Array.isArray(update.locations) ? update.locations.map(object).flatMap(value => typeof value?.path === 'string' ? [{ path: bounded(value.path), kind: typeof update.kind === 'string' ? update.kind : 'location' }] : []) : []
  const kind = update.kind === 'execute' ? 'command' : ['edit', 'delete', 'move'].includes(String(update.kind)) ? 'file-change' : old?.kind ?? 'tool'
  const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : ['pending', 'in_progress'].includes(String(update.status)) ? 'running' : old?.status ?? 'unknown'
  // A Grok tool update carries no time of its own, so the moment Sotto received a live one is the only start a
  // running row can have. A replayed update records nothing, because a transcript must not be given a clock it never had.
  const startedAt = live && status === 'running' && !old?.startedAt ? new Date().toISOString() : undefined
  return [{ ...context, ...old, id, sequence: old?.sequence ?? 0, kind, status, title: typeof update.title === 'string' ? bounded(update.title) : old?.title ?? 'Tool',
    ...(startedAt ? { startedAt, timingSource: 'observed' as const } : {}),
    ...(typeof input?.command === 'string' ? { command: bounded(input.command) } : {}),
    ...(update.rawInput !== undefined ? { text: bounded(JSON.stringify(update.rawInput)) } : {}),
    ...(texts?.length ? { output: bounded(texts.join('\n')) } : update.rawOutput !== undefined ? { output: bounded(typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)) } : {}),
    ...(Number.isInteger(output?.exitCode ?? output?.exit_code) ? { exitCode: (output?.exitCode ?? output?.exit_code) as number } : {}),
    ...(changes?.length || locations.length ? { changes: (changes?.length ? changes : locations).slice(0, 200) } : {}), ...(truncated || (changes?.length ?? 0) > 200 || locations.length > 200 ? { truncated: true } : {}) }]
}
