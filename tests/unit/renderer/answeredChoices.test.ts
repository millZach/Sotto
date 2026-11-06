import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentRequest } from '../../../src/shared/agents'
import { answerCount, answeredChoices, chosenCount } from '../../../src/renderer/src/agents/requests/answeredChoices'

/**
 * What this window answered, kept for Watcher's line about each request (ADR-0073, answering in Watcher's conversation),
 * follows each request's life as the window reads its threads, whether or not Watcher is on screen.
 */
describe('what this window answered', () => {
  beforeEach(() => { answeredChoices.clear() })

  it('keeps the choice while the request waits and after it leaves, for the line that replaces its card', () => {
    answeredChoices.note('thread', 'request', 'Use the staging key', true)
    answeredChoices.observe('thread', [{ id: 'request' }])
    expect(answeredChoices.sent('thread', 'request')).toBe('Use the staging key')
    answeredChoices.observe('thread', [])
    answeredChoices.observe('thread', [])
    expect(answeredChoices.sent('thread', 'request')).toBe('Use the staging key')
  })

  it('forgets the choice when a request waits again under an ID its provider used before', () => {
    answeredChoices.note('thread', 'request', 'Use the staging key', true)
    answeredChoices.observe('thread', [])
    answeredChoices.observe('thread', [{ id: 'request' }])
    expect(answeredChoices.sent('thread', 'request')).toBeUndefined()
    expect(answeredChoices.has('thread')).toBe(false)
  })

  it('reads only threads it keeps something for, and forgets a thread that is gone', () => {
    expect(answeredChoices.has('thread')).toBe(false)
    answeredChoices.note('thread', 'request', 'Deny', true)
    expect(answeredChoices.has('thread')).toBe(true)
    answeredChoices.observe('other', [{ id: 'request' }])
    expect(answeredChoices.sent('thread', 'request')).toBe('Deny')
  })

  it('keeps how many choices an answer carried, from whichever note counted them', () => {
    answeredChoices.note('thread', 'request', 'Ara, Rex, Two seconds', false, 3)
    expect(answeredChoices.choices('thread', 'request')).toBeUndefined()
    answeredChoices.note('thread', 'request', 'Ara, Rex, Two seconds', true)
    expect(answeredChoices.choices('thread', 'request')).toBe(3)
  })

  it('says nothing was sent from here for a choice that main never took', () => {
    answeredChoices.note('thread', 'request', 'Allow once', false)
    expect(answeredChoices.sent('thread', 'request')).toBeUndefined()
    answeredChoices.note('thread', 'request', null, true)
    expect(answeredChoices.sent('thread', 'request')).toBe('Allow once')
  })
})

describe('how many choices an answer carried', () => {
  const asked: AgentRequest = { id: 'voices', kind: 'question', text: 'Voice previews', options: [], questions: [
    { id: 'voices', question: 'Which voices?', multiSelect: true, allowFreeText: false, options: [{ id: 'ara', label: 'Ara, the bright one' }, { id: 'rex', label: 'Rex' }, { id: 'eve', label: 'Eve' }] },
    { id: 'length', question: 'How long?', multiSelect: false, allowFreeText: true, options: [{ id: 'two', label: 'Two seconds' }] },
  ] }
  it('counts each option picked and an answer of the user’s own, whatever commas the labels hold', () => {
    const selections = { voices: { optionIds: ['ara', 'rex'], other: false, text: '' }, length: { optionIds: [], other: true, text: 'Three seconds' } }
    expect(chosenCount(asked, { choice: null, selections })).toBe(3)
    expect(answerCount(asked, { answer: '', questionAnswers: { voices: { optionIds: ['ara', 'rex', 'eve'] }, length: { optionIds: ['two'] } } })).toBe(4)
    expect(chosenCount(asked, { choice: 'skip', selections })).toBe(0)
    const permission: AgentRequest = { id: 'p', kind: 'permission', text: 'Run the suite', options: [] }
    expect(chosenCount(permission, { choice: 'allow', selections: {} })).toBe(1)
    expect(answerCount(permission, { answer: 'Allow', approved: true })).toBe(1)
  })
})
