// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { answerRequest, pendingRequest } from '../../../src/main/agents/codexRequests'

function form(properties: Record<string, unknown>, required: string[] = []) {
  return pendingRequest('form-request', 'mcpServer/elicitation/request', {
    threadId: 'native-thread', mode: 'form', message: 'Choose the details',
    requestedSchema: { type: 'object', properties, required },
  }, 'native-thread')!
}

describe('Codex native form fidelity', () => {
  it('keeps optional fields optional and sends only answered native field IDs', () => {
    const pending = form({ name: { type: 'string' }, note: { type: 'string' }, mode: { type: 'string', enum: ['quick', 'full'] } }, ['name'])
    expect(pending.request.questions).toMatchObject([
      { id: 'name', required: true }, { id: 'note', required: false }, { id: 'mode', required: false },
    ])
    expect(answerRequest(pending, '', undefined, { name: { optionIds: [], text: 'Sotto' } })).toEqual({ action: 'accept', content: { name: 'Sotto' } })
    expect(() => answerRequest(pending, '', undefined, {})).toThrow(/question|required/i)
  })

  it('explains unsupported required fields without offering an input that cannot be submitted', () => {
    const pending = form({ count: { type: 'integer', minimum: 1 }, code: { type: 'string', pattern: '^[A-Z]+$' } }, ['count', 'code'])
    for (const question of pending.request.questions!) {
      expect(question).toMatchObject({ allowFreeText: false, options: [], unavailableReason: expect.stringMatching(/native|Codex/i) })
    }
    expect(() => answerRequest(pending, '', undefined, { count: { optionIds: [], text: '3' }, code: { optionIds: [], text: 'ABC' } })).toThrow()
  })

  it('can omit an unsupported optional field while preserving enum values distinct from labels', () => {
    const pending = form({ mode: { type: 'string', oneOf: [{ const: 'quick', title: 'Quick check' }, { const: 'full', title: 'Full check' }] }, count: { type: 'integer' } }, ['mode'])
    expect(pending.request.questions![1]).toMatchObject({ required: false, unavailableReason: expect.any(String) })
    expect(answerRequest(pending, '', undefined, { mode: { optionIds: ['quick'] } })).toEqual({ action: 'accept', content: { mode: 'quick' } })
    expect(() => answerRequest(pending, '', undefined, { mode: { optionIds: ['invented'] } })).toThrow(/offered/i)
  })
})
