// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { StartupService } from '../../../src/main/startup/startupService'


describe('StartupService', () => {
  it('delegates idempotently to login-item settings', () => {
    let enabled = false
    const adapter = {
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled })),
      setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean }) => {
        enabled = settings.openAtLogin
      }),
    }
    const service = new StartupService(adapter)

    expect(service.get()).toEqual({ enabled: false })
    expect(service.set(false)).toEqual({ enabled: false })
    expect(adapter.setLoginItemSettings).not.toHaveBeenCalled()

    expect(service.set(true)).toEqual({ enabled: true })
    expect(service.set(true)).toEqual({ enabled: true })
    expect(adapter.setLoginItemSettings).toHaveBeenCalledOnce()
  })
})
