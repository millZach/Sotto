// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { answerRequest, pendingRequest } from '../../../src/main/agents/codexRequests'

function form(properties: Record<string, unknown>, required: string[] = [], mode = 'form') {
  return pendingRequest('form-request', 'mcpServer/elicitation/request', {
    threadId: 'native-thread', mode, message: 'Choose the details',
    requestedSchema: { type: 'object', properties, required },
  }, 'native-thread')!
}
const UNSUPPORTED = 'Sotto can’t show this kind of field. Decline it, or answer it in Codex if your Codex app can.'

describe('Codex native form fidelity', () => {
  it('keeps optional fields optional and sends only answered native field IDs', () => {
    const pending = form({ name: { type: 'string' }, note: { type: 'string' }, mode: { type: 'string', enum: ['quick', 'full'] } }, ['name'])
    expect(pending.request.questions).toMatchObject([
      { id: 'name', required: true }, { id: 'note', required: false }, { id: 'mode', required: false },
    ])
    expect(answerRequest(pending, '', undefined, { name: { optionIds: [], text: 'Sotto' } })).toEqual({ action: 'accept', content: { name: 'Sotto' } })
    expect(() => answerRequest(pending, '', undefined, {})).toThrow(/question|required/i)
  })

  // Codex 0.166.0 cancels a `form` with a field outside MCP's primitives before it reaches Sotto, so a `pattern` or an
  // object arrives only through OpenAI's own spellings.
  it('explains a field it cannot show without offering an input that cannot be submitted', () => {
    const pending = form({ code: { type: 'string', pattern: '^[A-Z]+$' }, place: { type: 'object', properties: {} } }, ['code', 'place'], 'openai/form')
    for (const question of pending.request.questions!) {
      expect(question).toMatchObject({ allowFreeText: false, options: [], multiSelect: false, unavailableReason: UNSUPPORTED })
    }
    expect(() => answerRequest(pending, '', undefined, { code: { optionIds: [], text: 'ABC' }, place: { optionIds: [], text: 'x' } })).toThrow(UNSUPPORTED)
    expect(() => answerRequest(pending, '{"code":"ABC","place":{}}')).toThrow(UNSUPPORTED)
  })

  it('can omit an optional field it cannot show while preserving enum values distinct from labels', () => {
    const pending = form({ mode: { type: 'string', oneOf: [{ const: 'quick', title: 'Quick check' }, { const: 'full', title: 'Full check' }] }, image: { type: 'openai/imagePicker' } }, ['mode'], 'openaiForm')
    expect(pending.request.questions![1]).toMatchObject({ required: false, unavailableReason: UNSUPPORTED })
    expect(answerRequest(pending, '', undefined, { mode: { optionIds: ['quick'] } })).toEqual({ action: 'accept', content: { mode: 'quick' } })
    expect(() => answerRequest(pending, '', undefined, { mode: { optionIds: ['invented'] } })).toThrow(/offered/i)
  })
})

