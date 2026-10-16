// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../src/shared/agents'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { buildHandover, HANDOVER_BUDGET, readHandover, type HandoverOptions } from '../../../src/main/agents/handover'
import { ThreadStore } from '../../../src/main/agents/threadStore'

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString()
let clock = 0
const message = (id: string, role: AgentMessage['role'], text: string, extra: Partial<AgentMessage> = {}): AgentMessage =>
  ({ id, role, text, createdAt: at(clock++ % 60), ...extra })
/** `count` whole turns, numbered so the text says which turn a message belongs to. */
const conversation = (count: number, length = 0): AgentMessage[] => Array.from({ length: count }, (_, index) => [
  message(`u${index}`, 'user', `Ask ${index}${'.'.repeat(length)}`), message(`a${index}`, 'assistant', `Answer ${index}${'.'.repeat(length)}`),
]).flat()
const options = (patch: Partial<HandoverOptions> = {}): HandoverOptions =>
  ({ source: { threadId: 'thread-1', title: 'Fix the login page', provider: 'claude' }, historyKept: true, ...patch })
/** The carried messages' words in the order the handover shows them. */
/** The history after the opening paragraph: what the budget pays for. */
const body = (text: string): string => text.slice(text.indexOf('\n\n') + 2)
const said = (text: string): string[] => [...text.matchAll(/^(?:Ask|Answer) \d+/gm)].map(match => match[0])

