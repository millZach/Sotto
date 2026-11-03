import React, { type ReactNode } from 'react'

const SIZE = 18
const inDisc = (x: number, y: number, cx: number, cy: number, r: number): boolean => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r

/**
 * The crescent of the menu bar owl (ADR-0137, `scripts/lib/trayOwlDraw.mjs`): a disc with a smaller one taken from its
 * upper right, on an 18 by 18 grid with no anti-aliasing. Worked out once, as runs of pixels along each row.
 */
const CRESCENT: readonly { readonly x: number; readonly y: number; readonly w: number }[] = (() => {
  const runs: { x: number; y: number; w: number }[] = []
  for (let y = 0; y < SIZE; y++) {
    let start = -1
    for (let x = 0; x <= SIZE; x++) {
      const on = x < SIZE && inDisc(x, y, 9, 9.5, 8) && !inDisc(x, y, 12.6, 7.4, 6.6)
      if (on && start < 0) start = x
      if (!on && start >= 0) { runs.push({ x: start, y, w: x - start }); start = -1 }
    }
  }
  return runs
})()

/**
 * The owl that marks the popup (ADR-0181): the night moon with its two eyes and a star, drawn in the theme's colours.
 * While a turn runs its eyes light, glance and blink and the star flickers; at rest, and under reduced motion, it holds
 * still. It is decoration: the status line beside the conversation says what is happening.
 */
export function PopupOwl({ working }: { readonly working: boolean }): ReactNode {
  return (
    <svg className={`popup-owl${working ? ' is-working' : ''}`} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      <g className="popup-owl__moon">{CRESCENT.map(run => <rect key={`${run.x}-${run.y}`} x={run.x} y={run.y} width={run.w} height={1} />)}</g>
      <rect className="popup-owl__star" x={16} y={2} width={1} height={1} />
      <g className="popup-owl__eyes">
        <rect x={10} y={8} width={2} height={2} />
        <rect x={14} y={8} width={2} height={2} />
      </g>
    </svg>
  )
}
