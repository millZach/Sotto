// @vitest-environment node
// ADR-0218: a playbook is a local JSON file of ordered steps. Its file is checked before it runs, what comes from outside
// fills only the inputs it declares and is quoted as outside words, and an agent's output is read from its last block.
import { describe, expect, it } from 'vitest'
import { bindInputs, EXAMPLE_PLAYBOOK, fillTemplate, playbookSchema, readOutputBlock, type Playbook } from '../../../src/shared/playbooks'

const base = (steps: unknown[], extra: Record<string, unknown> = {}): unknown => ({ format: 1, name: 'Synthetic playbook', steps, ...extra })
const problems = (value: unknown): string[] => { const parsed = playbookSchema.safeParse(value); return parsed.success ? [] : parsed.error.issues.map(issue => issue.message) }

describe('a playbook file', () => {
  it('accepts the example: triage, decide, fix in a worktree, check, decide, pull request', () => {
    expect(problems(EXAMPLE_PLAYBOOK)).toEqual([])
    expect(EXAMPLE_PLAYBOOK.steps.map(step => step.kind)).toEqual(['agent', 'decision', 'agent', 'code', 'decision', 'agent'])
  })

  it('refuses steps that name a later step, repeat an id or reference nothing real', () => {
    expect(problems(base([{ id: 'one', kind: 'agent', prompt: 'Go', thread: 'two' }, { id: 'two', kind: 'agent', prompt: 'Go' }]))).not.toEqual([])
    expect(problems(base([{ id: 'one', kind: 'agent', prompt: 'Go' }, { id: 'one', kind: 'agent', prompt: 'Again' }]))).not.toEqual([])
    expect(problems(base([{ id: 'one', kind: 'agent', prompt: 'Use {{inputs.missing}}' }]))).not.toEqual([])
    expect(problems(base([{ id: 'one', kind: 'agent', prompt: 'Use {{steps.later.output.x}}' }, { id: 'later', kind: 'agent', prompt: 'Go', output: { properties: { x: { type: 'string' } } } }]))).not.toEqual([])
  })

  it('refuses a command that would take words from outside, and a step kind it does not know', () => {
    expect(problems(base([{ id: 'run', kind: 'code', run: ['echo', '{{inputs.title}}'] }], { inputs: { title: { type: 'string' } } }))).not.toEqual([])
    expect(problems(base([{ id: 'run', kind: 'shell', run: 'rm -rf /' }]))).not.toEqual([])
  })
})

describe('filling a step', () => {
  const context = { inputs: { title: 'Synthetic "quoted" title', count: 3 }, steps: { triage: { output: { plan: 'Synthetic plan', tags: ['a', 'b'] }, note: 'Synthetic note' } }, outside: new Set(['title']) }

  it('quotes an outside input as JSON so its end is plain, and leaves the user\'s own as written', () => {
    expect(fillTemplate('Title: {{inputs.title}} ({{ inputs.count }})', context)).toBe('Title: "Synthetic \\"quoted\\" title" (3)')
    expect(fillTemplate('{{steps.triage.output.plan}} / {{steps.triage.output.tags}} / {{steps.triage.note}} / {{steps.none.note}}', context)).toBe('Synthetic plan / a, b / Synthetic note / ')
  })

  it('binds only declared inputs, converting plain values and naming what is missing', () => {
    const declared: Playbook['inputs'] = { title: { type: 'string', required: true }, number: { type: 'number' }, ready: { type: 'boolean', default: false } }
    expect(bindInputs(declared!, { title: 'Synthetic', number: '12', extra: 'dropped' })).toEqual({ inputs: { title: 'Synthetic', number: 12, ready: false }, problems: [] })
    expect(bindInputs(declared!, { number: 'twelve' }).problems).toEqual(['title is required.', 'number should be a number.'])
  })
})

describe('reading an agent\'s output', () => {
  const output = { properties: { summary: { type: 'string' as const }, worthFixing: { type: 'boolean' as const }, files: { type: 'string[]' as const } }, required: ['summary'] }

  it('reads the last block, drops fields it does not name, and checks each type', () => {
    const reply = 'Draft:\n```sotto-output\n{"summary":"old"}\n```\nFinal:\n```sotto-output\n{"summary":"Synthetic","worthFixing":true,"files":["a.ts"],"extra":1}\n```'
    expect(readOutputBlock(reply, output)).toEqual({ ok: true, value: { summary: 'Synthetic', worthFixing: true, files: ['a.ts'] } })
  })

  it('refuses a reply with no block, a block that is not an object, a missing required field or a wrong type', () => {
    expect(readOutputBlock('No block here', output)).toMatchObject({ ok: false })
    expect(readOutputBlock('```sotto-output\n[1]\n```', output)).toMatchObject({ ok: false })
    expect(readOutputBlock('```sotto-output\n{"worthFixing":true}\n```', output)).toMatchObject({ ok: false, reason: 'it leaves out summary' })
    expect(readOutputBlock('```sotto-output\n{"summary":"x","worthFixing":"yes"}\n```', output)).toMatchObject({ ok: false, reason: 'worthFixing is not a boolean' })
  })
})
