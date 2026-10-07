// @vitest-environment node
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { bootstrapSotto } from '../../../src/main/app/bootstrap'
import { registerHostQuitDrain, type HostQuitHandles } from '../../../src/main/app/hostQuitDrain'

it('registers the desktop drain before remote resources can start', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const registration = source.indexOf('registerHostQuitDrain(app,')
  expect(registration).toBeGreaterThan(-1)
  for (const start of ['await desktopHosts.start()', 'void phoneAccess.start()']) {
    expect(registration).toBeLessThan(source.indexOf(start))
  }
})

it.each(['hosts', 'phone'] as const)('drains every acquired handle after %s startup rejects', async failureAt => {
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, whenReady: async () => undefined,
    quit: vi.fn(() => app.emit('before-quit', { preventDefault: vi.fn() })), exit: vi.fn(),
  })
  const order: string[] = []
  const resource = (name: string) => ({ close: vi.fn(async () => { order.push(name) }) })
  const localRuntime = resource('local'), desktopHosts = resource('hosts'), phoneAccess = resource('phone')
  const handles: HostQuitHandles = { localRuntime }
  const failed = vi.fn()
  const result = await bootstrapSotto({ app, log: vi.fn(), initialize: async () => {
    registerHostQuitDrain(app, handles, failed, vi.fn())
    handles.desktopHosts = desktopHosts
    if (failureAt === 'hosts') throw new Error('Synthetic host startup failure')
    handles.phoneAccess = phoneAccess
    throw new Error('Synthetic phone startup failure')
  } })
  expect(result.started).toBe(false)
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(2))
  expect(localRuntime.close).toHaveBeenCalledOnce()
  expect(desktopHosts.close).toHaveBeenCalledOnce()
  expect(phoneAccess.close).toHaveBeenCalledTimes(failureAt === 'phone' ? 1 : 0)
  if (failureAt === 'phone') expect(order[0]).toBe('phone')
  expect(failed).not.toHaveBeenCalled()
})
