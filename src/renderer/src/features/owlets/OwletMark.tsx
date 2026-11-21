import React, { type ReactNode } from 'react'

/**
 * The owlet's own mark (ADR-0210), Zach's pick C of `docs/prototypes/owlet-mark/` on November 20, 2026: a small round owl
 * whose head dips a little in the middle, as an owl's brows do, with two big eyes and a beak, and a face of its own for
 * each owlet. Drawn in lines in the colour of whatever holds it, with no ear tufts and no fill, so it never reads as
 * Watcher's tufted, filled owl. The face is chosen from the owlet's thread ID, so a rename keeps it.
 */
const BODY = 'M5 10.4C5 6.4 7.3 3.6 9.9 3.6c1 0 1.7.6 2.1 1.3.4-.7 1.1-1.3 2.1-1.3 2.6 0 4.9 2.8 4.9 6.8v4.4c0 3.7-3.1 6.1-7 6.1s-7-2.4-7-6.1z'
const LEFT = 9.3, RIGHT = 14.7, EYE_Y = 10.4

function Rings(): ReactNode { return <><circle cx={LEFT} cy={EYE_Y} r={2.5} /><circle cx={RIGHT} cy={EYE_Y} r={2.5} /></> }
function Pupils({ dx = 0, r = 1 }: { readonly dx?: number; readonly r?: number }): ReactNode {
  return <><circle cx={LEFT + dx} cy={EYE_Y} r={r} fill="currentColor" stroke="none" /><circle cx={RIGHT + dx} cy={EYE_Y} r={r} fill="currentColor" stroke="none" /></>
}

/** Round, glancing, wide, smiling and sleepy eyes. */
const FACES: readonly (() => ReactNode)[] = [
  () => <><Rings /><Pupils /></>,
  () => <><Rings /><Pupils dx={0.8} r={0.9} /></>,
  () => <><Rings /><Pupils r={1.6} /></>,
  () => <path d="M7 11.2c.6-1.2 1.4-1.8 2.3-1.8s1.7.6 2.3 1.8M12.4 11.2c.6-1.2 1.4-1.8 2.3-1.8s1.7.6 2.3 1.8" />,
  () => <><Rings /><path d="M6.8 10.4h5M12.2 10.4h5" /></>,
]
/** No mark, three dots, or a small chevron on its chest. */
const CHESTS: readonly (() => ReactNode)[] = [
  () => null,
  () => <path d="M10.5 17.6h.01M12 18.3h.01M13.5 17.6h.01" strokeWidth={1.9} />,
  () => <path d="M10.6 17.4l1.4.9 1.4-.9" />,
]

/** The face and chest an owlet wears, from the Sotto thread ID it has on its own host, so every window draws the same one. */
export function owletLook(threadId: string): { readonly face: number; readonly chest: number } {
  const own = threadId.slice(threadId.lastIndexOf(':') + 1)
  let hash = 7
  for (const char of own) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return { face: hash % FACES.length, chest: Math.floor(hash / FACES.length) % CHESTS.length }
}

export function OwletMark({ threadId, size = 22 }: { readonly threadId: string; readonly size?: number }): ReactNode {
  const look = owletLook(threadId)
  return <svg className="owlet-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" data-face={look.face} data-chest={look.chest}>
    <path d={BODY} />
    {FACES[look.face]!()}
    <path d="M11.2 13.6h1.6L12 14.9z" fill="currentColor" strokeWidth={1} />
    {CHESTS[look.chest]!()}
  </svg>
}
