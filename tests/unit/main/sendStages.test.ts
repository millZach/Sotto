// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { firstOutputBaseline, FirstOutputWatches, holdTurnEnd, lendSendStages, markSendStage, SEND_STAGE_FIELDS, SendStageClock, showsFirstOutput } from '../../../src/main/agents/sendStages'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
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
    expect(stages.durations()).toEqual({ ...Object.fromEntries(SEND_STAGE_FIELDS.map(field => [field, null])), preparationMs: 30, firstOutputMs: 50 })
  })

  it('waits for the first output only once the client confirmed the prompt', async () => {
    const { clock: unconfirmed } = clock(0)
    unconfirmed.mark('dispatched'); unconfirmed.mark('written')
    expect(unconfirmed.awaitsFirstOutput()).toBe(false)
    await unconfirmed.untilFirstOutput()
    // Watching stopped with the record, so later output is not counted.
    unconfirmed.mark('firstOutput')
    expect(unconfirmed.durations().firstOutputMs).toBeNull()

    const { time, clock: confirmed } = clock(0)
    confirmed.mark('written'); confirmed.mark('acknowledged')
    expect(confirmed.awaitsFirstOutput()).toBe(true)
    let settled = false
    const waiting = confirmed.untilFirstOutput().then(() => { settled = true })
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
    const waiting = closed.untilFirstOutput()
    closed.close()
    await waiting
    expect(closedListener).toHaveBeenCalledOnce()
    expect(closed.awaitsFirstOutput()).toBe(false)

    const { clock: limited } = clock(0)
    limited.mark('acknowledged')
    const limit = limited.untilFirstOutput(1_000)
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

  it('holds a record for the end of a turn its adapter times, until the adapter reports it, the clock closes or its limit passes (#1420)', async () => {
    vi.useFakeTimers()
    const { clock: timed } = clock(0)
    timed.mark('acknowledged')
    const giveBack = lendSendStages('command', timed)
    const report = holdTurnEnd('command')!
    giveBack()
    expect(holdTurnEnd('command')).toBeUndefined()
    // The first output ends that wait, not this one.
    timed.mark('firstOutput')
    expect([timed.awaitsFirstOutput(), timed.awaitsTurnEnd()]).toEqual([false, true])
    let ended = false
    const waiting = timed.untilTurnEnd().then(() => { ended = true })
    await Promise.resolve()
    expect(ended).toBe(false)
    report({ turnFirstOutputMs: 1_234.4, turnFinishWaitMs: 21_600.6 })
    await waiting
    expect(timed.turnEndTimings()).toEqual({ turnFirstOutputMs: 1_234, turnFinishWaitMs: 21_601 })
    // Only the first report counts, and a number that is not one is null.
    report({ turnFirstOutputMs: 1, turnFinishWaitMs: 1 })
    expect(timed.turnEndTimings()).toEqual({ turnFirstOutputMs: 1_234, turnFinishWaitMs: 21_601 })
    const { clock: odd } = clock(0)
    odd.holdTurnEnd()({ turnFirstOutputMs: Number.NaN, turnFinishWaitMs: null })
    expect(odd.turnEndTimings()).toEqual({ turnFirstOutputMs: null, turnFinishWaitMs: null })

    const { clock: closed } = clock(0)
    const late = closed.holdTurnEnd()
    const closing = closed.untilTurnEnd()
    closed.close()
    await closing
    late({ turnFirstOutputMs: 5, turnFinishWaitMs: 5 })
    expect([closed.awaitsTurnEnd(), closed.turnEndTimings()]).toEqual([false, undefined])
    // A clock already closed holds nothing.
    closed.holdTurnEnd()
    expect(closed.awaitsTurnEnd()).toBe(false)

    const { clock: limited } = clock(0)
    limited.holdTurnEnd()
    const limit = limited.untilTurnEnd(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await limit
    expect([limited.awaitsTurnEnd(), limited.turnEndTimings()]).toEqual([false, undefined])
  })

  it('never throws into the send that marks it', () => {
    const stages = new SendStageClock(0, () => { throw new Error('Synthetic clock failure') })
    const giveBack = lendSendStages('command', stages)
    try { expect(() => markSendStage('command', 'acknowledged')).not.toThrow() } finally { giveBack() }
  })

  it('is marked prepared by the workspace before the provider stack is handed the send', async () => {
    const f = await workspaceFixture()
    try {
      const snapshot = await f.host.connect()
      const project = snapshot.projects.find(item => item.providerId === 'codex')!
      const model = snapshot.models.find(item => item.providerId === 'codex')!
      await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'timed', projectId: project.id, title: 'Timed', modelId: model.id })
      const stages = new SendStageClock()
      const preparedWhenSent: boolean[] = []
      const execute = f.adapters.codex.execute.bind(f.adapters.codex)
      vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
        if (command.type === 'send') preparedWhenSent.push(stages.has('prepared'))
        return execute(command)
      })
      const giveBack = lendSendStages('timed-send', stages)
      try { expect(await f.host.execute({ type: 'send', commandId: 'timed-send', threadId: 'timed', messageId: 'timed-message', text: 'Filler' })).toMatchObject({ accepted: true }) }
      finally { giveBack() }
      expect(preparedWhenSent).toEqual([true])
    } finally { vi.restoreAllMocks(); await f.stop(); await f.remove() }
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

  it('is watched for per thread: marked when it shows, or given up when the reply ends without it', () => {
    const watches = new FirstOutputWatches()
    const shown = (id: string, extra: Partial<{ status: 'running' | 'idle'; messages: AgentMessage[] }> = {}) =>
      ({ id, status: extra.status ?? 'running' as const, messages: extra.messages ?? thread.messages, activities: thread.activities })
    const { clock: answered } = clock(0)
    answered.mark('acknowledged')
    watches.watch('answered', answered, thread)
    const { clock: silent } = clock(0)
    silent.mark('acknowledged')
    watches.watch('silent', silent, thread)
    watches.observe([shown('answered'), shown('silent')])
    expect([answered.has('firstOutput'), answered.awaitsFirstOutput(), silent.awaitsFirstOutput()]).toEqual([false, true, true])
    watches.observe([shown('answered', { messages: [...thread.messages, message('reply', 'assistant')] }), shown('silent', { status: 'idle' })])
    expect(answered.has('firstOutput')).toBe(true)
    expect([silent.has('firstOutput'), silent.awaitsFirstOutput()]).toEqual([false, false])

    // A newer send to the same thread replaces the older one, and closing them all stops every wait.
    const { clock: older } = clock(0); older.mark('acknowledged')
    const { clock: newer } = clock(0); newer.mark('acknowledged')
    watches.watch('thread', older, thread); watches.watch('thread', newer, thread)
    expect([older.awaitsFirstOutput(), newer.awaitsFirstOutput()]).toEqual([false, true])
    watches.closeAll()
    expect(newer.awaitsFirstOutput()).toBe(false)
  })

  it('keeps watching a reply whose adapter times its turn until the turn shows ended, and closing them all ends that wait too (#1420)', () => {
    const watches = new FirstOutputWatches()
    const replied = (id: string, status: 'running' | 'idle') =>
      ({ id, status, messages: [...thread.messages, message('reply', 'assistant')], activities: thread.activities })
    const { clock: timed } = clock(0)
    timed.mark('acknowledged'); timed.holdTurnEnd()
    watches.watch('timed', timed, thread)
    watches.observe([replied('timed', 'running')])
    expect([timed.has('firstOutput'), timed.awaitsTurnEnd()]).toEqual([true, true])
    // The adapter reports before its thread shows the turn ended; one that has not by then is given up.
    watches.observe([replied('timed', 'idle')])
    expect(timed.awaitsTurnEnd()).toBe(false)

    const { clock: open } = clock(0)
    open.mark('acknowledged'); open.holdTurnEnd()
    watches.watch('open', open, thread)
    watches.observe([replied('open', 'running')])
    watches.closeAll()
    expect(open.awaitsTurnEnd()).toBe(false)
  })

  it('is seen in the summary of a thread no pane shows, whose messages are not held', () => {
    const summarised = (id: string, text: string) => ({ messages: [], activities: [],
      summary: { messageCount: 3, activityCount: 0, lastAssistant: { id, text, createdAt: '2026-10-06T00:00:00.000Z' } } })
    const atSend = firstOutputBaseline(summarised('earlier-reply', 'Earlier words'))
    expect(showsFirstOutput(summarised('earlier-reply', 'Earlier words'), atSend)).toBe(false)
    expect(showsFirstOutput(summarised('reply', ' '), atSend)).toBe(false)
    expect(showsFirstOutput(summarised('reply', 'First words'), atSend)).toBe(true)
  })

  it('is given up when the reply\'s turn has already ended by the first snapshot after the acknowledgement', () => {
    const watches = new FirstOutputWatches()
    const earlier = { id: 'earlier-turn', status: 'completed' as const }
    const { clock: fast } = clock(0); fast.mark('acknowledged')
    watches.watch('fast', fast, { ...thread, lastTurn: earlier })
    // Idle with the turn the thread already had: nothing says the reply's turn ran yet, so the wait goes on.
    watches.observe([{ id: 'fast', status: 'idle', messages: thread.messages, activities: thread.activities, lastTurn: earlier }])
    expect(fast.awaitsFirstOutput()).toBe(true)
    // Idle with a finished turn it did not have at the send, never seen running: the reply ended without output.
    watches.observe([{ id: 'fast', status: 'idle', messages: thread.messages, activities: thread.activities, lastTurn: { id: 'reply-turn', status: 'failed' } }])
    expect([fast.has('firstOutput'), fast.awaitsFirstOutput()]).toEqual([false, false])
  })
})
