import { describe, expect, it } from 'vitest'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import type { ThreadSwitchTiming } from '../../../src/shared/mainActivity'
import { THREAD_SWITCH_GIVE_UP_MS, ThreadSwitchClock } from '../../../src/renderer/src/agents/threadSwitchClock'

/** A clock the test moves, and the frame and the task after it run when the test says. */
function rig() {
  let now = 1_000
  const frames: (() => void)[] = [], tasks: (() => void)[] = [], reports: ThreadSwitchTiming[] = []
  const clock = new ThreadSwitchClock({ now: () => now, frame: callback => frames.push(callback), later: callback => tasks.push(callback), report: timing => reports.push(timing) })
  const paint = (at: number): void => { now = at; for (const frame of frames.splice(0)) frame(); for (const task of tasks.splice(0)) task() }
  return { clock, reports, paint, at: (value: number) => { now = value } }
}

function state(activeThreadId: string, thread: Partial<AgentThread>, hostId = LAPTOP): AgentState {
  const threads = [{ id: 'other', messages: [] }, { id: activeThreadId, messages: [], ...thread }] as unknown as AgentThread[]
  return { activeThreadId, host: { hostId, threads } } as unknown as AgentState
}

const messages = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `m${index}` })) as unknown as AgentThread['messages']
const activities = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `a${index}` })) as unknown as AgentThread['activities']
const press = (type: string, timeStamp: number) => ({ type, timeStamp }) as Event
const FORGE_THREAD = 'host:62c79358-687d-4274-a876-1a0d79e1c195:t2'
const LAPTOP = '2e67ec62-e3ec-46ac-b5b1-c7dafc3113dd'

describe('the window’s clock on a thread switch', () => {
  it('times a switch from the press to the frame painted with the thread’s history', () => {
    const { clock, reports, paint, at } = rig()
    clock.start('t1', { held: false, threads: 1_065 }, press('click', 940))
    at(1_150); clock.replyDrawn('t1')
    // The selection is drawn while the history is on its way: nothing ends yet.
    clock.committed(state('t1', { historyStatus: 'loading' }))
    paint(1_200)
    expect(reports).toEqual([])
    at(1_900); clock.historyHeld('t1')
    clock.committed(state('t1', { messages: messages(80), activities: activities(2_000) }))
    paint(2_340)
    expect(reports).toEqual([{ inputMs: 60, replyMs: 210, historyMs: 960, paintedMs: 1_400, held: false, remote: false, messages: 80, activities: 2_000, threads: 1_065 }])
  })

  it('counts a history the window already held from the press, and a thread on another computer as remote', () => {
    const { clock, reports, paint } = rig()
    clock.start(FORGE_THREAD, { held: true, threads: 12 }, press('keydown', 990))
    clock.committed(state(FORGE_THREAD, { messages: messages(3) }))
    paint(1_120)
    expect(reports).toMatchObject([{ inputMs: 10, historyMs: 10, replyMs: 130, paintedMs: 130, held: true, remote: true, messages: 3, activities: 0 }])
    // This computer's own thread under its own host's key is not remote.
    const own = `host:${LAPTOP}:t3`
    clock.start(own, { held: true, threads: 12 })
    clock.committed(state(own, {}))
    paint(1_200)
    expect(reports.at(-1)?.remote).toBe(false)
  })

  it('starts from the handler when there is no press to read, and never from a press stamped after it', () => {
    const { clock, reports, paint } = rig()
    clock.start('t1', { held: true, threads: 1 })
    clock.committed(state('t1', {}))
    paint(1_050)
    clock.start('t1', { held: true, threads: 1 }, press('click', 5_000))
    clock.committed(state('t1', {}))
    paint(1_100)
    expect(reports.map(report => report.inputMs)).toEqual([0, 0])
    expect(reports.map(report => report.paintedMs)).toEqual([50, 50])
  })

  it('drops a switch the user left before it painted, and one that never painted', () => {
    const { clock, reports, paint, at } = rig()
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
    clock.start('t3', { held: false, threads: 2 })
    at(1_300 + THREAD_SWITCH_GIVE_UP_MS + 1); clock.historyHeld('t3')
    clock.committed(state('t3', {}))
    paint(1_300 + THREAD_SWITCH_GIVE_UP_MS + 2)
    expect(reports).toHaveLength(1)
  })

  it('ignores answers and histories for any other thread', () => {
    const { clock, reports, paint } = rig()
    clock.start('t1', { held: false, threads: 2 })
    clock.replyDrawn('other'); clock.historyHeld('other')
    clock.committed(state('other', {}))
    paint(1_100)
    expect(reports).toEqual([])
  })
})
