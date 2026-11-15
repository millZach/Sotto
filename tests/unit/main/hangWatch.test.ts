// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OUTSIDE_SOTTO } from '../../../src/main/performance/activityRecorder'
import { cleanHangFrames, HANG_FILE, MAIN_HANG_RECORDINGS_KEPT, saveHangRecording, sweepPartialHangRecordings, updateHangRecording, WINDOW_HANG_RECORDINGS_KEPT, type HangRecord } from '../../../src/main/performance/hangRecording'
import { MainHeartbeat, WindowHangWatch, type WatchedWindow } from '../../../src/main/performance/hangWatchdog'
import { HEARTBEAT_SLOT, QUIT_SLOT, SHARED_SLOTS } from '../../../src/main/performance/hangWatchdogShared'
import { HANG_STACKS, MainHangWatch, type MainDebugger, type MainHangWatchOptions } from '../../../src/main/performance/mainHangWatch'

const APP = process.platform === 'win32' ? 'C:\\Program Files\\Sotto\\resources\\app.asar' : '/opt/Sotto/resources/app.asar'
const appFile = (inside: string): string => `file:///${(process.platform === 'win32' ? APP.replace(/\\/gu, '/') : APP.slice(1))}/${inside}`

describe('a hang recording\'s frames (#1581)', () => {
  it('keeps Sotto\'s own places and Node\'s, and renames every other frame, reading nothing else of it', () => {
    const frames = cleanHangFrames([
      { functionName: 'saveThreads', url: appFile('out/main/index.js'), location: { lineNumber: 12, columnNumber: 3 }, this: { value: 'secret' }, scopeChain: [{ object: { value: 'secret' } }] },
      { functionName: 'listOnTimeout', url: 'node:internal/timers', location: { lineNumber: 684, columnNumber: 16 } },
      { functionName: 'words a thread said', url: '', location: { lineNumber: 1, columnNumber: 1 } },
      { functionName: 'page', url: 'https://example.com/a.js', location: { lineNumber: 1, columnNumber: 1 } },
    ], [APP])
    expect(frames).toEqual([
      { functionName: 'saveThreads', url: 'sotto:///out/main/index.js', lineNumber: 12, columnNumber: 3 },
      { functionName: 'listOnTimeout', url: 'node:internal/timers', lineNumber: 684, columnNumber: 16 },
      { functionName: OUTSIDE_SOTTO, url: OUTSIDE_SOTTO, lineNumber: -1, columnNumber: -1 },
      { functionName: OUTSIDE_SOTTO, url: OUTSIDE_SOTTO, lineNumber: -1, columnNumber: -1 },
    ])
    expect(JSON.stringify(frames)).not.toContain('secret')
  })
})

