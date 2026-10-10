// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { LINUX_LOGIN_ITEMS, StartupService, type LoginItemAdapter } from '../../../src/main/startup/startupService'

function loginItems(initial: { openAtLogin: boolean; status?: string }, onSet?: (openAtLogin: boolean) => { openAtLogin: boolean; status?: string }) {
  let current = initial
  const calls: boolean[] = []
  const adapter: LoginItemAdapter = {
    getLoginItemSettings: () => current,
    setLoginItemSettings: ({ openAtLogin }) => { calls.push(openAtLogin); current = onSet?.(openAtLogin) ?? { openAtLogin } },
  }
  return { adapter, calls }
}

describe('StartupService', () => {
  it('on Linux reads as off and turns nothing on, so a remembered or requested on never reaches Electron', () => {
    const startup = new StartupService(LINUX_LOGIN_ITEMS)
    expect(startup.get()).toEqual({ enabled: false, supported: false })
    expect(startup.set(true)).toEqual({ enabled: false, supported: false })
    expect(startup.set(false)).toEqual({ enabled: false, supported: false })
  })

  it('reads and writes the login item where the system reports no status', () => {
    const { adapter, calls } = loginItems({ openAtLogin: false })
    const startup = new StartupService(adapter)
    expect(startup.set(true)).toEqual({ enabled: true })
    expect(startup.set(true)).toEqual({ enabled: true })
    expect(calls).toEqual([true])
  })

  it('keeps a macOS login item waiting for approval on and says so, so the toggle does not snap back', () => {
    const { adapter } = loginItems({ openAtLogin: false, status: 'not-registered' }, () => ({ openAtLogin: false, status: 'requires-approval' }))
    const startup = new StartupService(adapter)
    expect(startup.set(true)).toEqual({ enabled: true, approvalRequired: true })
    expect(startup.get()).toEqual({ enabled: true, approvalRequired: true })
  })

  it('turns off a login item that is waiting for approval', () => {
    const { adapter, calls } = loginItems({ openAtLogin: false, status: 'requires-approval' }, () => ({ openAtLogin: false, status: 'not-registered' }))
    const startup = new StartupService(adapter)
    expect(startup.set(false)).toEqual({ enabled: false })
    expect(calls).toEqual([false])
  })

  it('reads an approved macOS login item as on without a notice', () => {
    const { adapter } = loginItems({ openAtLogin: true, status: 'enabled' })
    expect(new StartupService(adapter).get()).toEqual({ enabled: true })
  })
})
