import { describe, expect, it } from 'vitest'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import type { ThreadSwitchTiming } from '../../../src/shared/mainActivity'
import { THREAD_SWITCH_GIVE_UP_MS, ThreadSwitchClock } from '../../../src/renderer/src/agents/threadSwitchClock'

/** A clock the test moves; the frame runs at `frameAt` and the task after it at `at` when the test paints. */
function rig() {
  let now = 1_000
  let onScreen: string | null = null
  const frames: (() => void)[] = [], tasks: (() => void)[] = [], reports: ThreadSwitchTiming[] = []
  const clock = new ThreadSwitchClock({ now: () => now, frame: callback => frames.push(callback), later: callback => tasks.push(callback),
    shown: threadId => onScreen === threadId, report: timing => reports.push(timing) })
  const paint = (at: number, frameAt = at): void => { now = frameAt; for (const frame of frames.splice(0)) frame(); now = at; for (const task of tasks.splice(0)) task() }
  return { clock, reports, paint, at: (value: number) => { now = value }, show: (threadId: string | null) => { onScreen = threadId } }
}

function state(activeThreadId: string, thread: Partial<AgentThread>): AgentState {
  const threads = [{ id: 'other', messages: [] }, { id: activeThreadId, messages: [], ...thread }] as unknown as AgentThread[]
  return { activeThreadId, host: { hostId: 'laptop', threads } } as unknown as AgentState
}

const messages = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `m${index}` })) as unknown as AgentThread['messages']
const activities = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `a${index}` })) as unknown as AgentThread['activities']
const press = (type: string, timeStamp: number) => ({ type, timeStamp }) as Event

