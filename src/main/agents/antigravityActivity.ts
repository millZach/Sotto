import { MAX_ACTIVITY_TEXT, planSteps, type AgentActivity } from '../../shared/agentActivity'
import { antigravityCommand } from './antigravityRequests'
import { shownCommand, splitCommandLine } from './detachedRunScan'
import { object } from './providers/claude/claudeProtocol'
import { acpToolMedia, type MediaCapture } from './threadMedia'
import { acpThinkingActivities, type AcpThinking } from './thinkingActivity'

/**
 * Where one Antigravity update belongs: its turn (the user message it answers), the message it follows, the thread's
 * folder, and the row key the adapter gave it. A resumed session replays nothing, so a row is keyed by its place in its
 * turn, live only.
 */
export interface AntigravityPlace { readonly turnId: string; readonly afterMessageId?: string | undefined; readonly cwd: string; readonly key?: string | undefined }

export interface AntigravityToolSignal {
  readonly toolCallId: string
  readonly activityId: string
  readonly type: 'command' | 'subagent' | 'workflow'
  readonly isCommand: boolean
  readonly label?: string | undefined
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown'
  readonly pending: boolean
  readonly isControlTool: boolean
  readonly isSubagent: boolean
  readonly backgroundLaunch: boolean
  readonly heuristic: boolean
  readonly durationSeconds?: number | undefined
  readonly nativeTaskId?: string | undefined
  readonly killTaskId?: string | undefined
  readonly statusQueryRunning?: boolean | undefined
  readonly statusQueryFinished?: boolean | undefined
}

export const ANTIGRAVITY_THINKING_ID_PREFIX = 'antigravity-thinking-'
export const antigravityToolId = (key: string): string => `antigravity-tool-${key}`
const MOVES_ON = new Set(['agent_message_chunk', 'tool_call', 'plan'])
const ANTIGRAVITY_THINKING: AcpThinking = { idPrefix: ANTIGRAVITY_THINKING_ID_PREFIX, settles: update => MOVES_ON.has(String(update.sessionUpdate)) ? 'completed' : undefined }
/** `agy`'s subagent tools, by the titles T3 Code recognises them by: shown as a subagent's row. */
const SUBAGENT_TITLES = new Set(['Running start_subagent', 'Run start_subagent?', 'Running invoke_subagent', 'Run invoke_subagent?', 'Run invoke_subagent'])
const NON_BACKGROUND_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'fetch', 'think'])
const AGY_BACKGROUND_HEADER = /^Tool is running as a background task(?:\s+with task id:\s*([^\s,.;]+))?/imu
const AGY_STILL_RUNNING_HEADER = /^Background command is still running after \d+s\b/imu
const TEXT_TASK_ID_PATTERN = /\btask id:\s*([^\s,.;]+)/iu
const RUNNING_TEXT_PATTERN = /\b(?:running in (?:the )?background|moved to (?:the )?background|continuing in (?:the )?background|still running in (?:the )?background|background (?:task|command|job)\b)/iu
const FINISHED_TEXT_PATTERN = /\b(?:completed|exited|finished|done|failed|killed|cancelled)\b/iu
const TASK_ID_KEYS = ['backgroundTaskId', 'background_task_id', 'commandId', 'command_id', 'taskId', 'task_id', 'scheduleId', 'schedule_id', 'workflowId', 'workflow_id', 'jobId', 'job_id'] as const
const RUNNING_OUTPUT_STATUS = new Set(['running', 'background', 'backgrounded', 'in_progress', 'pending', 'async', 'started', 'waiting', 'scheduled', 'active'])
const FINISHED_OUTPUT_STATUS = new Set(['completed', 'done', 'finished', 'failed', 'error', 'exited', 'cancelled', 'canceled', 'killed'])
const SYSTEM_MESSAGE_ENVELOPE = /^(?:The following is a <SYSTEM_MESSAGE> not actually sent by the user\.[^\r\n]*\r?\n\s*)?<SYSTEM_MESSAGE>([\s\S]*)<\/SYSTEM_MESSAGE>$/u
const WAKEUP_TASK_PATTERNS = [
  /(?:^|[\s=])Task\s+id\s*(?::\s*|\s+)["']?([^\s"'`,.;]+)["']?\s+(?:finished|completed|failed|exited|killed|cancelled|canceled|done)\b/giu,
  /\bBackground\s+(?:task|command|job|workflow)\s+(?:id\s*[:=]?\s*)?["']?([^\s"'`,.;]+)["']?\s+(?:finished|completed|failed|exited|killed|cancelled|canceled|done)\b/giu,
  /\bsender=([^\s,;]+)\b(?=[^\r\n]*\b(?:finished|completed|failed|exited|killed|cancelled|canceled)\b)/giu,
] as const

