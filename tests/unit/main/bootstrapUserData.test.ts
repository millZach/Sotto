// @vitest-environment node
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { bootstrapSotto } from '../../../src/main/app/bootstrap'

it.each([true, false])('prepares user data only after acquiring the instance lock (%s)', async locked => {
  const order: string[] = []
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: vi.fn(() => { order.push('lock'); return locked }),
    whenReady: async () => { order.push('ready') }, quit: vi.fn(),
  })
  const prepareUserData = vi.fn(() => { order.push('migrate') })
  const runtime = { start: vi.fn(async () => undefined), showMain: vi.fn(), showFromActivation: vi.fn(), beginQuit: vi.fn(), dispose: vi.fn() }
  const result = await bootstrapSotto({ app, prepareUserData, initialize: () => runtime, log: vi.fn() })
  expect(order).toEqual(locked ? ['lock', 'migrate', 'ready'] : ['lock'])
  expect(prepareUserData).toHaveBeenCalledTimes(locked ? 1 : 0)
  expect(result.started).toBe(locked)
  result.dispose()
})

it('wires legacy migration through locked bootstrap rather than module initialization', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const setup = source.slice(source.indexOf('void bootstrapSotto('))
  expect(setup).toContain('migrateLegacyUserData(')
  expect(source.slice(0, source.indexOf('void bootstrapSotto('))).not.toContain('migrateLegacyUserData(app.getPath(')
})
