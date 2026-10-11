import React, { type CSSProperties, type ReactNode } from 'react'

import './owlSky.css'

/**
 * Where a star sits across the header. `left` is pixels from the tile's side of the sidebar, `right` pixels from
 * the toolbar's end, and `between` a share of the open sky between the tile (it ends 40 pixels in) and the toolbar
 * (it starts 158 pixels from the right), so a wider or narrower sidebar keeps the same scatter.
 */
type Anchor = { readonly left: number } | { readonly right: number } | { readonly between: number }

export interface OwlSkyStar {
  readonly at: Anchor
  /** Pixels from the top of the sidebar to the star's top edge. */
  readonly top: number
  /** Diameter in pixels before the mode's scale (light mode draws the stars a little larger). */
  readonly size: number
  /** 1 is the brightest and 4 the faintest; light mode drops tier 4. */
  readonly tier: 1 | 2 | 3 | 4
  /** In the theme's accent rather than the sidebar's text colour. */
  readonly accent?: true
  /** Which of the four slow cycles the star dims on, when it twinkles. */
  readonly twinkle?: 1 | 2 | 3 | 4
}

/**
 * The stars Zach placed on the header in the prototype he picked (October 10, 2026), read off his screenshot of a
 * 260-pixel sidebar. None sits on the tile, an icon or the search field: the ones by the toolbar are in its buttons'
 * empty corners or just above and below them.
 */
export const OWL_SKY_STARS: readonly OwlSkyStar[] = [
  { at: { left: 51 }, top: 10, size: 1.25, tier: 2, twinkle: 1 },
  { at: { left: 90 }, top: 17, size: 1.6, tier: 1 },
  { at: { left: 67 }, top: 29, size: 1, tier: 4 },
  { at: { left: 37 }, top: 38.5, size: 1, tier: 3, accent: true },
  { at: { between: 0.62 }, top: 8, size: 1, tier: 4 },
  { at: { between: 0.86 }, top: 31, size: 1.25, tier: 3, accent: true, twinkle: 2 },
  { at: { between: 0.5 }, top: 40, size: 1, tier: 4 },
  { at: { right: 10 }, top: 39.5, size: 1.1, tier: 3, twinkle: 3 },
  { at: { right: 51 }, top: 5.5, size: 1, tier: 4, twinkle: 4 },
  { at: { right: 8 }, top: 20, size: 1, tier: 3 },
  { at: { right: 87 }, top: 32.5, size: 1, tier: 3, accent: true },
]

/** The open sky between the tile and the toolbar: on macOS it closes on a narrow sidebar, and its stars go with it. */
function inOpenSky({ at }: OwlSkyStar): boolean {
  return 'between' in at || ('left' in at && at.left >= 40)
}

function place({ at, top, size }: OwlSkyStar): CSSProperties {
  const across: CSSProperties = 'left' in at ? { left: `calc(var(--owl-sky-inset) + ${at.left}px)` }
    : 'right' in at ? { right: `${at.right}px` }
    : { left: `calc(var(--owl-sky-inset) + 40px + (100% - 198px - var(--owl-sky-inset)) * ${at.between})` }
  return { ...across, top: `${top}px`, ...{ '--owl-star-size': `${size}px` } as CSSProperties }
}

/**
 * Sotto Owl's night sky behind the sidebar header: a scatter of tiny stars and the accent's glow behind the tile,
 * over the night the sidebar paints there (`data-sky`). It is decoration: hidden from assistive technology, under
 * every control, and never the target of a press.
 */
export function OwlSky(): ReactNode {
  return <div className="thread-nav__sky" aria-hidden="true">
    {OWL_SKY_STARS.map((star, index) => <i key={index} className="thread-nav__star" data-tier={star.tier}
      data-ink={star.accent ? 'accent' : undefined} data-twinkle={star.twinkle} data-open-sky={inOpenSky(star) || undefined} style={place(star)} />)}
  </div>
}
