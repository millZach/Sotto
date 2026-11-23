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
    expect(pending.request.context).toMatchObject({ action: 'Write a file', target: '/project/marker', details: 'marker' })
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
  it('supports Devin 3000.14 elicitation shapes: session/elicitation, optional sessionId, descriptions, array multi-select, $schema, and _meta allowOther', () => {
    const pending = devinPending('devin-ask', 'session/elicitation', {
      requestId: 'req-1',
      toolCallId: 'call-1',
      mode: 'form',
      message: 'Need choices',
      _meta: { 'cognition.ai/toolCallId': 'call-1' },
      requestedSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        properties: {
          single: {
            type: 'string',
            title: 'Approach',
            oneOf: [
              { const: 'fast', title: 'Fast', description: 'Quick fix' },
              { const: '__other__', title: 'Other' },
            ],
            _meta: { 'cognition.ai/allowOther': true, 'cognition.ai/otherOptionValue': '__other__' },
          },
          multi: {
            type: 'array',
            title: 'Checks',
            items: { anyOf: [{ const: 'lint', title: 'Lint', description: 'Run eslint' }, { const: 'typecheck', title: 'Typecheck' }] },
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
          },
        },
        required: ['single', 'multi'],
      },
    }, 'thread')!
    expect(pending.request.questions?.[0]).toMatchObject({
      id: 'single',
      multiSelect: false,
      allowFreeText: true,
      options: [{ id: 'fast', label: 'Fast', description: 'Quick fix' }],
    })
    expect(pending.request.questions?.[1]).toMatchObject({
      id: 'multi',
      multiSelect: true,
      allowFreeText: false,
      options: [{ id: 'lint', label: 'Lint', description: 'Run eslint' }, { id: 'typecheck', label: 'Typecheck' }],
    })
    expect(devinAnswer(pending, '', undefined, {
      single: { optionIds: [], text: 'Custom approach' },
      multi: { optionIds: ['lint', 'typecheck'] },
    })).toEqual({
      action: 'accept',
      content: { single: 'Custom approach', multi: ['lint', 'typecheck'] },
    })
    expect(() => devinAnswer(pending, '', undefined, {
      single: { optionIds: ['fast'] },
      multi: { optionIds: [] },
    })).toThrow()
  })
})

it('shows the complete verified existing-file replacement before one-time approval', () => {
  const input = { file_path: '/project/existing.txt', old_string: 'Before', new_string: 'After' }
  const pending = devinPending(4, 'session/request_permission', permission, 'thread', { toolCallId: 'tool', title: 'Replace text', rawInput: input })!
  expect(pending.request.context).toMatchObject({ action: 'Edit a file', target: '/project/existing.txt', details: '- Before\n+ After' })
  expect(pending.actionDetails).toBe(JSON.stringify(input))
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
  // Nothing is left out: the command, its folder and its other setting all show, none of them as JSON.
  expect(detailed.request.context).toEqual({ toolCallId: 'tool', command: 'git status', cwd: '/project', details: 'background: false' })
  expect(detailed.actionDetails).toBe(JSON.stringify(detailedInput))
})

// A Sotto tool is named by Devin's tool-name meta when it has one, never by a title that disagrees with it, and never by
// a command's title, which is the command text (#1086 review).
describe('which tool a Devin permission is for', () => {
  const sotto = new Set(['mcp__sotto_visual__visualize', 'mcp__sotto_browser__browser_open'])
  const ask = (toolCall: Record<string, unknown>) => () => devinPending(7, 'session/request_permission', permission, 'thread', { toolCallId: 'tool', ...toolCall }, sotto)

  it('refuses a call whose meta names another tool, even when its title names a Sotto tool', () => {
    expect(ask({ title: 'mcp__sotto_visual__visualize', rawInput: { title: 'x' }, _meta: { 'cognition.ai/toolName': 'mcp__other__exfil' } })).toThrow()
  })

  it('names a Sotto tool by its meta, whatever the title says', () => {
    expect(ask({ title: 'Visualize', rawInput: { title: 'x' }, _meta: { 'cognition.ai/toolName': 'mcp__sotto_visual__visualize' } })()!.request.text).toBe('Use Sotto’s visualize tool')
  })

  it('reads a command whose text looks like a Sotto tool name as a command, not as that tool', () => {
    const pending = ask({ kind: 'execute', title: 'mcp__sotto_browser__browser_open', rawInput: { command: 'mcp__sotto_browser__browser_open' } })()!
    expect(pending.request.text).toBe('mcp__sotto_browser__browser_open')
    expect(pending.request.context).toEqual({ toolCallId: 'tool', command: 'mcp__sotto_browser__browser_open' })
  })
})