describe('saving hang recordings', () => {
  let folder = ''
  afterEach(async () => { if (folder) await rm(folder, { recursive: true, force: true }) })
  const record = (startedAt: string, kind: HangRecord['kind'] = 'main'): HangRecord => ({ format: 1, kind, sottoVersion: '0.1.41', platform: 'win32', startedAt, answeredAfterMs: null, writtenAfterMs: 6_000, stacks: [] })

  it('writes a folder named for when main last answered, updates it in place, and keeps main\'s newest ten and the window\'s newest five apart from each other and from Record a minute\'s', async () => {
    folder = await mkdtemp(join(tmpdir(), 'sotto-hangs-'))
    const minute = join(folder, 'sotto-activity-2026-10-01-09-00-00')
    await import('node:fs/promises').then(fs => fs.mkdir(minute))
    // The window's are older than every one of main's, and still none of main's pushes one out.
    const windows: string[] = [], mains: string[] = []
    for (let minuteOfHour = 0; minuteOfHour < WINDOW_HANG_RECORDINGS_KEPT + 1; minuteOfHour += 1) {
      windows.push(await saveHangRecording(folder, record(new Date(2026, 9, 25, 13, minuteOfHour, 7).toISOString(), 'window')))
    }
    for (let minuteOfHour = 0; minuteOfHour < MAIN_HANG_RECORDINGS_KEPT + 2; minuteOfHour += 1) {
      mains.push(await saveHangRecording(folder, record(new Date(2026, 9, 25, 14, minuteOfHour, 7).toISOString())))
    }
    expect(mains[0]).toBe('sotto-hang-2026-10-25-14-00-07')
    await updateHangRecording(folder, mains.at(-1)!, { ...record(new Date(2026, 9, 25, 14, 11, 7).toISOString()), answeredAfterMs: 9_000 })
    const kept = (await readdir(folder)).sort()
    expect(kept).toEqual(['sotto-activity-2026-10-01-09-00-00', ...windows.slice(1), ...mains.slice(2)].sort())
    const saved = JSON.parse(await readFile(join(folder, mains.at(-1)!, HANG_FILE), 'utf8')) as HangRecord
    expect(saved.answeredAfterMs).toBe(9_000)
    expect(await readdir(join(folder, mains.at(-1)!))).toEqual([HANG_FILE])
  })

  it('leaves another save\'s half-written folder alone, and sweeps leftovers only when asked at start', async () => {
    folder = await mkdtemp(join(tmpdir(), 'sotto-hangs-'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(folder, 'sotto-hang-2026-10-25-14-00-00.partial'))
    await saveHangRecording(folder, record(new Date(2026, 9, 25, 14, 1, 0).toISOString()))
    expect(await readdir(folder)).toContain('sotto-hang-2026-10-25-14-00-00.partial')
    await sweepPartialHangRecordings(folder)
    expect(await readdir(folder)).toEqual(['sotto-hang-2026-10-25-14-01-00'])
  })
})

/** A main whose heartbeat the test moves by hand, with a debugger that pauses it on request. */
function harness(overrides: Partial<MainHangWatchOptions> = {}) {
  const state = { now: 100_000, answered: 100_000, quitAt: 0, pauses: 0, killed: 0, saved: [] as HangRecord[], updated: [] as HangRecord[], logged: [] as string[], closed: 0,
    /** What main does while paused: nothing (still stopped), or answer (the pause landed after it had recovered). */
    duringPause: 'stopped' as 'stopped' | 'answers', enable: 'answers' as 'answers' | 'never',
    /** Set by `stop`: when main answers again, and goes on answering from then on. */
    answersAt: null as number | null,
    /** The computer sleeps this long during the watch's next sleep between stacks. */
    sleepsFor: 0,
    /** Main is inside a native call until then: `Debugger.enable` does not land, or `Debugger.pause` does not. */
    enableFrom: 0, pauseFrom: 0, enables: 0 }
  /** The clock moves on, through the watch's own looks and its sleeps between stacks alike. */
  const advance = (ms: number): void => {
    state.now += ms
    if (state.answersAt !== null && state.now >= state.answersAt) state.answered = state.answered < state.answersAt ? state.answersAt : state.now
  }
  let pending: ((frames: unknown[] | null) => void) | null = null
  const debug: MainDebugger = {
    post: async method => {
      if (method === 'Debugger.enable') {
        state.enables += 1
        if (state.enable === 'never' || state.now < state.enableFrom) return new Promise(() => undefined)
      }
      if (method === 'Debugger.pause') {
        state.pauses += 1
        if (state.now < state.pauseFrom) return {}
        if (state.duringPause === 'answers') state.answered = state.now
        pending?.([{ functionName: 'saveThreads', url: appFile('out/main/index.js'), location: { lineNumber: 1, columnNumber: 2 } }])
      }
      return {}
    },
    nextPause: async withinMs => new Promise(resolve => { pending = resolve; setTimeout(() => resolve(null), withinMs) }),
    close: () => { state.closed += 1 },
  }
  const watch = new MainHangWatch({
    lastAnswered: () => state.answered, quitReceivedAt: () => state.quitAt, now: () => state.now, wallNow: () => state.now, connect: () => debug,
    save: async record => { state.saved.push(record); return 'sotto-hang-x' }, update: async (_name, record) => { state.updated.push(record) },
    kill: () => { state.killed += 1 }, sleep: async ms => { advance(ms + state.sleepsFor); state.sleepsFor = 0 }, log: event => { state.logged.push(event) },
    appRoots: [APP], sottoVersion: '0.1.41', platform: 'win32', debuggerWaitMs: 5, ...overrides,
  })
  /** `ms` of the computer running, the watch looking every 250 ms as its worker does; `step` is what main does meanwhile. */
  const run = async (ms: number, step: () => void = () => undefined): Promise<void> => {
    const until = state.now + ms
    while (state.now < until) { advance(Math.min(until, state.now + 250) - state.now); step(); await watch.tick() }
  }
  /** Main stops now, and answers again `ms` later; for good when `ms` is omitted. */
  const stop = (ms?: number): void => { state.answered = state.now; state.answersAt = ms === undefined ? null : state.now + ms }
  return { state, watch, run, stop }
}

describe('the watch on main', () => {
  it('saves a 1.2 s stop with main\'s stack, taken at 1 s while main was still stopped, then how long it lasted', async () => {
    const { state, watch, run, stop } = harness()
    await watch.tick()
    stop(1_200)
    await run(750)
    expect(state.saved).toEqual([])
    await run(250)
    expect(state.pauses).toBe(1)
    expect(state.saved).toHaveLength(1)
    expect(state.saved[0]).toMatchObject({ kind: 'main', answeredAfterMs: null, writtenAfterMs: 1_000, startedAt: new Date(100_000).toISOString() })
    expect(state.saved[0]!.stacks!.map(stack => stack.atMs)).toEqual([1_000])
    expect(state.saved[0]!.stacks![0]!.frames[0]).toEqual({ functionName: 'saveThreads', url: 'sotto:///out/main/index.js', lineNumber: 1, columnNumber: 2 })
    expect(state.closed).toBe(1)
    expect(state.logged).toEqual(['hang-recording-saved'])
    await run(250)
    expect(state.updated.map(record => record.answeredAfterMs)).toEqual([1_200])
    expect(state.updated[0]!.stacks).toHaveLength(1)
    await run(5_000)
    expect(state.updated).toHaveLength(1)
    expect(state.saved).toHaveLength(1)
  })

  it('saves nothing for a 0.8 s stop', async () => {
    const { state, watch, run, stop } = harness()
    await watch.tick()
    stop(800)
    await run(5_000)
    expect(state.pauses).toBe(0)
    expect(state.saved).toEqual([])
  })

  it('records a stop that runs past 5 s in full: a stack a second from 1 s to 9 s, rewritten while main stays stopped', async () => {
    const { state, watch, run, stop } = harness()
    await watch.tick()
    stop(12_000)
    await run(14_000)
    expect(state.pauses).toBe(HANG_STACKS)
    expect(state.saved).toHaveLength(1)
    expect(state.saved[0]!.stacks!.map(stack => stack.atMs)).toEqual([1_000])
    expect(state.updated).toHaveLength(2)
    // The stacks a hang recording held when it was taken at 5 s are all still there.
    expect(state.updated[0]).toMatchObject({ answeredAfterMs: null, writtenAfterMs: 9_000 })
    expect(state.updated[0]!.stacks!.map(stack => stack.atMs)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000])
    expect(state.updated[1]).toMatchObject({ answeredAfterMs: 12_000 })
    expect(state.updated[1]!.stacks).toHaveLength(HANG_STACKS)
    expect(state.closed).toBe(1)
  })

  it('keeps two freezes 24 s apart, and records no more than one in 20 s', async () => {
    const { state, watch, run, stop } = harness()
    await watch.tick()
    stop(1_500)
    await run(24_000)
    stop(1_500)
    await run(6_000)
    expect(state.saved.map(record => record.startedAt)).toEqual([new Date(100_000).toISOString(), new Date(124_000).toISOString()])
    // 6 s after the second: inside the gap.
    stop(1_500)
    await run(14_000)
    expect(state.saved).toHaveLength(2)
    // Its 1 s comes 20 s after the second was taken.
    stop(1_500)
    await run(3_000)
    expect(state.saved).toHaveLength(3)
  })

  it('still records a hang of main that begins inside the gap, at 5 s as before, and only once in ten minutes', async () => {
    const { state, watch, run, stop } = harness()
    await watch.tick()
    stop(1_500)
    await run(3_000)
    expect(state.saved).toHaveLength(1)
    stop(8_000)
    await run(10_000)
    expect(state.saved).toHaveLength(2)
    expect(state.saved[1]!.stacks!.map(stack => stack.atMs)).toEqual([5_000])
    expect(state.updated.at(-1)).toMatchObject({ answeredAfterMs: 8_000 })
    // Another hang 2 s later: inside both gaps.
    stop(8_000)
    await run(10_000)
    expect(state.saved).toHaveLength(2)
  })

  it('keeps no stack from a pause that landed after main had answered', async () => {
    const { state, watch, run } = harness()
    state.duringPause = 'answers'
    await watch.tick()
    await run(3_000)
    expect(state.pauses).toBe(1)
    expect(state.saved[0]!.stacks).toEqual([])
  })

  it('keeps trying in the same recording when a stop begins outside JavaScript, and takes stacks once main is back in it', async () => {
    const { state, watch, run, stop } = harness()
    await watch.tick()
    // A 20 s stop whose first 4 s are one native call: the debugger cannot even be enabled.
    stop(20_000)
    state.enableFrom = state.now + 4_000
    await run(22_000)
    expect(state.saved).toHaveLength(1)
    expect(state.saved[0]!.stacks).toEqual([])
    const last = state.updated.at(-1)!
    expect(last.answeredAfterMs).toBe(20_000)
    const times = last.stacks!.map(stack => stack.atMs)
    expect(times.length).toBeGreaterThanOrEqual(5)
    expect(times.every(atMs => atMs >= 4_000)).toBe(true)
    // Every session the tries opened was let go.
    expect(state.closed).toBe(state.enables)
  })

  it('keeps trying in the same recording when the debugger is enabled but its first pauses do not land', async () => {
    const { state, watch, run, stop } = harness()
    await watch.tick()
    stop(20_000)
    state.pauseFrom = state.now + 4_000
    await run(22_000)
    const last = state.updated.at(-1)!
    expect(last.answeredAfterMs).toBe(20_000)
    const times = last.stacks!.map(stack => stack.atMs)
    expect(times.length).toBeGreaterThanOrEqual(5)
    expect(times.every(atMs => atMs >= 4_000)).toBe(true)
    // A session whose pause did not land is let go at once, so that pause cannot land later and leave main paused.
    expect(state.enables).toBeGreaterThan(1)
    expect(state.closed).toBe(state.enables)
  })

  it('saves the hang with no stack when main is stopped outside JavaScript', async () => {
    const { state, watch, run } = harness()
    state.enable = 'never'
    await watch.tick()
    await run(6_000)
    expect(state.pauses).toBe(0)
    expect(state.saved[0]!.stacks).toEqual([])
  })

  it('records a hang during quit like any other, then ends Sotto once main has been stopped 20 s into the quit', async () => {
    const { state, watch, run } = harness({ quitForceMs: 20_000 })
    await watch.tick()
    state.quitAt = state.now
    await run(6_000)
    expect(state.saved).toHaveLength(1)
    expect(state.killed).toBe(0)
    await run(20_000)
    expect(state.killed).toBe(1)
    expect(state.logged).toEqual(['hang-recording-saved', 'quit-forced'])
  })

  it('never ends Sotto for a quit that was cancelled, even when main stops later (quit-slot-never-cleared)', async () => {
    const { state, watch, run } = harness({ quitForceMs: 20_000 })
    await watch.tick()
    state.quitAt = state.now
    // Quit was refused, as a refused update restart is: main goes on answering past the whole deadline.
    await run(25_000, () => { state.answered = state.now })
    await run(6_000)
    expect(state.killed).toBe(0)
    expect(state.saved).toHaveLength(1)
  })

  it('takes a gap with no looks at all, as a computer asleep, for no hang and no stopped quit (wallclock-false-hang)', async () => {
    const { state, watch, run } = harness({ quitForceMs: 20_000 })
    await watch.tick()
    state.quitAt = state.now
    await run(1_000, () => { state.answered = state.now })
    // Asleep for a minute: neither main nor the watch ran, so main's heartbeat is a minute old when the watch wakes.
    state.now += 60_000
    await watch.tick()
    expect(state.killed).toBe(0)
    expect(state.saved).toEqual([])
    // Awake again and draining: main answers, so the quit is still the quit drain's.
    await run(2_000, () => { state.answered = state.now })
    expect(state.killed).toBe(0)
  })

  it('leaves a quit to the quit drain while main still answers, even past the deadline', async () => {
    const { state, watch, run } = harness({ quitForceMs: 20_000 })
    await watch.tick()
    state.quitAt = state.now
    // Late, but answering: under the second a recording needs.
    await run(60_000, () => { state.answered = state.now - 750 })
    expect(state.killed).toBe(0)
    expect(state.saved).toEqual([])
  })

  it('takes a stall of the whole process too short to be sleep for no freeze, though the 2 s asleep gap lets it through', async () => {
    const { state, watch, run } = harness()
    await watch.tick()
    await run(1_000, () => { state.answered = state.now })
    // Main and the watch stop alike for 1.5 s, and main beats again just after the watch's next look: its heartbeat is
    // 1.5 s old at that look, over the second, and the gap is under ASLEEP_GAP_MS.
    state.now += 1_500
    await watch.tick()
    await run(250, () => { state.answered = state.now })
    expect(state.saved).toEqual([])
    // The longest stall that does not restart the count, 500 ms, leaves the heartbeat at most 750 ms old a look later.
    state.now += 500
    await watch.tick()
    state.now += 250
    await watch.tick()
    await run(250, () => { state.answered = state.now })
    expect(state.saved).toEqual([])
    expect(state.pauses).toBe(0)
  })

  it('keeps Quit\'s backstop as it was: a main stopped 4.75 s at the deadline cancels the quit, as before the threshold moved', async () => {
    const { state, watch, run, stop } = harness({ quitForceMs: 20_000 })
    await watch.tick()
    state.quitAt = state.now
    await run(15_250, () => { state.answered = state.now })
    stop()
    await run(30_000)
    // Recorded at 1 s; its stacks stop at the deadline and the backstop decides there, on a stop of 4.75 s, not a look
    // later on one of 5 s.
    expect(state.saved).toHaveLength(1)
    expect(state.updated.at(-1)!.stacks!.map(stack => stack.atMs)).toEqual([1_000, 2_000, 3_000, 4_000])
    expect(state.killed).toBe(0)
  })

  it('takes a computer asleep between two stacks for no freeze and no stopped quit, as between two looks', async () => {
    const { state, watch, run, stop } = harness({ quitForceMs: 20_000 })
    await watch.tick()
    state.quitAt = state.now
    await run(1_000, () => { state.answered = state.now })
    stop()
    // Asleep for a minute during the first wait after the first stack.
    state.sleepsFor = 60_000
    await run(1_000)
    expect(state.saved).toHaveLength(1)
    expect(state.pauses).toBe(1)
    // Awake, main still stopped for 3 s more: no hang, and no quit deadline reached.
    await run(3_000)
    expect(state.killed).toBe(0)
    await run(2_000, () => { state.answered = state.now })
    expect(state.killed).toBe(0)
    expect(state.saved).toHaveLength(1)
    // Stopped from 101 s, answered at 165.5 s, a minute of it asleep: 4.5 s awake.
    expect(state.updated.at(-1)!.answeredAfterMs).toBe(4_500)
  })

  it('keeps Quit\'s backstop as it was: a main stopped 5 s or more is ended at the deadline, and not before', async () => {
    const { state, watch, run, stop } = harness({ quitForceMs: 20_000 })
    await watch.tick()
    state.quitAt = state.now
    await run(10_000, () => { state.answered = state.now })
    stop()
    await run(9_750)
    expect(state.saved).toHaveLength(1)
    expect(state.killed).toBe(0)
    await run(250)
    expect(state.killed).toBe(1)
    expect(state.logged).toEqual(['hang-recording-saved', 'quit-forced'])
  })
})

