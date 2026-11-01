import { MAX_ACTIVITY_TEXT, planSteps, type AgentActivity } from '../../shared/agentActivity'
import { object } from './claudeProtocol'
import { acpToolMedia, type MediaCapture } from './threadMedia'
import { acpThinkingActivities, type AcpThinking } from './thinkingActivity'

/**
 * Where one Cursor update belongs: its turn (the user message it answers), the message it follows, the thread's folder,
 * and the row key the adapter worked out for it. Cursor's own tool call IDs differ between a live turn and its replay
 * (`session/load` names them `replay-<turn>-<n>`), so a row is keyed by its place in its turn instead, which both give
 * the same, and a thread read back after a restart keeps the rows it showed.
 */
export interface CursorPlace { readonly turnId: string; readonly afterMessageId?: string | undefined; readonly cwd: string; readonly key?: string | undefined }

export const CURSOR_THINKING_ID_PREFIX = 'cursor-thinking-'
/** The row a tool call at this place in its turn becomes, live or replayed. */
export const cursorToolId = (key: string): string => `cursor-tool-${key}`
/** Updates that say the model has moved on from a thought: its reply, a new tool or a plan. The turn's end is `cursor.ts`'s. */
const MOVES_ON = new Set(['agent_message_chunk', 'tool_call', 'plan'])
const CURSOR_THINKING: AcpThinking = { idPrefix: CURSOR_THINKING_ID_PREFIX, settles: update => MOVES_ON.has(String(update.sessionUpdate)) ? 'completed' : undefined }

const bounder = () => {
  let truncated = false
  return { bounded: (text: string): string => { if (text.length > MAX_ACTIVITY_TEXT) truncated = true; return text.slice(0, MAX_ACTIVITY_TEXT) }, truncated: () => truncated }
}
const where = (place: CursorPlace) => ({ turnId: place.turnId, ...(place.afterMessageId ? { afterMessageId: place.afterMessageId } : {}), cwd: place.cwd })

/**
 * The activity for one `session/update`, live or replayed. A thought (`agent_thought_chunk`) streams into a Thinking row
 * that runs until the model moves on; a tool call becomes a command, a file change with its diff, a read or a tool; and
 * the ACP `plan` update becomes the turn's one plan row. With `capture`, the thread media store's, given only with the Owl
 * feature `inline-media` on, a tool's pictures become handles (ADR-0170).
 */
export function cursorActivities(update: Record<string, unknown>, place: CursorPlace, previous: readonly AgentActivity[] = [], live = false, capture?: MediaCapture): AgentActivity[] {
  return acpThinkingActivities(CURSOR_THINKING, update, { turnId: place.turnId, afterMessageId: place.afterMessageId, key: place.key }, previous, live,
    () => cursorWork(update, place, previous, live, capture))
}

function cursorWork(update: Record<string, unknown>, place: CursorPlace, previous: readonly AgentActivity[], live: boolean, capture: MediaCapture | undefined): AgentActivity[] {
  if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) return planRow(update.entries.map(entry => ({ text: object(entry)?.content, status: object(entry)?.status })), place, previous)
  if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string' || !place.key) return []
  const { bounded, truncated } = bounder()
  const id = cursorToolId(place.key); const old = previous.find(row => row.id === id)
  const input = object(update.rawInput); const output = object(update.rawOutput)
  const content = Array.isArray(update.content) ? update.content.map(object).filter(value => value !== undefined) : []
  const texts = content.flatMap(value => { const part = object(value.content); return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [] })
  // Cursor's diff block carries the whole file as `newText`, after a `++ b/<path>` line of its own; `-- /dev/null` is a new file.
  const changes = content.flatMap(value => value.type === 'diff' && typeof value.path === 'string'
    ? [{ path: bounded(value.path), kind: 'edit', diff: bounded(`--- before\n${typeof value.oldText === 'string' ? value.oldText : ''}\n+++ after\n${typeof value.newText === 'string' ? value.newText : ''}`) }] : [])
  const locations = Array.isArray(update.locations) ? update.locations.map(object).flatMap(value => typeof value?.path === 'string' ? [{ path: bounded(value.path), kind: typeof update.kind === 'string' ? update.kind : 'location' }] : []) : []
  const nativeKind = typeof update.kind === 'string' ? update.kind : undefined
  const kind = nativeKind === 'execute' || typeof input?.command === 'string' ? 'command'
    : ['edit', 'delete', 'move'].includes(nativeKind ?? '') || changes.length ? 'file-change' : old?.kind ?? 'tool'
  const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed'
    : ['pending', 'in_progress'].includes(String(update.status)) ? 'running' : old?.status ?? 'unknown'
  // A Cursor update carries no time of its own: a live one is timed from when Sotto received it, a replayed one not at all.
  const startedAt = live && status === 'running' && !old?.startedAt ? new Date().toISOString() : undefined
  const exitCode = output?.exitCode ?? output?.exit_code
  const printed = [typeof output?.stdout === 'string' ? output.stdout : '', typeof output?.stderr === 'string' ? output.stderr : ''].filter(Boolean).join('\n')
  const read = typeof output?.content === 'string' ? output.content : undefined
  const shownChanges = changes.length ? changes : locations
  return [{ ...where(place), ...old, id, sequence: old?.sequence ?? 0, kind, status,
    title: typeof update.title === 'string' ? bounded(update.title) : old?.title ?? 'Tool',
    ...(startedAt ? { startedAt, timingSource: 'observed' as const } : {}),
    ...(typeof input?.command === 'string' ? { command: bounded(input.command) } : {}),
    ...(update.rawInput !== undefined && Object.keys(input ?? {}).length ? { text: bounded(JSON.stringify(update.rawInput)) } : {}),
    ...(texts.length ? { output: bounded(texts.join('\n')) } : printed ? { output: bounded(printed) } : read !== undefined ? { output: bounded(read) } : {}),
    ...(Number.isSafeInteger(exitCode) ? { exitCode: exitCode as number } : {}),
    ...(shownChanges.length ? { changes: shownChanges.slice(0, 200) } : {}),
    ...acpToolMedia(capture, update.content, old),
    ...(truncated() || shownChanges.length > 200 ? { truncated: true } : {}),
  }]
}

