import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { AgentMediaCallout } from '../../../shared/agentActivity'
import { themeColours, type MarkupSize } from './markup'

/**
 * Callouts (ADR-0170, part 6): the numbered boxes with notes an agent placed on a picture it showed. Each is a dashed box
 * in the theme's accent with a pin at its top left that carries its number, drawn the same way on a tile, in the viewer,
 * in the mark-up editor and on a marked copy that keeps them.
 */

/** How a callout is drawn on a picture of `size`, in the picture's own pixels. */
export interface CalloutGeometry {
  readonly x: number; readonly y: number; readonly width: number; readonly height: number
  readonly line: number; readonly dash: readonly [number, number]; readonly corner: number
  /** The pin's radius and the size its number is set in. */
  readonly radius: number; readonly font: number
}

/**
 * Where a callout's box and pin go. `unit`, the picture's pixels to one of the screen's, keeps the line and pin a
 * fixed size on screen, as on a small tile; without it they are a share of the picture, as on the copy.
 */
export function calloutGeometry(callout: AgentMediaCallout, size: MarkupSize, unit?: number): CalloutGeometry {
  const longer = Math.max(size.width, size.height)
  const line = unit ? 1.5 * unit : longer / 260, radius = unit ? 8 * unit : longer / 55
  return { x: callout.x * size.width, y: callout.y * size.height, width: callout.w * size.width, height: callout.h * size.height,
    line, dash: [line * 3, line * 2], corner: line * 2, radius, font: radius * 1.1 }
}

/** The callouts over a picture, as SVG in its pixels: the SVG's viewBox is the picture's size. */
export function CalloutLayer({ callouts, size, unit }: { readonly callouts: readonly AgentMediaCallout[]; readonly size: MarkupSize; readonly unit?: number | undefined }): ReactNode {
  return <g className="callouts">{callouts.map(callout => {
    const shape = calloutGeometry(callout, size, unit)
    return <g key={callout.n} data-callout={callout.n}>
      <rect className="callouts__box" x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.corner}
        strokeWidth={shape.line} strokeDasharray={shape.dash.join(' ')} />
      <circle className="callouts__pin" cx={shape.x} cy={shape.y} r={shape.radius} />
      <text className="callouts__number" x={shape.x} y={shape.y} fontSize={shape.font} textAnchor="middle" dominantBaseline="central">{callout.n}</text>
    </g>
  })}</g>
}

/** The theme's accent and the colour that reads on it, as a canvas paints them. */
export interface CalloutColours { readonly accent: string; readonly onAccent: string }
export function calloutColours(host: Element): CalloutColours {
  const [accent, onAccent] = themeColours(host, ['--tt-accent', '--tt-on-accent']) as [string, string]
  return { accent, onAccent }
}

/** Draws the callouts on a canvas the picture's size, as the editor showed them: for a marked copy that keeps them. */
export function drawCallouts(context: CanvasRenderingContext2D, callouts: readonly AgentMediaCallout[], size: MarkupSize, colours: CalloutColours): void {
  for (const callout of callouts) {
    const shape = calloutGeometry(callout, size)
    context.save()
    context.strokeStyle = colours.accent; context.lineWidth = shape.line; context.setLineDash([...shape.dash])
    context.beginPath(); context.roundRect(shape.x, shape.y, shape.width, shape.height, shape.corner); context.stroke()
    context.setLineDash([])
    context.fillStyle = colours.accent
    context.beginPath(); context.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2); context.fill()
    context.fillStyle = colours.onAccent; context.font = `700 ${shape.font}px Figtree, system-ui, sans-serif`
    context.textAlign = 'center'; context.textBaseline = 'middle'
    context.fillText(String(callout.n), shape.x, shape.y)
    context.restore()
  }
}

/** The callouts' notes, numbered as on the picture: the list beside it in the viewer and the editor. */
export function CalloutNotes({ callouts }: { readonly callouts: readonly AgentMediaCallout[] }): ReactNode {
  return <ol className="callout-notes">{callouts.map(callout => <li key={callout.n}>
    <span className="callout-notes__number" aria-hidden="true">{callout.n}</span>
    <span className="callout-notes__note tt-paragraph">{callout.note}</span>
  </li>)}</ol>
}
/** "Callouts from Codex": the heading over a picture's callouts in the viewer and the editor. */
export function useCalloutsHeading(): (by: string | undefined) => string {
  const { t } = useLingui()
  return by => by ? t({ message: `Callouts from ${by}`, comment: '{by} is who placed the numbered boxes on a picture: a provider, such as Codex, or Watcher.' }) : t`Callouts`
}
