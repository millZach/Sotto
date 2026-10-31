// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { RecoveryNoticeCenter } from '../../../src/main/storage/recoveryNoticeCenter'

describe('RecoveryNoticeCenter', () => {
  it('retains and emits each safe recovery code once per launch', () => {
    const center = new RecoveryNoticeCenter()
    const listener = vi.fn()
    const unsubscribe = center.subscribe(listener)

    center.publish({ code: 'SETTINGS_RECOVERED' })
    center.publish({ code: 'SETTINGS_RECOVERED' })
    center.publish({ code: 'HISTORY_RECOVERED' })
    center.publish({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })
    center.publish({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })

    expect(center.list()).toEqual([
      { code: 'SETTINGS_RECOVERED' },
      { code: 'HISTORY_RECOVERED' },
      { code: 'ACCESSIBILITY_PERMISSION_REQUIRED' },
    ])
    expect(listener.mock.calls).toEqual([
      [{ code: 'SETTINGS_RECOVERED' }],
      [{ code: 'HISTORY_RECOVERED' }],
      [{ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' }],
    ])
    unsubscribe()
    center.publish({ code: 'SETTINGS_RECOVERED' })
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('returns immutable copies that cannot alter retained notices', () => {
    const center = new RecoveryNoticeCenter()
    center.publish({ code: 'SETTINGS_RECOVERED' })
    const first = center.list()

    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
    expect(center.list()).toEqual([{ code: 'SETTINGS_RECOVERED' }])
  })

  it('clears a notice for every subscriber and keeps its cause seen until the next launch', () => {
    const center = new RecoveryNoticeCenter()
    const listener = vi.fn()
    center.subscribe(listener)
    center.publish({ code: 'SETTINGS_RECOVERED' })
    center.publish({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })
    center.clear('ACCESSIBILITY_PERMISSION_REQUIRED')
    center.clear('ACCESSIBILITY_PERMISSION_REQUIRED')
    center.publish({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })
    expect(center.list()).toEqual([{ code: 'SETTINGS_RECOVERED' }])
    expect(listener).toHaveBeenCalledTimes(3)
    expect(listener).toHaveBeenLastCalledWith({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED', cleared: true })

    const restarted = new RecoveryNoticeCenter()
    restarted.publish({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })
    expect(restarted.list()).toEqual([{ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' }])
  })
})