describe('the watch on the window', () => {
  function windowHarness() {
    const clock = { now: 0 }
    const saved: HangRecord[] = [], updated: HangRecord[] = []
    const asks: ((value: unknown) => void)[] = []
    let shown = true, destroyed = false, loading = false
    const makeWindow = (): WatchedWindow => ({ executeJavaScript: () => new Promise(resolve => { asks.push(resolve) }), isDestroyed: () => destroyed, isLoading: () => loading })
    let window = makeWindow()
    const watch = new WindowHangWatch({
      target: () => shown ? window : null, now: () => clock.now, wallNow: () => clock.now, setInterval: () => ({}), clearInterval: () => undefined,
      processes: () => [{ type: 'Browser', cpuPercent: 3, workingSetKb: 1, privateKb: 1 }, { type: 'Tab', cpuPercent: 99.5, workingSetKb: 2, privateKb: 2 }],
      mainLoop: () => ({ blockedShare: 0, longestFreezeMs: 0, freezesOver100ms: 0, bars: [] }),
      save: async record => { saved.push(record); return 'sotto-hang-w' }, update: async (_name, record) => { updated.push(record) },
      log: () => undefined, sottoVersion: '0.1.41', platform: 'win32', hangMs: 8_000,
    })
    return { clock, saved, updated, asks, watch, hide: () => { shown = false }, destroy: () => { destroyed = true },
      load: (on: boolean) => { loading = on }, replace: () => { destroyed = false; window = makeWindow() } }
  }

  it('asks a shown window, and saves a window that has not answered for eight seconds with each process\'s numbers', async () => {
    const { clock, saved, updated, asks, watch } = windowHarness()
    watch.tick()
    asks.shift()!(0)
    await Promise.resolve()
    for (const at of [2_000, 4_000, 6_000, 8_000]) { clock.now = at; watch.tick() }
    expect(saved).toEqual([])
    clock.now = 10_000; watch.tick()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ kind: 'window', startedAt: new Date(2_000).toISOString(), answeredAfterMs: null, writtenAfterMs: 8_000 })
    expect(saved[0]!.processes!.map(item => item.type)).toEqual(['Browser', 'Tab'])
    clock.now = 15_000
    asks.shift()!(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updated.map(record => record.answeredAfterMs)).toEqual([13_000])
  })

  it('does not ask a hidden window, and lets go of one that was destroyed while it was asked', () => {
    const { clock, saved, asks, watch, hide, destroy } = windowHarness()
    watch.tick()
    destroy()
    clock.now = 20_000; watch.tick()
    expect(saved).toEqual([])
    hide()
    watch.tick()
    expect(asks).toHaveLength(1)
  })

  it('lets go of a recording whose window was destroyed, so the next window\'s answer does not end it', async () => {
    const { clock, saved, updated, asks, watch, destroy, replace } = windowHarness()
    for (const at of [0, 2_000, 4_000, 6_000, 8_000]) { clock.now = at; watch.tick() }
    expect(saved).toHaveLength(1)
    destroy(); watch.tick()
    replace()
    clock.now = 10_000; watch.tick()
    asks.at(-1)!(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updated).toEqual([])
  })

  it('drops a question that was pending while the computer slept, saving nothing (wallclock-false-hang)', () => {
    const { clock, saved, asks, watch } = windowHarness()
    watch.tick()
    expect(asks).toHaveLength(1)
    clock.now = 60_000; watch.tick()
    expect(saved).toEqual([])
    clock.now = 62_000; watch.tick()
    expect(saved).toEqual([])
    expect(asks).toHaveLength(2)
  })

  it('does not ask a window that is loading a page, and drops a question when it starts loading', () => {
    const { clock, saved, asks, watch, load } = windowHarness()
    load(true)
    watch.tick()
    expect(asks).toHaveLength(0)
    load(false)
    watch.tick()
    load(true)
    clock.now = 20_000; watch.tick()
    expect(saved).toEqual([])
  })
})

