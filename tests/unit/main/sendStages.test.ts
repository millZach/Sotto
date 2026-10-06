// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { firstOutputBaseline, lendSendStages, markSendStage, NO_SEND_STAGES, SendStageClock, showsFirstOutput } from '../../../src/main/agents/sendStages'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage } from '../../../src/shared/agents'

/** A clock whose `now` reads `time.at`, so each mark lands where the test puts it. */
function clock(receivedAt?: number) {
  const time = { at: 0 }
  return { time, clock: new SendStageClock(receivedAt, () => time.at) }
}
const message = (id: string, role: AgentMessage['role'], text = 'Filler'): AgentMessage => ({ id, role, text, createdAt: '2026-10-05T00:00:00.000Z' })
const activity = (id: string, kind: AgentActivity['kind']): AgentActivity => ({ id, turnId: 'turn', sequence: 0, kind, status: 'running', title: 'Filler' })

afterEach(() => { vi.useRealTimers() })

describe('send stage clock', () => {
  it('turns its marks into the duration of each step, with the read taken out of admission', () => {
    const { time, clock: stages } = clock(100)
    stages.addRead(30)
    for (const [at, mark] of [[150, 'dispatched'], [170, 'prepared'], [200, 'written'], [260, 'acknowledged'], [1_260, 'firstOutput']] as const) {
      time.at = at; stages.mark(mark)
    }
    expect(stages.durations()).toEqual({ admissionMs: 20, readBeforeSendMs: 30, preparationMs: 20, adapterMs: 30, acknowledgementMs: 60, firstOutputMs: 1_000 })
  })

  it('keeps the first mark of each name and leaves steps nobody marked null', () => {
    const { time, clock: stages } = clock()
    time.at = 10; stages.mark('dispatched')
    time.at = 40; stages.mark('dispatched'); stages.mark('prepared')
    time.at = 90; stages.mark('firstOutput')
    // No receipt, no read, no adapter: the first output counts from the last step that was marked.
    expect(stages.durations()).toEqual({ ...NO_SEND_STAGES, preparationMs: 30, firstOutputMs: 50 })
  })

  it('waits for the first output only once the client confirmed the prompt', async () => {
    const { clock: unconfirmed } = clock(0)
    unconfirmed.mark('dispatched'); unconfirmed.mark('written')
    expect(unconfirmed.awaitsFirstOutput()).toBe(false)
    await unconfirmed.firstOutput()
    // Watching stopped with the record, so later output is not counted.
    unconfirmed.mark('firstOutput')
    expect(unconfirmed.durations().firstOutputMs).toBeNull()

    const { time, clock: confirmed } = clock(0)
    confirmed.mark('written'); confirmed.mark('acknowledged')
    expect(confirmed.awaitsFirstOutput()).toBe(true)
    let settled = false
    const waiting = confirmed.firstOutput().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    time.at = 25; confirmed.mark('firstOutput')
    await waiting
    expect(confirmed.durations().firstOutputMs).toBe(25)
  })

  it('stops waiting when it is closed or its limit passes', async () => {
    vi.useFakeTimers()
    const { clock: closed } = clock(0)
    closed.mark('acknowledged')
    const closedListener = vi.fn()
    closed.onClosed(closedListener)
    const waiting = closed.firstOutput()
    closed.close()
    await waiting
    expect(closedListener).toHaveBeenCalledOnce()
    expect(closed.awaitsFirstOutput()).toBe(false)

    const { clock: limited } = clock(0)
    limited.mark('acknowledged')
    const limit = limited.firstOutput(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await limit
    expect(limited.durations().firstOutputMs).toBeNull()
  })

  it('reaches the layers below only by command ID, and only while it is lent', () => {
    const { time, clock: stages } = clock(0)
    const giveBack = lendSendStages('command', stages)
    time.at = 5; markSendStage('command', 'dispatched')
    time.at = 9; markSendStage('another-command', 'prepared'); markSendStage('command', 'prepared')
    giveBack()
    time.at = 20; markSendStage('command', 'written')
    expect(stages.durations()).toMatchObject({ preparationMs: 4, adapterMs: null })
  })
})

describe('first output', () => {
  const thread = { messages: [message('earlier-prompt', 'user'), message('earlier-reply', 'assistant')], activities: [activity('earlier-tool', 'tool')] }
  const baseline = firstOutputBaseline(thread)

  it('is reply text or reply activity the thread did not show before the send', () => {
    const prompt = message('prompt', 'user')
    expect(showsFirstOutput({ ...thread, messages: [...thread.messages, prompt] }, baseline)).toBe(false)
    expect(showsFirstOutput({ ...thread, messages: [...thread.messages, prompt, message('reply', 'assistant', '  ')] }, baseline)).toBe(false)
    expect(showsFirstOutput({ ...thread, messages: [...thread.messages, prompt, message('reply', 'assistant')] }, baseline)).toBe(true)
    for (const kind of ['reasoning', 'tool', 'command', 'file-change', 'plan', 'subagent'] as const) {
      expect(showsFirstOutput({ ...thread, activities: [...thread.activities, activity('new', kind)] }, baseline)).toBe(true)
    }
  })

  it('is not a turn starting, a status line, or activity that was already there', () => {
    for (const kind of ['turn', 'status', 'compaction'] as const) {
      expect(showsFirstOutput({ ...thread, activities: [...thread.activities, activity('new', kind)] }, baseline)).toBe(false)
    }
    expect(showsFirstOutput({ ...thread, activities: [{ ...activity('earlier-tool', 'tool'), status: 'completed' }] }, baseline)).toBe(false)
    expect(showsFirstOutput({ messages: [], activities: undefined }, firstOutputBaseline(undefined))).toBe(false)
  })
})
