import type { RecoveryNoticeCenter } from '../storage/recoveryNoticeCenter'
import type { AccessibilityGate } from './pasteAccessibility'

/** Recheck only outstanding paste permissions when Sotto regains focus, without sending a keystroke. */
export function createPastePermissionRecovery(
  notices: Pick<RecoveryNoticeCenter, 'list' | 'clear'>,
  accessibility: AccessibilityGate,
  automationGranted: () => Promise<boolean>,
): { check(): Promise<void>; pasted(): void } {
  let checkingAutomation = false
  return {
    async check(): Promise<void> {
      const active = notices.list()
      if (active.some(notice => notice.code === 'ACCESSIBILITY_PERMISSION_REQUIRED') && accessibility.status() === 'trusted') {
        notices.clear('ACCESSIBILITY_PERMISSION_REQUIRED')
      }
      if (checkingAutomation || !active.some(notice => notice.code === 'AUTOMATION_PERMISSION_REQUIRED')) return
      checkingAutomation = true
      try {
        if (await automationGranted()) notices.clear('AUTOMATION_PERMISSION_REQUIRED')
      } finally {
        checkingAutomation = false
      }
    },
    pasted(): void {
      notices.clear('ACCESSIBILITY_PERMISSION_REQUIRED')
      notices.clear('AUTOMATION_PERMISSION_REQUIRED')
    },
  }
}
