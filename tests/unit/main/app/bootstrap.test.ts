// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  bootstrapSotto,
  NativeRuntimeStoppedError,
  type RuntimeController
} from '../../../../src/main/app/bootstrap'
import { createApp, createDeferred, createRuntime } from '../../../fixtures/bootstrapHarness'


describe('bootstrap failure containment', () => {
  it('fails closed before runtime startup when bundled manifest initialization rejects', async () => {
    const app = createApp(Promise.resolve())
    const log = vi.fn()
    const initialize = vi.fn(async (): Promise<RuntimeController> => {
      throw new Error('Invalid bundled model manifest: private path')
    })

    const result = await bootstrapSotto({ app, initialize, log })

    expect(result.started).toBe(false)
    expect(initialize).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('bootstrap-startup-failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('catches readiness rejection, emits only a safe diagnostic, and quits in a controlled way', async () => {
    const app = createApp(Promise.reject(new Error('secret token C:/Users/private')))
    const log = vi.fn()
    const initialize = vi.fn(async () => createRuntime())

    const result = await bootstrapSotto({ app, initialize, log })

    expect(result.started).toBe(false)
    expect(initialize).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('bootstrap-readiness-failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('contains renderer startup rejection, cleans resources, and quits without leaking the error', async () => {
    const app = createApp(Promise.resolve())
    const log = vi.fn()
    const runtime = createRuntime(async () => {
      throw new Error('renderer secret C:/Users/private')
    })

    const result = await bootstrapSotto({
      app,
      initialize: async () => runtime,
      log,
    })

    expect(result.started).toBe(false)
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('bootstrap-startup-failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('raises the existing main window for a second instance and cleans up once on quit', async () => {
    const app = createApp(Promise.resolve())
    const runtime = createRuntime()
    const result = await bootstrapSotto({
      app,
      initialize: async () => runtime,
      log: vi.fn(),
    })

    expect(result.started).toBe(true)
    app.emit('second-instance')
    expect(runtime.showMain).toHaveBeenCalledOnce()

    app.emit('before-quit')
    app.emit('before-quit')
    result.dispose()
    expect(runtime.beginQuit).toHaveBeenCalledOnce()
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  it('quits immediately when another instance owns the lock', async () => {
    const app = createApp(Promise.resolve())
    vi.mocked(app.requestSingleInstanceLock).mockReturnValue(false)
    const initialize = vi.fn(async () => createRuntime())

    const result = await bootstrapSotto({ app, initialize, log: vi.fn() })

    expect(result.started).toBe(false)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(initialize).not.toHaveBeenCalled()
  })

  it('stops before initialization when before-quit wins during readiness', async () => {
    const readiness = createDeferred<void>()
    const app = createApp(readiness.promise)
    const initialize = vi.fn(async () => createRuntime())
    const log = vi.fn()
    const bootstrap = bootstrapSotto({ app, initialize, log })

    app.emit('before-quit')
    readiness.resolve()

    await expect(bootstrap).resolves.toMatchObject({ started: false })
    expect(initialize).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('disposes a late initialization candidate when before-quit has already won', async () => {
    const initialization = createDeferred<RuntimeController>()
    const app = createApp(Promise.resolve())
    const initialize = vi.fn(() => initialization.promise)
    const log = vi.fn()
    const bootstrap = bootstrapSotto({ app, initialize, log })
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())

    app.emit('before-quit')
    const candidate = createRuntime()
    initialization.resolve(candidate)

    await expect(bootstrap).resolves.toMatchObject({ started: false })
    expect(candidate.start).not.toHaveBeenCalled()
    expect(candidate.beginQuit).toHaveBeenCalledOnce()
    expect(candidate.dispose).toHaveBeenCalledOnce()
    expect(log).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('contains an expected stopped rejection after before-quit during runtime startup', async () => {
    const startup = createDeferred<void>()
    const app = createApp(Promise.resolve())
    const runtime = createRuntime(() => startup.promise)
    const log = vi.fn()
    const bootstrap = bootstrapSotto({
      app,
      initialize: async () => runtime,
      log,
    })
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())

    app.emit('second-instance')
    app.emit('before-quit')
    startup.reject(new NativeRuntimeStoppedError())

    await expect(bootstrap).resolves.toMatchObject({ started: false })
    expect(runtime.showMain).not.toHaveBeenCalled()
    expect(runtime.beginQuit).toHaveBeenCalledOnce()
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect(log).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('coalesces second-instance intent across readiness and startup, then shows immediately', async () => {
    const readiness = createDeferred<void>()
    const startup = createDeferred<void>()
    const app = createApp(readiness.promise)
    const runtime = createRuntime(() => startup.promise)
    const bootstrap = bootstrapSotto({
      app,
      initialize: async () => runtime,
      log: vi.fn(),
    })

    app.emit('second-instance')
    app.emit('second-instance')
    readiness.resolve()
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())
    app.emit('second-instance')
    app.emit('second-instance')
    const callsBeforeStartupCompleted = runtime.showMain.mock.calls.length
    startup.resolve()

    await expect(bootstrap).resolves.toMatchObject({ started: true })
    expect(callsBeforeStartupCompleted).toBe(0)
    expect(runtime.showMain).toHaveBeenCalledOnce()

    app.emit('second-instance')
    expect(runtime.showMain).toHaveBeenCalledTimes(2)
  })

  it('retains second-instance intent while initialization is pending for a minimized runtime', async () => {
    const initialization = createDeferred<RuntimeController>()
    const app = createApp(Promise.resolve())
    const initialize = vi.fn(() => initialization.promise)
    const bootstrap = bootstrapSotto({ app, initialize, log: vi.fn() })
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())

    app.emit('second-instance')
    app.emit('second-instance')
    const minimizedRuntime = createRuntime()
    initialization.resolve(minimizedRuntime)

    await expect(bootstrap).resolves.toMatchObject({ started: true })
    expect(minimizedRuntime.start).toHaveBeenCalledOnce()
    expect(minimizedRuntime.showMain).toHaveBeenCalledOnce()
  })

  it('drops pending second-instance intent when startup fails', async () => {
    const startup = createDeferred<void>()
    const app = createApp(Promise.resolve())
    const runtime = createRuntime(() => startup.promise)
    const log = vi.fn()
    const bootstrap = bootstrapSotto({
      app,
      initialize: async () => runtime,
      log,
    })
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())

    app.emit('second-instance')
    app.emit('second-instance')
    startup.reject(new Error('real startup failure'))

    await expect(bootstrap).resolves.toMatchObject({ started: false })
    expect(runtime.showMain).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('bootstrap-startup-failed')
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it.each([
    ['beginQuit', 'bootstrap-runtime-begin-quit-failed'],
    ['dispose', 'bootstrap-runtime-dispose-failed'],
  ] as const)(
    'isolates a throwing candidate %s during before-quit',
    async (failingMethod, expectedCode) => {
      const app = createApp(Promise.resolve())
      const log = vi.fn()
      const candidate = createRuntime()
      candidate[failingMethod].mockImplementation(() => {
        throw new Error('secret native teardown detail')
      })
      const result = await bootstrapSotto({
        app,
        initialize: async () => candidate,
        log,
      })

      expect(() => app.emit('before-quit')).not.toThrow()
      expect(candidate.beginQuit).toHaveBeenCalledOnce()
      expect(candidate.dispose).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith(expectedCode)
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret')

      expect(() => result.dispose()).not.toThrow()
      expect(candidate.beginQuit).toHaveBeenCalledOnce()
      expect(candidate.dispose).toHaveBeenCalledOnce()
    },
  )

  it('raises the existing main window when the app is reactivated', async () => {
    const app = createApp(Promise.resolve())
    const runtime = createRuntime()
    const result = await bootstrapSotto({
      app,
      initialize: async () => runtime,
      log: vi.fn(),
    })

    expect(result.started).toBe(true)
    app.emit('activate')
    expect(runtime.showFromActivation).toHaveBeenCalledOnce()
    expect(runtime.showMain).not.toHaveBeenCalled()
    app.emit('activate')
    expect(runtime.showFromActivation).toHaveBeenCalledTimes(2)
  })

  it('coalesces activation intent raised before startup completes into one show', async () => {
    const readiness = createDeferred<void>()
    const startup = createDeferred<void>()
    const app = createApp(readiness.promise)
    const runtime = createRuntime(() => startup.promise)
    const bootstrap = bootstrapSotto({
      app,
      initialize: async () => runtime,
      log: vi.fn(),
    })

    app.emit('activate')
    app.emit('activate')
    readiness.resolve()
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())
    app.emit('activate')
    app.emit('second-instance')
    const callsBeforeStartupCompleted = runtime.showMain.mock.calls.length
    startup.resolve()

    await expect(bootstrap).resolves.toMatchObject({ started: true })
    expect(callsBeforeStartupCompleted).toBe(0)
    expect(runtime.showMain).toHaveBeenCalledOnce()
  })

  it('ignores activation after disposal', async () => {
    const app = createApp(Promise.resolve())
    const runtime = createRuntime()
    const result = await bootstrapSotto({
      app,
      initialize: async () => runtime,
      log: vi.fn(),
    })

    result.dispose()
    app.emit('activate')

    expect(runtime.showMain).not.toHaveBeenCalled()
    expect(runtime.showFromActivation).not.toHaveBeenCalled()
  })

  it('drops pending activation intent when startup fails', async () => {
    const startup = createDeferred<void>()
    const app = createApp(Promise.resolve())
    const runtime = createRuntime(() => startup.promise)
    const bootstrap = bootstrapSotto({
      app,
      initialize: async () => runtime,
      log: vi.fn(),
    })
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())

    app.emit('activate')
    startup.reject(new Error('real startup failure'))

    await expect(bootstrap).resolves.toMatchObject({ started: false })
    expect(runtime.showMain).not.toHaveBeenCalled()
  })
})
