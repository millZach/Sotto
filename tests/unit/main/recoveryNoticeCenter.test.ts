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

    expect(center.list()).toEqual([
      { code: 'SETTINGS_RECOVERED' },
      { code: 'HISTORY_RECOVERED' },
    ])
    expect(listener.mock.calls).toEqual([
      [{ code: 'SETTINGS_RECOVERED' }],
      [{ code: 'HISTORY_RECOVERED' }],
    ])
    unsubscribe()
    center.publish({ code: 'SETTINGS_RECOVERED' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('returns immutable copies that cannot alter retained notices', () => {
    const center = new RecoveryNoticeCenter()
    center.publish({ code: 'SETTINGS_RECOVERED' })
    const first = center.list()

    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
    expect(center.list()).toEqual([{ code: 'SETTINGS_RECOVERED' }])
  })
})
