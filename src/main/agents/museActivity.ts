import { z } from 'zod'
import { THINKING_TITLE, thinkingText, type AgentActivity } from '../../shared/agentActivity'
import type { AgentMessage } from '../../shared/agents'

/**
 * One MSP transcript item, as the view stream and a resume's history carry it. MSP evolves additively and
 * item kinds are an open vocabulary, so the shape is read loosely: a kind Sotto does not know is rendered
 * from its name, its status and its `fallbackText`, never dropped silently and never guessed at.
 */
export const museItemSchema = z.looseObject({
  itemId: z.string().min(1), kind: z.string().min(1), status: z.string().min(1), revision: z.number().int().min(1),
  turnId: z.string().nullable().optional(), recordedAt: z.string().optional(), commandId: z.string().optional(),
  text: z.string().optional(), displayText: z.string().optional(), fallbackText: z.string().optional(),
  attachments: z.array(z.looseObject({ type: z.string(), mediaType: z.string(), width: z.number().optional(), height: z.number().optional() })).optional(),
  summary: z.array(z.string()).optional(),
  tool: z.string().optional(), callId: z.string().optional(), args: z.string().optional(),
  visibleOutput: z.string().optional(), failureReason: z.string().optional(), truncated: z.boolean().optional(),
  commandText: z.string().optional(), exitCode: z.number().int().optional(), durationMs: z.number().optional(),
  role: z.string().optional(), objective: z.string().optional(), controlStatus: z.string().optional(),
  result: z.looseObject({ summary: z.string().default(''), text: z.string().optional() }).optional(),
  children: z.array(z.looseObject({ childId: z.string(), attempt: z.number(), status: z.string(), label: z.string().optional(), terminal: z.string().optional() })).optional(),
  message: z.string().optional(), outcome: z.string().optional(), reason: z.string().optional(),
  tokensBefore: z.number().optional(), tokensAfter: z.number().optional(),
  background: z.boolean().optional(), steered: z.boolean().optional(), retracted: z.boolean().optional(),
})
export type MuseItem = z.infer<typeof museItemSchema>

export const museItemEventSchema = z.looseObject({ sessionId: z.string().min(1), item: museItemSchema, viewCursor: z.string().default('') })
export const museItemDeltaSchema = z.looseObject({
  sessionId: z.string().min(1), itemId: z.string().min(1), delta: z.string(), field: z.string().optional(), viewCursor: z.string().default(''),
})
export const museTurnEventSchema = z.looseObject({ sessionId: z.string().min(1), turnId: z.string().min(1), commandId: z.string().optional(), viewCursor: z.string().default('') })
export const museTurnCompletedSchema = z.looseObject({
  sessionId: z.string().min(1), turnId: z.string().min(1), terminal: z.string().min(1),
  error: z.looseObject({ kind: z.string().default(''), message: z.string().default(''), retryable: z.boolean().default(false) }).optional(),
  reason: z.string().optional(), durationMs: z.number().optional(), viewCursor: z.string().default(''),
})

const MAX = 65_536
const bounded = (text: string): { text: string; truncated?: true } =>
  text.length > MAX ? { text: text.slice(0, MAX), truncated: true } : { text }
const at = (item: MuseItem): string => item.recordedAt && !Number.isNaN(Date.parse(item.recordedAt)) ? item.recordedAt : new Date().toISOString()

export function museStatus(status: string): AgentActivity['status'] {
  switch (status) {
    case 'inProgress': return 'running'
    case 'completed': return 'completed'
    case 'cancelled': return 'interrupted'
    case 'failed': case 'rejected': case 'timedOut': return 'failed'
    default: return 'unknown'
  }
}
export const museTerminal = (status: string): boolean => status !== 'inProgress'

/** A user or assistant item as the message Sotto records. The adapter chooses the ID, so origins stay its own. */
export function museItemMessage(item: MuseItem, id: string): AgentMessage | undefined {
  if (item.kind === 'userMessage') return { id, role: 'user', text: item.text ?? '', createdAt: at(item), ...(item.commandId ? { commandId: item.commandId } : {}) }
  if (item.kind === 'agentMessage') return { id, role: 'assistant', text: item.text ?? '', createdAt: at(item) }
  return undefined
}

