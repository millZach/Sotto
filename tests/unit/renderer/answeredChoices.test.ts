import { beforeEach, describe, expect, it } from 'vitest'
import { answeredChoices } from '../../../src/renderer/src/agents/requests/answeredChoices'

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

  it('says nothing was sent from here for a choice that main never took', () => {
    answeredChoices.note('thread', 'request', 'Allow once', false)
    expect(answeredChoices.sent('thread', 'request')).toBeUndefined()
    answeredChoices.note('thread', 'request', null, true)
    expect(answeredChoices.sent('thread', 'request')).toBe('Allow once')
  })
})
