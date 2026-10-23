import { describe, expect, it } from 'vitest'
import type { ThreadRow } from '../../../../src/renderer/src/agents/threadFacts'
import { draftThread } from '../../../../src/renderer/src/agents/draftThreads'
import { isUnsentThread, listedRows, unsentTitle, type UnsentContent } from '../../../../src/renderer/src/agents/unsentThreads'

const row = (id: string, thread: Record<string, unknown> = {}): ThreadRow =>
  ({ settledBy: null, thread: { id, title: 'New thread', titleSource: 'default', status: 'idle', messages: [], ...thread } }) as unknown as ThreadRow
const content = (text: string, more: { attachments?: unknown[]; submitted?: string } = {}): UnsentContent =>
  ({ draft: { draftId: 'd', text, attachments: more.attachments ?? [], skills: [], files: [], requestId: null }, submitted: more.submitted }) as UnsentContent

describe('unsent threads in the sidebar', () => {
  it('leaves a new thread out until something is typed, then lists it under what was typed', () => {
    const rows = [row('a'), row('b'), row('c', { titleSource: 'generated', title: 'Fix the build' })]
    const listed = listedRows(rows, id => content(id === 'b' ? '\n  Make the sidebar quieter\nand more' : '   '))
    expect(listed.map(item => [item.thread.id, item.thread.title])).toEqual([['b', 'Make the sidebar quieter and more'], ['c', 'Fix the build']])
  })

  it('keeps a thread listed under its prompt from the press of Send, sent or refused', () => {
    const listed = listedRows([row('a')], () => content('', { submitted: 'Ship it' }))
    expect(listed.map(item => item.thread.title)).toEqual(['Ship it'])
  })

  it('lists a thread holding only an attachment under its default title', () => {
    const listed = listedRows([row('a')], () => content('', { attachments: [{}] }))
    expect(listed.map(item => item.thread.title)).toEqual(['New thread'])
  })

  it('keeps a thread that has messages or is working, and the same array when nothing is unsent', () => {
    const rows = [row('a', { messages: [{}] }), row('b', { status: 'running' })]
    expect(listedRows(rows, () => content(''))).toBe(rows)
  })

  it('names the row the way the first message will name the thread', () => {
    expect(unsentTitle('x'.repeat(200))).toBe(`${'x'.repeat(59)}…`)
    expect(unsentTitle(`${'x'.repeat(58)}😀yyy`)).toBe(`${'x'.repeat(58)}…`)
  })

  it('leaves a record without a title source, settled, archived and delegated threads alone', () => {
    const rows = [row('a', { titleSource: undefined }), row('b', { settledAt: '2026-10-01T00:00:00Z' }), row('c', { archivedAt: '2026-10-01T00:00:00Z' }), row('d', { delegatedBy: 'p' }), { ...row('e'), settledBy: 'project' } as ThreadRow]
    expect(listedRows(rows, () => content('')).map(item => item.thread.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('counts the record New thread shows before main answers as unsent', () => {
    expect(isUnsentThread(draftThread({ id: 'a', projectId: 'p', title: 'New thread', modelId: 'claude:sonnet', workingCopy: 'shared' }))).toBe(true)
  })
})
