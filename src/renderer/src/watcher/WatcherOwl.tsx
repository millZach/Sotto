import React, { type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import './watcher.css'

/** The owl alone, simplified for 16 pixels as build/tray-template.svg draws it: no beak, larger pupils, eyes cut through. */
const OWL =
  'M1.27 4.8C0.84 3.93 0.73 2.31 1.49 1.22C1.63 0.95 1.93 0.68 2.06 1.22C2.12 2.03 2.71 2.9 3.93 2.9C5.83 2.2 10.17 1.76 12.94 3.34C13.69 3.28 14.4 2.71 14.45 1.82C14.51 1.57 14.73 1.57 14.83 1.98C15.32 2.58 15.54 4.26 14.94 5.56C15.38 6.1 15.7 7.46 15.7 9.63C15.76 12.12 15.29 13.37 13.97 14.24C12.75 15.19 10.17 15.24 8 15.24C5.8 15.24 3.23 15.19 2.01 14.24C0.68 13.37 0.22 12.12 0.27 9.63C0.24 7.19 0.52 5.83 1.27 4.8Z'
  + 'M1.84 8.95C1.82 7.05 2.25 6.07 3.66 6.07C5.34 6.02 6.75 6.21 6.73 8.54C6.73 10.44 6.1 11.31 4.34 11.31C2.58 11.34 1.82 10.58 1.84 8.95Z'
  + 'M9.33 9.22C9.33 8.14 9.63 7.67 10.44 7.46L13.1 6.92C13.8 6.78 14.13 7.46 14.13 8.81C14.16 10.71 13.69 11.34 11.66 11.34C10.17 11.34 9.33 10.71 9.33 9.22Z'

/** The English of `watchedByWatcher()`, for the Threads sidebar until its words move to the interface catalogs. */
export const WATCHED_BY_WATCHER = 'Watched by Watcher'
/** What Watcher's owl beside a thread means, in the interface language. */
export const watchedByWatcher = (): string => i18n._(msg`Watched by Watcher`)

/** Watcher's owl in the colour of whatever holds it. It names nothing; its holder says what it stands for. */
export function WatcherOwl({ size = 16, className }: { readonly size?: number; readonly className?: string | undefined }): ReactNode {
  return <svg className={className ? `watcher-owl ${className}` : 'watcher-owl'} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d={OWL} fillRule="evenodd" />
    <circle cx="5.29" cy="8.22" r="1.19" />
    <circle cx="10.79" cy="8.87" r="1.19" />
  </svg>
}

/**
 * The owl right after a watched thread's provider logo, at the logo's own size and in its holder's muted text
 * colour. An image, never a control: hovering it says what it means, and so does a screen reader.
 */
export function WatchedBadge({ size = 14 }: { readonly size?: number }): ReactNode {
  const { t } = useLingui()
  const watched = t`Watched by Watcher`
  return <span className="watched-badge" role="img" aria-label={watched} title={watched}><WatcherOwl size={size} /></span>
}
