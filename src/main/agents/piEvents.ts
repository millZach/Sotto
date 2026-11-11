import type { PiFrame } from './piRpc'

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
export interface PiTurnUsage { input?: number; output?: number; cached?: number }
/** Sum the assistant messages in a turn, including the model calls before and after tools. */
export function piUsage(total: PiTurnUsage, value: unknown): void {
  const usage = object(value)
  for (const [key, native] of [['input', 'input'], ['output', 'output'], ['cached', 'cacheRead']] as const) {
    const count = usage?.[native]
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) total[key] = (total[key] ?? 0) + count
  }
}

/** Normalize only the activity fields Sotto uses. Protocol bodies never reach diagnostic logs. */
export function piEventUpdates(frame: PiFrame): Record<string, unknown>[] {
  if (frame.type === 'message_update') {
    const event = object(frame.assistantMessageEvent)
    if (typeof event?.delta !== 'string') return []
    if (event.type === 'text_delta') return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.delta } }]
    if (event.type === 'thinking_delta') return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.delta } }]
  }
  if (frame.type === 'message_end') {
    const message = object(frame.message)
    if (message?.role === 'user') {
      const content = message.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(object).filter(part => part?.type === 'text').map(part => part?.text).join('') : undefined
      return text === undefined ? [] : [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }]
    }
  }
  if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(frame.type)) {
    const result = object(frame.result ?? frame.partialResult)
    return [{ sessionUpdate: frame.type === 'tool_execution_start' ? 'tool_call' : 'tool_call_update', toolCallId: frame.toolCallId,
      title: frame.toolName, rawInput: frame.args, content: result?.content, durationMs: frame.durationMs,
      status: frame.type === 'tool_execution_end' ? frame.isError === true ? 'failed' : 'completed' : 'in_progress' }]
  }
  return []
}
