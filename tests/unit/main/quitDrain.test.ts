// @vitest-environment node
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { registerQuitDrain } from '../../../src/main/app/quitDrain'
it('prevents repeated quits until the host drain settles, then allows the real quit', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
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
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() }), failure = vi.fn()
  registerQuitDrain(app, async () => { throw new Error('synthetic') }, failure)
  app.emit('before-quit', { preventDefault: vi.fn() })
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
  expect(failure).toHaveBeenCalledTimes(1)
})
