// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { recordingFileSystem, sweepPartialActivityRecordings, type ProfilerTarget, type RawCpuProfile, type RecordingFileSystem } from '../../../src/main/performance/activityRecorder'
import { discardLeaving, MainActivityService, saveFailedLeaving, type MainActivityLogEvent } from '../../../src/main/performance/mainActivityService'
import { SAMPLE_INTERVAL_MS } from '../../../src/main/performance/mainLoopMonitor'
import type { MainActivityState } from '../../../src/shared/mainActivity'

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })

const profile: RawCpuProfile = { nodes: [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 1, children: [] }], startTime: 0, endTime: 10, samples: [1], timeDeltas: [10] }

function profiler(options: { failStart?: boolean; failStop?: boolean; stopped?: Promise<void>; starting?: Promise<void> } = {}): ProfilerTarget & { started: boolean; cancelled: boolean } {
  const target = {
    started: false, cancelled: false,
    start: vi.fn(async () => { await options.starting; if (options.failStart) throw new Error('attach refused'); target.started = true }),
    stop: vi.fn(async () => { await options.stopped; if (options.failStop) throw new Error('gone'); return profile }),
    cancel: vi.fn(async () => { target.cancelled = true }),
  }
  return target
}

async function harness(options: { main?: ProfilerTarget; mainProfiler?: () => ProfilerTarget; files?: RecordingFileSystem; before?: (directory: string) => Promise<void> } = {}) {
  const directory = join(await mkdtemp(join(tmpdir(), 'sotto-main-activity-')), 'performance-recordings')
  folders.push(join(directory, '..'))
  await options.before?.(directory)
  let at = 0
  const clock = { now: () => at, setInterval: () => ({ unref: () => undefined }), clearInterval: () => undefined }
  const timers: (() => void)[] = []
  const events: MainActivityLogEvent[] = []
  const revealed: string[] = []
  const service = new MainActivityService({
    directory, clock, wallClock: () => Date.UTC(2026, 9, 20, 14, 32, 5), windowSeconds: 4, durationMs: 60_000,
    mainProfiler: options.mainProfiler ?? (() => options.main ?? profiler()), appRoots: [process.cwd()], sottoVersion: '0.1.38-owl.20261020.1', platform: 'win32',
    revealFile: path => revealed.push(path), log: event => events.push(event),
    setTimeout: callback => { timers.push(callback); return timers.length }, clearTimeout: () => { timers.length = 0 },
    ...(options.files ? { files: options.files } : {}),
  })
  const states: MainActivityState[] = []
  service.subscribe(state => states.push(state))
  service.start()
  const block = (ms: number): void => { at += SAMPLE_INTERVAL_MS + ms; service.loop.sample() }
  const freeze = (): void => { for (let step = 0; step < 3; step += 1) block(1_000) }
  const recover = (): void => { for (let step = 0; step < 120; step += 1) block(0) }
  /** Runs the recording's end, as the timer would, and waits for it to finish. */
  const finish = async (): Promise<void> => {
    for (const callback of timers.splice(0)) callback()
    await service.settled()
  }
  /** Runs the recording's end without waiting for it to settle. */
  const due = (): void => { for (const callback of timers.splice(0)) callback() }
  return { service, directory, states, events, revealed, freeze, recover, finish, due }
}

