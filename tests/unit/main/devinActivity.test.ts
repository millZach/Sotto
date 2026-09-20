// @vitest-environment node
import { expect, it } from 'vitest'
import { devinActivities } from '../../../src/main/agents/devinActivity'
import { agentActivitySchema, MAX_ACTIVITY_TEXT } from '../../../src/shared/agentActivity'
const context = { turnId: 'turn', afterMessageId: 'message', cwd: '/project' }

it('preserves an ACP tool action when later completion supplies only status and output', () => {
  const started = devinActivities({ sessionUpdate: 'tool_call', toolCallId: 'exec', kind: 'execute', title: 'Check project', status: 'in_progress', rawInput: { command: 'git status' } }, context)
  const ended = devinActivities({ sessionUpdate: 'tool_call_update', toolCallId: 'exec', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Clean' } }], rawOutput: { exit_code: 0 } }, context, started)
  expect(ended[0]).toMatchObject({ id: 'devin-tool-exec', kind: 'command', status: 'completed', command: 'git status', output: 'Clean', exitCode: 0, afterMessageId: 'message' })
  expect(agentActivitySchema.safeParse(ended[0]).success).toBe(true)
})
it('keeps file paths and bounded diff content in existing activity rows', () => {
  const rows = devinActivities({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit', kind: 'edit', status: 'pending', rawInput: { file_path: '/project/file', content: 'new' }, content: [{ type: 'diff', path: '/project/file', oldText: 'old', newText: 'x'.repeat(MAX_ACTIVITY_TEXT + 1) }] }, context)
  expect(rows[0]).toMatchObject({ kind: 'file-change', truncated: true, changes: [{ path: '/project/file', kind: 'edit' }] })
  expect(rows[0]!.changes![0]!.diff).toHaveLength(MAX_ACTIVITY_TEXT)
  expect(agentActivitySchema.safeParse(rows[0]).success).toBe(true)
})
it('bounds a native plan and does not interpret unknown notifications as activity', () => {
  const rows = devinActivities({ sessionUpdate: 'plan', entries: Array.from({ length: 205 }, () => ({ content: 'Step', status: 'completed' })) }, context)
  expect(rows[0]!.steps).toHaveLength(200)
  expect(rows[0]!.truncated).toBe(true)
  expect(devinActivities({ sessionUpdate: '_cognition.ai/agent_stopped' }, context)).toEqual([])
})
