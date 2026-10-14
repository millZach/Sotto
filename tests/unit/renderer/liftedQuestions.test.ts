import { describe, expect, it } from 'vitest'

import { questionsIn } from '../../../src/renderer/src/agents/liftedQuestions'

describe('questions a reply asked on the way', () => {
  it('finds a question in the middle of a paragraph, bold or not', () => {
    const reply = 'One thing I need from you. ADR-0078 keeps Usage history on the computer that recorded it. **Should Overview follow ADR-0078, or show every computer?** I will keep going on the layout while you decide.'
    expect(questionsIn(reply)).toEqual(['Should Overview follow ADR-0078, or show every computer?'])
  })

  it('keeps each question once and in the order it was written', () => {
    const reply = ['Two things before I go on:', '', '1. Should the rings be per provider?', '- [ ] Do you want the Read again link kept?', '', 'Should the rings be per provider?'].join('\n')
    expect(questionsIn(reply)).toEqual(['Should the rings be per provider?', 'Do you want the Read again link kept?'])
  })

  it('reads links as their words and code as its text', () => {
    expect(questionsIn('Should I rename `usageRows` as [the plan](https://example.com/plan?x=1) says?'))
      .toEqual(['Should I rename usageRows as the plan says?'])
  })

  it('leaves code, headings, tables and quotes alone', () => {
    const reply = [
      '## Why does Overview have no history?',
      '> Can you fix the Usage tab?',
      '| Is it fixed? | yes |',
      '```ts',
      'const ok = ready ? "Is it ready?" : null',
      '```',
      'The fix uses `a ?? b` where the old code read `a ? a : b`.',
      '~~~',
      'Should this fence be read?',
      '~~~',
    ].join('\n')
    expect(questionsIn(reply)).toEqual([])
  })

  it('does not end a sentence at an abbreviation', () => {
    expect(questionsIn('Should I keep the old names, e.g. Room left, or use the new ones?'))
      .toEqual(['Should I keep the old names, e.g. Room left, or use the new ones?'])
  })

  it('passes over asides too short to be a question for the user', () => {
    expect(questionsIn('Why? Because the alias and the model differ. Ready to merge?')).toEqual(['Ready to merge?'])
  })

  it('shortens a very long question', () => {
    const long = `Should I ${'really '.repeat(80)}do it?`
    const [quoted] = questionsIn(long)
    expect(quoted).toHaveLength(400)
    expect(quoted!.endsWith('…')).toBe(true)
  })
})
