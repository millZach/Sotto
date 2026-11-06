// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { replySource, requestSource } from '../../../src/main/agents/prototypeSources'

// Where a prototype's pages were found (ADR-0108), written one way for QuestionPages and the mark.

describe('prototype sources', () => {
  it('writes a question’s and a reply’s source, IDs with colons included', () => {
    expect(requestSource('q:1')).toBe('request:q:1')
    expect(replySource('m-1')).toBe('reply:m-1')
  })
})
