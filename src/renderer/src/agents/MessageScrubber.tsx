import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { AgentRequest } from '../../../shared/agents'
import { clockLabel } from './threadFacts'
import { nearestTick, plainOpening, scrubberAfter, scrubberLane, scrubberShown, swell, tickPlaces, type ScrubberMark } from './messageScrubberMarks'
import './messageScrubber.css'

/** How close the pointer must come to a tick to reach it. */
const REACH_PX = 14
/** How long the card waits after the pointer leaves, so moving from a tick to its card does not close it. */
const LEAVE_MS = 140
/** The card's widest, and the room it keeps from the column's right edge. */
const CARD_WIDEST = 340
const CARD_GAP = 8
/** A lane this narrow draws shorter ticks, as the narrowest window and a split pane do. */
const NARROW_LANE_PX = 30
const PAGE_STEP = 5

interface Geometry {
  readonly height: number
  /** The column's left edge, from the transcript's. */
  readonly column: number
  readonly columnWidth: number
  readonly lane: number
  readonly long: boolean
}
type Via = 'pointer' | 'keys' | 'touch'

/**
 * The message scrubber (ADR-0109; Owl only): one tick for each message the user sent, in the transcript's left margin.
 * It shows once the conversation is more than two screens tall. The pointer anywhere in the lane reaches the nearest
 * tick, which shows a card with the message and what came back; a press goes there, drawing an earlier page of the
 * conversation first when the message is not drawn. The ticks are one Tab stop: Up and Down move between them and show
 * each card, Home and End go to the ends, Enter or Space goes there and puts focus on the message, and Escape closes the
 * card and then returns to the transcript.
 */
