import type { RecoveryNoticeCenter } from '../storage/recoveryNoticeCenter'
import type { AccessibilityGate } from './pasteAccessibility'

/** Recheck only outstanding paste permissions when Sotto regains focus, without sending a keystroke. */
export function createPastePermissionRecovery(
  notices: Pick<RecoveryNoticeCenter, 'hasUnresolved' | 'resolve'>,
  accessibility: AccessibilityGate,
  automationGranted: () => Promise<boolean>,
): { check(): Promise<void>; pasted(): void } {
  let checkingAutomation = false
  return {
    async check(): Promise<void> {
      if (notices.hasUnresolved('ACCESSIBILITY_PERMISSION_REQUIRED') && accessibility.status() === 'trusted') {
        notices.resolve('ACCESSIBILITY_PERMISSION_REQUIRED')
      }
      if (checkingAutomation || !notices.hasUnresolved('AUTOMATION_PERMISSION_REQUIRED')) return
      checkingAutomation = true
      try {
        if (await automationGranted()) notices.resolve('AUTOMATION_PERMISSION_REQUIRED')
      } finally {
        checkingAutomation = false
      }
    },
    pasted(): void {
      notices.resolve('ACCESSIBILITY_PERMISSION_REQUIRED')
      notices.resolve('AUTOMATION_PERMISSION_REQUIRED')
    },
  }
}
