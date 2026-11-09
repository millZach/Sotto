// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { agentCommandSchema } from '../../../src/shared/agents'
import { requestDraftSchema } from '../../../src/shared/requestDrafts'
import { claudeAnswer, claudePending } from '../../../src/main/agents/providers/claude/claudeRequests'
import { answerRequest, pendingRequest } from '../../../src/main/agents/providers/codex/codexRequests'
import { cursorAnswer, cursorPending } from '../../../src/main/agents/cursorRequests'
import { devinAnswer, devinPending } from '../../../src/main/agents/devinRequests'
import { grokAnswer, grokPending } from '../../../src/main/agents/grokRequests'
import { museUserInputAnswers, museUserInputPending, type MuseUserInput } from '../../../src/main/agents/museRequests'
import { QUESTION_SKIPPED } from '../../../src/main/agents/nativeRequests'
import { opencodeFormAnswer, opencodeFormPending, opencodeFormSchema } from '../../../src/main/agents/opencodeRequests'

const skip = { optionIds: [], skipped: true as const }

describe('a skipped question on the wire (ADR-0135, November 6, 2026)', () => {
  it('takes a skip on one question, with no choice or words beside it', () => {
    const answer = { type: 'answer', threadId: 'thread', requestId: 'request', answer: '' } as const
    expect(agentCommandSchema.parse({ ...answer, questionAnswers: { a: { optionIds: ['x'] }, b: skip } })).toMatchObject({ questionAnswers: { b: { skipped: true } } })
    expect(agentCommandSchema.safeParse({ ...answer, questionAnswers: { b: { optionIds: ['x'], skipped: true } } }).success).toBe(false)
    expect(agentCommandSchema.safeParse({ ...answer, questionAnswers: { b: { optionIds: [], text: 'words', skipped: true } } }).success).toBe(false)
  })

  it('keeps a skip in a saved draft only on a question its adapter marked skippable', () => {
    const target = { kind: 'thread', ownerId: 'thread', providerId: 'claude', requestId: 'request', questions: [
      { id: 'a', question: 'A?', options: [], multiSelect: false, allowFreeText: true, skippable: true },
      { id: 'b', question: 'B?', options: [], multiSelect: false, allowFreeText: true }] } as const
    const draft = (selections: Record<string, unknown>) => requestDraftSchema.safeParse({ target, revision: 1, held: false, selections })
    expect(draft({ a: { optionIds: [], other: false, text: '', skipped: true } }).success).toBe(true)
    expect(draft({ b: { optionIds: [], other: false, text: '', skipped: true } }).success).toBe(false)
    expect(draft({ a: { optionIds: [], other: false, text: 'words', skipped: true } }).success).toBe(false)
  })
})

