import { describe, expect, it } from 'vitest'
import { normalizeTerminalHook } from '../../../src/main/terminals/hooksNormalizer'
import { terminalAgentHookEventSchema } from '../../../src/main/terminals/hooksProtocol'

const binding = { terminalId: 'terminal-1', runId: 'run-1' }
const claude = (hook: string, extra: Record<string, unknown> = {}) => normalizeTerminalHook('claude', hook, {
  hook_event_name: hook, session_id: 'session-1', prompt_id: 'turn-1',
  prompt: 'SECRET_PROMPT', cwd: 'SECRET_CWD', transcript_path: 'SECRET_TRANSCRIPT', tool_input: { content: 'SECRET_CONTENT', file_path: 'SECRET_PATH' },
  last_assistant_message: 'SECRET_FINAL', ...extra,
}, binding)

describe('terminal hook normalization', () => {
  it('allows only identifiers and normalized state across Claude lifecycle hooks', () => {
    for (const hook of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd']) {
      const normalized = claude(hook)
      expect(normalized).not.toBeNull()
      expect(JSON.stringify(normalized)).not.toContain('SECRET')
      expect(normalized?.event.providerSessionId).toBe('session-1')
    }
  })
  it('holds only known tool approvals and leaves questions and mode changes native', () => {
    expect(claude('PermissionRequest', { tool_name: 'Write' })?.blocking).toBe(true)
    for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'UnknownTool', 'Bash']) {
      expect(claude('PermissionRequest', { tool_name: tool })).toBeNull()
    }
    expect(claude('PermissionRequest', { tool_name: 'Write', tool_input: [] })).toBeNull()
    for (const tool_input of [{}, { file_path: 42, content: 'text' }, { file_path: 'path', content: null }]) {
      expect(claude('PermissionRequest', { tool_name: 'Write', tool_input })).toBeNull()
    }
  })
  it('reports known continuing/background/session-cron Stops as Working without forwarding their bodies', () => {
    for (const extra of [{ stop_hook_active: true }, { background_tasks: [{ text: 'SECRET_TASK' }] }, { session_crons: [{ text: 'SECRET_CRON' }] }]) {
      const normalized = claude('Stop', extra)
      expect(normalized?.event).toMatchObject({ kind: 'working', state: 'working', workPhase: 'continuing' })
      expect(normalized?.blocking).toBe(false)
      expect(JSON.stringify(normalized)).not.toContain('SECRET')
      expect(terminalAgentHookEventSchema.safeParse(normalized?.event).success).toBe(true)
    }
  })
  it('rejects malformed Stop types even when another field reports continuing work', () => {
    for (const extra of [{ stop_hook_active: 'false' }, { stop_hook_active: 1 }, { background_tasks: 'unknown-shape' },
      { session_crons: {} }, { stop_hook_active: true, background_tasks: null }]) {
      expect(claude('Stop', extra)).toBeNull()
    }
  })
  it('allowlists explicit submit/tool phases and rejects unknown work metadata', () => {
    for (const [hook, phase] of [['UserPromptSubmit', 'submitted'], ['PreToolUse', 'tool-start'], ['PostToolUse', 'tool-end']]) {
      expect(claude(hook!)?.event.workPhase).toBe(phase)
    }
    expect(terminalAgentHookEventSchema.safeParse({ ...claude('PreToolUse')!.event, workPhase: 'SECRET_UNKNOWN' }).success).toBe(false)
  })
  it('admits only known notifications and no invalid provider IDs', () => {
    expect(claude('Notification', { notification_type: 'permission_prompt' })?.event.notificationType).toBe('permission_prompt')
    expect(claude('Notification', { notification_type: 'unknown' })).toBeNull()
    expect(claude('Stop', { session_id: 'a path / or content' })).toBeNull()
    expect(normalizeTerminalHook('claude', 'Stop', { hook_event_name: 'SessionEnd', session_id: 'session' }, binding)).toBeNull()
  })
  it('strips all Codex message bodies and accepts notify completion only', () => {
    const payload = { type: 'agent-turn-complete', 'thread-id': 'thread-1', 'turn-id': 'turn-1',
      cwd: 'SECRET_CWD', 'input-messages': ['SECRET_INPUT'], 'last-assistant-message': 'SECRET_OUTPUT', client: 'SECRET_CLIENT' }
    const normalized = normalizeTerminalHook('codex', undefined, payload, binding)
    expect(normalized?.event).toMatchObject({ kind: 'completed', state: 'idle', providerSessionId: 'thread-1', turnId: 'turn-1' })
    expect(JSON.stringify(normalized)).not.toContain('SECRET')
    expect(normalizeTerminalHook('codex', undefined, { ...payload, type: 'approval' }, binding)).toBeNull()
  })
})
