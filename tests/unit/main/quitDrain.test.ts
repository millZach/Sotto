// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { bootstrapSotto } from '../../../src/main/app/bootstrap'
import { registerQuitDrain, SYSTEM_ENDING_WINDOW_MS } from '../../../src/main/app/quitDrain'
afterEach(() => vi.useRealTimers())
it('prevents repeated quits until the host drain settles, then allows the real quit', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() })
  let resolve = (): void => undefined
  const pending = new Promise<void>(done => { resolve = done })
  const drain = vi.fn(() => pending), failure = vi.fn(), event = { preventDefault: vi.fn() }
  registerQuitDrain(app, drain, failure)
  app.emit('before-quit', event); app.emit('before-quit', event)
  await Promise.resolve()
  expect(event.preventDefault).toHaveBeenCalledTimes(2); expect(drain).toHaveBeenCalledTimes(1); expect(app.quit).not.toHaveBeenCalled()
  resolve(); await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
  app.emit('before-quit', event)
  expect(event.preventDefault).toHaveBeenCalledTimes(2); expect(failure).not.toHaveBeenCalled()
})
it('reports a failed drain once and still permits exit', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() }), failure = vi.fn()
  registerQuitDrain(app, async () => { throw new Error('synthetic') }, failure)
  app.emit('before-quit', { preventDefault: vi.fn() })
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
  expect(failure).toHaveBeenCalledTimes(1)
})

it.each(['resolve', 'reject'] as const)('forces exit after ten seconds even if a drain later %ss', async ending => {
  vi.useFakeTimers()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() })
  let resolve = (): void => undefined, reject = (): void => undefined
  const pending = new Promise<void>((done, fail) => { resolve = done; reject = () => fail(new Error('synthetic')) })
  const drain = vi.fn(() => pending)
  registerQuitDrain(app, drain, vi.fn())
  app.emit('before-quit', { preventDefault: vi.fn() })
  await vi.advanceTimersByTimeAsync(9_999)
  expect(app.exit).not.toHaveBeenCalled()
  app.emit('before-quit', { preventDefault: vi.fn() })
  await vi.advanceTimersByTimeAsync(1)
  expect(app.exit).toHaveBeenCalledTimes(1)
  expect(app.quit).not.toHaveBeenCalled()
  expect(drain).toHaveBeenCalledTimes(1)
  if (ending === 'resolve') resolve()
  else reject()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(app.exit).toHaveBeenCalledTimes(1)
  expect(app.quit).not.toHaveBeenCalled()
})

it('keeps the native windows and tray until the drain settles despite bootstrap registering first', async () => {
  vi.useFakeTimers()
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true,
    whenReady: async () => undefined,
    quit: vi.fn(() => app.emit('before-quit', quitEvent())),
    exit: vi.fn(),
  })
  function quitEvent() {
    return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
  }
  const runtime = { start: vi.fn(async () => undefined), showMain: vi.fn(), showFromActivation: vi.fn(), beginQuit: vi.fn(), dispose: vi.fn() }
  await bootstrapSotto({ app, initialize: () => runtime, log: vi.fn() })
  let resolve = (): void => undefined
  const pending = new Promise<void>(done => { resolve = done })
  registerQuitDrain(app, () => pending, vi.fn())
  app.emit('before-quit', quitEvent())
  await vi.advanceTimersByTimeAsync(0)
  expect(runtime.beginQuit).not.toHaveBeenCalled()
  expect(runtime.dispose).not.toHaveBeenCalled()
  resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(runtime.beginQuit).toHaveBeenCalledTimes(1)
  expect(runtime.dispose).toHaveBeenCalledTimes(1)
  expect(app.quit).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(app.exit).not.toHaveBeenCalled()
})

it('lets a macOS log out, restart or shutdown quit at once and still starts the drain', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() })
  const power = new EventEmitter()
  const drain = vi.fn(() => new Promise<void>(() => undefined)), event = { preventDefault: vi.fn() }
  registerQuitDrain(app, drain, vi.fn(), power)
  power.emit('shutdown')
  app.emit('before-quit', event)
  app.emit('before-quit', event)
  await Promise.resolve()
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(drain).toHaveBeenCalledTimes(1)
  expect(app.quit).not.toHaveBeenCalled()
  expect(app.exit).not.toHaveBeenCalled()
})

it('stops holding a quit already draining when the system starts to log out', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() })
  const power = new EventEmitter()
  let resolve = (): void => undefined
  const drain = vi.fn(() => new Promise<void>(done => { resolve = done }))
  registerQuitDrain(app, drain, vi.fn(), power)
  const first = { preventDefault: vi.fn() }
  app.emit('before-quit', first)
  expect(first.preventDefault).toHaveBeenCalledTimes(1)
  power.emit('shutdown')
  const second = { preventDefault: vi.fn() }
  app.emit('before-quit', second)
  expect(second.preventDefault).not.toHaveBeenCalled()
  resolve()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(app.quit).not.toHaveBeenCalled()
  expect(drain).toHaveBeenCalledTimes(1)
})

it('still drains an ordinary quit when the shutdown source never fires', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() })
  const event = { preventDefault: vi.fn() }
  registerQuitDrain(app, async () => undefined, vi.fn(), new EventEmitter())
  app.emit('before-quit', event)
  expect(event.preventDefault).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
})

it('drains a later Command-Q again when a log out is cancelled', async () => {
  vi.useFakeTimers()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() })
  const power = new EventEmitter()
  registerQuitDrain(app, async () => undefined, vi.fn(), power)
  power.emit('shutdown')
  await vi.advanceTimersByTimeAsync(SYSTEM_ENDING_WINDOW_MS)
  const event = { preventDefault: vi.fn() }
  app.emit('before-quit', event)
  expect(event.preventDefault).toHaveBeenCalledTimes(1)
})
