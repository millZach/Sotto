// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { opencodeFormAnswer, opencodeFormPending, opencodeFormSchema } from '../../../src/main/agents/opencodeRequests'

const pendingOf = (fields: unknown[]) => {
  const pending = opencodeFormPending('thread', opencodeFormSchema.parse({ id: 'frm_1', sessionID: 'ses_1', title: 'Questions', fields }))
  if (!pending) throw new Error('expected a form Sotto can draw')
  return pending
}

describe('an OpenCode form answer, in each field’s own type', () => {
  it('takes no answer from empty text for a number, rather than 0', () => {
    const pending = pendingOf([{ key: 'count', description: 'How many?', type: 'number', options: [{ value: '5', label: 'Five' }], custom: true, required: false }])
    // Spaces typed beside a chosen option are no number at all: the option is the answer.
    expect(opencodeFormAnswer(pending, '', { count: { optionIds: ['option-0'], text: '   ' } })).toEqual({ count: 5 })
    expect(opencodeFormAnswer(pending, '', { count: { optionIds: [], text: '   ' } })).toEqual({})
  })
  it('keeps what the user typed in a text field that also offers options', () => {
    const pending = pendingOf([{ key: 'colour', description: 'Which colour?', type: 'string', options: [{ value: 'red', label: 'Red' }], custom: true }])
    expect(opencodeFormAnswer(pending, '', { colour: { optionIds: ['option-0'], text: 'Crimson' } })).toEqual({ colour: 'Crimson' })
    expect(opencodeFormAnswer(pending, '', { colour: { optionIds: ['option-0'], text: '' } })).toEqual({ colour: 'red' })
  })
})
