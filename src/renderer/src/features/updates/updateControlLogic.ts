import type { UpdateStatus } from '../../../../shared/contracts'

/** What pressing the footer's update control would do right now. */
export type UpdateAction = 'check' | 'download' | 'install' | 'none'

/** The glyph the control wears; `checking` and `downloading` also animate. */
export type UpdateIconState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded'

export const UPDATES_UNSUPPORTED_MESSAGE = 'Update checks run only in the installed Windows app.'

/**
 * One button, one meaning at a time. A failed download keeps the offer and a
 * failed install keeps the download, so both simply offer the same action
 * again; a failed check offers to check again.
 */
export function updateAction(status: UpdateStatus | null): UpdateAction {
  if (status === null) return 'none'
  switch (status.phase.phase) {
    case 'idle':
    case 'up-to-date':
    case 'failed':
      return 'check'
    case 'available':
      return 'download'
    case 'downloaded':
      return 'install'
    default:
      return 'none'
  }
}

export function updateIconState(status: UpdateStatus | null): UpdateIconState {
  switch (status?.phase.phase) {
    case 'checking': return 'checking'
    case 'available': return 'available'
    case 'downloading': return 'downloading'
    case 'downloaded': return 'downloaded'
    default: return 'idle'
  }
}

/** The control's name: what it shows and, when it is pressable, what a press does. */
export function updateTooltip(status: UpdateStatus | null): string {
  if (status === null) return 'Check for updates'
  const phase = status.phase
  switch (phase.phase) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return phase.problem === null
        ? `Update ${phase.version} ready to download`
        : `Download failed for ${phase.version}. Click to retry.`
    case 'downloading':
      return `Downloading update (${phase.percent}%)`
    case 'downloaded':
      return phase.problem === null
        ? `Update ${phase.version} downloaded. Click to restart and install.`
        : `Install failed for ${phase.version}. Click to retry.`
    case 'unsupported':
      return UPDATES_UNSUPPORTED_MESSAGE
    default:
      return 'Check for updates'
  }
}

/** The question asked before restarting into the installer for `version`. */
export function installConfirmation(version: string): { readonly title: string; readonly description: string } {
  return {
    title: `Install update ${version} and restart Sotto?`,
    description: 'Any dictation or agent work in progress will be interrupted. Make sure you are ready before continuing.',
  }
}

/** The sentence for a toast after an action could not be completed, from the phase that carries it. */
export function updateProblem(status: UpdateStatus | null): string | null {
  const phase = status?.phase
  if (phase === undefined) return null
  if (phase.phase === 'available' || phase.phase === 'downloaded' || phase.phase === 'failed') return phase.problem
  return null
}
