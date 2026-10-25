// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parsePrototypeSource, replySource, requestSource } from '../../../src/main/agents/prototypeSources'
import { watcherPrototypeFields, watcherPrototypeSource } from '../../../src/main/agents/watcherNews'

// Where a prototype's pages were found (ADR-0108), written one way for QuestionPages, the mark and Watcher's news.

describe('prototype sources', () => {
  it('writes a question’s and a reply’s source and reads them back, IDs with colons included', () => {
    expect(requestSource('q:1')).toBe('request:q:1')
    expect(replySource('m-1')).toBe('reply:m-1')
    expect(parsePrototypeSource(requestSource('q:1'))).toEqual({ kind: 'request', id: 'q:1' })
    expect(parsePrototypeSource(replySource('m-1'))).toEqual({ kind: 'reply', id: 'm-1' })
    for (const other of ['reply:', 'request', 'turn:1', ':1', '']) expect(parsePrototypeSource(other), other).toBeUndefined()
  })

  it('carries a source in Watcher’s news and back, and leaves out one too long to carry', () => {
    for (const source of [requestSource('q'), replySource('m')]) expect(watcherPrototypeSource(watcherPrototypeFields(source)!)).toBe(source)
    expect(watcherPrototypeFields(replySource('m'.repeat(512)))).toEqual({ messageId: 'm'.repeat(512) })
    expect(watcherPrototypeFields(replySource('m'.repeat(513)))).toBeUndefined()
    expect(watcherPrototypeFields('turn:1')).toBeUndefined()
  })
})