describe('the window’s clock on a thread switch', () => {
  it('times a switch from the press to the frame painted with the thread’s history', () => {
    const { clock, reports, paint, at, show } = rig()
    show('t1')
    clock.start('t1', { held: false, threads: 1_065 }, press('click', 940))
    at(1_150); clock.replyDrawn('t1')
    // The selection is drawn while the history is on its way: nothing ends yet.
    clock.committed(state('t1', { historyStatus: 'loading' }))
    paint(1_200)
    expect(reports).toEqual([])
    at(1_900); clock.historyHeld('t1')
    clock.committed(state('t1', { messages: messages(80), activities: activities(2_000) }))
    paint(2_340, 2_300)
    expect(reports).toEqual([{ inputMs: 60, replyMs: 210, historyMs: 960, frameMs: 1_360, paintedMs: 1_400, held: false, remote: false,
      messages: 80, activities: 2_000, threads: 1_065, commits: 0, shareMs: 0, newThreadRecords: 0, newFields: [],
      wholeReads: { broadcastParts: 0, broadcastThreads: 0, broadcastCatalog: 0, answerThreads: 0, answerCatalog: 0 } }])
  })

  it('counts a history the window already held from the press, and a thread its host marks remote as remote', () => {
    const { clock, reports, paint, show } = rig()
    show('t2')
    clock.start('t2', { held: true, threads: 12 }, press('keydown', 990))
    clock.committed(state('t2', { messages: messages(3), remoteHost: true }))
    paint(1_120)
    expect(reports).toMatchObject([{ inputMs: 10, historyMs: 10, replyMs: 130, paintedMs: 130, held: true, remote: true, messages: 3, activities: 0 }])
  })

  it('starts from the handler when there is no press to read, and never from a press stamped after it', () => {
    const { clock, reports, paint, show } = rig()
    show('t1')
    clock.start('t1', { held: true, threads: 1 })
    clock.committed(state('t1', {}))
    paint(1_050)
    clock.start('t1', { held: true, threads: 1 }, press('click', 5_000))
    clock.committed(state('t1', {}))
    paint(1_100)
    expect(reports.map(report => report.inputMs)).toEqual([0, 0])
    expect(reports.map(report => report.paintedMs)).toEqual([50, 50])
  })

  it('drops a switch the person left before it painted, and one that never painted', () => {
    const { clock, reports, paint, at, show } = rig()
    show('t2')
    clock.start('t1', { held: false, threads: 2 })
    at(1_100); clock.historyHeld('t1')
    clock.committed(state('t1', {}))
    // Another press comes before the frame: only the second switch is counted.
    clock.start('t2', { held: true, threads: 2 })
    paint(1_200)
    expect(reports).toEqual([])
    clock.committed(state('t2', {}))
    paint(1_300)
    expect(reports).toHaveLength(1)
    show('t3')
    clock.start('t3', { held: false, threads: 2 })
    at(1_300 + THREAD_SWITCH_GIVE_UP_MS + 1); clock.historyHeld('t3')
    clock.committed(state('t3', {}))
    paint(1_300 + THREAD_SWITCH_GIVE_UP_MS + 2)
    expect(reports).toHaveLength(1)
  })

  it('counts nothing when the thread’s pane is not on screen as it paints, as when the person opened Settings', () => {
    const { clock, reports, paint, show } = rig()
    show(null)
    clock.start('t1', { held: true, threads: 2 })
    clock.committed(state('t1', {}))
    paint(1_100)
    expect(reports).toEqual([])
    expect(clock.timing()).toBe(false)
  })

  it('counts nothing for a history that could not be read', () => {
    const { clock, reports, paint, show } = rig()
    show('t1')
    clock.start('t1', { held: false, threads: 2 })
    clock.historyHeld('t1')
    clock.committed(state('t1', { historyStatus: 'error' }))
    paint(1_100)
    expect(reports).toEqual([])
    expect(clock.timing()).toBe(false)
  })

  it('lets a switch go when the person goes back to the thread shown, even once its frame is asked for', () => {
    const { clock, reports, paint, show } = rig()
    show('t1')
    clock.start('t1', { held: true, threads: 2 })
    clock.cancel()
    clock.committed(state('t1', {}))
    paint(1_100)
    expect(reports).toEqual([])
    // Back to the first thread after the second's frame was asked for: that frame shows the first thread, so nothing counts.
    show('t2')
    clock.start('t2', { held: true, threads: 2 })
    clock.committed(state('t2', {}))
    clock.cancel()
    clock.committed(state('t1', {}))
    paint(1_200)
    expect(reports).toEqual([])
    // A frame asked for the second that ends showing another thread counts nothing either.
    clock.start('t2', { held: true, threads: 2 })
    clock.committed(state('t2', {}))
    clock.committed(state('t1', {}))
    paint(1_300)
    expect(reports).toEqual([])
  })

  it('counts what each commit’s sharing walked while the switch is timed, and nothing when none is', () => {
    const { clock, reports, paint, show } = rig()
    show('t1')
    const before = state('t1', {}), kept = before.host.threads[0]!
    const after = { ...before, deliveries: [], host: { ...before.host, projects: [], threads: [kept, { ...before.host.threads[1]! }] } } as unknown as AgentState
    expect(clock.timing()).toBe(false)
    clock.shared(500, before, after)
    clock.start('t1', { held: true, threads: 2 })
    expect(clock.timing()).toBe(true)
    clock.shared(120.4, before, after)
    clock.shared(80.2, after, after)
    clock.committed(after)
    paint(1_100)
    expect(reports).toMatchObject([{ commits: 2, shareMs: 201, newThreadRecords: 1, newFields: ['deliveries', 'host.projects'] }])
    expect(clock.timing()).toBe(false)
  })

  it('counts the whole reads the page needed during the switch, by why, and none outside one', () => {
    const { clock, reports, paint, show } = rig()
    show('t1')
    clock.wholeRead('broadcastThreads')
    clock.start('t1', { held: true, threads: 2 })
    clock.wholeRead('answerThreads'); clock.wholeRead('answerThreads'); clock.wholeRead('broadcastCatalog')
    clock.committed(state('t1', {}))
    paint(1_100)
    expect(reports[0]!.wholeReads).toEqual({ broadcastParts: 0, broadcastThreads: 0, broadcastCatalog: 1, answerThreads: 2, answerCatalog: 0 })
  })

  it('ignores answers and histories for any other thread', () => {
    const { clock, reports, paint, show } = rig()
    show('other')
    clock.start('t1', { held: false, threads: 2 })
    clock.replyDrawn('other'); clock.historyHeld('other')
    clock.committed(state('other', {}))
    paint(1_100)
    expect(reports).toEqual([])
  })
})