function argsRecord(args: string | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined
  try {
    const value: unknown = JSON.parse(args)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}
const stringField = (record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
  for (const key of keys) { const value = record?.[key]; if (typeof value === 'string' && value) return value }
  return undefined
}

/**
 * One item as activity beside the thread's messages. `turnId` is the identity Sotto's records share for the
 * turn: the user message that opened it, which the adapter supplies. Reminder children are Muse's own
 * housekeeping sessions, not work the user asked for, so they keep no record here.
 */
export function museItemActivity(item: MuseItem, turnId: string, afterMessageId?: string): AgentActivity | undefined {
  if (item.kind === 'userMessage' || item.kind === 'agentMessage' || item.kind === 'reminderChild') return undefined
  const base: AgentActivity = {
    id: `muse-item-${item.itemId}`, turnId, sequence: 0, kind: 'tool', status: museStatus(item.status),
    title: 'Tool', startedAt: at(item), timingSource: 'provider',
    ...(museTerminal(item.status) ? { completedAt: at(item) } : {}),
    ...(afterMessageId ? { afterMessageId } : {}),
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    ...(item.failureReason ? { error: bounded(item.failureReason).text } : {}),
    ...(item.truncated ? { truncated: true } : {}),
  }
  if (item.kind === 'reasoning') {
    const text = (item.summary?.length ? item.summary.join('') : item.text ?? '')
    return { ...base, kind: 'reasoning', title: THINKING_TITLE, ...thinkingText(text) }
  }
  if (item.kind === 'toolCall') {
    const args = argsRecord(item.args)
    const output = item.visibleOutput ? { output: bounded(item.visibleOutput).text } : {}
    const detail = item.args ? { text: bounded(item.args).text } : {}
    if (item.tool === 'bash' || item.tool === 'shell') {
      const command = stringField(args, 'command', 'cmd')
      return { ...base, kind: 'command', title: 'Command', ...(command ? { command: bounded(command).text } : detail), ...output }
    }
    const path = stringField(args, 'path', 'file', 'filePath')
    if ((item.tool === 'write_file' || item.tool === 'edit_file') && path) {
      return { ...base, kind: 'file-change', title: item.tool === 'write_file' ? 'Write file' : 'Edit file', changes: [{ path: bounded(path).text, kind: item.tool }], ...detail, ...output }
    }
    return { ...base, kind: 'tool', title: bounded(item.tool ?? item.fallbackText ?? 'Tool').text, ...detail, ...output }
  }
  if (item.kind === 'userShell') {
    return { ...base, kind: 'command', title: 'Command', ...(item.commandText ? { command: bounded(item.commandText).text } : {}),
      ...(item.visibleOutput ? { output: bounded(item.visibleOutput).text } : {}), ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}) }
  }
  if (item.kind === 'subagent') {
    const summary = item.result?.text ?? item.result?.summary
    return { ...base, kind: 'subagent', title: bounded(item.objective ?? item.role ?? 'Subagent').text,
      agents: [{ id: item.itemId, status: item.controlStatus ?? item.status, ...(item.role ? { title: item.role } : {}), ...(item.objective ? { description: bounded(item.objective).text } : {}), ...(summary ? { message: bounded(summary).text } : {}) }] }
  }
  if (item.kind === 'workflow') {
    const children = item.children ?? []
    const count = (test: (child: (typeof children)[number]) => boolean): number => children.filter(test).length
    return { ...base, kind: 'subagent', title: 'Workflow', ...(item.message ? { text: bounded(item.message).text } : {}),
      agents: [{ id: item.itemId, status: item.status, kind: 'workflow',
        progress: {
          total: children.length,
          working: count(child => !child.terminal && child.status !== 'completed' && child.status !== 'failed'),
          completed: count(child => child.terminal === 'completed' || child.status === 'completed'),
          failed: count(child => child.terminal === 'failed' || child.status === 'failed'),
          interrupted: count(child => child.terminal === 'cancelled'),
        } },
      ...children.map(child => ({ id: `${item.itemId}:${child.childId}:${child.attempt}`, status: child.status, parentId: item.itemId, ...(child.label ? { title: child.label } : {}) }))] }
  }
  if (item.kind === 'compaction') {
    return { ...base, kind: 'compaction', title: 'Context compacted', status: item.outcome === 'failed' ? 'failed' : 'completed',
      ...((item.tokensBefore !== undefined || item.tokensAfter !== undefined)
        ? { context: { ...(item.tokensBefore !== undefined ? { before: item.tokensBefore } : {}), ...(item.tokensAfter !== undefined ? { after: item.tokensAfter } : {}) } } : {}),
      ...(item.reason ? { text: bounded(item.reason).text } : {}) }
  }
  return { ...base, kind: 'status', title: bounded(item.fallbackText ?? item.kind).text, ...(item.text ? { text: bounded(item.text).text } : {}) }
}

/** The todo list as a plan record's steps. Muse replaces the whole list with every change, as a pane draws it. */
export function musePlanActivity(turnId: string, items: readonly { text: string; status: string }[], afterMessageId?: string): AgentActivity | undefined {
  if (!items.length) return undefined
  const state = (status: string): 'pending' | 'running' | 'completed' =>
    status === 'completed' ? 'completed' : status === 'inProgress' ? 'running' : 'pending'
  return {
    id: `muse-plan-${turnId}`, turnId, sequence: 0, kind: 'plan', title: 'Plan',
    status: items.every(item => item.status === 'completed' || item.status === 'cancelled') ? 'completed' : 'running',
    steps: items.map(item => ({ text: item.text.slice(0, 1_000), status: state(item.status) })).slice(0, 200),
    ...(afterMessageId ? { afterMessageId } : {}),
  }
}
