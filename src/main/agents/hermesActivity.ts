import { MAX_ACTIVITY_TEXT, type AgentActivity } from '../../shared/agentActivity'
import { object } from './providers/claude/claudeProtocol'
import { acpToolMedia, type MediaCapture } from './threadMedia'
import { acpThinkingActivities, type AcpThinking } from './thinkingActivity'

type Context = { turnId: string; afterMessageId?: string | undefined; cwd: string; key?: string | undefined }

export const HERMES_THINKING_ID_PREFIX = 'hermes-thinking-'
/** Updates that say the model has moved on from a thought: its reply, a new tool, or a new prompt. */
const MOVES_ON = new Set(['agent_message_chunk', 'tool_call', 'user_message_chunk'])
const HERMES_THINKING: AcpThinking = {
  idPrefix: HERMES_THINKING_ID_PREFIX,
  settles: update => MOVES_ON.has(String(update.sessionUpdate)) ? 'completed' : undefined,
}

/** Render native thoughts, tool updates and captured media using Sotto's existing activity rows. */
export function hermesActivities(update: Record<string, unknown>, context: Context, previous: readonly AgentActivity[] = [], live = false, capture?: MediaCapture): AgentActivity[] {
  return acpThinkingActivities(HERMES_THINKING, update, { turnId: context.turnId, afterMessageId: context.afterMessageId, key: context.key }, previous, live,
    () => hermesWork(update, context, previous, live, capture))
}

const FILE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'delete', 'move', 'rename', 'write_file', 'patch'])

function hermesWork(update: Record<string, unknown>, context: Context, previous: readonly AgentActivity[], live: boolean, capture: MediaCapture | undefined): AgentActivity[] {
  let truncated = false
  const bounded = (value: string) => { if (value.length > MAX_ACTIVITY_TEXT) truncated = true; return value.slice(0, MAX_ACTIVITY_TEXT) }
  if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string') return []
  const id = context.key ?? `hermes-tool-${update.toolCallId}`
  const old = previous.find(row => row.id === id)
  const input = object(update.rawInput)
  const title = typeof update.title === 'string' && update.title !== '' ? update.title : old?.title ?? 'Tool'
  const content = Array.isArray(update.content) ? update.content.map(object).filter(value => value !== undefined) : undefined
  const texts = content?.flatMap(value => {
    const part = object(value.content) ?? value
    return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  })
  // Native Hermes tools omit rawInput, but supply ACP kind, locations and `$ command` content.
  const command = typeof input?.command === 'string' ? input.command
    : update.kind === 'execute' ? texts?.find(text => text.startsWith('$ '))?.slice(2) : undefined
  const locations = Array.isArray(update.locations) ? update.locations.map(object) : []
  const path = [input?.file_path, input?.filePath, input?.path, locations[0]?.path].find((value): value is string => typeof value === 'string' && value !== '')
  const kind: AgentActivity['kind'] = update.kind === 'execute' || title === 'bash' || command !== undefined ? 'command'
    : ['edit', 'delete', 'move'].includes(String(update.kind)) || FILE_TOOLS.has(title.split(':')[0] ?? title) ? 'file-change' : old?.kind ?? 'tool'
  const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed'
    : ['pending', 'in_progress'].includes(String(update.status)) || update.sessionUpdate === 'tool_call' ? 'running' : old?.status ?? 'unknown'
  // A live update carries no time of its own, so the moment Sotto received it is the start a running row can have.
  const startedAt = live && status === 'running' && !old?.startedAt ? new Date().toISOString() : undefined
  return [{
    ...old, id, turnId: context.turnId, ...(context.afterMessageId ? { afterMessageId: context.afterMessageId } : {}),
    sequence: old?.sequence ?? 0, kind, status, title: bounded(title),
    ...(startedAt ? { startedAt, timingSource: 'observed' as const } : {}),
    ...(command !== undefined ? { command: bounded(command) } : {}),
    ...(typeof input?.workdir === 'string' ? { cwd: bounded(input.workdir) } : {}),
    ...(update.rawInput !== undefined && command === undefined ? { text: bounded(JSON.stringify(update.rawInput)) } : {}),
    ...(texts?.length ? { output: bounded(texts.join('\n')) } : {}),
    ...acpToolMedia(capture, update.content, old),
    ...(path && kind === 'file-change' ? { changes: [{ path: bounded(path), kind: title }] } : {}),
    ...(truncated ? { truncated: true } : {}),
  }]
}
