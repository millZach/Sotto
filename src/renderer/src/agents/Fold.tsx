import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** How long a fold takes, the same as the chevron that turns with it. */
export const FOLD_MS = 160
/** Past this height there is too much to move, so it opens and folds at once. */
const TALLEST_PX = 1_200

const stillMotion = (): boolean => document.documentElement.dataset.reducedMotion === 'on' || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

/**
 * What a disclosure opens, sliding open and shut under its line. Its children are drawn only while it shows, or while it folds
 * shut, so a closed fold costs nothing. It starts as it is, without moving, so a thread opening with its steps open stays still;
 * only a change moves it, and not under reduced motion or off screen. While it folds, what it holds takes no focus.
 */
export function Fold({ open, children }: { readonly open: boolean; readonly children: ReactNode }): ReactNode {
  const [drawn, setDrawn] = useState(open)
  if (open && !drawn) setDrawn(true)
  const box = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(open)
  const moving = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    if (wasOpen.current === open) return
    wasOpen.current = open
    const element = box.current
    if (element === null) return
    // A fold that turns back part-way goes on from the height it has reached.
    const shown = moving.current === null && open ? 0 : element.getBoundingClientRect().height
    moving.current?.cancel()
    moving.current = null
    const settle = (): void => {
      moving.current = null
      element.style.overflow = ''
      element.inert = false
      if (!open) setDrawn(false)
    }
    const rect = element.getBoundingClientRect()
    const onScreen = rect.bottom > 0 && rect.top < window.innerHeight
    if (typeof element.animate !== 'function' || stillMotion() || !onScreen || Math.max(shown, rect.height) > TALLEST_PX) { settle(); return }
    element.style.overflow = 'hidden'
    element.inert = !open
    const end = open ? rect.height : 0
    const animation = element.animate(
      [{ height: `${shown}px`, opacity: rect.height ? shown / rect.height : 1 }, { height: `${end}px`, opacity: open ? 1 : 0 }],
      { duration: FOLD_MS, easing: 'cubic-bezier(.2, 0, 0, 1)' },
    )
    moving.current = animation
    animation.onfinish = settle
  }, [open])
  useEffect(() => () => moving.current?.cancel(), [])
  return drawn ? <div ref={box} className="thread-fold">{children}</div> : null
}
