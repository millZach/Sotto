// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createPastePermissionRecovery } from '../../../src/main/output/pastePermissionRecovery'
import { RecoveryNoticeCenter } from '../../../src/main/storage/recoveryNoticeCenter'
import { deferred } from '../../fixtures/deferred'

describe('paste permission recovery', () => {
  it('rechecks only outstanding permissions and clears them once granted', async () => {
    const notices = new RecoveryNoticeCenter()
    let trusted = false
    const status = vi.fn(() => trusted ? 'trusted' as const : 'untrusted' as const)
    const automation = vi.fn(async () => trusted)
    const recovery = createPastePermissionRecovery(notices, { status, requestOnce: vi.fn() }, automation)
    await recovery.check()
    expect(status).not.toHaveBeenCalled()
    expect(automation).not.toHaveBeenCalled()

    notices.publish({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })
    notices.publish({ code: 'AUTOMATION_PERMISSION_REQUIRED' })
    notices.publish({ code: 'HISTORY_RECOVERED' })
    await recovery.check()
    expect(notices.list()).toHaveLength(3)
    trusted = true
    await recovery.check()
    expect(notices.list()).toEqual([{ code: 'HISTORY_RECOVERED' }])
    notices.publish({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })
    notices.publish({ code: 'AUTOMATION_PERMISSION_REQUIRED' })
    await recovery.check()
    expect(status).toHaveBeenCalledTimes(2)
    expect(automation).toHaveBeenCalledTimes(2)
  })

  it('checks Automation once while the previous check is still answering', async () => {
    const notices = new RecoveryNoticeCenter()
    notices.publish({ code: 'AUTOMATION_PERMISSION_REQUIRED' })
    const pending = deferred<boolean>()
    const automation = vi.fn(() => pending.promise)
    const recovery = createPastePermissionRecovery(notices, { status: () => 'trusted', requestOnce: vi.fn() }, automation)
    const first = recovery.check()
    await recovery.check()
    expect(automation).toHaveBeenCalledOnce()
    pending.resolve(true)
    await first
    expect(notices.list()).toEqual([])
  })

  it('clears both permission notices after a successful paste without hiding other recovery notices', () => {
    const notices = new RecoveryNoticeCenter()
    notices.publish({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' })
    notices.publish({ code: 'AUTOMATION_PERMISSION_REQUIRED' })
    notices.publish({ code: 'HISTORY_RECOVERED' })
    const recovery = createPastePermissionRecovery(notices, { status: () => 'untrusted', requestOnce: vi.fn() }, vi.fn())
    recovery.pasted()
    expect(notices.list()).toEqual([{ code: 'HISTORY_RECOVERED' }])
  })
})