describe('what each provider is told about a question skipped on its own', () => {
  it('Claude Code: the skip sentence as that question’s answer', () => {
    const pending = claudePending({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 't', input: { questions: [
      { question: 'Fix it now?', options: [{ label: 'Wait' }, { label: 'Now' }] }, { question: 'Which key?', options: [{ label: 'Staging' }] }] } } })!
    expect(pending.request.questions?.every(question => question.skippable === true)).toBe(true)
    expect(claudeAnswer(pending, '', undefined, { '0': { optionIds: ['Wait'] }, '1': skip }))
      .toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Fix it now?': 'Wait', 'Which key?': QUESTION_SKIPPED } } })
  })

  it('Codex: a note saying so, where Codex’s own app sends nothing', () => {
    const pending = pendingRequest(3, 'item/tool/requestUserInput', { threadId: 't', questions: [{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }, { id: 'q2', question: 'Second?', options: null }] }, 't')!
    expect(pending.request.questions?.every(question => question.skippable === true)).toBe(true)
    expect(answerRequest(pending, '', undefined, { q1: { optionIds: ['A'] }, q2: skip })).toEqual({ answers: { q1: { answers: ['A'] }, q2: { answers: [`user_note: ${QUESTION_SKIPPED}`] } } })
  })

  it('a Codex tool’s form: words a field takes, left out where it may be, and no Skip on a required choice, number, yes or no, or formatted field', () => {
    const pending = pendingRequest('f', 'mcpServer/elicitation/request', { threadId: 't', mode: 'form', message: 'Details', requestedSchema: { type: 'object', required: ['name', 'mode', 'count', 'ok', 'email', 'short'], properties: {
      name: { type: 'string' }, note: { type: 'string' }, mode: { type: 'string', enum: ['quick', 'full'] }, count: { type: 'integer' }, ok: { type: 'boolean' },
      email: { type: 'string', format: 'email' }, short: { type: 'string', maxLength: 10 } } } }, 't')!
    const marked = Object.fromEntries((pending.request.questions ?? []).map(question => [question.id, question.skippable === true]))
    expect(marked).toEqual({ name: true, note: true, mode: false, count: false, ok: false, email: false, short: false })
    expect(answerRequest(pending, '', undefined, { name: skip, note: skip, mode: { optionIds: ['quick'] }, count: { optionIds: [], text: '2' }, ok: { optionIds: ['true'] },
      email: { optionIds: [], text: 'a@b.c' }, short: { optionIds: [], text: 'hi' } }))
      .toEqual({ action: 'accept', content: { name: QUESTION_SKIPPED, mode: 'quick', count: 2, ok: true, email: 'a@b.c', short: 'hi' } })
    expect(() => answerRequest(pending, '', undefined, { name: { optionIds: [], text: 'x' }, mode: skip, count: { optionIds: [], text: '2' }, ok: { optionIds: ['true'] },
      email: { optionIds: [], text: 'a@b.c' }, short: { optionIds: [], text: 'hi' } })).toThrow('cannot be skipped on its own')
  })

  it('Cursor: left out, as Cursor sends a question the user passed over', () => {
    const pending = cursorPending('q', 'cursor/ask_question', { toolCallId: 'c', title: 'Pick', questions: [
      { id: 'q1', prompt: 'Color?', options: [{ id: 'b', label: 'Blue' }], allowMultiple: false },
      { id: 'q2', prompt: 'Size?', options: [{ id: 's', label: 'Small' }], allowMultiple: false }] }, 'thread')!
    expect(pending.request.questions?.every(question => question.skippable === true)).toBe(true)
    expect(cursorAnswer(pending, '', undefined, { q1: { optionIds: ['b'] }, q2: skip })).toEqual({ outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }] } })
  })

  it('Grok Build: its own Other answer with the skip sentence as the note, so the turn goes on', () => {
    const pending = grokPending('id', 'x.ai/ask_user_question', { sessionId: 'n', toolCallId: 't', questions: [
      { question: 'Which?', options: [{ label: 'One' }] }, { question: 'Why?', options: [] }] }, 'thread')!
    expect(pending.request.skippable).toBeUndefined()
    expect(pending.request.questions?.every(question => question.skippable === true)).toBe(true)
    expect(grokAnswer(pending, '', undefined, { '0': { optionIds: ['One'] }, '1': skip }))
      .toEqual({ outcome: 'accepted', answers: { 'Which?': ['One'], 'Why?': ['Other'] }, annotations: { 'Why?': { notes: QUESTION_SKIPPED } } })
  })

  it('Muse: the skip sentence in words, which Muse takes for any question', () => {
    const pending = museUserInputPending('thread', { userInputId: 'u', sessionId: 's', turnId: 't', toolName: 'request_user_input', questions: [
      { id: 'color', question: 'Which color?', selection: { mode: 'single' }, options: [{ label: 'Red' }] },
      { id: 'sizes', question: 'Which sizes?', selection: { mode: 'multiple', minSelections: 1 }, options: [{ label: 'S' }] }] } as MuseUserInput)
    if (pending.kind !== 'userInput') throw new Error('expected a question')
    expect(museUserInputAnswers(pending, '', { color: { optionIds: ['option-0'] }, sizes: skip }))
      .toEqual([{ questionId: 'color', selectedLabel: 'Red' }, { questionId: 'sizes', freeText: QUESTION_SKIPPED }])
  })

  it('Devin: words a required field takes, left out where it may be, and no Skip on a required choice', () => {
    const pending = devinPending('q', 'elicitation/create', { mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: {
      color: { type: 'string', oneOf: [{ const: 'b', title: 'Blue' }] }, reason: { type: 'string' }, optional: { type: 'string' }, tight: { type: 'string', maxLength: 8 },
    }, required: ['color', 'reason', 'tight'] } }, 'thread')!
    expect(Object.fromEntries((pending.request.questions ?? []).map(question => [question.id, question.skippable === true])))
      .toEqual({ color: false, reason: true, optional: true, tight: false })
    expect(devinAnswer(pending, '', undefined, { color: { optionIds: ['b'] }, reason: skip, optional: skip, tight: { optionIds: [], text: 'ok' } }))
      .toEqual({ action: 'accept', content: { color: 'b', reason: QUESTION_SKIPPED, tight: 'ok' } })
  })

  it('OpenCode: words a text field takes, left out where it may be, and no Skip on a required yes or no', () => {
    const pending = opencodeFormPending('thread', opencodeFormSchema.parse({ id: 'f', sessionID: 's', title: 'Q', fields: [
      { key: 'why', type: 'string' }, { key: 'ok', type: 'boolean' }, { key: 'extra', type: 'string', required: false }, { key: 'code', type: 'string', pattern: '^[0-9]+$' }] }))!
    expect(Object.fromEntries((pending.request.questions ?? []).map(question => [question.id, question.skippable === true])))
      .toEqual({ why: true, ok: false, extra: true, code: false })
    expect(opencodeFormAnswer(pending, '', { why: skip, ok: { optionIds: ['option-0'] }, extra: skip, code: { optionIds: [], text: '12' } }))
      .toEqual({ why: QUESTION_SKIPPED, ok: true, code: '12' })
  })
})