describe('MainActivityService', () => {
  it('starts one recording when Record a minute arrives twice while the profilers start', async () => {
    let release!: () => void
    const starting = new Promise<void>(resolve => { release = resolve })
    const mains: ReturnType<typeof profiler>[] = []
    const { service, finish } = await harness({ mainProfiler: () => { const main = profiler({ starting }); mains.push(main); return main } })
    const firstWindow = profiler({ starting }), secondWindow = profiler({ starting })
    // Two presses queued behind a frozen main reach the service back to back, before either start resolves.
    const first = service.command({ type: 'record' }, () => firstWindow)
    const second = service.command({ type: 'record' }, () => secondWindow)
    release()
    await Promise.all([first, second])
    expect(mains).toHaveLength(1)
    expect(secondWindow.start).not.toHaveBeenCalled()
    expect(service.state().recording).toMatchObject({ phase: 'recording' })
    await finish()
    // Every profiler that started was stopped: none is left running on main or holding the window's debugger.
    expect(mains[0]!.stop).toHaveBeenCalledTimes(1)
    expect(firstWindow.stop).toHaveBeenCalledTimes(1)
    expect(service.state().recording).toMatchObject({ phase: 'saved' })
  })

  it('Stop without saving while the profilers start stops them once started and keeps nothing', async () => {
    let release!: () => void
    const starting = new Promise<void>(resolve => { release = resolve })
    const main = profiler({ starting }), window = profiler({ starting })
    const { service, directory, events } = await harness({ main })
    const recording = service.command({ type: 'record' }, () => window)
    await service.command({ type: 'discard' })
    release()
    await recording
    await service.settled()
    expect(main.cancelled).toBe(true)
    expect(main.stop).not.toHaveBeenCalled()
    expect(window.started && !window.cancelled).toBe(false)
    expect(service.state().recording).toEqual({ phase: 'idle' })
    expect(await readdir(directory).catch(() => [])).toEqual([])
    expect(events).toEqual([])
    // The slot is free again: the next press records.
    expect((await service.command({ type: 'record' }, () => profiler())).recording).toMatchObject({ phase: 'recording' })
  })

  it('tells the window when main freezes and recovers', async () => {
    const { service, states, freeze, recover } = await harness()
    freeze()
    expect(service.state().reading.frozen).toBe(true)
    expect(states.at(-1)!.reading.frozen).toBe(true)
    recover()
    expect(states.at(-1)!.reading.frozen).toBe(false)
  })

  it('Not now hides the notice until main recovers and freezes again', async () => {
    const { service, freeze, recover } = await harness()
    // Not now means nothing while main keeps up.
    expect((await service.command({ type: 'not-now' })).noticeHidden).toBe(false)
    freeze()
    expect((await service.command({ type: 'not-now' })).noticeHidden).toBe(true)
    recover()
    expect(service.state().noticeHidden).toBe(false)
    freeze()
    expect(service.state()).toMatchObject({ noticeHidden: false, reading: { frozen: true } })
  })

  it('records a minute of main and the window, saves it, and shows it in its folder', async () => {
    const { service, directory, events, revealed, finish } = await harness()
    const window = profiler()
    const started = await service.command({ type: 'record' }, () => window)
    expect(started.recording).toEqual({ phase: 'recording', startedAt: Date.UTC(2026, 9, 20, 14, 32, 5), durationMs: 60_000 })
    expect(window.started).toBe(true)
    // A second press while recording starts nothing new.
    await service.command({ type: 'record' }, () => profiler())
    await finish()
    const saved = service.state().recording
    expect(saved).toMatchObject({ phase: 'saved', files: ['main.cpuprofile', 'window.cpuprofile', 'summary.json'], windowRecorded: true })
    expect((await readdir(directory))).toHaveLength(1)
    expect(events).toEqual(['activity-recording-saved'])
    await service.command({ type: 'show-in-folder' })
    expect(revealed).toEqual([join(directory, (saved as { name: string }).name, 'main.cpuprofile')])
    const summary = JSON.parse(await readFile(join(directory, (saved as { name: string }).name, 'summary.json'), 'utf8')) as Record<string, unknown>
    expect(summary).toMatchObject({ format: 1, sottoVersion: '0.1.38-owl.20261020.1', platform: 'win32', windowRecorded: true })
    // Close returns to idle; the files stay.
    expect((await service.command({ type: 'close' })).recording).toEqual({ phase: 'idle' })
    expect((await readdir(directory))).toHaveLength(1)
  })

  it('keeps main\'s profile alone when the window\'s debugger is taken', async () => {
    const { service, events, finish } = await harness()
    await service.command({ type: 'record' }, () => profiler({ failStart: true }))
    await finish()
    expect(service.state().recording).toMatchObject({ phase: 'saved', files: ['main.cpuprofile', 'summary.json'], windowRecorded: false })
    expect(events).toEqual(['activity-recording-window-unavailable', 'activity-recording-saved'])
  })

  it('Stop without saving keeps nothing', async () => {
    const { service, directory } = await harness()
    const window = profiler()
    await service.command({ type: 'record' }, () => window)
    expect((await service.command({ type: 'discard' })).recording).toEqual({ phase: 'idle' })
    expect(window.cancelled).toBe(true)
    await expect(readdir(directory)).rejects.toThrow()
  })

  it('Stop without saving wins while the profiles are still being collected', async () => {
    let release!: () => void
    const stopped = new Promise<void>(resolve => { release = resolve })
    const main = profiler({ stopped })
    const { service, directory, events, due } = await harness({ main })
    await service.command({ type: 'record' })
    // The minute is up and main's profiler is stopping when Stop without saving is pressed.
    due()
    expect(main.stop).toHaveBeenCalled()
    expect((await service.command({ type: 'discard' })).recording).toEqual({ phase: 'idle' })
    release()
    await service.settled()
    expect(service.state().recording).toEqual({ phase: 'idle' })
    expect(events).not.toContain('activity-recording-saved')
    expect(await readdir(directory).catch(() => [])).toEqual([])
  })

  it('Stop without saving wins while the files are being written', async () => {
    let release!: () => void
    const written = new Promise<void>(resolve => { release = resolve })
    let writing!: () => void
    const started = new Promise<void>(resolve => { writing = resolve })
    const files: RecordingFileSystem = { ...recordingFileSystem, writeFile: async (path, data) => { writing(); await written; await recordingFileSystem.writeFile(path, data) } }
    const { service, directory, events, due } = await harness({ files })
    await service.command({ type: 'record' })
    due()
    await started
    await service.command({ type: 'discard' })
    release()
    await service.settled()
    expect(await readdir(directory)).toEqual([])
    expect(service.state().recording).toEqual({ phase: 'idle' })
    expect(events).not.toContain('activity-recording-saved')
  })

  it('a failed save leaves no files and says nothing was kept', async () => {
    let writes = 0
    const files: RecordingFileSystem = { ...recordingFileSystem, writeFile: async (path, data) => { if ((writes += 1) === 2) throw new Error('disk full'); await recordingFileSystem.writeFile(path, data) } }
    const { service, directory, finish } = await harness({ files })
    await service.command({ type: 'record' }, () => profiler())
    await finish()
    expect(service.state().recording).toEqual({ phase: 'failed', message: 'Sotto could not save the recording. Nothing was kept. Try Record a minute again.' })
    expect(await readdir(directory)).toEqual([])
  })

  it('a failed save that could not tidy up says which folder is left', async () => {
    let writes = 0
    const files: RecordingFileSystem = {
      ...recordingFileSystem,
      writeFile: async (path, data) => { if ((writes += 1) === 2) throw new Error('disk full'); await recordingFileSystem.writeFile(path, data) },
      rm: async () => { throw new Error('in use') },
    }
    const { service, directory, finish } = await harness({ files })
    await service.command({ type: 'record' }, () => profiler())
    await finish()
    const recording = service.state().recording
    expect(recording.phase).toBe('failed')
    const left = (await readdir(directory))[0]!
    expect(left).toMatch(/\.partial$/)
    expect((recording as { message: string }).message).toContain(left)
    expect((recording as { message: string }).message).not.toContain('Nothing was kept')
  })

  it('clears half-written folders when it starts', async () => {
    const { service, directory } = await harness({ before: async directory => { await mkdir(join(directory, 'sotto-activity-2026-10-20-09-00-00.partial'), { recursive: true }) } })
    await service.settled()
    expect(await readdir(directory)).toEqual([])
  })

  /** File operations whose publishing rename holds until `go`, so Stop without saving can come just after it. */
  function holdAfterPublish(rm: RecordingFileSystem['rm'], rename: RecordingFileSystem['rename'] = recordingFileSystem.rename) {
    let published!: () => void
    const publishedNow = new Promise<void>(resolve => { published = resolve })
    let go!: () => void
    const going = new Promise<void>(resolve => { go = resolve })
    let renames = 0
    const files: RecordingFileSystem = {
      ...recordingFileSystem, rm,
      rename: async (from, to) => {
        if ((renames += 1) > 1) return rename(from, to)
        await recordingFileSystem.rename(from, to)
        published()
        await going
      },
    }
    return { files, publishedNow, go }
  }

  it('Stop without saving just after the save published marks the folder half-written when it cannot remove it, and says so truly', async () => {
    const { files, publishedNow, go } = holdAfterPublish(async () => { throw new Error('in use') })
    const { service, directory, events, due } = await harness({ files })
    await service.command({ type: 'record' })
    due()
    await publishedNow
    await service.command({ type: 'discard' })
    go()
    await service.settled()
    const left = await readdir(directory)
    expect(left).toHaveLength(1)
    expect(left[0]).toMatch(/^sotto-activity-.*\.partial$/)
    const recording = service.state().recording
    expect(recording).toEqual({ phase: 'failed', message: saveFailedLeaving(left[0]!) })
    expect(events).not.toContain('activity-recording-saved')
    // What the message promises: the sweep the next start or save runs removes it.
    expect(await sweepPartialActivityRecordings(directory)).toEqual([])
    expect(await readdir(directory)).toEqual([])
  })

  it('Stop without saving just after the save published, when the folder can be neither marked nor removed, says it is kept', async () => {
    const { files, publishedNow, go } = holdAfterPublish(async () => { throw new Error('in use') }, async () => { throw new Error('in use') })
    const { service, directory, due } = await harness({ files })
    await service.command({ type: 'record' })
    due()
    await publishedNow
    await service.command({ type: 'discard' })
    go()
    await service.settled()
    const left = await readdir(directory)
    expect(left).toEqual([expect.stringMatching(/^sotto-activity-[\d-]+$/)])
    expect(service.state().recording).toEqual({ phase: 'failed', message: discardLeaving(left[0]!) })
  })

  it('says plainly when a recording could not start, and keeps nothing', async () => {
    const { service, events } = await harness({ main: profiler({ failStart: true }) })
    const state = await service.command({ type: 'record' })
    expect(state.recording).toEqual({ phase: 'failed', message: 'Sotto could not start recording. Nothing was kept. Try Record a minute again.' })
    expect(events).toEqual(['activity-recording-failed'])
    expect((await service.command({ type: 'close' })).recording).toEqual({ phase: 'idle' })
  })

  it('says plainly when a recording could not be saved', async () => {
    const { service, finish } = await harness({ main: profiler({ failStop: true }) })
    await service.command({ type: 'record' })
    await finish()
    expect(service.state().recording).toEqual({ phase: 'failed', message: 'Sotto could not save the recording. Nothing was kept. Try Record a minute again.' })
  })

  it('closing a saved recording during a freeze answers the notice as Not now does', async () => {
    const { service, freeze, finish } = await harness()
    await service.command({ type: 'record' })
    await finish()
    freeze()
    expect((await service.command({ type: 'close' })).noticeHidden).toBe(true)
  })

  it('stops its monitor and any recording when disposed', async () => {
    const { service } = await harness()
    const main = profiler()
    await service.command({ type: 'record' }, () => main)
    service.dispose()
    expect(service.loop.running).toBe(false)
  })
})