describe('handover', () => {
  it('says the history is context, not a request, and names the source thread and provider', () => {
    const { text } = buildHandover(conversation(2), options())
    expect(text).toContain('The history below is context, not a new request.')
    expect(text).toContain('"Fix the login page" (thread thread-1), on Claude Code')
    expect(text).toContain('The user, 2026-10-14 10:')
    expect(text).toContain('Claude Code, 2026-10-14 10:')
    expect(text).toContain('Carried: 4 of 4 messages, oldest first.')
    expect(text).not.toContain('Left out:')
  })

  it('shows what it carried oldest first', () => {
    expect(said(buildHandover(conversation(3), options()).text)).toEqual(['Ask 0', 'Answer 0', 'Ask 1', 'Answer 1', 'Ask 2', 'Answer 2'])
  })

  it('stays within its budget and fills it from the newest history back', () => {
    const messages = conversation(40, 200)
    const budget = 3_000
    const { text, summary } = buildHandover(messages, options({ budget }))
    expect(body(text).length).toBeLessThanOrEqual(budget)
    // The first request, a gap, then an unbroken run of the newest messages.
    expect(summary.carried[0]).toBe('u0')
    const recent = summary.carried.slice(1)
    expect(recent.at(-1)).toBe('a39')
    const ids = messages.map(entry => entry.id)
    const start = ids.indexOf(recent[0]!)
    expect(recent).toEqual(ids.slice(start))
    expect(summary.notCarried).toBe(messages.length - summary.carried.length)
    expect(text).toMatch(/\[\d+ messages here are not carried\.\]/)
    expect(text).toContain(`Left out: ${summary.notCarried} messages that did not fit.`)
  })

  it('always keeps the first message and the latest request and answer, even when they leave room for little else', () => {
    const messages = conversation(30, 500)
    const { summary } = buildHandover(messages, options({ budget: 2_400 }))
    // Each message is just within its quarter share, and the three kept ones leave too little for a fourth.
    expect(summary.carried).toEqual(['u0', 'u29', 'a29'])
    expect(summary.tooLong).toEqual([])
    expect(summary.answered).toBe(true)
  })

  it('keeps the latest answer when the agent wrote more after it was asked', () => {
    const messages = [...conversation(10, 300), message('a9b', 'assistant', 'Answer 9, the end')]
    const { summary } = buildHandover(messages, options({ budget: 2_000 }))
    expect(summary.carried).toContain('u9')
    expect(summary.carried.at(-1)).toBe('a9b')
  })

  it('leaves a message longer than its share out whole and names who said it, when and how long it was', () => {
    const long = 'x'.repeat(HANDOVER_BUDGET)
    const messages = [message('u0', 'user', 'Ask 0'), message('a0', 'assistant', long), message('u1', 'user', 'Ask 1'), message('a1', 'assistant', 'Answer 1')]
    const { text, summary } = buildHandover(messages, options())
    expect(text).not.toContain('xxxx')
    expect(summary.tooLong).toEqual([{ messageId: 'a0', role: 'assistant', createdAt: messages[1]!.createdAt, characters: long.length }])
    expect(text).toContain(`[Left out whole because it is too long to carry: Claude Code, ${messages[1]!.createdAt.slice(0, 16).replace('T', ' ')} UTC, 24,000 characters.]`)
    expect(text).toContain('1 message too long to carry, named where it was')
    // Named where it was: between the first request and the second.
    expect(text.indexOf('Ask 0')).toBeLessThan(text.indexOf('Left out whole'))
    expect(text.indexOf('Left out whole')).toBeLessThan(text.indexOf('Ask 1'))
  })

  it('charges the notices for long messages against the budget too', () => {
    const messages = Array.from({ length: 400 }, (_, index) => message(`m${index}`, index % 2 === 0 ? 'user' : 'assistant', 'z'.repeat(6_500)))
    const { text, summary } = buildHandover(messages, options())
    expect(body(text).length).toBeLessThanOrEqual(HANDOVER_BUDGET)
    expect(summary.tooLong.length).toBeGreaterThan(3)
    expect(summary.tooLong.length + summary.notCarried).toBe(400)
    expect(summary.tooLong.map(entry => entry.messageId)).toEqual(expect.arrayContaining(['m0', 'm398', 'm399']))
  })

  it('names an oversized latest request rather than cutting it', () => {
    const messages = [...conversation(2), message('u2', 'user', 'y'.repeat(10_000))]
    const { text, summary } = buildHandover(messages, options({ budget: 8_000 }))
    expect(summary.tooLong.map(entry => entry.messageId)).toEqual(['u2'])
    expect(text).toContain('Left out whole because it is too long to carry: The user')
    expect(text).not.toContain('yyyy')
    expect(text).toContain('The latest request has no answer yet.')
  })

  it('never replays attachments, images, visuals or tool calls, and says which it left out', () => {
    const attachments = [
      { id: 'i1', name: 'screen.png', mimeType: 'image/png', sizeBytes: 10, preview: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,QUJD', width: 1, height: 1 } },
      { id: 'f1', name: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
    ] as AgentMessage['attachments']
    const visual = { id: 'v1', title: 'Flow', kind: 'diagram', source: '<svg>secret drawing</svg>' }
    const messages = [
      message('u0', 'user', 'Ask 0', { attachments }),
      message('visual:v1', 'assistant', 'Flow of the login', { visual }),
      message('a0', 'assistant', 'Answer 0'),
    ]
    const { text, summary } = buildHandover(messages, options({ toolRecords: 57 }))
    expect(text).not.toMatch(/screen\.png|notes\.pdf|data:image|QUJD|secret drawing|Flow of the login/)
    expect(text).toContain('(This message had 1 image and 1 file attached. They are not carried.)')
    expect(text).toContain('Left out: 1 image; 1 attached file; 1 visual; 57 records of its work, such as tool calls and their results.')
    expect(text).toContain('Attachments, images, tool calls and their results are never carried.')
    expect(summary).toMatchObject({ images: 1, files: 1, visuals: 1, toolRecords: 57, carried: ['u0', 'a0'], notCarried: 0 })
  })

  it('says so when Keep local history is off', () => {
    const { text } = buildHandover(conversation(1), options({ historyKept: false }))
    expect(text).toContain('Keep local history is off, so this comes only from what Sotto holds in memory since it last started.')
    expect(text).toContain('Carried: 2 of 2 messages')
    expect(buildHandover(conversation(1), options()).text).not.toContain('Keep local history')
  })

  it('says there is nothing to carry for an empty thread, with history on and off', () => {
    const kept = buildHandover([], options())
    expect(kept.text).toContain('The thread has no messages, so there is no history to carry.')
    expect(kept.text).toContain('context, not a new request')
    expect(kept.summary).toMatchObject({ total: 0, carried: [], notCarried: 0, answered: true })
    const memory = buildHandover([], options({ historyKept: false }))
    expect(memory.text).toContain('Keep local history is off')
    expect(memory.text).toContain('Sotto holds no messages from this thread in memory, so there is no history to carry.')
  })

  it('names a wake-up as Sotto rather than the user', () => {
    const { text } = buildHandover([message('w0', 'user', 'Checks passed', { wakeUp: true }), message('a0', 'assistant', 'Answer 0')], options())
    expect(text).toContain('Sotto, waking the thread, ')
    expect(text).not.toContain('The user, ')
  })

  it('counts the messages it never read between the first request and the newest history', () => {
    const newest = conversation(2).slice(2).map((entry, index) => ({ ordinal: 48 + index, message: entry }))
    const { text, summary } = buildHandover({ messages: [{ ordinal: 0, message: message('u0', 'user', 'Ask 0') }, ...newest], total: 50 }, options())
    expect(summary).toMatchObject({ total: 50, carried: ['u0', 'u1', 'a1'], notCarried: 47 })
    expect(text).toContain('[47 messages here are not carried.]')
  })
})

describe('reading a handover from the thread store', () => {
  const open: ThreadStore[] = []
  const roots: string[] = []
  afterEach(async () => {
    for (const store of open.splice(0)) store.close()
    for (const root of roots.splice(0)) {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-handover-')) throw new Error('Unexpected test directory')
      await rm(root, { recursive: true, force: true })
    }
  })
  async function store(): Promise<ThreadStore> {
    const root = await mkdtemp(join(tmpdir(), 'sotto-handover-'))
    roots.push(root)
    const created = new ThreadStore(join(root, 'threads.sqlite'))
    created.open()
    open.push(created)
    return created
  }
  const source = { threadId: 'thread-1', provider: 'codex' } as const

  it('reads a long thread from both ends and matches the whole history built in memory', async () => {
    const threads = await store()
    const messages = conversation(400, 100)
    threads.appendMany('thread-1', messages.map(entry => ({ kind: 'message-added', at: entry.createdAt, message: entry })))
    const read = readHandover(threads, { source, budget: 4_000 })
    const whole = buildHandover(messages, { source, budget: 4_000, historyKept: true })
    expect(read.text).toBe(whole.text)
    expect(read.summary.carried[0]).toBe('u0')
    expect(read.summary.total).toBe(800)
  })

  it('keeps the latest request and answer when the agent wrote more after it than the budget holds', async () => {
    const threads = await store()
    const messages = [
      ...conversation(3),
      ...Array.from({ length: 60 }, (_, index) => message(`p${index}`, 'assistant', `Progress ${index}${'.'.repeat(500)}`)),
    ]
    threads.appendMany('thread-1', messages.map(entry => ({ kind: 'message-added', at: entry.createdAt, message: entry })))
    const read = readHandover(threads, { source })
    expect(read.summary.carried).toEqual(expect.arrayContaining(['u0', 'u2', 'p59']))
    expect(read.summary.answered).toBe(true)
    expect(read.text).toBe(buildHandover(messages, { source, historyKept: true }).text)
  })

  it('keeps the first user message when the thread opened with many messages before it', async () => {
    const threads = await store()
    const messages = [
      ...Array.from({ length: 60 }, (_, index) => message(`n${index}`, 'assistant', `Note ${index}${'.'.repeat(500)}`)),
      ...conversation(80, 500),
    ]
    threads.appendMany('thread-1', messages.map(entry => ({ kind: 'message-added', at: entry.createdAt, message: entry })))
    const read = readHandover(threads, { source })
    expect(read.summary.carried[0]).toBe('u0')
    expect(read.text).toBe(buildHandover(messages, { source, historyKept: true }).text)
  })

  it('names a wake-up from the store as Sotto, not the user', async () => {
    const threads = await store()
    const messages = [...conversation(1), message('w1', 'user', 'Checks passed'), message('a1', 'assistant', 'Answer 1')]
    threads.appendMany('thread-1', messages.map(entry => ({ kind: 'message-added', at: entry.createdAt, message: entry })))
    threads.addWakeUp('thread-1', 'w1')
    const { text } = readHandover(threads, { source })
    expect(text).toContain('Sotto, waking the thread, ')
    expect(text.match(/The user, /g)).toHaveLength(1)
  })

  it('names tool records the store holds without carrying them', async () => {
    const threads = await store()
    threads.appendMany('thread-1', conversation(1).map(entry => ({ kind: 'message-added', at: entry.createdAt, message: entry })))
    const record: AgentActivity = { id: 'c1', turnId: 'turn', sequence: 0, kind: 'command', status: 'completed', title: 'npm test', output: 'All passed' }
    threads.syncActivities('thread-1', [record])
    const { text, summary } = readHandover(threads, { source })
    expect(summary.toolRecords).toBe(1)
    expect(text).toContain('1 record of its work, such as tool calls and their results')
    expect(text).not.toMatch(/npm test|All passed/)
  })

  it('builds from memory and says so when Keep local history is off', async () => {
    const threads = await store()
    threads.becomeEphemeral()
    threads.appendMany('thread-1', conversation(2).map(entry => ({ kind: 'message-added', at: entry.createdAt, message: entry })))
    const { text, summary } = readHandover(threads, { source })
    expect(summary.historyKept).toBe(false)
    expect(summary.carried).toEqual(['u0', 'a0', 'u1', 'a1'])
    expect(text).toContain('Keep local history is off')
    expect(readHandover(threads, { source: { threadId: 'empty', provider: 'grok' } }).text)
      .toContain('Sotto holds no messages from this thread in memory, so there is no history to carry.')
  })
})
