import { THINKING_TITLE, thinkingText, type AgentActivity } from '../../shared/agentActivity'

/**
 * OpenCode's work beside a thread's messages (ADR-0087): each tool call and each run of reasoning as one activity
 * record, built from the same facts whether they came live from the event stream or from a provider session's history,
 * so a resumed thread shows the same records under the same IDs.
 */
export interface OpenCodeTool {
  readonly id: string
  name: string
  input?: Record<string, unknown> | undefined
  status: AgentActivity['status']
  output?: string | undefined
  error?: string | undefined
  startedAt: string
  completedAt?: string | undefined
}

const MAX = 65_536
const bounded = (text: string): string => text.length > MAX ? text.slice(0, MAX) : text
const field = (input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
  for (const key of keys) { const value = input?.[key]; if (typeof value === 'string' && value) return value }
  return undefined
}

/** The text a tool returned, as OpenCode carries it: a list of parts, of which the text ones are shown. */
export function opencodeToolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n')
  return text || undefined
}

/** A tool's state as a provider session's history reports it. */
export function opencodeToolStatus(status: string | undefined): AgentActivity['status'] {
  switch (status) {
    case 'completed': return 'completed'
    case 'error': return 'failed'
    case 'running': case 'streaming': case 'pending': return 'running'
    default: return 'unknown'
  }
}

/** One tool call as an activity record. A shell call is a command, a write or edit a file change, the rest a tool. */
export function opencodeToolActivity(tool: OpenCodeTool, turnId: string, afterMessageId?: string): AgentActivity {
  const base: AgentActivity = {
    id: `opencode-tool-${tool.id}`, turnId, sequence: 0, kind: 'tool', status: tool.status, title: bounded(tool.name),
    startedAt: tool.startedAt, timingSource: 'provider',
    ...(tool.completedAt ? { completedAt: tool.completedAt } : {}),
    ...(afterMessageId ? { afterMessageId } : {}),
    ...(tool.output ? { output: bounded(tool.output) } : {}),
    ...(tool.error ? { error: bounded(tool.error) } : {}),
  }
  if (tool.name === 'shell' || tool.name === 'bash') {
    const command = field(tool.input, 'command', 'cmd')
    return { ...base, kind: 'command', title: 'Command', ...(command ? { command: bounded(command) } : {}) }
  }
  const path = field(tool.input, 'path', 'filePath', 'file')
  if (['write', 'edit', 'patch', 'apply_patch', 'multiedit'].includes(tool.name) && path) {
    return { ...base, kind: 'file-change', title: tool.name === 'write' ? 'Write file' : 'Edit file', changes: [{ path: bounded(path), kind: tool.name }] }
  }
  const detail = tool.input && Object.keys(tool.input).length ? JSON.stringify(tool.input) : undefined
  return { ...base, ...(detail ? { text: bounded(detail) } : {}) }
}

/** One run of reasoning as an activity record, under the ID live events and history share. */
export function opencodeReasoningActivity(assistantMessageId: string, ordinal: number, text: string, done: boolean, turnId: string, at: string, afterMessageId?: string): AgentActivity {
  return {
    id: `opencode-reasoning-${assistantMessageId}-${ordinal}`, turnId, sequence: 0, kind: 'reasoning', title: THINKING_TITLE,
    status: done ? 'completed' : 'running', startedAt: at, timingSource: 'provider', ...(done ? { completedAt: at } : {}),
    ...(afterMessageId ? { afterMessageId } : {}), ...thinkingText(text),
  }
}

/** The message ID a reply's text block goes by, live and in history alike. */
export function opencodeTextMessageId(assistantMessageId: string, ordinal: number): string { return `opencode-${assistantMessageId}-${ordinal}` }