export function MessageScrubber({ marks, scroller, content, moreAbove, who, running, requests, onJump }: {
  readonly marks: readonly ScrubberMark[]
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly content: RefObject<HTMLDivElement | null>
  /** There are messages above the first one drawn, in the window or in the thread's store. */
  readonly moreAbove: boolean
  /** Who replies: the provider, or Watcher in its own conversation. */
  readonly who: string
  readonly running: boolean
  readonly requests: readonly AgentRequest[]
  /** Brings a message into view, and into focus when the keyboard asked. */
  readonly onJump: (messageId: string, focus: boolean) => void
}): ReactNode {
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [hot, setHot] = useState<{ readonly index: number; readonly via: Via } | null>(null)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const [inView, setInView] = useState<ReadonlySet<string>>(() => new Set())
  const ticks = useRef<(HTMLButtonElement | null)[]>([])
  const card = useRef<HTMLDivElement>(null)
  const nav = useRef<HTMLElement>(null)
  const leaveTimer = useRef(0)
  const lastPointer = useRef<string>('mouse')
  const frame = useRef(0)
  const count = marks.length

  const measure = useCallback((): void => {
    const element = scroller.current
    if (element === null) return
    const style = getComputedStyle(element)
    const padLeft = Number.parseFloat(style.paddingLeft) || 0
    const padRight = Number.parseFloat(style.paddingRight) || 0
    const height = element.clientHeight
    const next: Geometry = { height, column: element.offsetLeft + padLeft, columnWidth: element.clientWidth - padLeft - padRight, lane: scrubberLane(padLeft),
      long: scrubberShown(count, element.scrollHeight, height, moreAbove) }
    setGeometry(current => current && current.height === next.height && current.column === next.column && current.columnWidth === next.columnWidth
      && current.lane === next.lane && current.long === next.long ? current : next)
  }, [scroller, count, moreAbove])

  // Which sent messages are on screen: each one's turn runs from its message to the next one the user sent.
  const readInView = useCallback((): void => {
    const element = scroller.current
    const holder = content.current
    if (element === null || holder === null) return
    const view = element.getBoundingClientRect()
    const ids = new Set(marks.map(mark => mark.messageId))
    const drawn = [...holder.querySelectorAll<HTMLElement>('.thread-message[data-role="user"][data-message-id]')].filter(article => ids.has(article.dataset.messageId!))
    const seen = new Set<string>()
    for (const [index, article] of drawn.entries()) {
      const top = article.getBoundingClientRect().top
      const end = drawn[index + 1]?.getBoundingClientRect().top ?? holder.getBoundingClientRect().bottom
      if (top < view.bottom && end > view.top) seen.add(article.dataset.messageId!)
    }
    setInView(current => current.size === seen.size && [...seen].every(id => current.has(id)) ? current : seen)
  }, [scroller, content, marks])

  useLayoutEffect(() => { measure(); readInView() }, [measure, readInView])
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    // The column comes after the ticks in the page, so on the first draw its ref is set only by now.
    measure()
    readInView()
    const onScroll = (): void => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => { measure(); readInView() })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onScroll)
    observer?.observe(element)
    if (content.current) observer?.observe(content.current)
    return () => { element.removeEventListener('scroll', onScroll); observer?.disconnect(); cancelAnimationFrame(frame.current) }
  }, [scroller, content, measure, readInView])
  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  const shown = geometry !== null && geometry.long && geometry.lane > 0
  const { pitch, places } = useMemo(() => tickPlaces(shown ? count : 0, geometry?.height ?? 0), [shown, count, geometry?.height])

  // The swell is drawn on the ticks themselves, so a pointer moving through the lane redraws no component.
  const rise = useCallback((y: number | null): void => {
    const heights = swell(places, y)
    for (const [index, tick] of ticks.current.entries()) {
      if (!tick) continue
      if (y === null) tick.style.removeProperty('--rise')
      else tick.style.setProperty('--rise', heights[index]!.toFixed(3))
    }
  }, [places])

  const close = useCallback((): void => { setHot(null); rise(null) }, [rise])
  // A thread with fewer messages, or one that is no longer long, keeps no card open on a tick that has gone.
  useEffect(() => { if (!shown || (hot !== null && hot.index >= count)) close() }, [shown, hot, count, close])
  useEffect(() => { if (focusIndex !== null && focusIndex >= count) setFocusIndex(null) }, [focusIndex, count])

  const jump = (index: number, focus: boolean): void => {
    const mark = marks[index]
    if (!mark) return
    close()
    onJump(mark.messageId, focus)
  }

  const pointerY = (clientY: number): number => clientY - (nav.current?.getBoundingClientRect().top ?? 0)
  const onPointerMove = (event: React.PointerEvent): void => {
    if (event.pointerType === 'touch') return
    window.clearTimeout(leaveTimer.current)
    const y = pointerY(event.clientY)
    rise(y)
    const index = nearestTick(places, y, REACH_PX)
    if (index < 0) { if (hot?.via === 'pointer') setHot(null); return }
    if (hot?.index !== index || hot.via !== 'pointer') setHot({ index, via: 'pointer' })
  }
  const leave = (): void => {
    if (hot?.via !== 'pointer') { rise(focusIndex === null ? null : places[focusIndex] ?? null); return }
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => { if (!card.current?.matches(':hover')) close() }, LEAVE_MS)
  }

  const focusTick = (index: number): void => {
    const next = Math.max(0, Math.min(count - 1, index))
    setFocusIndex(next)
    ticks.current[next]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const at = focusIndex ?? count - 1
    const keys: Record<string, () => void> = {
      ArrowUp: () => focusTick(at - 1), ArrowDown: () => focusTick(at + 1), Home: () => focusTick(0), End: () => focusTick(count - 1),
      PageUp: () => focusTick(at - PAGE_STEP), PageDown: () => focusTick(at + PAGE_STEP),
      Enter: () => jump(at, true), ' ': () => jump(at, true),
      Escape: () => { if (hot !== null) close(); else scroller.current?.focus() },
    }
    const run = keys[event.key]
    if (!run) return
    event.preventDefault()
    event.stopPropagation()
    run()
  }

  // The wheel over the lane scrolls the transcript, as it would over the margin the lane sits in.
  const onWheel = (event: React.WheelEvent): void => {
    const element = scroller.current
    if (element === null) return
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
    element.scrollTop += event.deltaY * unit
  }

  // The card sits beside its tick, kept inside the transcript.
  const [cardTop, setCardTop] = useState(0)
  useLayoutEffect(() => {
    if (hot === null || geometry === null) return
    const height = card.current?.offsetHeight ?? 0
    const place = places[hot.index] ?? 0
    setCardTop(Math.max(CARD_GAP, Math.min(geometry.height - height - CARD_GAP, place - height / 2)))
  }, [hot, geometry, places])

  if (!shown) return null
  const tabbable = focusIndex ?? lastIndexOf(marks, inView) ?? count - 1
  const style = {
    '--scrubber-left': `${geometry.column - geometry.lane}px`, '--scrubber-lane': `${geometry.lane}px`,
    '--scrubber-gap': `${geometry.lane < NARROW_LANE_PX ? 4 : 18}px`, '--scrubber-hit': `${Math.max(6, pitch)}px`,
  } as CSSProperties
  // The card is the lane's sibling, so it is placed on its own: over the column, beside the lane, never over it.
  const cardPlace = { left: geometry.column + CARD_GAP, width: Math.max(180, Math.min(CARD_WIDEST, geometry.columnWidth - 2 * CARD_GAP)) }
  const shownMark = hot === null ? undefined : marks[hot.index]
  return <>
    <nav ref={nav} className="message-scrubber" aria-label="Messages you sent" style={style} data-active={hot !== null || undefined}
      data-narrow={geometry.lane < NARROW_LANE_PX || undefined}
      onPointerMove={onPointerMove} onPointerLeave={leave} onPointerDown={event => { lastPointer.current = event.pointerType }} onWheel={onWheel} onKeyDown={onKeyDown}
      onFocus={event => {
        const index = ticks.current.indexOf(event.target as HTMLButtonElement)
        if (index < 0) return
        setFocusIndex(index)
        setHot({ index, via: 'keys' })
        rise(places[index] ?? null)
      }}
      onBlur={event => { if (!nav.current?.contains(event.relatedTarget as Node | null)) { setFocusIndex(null); if (hot?.via === 'keys') close() } }}>
      {marks.map((mark, index) => <button key={mark.messageId} ref={element => { ticks.current[index] = element }} type="button" className="message-scrubber__tick"
        style={{ top: `${places[index]}px` }} tabIndex={index === tabbable ? 0 : -1} data-hot={hot?.index === index || undefined} data-in-view={inView.has(mark.messageId) || undefined}
        aria-label={`Go to your message at ${clockLabel(Date.parse(mark.message.createdAt))}: ${opening(mark, 80)}`}
        onClick={event => {
          // A tap shows the card first; a tap on the card goes there. The keyboard's press is handled on its key.
          if (event.detail === 0) return
          if (lastPointer.current === 'touch' && hot?.index !== index) { setHot({ index, via: 'touch' }); return }
          jump(index, false)
        }} />)}
    </nav>
    {shownMark && hot ? <ScrubberCard ref={card} mark={shownMark} index={hot.index} count={count} who={who} running={running} requests={requests} keys={hot.via === 'keys'}
      top={cardTop} place={cardPlace} onPress={() => jump(hot.index, false)} onEnter={() => window.clearTimeout(leaveTimer.current)} onLeave={() => { if (hot.via === 'pointer') leave() }} /> : null}
  </>
}

