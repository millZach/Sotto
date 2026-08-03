import React, { type ReactNode } from 'react'

import { formatAccelerator, type AcceleratorStyle } from '../../../shared/accelerator'
import type { SottoPlatform } from '../../../shared/platform'

export interface ShortcutKeyProps {
  readonly accelerator: string
  readonly platform: SottoPlatform
}

export function ShortcutKey({ accelerator, platform }: ShortcutKeyProps): ReactNode {
  const tokens = (style: AcceleratorStyle): string[] =>
    formatAccelerator(accelerator, platform, style)
      .split('+')
      .map((key) => key.trim())
      .filter(Boolean)

  const keys = tokens('display')
  // macOS renders ⌘⇧Space as adjacent glyph chips with no separators, so the
  // label spells the same chord out in words for anyone who cannot see them.
  const separated = platform !== 'darwin'
  const label = (separated ? keys : tokens('editing')).join('+')

  return (
    <span className="tt-shortcut" aria-label={label}>
      {keys.map((key, index) => (
        <span key={`${key}-${index}`}>
          {index === 0 || !separated ? null : <span aria-hidden="true">+</span>}
          <kbd>{key}</kbd>
        </span>
      ))}
    </span>
  )
}