describe('Devin elicitation skippability, zero-minimum arrays, limits, and uniqueItems', () => {
  it('omits skippable on required choice fields even when allowOther is true', () => {
    const pending = devinPending('req-choice', 'session/elicitation', {
      mode: 'form',
      message: 'Pick one',
      requestedSchema: {
        type: 'object',
        properties: {
          choice: {
            type: 'string',
            title: 'Target',
            oneOf: [{ const: 'staging', title: 'Staging' }],
            _meta: { 'cognition.ai/allowOther': true },
          },
          notes: { type: 'string', title: 'Notes' },
        },
        required: ['choice', 'notes'],
      },
    }, 'thread')!
    expect(pending.request.questions?.[0]).toMatchObject({ id: 'choice', allowFreeText: true, required: true })
    expect(pending.request.questions?.[0]?.skippable).toBeUndefined()
    expect(pending.request.questions?.[1]).toMatchObject({ id: 'notes', allowFreeText: true, required: true, skippable: true })
  })

  it('allows zero selections on required arrays when minItems is omitted or zero and shows item limits on array questions', () => {
    const pending = devinPending('req-arrays', 'session/elicitation', {
      mode: 'form',
      message: 'Select checks',
      requestedSchema: {
        type: 'object',
        properties: {
          optionalMin: {
            type: 'array',
            title: 'Optional checks',
            items: { anyOf: [{ const: 'lint', title: 'Lint' }] },
          },
          explicitZero: {
            type: 'array',
            title: 'Up to two',
            items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] },
            minItems: 0,
            maxItems: 2,
          },
          bounded: {
            type: 'array',
            description: 'Pick release checks',
            items: { anyOf: [{ const: 'unit', title: 'Unit' }, { const: 'e2e', title: 'E2E' }] },
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
          },
        },
        required: ['optionalMin', 'explicitZero', 'bounded'],
      },
    }, 'thread')!
    expect(pending.request.questions?.[0]).toMatchObject({ id: 'optionalMin', required: false, skippable: true })
    expect(pending.request.questions?.[1]).toMatchObject({ id: 'explicitZero', required: false, skippable: true, question: 'Up to two\nChoose at most 2 options.' })
    expect(pending.request.questions?.[2]).toMatchObject({ id: 'bounded', required: true, question: 'Pick release checks\nChoose 1 to 2 options.' })
    expect(pending.request.questions?.[2]?.skippable).toBeUndefined()

    expect(devinAnswer(pending, '', undefined, {
      optionalMin: { optionIds: [] },
      explicitZero: { optionIds: [] },
      bounded: { optionIds: ['unit'] },
    })).toEqual({
      action: 'accept',
      content: { bounded: ['unit'], optionalMin: [], explicitZero: [] },
    })
  })

  it('enforces uniqueItems and surfaces item limit bounds in array validation errors', () => {
    const pending = devinPending('req-unique', 'session/elicitation', {
      mode: 'form',
      message: 'Pick unique items',
      requestedSchema: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { anyOf: [{ const: 'smoke', title: 'Smoke' }, { const: 'perf', title: 'Perf' }] },
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
            _meta: { 'cognition.ai/allowOther': true },
          },
        },
        required: ['tags'],
      },
    }, 'thread')!

    expect(() => devinAnswer(pending, '', undefined, { tags: { optionIds: ['smoke'], text: 'smoke' } })).toThrow(/at most once/u)
    expect(() => devinAnswer(pending, '', undefined, { tags: { optionIds: [] } })).toThrow(/Answer every question/u)
    expect(() => devinAnswer(pending, '{"tags":[]}')).toThrow(/at least 1 option/u)
    expect(() => devinAnswer(pending, '', undefined, { tags: { optionIds: ['smoke', 'perf'], text: 'extra' } })).toThrow(/at most 2 options/u)
  })
})
