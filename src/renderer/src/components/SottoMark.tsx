import React, { type ReactNode } from 'react'

export interface SottoMarkProps {
  /** Sizing hook; the mark has no intrinsic size of its own. */
  readonly className?: string | undefined
}

/**
 * The Sotto mark, kept byte-for-byte in step with build/icon.svg so every
 * in-app appearance matches the packaged application icon. The gradient id is
 * scoped per instance because several marks can share one document, and React
 * ids carry colons that are illegal in SVG fragment references.
 */
export function SottoMark({ className }: SottoMarkProps): ReactNode {
  const gradientId = `sotto-mark-${React.useId().replaceAll(':', '')}`

  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 96 96">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#cf6c0d" />
          <stop offset="1" stopColor="#8f4404" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="22" fill={`url(#${gradientId})`} />
      <rect x="26" y="20" width="9" height="56" rx="4.5" fill="#ffffff" />
      <path
        d="M44 48c4.5-15 9-15 13.5 0s9 15 13.5 0"
        stroke="#ffffff"
        strokeWidth="7.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
