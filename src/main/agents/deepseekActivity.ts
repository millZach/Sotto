import { MAX_ACTIVITY_TEXT, type AgentActivity } from '../../shared/agentActivity'
import { object } from './claudeProtocol'
import { acpThinkingActivities, type AcpThinking } from './thinkingActivity'

type Context = { turnId: string; afterMessageId?: string | undefined; cwd: string; key?: string | undefined }

export const DEEPSEEK_THINKING_ID_PREFIX = 'deepseek-thinking-'
/** Updates that say the model has moved on from a thought: its reply, a new tool, or a new prompt. */
const MOVES_ON = new Set(['agent_message_chunk', 'tool_call', 'user_message_chunk'])
const DEEPSEEK_THINKING: AcpThinking = {
  idPrefix: DEEPSEEK_THINKING_ID_PREFIX,
  settles: update => MOVES_ON.has(String(update.sessionUpdate)) ? 'completed' : undefined,
}

/**
 * DeepSeek Harness's activity for one update (ADR-0136). Every tool arrives with ACP kind `other` and no
 * locations, so what a row is comes from the tool's own name and arguments: `bash` is a command, the file tools
 * are file changes naming their path (no diff travels on this surface; the thread's own turn snapshot shows what
 * changed), and anything else, MCP tools included, is a tool row. A thought settles when the model moves on.
 */
export function deepseekActivities(update: Record<string, unknown>, context: Context, previous: readonly AgentActivity[] = [], live = false): AgentActivity[] {
  return acpThinkingActivities(DEEPSEEK_THINKING, update, { turnId: context.turnId, afterMessageId: context.afterMessageId, key: context.key }, previous, live,
    () => deepseekWork(update, context, previous, live))
}

const FILE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'delete', 'move', 'rename'])

function deepseekWork(update: Record<string, unknown>, context: Context, previous: readonly AgentActivity[], live: boolean): AgentActivity[] {
  let truncated = false
  const bounded = (value: string) => { if (value.length > MAX_ACTIVITY_TEXT) truncated = true; return value.slice(0, MAX_ACTIVITY_TEXT) }
  if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string') return []
  const id = context.key ?? `deepseek-tool-${update.toolCallId}`
  const old = previous.find(row => row.id === id)
  const input = object(update.rawInput)
  const title = typeof update.title === 'string' && update.title !== '' ? update.title : old?.title ?? 'Tool'
  const command = typeof input?.command === 'string' ? input.command : undefined
  const path = [input?.file_path, input?.filePath, input?.path].find((value): value is string => typeof value === 'string' && value !== '')
  const kind: AgentActivity['kind'] = title === 'bash' || command !== undefined ? 'command' : FILE_TOOLS.has(title) ? 'file-change' : old?.kind ?? 'tool'
  const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed'
    : ['pending', 'in_progress'].includes(String(update.status)) ? 'running' : old?.status ?? 'unknown'
  const content = Array.isArray(update.content) ? update.content.map(object).filter(value => value !== undefined) : undefined
  const texts = content?.flatMap(value => {
    const part = object(value.content) ?? value
    return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  })
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
    ...(path && kind === 'file-change' ? { changes: [{ path: bounded(path), kind: title }] } : {}),
    ...(truncated ? { truncated: true } : {}),
  }]
}
