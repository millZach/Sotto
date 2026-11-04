// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { answerRequest, pendingRequest } from '../../../src/main/agents/codexRequests'

const yesNo = [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }]
function codex(questions: Array<Record<string, unknown>>) {
  return pendingRequest(7, 'item/tool/requestUserInput', { threadId: 't', turnId: 'turn', itemId: 'item', questions }, 'sotto-thread')!
}
const withOther = () => codex([{ id: 'choice', header: 'Pick', question: 'Yes or no?', isOther: true, isSecret: false, options: yesNo }])

// Issue #2155: Codex 0.166.0's app-server sends `options: null` for a question without choices, and its own terminal
// client treats any question without choices as a text box, whatever `isOther` says.
describe('a Codex question without choices takes typed words', () => {
  // [options, isOther, allowFreeText]. Undefined leaves the key out.
  const cases: Array<[unknown, boolean | undefined, boolean]> = [
    [null, false, true], [[], false, true], [undefined, false, true],
    [null, true, true], [[], true, true], [undefined, true, true],
    [null, undefined, true], [[], undefined, true], [undefined, undefined, true],
    // Choices without Other, the shape of an MCP tool approval, still take a choice only.
    [yesNo, false, false], [yesNo, true, true], [yesNo, undefined, false],
  ]
  it.each(cases)('options %j with isOther %j gives allowFreeText %j', (options, isOther, allowFreeText) => {
    const pending = codex([{ id: 'q', header: 'Test', question: 'Enter a test value', isSecret: false,
      ...(options === undefined ? {} : { options }), ...(isOther === undefined ? {} : { isOther }) }])
    expect(pending.request.questions![0]).toMatchObject({ allowFreeText, options: Array.isArray(options) ? options.map(o => ({ id: o.label })) : [] })
  })

  it('sends a typed answer to the question in the issue', () => {
    const pending = codex([{ id: 'q', header: 'Test', question: 'Enter a test value', isSecret: false, isOther: false, options: null }])
    expect(answerRequest(pending, '', undefined, { q: { optionIds: [], text: 'fake-value-123' } })).toEqual({ answers: { q: { answers: ['user_note: fake-value-123'] } } })
  })
})

// Issue #2157: Codex 0.166.0's terminal client and app-server test client send typed words as `user_note: <text>`
// (tui/src/bottom_pane/request_user_input/mod.rs:867-898), so a typed answer never reads as the option it spells.
describe('a typed Codex answer is marked as the user\'s own words', () => {
  it('sends a chosen option as its label alone', () => {
    expect(answerRequest(withOther(), '', undefined, { choice: { optionIds: ['Yes'] } })).toEqual({ answers: { choice: { answers: ['Yes'] } } })
  })
  it('sends a typed answer beside choices as a note, without "None of the above"', () => {
    expect(answerRequest(withOther(), '', undefined, { choice: { optionIds: [], text: 'A custom answer' } })).toEqual({ answers: { choice: { answers: ['user_note: A custom answer'] } } })
  })
  it('sends a chosen option with a note as the label, then the note', () => {
    expect(answerRequest(withOther(), '', undefined, { choice: { optionIds: ['Yes'], text: 'but only on Tuesdays' } }))
      .toEqual({ answers: { choice: { answers: ['Yes', 'user_note: but only on Tuesdays'] } } })
  })
  it('sends a typed answer to a question without choices as a note, trimmed as the terminal client trims it', () => {
    const pending = codex([{ id: 'q', header: 'Name', question: 'Name?', isOther: false, isSecret: false, options: null }])
    expect(answerRequest(pending, '', undefined, { q: { optionIds: [], text: '  free \n' } })).toEqual({ answers: { q: { answers: ['user_note: free'] } } })
  })
  it('keeps typed "Yes" apart from choosing Yes', () => {
    expect(answerRequest(withOther(), '', undefined, { choice: { optionIds: [], text: 'Yes' } })).toEqual({ answers: { choice: { answers: ['user_note: Yes'] } } })
  })
  it('leaves an answer without question answers as the words sent, since it cannot tell a choice from typing', () => {
    expect(answerRequest(withOther(), 'A custom answer')).toEqual({ answers: { choice: { answers: ['A custom answer'] } } })
  })
  it('still refuses typed words on a question that offers choices without Other', () => {
    const pending = codex([{ id: 'approve', header: 'Approve', question: 'Run tool?', isOther: false, options: [{ label: 'Allow', description: '' }, { label: 'Cancel', description: '' }] }])
    expect(() => answerRequest(pending, '', undefined, { approve: { optionIds: [], text: 'Allow' } })).toThrow('This question does not support free text.')
  })
})
