import { describe, expect, it } from 'vitest'
import { draftBroadWork, suggestedEffortIndex } from '../../../../src/renderer/src/agents/effortSuggestion'

const CLAUDE = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
const CODEX = ['minimal', 'low', 'medium', 'high', 'xhigh']
/** More than 280 characters of material with no broad work in it, as a pasted paragraph, log or function is. */
const PASTED = 'The preview stalls after two seconds when the stream ends mid-chunk. '.repeat(5)

describe('work that splits across agents (ADR-0172 decision 5)', () => {
  it.each([
    'Refactor the whole app to use the new theme tokens',
    'Build out the usage dashboard from scratch',
    'Build 20 more composer mockup directions, quick throwaway gallery',
    'Research how other apps show reasoning effort and compare their approaches',
    'Implement the export flow for every provider:\n- a CSV button\n- a JSON button\n- a settings toggle',
  ])('reads %j as broad', draft => { expect(draftBroadWork(draft)).toBe(true) })

  it.each([
    ['one verb before pasted text', `Rewrite this paragraph: ${PASTED}`],
    ['a comparison of pasted material', `Compare these two functions: ${PASTED}`],
    ['a version number', 'Upgrade to Node 24 and pin versions'],
    ['a casual count', 'Give me 5 ideas for a name'],
    ['one refactor of one component', 'Refactor the effort picker'],
    ['a short research question', 'Research the best way to cache provider usage'],
    ['two small kinds of work', 'Compare these two functions and refactor the slower one'],
    ['a debugging session', "keyfix app needs major fixes.. super buggy and is not working. pls debug and don't report back to me till it's all working"],
  ])('does not read %s as broad', (_, draft) => { expect(draftBroadWork(draft)).toBe(false) })

  it('offers Ultracode for broad work only where the model has it, from any level but Ultracode itself', () => {
    expect(suggestedEffortIndex(1, CLAUDE, 'max', 'medium', true)).toBe(CLAUDE.indexOf('ultracode'))
    expect(suggestedEffortIndex(0, CLAUDE, '', undefined, true)).toBe(CLAUDE.indexOf('ultracode'))
    expect(suggestedEffortIndex(1, CLAUDE, 'ultracode', 'medium', true)).toBeNull()
    expect(suggestedEffortIndex(1, CODEX, 'medium', 'medium', true)).toBe(CODEX.indexOf('high'))
    expect(suggestedEffortIndex(1, CLAUDE, 'medium', 'medium', false)).toBe(CLAUDE.indexOf('high'))
  })
})
