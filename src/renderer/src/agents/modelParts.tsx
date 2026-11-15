import { plural, t } from '@lingui/core/macro'
import React, { useEffect, useState, type ReactNode } from 'react'
import type { Model3dView } from '../../../shared/models3d'

/**
 * What a 3D model's line in its thread, the 3D models page and Tools › 3D models say and show alike (ADR-0141; the
 * Meshy plan's tickets 4 and 5): the still picture, the ring while Meshy works, the step and the time left, the credits
 * and the files' sizes.
 */

/** The still picture, read once the 3D model is done, as an address the window may show. */
export function useStill(view: Pick<Model3dView, 'id' | 'state' | 'still'> | null | undefined): string | undefined {
  const [still, setStill] = useState<string>()
  const wanted = view?.state === 'done' && view.still ? `${view.id}/${view.still}` : undefined
  useEffect(() => {
    if (!wanted || !view) { setStill(undefined); return undefined }
    let live = true
    const type = /\.jpe?g$/iu.test(view.still ?? '') ? 'image/jpeg' : /\.webp$/iu.test(view.still ?? '') ? 'image/webp' : 'image/png'
    void window.sotto?.plugins?.model3dBytes({ id: view.id, part: 'still' }).then(bytes => { if (live) setStill(bytes ? `data:${type};base64,${base64(bytes)}` : undefined) }, () => undefined)
    return () => { live = false }
    // The picture is read again only when the 3D model or its picture changes, not on each of Meshy's reads.
  }, [wanted])
  return still
}

/** A ring that fills with Meshy's percent, or turns while there is none yet. */
export function Ring({ percent, spin, size = 26 }: { readonly percent: number | undefined; readonly spin: boolean; readonly size?: number }): ReactNode {
  const filled = percent === undefined ? 30 : percent
  return <svg className={percent === undefined && spin ? 'model-line__ring model-line__ring--spin' : 'model-line__ring'} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <circle className="model-line__ring-track" cx="12" cy="12" r="9" />
    <circle className="model-line__ring-fill" cx="12" cy="12" r="9" strokeDasharray={`${(filled / 100 * 56.5).toFixed(1)} 56.5`} />
  </svg>
}

/** The step Meshy is on: two from words, one from a photo, then saving the files. */
export function stepWords(view: Pick<Model3dView, 'stage' | 'source'>): string {
  if (view.stage === 'files') return t`Saving the files`
  if (view.source === 'photo') return t`Making the 3D model`
  return view.stage === 'texture' ? t`Step 2 of 2: painting the texture` : t`Step 1 of 2: making the shape`
}

/** Meshy's percent and, once there is a rate to go by, about how long is left: "68%, about 40 seconds left". */
export function progressWords(percent: number, secondsLeft: number | undefined): string {
  if (secondsLeft === undefined) return t({ message: `${percent}%`, comment: '{percent} is Meshy\'s percent for the step it is on.' })
  // Seconds to the nearest five under three quarters of a minute, then a minute, then whole minutes.
  const left = secondsLeft < 45 ? t({ message: `about ${Math.max(5, Math.round(secondsLeft / 5) * 5)} seconds left`, comment: 'A number of seconds, at least 5.' })
    : secondsLeft < 90 ? t`about a minute left`
      : t({ message: `about ${Math.round(secondsLeft / 60)} minutes left`, comment: 'A number of minutes, at least 2.' })
  return t({ message: `${percent}%, ${left}`, comment: '{percent} is Meshy\'s percent; {left} says about how long is left, such as "about 40 seconds left".' })
}

/** The step and Meshy's percent alone, as a tile has room for: "Step 2 of 2: painting the texture · 68%". */
export function makingWords(view: Pick<Model3dView, 'stage' | 'source' | 'percent'>): string {
  const step = stepWords(view)
  const percent = view.percent
  return percent === undefined ? step : t({ message: `${step} · ${percent}%`, comment: '{step} is the step Meshy is on; {percent} is its percent for that step.' })
}

export const creditsWords = (credits: number): string => plural(credits, { one: '# credit', other: '# credits' })

/** A file's kind by its extension, as its chip shows it: ".glb". */
export const extensionOf = (name: string): string => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot).toLowerCase() : name }

/** A file's size in megabytes to one place, or in kilobytes under a tenth of one. */
export function sizeWords(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  if (megabytes >= 0.1) { const shown = megabytes.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 }); return t`${shown} MB` }
  const kilobytes = Math.max(1, Math.round(bytes / 1024)).toLocaleString()
  return t`${kilobytes} KB`
}

/** Bytes as base64, a piece at a time so a large picture never overflows the call. */
function base64(bytes: Uint8Array): string {
  let text = ''
  for (let at = 0; at < bytes.byteLength; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}
