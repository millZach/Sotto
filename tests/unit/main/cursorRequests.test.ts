// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { cursorAnswer, cursorDecline, cursorPending, CURSOR_PLAN_TOOL } from '../../../src/main/agents/cursorRequests'

const permission = {
  sessionId: 's1',
  toolCall: { toolCallId: 'call_1\nfc_1', title: '`git status --short`', kind: 'execute', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: 'Not in allowlist: git status' } }] },
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }],
}

describe('Cursor’s permission requests', () => {
  const pending = cursorPending(7, 'session/request_permission', permission, 'thread')!
  it('offers allow once and reject, never allow always', () => {
    expect(pending.request).toMatchObject({ kind: 'permission', text: '`git status --short`\nNot in allowlist: git status',
      context: { toolCallId: 'call_1\nfc_1', command: 'git status --short', details: 'Not in allowlist: git status' } })
    expect(pending.request.permissionChoices).toEqual([{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }, { id: 'reject-once', label: 'Reject', kind: 'deny' }])
  })
  it('answers the user’s choice, and refuses allow always even when named', () => {
    expect(cursorAnswer(pending, '', true)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(cursorAnswer(pending, '', false)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    expect(cursorAnswer(pending, '', true, undefined, 'allow-once')).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(() => cursorAnswer(pending, '', true, undefined, 'allow-always')).toThrow('not offered')
    expect(cursorDecline(pending)).toEqual({ outcome: { outcome: 'cancelled' } })
  })
  it('carries a file change’s path and its change into the request card', () => {
    const path = 'C:\\outside\\notes.md'
    const edit = cursorPending(9, 'session/request_permission', { ...permission, toolCall: { toolCallId: 'call_e', title: 'Edit File', kind: 'edit', status: 'pending',
      rawInput: { path }, locations: [{ path }],
      content: [{ type: 'diff', path, oldText: 'old line', newText: 'new line' }, { type: 'content', content: { type: 'text', text: 'Outside the workspace' } }] } }, 'thread')!
    expect(edit.request.text).toBe(`Edit File\n${path}\nOutside the workspace`)
    expect(edit.request.context).toEqual({ toolCallId: 'call_e', details: `Outside the workspace\n${path}\n--- before\nold line\n+++ after\nnew line` })
    // A title that already names the file is not given it twice.
    const named = cursorPending(10, 'session/request_permission', { ...permission, toolCall: { toolCallId: 'call_n', title: `Edit \`${path}\``, kind: 'edit', status: 'pending',
      content: [{ type: 'diff', path, oldText: null, newText: 'new file' }] } }, 'thread')!
    expect(named.request.text).toBe(`Edit \`${path}\``)
    expect(named.request.context?.details).toBe(`${path}\n--- before\n\n+++ after\nnew file`)
  })
  it('answers nothing it cannot allow once', () => {
    const always = cursorPending(8, 'session/request_permission', { ...permission, options: [permission.options[1]] }, 'thread')!
    expect(always.request.permissionChoices).toEqual([])
    expect(() => cursorAnswer(always, '', true)).toThrow('Nothing was approved')
    expect(cursorAnswer(always, '', false)).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

describe('Cursor’s questions', () => {
  const asked = { toolCallId: 'call_q', title: 'Pick', questions: [
    { id: 'q1', prompt: 'Which color?', options: [{ id: 'b', label: 'Blue' }, { id: 'r', label: 'Red' }], allowMultiple: false },
    { id: 'q2', prompt: 'Which sizes?', options: [{ id: 's', label: 'Small' }, { id: 'l', label: 'Large' }], allowMultiple: true }] }
  const pending = cursorPending('q', 'cursor/ask_question', asked, 'thread')!
  it('shows each question with its options, which are the only answers it takes', () => {
    expect(pending.request).toMatchObject({ kind: 'question', text: 'Pick', options: [] })
    expect(pending.request.questions).toEqual([
      { id: 'q1', question: 'Which color?', options: [{ id: 'b', label: 'Blue' }, { id: 'r', label: 'Red' }], multiSelect: false, allowFreeText: false, required: false },
      { id: 'q2', question: 'Which sizes?', options: [{ id: 's', label: 'Small' }, { id: 'l', label: 'Large' }], multiSelect: true, allowFreeText: false, required: false }])
  })
  it('answers the chosen option IDs, and skips a question left unanswered', () => {
    expect(cursorAnswer(pending, '', undefined, { q1: { optionIds: ['r'] }, q2: { optionIds: ['s', 'l'] } }))
      .toEqual({ outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['r'] }, { questionId: 'q2', selectedOptionIds: ['s', 'l'] }] } })
    expect(cursorAnswer(pending, '', undefined, { q1: { optionIds: ['b'] } })).toEqual({ outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }] } })
    expect(cursorAnswer(pending, '', undefined, { q1: { optionIds: [] }, q2: { optionIds: [] } })).toEqual({ outcome: { outcome: 'skipped' } })
    expect(cursorAnswer(pending, '', undefined, { q1: { optionIds: ['a'] } }, undefined, true)).toEqual({ outcome: { outcome: 'skipped' } })
    expect(() => cursorAnswer(pending, '', undefined, { q1: { optionIds: ['green'] } })).toThrow()
  })
  it('reads a typed answer to one question as the option it names', () => {
    const single = cursorPending('one', 'cursor/ask_question', { questions: [asked.questions[0]] }, 'thread')!
    expect(single.request).toMatchObject({ text: 'Which color?', options: [{ id: 'b', label: 'Blue' }, { id: 'r', label: 'Red' }] })
    expect(cursorAnswer(single, 'blue')).toEqual({ outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['b'] }] } })
    expect(() => cursorAnswer(single, 'Green')).toThrow('its own options')
  })
  it('reads a question Cursor asks as a permission, and answers it the same way', () => {
    const fallback = cursorPending(3, 'session/request_permission', { sessionId: 's1', toolCall: { toolCallId: 'ask_1_q0', title: 'Pick', kind: 'other', content: [{ type: 'content', content: { type: 'text', text: 'Which color?' } }] },
      options: [{ optionId: 'b', name: 'Blue', kind: 'allow_once' }, { optionId: '__ask_question_skip__', name: 'Skip', kind: 'reject_once' }] }, 'thread')!
    expect(fallback.request).toMatchObject({ kind: 'question', text: 'Which color?', options: [{ id: 'b', label: 'Blue' }] })
    expect(cursorAnswer(fallback, 'Blue')).toEqual({ outcome: { outcome: 'selected', optionId: 'b' } })
    expect(cursorAnswer(fallback, '')).toEqual({ outcome: { outcome: 'selected', optionId: '__ask_question_skip__' } })
  })
})

