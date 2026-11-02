import React, { useId, type CSSProperties, type ReactNode } from 'react'

import { mixRgb, parseThemeRgb, rgbToHex } from '../../../shared/themes/color'
import { OWL_BEAK, OWL_EYE_LEFT, OWL_EYE_RIGHT, OWL_HEAD, OWL_PUPILS, OWL_PUPIL_RADIUS, bareOwlFill, rootSurface } from '../components/SottoMark'
import { useThemeBrand } from '../components/useThemeBrand'

const WHITE = { r: 255, g: 255, b: 255 }
/** Each eye's socket: its outline, resting pupil, top, bottom and middle, and which side of the face it is on. */
const EYES = [
  { path: OWL_EYE_LEFT, pupil: OWL_PUPILS[0], top: 39.2, bottom: 62.8, middle: 31.56, side: -1 },
  { path: OWL_EYE_RIGHT, pupil: OWL_PUPILS[1], top: 43, bottom: 62.8, middle: 64.56, side: 1 },
] as const

/**
 * The widget's living owl (ADR-0178), an Owl feature. It is the tile-less mark
 * drawn in parts, so the stylesheet can move it: the shell's status and
 * speaking attributes choose what it does, and every movement is a CSS
 * animation or transition, so nothing here runs on a timer.
 */
export function WidgetOwl({ className }: { readonly className?: string }): ReactNode {
  const brand = useThemeBrand()
  // React 19's ids hold no colons, so they work inside url(#…).
  const id = useId()
  const tile = bareOwlFill(brand, rootSurface())
  const lit = rgbToHex(mixRgb(parseThemeRgb(tile, WHITE), WHITE, 0.55))
  return (
    <svg className={className} aria-hidden="true" viewBox="8 12 80 72" data-tile={brand.tile} data-glyph={brand.glyph} data-fill={tile} data-living="">
      <defs>
        {/* The head's holes. Happy eyes close: their holes fade and an upturned arch is cut instead. */}
        <mask id={`${id}-holes`} maskUnits="userSpaceOnUse" x="0" y="0" width="96" height="96">
          <rect width="96" height="96" fill="#fff" />
          {EYES.map(eye => <path key={eye.path} className="widget-owl__hole" d={eye.path} fill="#000" />)}
          {EYES.map(({ middle: x, top, bottom }) => {
            const y = (top + bottom) / 2
            return <path key={x} className="widget-owl__happy" d={`M${x - 7} ${y + 3}Q${x} ${y - 7} ${x + 7} ${y + 3}`} fill="none" stroke="#000" strokeWidth="3.8" strokeLinecap="round" />
          })}
          <path d={OWL_BEAK} fill="#000" />
        </mask>
        {EYES.map((eye, index) => <clipPath key={eye.path} id={`${id}-eye${index}`}><path d={eye.path} /></clipPath>)}
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor={lit} stopOpacity="0.9" />
          <stop offset="1" stopColor={tile} stopOpacity="0.12" />
        </radialGradient>
      </defs>
      <g className="widget-owl__pose">
        <g className="widget-owl__tilt">
          <g className="widget-owl__hop">
            <g className="widget-owl__bob">
              <g className="widget-owl__breath">
                <path d={OWL_HEAD} fill={tile} mask={`url(#${id}-holes)`} />
                {EYES.map(({ path, pupil: [x, y], top, bottom, side }, index) => (
                  <g key={path} className="widget-owl__eye" clipPath={`url(#${id}-eye${index})`}>
                    <circle className="widget-owl__glow" cx={x} cy={y} r="13" fill={`url(#${id}-glow)`} />
                    <g className="widget-owl__pupil">
                      <circle cx={x} cy={y} r={OWL_PUPIL_RADIUS} fill={tile} />
                      <circle className="widget-owl__pupil-lit" cx={x} cy={y} r={OWL_PUPIL_RADIUS * 1.3} fill={lit} />
                    </g>
                    <rect className="widget-owl__lid" x={x - 30} y={top - 2} width="60" height={bottom - top + 4} fill={tile} />
                    {/* A sad lid, its inner end higher, rests above the eye until something goes wrong. */}
                    <rect
                      className="widget-owl__sad"
                      x={x - 30} y={top - 30} width="60" height="30" fill={tile}
                      style={{ '--owl-eye': `${x}px ${(top + bottom) / 2}px`, '--owl-sad': `${side * 18}deg`, '--owl-drop': `${(bottom - top) * 0.3 + 2}px` } as CSSProperties}
                    />
                  </g>
                ))}
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  )
}
