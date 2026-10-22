import { describe, expect, it } from 'vitest'
import type { ThreadRow } from '../../../../src/renderer/src/agents/threadFacts'
import { listedRows, unsentTitle } from '../../../../src/renderer/src/agents/unsentThreads'

const row = (id: string, thread: Record<string, unknown> = {}): ThreadRow =>
  ({ thread: { id, title: 'New thread', titleSource: 'default', status: 'idle', messages: [], ...thread } }) as unknown as ThreadRow

describe('unsent threads in the sidebar', () => {
  it('leaves a new thread out until something is typed, then lists it under what was typed', () => {
    const rows = [row('a'), row('b'), row('c', { titleSource: 'generated', title: 'Fix the build' })]
    const listed = listedRows(rows, id => id === 'b' ? '\n  Make the sidebar quieter\nand more' : '   ')
    expect(listed.map(item => [item.thread.id, item.thread.title])).toEqual([['b', 'Make the sidebar quieter'], ['c', 'Fix the build']])
  })

  it('keeps a thread that has messages or is working, and the same array when nothing is unsent', () => {
    const rows = [row('a', { messages: [{}] }), row('b', { status: 'running' })]
    expect(listedRows(rows, () => '')).toBe(rows)
  })

  it('shortens a long first line', () => {
    expect(unsentTitle('x'.repeat(200))).toHaveLength(80)
  })
})
