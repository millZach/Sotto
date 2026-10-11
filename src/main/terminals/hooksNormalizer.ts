import { randomUUID } from 'node:crypto'
import { terminalHookId, type TerminalAgentHookEvent } from './hooksProtocol'

interface HookBinding { terminalId: string; runId: string }
export interface NormalizedTerminalHook { event: TerminalAgentHookEvent; blocking: boolean }
const id = (value: unknown): string | undefined => {
  const parsed = terminalHookId.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Raw provider data is examined here only. The returned object cannot contain content. */
export function normalizeTerminalHook(provider: string, hookName: string | undefined, raw: unknown, binding: HookBinding): NormalizedTerminalHook | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const payload = raw as Record<string, unknown>
  const event: TerminalAgentHookEvent = { ...binding, eventId: randomUUID(), kind: 'working', state: 'working' }
  if (provider === 'codex') {
    if (payload.type !== 'agent-turn-complete') return null
    const session = id(payload['thread-id']), turn = id(payload['turn-id'])
    if (!session || !turn) return null
    return { event: { ...event, kind: 'completed', state: 'idle', providerSessionId: session, turnId: turn }, blocking: false }
  }
  if (provider !== 'claude' || payload.hook_event_name !== hookName) return null
  const session = id(payload.session_id)
  if (!session) return null
  event.providerSessionId = session
  const turn = id(payload.prompt_id)
  if (turn) event.turnId = turn
  switch (hookName) {
    case 'SessionStart': return { event: { ...event, kind: 'session-start', state: 'starting' }, blocking: false }
    case 'UserPromptSubmit': return { event: { ...event, workPhase: 'submitted' }, blocking: false }
    case 'PreToolUse': return { event: { ...event, workPhase: 'tool-start' }, blocking: false }
    case 'PostToolUse': return { event: { ...event, workPhase: 'tool-end' }, blocking: false }
    case 'PermissionRequest': {
      // Tool-mode/plan changes and AskUserQuestion have no supported answer shape.
      if (payload.tool_name !== 'Write' || typeof payload.tool_input !== 'object' ||
        payload.tool_input === null || Array.isArray(payload.tool_input)) return null
      const tool = payload.tool_input as Record<string, unknown>
      if (typeof tool.content !== 'string' || typeof tool.file_path !== 'string') return null
      return { event: { ...event, kind: 'permission', state: 'needs-you', requestId: randomUUID(), approvalId: randomUUID() }, blocking: true }
    }
    case 'Stop':
      if ((payload.stop_hook_active !== undefined && typeof payload.stop_hook_active !== 'boolean') ||
        (payload.background_tasks !== undefined && !Array.isArray(payload.background_tasks)) ||
        (payload.session_crons !== undefined && !Array.isArray(payload.session_crons))) return null
      if (payload.stop_hook_active === true ||
        (Array.isArray(payload.background_tasks) && payload.background_tasks.length !== 0) ||
        (Array.isArray(payload.session_crons) && payload.session_crons.length !== 0)) {
        return { event: { ...event, workPhase: 'continuing' }, blocking: false }
      }
      return { event: { ...event, kind: 'completed', state: 'idle' }, blocking: false }
    case 'StopFailure': return { event: { ...event, kind: 'cancelled', state: 'idle' }, blocking: false }
    case 'SessionEnd': return { event: { ...event, kind: 'ended', state: 'idle' }, blocking: false }
    case 'Notification': {
      const kind = payload.notification_type
      if (kind !== 'permission_prompt' && kind !== 'idle_prompt' && kind !== 'elicitation_dialog' && kind !== 'question') return null
      return { event: { ...event, kind: 'notification', state: kind === 'idle_prompt' ? 'idle' : 'needs-you', notificationType: kind }, blocking: false }
    }
    default: return null
  }
}
