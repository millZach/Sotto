// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { museItemActivity } from '../../../src/main/agents/museActivity'
import { museApprovalChoice, museApprovalPending, museUserInputAnswers, museUserInputPending, type MuseApproval, type MuseUserInput } from '../../../src/main/agents/museRequests'

const approval: MuseApproval = {
  approvalId: 'a1', sessionId: 's1', turnId: 't1', toolName: 'bash', toolCallId: 'c1', itemId: 'i1',
  rawArgs: '{"command":"ls"}', subject: { kind: 'shell', command: 'ls' }, streamSeq: 1, warnings: [],
  availableChoices: [
    { choiceId: 'once', decision: 'approved', label: 'Allow once', scope: 'once' },
    { choiceId: 'session', decision: 'approved', label: 'Allow for session', scope: 'session', rulePreview: 'bash ls' },
    { choiceId: 'always', decision: 'approved', label: 'Always allow', scope: 'localPersistent' },
    { choiceId: 'deny', decision: 'denied', label: 'Deny', scope: 'once' },
    { choiceId: 'stop', decision: 'abort', label: 'Stop the turn', scope: 'once' },
  ],
  currentRequirementId: { approvalId: 'a1', sourceIndex: 0 }, askedAt: '2026-10-12T00:00:00Z',
} as MuseApproval

describe('Muse approvals as Sotto shows them', () => {
  it('names the action from its subject and keeps the client’s choice labels', () => {
    const pending = museApprovalPending('thread', approval)
    expect(pending.request.text).toBe('Run a command: ls')
    expect(pending.request.permissionChoices?.map(choice => [choice.id, choice.kind])).toEqual([
      ['once', 'allow-once'], ['session', 'allow-session'], ['always', 'allow-always'], ['deny', 'deny'], ['stop', 'cancel'],
    ])
  })
  it('takes the one-time form of a plain allow or deny, never a wider one', () => {
    const pending = museApprovalPending('thread', approval)
    if (pending.kind !== 'approval') throw new Error('expected approval')
    expect(museApprovalChoice(pending, true)).toBe('once')
    expect(museApprovalChoice(pending, false)).toBe('deny')
    expect(museApprovalChoice(pending, undefined, 'session')).toBe('session')
    expect(() => museApprovalChoice(pending, true, 'deny')).toThrow()
  })
  it('reads a file action as a sentence', () => {
    const pending = museApprovalPending('thread', { ...approval, subject: { kind: 'fileAccess', path: '/etc/passwd', access: 'write' } })
    expect(pending.request.text).toBe('Write to /etc/passwd')
  })
})

const input: MuseUserInput = {
  userInputId: 'u1', sessionId: 's1', turnId: 't1', toolName: 'request_user_input',
  questions: [{ id: 'color', header: 'Color', question: 'Which color?', selection: { mode: 'single' },
    options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue' }] }],
} as MuseUserInput

describe('Muse questions and their answers', () => {
  it('shows the question and answers by label', () => {
    const pending = museUserInputPending('thread', input)
    expect(pending.request.text).toBe('Which color?')
    if (pending.kind !== 'userInput') throw new Error('expected question')
    expect(museUserInputAnswers(pending, 'Blue')).toEqual([{ questionId: 'color', selectedLabel: 'Blue' }])
    expect(museUserInputAnswers(pending, 'Green')).toEqual([{ questionId: 'color', freeText: 'Green' }])
  })
})

describe('Muse items as activity', () => {
  it('reads a shell call as a command and a file write as a change', () => {
    const shell = museItemActivity({ itemId: 'i1', kind: 'toolCall', status: 'completed', revision: 1, tool: 'bash', args: '{"command":"ls -la"}', visibleOutput: 'ok' }, 'turn')
    expect(shell).toMatchObject({ kind: 'command', command: 'ls -la', output: 'ok', status: 'completed' })
    const write = museItemActivity({ itemId: 'i2', kind: 'toolCall', status: 'inProgress', revision: 1, tool: 'write_file', args: '{"path":"src/a.ts","content":"x"}' }, 'turn')
    expect(write).toMatchObject({ kind: 'file-change', status: 'running', changes: [{ path: 'src/a.ts', kind: 'write_file' }] })
  })
  it('keeps reminder children and unknown kinds honest', () => {
    expect(museItemActivity({ itemId: 'i3', kind: 'reminderChild', status: 'completed', revision: 1 }, 'turn')).toBeUndefined()
    const future = museItemActivity({ itemId: 'i4', kind: 'someFutureKind', status: 'completed', revision: 1, fallbackText: 'Did a future thing' }, 'turn')
    expect(future).toMatchObject({ kind: 'status', title: 'Did a future thing' })
  })
})
