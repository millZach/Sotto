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

/** Where the tile ends and the open sky begins, in pixels from the tile's side of the sidebar. */
const TILE_END = 40
/** How far the toolbar reaches in from the sidebar's other end. */
const TOOLBAR_WIDTH = 158

/** The open sky between the tile and the toolbar: on macOS it closes on a narrow sidebar, and its stars go with it. */
function inOpenSky({ at }: Pick<OwlSkyStar, 'at'>): boolean {
  return 'between' in at || ('left' in at && at.left >= TILE_END)
}

function place({ at, top, size }: OwlSkyStar): CSSProperties {
  // A star in the open sky past the tile keeps its share of that sky when the sky narrows (macOS, owlSky.css).
  const across: CSSProperties = 'left' in at ? { left: inOpenSky({ at }) ? `calc(var(--owl-sky-inset) + ${TILE_END}px + ${at.left - TILE_END}px * var(--owl-open-sky-scale, 1))` : `calc(var(--owl-sky-inset) + ${at.left}px)` }
    : 'right' in at ? { right: `${at.right}px` }
    : { left: `calc(var(--owl-sky-inset) + ${TILE_END}px + (100% - ${TILE_END + TOOLBAR_WIDTH}px - var(--owl-sky-inset)) * ${at.between})` }
  return { ...across, top: `${top}px`, ...{ '--owl-star-size': `${size}px` } as CSSProperties }
}

/**
 * Sotto Owl's night sky behind the sidebar header: a scatter of tiny stars and the accent's glow behind the tile
 * (on macOS there is no tile in the corner and no glow), over the night the sidebar paints there (`data-sky`).
 * It is decoration: hidden from assistive technology, under every control, and never the target of a press.
 */
export function OwlSky(): ReactNode {
  return <div className="thread-nav__sky" aria-hidden="true">
    {OWL_SKY_STARS.map((star, index) => <i key={index} className="thread-nav__star" data-tier={star.tier}
      data-ink={star.accent ? 'accent' : undefined} data-twinkle={star.twinkle} data-open-sky={inOpenSky(star) || undefined} style={place(star)} />)}
  </div>
}

/** How wide the sidebar is where the room's stars are read from: the scatter keeps the places it has there. */
const ROOM_SKY_WIDTH = 320
/** Watcher's name sits where these two would, so in the room they step just above and below it. */
const ROOM_MOVES = new Map<number, { readonly left: number; readonly top: number }>([[1, { left: 96, top: 39.5 }], [2, { left: 70, top: 5 }]])

/** Pixels from the tile's side for a star anchored across a sidebar of the room's width. */
function roomLeft({ at, size }: OwlSkyStar): number {
  if ('left' in at) return at.left
  if ('right' in at) return ROOM_SKY_WIDTH - at.right - size
  return TILE_END + (ROOM_SKY_WIDTH - TILE_END - TOOLBAR_WIDTH) * at.between
}

/**
 * The same sky in Watcher's room, which has no sidebar (the no-sidebar mock-up Zach picked on October 11, 2026): the
 * tile keeps the window's top-left corner, and the night spreads across that corner of the room's header and fades
 * before the conversation. The eleven stars fall where they do on a 320-pixel sidebar, except the two Watcher's name
 * would cover. Decoration, like the sidebar's: hidden, under every control, never pressed.
 */
export function OwlRoomSky(): ReactNode {
  return <div className="watcher-room__sky" aria-hidden="true">
    <div className="watcher-room__stars">
      {OWL_SKY_STARS.map((star, index) => {
        const { left, top } = ROOM_MOVES.get(index) ?? { left: roomLeft(star), top: star.top }
        return <i key={index} className="thread-nav__star" data-tier={star.tier} data-ink={star.accent ? 'accent' : undefined} data-twinkle={star.twinkle}
          style={{ left: `calc(var(--owl-sky-inset) + ${left}px)`, top: `${top}px`, ...{ '--owl-star-size': `${star.size}px` } as CSSProperties }} />
      })}
    </div>
  </div>
}
