import { MAX_ACTIVITY_TEXT, planSteps, type AgentActivity } from '../../shared/agentActivity'
import { antigravityCommand } from './antigravityRequests'
import { object } from './providers/claude/claudeProtocol'
import { acpToolMedia, type MediaCapture } from './threadMedia'
import { acpThinkingActivities, type AcpThinking } from './thinkingActivity'

/**
 * Where one Antigravity update belongs: its turn (the user message it answers), the message it follows, the thread's
 * folder, and the row key the adapter gave it. A resumed session replays nothing, so a row is keyed by its place in its
 * turn, live only.
 */
export interface AntigravityPlace { readonly turnId: string; readonly afterMessageId?: string | undefined; readonly cwd: string; readonly key?: string | undefined }

export const ANTIGRAVITY_THINKING_ID_PREFIX = 'antigravity-thinking-'
export const antigravityToolId = (key: string): string => `antigravity-tool-${key}`
const MOVES_ON = new Set(['agent_message_chunk', 'tool_call', 'plan'])
const ANTIGRAVITY_THINKING: AcpThinking = { idPrefix: ANTIGRAVITY_THINKING_ID_PREFIX, settles: update => MOVES_ON.has(String(update.sessionUpdate)) ? 'completed' : undefined }
/** `agy`'s subagent tools, by the titles T3 Code recognises them by: shown as a subagent's row. */
const SUBAGENT_TITLES = new Set(['Running start_subagent', 'Run start_subagent?', 'Running invoke_subagent', 'Run invoke_subagent?', 'Run invoke_subagent'])

const bounder = () => {
  let truncated = false
  return { bounded: (text: string): string => { if (text.length > MAX_ACTIVITY_TEXT) truncated = true; return text.slice(0, MAX_ACTIVITY_TEXT) }, truncated: () => truncated }
}
const where = (place: AntigravityPlace) => ({ turnId: place.turnId, ...(place.afterMessageId ? { afterMessageId: place.afterMessageId } : {}), cwd: place.cwd })
const firstString = (value: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined => {
  for (const key of keys) if (typeof value?.[key] === 'string' && (value[key] as string).trim()) return (value[key] as string).trim()
  return undefined
}

/** The activity for one live `session/update`: a thought, a tool call, or the turn's plan. */
export function antigravityActivities(update: Record<string, unknown>, place: AntigravityPlace, previous: readonly AgentActivity[] = [], capture?: MediaCapture): AgentActivity[] {
  return acpThinkingActivities(ANTIGRAVITY_THINKING, update, { turnId: place.turnId, afterMessageId: place.afterMessageId, key: place.key }, previous, true,
    () => antigravityWork(update, place, previous, capture))
}

function antigravityWork(update: Record<string, unknown>, place: AntigravityPlace, previous: readonly AgentActivity[], capture: MediaCapture | undefined): AgentActivity[] {
  if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) return planRow(update.entries.map(entry => ({ text: object(entry)?.content, status: object(entry)?.status })), place, previous)
  if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string' || !place.key) return []
  const { bounded, truncated } = bounder()
  const id = antigravityToolId(place.key); const old = previous.find(row => row.id === id)
  const input = object(update.rawInput); const output = object(update.rawOutput)
  const content = Array.isArray(update.content) ? update.content.map(object).filter(value => value !== undefined) : []
  const texts = content.flatMap(value => { const part = object(value.content); return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [] })
  const changes = content.flatMap(value => value.type === 'diff' && typeof value.path === 'string'
    ? [{ path: bounded(value.path), kind: 'edit', diff: bounded(`--- before\n${typeof value.oldText === 'string' ? value.oldText : ''}\n+++ after\n${typeof value.newText === 'string' ? value.newText : ''}`) }] : [])
  const locations = Array.isArray(update.locations) ? update.locations.map(object).flatMap(value => typeof value?.path === 'string' ? [{ path: bounded(value.path), kind: typeof update.kind === 'string' ? update.kind : 'location' }] : []) : []
  const nativeKind = typeof update.kind === 'string' ? update.kind : undefined
  const command = antigravityCommand(update.rawInput) ?? (output ? firstString(output, ['commandLine', 'command_line']) : undefined)
  const title = typeof update.title === 'string' ? bounded(update.title) : old?.title
  const subagent = (nativeKind === undefined || nativeKind === 'other') && title !== undefined && SUBAGENT_TITLES.has(title) && object(update._meta)?.is_mcp_tool_call !== true
  const kind = subagent ? 'subagent' : nativeKind === 'execute' || command ? 'command'
    : ['edit', 'delete', 'move'].includes(nativeKind ?? '') || changes.length ? 'file-change' : old?.kind ?? 'tool'
  const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed'
    : ['pending', 'in_progress'].includes(String(update.status)) ? 'running' : old?.status ?? 'unknown'
  const startedAt = status === 'running' && !old?.startedAt ? new Date().toISOString() : undefined
  const exitCode = output?.exitCode ?? output?.exit_code
  const printed = firstString(output, ['combinedOutput', 'combined_output', 'stdout']) ?? ''
  const cwd = firstString(input, ['Cwd', 'WorkingDirectory', 'working_dir', 'workingDir', 'cwd'])
  const shownChanges = changes.length ? changes : locations
  const said = typeof update.rawOutput === 'string' && update.rawOutput.trim() ? update.rawOutput.trim() : undefined
  return [{ ...where(place), ...old, id, sequence: old?.sequence ?? 0, kind, status,
    title: title ?? 'Tool',
    ...(startedAt ? { startedAt, timingSource: 'observed' as const } : {}),
    ...(command ? { command: bounded(command) } : {}),
    ...(cwd ? { cwd: bounded(cwd) } : {}),
    ...(update.rawInput !== undefined && Object.keys(input ?? {}).length ? { text: bounded(JSON.stringify(update.rawInput)) } : {}),
    ...(texts.length ? { output: bounded(texts.join('\n')) } : printed ? { output: bounded(printed) } : said ? { output: bounded(said) } : {}),
    ...(Number.isSafeInteger(exitCode) ? { exitCode: exitCode as number } : {}),
    ...(shownChanges.length ? { changes: shownChanges.slice(0, 200) } : {}),
    ...(subagent ? { agents: [{ id: `antigravity-child-${place.key}`, status, title: title ?? 'Subagent' }] } : {}),
    ...acpToolMedia(capture, update.content, old),
    ...(truncated() || shownChanges.length > 200 ? { truncated: true } : {}),
  }]
}

/** The turn's one plan row: `agy` replaces its whole list on every plan update. */
function planRow(entries: readonly { text: unknown; status: unknown }[], place: AntigravityPlace, previous: readonly AgentActivity[]): AgentActivity[] {
  const steps = planSteps(entries)
  if (!steps.length) return []
  const id = `antigravity-plan-${place.turnId}`; const old = previous.find(row => row.id === id)
  return [{ ...where(place), ...old, id, sequence: old?.sequence ?? 0, kind: 'plan', status: 'running', title: 'Plan', steps, ...(entries.length > 200 ? { truncated: true } : {}) }]
}
