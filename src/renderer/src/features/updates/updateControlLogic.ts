import { t } from '@lingui/core/macro'

import type { UpdateStatus } from '../../../../shared/contracts'

/** What pressing the footer's update control would do right now. */
export type UpdateAction = 'check' | 'download' | 'install' | 'none'

/** The glyph the control wears; `checking` and `downloading` also animate. */
export type UpdateIconState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded'

/** Where updates do run, for a build that cannot update itself (ADR-0093), in the interface language. */
export function updatesUnsupportedMessage(): string {
  return t`Update checks run in the installed Windows app and in Sotto Owl on a Mac.`
}

/** The same sentence in English, for Settings until it reads `updatesUnsupportedMessage`. */
export const UPDATES_UNSUPPORTED_MESSAGE = 'Update checks run in the installed Windows app and in Sotto Owl on a Mac.'

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
  if (status === null) return t`Check for updates`
  const phase = status.phase
  switch (phase.phase) {
    case 'checking':
      return t`Checking for updates…`
    case 'available': {
      const version = phase.version
      return phase.problem === null
        ? t`Update ${version} ready to download`
        : phase.failedStep === 'download'
          ? t`Download failed for ${version}. Click to retry.`
          : t`Update check failed. Update ${version} is still offered. Click to download.`
    }
    case 'downloading': {
      const percent = phase.percent
      return t`Downloading update (${percent}%)`
    }
    case 'downloaded': {
      const version = phase.version
      return phase.problem === null
        ? t`Update ${version} downloaded. Click to restart and install.`
        : t`Install failed for ${version}. Click to retry.`
    }
    case 'unsupported':
      return updatesUnsupportedMessage()
    default:
      return t`Check for updates`
  }
}

/** The question asked before restarting into the installer for `version`. */
export function installConfirmation(version: string): { readonly title: string; readonly description: string } {
  return {
    title: t`Install update ${version} and restart Sotto?`,
    description: t`Any dictation or agent work in progress will be interrupted. Make sure you are ready before continuing.`,
  }
}

/** The sentence for a toast after an action could not be completed, from the phase that carries it. */
export function updateProblem(status: UpdateStatus | null): string | null {
  const phase = status?.phase
  if (phase === undefined) return null
  if (phase.phase === 'available' || phase.phase === 'downloaded' || phase.phase === 'failed') return phase.problem
  return null
}