describe('main\'s heartbeat and the Quit stamp (quit-slot-never-cleared)', () => {
  function heartbeat() {
    const clock = { now: 5_000 }
    const shared = new BigInt64Array(SHARED_SLOTS)
    return { clock, shared, beat: new MainHeartbeat(shared, () => clock.now, 20_000) }
  }

  it('writes the heartbeat on the monotonic clock it is given, and stamps Quit once', () => {
    const { clock, shared, beat } = heartbeat()
    beat.beat()
    expect(shared[HEARTBEAT_SLOT]).toBe(5_000n)
    beat.quitReceived()
    clock.now += 250
    beat.quitReceived()
    expect(shared[QUIT_SLOT]).toBe(5_000n)
  })

  it('takes the stamp back once main has run on for twice the deadline, so a quit that did not happen ends nothing', () => {
    const { clock, shared, beat } = heartbeat()
    beat.beat()
    beat.quitReceived()
    for (let ran = 0; ran < 39_750; ran += 250) { clock.now += 250; beat.beat() }
    expect(shared[QUIT_SLOT]).not.toBe(0n)
    clock.now += 250; beat.beat()
    expect(shared[QUIT_SLOT]).toBe(0n)
  })

  it('does not count time asleep towards that, and takes the stamp back at once when a quit is called off', () => {
    const { clock, shared, beat } = heartbeat()
    beat.beat()
    beat.quitReceived()
    clock.now += 120_000; beat.beat()
    expect(shared[QUIT_SLOT]).not.toBe(0n)
    beat.quitCancelled()
    expect(shared[QUIT_SLOT]).toBe(0n)
  })
})
