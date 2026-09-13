import React, { type ReactNode } from 'react'

import { useThemeBrand } from './useThemeBrand'

export interface SottoMarkProps {
  /** Sizing hook; the mark has no intrinsic size of its own. */
  readonly className?: string | undefined
}

/**
 * The Sotto mark. Its geometry is kept in step with build/icon.svg; its colours
 * follow the window's theme: the tile is the accent and the bar and wave take
 * a foreground that reads on it. The gradient id is scoped per instance because
 * several marks can share one document, and React ids carry colons that are
 * illegal in SVG fragment references.
 */
export function SottoMark({ className }: SottoMarkProps): ReactNode {
  const gradientId = `sotto-mark-${React.useId().replaceAll(':', '')}`
  const brand = useThemeBrand()

  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 96 96" data-tile={brand.tile} data-glyph={brand.glyph}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={brand.tile} />
          <stop offset="1" stopColor={brand.tile} />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="22" fill={`url(#${gradientId})`} />
      <rect x="26" y="20" width="9" height="56" rx="4.5" fill={brand.glyph} />
      <path
        d="M44 48c4.5-15 9-15 13.5 0s9 15 13.5 0"
        stroke={brand.glyph}
        strokeWidth="7.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