// Issue #2154: every field Codex 0.166.0 forwards in a form is answered with a value of its own type (Zach's picks,
// November 4, 2026: Yes and No for a boolean, a default said in the words and never chosen for the user, a number typed).
describe('typed Codex form fields (#2154)', () => {
  it('asks a boolean as Yes or No and answers a JSON boolean', () => {
    const pending = form({ proceed: { type: 'boolean', title: 'Proceed?' } }, ['proceed'])
    expect(pending.request.questions).toEqual([{ id: 'proceed', question: 'proceed', header: 'Proceed?', multiSelect: false, allowFreeText: false, required: true,
      options: [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }] }])
    expect(pending.request.options).toEqual([{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }])
    expect(answerRequest(pending, '', undefined, { proceed: { optionIds: ['true'] } })).toEqual({ action: 'accept', content: { proceed: true } })
    expect(answerRequest(pending, '', undefined, { proceed: { optionIds: ['false'] } })).toEqual({ action: 'accept', content: { proceed: false } })
    expect(answerRequest(pending, '{"proceed":false}')).toEqual({ action: 'accept', content: { proceed: false } })
    // The one-field choice a phone or an older card sends is the option's ID.
    expect(answerRequest(pending, 'true')).toEqual({ action: 'accept', content: { proceed: true } })
    expect(() => answerRequest(pending, '{"proceed":"maybe"}')).toThrow('Choose Yes or No.')
    expect(() => answerRequest(pending, '', undefined, { proceed: { optionIds: [], text: 'yes' } })).toThrow()
  })

  it('says a default in the words and chooses nothing for the user', () => {
    const pending = form({ proceed: { type: 'boolean', description: 'Proceed with the release?', default: true },
      mode: { type: 'string', oneOf: [{ const: 'quick', title: 'Quick check' }, { const: 'full', title: 'Full check' }], default: 'full' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, default: ['a', 'b'] } })
    expect(pending.request.questions!.map(question => question.question)).toEqual([
      'Proceed with the release?\nDefault: Yes.', 'mode\nDefault: Full check.', 'tags\nDefault: a, b.',
    ])
    expect(form({ tags: { type: 'array', items: { type: 'string', enum: ['a'] }, default: [] } }).request.questions![0]!.question).toBe('tags\nDefault: none.')
    // Nothing answered is nothing sent: Codex's server applies its own default.
    expect(answerRequest(pending, '', undefined, {})).toEqual({ action: 'accept', content: {} })
  })

  it('takes a number in the text box, says its range, and answers a JSON number inside it', () => {
    const pending = form({ count: { type: 'integer', title: 'Count', description: 'How many copies?', minimum: 1, maximum: 5, default: 3 },
      ratio: { type: 'number', minimum: 0 } }, ['count'])
    expect(pending.request.questions).toMatchObject([
      { id: 'count', question: 'How many copies?\nA whole number from 1 to 5. Default: 3.', allowFreeText: true, options: [], required: true },
      { id: 'ratio', question: 'ratio\nA number of at least 0.', allowFreeText: true, options: [], required: false },
    ])
    expect(pending.request.questions![0]!.unavailableReason).toBeUndefined()
    expect(answerRequest(pending, '', undefined, { count: { optionIds: [], text: ' 4 ' }, ratio: { optionIds: [], text: '0.5' } }))
      .toEqual({ action: 'accept', content: { count: 4, ratio: 0.5 } })
    for (const text of ['9', '0', '2.5', 'three', '']) {
      expect(() => answerRequest(pending, '', undefined, { count: { optionIds: [], text } })).toThrow(/whole number from 1 to 5|Answer every question/u)
    }
    expect(() => answerRequest(pending, '', undefined, { count: { optionIds: [], text: '2.5' } })).toThrow('Answer with a whole number from 1 to 5.')
    expect(() => answerRequest(pending, '', undefined, { count: { optionIds: [], text: '2' }, ratio: { optionIds: [], text: '-1' } })).toThrow('Answer with a number of at least 0.')
    expect(answerRequest(pending, '{"count":"5"}')).toEqual({ action: 'accept', content: { count: 5 } })
    expect(() => answerRequest(pending, '{"count":6}')).toThrow('Answer with a whole number from 1 to 5.')
  })

  it('asks a multi-select array as a choice of several and answers the chosen values in a JSON array', () => {
    const untitled = form({ tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b', 'c'] }, minItems: 1, maxItems: 2 } }, ['tags'])
    expect(untitled.request.questions![0]).toMatchObject({ multiSelect: true, allowFreeText: false, options: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' }] })
    expect(untitled.request.options).toEqual([])
    expect(answerRequest(untitled, '', undefined, { tags: { optionIds: ['a', 'c'] } })).toEqual({ action: 'accept', content: { tags: ['a', 'c'] } })
    expect(() => answerRequest(untitled, '', undefined, { tags: { optionIds: ['a', 'b', 'c'] } })).toThrow('Choose no more than 2 options.')
    expect(() => answerRequest(untitled, '{"tags":[]}')).toThrow('Choose at least 1 option.')
    expect(() => answerRequest(untitled, '{"tags":["z"]}')).toThrow(/offered/u)
    expect(answerRequest(untitled, '{"tags":["b"]}')).toEqual({ action: 'accept', content: { tags: ['b'] } })
    // Required, but none is a valid answer: the card may send it with nothing chosen, and that sends an empty list.
    const none = form({ tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }, ['tags'])
    expect(none.request.questions![0]!.required).toBe(false)
    expect(answerRequest(none, '', undefined, {})).toEqual({ action: 'accept', content: { tags: [] } })
    expect(answerRequest(none, '{}')).toEqual({ action: 'accept', content: { tags: [] } })
    for (const items of [{ anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] }, { oneOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] }]) {
      const titled = form({ tags: { type: 'array', items } }, ['tags'])
      expect(titled.request.questions![0]).toMatchObject({ multiSelect: true, options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] })
      expect(answerRequest(titled, '', undefined, { tags: { optionIds: ['b'] } })).toEqual({ action: 'accept', content: { tags: ['b'] } })
    }
  })

  it('takes a string with a format Codex forwards as text, and checks its length in words', () => {
    const pending = form({ email: { type: 'string', title: 'Email', format: 'email' }, code: { type: 'string', minLength: 2, maxLength: 4 } }, ['email'])
    expect(pending.request.questions![0]).toMatchObject({ allowFreeText: true, options: [] })
    expect(pending.request.questions![0]!.unavailableReason).toBeUndefined()
    expect(answerRequest(pending, '', undefined, { email: { optionIds: [], text: 'dev@example.com' } })).toEqual({ action: 'accept', content: { email: 'dev@example.com' } })
    expect(() => answerRequest(pending, '{"email":"a@b.c","code":"x"}')).toThrow('Answer with at least 2 characters.')
    expect(() => answerRequest(pending, '{"email":"a@b.c","code":"xxxxx"}')).toThrow('Answer with no more than 4 characters.')
    expect(() => answerRequest(pending, '{"email":7}')).toThrow('Answer with words.')
  })

  it('declines on Decline or Skip, and refuses a missing required field', () => {
    const pending = form({ proceed: { type: 'boolean' }, count: { type: 'number' } }, ['proceed'])
    expect(answerRequest(pending, '', false)).toEqual({ action: 'decline', content: null })
    expect(answerRequest(pending, '', undefined, undefined, undefined, true)).toEqual({ action: 'decline', content: null })
    expect(() => answerRequest(pending, '{"count":2}')).toThrow('Answer the required field: proceed.')
    expect(() => answerRequest(pending, '{"proceed":true,"other":1}')).toThrow('Answer only this form’s own fields.')
    expect(answerRequest(pending, '', undefined, { proceed: { optionIds: ['true'] }, count: { optionIds: [], text: '' } })).toEqual({ action: 'accept', content: { proceed: true } })
  })
})
