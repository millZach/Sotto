// @vitest-environment node
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../fixtures/deferred'
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
    registerHostQuitDrain(app, handles, failed, vi.fn(), 'win32', new EventEmitter())
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

it.each(['win32', 'darwin', 'linux'] as const)('pins shutdown registration and drain behavior on %s', async platform => {
  const app = Object.assign(new EventEmitter(), {
    quit: vi.fn(() => app.emit('before-quit', { preventDefault: vi.fn() })), exit: vi.fn(),
  })
  const power = new EventEmitter(), close = vi.fn(async () => undefined)
  registerHostQuitDrain(app, { localRuntime: { close } }, vi.fn(), vi.fn(), platform, power)
  expect(power.listenerCount('shutdown')).toBe(platform === 'win32' ? 0 : 1)
  const shutdown = { preventDefault: vi.fn() }
  power.emit('shutdown', shutdown)
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledTimes(platform === 'linux' ? 1 : 0)
    expect(app.quit).toHaveBeenCalledTimes(platform === 'linux' ? 2 : 0)
  })
  expect(shutdown.preventDefault).toHaveBeenCalledTimes(platform === 'linux' ? 1 : 0)
  if (platform !== 'linux') {
    const quit = { preventDefault: vi.fn() }
    app.emit('before-quit', quit)
    expect(quit.preventDefault).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  }
})

it('starts local and cloud iPhone cleanup before slow phone cleanup on Linux shutdown', async () => {
  const app = Object.assign(new EventEmitter(), {
    quit: vi.fn(() => app.emit('before-quit', { preventDefault: vi.fn() })), exit: vi.fn(),
  })
  const power = new EventEmitter(), order: string[] = []
  let finishPhone = (): void => undefined
  const phone = new Promise<void>(resolve => { finishPhone = resolve })
  const close = (name: string) => ({ close: vi.fn(async () => { order.push(name) }) })
  const localRuntime = close('local'), cloudIphone = close('cloud'), desktopHosts = close('hosts')
  registerHostQuitDrain(app, { localRuntime, cloudIphone, desktopHosts,
    phoneAccess: { close: () => { order.push('phone'); return phone } },
  }, vi.fn(), vi.fn(), 'linux', power)
  power.emit('shutdown', { preventDefault: vi.fn() })
  await vi.waitFor(() => expect(order).toEqual(['local', 'cloud', 'phone']))
  expect(desktopHosts.close).not.toHaveBeenCalled()
  finishPhone()
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(2))
  expect(localRuntime.close).toHaveBeenCalledOnce()
  expect(cloudIphone.close).toHaveBeenCalledOnce()
  expect(desktopHosts.close).toHaveBeenCalledOnce()
})

it.each(['win32', 'darwin', 'linux'] as const)('keeps phone-first cleanup on an ordinary %s quit', async platform => {
  const app = Object.assign(new EventEmitter(), {
    quit: vi.fn(() => app.emit('before-quit', { preventDefault: vi.fn() })), exit: vi.fn(),
  })
  const order: string[] = []
  let finishPhone = (): void => undefined
  const phone = new Promise<void>(resolve => { finishPhone = resolve })
  const close = (name: string) => ({ close: async () => { order.push(name) } })
  registerHostQuitDrain(app, {
    localRuntime: close('local'), cloudIphone: close('cloud'), desktopHosts: close('hosts'),
    phoneAccess: { close: () => { order.push('phone'); return phone } },
  }, vi.fn(), vi.fn(), platform, new EventEmitter())
  app.quit()
  await vi.waitFor(() => expect(order).toEqual(['phone']))
  finishPhone()
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(2))
  expect(order).toEqual(['phone', 'hosts', 'local', 'cloud'])
})

it('starts urgent Linux cleanup when shutdown arrives during phone-first ordinary quit', async () => {
  const app = Object.assign(new EventEmitter(), {
    quit: vi.fn(() => app.emit('before-quit', { preventDefault: vi.fn() })), exit: vi.fn(),
  })
  const power = new EventEmitter(), phone = deferred<void>()
  const local = { close: vi.fn(async () => undefined), prepareForShutdown: vi.fn(async () => undefined) }
  const cloud = { close: vi.fn(async () => undefined) }, stopPublishing = vi.fn()
  registerHostQuitDrain(app, { localRuntime: local, cloudIphone: cloud, stopPublishing,
    phoneAccess: { close: () => phone.promise },
  }, vi.fn(), vi.fn(), 'linux', power)
  app.quit()
  await vi.waitFor(() => expect(stopPublishing).toHaveBeenCalledOnce())
  expect(local.close).not.toHaveBeenCalled()
  power.emit('shutdown', { preventDefault: vi.fn() })
  power.emit('shutdown', { preventDefault: vi.fn() })
  await vi.waitFor(() => expect(local.prepareForShutdown).toHaveBeenCalledOnce())
  expect(cloud.close).toHaveBeenCalledOnce()
  expect(local.close).not.toHaveBeenCalled()
  expect(stopPublishing).toHaveBeenCalledOnce()
  phone.resolve()
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(3))
  expect(local.close).toHaveBeenCalledOnce()
  expect(cloud.close).toHaveBeenCalledOnce()
})
