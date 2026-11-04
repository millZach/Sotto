// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { answerRequest, pendingRequest } from '../../../src/main/agents/codexRequests'

const yesNo = [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }]
function codex(questions: Array<Record<string, unknown>>) {
  return pendingRequest(7, 'item/tool/requestUserInput', { threadId: 't', turnId: 'turn', itemId: 'item', questions }, 'sotto-thread')!
}

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
    expect(answerRequest(pending, '', undefined, { q: { optionIds: [], text: 'fake-value-123' } })).toEqual({ answers: { q: { answers: ['fake-value-123'] } } })
  })
})
