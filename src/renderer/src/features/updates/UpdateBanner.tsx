import React, { useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

import type { UpdateStatus } from '../../../../shared/contracts'
import { Button } from '../../components/Button'

export interface UpdateBannerProps {
  readonly status: UpdateStatus
  readonly onDownload: () => Promise<boolean>
  readonly onInstall: () => Promise<boolean>
  readonly onDismiss: () => void
}

/**
 * A single quiet strip above whichever view is open — never a modal, never the
 * floating widget. It says what is available, offers one action, and can be
 * waved away; nothing here interrupts or blocks a dictation in progress.
 */
export function UpdateBanner({
  status,
  onDownload,
  onInstall,
  onDismiss,
}: UpdateBannerProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const phase = status.phase
  if (phase.phase !== 'available' && phase.phase !== 'downloading' && phase.phase !== 'downloaded') {
    return null
  }

  const run = async (operation: () => Promise<boolean>): Promise<void> => {
    setBusy(true)
    try {
      await operation()
    } finally {
      setBusy(false)
    }
  }

  // Ember is reserved for something having succeeded; an offer is only news.
  const tone = phase.phase === 'downloaded' ? 'ready' : 'offer'

  return (
    <aside className="update-banner" data-tone={tone} role="status" aria-live="polite">
      <span className="update-banner__mark" aria-hidden="true" />
      <div className="update-banner__body">
        {phase.phase === 'available' ? (
          <>
            <p className="update-banner__title">Sotto {phase.version} is available</p>
            <p className="update-banner__detail">
              You are running {status.currentVersion}. Sotto downloads it here, and only when you say so.
            </p>
          </>
        ) : null}
        {phase.phase === 'downloading' ? (
          <>
            <p className="update-banner__title">Downloading Sotto {phase.version}</p>
            <p className="update-banner__detail">{phase.percent}% — keep dictating, this runs in the background.</p>
            <div
              className="update-banner__progress"
              role="progressbar"
              aria-label={`Downloading Sotto ${phase.version}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={phase.percent}
            >
              <span style={{ width: `${phase.percent}%` }} />
            </div>
          </>
        ) : null}
        {phase.phase === 'downloaded' ? (
          <>
            <p className="update-banner__title">Sotto {phase.version} is ready to install</p>
            <p className="update-banner__detail">
              Restart now, or Sotto installs it the next time you quit.
            </p>
          </>
        ) : null}
      </div>
      <div className="update-banner__actions">
        {phase.phase === 'available' ? (
          <Button variant="secondary" disabled={busy} onClick={() => void run(onDownload)}>
            {busy ? 'Starting...' : 'Download'}
          </Button>
        ) : null}
        {phase.phase === 'downloaded' ? (
          <Button variant="secondary" disabled={busy} onClick={() => void run(onInstall)}>
            Restart to update
          </Button>
        ) : null}
        <Button variant="ghost" iconOnly aria-label="Dismiss update notice" onClick={onDismiss}>
          <X size={15} aria-hidden="true" />
        </Button>
      </div>
    </aside>
  )
}
