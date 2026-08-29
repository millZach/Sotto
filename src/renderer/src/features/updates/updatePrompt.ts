import type { UpdateStatus } from '../../../../shared/contracts'

/**
 * The management window only interrupts for two moments: a version being
 * offered, and a version already on disk waiting for a restart. Checking,
 * being current, failing, and having no feed at all are Settings-only facts —
 * none of them is worth a strip across the top of the window.
 *
 * The key carries the moment as well as the version, so dismissing the offer
 * does not also silence the "ready to install" note that the user's own
 * download produced.
 */
export function updatePromptKey(status: UpdateStatus | null): string | null {
  if (status === null) return null
  switch (status.phase.phase) {
    case 'available':
    case 'downloading':
      return `offer:${status.phase.version}`
    case 'downloaded':
      return `ready:${status.phase.version}`
    default:
      return null
  }
}
