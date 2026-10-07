import { MAX_ACTIVITY_TEXT, planSteps, type AgentActivity } from '../../shared/agentActivity'
import { object } from './claudeProtocol'
import { acpThinkingActivities, type AcpThinking } from './thinkingActivity'

type Context = { turnId: string; afterMessageId?: string; cwd: string }

export const DEVIN_THINKING_ID_PREFIX = 'devin-thinking-'
/** Updates that say the model has moved on from a thought: its reply, a new tool or a plan. The turn's end is `devin.ts`'s. */
const MOVES_ON = new Set(['agent_message_chunk', 'tool_call', 'plan'])
const DEVIN_THINKING: AcpThinking = { idPrefix: DEVIN_THINKING_ID_PREFIX, settles: update => MOVES_ON.has(String(update.sessionUpdate)) ? 'completed' : undefined }

/**
 * ACP activity updates are upserts. Partial updates retain the original action and transcript anchor. A thought
 * (`agent_thought_chunk`) streams into a Thinking row that runs until the model moves on to something else.
 */
export function devinActivities(update: Record<string, unknown>, context: Context, previous: readonly AgentActivity[] = [], live = false): AgentActivity[] {
  // ACP may name the message a chunk belongs to; without it, chunks that run on in order are one thought.
  const key = typeof update.messageId === 'string' && update.messageId ? `${context.turnId}-${update.messageId.slice(0, 128)}` : undefined
  return acpThinkingActivities(DEVIN_THINKING, update, { turnId: context.turnId, afterMessageId: context.afterMessageId, key }, previous, live,
    () => devinWork(update, context, previous, live))
}

function devinWork(update: Record<string, unknown>, context: Context, previous: readonly AgentActivity[], live: boolean): AgentActivity[] {
  let truncated = false
  const bounded = (text: string): string => {
    if (text.length > MAX_ACTIVITY_TEXT) truncated = true
    return text.slice(0, MAX_ACTIVITY_TEXT)
  }
  if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
    const steps = planSteps(update.entries.map(entry => ({ text: object(entry)?.content, status: object(entry)?.status })))
    if (!steps.length) return []
    const id = `devin-plan-${context.turnId}`; const old = previous.find(row => row.id === id)
    return [{ ...context, ...old, id, sequence: old?.sequence ?? 0, kind: 'plan', status: 'running', title: 'Plan', steps, ...(update.entries.length > 200 ? { truncated: true } : {}) }]
  }
  if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string') return []
  const id = `devin-tool-${update.toolCallId}`; const old = previous.find(row => row.id === id)
  const input = object(update.rawInput); const output = object(update.rawOutput)
  const content = Array.isArray(update.content) ? update.content.map(object).filter(value => value !== undefined) : []
  const texts = content.flatMap(value => { const part = object(value.content); return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [] })
  const changes = content.flatMap(value => value.type === 'diff' && typeof value.path === 'string'
    ? [{ path: bounded(value.path), kind: 'edit', diff: bounded(`--- before\n${typeof value.oldText === 'string' ? value.oldText : ''}\n+++ after\n${typeof value.newText === 'string' ? value.newText : ''}`) }] : [])
  if (!changes.length && typeof input?.file_path === 'string') changes.push({ path: bounded(input.file_path), kind: 'edit', diff: bounded(typeof input.content === 'string' ? input.content : '') })
  const kind = update.kind === 'execute' || typeof input?.command === 'string' ? 'command'
    : ['edit', 'delete', 'move'].includes(String(update.kind)) || changes.length ? 'file-change' : old?.kind ?? 'tool'
  const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed'
    : ['pending', 'in_progress'].includes(String(update.status)) ? 'running' : old?.status ?? 'unknown'
  // A Devin tool update carries no time of its own, so the moment Sotto received a live one is the only start a
  // running row can have. A replayed update records nothing, because a transcript must not be given a clock it never had.
  const startedAt = live && status === 'running' && !old?.startedAt ? new Date().toISOString() : undefined
  return [{ ...context, ...old, id, sequence: old?.sequence ?? 0, kind, status,
    title: typeof update.title === 'string' ? bounded(update.title) : old?.title ?? 'Tool',
    ...(startedAt ? { startedAt, timingSource: 'observed' as const } : {}),
    ...(typeof input?.command === 'string' ? { command: bounded(input.command) } : {}),
    ...(update.rawInput !== undefined ? { text: bounded(JSON.stringify(update.rawInput)) } : {}),
    ...(texts.length ? { output: bounded(texts.join('\n')) } : update.rawOutput !== undefined ? { output: bounded(typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)) } : {}),
    ...(Number.isSafeInteger(output?.exitCode ?? output?.exit_code) ? { exitCode: (output?.exitCode ?? output?.exit_code) as number } : {}),
    ...(changes.length ? { changes: changes.slice(0, 200) } : {}),
    ...(truncated || changes.length > 200 ? { truncated: true } : {}),
  }]
}
