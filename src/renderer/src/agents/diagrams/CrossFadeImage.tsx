import React, { useEffect, useState, type ReactNode } from 'react'
import { useReducedMotion } from '../../state/reducedMotion'

/** How long one picture takes to fade into the next. The stylesheet's animations match it. */
export const CROSS_FADE_MS = 180

interface Layer { readonly src: string; readonly key: number }

/**
 * One picture that cross-fades to the next when `src` changes: the old one fades out under the new one fading in,
 * because a drawing's background is transparent and the old one would show through. Every picture it is given has the
 * same size, so nothing moves. Under reduced motion the new picture replaces the old at once. Only the picture on top
 * is in the accessibility tree.
 */
export function CrossFadeImage({ src, alt, width, height, describedBy, className }: {
  readonly src: string; readonly alt: string; readonly width: number; readonly height: number; readonly describedBy?: string | undefined; readonly className: string
}): ReactNode {
  const reduced = useReducedMotion()
  const [layers, setLayers] = useState<readonly Layer[]>(() => [{ src, key: 0 }])
  const top = layers[layers.length - 1]!
  if (top.src !== src) {
    const next = { src, key: top.key + 1 }
    setLayers(reduced ? [next] : [top, next])
  }
  const fading = layers.length > 1
  // The leaving picture goes once the fade is over, whether or not its animation reported the end.
  useEffect(() => {
    if (!fading) return
    const timer = window.setTimeout(() => setLayers(current => current.slice(-1)), CROSS_FADE_MS + 120)
    return () => window.clearTimeout(timer)
  }, [fading, layers])
  useEffect(() => { if (reduced) setLayers(current => current.length > 1 ? current.slice(-1) : current) }, [reduced])

  return <span className={className} data-fading={fading || undefined}>
    {layers.map((layer, index) => {
      const shown = index === layers.length - 1
      return <img key={layer.key} src={layer.src} alt={shown ? alt : ''} aria-hidden={shown ? undefined : true}
        width={width} height={height} draggable={false} aria-describedby={shown ? describedBy : undefined}
        data-layer={shown ? (fading ? 'arriving' : 'shown') : 'leaving'}
        onAnimationEnd={shown && fading ? () => setLayers(current => current.slice(-1)) : undefined} />
    })}
  </span>
}
