import React, { type ReactNode } from 'react'

import { formatWindowsAccelerator } from '../../../shared/accelerator'

export interface ShortcutKeyProps {
  readonly accelerator: string
}

export function ShortcutKey({ accelerator }: ShortcutKeyProps): ReactNode {
  const keys = formatWindowsAccelerator(accelerator)
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean)
  const displayAccelerator = keys.join('+')
  return (
    <span className="tt-shortcut" aria-label={displayAccelerator}>
      {keys.map((key, index) => (
        <span key={`${key}-${index}`}>
          {index === 0 ? null : <span aria-hidden="true">+</span>}
          <kbd>{key}</kbd>
        </span>
      ))}
    </span>
  )
}