export interface AntigravitySystemWakeup {
  readonly isWakeup: boolean
  readonly completedTaskIds: readonly string[]
}

/**
 * Parses an incoming Antigravity `user_message_chunk` to distinguish a complete runtime `<SYSTEM_MESSAGE>` envelope
 * from user-pasted text and extract any background task IDs reported finished in the envelope header.
 */
export function parseAntigravitySystemWakeup(text: string): AntigravitySystemWakeup {
  const envelope = SYSTEM_MESSAGE_ENVELOPE.exec(text.trim())
  if (!envelope) return { isWakeup: false, completedTaskIds: [] }
  const body = envelope[1] ?? ''
  const cut = body.search(/\r?\n(?:Command output:|Log output:)/iu)
  const header = cut >= 0 ? body.slice(0, cut) : body
  const ids = new Set<string>()
  for (const pattern of WAKEUP_TASK_PATTERNS) {
    for (const match of header.matchAll(pattern)) {
      const id = match[1]?.trim()
      if (id) ids.add(id)
    }
  }
  return { isWakeup: true, completedTaskIds: [...ids] }
}

function backgroundHeaderText(outputText: string): string {
  const cut = outputText.search(/\r?\n(?:Task logs are available at:|Log output:)/iu)
  return cut >= 0 ? outputText.slice(0, cut) : outputText
}

