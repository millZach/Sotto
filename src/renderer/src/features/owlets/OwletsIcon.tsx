import React, { type ReactNode } from 'react'

/**
 * The Owlets room's icon: two small owls on a branch, as the sidebar look drew it (docs/prototypes/owlets-sidebar/).
 * Drawn as the switch's other icons are, in the colour of whatever holds it. The owlet's own mark is still to be drawn
 * (ADR-0210); this stands only for the room.
 */
export function OwletsIcon({ size = 16 }: { readonly size?: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="8.5" cy="10" r="5" />
    <path d="M6.8 9.6h.01M10.2 9.6h.01" strokeWidth={2.4} />
    <circle cx="16.8" cy="12.5" r="3.6" />
    <path d="M15.6 12.2h.01M18 12.2h.01" />
    <path d="M3 19.5h18" />
  </svg>
}
