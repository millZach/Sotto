// @vitest-environment node
import { expect, it } from 'vitest'
import { claudePending, claudeAnswer } from '../../../src/main/agents/claudeRequests'
import { pendingRequest, answerRequest } from '../../../src/main/agents/codexRequests'
import { grokPending, grokAnswer } from '../../../src/main/agents/grokRequests'

it('Claude exposes every question and round-trips selections plus free text to original keys', () => {
  const pending = claudePending({ type: 'control_request', request_id: 'request', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'tool', input: { questions: [
    { question: 'Choose colors', header: 'Colors', multiSelect: true, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue' }] }, { question: 'Name?' },
  ] } } })!
  expect(pending.request.questions).toHaveLength(2)
  expect(pending.request.questions?.[0]).toMatchObject({ multiSelect: true, allowFreeText: true, options: [{ id: 'Red', label: 'Red', description: 'Warm' }, { id: 'Blue', label: 'Blue' }] })
  expect(claudeAnswer(pending, '', undefined, { '0': { optionIds: ['Red', 'Blue'] }, '1': { optionIds: [], text: 'Zach' } })).toMatchObject({ updatedInput: { answers: { 'Choose colors': 'Red, Blue', 'Name?': 'Zach' } } })
  expect(() => claudeAnswer(pending, '', undefined, { '0': { optionIds: ['invented'] } })).toThrow()
})
it('Codex retains question ids and only offers actual decisions', () => {
  const pending = pendingRequest(3, 'item/tool/requestUserInput', { threadId: 't', questions: [{ id: 'q1', question: 'First?', options: [{ label: 'A', description: 'Detail' }] }, { id: 'q2', question: 'Second?', options: null }] }, 't')!
  expect(pending.request.questions?.map(q => q.id)).toEqual(['q1', 'q2'])
  expect(answerRequest(pending, '', undefined, { q1: { optionIds: ['A'] }, q2: { optionIds: [], text: 'free' } })).toEqual({ answers: { q1: { answers: ['A'] }, q2: { answers: ['free'] } } })
  const permission = pendingRequest(4, 'item/commandExecution/requestApproval', { threadId: 't', command: 'echo ok', availableDecisions: ['acceptForSession', 'cancel'] }, 't')!
  expect(permission.request.permissionChoices?.map(choice => choice.id)).toEqual(['acceptForSession', 'cancel'])
  expect(answerRequest(permission, '', true, undefined, 'acceptForSession')).toEqual({ decision: 'acceptForSession' })
  expect(() => answerRequest(permission, '', true, undefined, 'accept')).toThrow()
})
it('Grok round-trips exact options and annotations, rejecting broadened or mismatched approvals', () => {
  const pending = grokPending('id', 'x.ai/ask_user_question', { sessionId: 'native', toolCallId: 'tool', questions: [{ question: 'Which?', options: [{ label: 'One', description: 'First' }], multiSelect: true }, { question: 'Why?', options: [] }] }, 'thread')!
  expect(pending.request.questions).toHaveLength(2)
  expect(grokAnswer(pending, '', undefined, { '0': { optionIds: ['One'], text: 'also two' }, '1': { optionIds: [], text: 'reason' } })).toEqual({ outcome: 'accepted', answers: { 'Which?': ['One', 'Other'], 'Why?': ['Other'] }, annotations: { 'Which?': { notes: 'also two' }, 'Why?': { notes: 'reason' } } })
  const permission = grokPending(2, 'session/request_permission', { sessionId: 'native', toolCall: { toolCallId: 'tool', title: 'Run', rawInput: { command: 'echo hi' } }, options: [{ optionId: 'once', name: 'Just once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] }, 'thread')!
  expect(grokAnswer(permission, '', true, undefined, 'once')).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  expect(() => grokAnswer(permission, '', false, undefined, 'once')).toThrow()
  expect(() => grokAnswer(permission, '', true, undefined, 'always')).toThrow()
})
it('Codex offers exact native rule and permission-profile choices without renderer-supplied grants', () => {
  const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } }
  const pending = pendingRequest(1, 'item/commandExecution/requestApproval', { threadId: 't', availableDecisions: [decision, 'decline'], command: 'git status' }, 't')!
  const choice = pending.request.permissionChoices!.find(choice => choice.kind === 'allow-always')!
  expect(choice).toBeDefined()
  expect(answerRequest(pending, '', true, undefined, choice.id)).toEqual({ decision })
  const permissions = { fileSystem: { read: ['/synthetic'] }, network: { enabled: false } }
  const profile = pendingRequest(2, 'item/permissions/requestApproval', { threadId: 't', permissions, cwd: '/synthetic' }, 't')!
  expect(answerRequest(profile, '', true, undefined, 'allow-turn')).toEqual({ permissions, scope: 'turn' })
  expect(() => answerRequest(profile, '', true, undefined, 'invented')).toThrow()
})
it('Codex string elicitation exposes every field and preserves native enum values', () => {
  const pending = pendingRequest(1, 'mcpServer/elicitation/request', { threadId: 't', mode: 'form', requestedSchema: { type: 'object', properties: { color: { type: 'string', enum: ['b'], enumNames: ['Blue'] }, reason: { type: 'string' } }, required: ['color', 'reason'] } }, 't')!
  expect(pending.request.questions?.map(q => q.id)).toEqual(['color', 'reason'])
  expect(answerRequest(pending, '', undefined, { color: { optionIds: ['b'] }, reason: { optionIds: [], text: 'Why' } })).toEqual({ action: 'accept', content: { color: 'b', reason: 'Why' } })
})
