// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { devinAnswer, devinDecline, devinPending } from '../../../src/main/agents/devinRequests'

const permission = { sessionId: 'native', toolCall: { toolCallId: 'tool' }, options: [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Allow always', kind: 'allow_always' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
] }
const tool = { toolCallId: 'tool', title: 'Write marker', rawInput: { file_path: '/project/marker', content: 'marker' } }
describe('Devin native requests', () => {
  it('joins permission scope to the exact earlier tool and exposes only once decisions', () => {
    const pending = devinPending(2, 'session/request_permission', permission, 'thread', tool)!
    expect(pending.request.text).toBe('Write marker')
    expect(pending.request.context?.details).toBe(JSON.stringify(tool.rawInput))
    expect(pending.actionDetails).toBe(JSON.stringify(tool.rawInput))
    expect(pending.request.permissionChoices?.map(choice => choice.id)).toEqual(['once', 'deny'])
    expect(devinAnswer(pending, '', true, undefined, 'once')).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(devinAnswer(pending, '', false)).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    expect(devinDecline(pending)).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(() => devinAnswer(pending, '', undefined)).toThrow()
    expect(() => devinAnswer(pending, '', true, undefined, 'always')).toThrow()
    expect(() => devinAnswer(pending, '', false, undefined, 'once')).toThrow()
  })
  it('refuses permission without a matching, complete action and with duplicate choices', () => {
    expect(() => devinPending(2, 'session/request_permission', permission, 'thread')).toThrow()
    expect(() => devinPending(2, 'session/request_permission', permission, 'thread', { ...tool, toolCallId: 'other' })).toThrow()
    expect(() => devinPending(2, 'session/request_permission', { ...permission, options: [...permission.options, permission.options[0]] }, 'thread', tool)).toThrow()
  })
  it('preserves form field names and exact enum values, and validates free text constraints', () => {
    const pending = devinPending('question', 'elicitation/create', { mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: {
      color: { type: 'string', oneOf: [{ const: 'b', title: 'Blue' }] }, reason: { type: 'string', minLength: 3, maxLength: 8 }, optional: { type: 'string' },
    }, required: ['color', 'reason'] } }, 'thread')!
    expect(devinAnswer(pending, '', undefined, { color: { optionIds: ['b'] }, reason: { optionIds: [], text: 'Works' } }))
      .toEqual({ action: 'accept', content: { color: 'b', reason: 'Works' } })
    expect(() => devinAnswer(pending, '', undefined, { color: { optionIds: ['Blue'] }, reason: { optionIds: [], text: 'Works' } })).toThrow()
    expect(() => devinAnswer(pending, '', undefined, { color: { optionIds: ['b'] }, reason: { optionIds: [], text: 'no' } })).toThrow()
    expect(devinDecline(pending)).toEqual({ action: 'decline' })
  })
  it('fails closed for unsupported form constraints, missing fields and injected answers', () => {
    expect(() => devinPending(1, 'elicitation/create', { mode: 'url', message: 'Go elsewhere' }, 'thread')).toThrow()
    const shape = { mode: 'form', requestedSchema: { type: 'object', properties: { name: { type: 'string', pattern: '^yes$' } }, required: ['name'] } }
    expect(() => devinPending(1, 'elicitation/create', shape, 'thread')).toThrow()
    const pending = devinPending(1, 'elicitation/create', { ...shape, requestedSchema: { ...shape.requestedSchema, properties: { name: { type: 'string' } } } }, 'thread')!
    expect(() => devinAnswer(pending, '{"injected":"yes"}')).toThrow()
    expect(devinAnswer(pending, 'yes')).toEqual({ action: 'accept', content: { name: 'yes' } })
  })
})

it('shows the complete verified existing-file replacement before one-time approval', () => {
  const input = { file_path: '/project/existing.txt', old_string: 'Before', new_string: 'After' }
  const pending = devinPending(4, 'session/request_permission', permission, 'thread', { toolCallId: 'tool', title: 'Replace text', rawInput: input })!
  expect(pending.request.context?.details).toBe(JSON.stringify(input))
  expect(devinAnswer(pending, '', true, undefined, 'once')).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  expect(() => devinPending(4, 'session/request_permission', permission, 'thread', {
    toolCallId: 'tool', rawInput: { file_path: '/project/existing.txt', old_string: 'Before' },
  })).toThrow()
})

it('presents command permission scope once while retaining exact internal action evidence', () => {
  const input = { command: 'git status' }
  const pending = devinPending(5, 'session/request_permission', permission, 'thread', { toolCallId: 'tool', title: 'Inspect project', rawInput: input })!
  expect(pending.request.text).toBe('Inspect project')
  expect(pending.request.context).toEqual({ toolCallId: 'tool', command: 'git status' })
  expect(pending.actionDetails).toBe(JSON.stringify(input))
  const detailedInput = { command: 'git status', cwd: '/project', background: false }
  const detailed = devinPending(6, 'session/request_permission', permission, 'thread', { toolCallId: 'tool', title: 'Inspect project', rawInput: detailedInput })!
  expect(detailed.request.text).toBe('Inspect project')
  expect(detailed.request.context).toEqual({ toolCallId: 'tool', details: JSON.stringify(detailedInput) })
  expect(detailed.actionDetails).toBe(JSON.stringify(detailedInput))
})