describe('registerMainActivityIpc', () => {
  it('registers nothing where the Owl feature built no service', async () => {
    const { registerMainActivityIpc } = await import('../../../src/main/performance/mainActivityIpc')
    const ipc = { handle: vi.fn(), removeHandler: vi.fn() }
    registerMainActivityIpc(ipc, null, () => [], () => null)()
    expect(ipc.handle).not.toHaveBeenCalled()
    expect(ipc.removeHandler).not.toHaveBeenCalled()
  })

  it('answers only the main window, and checks every command', async () => {
    const { registerMainActivityIpc } = await import('../../../src/main/performance/mainActivityIpc')
    const { MAIN_ACTIVITY_COMMAND, MAIN_ACTIVITY_READ } = await import('../../../src/shared/mainActivity')
    const { service } = await harness()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipc = { handle: (channel: string, listener: (event: never, ...args: unknown[]) => unknown) => { handlers.set(channel, listener as never) }, removeHandler: (channel: string) => { handlers.delete(channel) } }
    const frame = { url: 'file:///app/out/renderer/index.html', parent: null }
    const main = { id: 1, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false }
    const other = { id: 2, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false }
    const event = (sender: object) => ({ sender, senderFrame: frame })
    const cleanup = registerMainActivityIpc(ipc as never, service, () => [{ role: 'main', webContents: main as never, url: 'file:///app/out/renderer/index.html' }], () => null)
    expect([...handlers.keys()].sort()).toEqual([MAIN_ACTIVITY_COMMAND, MAIN_ACTIVITY_READ].sort())
    await expect(Promise.resolve(handlers.get(MAIN_ACTIVITY_READ)!(event(main)))).resolves.toMatchObject({ recording: { phase: 'idle' } })
    expect(() => handlers.get(MAIN_ACTIVITY_READ)!(event(other))).toThrow('Open Settings in the main Sotto window.')
    await expect(Promise.resolve().then(() => handlers.get(MAIN_ACTIVITY_COMMAND)!(event(main), { type: 'delete-everything' }))).rejects.toThrow()
    cleanup()
    expect(handlers.size).toBe(0)
  })
})