/** The turn's one plan row: Cursor replaces its whole list on every plan update and every `cursor/update_todos`. */
function planRow(entries: readonly { text: unknown; status: unknown }[], place: CursorPlace, previous: readonly AgentActivity[]): AgentActivity[] {
  const steps = planSteps(entries)
  if (!steps.length) return []
  const id = `cursor-plan-${place.turnId}`; const old = previous.find(row => row.id === id)
  return [{ ...where(place), ...old, id, sequence: old?.sequence ?? 0, kind: 'plan', status: 'running', title: 'Plan', steps, ...(entries.length > 200 ? { truncated: true } : {}) }]
}

/** `cursor/update_todos`: Cursor's to-do list, which is the turn's plan row. A merge keeps the steps it does not name. */
export function cursorTodos(params: unknown, place: CursorPlace, previous: readonly AgentActivity[]): AgentActivity[] {
  const value = object(params)
  if (!Array.isArray(value?.todos)) return []
  const todos = value.todos.map(object).filter(todo => todo !== undefined)
  const entries = todos.map(todo => ({ text: todo.content, status: todo.status }))
  if (value.merge === true) {
    const old = previous.find(row => row.id === `cursor-plan-${place.turnId}`)?.steps ?? []
    const named = new Set(entries.map(entry => String(entry.text)))
    return planRow([...old.filter(step => !named.has(step.text)).map(step => ({ text: step.text, status: step.status === 'running' ? 'in_progress' : step.status })), ...entries], place, previous)
  }
  return planRow(entries, place, previous)
}

/**
 * `cursor/task`: one of Cursor's subagents, as a subagent row. Cursor says it once when the task starts and again, with
 * how long it took, when it is done.
 */
export function cursorTask(params: unknown, place: CursorPlace, previous: readonly AgentActivity[], live: boolean): AgentActivity[] {
  const value = object(params)
  if (typeof value?.toolCallId !== 'string' || !place.key) return []
  const { bounded, truncated } = bounder()
  const id = `cursor-agent-${place.key}`; const old = previous.find(row => row.id === id); const oldAgent = old?.agents?.[0]
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : undefined
  const status = durationMs !== undefined ? 'completed' : old?.status ?? 'running'
  const description = typeof value.description === 'string' && value.description ? bounded(value.description) : undefined
  const prompt = typeof value.prompt === 'string' && value.prompt ? bounded(value.prompt) : undefined
  const title = description ?? prompt?.split(/\r?\n/u)[0] ?? oldAgent?.title ?? 'Subagent'
  const observedAt = live ? new Date().toISOString() : oldAgent?.observedAt
  return [{ ...where(place), ...old, id, sequence: old?.sequence ?? 0, kind: 'subagent', status, title,
    agents: [{ ...oldAgent, id: `cursor-child-${place.key}`, status, title,
      ...(description ? { description } : {}), ...(prompt ? { prompt } : {}),
      ...(typeof value.model === 'string' && value.model ? { model: bounded(value.model) } : {}),
      ...(observedAt ? { observedAt } : {}),
      ...(live && !oldAgent?.startedAt && observedAt ? { startedAt: observedAt, timingSource: 'observed' as const } : {}),
      ...(status === 'completed' && observedAt ? { completedAt: oldAgent?.completedAt ?? observedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}) }],
    ...(durationMs !== undefined ? { durationMs, timingSource: 'provider' as const } : {}), ...(truncated() ? { truncated: true } : {}) }]
}

/** `cursor/generate_image`: an image Cursor made, named by what it shows and where Cursor saved it. */
export function cursorImage(params: unknown, place: CursorPlace, previous: readonly AgentActivity[]): AgentActivity[] {
  const value = object(params)
  if (typeof value?.toolCallId !== 'string' || !place.key) return []
  const { bounded, truncated } = bounder()
  const id = `cursor-image-${place.key}`; const old = previous.find(row => row.id === id)
  const description = typeof value.description === 'string' ? bounded(value.description) : ''
  const file = typeof value.filePath === 'string' ? bounded(value.filePath) : undefined
  return [{ ...where(place), ...old, id, sequence: old?.sequence ?? 0, kind: 'tool', status: file ? 'completed' : old?.status ?? 'running', generates: 'image',
    title: description ? `Image: ${description.split(/\r?\n/u)[0]}` : 'Image', ...(file ? { changes: [{ path: file, kind: 'image' }] } : {}), ...(truncated() ? { truncated: true } : {}) }]
}