const opening = (mark: ScrubberMark, most: number): string => {
  const words = plainOpening(mark.message.text, most)
  const attached = mark.message.attachments?.length ?? 0
  return words || (attached === 1 ? 'One attachment' : attached > 1 ? `${attached} attachments` : 'An empty message')
}

/** The last sent message on screen, which is where Tab first lands in the column. */
function lastIndexOf(marks: readonly ScrubberMark[], inView: ReadonlySet<string>): number | undefined {
  const index = marks.findLastIndex(mark => inView.has(mark.messageId))
  return index < 0 ? undefined : index
}

/**
 * The card for one tick (pick B): who sent it, when and which of how many, the message, then the start of the reply or
 * the question it led to with its choices. It repeats what the tick's name already says, so it is for the eye alone.
 */
function ScrubberCard({ ref, mark, index, count, who, running, requests, keys, top, place, onPress, onEnter, onLeave }: {
  readonly ref: RefObject<HTMLDivElement | null>
  readonly mark: ScrubberMark; readonly index: number; readonly count: number; readonly who: string; readonly running: boolean
  readonly requests: readonly AgentRequest[]; readonly keys: boolean; readonly top: number
  readonly place: { readonly left: number; readonly width: number }
  readonly onPress: () => void; readonly onEnter: () => void; readonly onLeave: () => void
}): ReactNode {
  const newest = index === count - 1
  const after = scrubberAfter(mark, newest, requests)
  return <div ref={ref} className="message-scrubber__card" aria-hidden="true" style={{ top: `${top}px`, left: `${place.left}px`, width: `${place.width}px` }} onClick={onPress} onPointerEnter={onEnter} onPointerLeave={onLeave}>
    <div className="message-scrubber__head"><b>You</b><span>{clockLabel(Date.parse(mark.message.createdAt))}</span><span>Message {index + 1} of {count}</span></div>
    <p className="message-scrubber__said">{opening(mark, 400)}</p>
    {after.kind === 'reply' ? <><p className="message-scrubber__who">{who} replied</p><p className="message-scrubber__then">{after.text}</p></>
      : after.kind === 'asked' ? <><p className="message-scrubber__who">{who} asked</p><p className="message-scrubber__then">{after.question}</p>
        {after.choices.length ? <ul className="message-scrubber__choices">{after.choices.map(choice => <li key={choice}>{choice}</li>)}</ul> : null}
        {after.more > 0 ? <p className="message-scrubber__more">{after.more === 1 ? 'One more choice' : `${after.more} more choices`}</p> : null}</>
        : newest && running ? <p className="message-scrubber__who">{who} is working</p> : null}
    {keys ? <p className="message-scrubber__keys">Enter goes there. Up and Down move to the others. Esc closes this.</p> : null}
  </div>
}
