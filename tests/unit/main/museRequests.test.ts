// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { agentRequestSchema } from '../../../src/shared/agents'
import { museItemActivity } from '../../../src/main/agents/museActivity'
import { museApprovalChoice, museApprovalPending, museToolAdmission, museToolName, museUserInputAnswers, museUserInputPending, type MuseApproval, type MuseUserInput } from '../../../src/main/agents/museRequests'

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
  it.each(['session', 'localPersistent'])('requires an explicit choice for a %s grant without allow once', scope => {
    const pending = museApprovalPending('thread', { ...approval, availableChoices: approval.availableChoices.filter(choice => choice.scope === scope || choice.decision === 'denied') })
    if (pending.kind !== 'approval') throw new Error('expected approval')
    expect(() => museApprovalChoice(pending, true)).toThrow('Muse did not offer a way to allow this.')
    expect(museApprovalChoice(pending, false)).toBe('deny')
    const explicit = scope === 'session' ? 'session' : 'always'
    expect(museApprovalChoice(pending, undefined, explicit)).toBe(explicit)
    expect(museApprovalChoice(pending, true, explicit)).toBe(explicit)
    expect(() => museApprovalChoice(pending, false, explicit)).toThrow('Explicit approval must match')
  })
  it('does not classify an unknown grant scope or decision as a sendable choice', () => {
    const pending = museApprovalPending('thread', { ...approval, availableChoices: [
      { choiceId: 'unknown-scope', decision: 'approved', label: 'Allow', scope: 'futureScope' },
      { choiceId: 'unknown-decision', decision: 'futureDecision', label: 'Choose', scope: 'once' },
      approval.availableChoices.find(choice => choice.choiceId === 'deny')!,
    ] })
    if (pending.kind !== 'approval') throw new Error('expected approval')
    expect(pending.request.permissionChoices?.map(choice => choice.id)).toEqual(['deny'])
    expect(() => museApprovalChoice(pending, true)).toThrow()
    expect(() => museApprovalChoice(pending, undefined, 'unknown-scope')).toThrow('not offered')
    expect(() => museApprovalChoice(pending, undefined, 'unknown-decision')).toThrow('not offered')
    expect(museApprovalChoice(pending, false)).toBe('deny')
  })
  it('requires an explicit choice for a persistent denial and prefers the one-time denial when both exist', () => {
    const persistent = { choiceId: 'deny-always', decision: 'deniedPolicyAmendment', label: 'Always deny', scope: 'localPersistent' }
    const once = approval.availableChoices.find(choice => choice.choiceId === 'deny')!
    const pending = museApprovalPending('thread', { ...approval, availableChoices: [persistent, once] })
    if (pending.kind !== 'approval') throw new Error('expected approval')
    expect(museApprovalChoice(pending, false)).toBe('deny')
    const onlyPersistent = museApprovalPending('thread', { ...approval, availableChoices: [persistent] })
    if (onlyPersistent.kind !== 'approval') throw new Error('expected approval')
    expect(() => museApprovalChoice(onlyPersistent, false)).toThrow('Muse did not offer a way to deny this.')
    expect(museApprovalChoice(onlyPersistent, false, 'deny-always')).toBe('deny-always')
    expect(museApprovalChoice(onlyPersistent, undefined, 'deny-always')).toBe('deny-always')
  })
  it('does not use a broader cancellation as a plain denial', () => {
    const pending = museApprovalPending('thread', { ...approval, availableChoices: [{ choiceId: 'stop', decision: 'abort', label: 'Stop', scope: 'session' }] })
    if (pending.kind !== 'approval') throw new Error('expected approval')
    expect(() => museApprovalChoice(pending, false)).toThrow('Muse did not offer a way to deny this.')
    expect(museApprovalChoice(pending, false, 'stop')).toBe('stop')
  })
  it('refuses contradictory decision scopes instead of presenting a policy amendment as one-time', () => {
    const contradictory = [
      { choiceId: 'allow-policy', decision: 'approvedPolicyAmendment', label: 'Allow', scope: 'once' },
      { choiceId: 'allow-session', decision: 'approvedForSession', label: 'Allow', scope: 'once' },
      { choiceId: 'deny-policy', decision: 'deniedPolicyAmendment', label: 'Deny', scope: 'once' },
    ]
    const pending = museApprovalPending('thread', { ...approval, availableChoices: [...contradictory, ...approval.availableChoices] })
    if (pending.kind !== 'approval') throw new Error('expected approval')
    expect(pending.request.permissionChoices?.map(choice => choice.id)).toEqual(approval.availableChoices.map(choice => choice.choiceId))
    expect(museApprovalChoice(pending, true)).toBe('once')
    expect(museApprovalChoice(pending, false)).toBe('deny')
    for (const choice of contradictory) expect(() => museApprovalChoice(pending, undefined, choice.choiceId)).toThrow('not offered')
  })
  it('preserves explicit known session and persistent decisions with their matching scopes', () => {
    const pending = museApprovalPending('thread', { ...approval, availableChoices: [
      { choiceId: 'session', decision: 'approvedForSession', label: 'Allow for session', scope: 'session' },
      { choiceId: 'always', decision: 'approvedPolicyAmendment', label: 'Always allow', scope: 'localPersistent' },
    ] })
    if (pending.kind !== 'approval') throw new Error('expected approval')
    expect(museApprovalChoice(pending, true, 'session')).toBe('session')
    expect(museApprovalChoice(pending, true, 'always')).toBe('always')
    expect(() => museApprovalChoice(pending, true)).toThrow('Muse did not offer a way to allow this.')
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

function pendingInput(value: MuseUserInput = input): Extract<ReturnType<typeof museUserInputPending>, { kind: 'userInput' }> {
  const pending = museUserInputPending('thread', value)
  if (pending.kind !== 'userInput') throw new Error('expected question')
  return pending
}

describe('Muse questions and their answers', () => {
  it('shows the question and answers by label', () => {
    const pending = museUserInputPending('thread', input)
    expect(pending.request.text).toBe('Which color?')
    if (pending.kind !== 'userInput') throw new Error('expected question')
    expect(museUserInputAnswers(pending, 'Blue')).toEqual([{ questionId: 'color', selectedLabel: 'Blue' }])
    expect(museUserInputAnswers(pending, 'Green')).toEqual([{ questionId: 'color', freeText: 'Green' }])
  })
  it('gives long labels unique bounded IDs and answers with their original text', () => {
    const prefix = 'x'.repeat(600)
    const labels = [`${prefix} first`, `${prefix} second`]
    const value: MuseUserInput = { ...input, questions: [{ ...input.questions[0]!, options: labels.map(label => ({ label })) }] }
    const pending = pendingInput(value)
    const options = pending.request.questions![0]!.options
    expect(agentRequestSchema.safeParse(pending.request).success).toBe(true)
    expect(options.map(option => option.label)).toEqual(['x'.repeat(500), 'x'.repeat(500)])
    expect(options.map(option => option.id)).toEqual(['option-0', 'option-1'])
    expect(pendingInput(value).request.questions![0]!.options.map(option => option.id)).toEqual(options.map(option => option.id))
    expect(museUserInputAnswers(pending, '', { color: { optionIds: [options[1]!.id] } })).toEqual([{ questionId: 'color', selectedLabel: labels[1] }])
    expect(museUserInputAnswers(pending, labels[0]!)).toEqual([{ questionId: 'color', selectedLabel: labels[0] }])
    expect(museUserInputAnswers(pending, options[0]!.label)).toEqual([{ questionId: 'color', freeText: 'x'.repeat(500) }])
  })
  it('preserves duplicate native labels without colliding option IDs', () => {
    const pending = pendingInput({ ...input, questions: [{ ...input.questions[0]!, selection: { mode: 'multiple' }, options: [{ label: 'Same' }, { label: 'Same' }] }] })
    const options = pending.request.questions![0]!.options
    expect(new Set(options.map(option => option.id)).size).toBe(2)
    expect(museUserInputAnswers(pending, '', { color: { optionIds: options.map(option => option.id) } })).toEqual([{ questionId: 'color', selectedLabels: ['Same', 'Same'] }])
    expect(museUserInputAnswers(pending, 'Same')).toEqual([{ questionId: 'color', selectedLabels: ['Same'] }])
  })
  it.each([undefined, { optionIds: [] }, { optionIds: [], text: '  ' }])('represents an unanswered optional question in every native answer entry (%j)', optional => {
    const pending = pendingInput({ ...input, questions: [input.questions[0]!,
      { ...input.questions[0]!, id: 'single', selection: { mode: 'single', minSelections: 0 } },
      { ...input.questions[0]!, id: 'multiple', selection: { mode: 'multiple', minSelections: 0 } },
    ] })
    expect(museUserInputAnswers(pending, '', {
      color: { optionIds: ['option-1'] },
      ...(optional ? { single: optional, multiple: optional } : {}),
    })).toEqual([
      { questionId: 'color', selectedLabel: 'Blue' },
      { questionId: 'single', freeText: '' },
      { questionId: 'multiple', selectedLabels: [] },
    ])
  })
  it('allows an answered optional question and keeps selection notes', () => {
    const pending = pendingInput({ ...input, questions: [{ ...input.questions[0]!, selection: { mode: 'multiple', minSelections: 0 } }] })
    expect(museUserInputAnswers(pending, '', { color: { optionIds: ['option-0', 'option-1'], text: '  Both work  ' } })).toEqual([{ questionId: 'color', selectedLabels: ['Red', 'Blue'], note: 'Both work' }])
    expect(museUserInputAnswers(pending, '', { color: { optionIds: [], text: '  Green  ' } })).toEqual([{ questionId: 'color', freeText: 'Green' }])
  })
  it('requires answers to mandatory questions and refuses unknown or repeated selections', () => {
    const pending = pendingInput()
    expect(() => museUserInputAnswers(pending, '', {})).toThrow('Answer every question once.')
    expect(() => museUserInputAnswers(pending, '', { color: { optionIds: [] } })).toThrow('Answer every question.')
    expect(() => museUserInputAnswers(pending, '', { color: { optionIds: ['unknown'] } })).toThrow('Choose an offered question option.')
    expect(() => museUserInputAnswers(pending, '', { color: { optionIds: ['option-0', 'option-0'] } })).toThrow('Answer every question once.')
    expect(() => museUserInputAnswers(pending, '', { color: { optionIds: ['option-0', 'option-1'] } })).toThrow('Choose one option')
    expect(() => museUserInputAnswers(pending, '', { other: { optionIds: [] } })).toThrow('The question changed.')
  })
  it('checks multiple-selection bounds while preserving free text as an independent answer', () => {
    const pending = pendingInput({ ...input, questions: [{ ...input.questions[0]!, selection: { mode: 'multiple', minSelections: 2, maxSelections: 2 }, options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }] }] })
    expect(() => museUserInputAnswers(pending, '', { color: { optionIds: ['option-0'], text: 'One is enough' } })).toThrow('Choose at least 2 options')
    expect(() => museUserInputAnswers(pending, '', { color: { optionIds: ['option-0', 'option-1', 'option-2'] } })).toThrow('Choose no more than 2 options')
    expect(museUserInputAnswers(pending, '', { color: { optionIds: ['option-0', 'option-2'] } })).toEqual([{ questionId: 'color', selectedLabels: ['Red', 'Green'] }])
    expect(museUserInputAnswers(pending, '', { color: { optionIds: [], text: 'Yellow' } })).toEqual([{ questionId: 'color', freeText: 'Yellow' }])
  })
  it('refuses oversized free text and notes before dispatch while preserving answers at the native limit', () => {
    const pending = pendingInput()
    const accepted = 'a'.repeat(500)
    expect(museUserInputAnswers(pending, accepted)).toEqual([{ questionId: 'color', freeText: accepted }])
    expect(museUserInputAnswers(pending, '', { color: { optionIds: ['option-0'], text: accepted } })).toEqual([{ questionId: 'color', selectedLabel: 'Red', note: accepted }])
    expect(() => museUserInputAnswers(pending, 'a'.repeat(501))).toThrow('Muse accepts up to 500 characters for an answer. Nothing was sent.')
    expect(() => museUserInputAnswers(pending, '', { color: { optionIds: ['option-0'], text: 'a'.repeat(501) } })).toThrow('Muse accepts up to 500 characters for a note. Nothing was sent.')
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

describe('Muse prompts for Sotto’s own tools', () => {
  const own = new Set([museToolName('sotto_browser', 'browser_open'), museToolName('sotto_visual', 'visualize')])
  const tool = (toolName: string, extra: Partial<MuseApproval> = {}): MuseApproval => ({ ...approval, toolName, subject: { kind: 'tool', toolName }, ...extra })
  it('names tools as Muse does', () => {
    expect(museToolName('sotto_browser', 'browser_open')).toBe('mcp__sotto_browser__browser_open')
    expect(museToolName('sotto-browser', 'open.page')).toBe('mcp__sotto_browser__open_page')
  })
  it('answers a call to a tool this session was given with the one-time allow and nothing wider', () => {
    expect(museToolAdmission(tool('mcp__sotto_browser__browser_open'), own)).toBe('once')
    expect(museToolAdmission(tool('mcp__sotto_visual__visualize'), own)).toBe('once')
  })
  it('leaves every other subject for the user', () => {
    expect(museToolAdmission(approval, own)).toBeUndefined()
    expect(museToolAdmission(tool('mcp__sotto_browser__browser_delete_everything'), own)).toBeUndefined()
    expect(museToolAdmission(tool('mcp__someone_else__browser_open'), own)).toBeUndefined()
    expect(museToolAdmission(tool('mcp__sotto_browser__browser_open_extra'), own)).toBeUndefined()
    expect(museToolAdmission({ ...approval, toolName: 'mcp__sotto_browser__browser_open', subject: { kind: 'shell', command: 'mcp__sotto_browser__browser_open' } }, own)).toBeUndefined()
    expect(museToolAdmission({ ...tool('mcp__sotto_browser__browser_open'), subject: { kind: 'tool' } }, own)).toBeUndefined()
    expect(museToolAdmission(tool('mcp__sotto_browser__browser_open'), new Set())).toBeUndefined()
  })
  it('leaves a call with no one-time allow for the user', () => {
    const wider = tool('mcp__sotto_browser__browser_open', { availableChoices: approval.availableChoices.filter(choice => choice.scope !== 'once' || choice.decision !== 'approved') })
    expect(museToolAdmission(wider, own)).toBeUndefined()
  })
})
