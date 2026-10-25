import React, { type ReactNode } from 'react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import type { SottoPlatform } from '../../../shared/platform'
import type { SystemSettingsPane } from '../../../shared/systemSettings'
import { Button, type ButtonVariant } from './Button'

// The panes' names as macOS writes them in the user's language.
const PANE_NAMES: Readonly<Record<SystemSettingsPane, MessageDescriptor>> = Object.freeze({
  microphone: msg({ message: 'Microphone', comment: 'The macOS Privacy & Security pane, as System Settings names it' }),
  accessibility: msg({ message: 'Accessibility', comment: 'The macOS Privacy & Security pane, as System Settings names it' }),
  automation: msg({ message: 'Automation', comment: 'The macOS Privacy & Security pane, as System Settings names it' }),
  'input-monitoring': msg({ message: 'Input Monitoring', comment: 'The macOS Privacy & Security pane, as System Settings names it' }),
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
  const { t, i18n } = useLingui()
  const open = window.sotto?.openSystemSettings
  if (platform !== 'darwin' || open === undefined) return null
  const paneName = i18n._(PANE_NAMES[pane])
  const label = t`Open System Settings at Privacy & Security, ${paneName}`
  const onClick = (): void => { void open(pane).catch(() => undefined) }
  if (appearance === 'toast') {
    return <button type="button" className="tt-toast__link tt-focusable" aria-label={label} onClick={onClick}><Trans>Open System Settings</Trans></button>
  }
  return <Button variant={appearance} aria-label={label} onClick={onClick}><Trans>Open System Settings</Trans></Button>
}
