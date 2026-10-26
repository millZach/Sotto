// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OUTSIDE_SOTTO } from '../../../src/main/performance/activityRecorder'
import { cleanHangFrames, HANG_FILE, HANG_RECORDINGS_KEPT, saveHangRecording, sweepPartialHangRecordings, updateHangRecording, type HangRecord } from '../../../src/main/performance/hangRecording'
import { WindowHangWatch, type WatchedWindow } from '../../../src/main/performance/hangWatchdog'
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
  const record = (startedAt: string): HangRecord => ({ format: 1, kind: 'main', sottoVersion: '0.1.41', platform: 'win32', startedAt, answeredAfterMs: null, writtenAfterMs: 6_000, stacks: [] })

  it('writes a folder named for when main last answered, updates it in place, and keeps the newest five apart from Record a minute\'s', async () => {
    folder = await mkdtemp(join(tmpdir(), 'sotto-hangs-'))
    const minute = join(folder, 'sotto-activity-2026-10-01-09-00-00')
    await import('node:fs/promises').then(fs => fs.mkdir(minute))
    const names: string[] = []
    for (let minuteOfHour = 0; minuteOfHour < HANG_RECORDINGS_KEPT + 2; minuteOfHour += 1) {
      names.push(await saveHangRecording(folder, record(new Date(2026, 9, 25, 14, minuteOfHour, 7).toISOString())))
    }
    expect(names[0]).toBe('sotto-hang-2026-10-25-14-00-07')
    await updateHangRecording(folder, names.at(-1)!, { ...record(new Date(2026, 9, 25, 14, 6, 7).toISOString()), answeredAfterMs: 9_000 })
    const kept = (await readdir(folder)).sort()
    expect(kept).toEqual(['sotto-activity-2026-10-01-09-00-00', ...names.slice(2)])
    const saved = JSON.parse(await readFile(join(folder, names.at(-1)!, HANG_FILE), 'utf8')) as HangRecord
    expect(saved.answeredAfterMs).toBe(9_000)
    expect(await readdir(join(folder, names.at(-1)!))).toEqual([HANG_FILE])
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
    duringPause: 'stopped' as 'stopped' | 'answers', enable: 'answers' as 'answers' | 'never' }
  let pending: ((frames: unknown[] | null) => void) | null = null
  const debug: MainDebugger = {
    post: async method => {
      if (method === 'Debugger.enable' && state.enable === 'never') return new Promise(() => undefined)
      if (method === 'Debugger.pause') {
        state.pauses += 1
        if (state.duringPause === 'answers') state.answered = state.now
        pending?.([{ functionName: 'saveThreads', url: appFile('out/main/index.js'), location: { lineNumber: 1, columnNumber: 2 } }])
      }
      return {}
    },
    nextPause: async () => new Promise(resolve => { pending = resolve }),
    close: () => { state.closed += 1 },
  }
  const watch = new MainHangWatch({
    lastAnswered: () => state.answered, quitReceivedAt: () => state.quitAt, now: () => state.now, connect: () => debug,
    save: async record => { state.saved.push(record); return 'sotto-hang-x' }, update: async (_name, record) => { state.updated.push(record) },
    kill: () => { state.killed += 1 }, sleep: async ms => { state.now += ms }, log: event => { state.logged.push(event) },
    appRoots: [APP], sottoVersion: '0.1.41', platform: 'win32', debuggerWaitMs: 5, ...overrides,
  })
  return { state, watch }
}

describe('the watch on main', () => {
  it('waits out a short stop, then takes main\'s stack while it stays stopped and writes how long it lasted', async () => {
    const { state, watch } = harness()
    state.now += 4_000
    await watch.tick()
    expect(state.saved).toEqual([])
    state.now += 1_500
    await watch.tick()
    expect(state.pauses).toBe(HANG_STACKS)
    expect(state.saved).toHaveLength(1)
    expect(state.saved[0]).toMatchObject({ kind: 'main', answeredAfterMs: null, startedAt: new Date(100_000).toISOString() })
    expect(state.saved[0]!.stacks![0]!.frames[0]).toEqual({ functionName: 'saveThreads', url: 'sotto:///out/main/index.js', lineNumber: 1, columnNumber: 2 })
    expect(state.closed).toBe(1)
    expect(state.logged).toEqual(['hang-recording-saved'])
    state.answered = state.now = 112_000
    await watch.tick()
    expect(state.updated.map(record => record.answeredAfterMs)).toEqual([12_000])
    await watch.tick()
    expect(state.updated).toHaveLength(1)
  })

  it('keeps no stack from a pause that landed after main had answered', async () => {
    const { state, watch } = harness()
    state.duringPause = 'answers'
    state.now += 6_000
    await watch.tick()
    expect(state.pauses).toBe(1)
    expect(state.saved[0]!.stacks).toEqual([])
  })

  it('saves the hang with no stack when main is stopped outside JavaScript', async () => {
    const { state, watch } = harness()
    state.enable = 'never'
    state.now += 6_000
    await watch.tick()
    expect(state.pauses).toBe(0)
    expect(state.saved[0]!.stacks).toEqual([])
  })

  it('records one hang in ten minutes at most', async () => {
    const { state, watch } = harness()
    state.now += 6_000
    await watch.tick()
    state.answered = state.now; await watch.tick()
    state.now += 6_000
    await watch.tick()
    expect(state.saved).toHaveLength(1)
  })

  it('records a hang during quit like any other, then ends Sotto once Quit is 20 s old and main is still stopped', async () => {
    const { state, watch } = harness({ quitForceMs: 20_000 })
    state.quitAt = state.now
    state.now += 6_000
    await watch.tick()
    expect(state.saved).toHaveLength(1)
    expect(state.killed).toBe(0)
    state.now = state.quitAt + 19_000
    await watch.tick()
    expect(state.killed).toBe(0)
    state.now += 1_000
    await watch.tick()
    expect(state.killed).toBe(1)
    expect(state.logged).toEqual(['hang-recording-saved', 'quit-forced'])
  })

  it('leaves a quit to the quit drain while main still answers, even past the deadline', async () => {
    const { state, watch } = harness({ quitForceMs: 20_000 })
    state.quitAt = state.now
    state.now += 60_000
    state.answered = state.now - 1_000
    await watch.tick()
    expect(state.killed).toBe(0)
    expect(state.saved).toEqual([])
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
      target: () => shown ? window : null, now: () => clock.now, setInterval: () => ({}), clearInterval: () => undefined,
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
    clock.now = 2_000; watch.tick()
    clock.now = 9_000; watch.tick()
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
    watch.tick()
    clock.now = 8_000; watch.tick()
    expect(saved).toHaveLength(1)
    destroy(); watch.tick()
    replace()
    clock.now = 9_000; watch.tick()
    asks.at(-1)!(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updated).toEqual([])
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