const bounder = () => {
  let truncated = false
  return { bounded: (text: string): string => { if (text.length > MAX_ACTIVITY_TEXT) truncated = true; return text.slice(0, MAX_ACTIVITY_TEXT) }, truncated: () => truncated }
}
const where = (place: AntigravityPlace) => ({ turnId: place.turnId, ...(place.afterMessageId ? { afterMessageId: place.afterMessageId } : {}), cwd: place.cwd })
const firstString = (value: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined => {
  for (const key of keys) if (typeof value?.[key] === 'string' && (value[key] as string).trim()) return (value[key] as string).trim()
  return undefined
}
const normalizeToolStatus = (raw: unknown): 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | undefined => raw === 'completed' ? 'completed'
  : raw === 'failed' ? 'failed' : raw === 'interrupted' ? 'interrupted' : ['pending', 'in_progress'].includes(String(raw)) ? 'running' : undefined

interface ParsedToolFields {
  readonly input: Record<string, unknown> | undefined
  readonly output: Record<string, unknown> | undefined
  readonly texts: string[]
  readonly nativeKind: string | undefined
  readonly command: string | undefined
  readonly title: string | undefined
  readonly subagent: boolean
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown'
  readonly exitCode: unknown
  readonly outputText: string | undefined
}

function parseToolFields(update: Record<string, unknown>, old?: Pick<AgentActivity, 'title' | 'status' | 'command'>): ParsedToolFields {
  const input = object(update.rawInput)
  const output = object(update.rawOutput)
  const content = Array.isArray(update.content) ? update.content.map(object).filter(value => value !== undefined) : []
  const texts = content.flatMap(value => { const part = object(value.content); return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [] })
  const nativeKind = typeof update.kind === 'string' ? update.kind : undefined
  const command = antigravityCommand(update.rawInput) ?? (output ? firstString(output, ['commandLine', 'command_line']) : undefined) ?? old?.command
  const title = typeof update.title === 'string' ? update.title : old?.title
  const subagent = (nativeKind === undefined || nativeKind === 'other') && title !== undefined && SUBAGENT_TITLES.has(title) && object(update._meta)?.is_mcp_tool_call !== true
  const status = normalizeToolStatus(update.status) ?? old?.status ?? 'unknown'
  const exitCode = output?.exitCode ?? output?.exit_code
  const printed = firstString(output, ['combinedOutput', 'combined_output', 'stdout']) ?? ''
  const said = typeof update.rawOutput === 'string' && update.rawOutput.trim() ? update.rawOutput.trim() : undefined
  const outputText = texts.length ? texts.join('\n') : printed || said
  return { input, output, texts, nativeKind, command, title, subagent, status, exitCode, outputText }
}

/** Extracts background-execution signals from an Antigravity ACP `tool_call` or `tool_call_update` frame. */
export function antigravityToolCallSignal(update: Record<string, unknown>, key: string, old?: Pick<AgentActivity, 'title' | 'status' | 'command'>): AntigravityToolSignal | undefined {
  if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string') return undefined
  const fields = parseToolFields(update, old)
  const outputStatus = firstString(fields.output, ['status', 'state'])?.toLowerCase()
  const headerText = fields.outputText ? backgroundHeaderText(fields.outputText) : undefined
  const textTaskId = headerText
    ? AGY_BACKGROUND_HEADER.exec(headerText)?.[1] ?? TEXT_TASK_ID_PATTERN.exec(headerText)?.[1]
    : undefined
  const nativeTaskId = firstString(fields.output, TASK_ID_KEYS) ?? firstString(fields.input, ['TaskId', 'taskId', 'CommandId', 'commandId']) ?? textTaskId
  const action = firstString(fields.input, ['Action', 'action'])?.toLowerCase()
  const lowerTitle = fields.title?.toLowerCase() ?? ''
  const trimmedTitle = lowerTitle.trim()
  const canBackground = !NON_BACKGROUND_KINDS.has(fields.nativeKind ?? '')
  const isKill = (action === 'kill' || action === 'cancel' || lowerTitle.includes('cancel_')) && nativeTaskId !== undefined
  const isStatusTool = lowerTitle.includes('command_status') || ((lowerTitle.includes('manage_task') || canBackground && nativeTaskId !== undefined) && action === 'status')
  const isControlTool = isKill || isStatusTool || /\bmanage_task\b/iu.test(lowerTitle)
  const isScheduleTool = canBackground && fields.input?.IsDaemon !== true
    && (fields.input?.DurationSeconds !== undefined || fields.input?.CronExpression !== undefined || /^(?:run(?:ning)?\s+)?schedule(?:\s*\?|\b(?!\.\w))/iu.test(trimmedTitle))
  const isWorkflowTool = canBackground && (/^(?:run(?:ning)?\s+)?run_workflow\b/iu.test(trimmedTitle) || Boolean(fields.input?.ScriptPath || fields.input?.Script))
  const isCommand = fields.nativeKind === 'execute'
    || (canBackground && (fields.command !== undefined || /^(?:run(?:ning)?\s+)?(?:run_command|command_status|shell|terminal|bash)\b/iu.test(trimmedTitle)))
  const type: 'command' | 'subagent' | 'workflow' = fields.subagent ? 'subagent' : isWorkflowTool || isScheduleTool ? 'workflow' : 'command'

  const explicitOutputRunning = Boolean(
    (outputStatus && RUNNING_OUTPUT_STATUS.has(outputStatus))
    || fields.output?.background === true
    || fields.output?.running === true
    || fields.output?.async === true
  )
  const explicitTextRunning = Boolean(
    headerText && (AGY_BACKGROUND_HEADER.test(headerText) || AGY_STILL_RUNNING_HEADER.test(headerText))
  )
  const outputSaysRunning = explicitOutputRunning || explicitTextRunning || Boolean(
    headerText && RUNNING_TEXT_PATTERN.test(headerText) && !FINISHED_TEXT_PATTERN.test(headerText)
  )
  const outputSaysFinished = Boolean(
    Number.isSafeInteger(fields.exitCode)
    || (outputStatus && FINISHED_OUTPUT_STATUS.has(outputStatus))
    || (!explicitOutputRunning && !explicitTextRunning && headerText && (
      (isScheduleTool && /\b(?:cancelled|canceled|killed|not found|failed|error)\b/iu.test(headerText))
      || (isStatusTool && !outputSaysRunning && /\b(?:cancelled|canceled|killed|not found|no such (?:task|command|job)|already (?:finished|completed|exited))\b/iu.test(headerText))
    ))
  )
  const supportsBackgroundLaunch = isCommand || isWorkflowTool || isScheduleTool
  const inputBackground = fields.input?.IsBackground === true || fields.input?.isBackground === true || fields.input?.background === true
  const backgroundLaunch = !fields.subagent && supportsBackgroundLaunch && fields.status === 'completed' && !outputSaysFinished && !isStatusTool && !isKill && Boolean(
    inputBackground || outputSaysRunning || isScheduleTool || (isWorkflowTool && (inputBackground || outputSaysRunning))
  )
  const heuristic = backgroundLaunch || (fields.status === 'running' && inputBackground)
  const redactedCommand = fields.command ? shownCommand(splitCommandLine(fields.command)) || undefined : undefined
  const label = redactedCommand ?? firstString(fields.input, ['Description', 'description']) ?? fields.title
  const rawDuration = fields.input?.DurationSeconds
  const durationSeconds = isScheduleTool && fields.input?.CronExpression === undefined
    && typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined
  const killSucceeded = isKill && fields.status === 'completed' && outputStatus !== 'failed' && outputStatus !== 'error'

  return {
    toolCallId: update.toolCallId,
    activityId: antigravityToolId(key),
    type,
    isCommand,
    label,
    status: fields.status,
    pending: update.status === 'pending',
    isControlTool,
    isSubagent: fields.subagent,
    backgroundLaunch,
    heuristic,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(nativeTaskId ? { nativeTaskId } : {}),
    ...(killSucceeded ? { killTaskId: nativeTaskId } : {}),
    ...(isStatusTool && nativeTaskId ? { statusQueryRunning: outputSaysRunning && !outputSaysFinished, statusQueryFinished: outputSaysFinished } : {}),
  }
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
  const fields = parseToolFields(update, old)
  const content = Array.isArray(update.content) ? update.content.map(object).filter(value => value !== undefined) : []
  const changes = content.flatMap(value => value.type === 'diff' && typeof value.path === 'string'
    ? [{ path: bounded(value.path), kind: 'edit', diff: bounded(`--- before\n${typeof value.oldText === 'string' ? value.oldText : ''}\n+++ after\n${typeof value.newText === 'string' ? value.newText : ''}`) }] : [])
  const locations = Array.isArray(update.locations) ? update.locations.map(object).flatMap(value => typeof value?.path === 'string' ? [{ path: bounded(value.path), kind: typeof update.kind === 'string' ? update.kind : 'location' }] : []) : []
  const title = typeof fields.title === 'string' ? bounded(fields.title) : old?.title
  const kind = fields.subagent ? 'subagent' : fields.nativeKind === 'execute' || fields.command ? 'command'
    : ['edit', 'delete', 'move'].includes(fields.nativeKind ?? '') || changes.length ? 'file-change' : old?.kind ?? 'tool'
  const startedAt = fields.status === 'running' && !old?.startedAt ? new Date().toISOString() : undefined
  const cwd = firstString(fields.input, ['Cwd', 'WorkingDirectory', 'working_dir', 'workingDir', 'cwd'])
  const shownChanges = changes.length ? changes : locations
  return [{ ...where(place), ...old, id, sequence: old?.sequence ?? 0, kind, status: fields.status,
    title: title ?? 'Tool',
    ...(startedAt ? { startedAt, timingSource: 'observed' as const } : {}),
    ...(fields.command ? { command: bounded(fields.command) } : {}),
    ...(cwd ? { cwd: bounded(cwd) } : {}),
    ...(update.rawInput !== undefined && Object.keys(fields.input ?? {}).length ? { text: bounded(JSON.stringify(update.rawInput)) } : {}),
    ...(fields.outputText ? { output: bounded(fields.outputText) } : {}),
    ...(Number.isSafeInteger(fields.exitCode) ? { exitCode: fields.exitCode as number } : {}),
    ...(shownChanges.length ? { changes: shownChanges.slice(0, 200) } : {}),
    ...(fields.subagent ? { agents: [childAgent(place.key, fields.status, title, fields.input, old)] } : {}),
    ...acpToolMedia(capture, update.content, old),
    ...(truncated() || shownChanges.length > 200 ? { truncated: true } : {}),
  }]
}

type ChildAgent = NonNullable<AgentActivity['agents']>[number]
const SETTLED = new Set(['completed', 'failed', 'interrupted'])
/**
 * A subagent row's child, as the Agents pane shows it: its role, the prompt and model it was launched with, from the
 * `invoke_subagent` call's own input (`Role`, `Prompt`, `Model`). `agy` 1.5 runs a child detached, so the call ends at
 * once while the child works on: a finished launch leaves the child running until its answer is read from `agy`'s
 * records (`antigravityChildren.ts`), and a child already settled keeps what was read.
 */
function childAgent(key: string, status: string, title: string | undefined, input: Record<string, unknown> | undefined, old: AgentActivity | undefined): ChildAgent {
  const held = old?.agents?.[0]
  if (held && SETTLED.has(held.status)) return held
  const words = (field: string): string | undefined => firstString(input, [field])?.slice(0, MAX_ACTIVITY_TEXT)
  const role = words('Role') ?? held?.title, prompt = words('Prompt') ?? held?.prompt, model = words('Model') ?? held?.model
  const detached = status === 'completed' && (prompt !== undefined || title?.includes('invoke_subagent') === true)
  const next = detached ? 'running' : status, now = new Date().toISOString()
  // A child seen at work now is live: without the moment it was seen, the Agents pane reads it as last seen working.
  return { id: `antigravity-child-${key}`, status: next, title: role ?? title ?? 'Subagent',
    ...(prompt ? { prompt } : {}), ...(model && model !== 'inherit' ? { model } : {}),
    ...(next === 'running' ? { observedAt: now, startedAt: held?.startedAt ?? now, timingSource: 'observed' as const } : {}) }
}

/** The turn's one plan row: `agy` replaces its whole list on every plan update. */
function planRow(entries: readonly { text: unknown; status: unknown }[], place: AntigravityPlace, previous: readonly AgentActivity[]): AgentActivity[] {
  const steps = planSteps(entries)
  if (!steps.length) return []
  const id = `antigravity-plan-${place.turnId}`; const old = previous.find(row => row.id === id)
  return [{ ...where(place), ...old, id, sequence: old?.sequence ?? 0, kind: 'plan', status: 'running', title: 'Plan', steps, ...(entries.length > 200 ? { truncated: true } : {}) }]
}
