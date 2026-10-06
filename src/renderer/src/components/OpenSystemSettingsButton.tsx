import React, { type ReactNode } from 'react'

import type { SottoPlatform } from '../../../shared/platform'
import type { SystemSettingsPane } from '../../../shared/systemSettings'
import { Button, type ButtonVariant } from './Button'

const PANE_NAMES: Readonly<Record<SystemSettingsPane, string>> = Object.freeze({
  microphone: 'Microphone',
  accessibility: 'Accessibility',
  automation: 'Automation',
})

export interface OpenSystemSettingsButtonProps {
  readonly platform: SottoPlatform
  readonly pane: SystemSettingsPane
  /** A toast renders it as an inline link; a page renders it as a button. */
  readonly appearance?: 'toast' | ButtonVariant
}

/**
 * Takes the user to the macOS Privacy & Security pane that holds a permission
 * Sotto needs. Nothing renders off macOS, or when the bridge cannot open it.
 */
export function OpenSystemSettingsButton({ platform, pane, appearance = 'secondary' }: OpenSystemSettingsButtonProps): ReactNode {
  const open = window.sotto?.openSystemSettings
  if (platform !== 'darwin' || open === undefined) return null
  const label = `Open System Settings at Privacy & Security, ${PANE_NAMES[pane]}`
  const onClick = (): void => { void open(pane).catch(() => undefined) }
  if (appearance === 'toast') {
    return <button type="button" className="tt-toast__link tt-focusable" aria-label={label} onClick={onClick}>Open System Settings</button>
  }
  return <Button variant={appearance} aria-label={label} onClick={onClick}>Open System Settings</Button>
}
