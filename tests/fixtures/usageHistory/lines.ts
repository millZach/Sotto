/**
 * Synthetic provider records for the Usage history readers. Every number, identifier and word here is invented;
 * none comes from a real log. `SECRET` stands for anything a person wrote, which no reader may ever pass on.
 */
export const SECRET = 'PRIVATE-WORDS-NEVER-LEAVE'

export interface ClaudeUsage { input?: number; read?: number; write?: number; output?: number; write5m?: number; write1h?: number }
export function claudeAssistant(options: { session: string; id: string; model?: string; at: string; usage: ClaudeUsage; sidechain?: boolean; uuid?: string }): string {
  const { usage } = options
  return JSON.stringify({ type: 'assistant', sessionId: options.session, uuid: options.uuid ?? `a-${options.id}-${usage.output ?? 0}`, timestamp: options.at,
    isSidechain: options.sidechain ?? false, requestId: `req-${options.id}`,
    message: { id: options.id, role: 'assistant', model: options.model ?? 'claude-opus-5-5', content: [{ type: 'text', text: SECRET }],
      usage: { input_tokens: usage.input ?? 0, cache_read_input_tokens: usage.read ?? 0, cache_creation_input_tokens: usage.write ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: usage.write5m ?? 0, ephemeral_1h_input_tokens: usage.write1h ?? 0 }, output_tokens: usage.output ?? 0 } } })
}
export function claudeUser(options: { session: string; uuid: string; at: string; content?: unknown; sidechain?: boolean; meta?: boolean }): string {
  return JSON.stringify({ type: 'user', sessionId: options.session, uuid: options.uuid, timestamp: options.at, isSidechain: options.sidechain ?? false,
    ...(options.meta ? { isMeta: true } : {}), message: { role: 'user', content: options.content ?? `${SECRET} please` } })
}
export function claudeToolResult(options: { session: string; uuid: string; at: string }): string {
  return claudeUser({ ...options, content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: SECRET }] })
}

export interface CodexTotals { input: number; cached?: number; output: number; reasoning?: number }
const codexUsage = (value: CodexTotals) => ({ input_tokens: value.input, cached_input_tokens: value.cached ?? 0, output_tokens: value.output,
  reasoning_output_tokens: value.reasoning ?? 0, total_tokens: value.input + value.output })
export function codexMeta(options: { id: string; originator?: string; at: string; forkedFrom?: string; parent?: string; threadSource?: string; source?: unknown; ordinal?: number }): string {
  return JSON.stringify({ timestamp: options.at, type: 'session_meta', payload: { id: options.id, session_id: options.id, timestamp: options.at, cwd: SECRET,
    originator: options.originator ?? 'codex-tui', cli_version: '0.0.0', base_instructions: SECRET,
    ...(options.forkedFrom ? { forked_from_id: options.forkedFrom } : {}), ...(options.parent ? { parent_thread_id: options.parent } : {}),
    ...(options.threadSource ? { thread_source: options.threadSource } : {}), ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.ordinal !== undefined ? { subagent_history_start_ordinal: options.ordinal } : {}) } })
}
export function codexTaskStarted(options: { turn: string; at: string }): string {
  return JSON.stringify({ timestamp: options.at, type: 'event_msg', payload: { type: 'task_started', turn_id: options.turn } })
}
export function codexTurnContext(options: { turn?: string; model: string; at: string }): string {
  return JSON.stringify({ timestamp: options.at, type: 'turn_context', payload: { ...(options.turn ? { turn_id: options.turn } : {}), model: options.model, cwd: SECRET } })
}
export function codexUserMessage(options: { at: string }): string {
  return JSON.stringify({ timestamp: options.at, type: 'event_msg', payload: { type: 'user_message', message: SECRET } })
}
export function codexTokenCount(options: { at: string; total: CodexTotals; last: CodexTotals }): string {
  return JSON.stringify({ timestamp: options.at, type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: codexUsage(options.total), last_token_usage: codexUsage(options.last), model_context_window: 100_000 } } })
}
export function codexRecord(options: { at: string; thread: string; turn: string; response: string; total: CodexTotals; last: CodexTotals }): string {
  return JSON.stringify({ timestamp: options.at, type: 'token_usage_record', payload: { thread_id: options.thread, turn_id: options.turn, response_id: options.response,
    usage: codexUsage(options.last), turn_token_usage: codexUsage(options.last), thread_token_usage: codexUsage(options.total) } })
}

export function jsonl(lines: readonly string[]): string { return lines.map(line => `${line}\n`).join('') }
