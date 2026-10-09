import React, { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { formatAccelerator } from '../../../../shared/accelerator'
import type { SottoPlatform } from '../../../../shared/platform'
import { Button } from '../../components/Button'
import './threadsTour.css'

export interface ThreadsTourProps {
  readonly shortcut: string
  readonly platform: SottoPlatform
  /** Called once, when the tour is finished or skipped. */
  readonly onDone: () => void
}

interface TourStop {
  /** The part of the Threads page the stop points at. */
  readonly selector: string
  readonly title: string
  readonly body: string
}

export function threadsTourStops(shortcut: string): readonly TourStop[] {
  return [
    { selector: 'aside.thread-nav', title: 'Projects and threads', body: 'Your projects and their threads are listed here. Add project brings in another folder.' },
    { selector: 'aside.thread-nav button[aria-label="New thread"]', title: 'New thread', body: `Starts a thread in the selected project. Type your message, or press ${shortcut} and speak it.` },
    { selector: 'section.thread-workspace', title: 'Threads', body: "A thread shows the agent's work, and the questions and permissions it asks you to answer." },
    { selector: 'aside.thread-nav a.thread-nav__page[href="#settings"]', title: 'Settings', body: 'Anything you skipped in setup waits here, with your shortcut, microphone and keys.' },
  ]
}

interface Box { readonly top: number; readonly left: number; readonly width: number; readonly height: number }

const GAP = 14
const PAD = 6
const BUBBLE_WIDTH = 320

function boxOf(element: Element | null): Box | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null
}

/** Beside a narrow target, above or below a wide one, always inside the window. */
function bubblePlace(target: Box | null, height: number): { top: number; left: number } {
  const width = window.innerWidth
  const tall = window.innerHeight
  if (!target) return { top: Math.max(GAP, (tall - height) / 2), left: Math.max(GAP, (width - BUBBLE_WIDTH) / 2) }
  let left: number
  let top: number
  if (target.width >= width * 0.45 && target.height >= tall * 0.6) {
    // A part that fills most of the window keeps its note inside it, in the middle.
    left = target.left + target.width / 2 - BUBBLE_WIDTH / 2
    top = target.top + target.height / 2 - height / 2
  } else if (target.width < width * 0.45 && target.left + target.width + GAP + BUBBLE_WIDTH < width - GAP) {
    left = target.left + target.width + PAD + GAP
    top = target.top + Math.min(target.height / 2, 60) - 30
  } else if (target.width < width * 0.45 && target.left - GAP - BUBBLE_WIDTH > GAP) {
    left = target.left - PAD - GAP - BUBBLE_WIDTH
    top = target.top
  } else {
    left = target.left + target.width / 2 - BUBBLE_WIDTH / 2
    top = target.top + target.height / 2 > tall / 2 ? target.top - PAD - GAP - height : target.top + target.height + PAD + GAP
  }
  return {
    left: Math.min(Math.max(GAP, left), width - BUBBLE_WIDTH - GAP),
    top: Math.min(Math.max(GAP, top), tall - height - GAP),
  }
}

/**
 * The Threads tour: four stops on the real Threads page right after first-run setup, each a spotlight on one part with
 * a short note. It is a modal dialog, so focus stays in its note and Escape ends it; a part that is not on the page is
 * passed over.
 */
export function ThreadsTour({ shortcut, platform, onDone }: ThreadsTourProps): ReactNode {
  const stops = threadsTourStops(formatAccelerator(shortcut, platform, 'editing'))
  const [index, setIndex] = useState(0)
  const [target, setTarget] = useState<Box | null>(null)
  const [bubbleHeight, setBubbleHeight] = useState(180)
  const bubble = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const bodyId = useId()
  const finished = useRef(false)
  const stop = stops[index]!
  const last = index === stops.length - 1

  const finish = (): void => {
    if (finished.current) return
    finished.current = true
    onDone()
    queueMicrotask(() => document.querySelector<HTMLElement>(stops[1]!.selector)?.focus())
  }

  // Follow the part as the page lays out, the way an anchored popover does.
  useEffect(() => {
    let frame = 0
    const measure = (): void => {
      const next = boxOf(document.querySelector(stop.selector))
      setTarget(current => current && next && current.top === next.top && current.left === next.left && current.width === next.width && current.height === next.height ? current : next)
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [stop.selector])

  useLayoutEffect(() => {
    if (bubble.current) setBubbleHeight(bubble.current.offsetHeight)
  }, [index])

  useEffect(() => { heading.current?.focus() }, [index])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish()
      return
    }
    if (event.key !== 'Tab' || !bubble.current) return
    const focusable = [...bubble.current.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    if (focusable.length === 0) return
    const first = focusable[0]!
    const lastFocusable = focusable[focusable.length - 1]!
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
      event.preventDefault()
      lastFocusable.focus()
    } else if (!event.shiftKey && document.activeElement === lastFocusable) {
      event.preventDefault()
      first.focus()
    }
  }

  const place = bubblePlace(target, bubbleHeight)
  return createPortal(
    <div className="threads-tour" onKeyDown={onKeyDown}>
      <div className="threads-tour__scrim" data-hole={target !== null} aria-hidden="true"
        style={target ? { top: target.top - PAD, left: target.left - PAD, width: target.width + PAD * 2, height: target.height + PAD * 2 } : undefined} />
      <div ref={bubble} className="threads-tour__note" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}
        style={{ top: place.top, left: place.left, width: BUBBLE_WIDTH }}>
        <h2 id={titleId} ref={heading} tabIndex={-1}>{stop.title}</h2>
        <p id={bodyId}>{stop.body}</p>
        <footer>
          <span className="threads-tour__count">{index + 1} of {stops.length}</span>
          <span className="threads-tour__actions">
            {last ? null : <Button variant="ghost" onClick={finish}>Skip tour</Button>}
            {index > 0 ? <Button variant="ghost" onClick={() => setIndex(index - 1)}>Back</Button> : null}
            {last ? <Button onClick={finish}>Done</Button> : <Button onClick={() => setIndex(index + 1)}>Next</Button>}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