describe('Cursor’s plans', () => {
  const pending = cursorPending('p', 'cursor/create_plan', { toolCallId: 'call_p', name: 'contrib-doc', overview: 'Add a guide.', plan: '1. Draft\n2. Review', todos: [{ id: 'a', content: 'Draft', status: 'pending' }] }, 'thread')!
  it('shows a plan as a request to accept or reject, named as Cursor’s plan', () => {
    expect(pending.request).toMatchObject({ kind: 'permission', text: 'contrib-doc\n\nAdd a guide.\n\n1. Draft\n2. Review', context: { toolName: CURSOR_PLAN_TOOL, toolCallId: 'call_p',
      plan: { name: 'contrib-doc', overview: 'Add a guide.', steps: '1. Draft\n2. Review' } } })
    expect(pending.request.context?.details).toBeUndefined()
    expect(pending.request.permissionChoices?.map(choice => [choice.id, choice.label, choice.kind])).toEqual([['accept-plan', 'Accept plan', 'allow-once'], ['reject-plan', 'Reject', 'deny']])
  })
  it('answers accepted or rejected, and cancelled when the thread stops', () => {
    expect(cursorAnswer(pending, '', true)).toEqual({ outcome: { outcome: 'accepted' } })
    expect(cursorAnswer(pending, '', false, undefined, 'reject-plan')).toEqual({ outcome: { outcome: 'rejected' } })
    expect(cursorAnswer(pending, '', true, undefined, 'accept-plan')).toEqual({ outcome: { outcome: 'accepted' } })
    expect(cursorDecline(pending)).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

it('reads no request it does not know', () => {
  expect(cursorPending(1, 'cursor/unknown', {}, 'thread')).toBeUndefined()
  expect(cursorPending(1, 'session/request_permission', { sessionId: 's' }, 'thread')).toBeUndefined()
})
