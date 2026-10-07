import React, { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useReducedMotion } from '../../state/reducedMotion'

/** How long one picture takes to fade into the next. The stylesheet reads it as `--diagram-fade`. */
export const CROSS_FADE_MS = 180
/** How long past the fade the leaving picture stays when its animation does not report its end. */
const FADE_GRACE_MS = 120

interface DiagramImageProps {
  readonly src: string
  /** The drawing's accessible name; empty for a picture kept out of the accessibility tree. */
  readonly alt: string
  readonly width: number
  readonly height: number
  readonly describedBy?: string | undefined
  readonly hidden?: boolean
  readonly layer?: 'shown' | 'arriving' | 'leaving'
  readonly onAnimationEnd?: (() => void) | undefined
  /** Where the image is placed, for the expanded viewer, which zooms and pans it. */
  readonly className?: string
  readonly style?: CSSProperties
}

/**
 * One drawing as an image: never dragged, decoded off the main thread. Every diagram image is this: an answer's, a
 * visual's step pictures, and the expanded viewer's.
 */
export function DiagramImage({ src, alt, width, height, describedBy, hidden, layer, onAnimationEnd, className, style }: DiagramImageProps): ReactNode {
  return <img src={src} alt={alt} width={width} height={height} draggable={false} decoding="async" aria-describedby={describedBy}
    aria-hidden={hidden || undefined} data-layer={layer} onAnimationEnd={onAnimationEnd} className={className} style={style} />
}

interface Layer { readonly src: string; readonly key: number }

/**
 * One picture that cross-fades to the next when `src` changes: the old one fades out under the new one fading in,
 * because a drawing's background is transparent and the old one would show through. Every picture it is given has the
 * same size, so nothing moves. Under reduced motion the new picture replaces the old at once. Only the picture on top
 * is in the accessibility tree. `className` lays the pictures over each other.
 */
export function CrossFadeImage({ src, alt, width, height, describedBy, className }: Omit<DiagramImageProps, 'hidden' | 'layer' | 'onAnimationEnd' | 'className' | 'style'> & {
  readonly className: string
}): ReactNode {
  const reduced = useReducedMotion()
  const [layers, setLayers] = useState<readonly Layer[]>(() => [{ src, key: 0 }])
  const top = layers[layers.length - 1]!
  if (top.src !== src) {
    const next = { src, key: top.key + 1 }
    setLayers(reduced ? [next] : [top, next])
  }
  const fading = layers.length > 1
  const settle = (): void => setLayers(current => current.slice(-1))
  useEffect(() => {
    if (!fading) return
    const timer = window.setTimeout(settle, CROSS_FADE_MS + FADE_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [fading, layers])
  useEffect(() => { if (reduced) setLayers(current => current.length > 1 ? current.slice(-1) : current) }, [reduced])

  return <span className={className} style={{ '--diagram-fade': `${CROSS_FADE_MS}ms` } as CSSProperties}>
    {layers.map((layer, index) => {
      const shown = index === layers.length - 1
      return <DiagramImage key={layer.key} src={layer.src} alt={shown ? alt : ''} hidden={!shown} width={width} height={height}
        describedBy={shown ? describedBy : undefined} layer={shown ? (fading ? 'arriving' : 'shown') : 'leaving'}
        onAnimationEnd={shown && fading ? settle : undefined} />
    })}
  </span>
}
