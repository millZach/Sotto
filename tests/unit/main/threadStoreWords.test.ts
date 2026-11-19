// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../src/shared/agents'
import { agentThreadWordsSchema, THREAD_WORDS_MOST, THREAD_WORDS_QUOTE, threadWordHit, threadWordQuote, threadWordsQuery } from '../../../src/shared/threadWords'
import { ThreadStore } from '../../../src/main/agents/threadStore'

const open: ThreadStore[] = []
const roots: string[] = []
afterEach(async () => {
  for (const store of open.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-thread-words-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function store(): Promise<ThreadStore> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-thread-words-'))
  roots.push(root)
  const created = new ThreadStore(join(root, 'threads.sqlite'))
  created.open()
  open.push(created)
  return created
}

const at = (minute: number): string => new Date(Date.UTC(2026, 10, 19, 10, minute)).toISOString()
const message = (id: string, role: AgentMessage['role'], text: string, minute = 0): AgentMessage => ({ id, role, text, createdAt: at(minute) })
const add = (target: ThreadStore, threadId: string, messages: AgentMessage[]): void => {
  target.appendMany(threadId, messages.map(item => ({ kind: 'message-added', at: item.createdAt, message: item })))
}

describe('Search threads’ read of what was said', () => {
  it('finds a phrase only inside a thread, quoting its newest match and counting the others', async () => {
    const target = await store()
    add(target, 'boiler', [
      message('u0', 'user', 'Check the purge timer in the boiler sequence.', 1),
      message('a0', 'assistant', 'The PURGE runs 90 s before the pilot, as the manual says.', 2),
      message('u1', 'user', 'And the pilot?', 3),
    ])
    add(target, 'owl', [message('u0', 'user', 'Make the owl sprite blink.', 5)])
    const read = target.threadWords('  purge ')
    expect(agentThreadWordsSchema.parse(read)).toEqual(read)
    // Case is ignored, and the newest matching message is the quote: the reply, with one other message matching.
    expect(read.found).toEqual([{ threadId: 'boiler', messageId: 'a0', role: 'assistant', quote: 'The PURGE runs 90 s before the pilot, as the manual says.', more: 1 }])
    expect(target.threadWords('sprite').found).toMatchObject([{ threadId: 'owl', role: 'user', more: 0 }])
    expect(target.threadWords('nothing like this').found).toEqual([])
    expect(target.threadWords('   ').found).toEqual([])
  })

  it('leaves out a wake-up, which is Sotto’s, and matches LIKE’s wildcards as the characters they are', async () => {
    const target = await store()
    add(target, 'babysat', [
      message('u0', 'user', 'Babysit #74 until it merges.', 1),
      message('wake', 'user', 'Checks on #74 are green; merge when ready.', 2),
      message('a0', 'assistant', 'Coverage is 100% on the new file.', 3),
      message('a1', 'assistant', 'Coverage is 1000 lines now.', 4),
    ])
    target.addWakeUp('babysat', 'wake')
    expect(target.threadWords('green').found).toEqual([])
    expect(target.threadWords('#74').found).toMatchObject([{ messageId: 'u0', more: 0 }])
    // `%` and `_` are no wildcards here: "100%" is not "1000".
    expect(target.threadWords('100%').found).toMatchObject([{ messageId: 'a0', more: 0 }])
    expect(target.threadWords('100_').found).toEqual([])
  })

  it('orders threads by their newest match and names at most a page of them', async () => {
    const target = await store()
    for (let index = 0; index < THREAD_WORDS_MOST + 5; index++) add(target, `thread-${index}`, [message('u0', 'user', `Rust port note ${index}`, index % 60)])
    add(target, 'newest', [message('u0', 'user', 'The rust port again', 59), message('a0', 'assistant', 'Still the rust port.', 59)])
    const found = target.threadWords('rust port').found
    expect(found).toHaveLength(THREAD_WORDS_MOST)
    const times = found.map(match => Number(match.threadId === 'newest' ? 59 : Number(match.threadId.slice(7)) % 60))
    expect(times).toEqual([...times].sort((first, second) => second - first))
  })

  it('quotes the match it orders the thread by: its last in the conversation, whatever the clock says', async () => {
    const target = await store()
    // The later message carries the earlier time, as a provider's corrected timestamp can.
    add(target, 'clock', [message('u0', 'user', 'purge first', 30), message('u1', 'user', 'purge later', 10)])
    add(target, 'between', [message('u0', 'user', 'purge between', 20)])
    expect(target.threadWords('purge').found.map(match => [match.threadId, match.messageId])).toEqual([['between', 'u0'], ['clock', 'u1']])
  })

  it('quotes a long message around its match, on one line, cut at both ends', async () => {
    const target = await store()
    const long = `${'Opening words. '.repeat(30)}Here the\n\nneedle sits${' and the message goes on'.repeat(30)}`
    add(target, 'long', [message('a0', 'assistant', long, 1)])
    const [match] = target.threadWords('needle').found
    expect(match!.quote.startsWith('…')).toBe(true)
    expect(match!.quote.endsWith('…')).toBe(true)
    expect(match!.quote).toContain('Here the needle sits')
    expect(match!.quote).not.toContain('\n')
    expect(match!.quote.length).toBeLessThanOrEqual(THREAD_WORDS_QUOTE + 2)
  })
})

describe('a quote and a search as the store reads them', () => {
  it('never starts or ends on half a character, and marks only the ends it cut', () => {
    expect(threadWordQuote('whole message', 0, true)).toBe('whole message')
    expect(threadWordQuote('\uDE00 after a cut pair', 12, true)).toBe('…after a cut pair')
    const cut = threadWordQuote(`${'a'.repeat(THREAD_WORDS_QUOTE - 1)}😀 more`, 0, false)
    expect(cut).toBe(`${'a'.repeat(THREAD_WORDS_QUOTE - 1)}…`)
    expect(threadWordsQuery(`  ${'b'.repeat(199)}😀tail  `)).toBe('b'.repeat(199))
    expect(threadWordsQuery(' purge  \n timer ')).toBe('purge timer')
  })

  it('finds the search in a quote whose spaces were run together, and says when the quote does not show it', () => {
    // The store matched "purge   timer"; the quote holds it on one line.
    expect(threadWordHit('…the Purge timer runs', '  purge   timer ')).toEqual({ start: 5, length: 11 })
    expect(threadWordHit('…cut before the', 'the match')).toBeUndefined()
    expect(threadWordHit('anything', '   ')).toBeUndefined()
  })
})
