import React, { type ReactNode } from 'react'
import { Check, Download, RefreshCw, RotateCw } from 'lucide-react'

import type { UpdateStatus } from '../../../../shared/contracts'
import { updateAction, updateIconState, updateTooltip, type UpdateAction } from './updateControlLogic'

const RING_RADIUS = 14
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export interface UpdateControlProps {
  readonly status: UpdateStatus | null
  /** True while a press is still being answered, so a second press cannot overlap it. */
  readonly busy: boolean
  readonly onActivate: (action: Exclude<UpdateAction, 'none'>) => void
}

/**
 * The one place update state lives in the window: a small round button at the
 * end of the footer. Idle it offers a check; once a release is found it wears
 * the download glyph, a progress ring while the installer downloads, and a
 * restart glyph once it is on disk. Its name says exactly what a press does.
 */
export function UpdateControl({ status, busy, onActivate }: UpdateControlProps): ReactNode {
  const action = updateAction(status)
  const icon = updateIconState(status)
  const tooltip = updateTooltip(status)
  const percent = status?.phase.phase === 'downloading' ? status.phase.percent : null
  const enabledAction = busy || action === 'none' ? null : action

  return (
    <button
      type="button"
      className="update-control tt-focusable"
      data-state={icon}
      aria-label={tooltip}
      title={tooltip}
      aria-disabled={enabledAction === null || undefined}
      onClick={() => { if (enabledAction !== null) onActivate(enabledAction) }}
    >
      {icon === 'downloading' ? (
        <svg className="update-control__ring" viewBox="0 0 32 32" aria-hidden="true">
          <circle className="update-control__ring-track" cx="16" cy="16" r={RING_RADIUS} />
          <circle
            className="update-control__ring-value"
            cx="16"
            cy="16"
            r={RING_RADIUS}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - (percent ?? 0) / 100)}
          />
        </svg>
      ) : null}
      <span className="update-control__glyph">
        {icon === 'downloaded' ? <RotateCw size={15} aria-hidden="true" />
          : icon === 'available' || icon === 'downloading' ? <Download size={15} aria-hidden="true" />
          : <RefreshCw size={15} aria-hidden="true" />}
        {icon === 'available' ? <span className="update-control__dot" aria-hidden="true" /> : null}
        {icon === 'downloaded' ? <span className="update-control__badge" aria-hidden="true"><Check size={8} strokeWidth={3} /></span> : null}
      </span>
    </button>
  )
}
