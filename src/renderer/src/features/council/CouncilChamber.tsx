import React, { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { ClimbRecord } from '../../../../shared/councilClimb'
import type { AgentThread } from '../../../../shared/agents'
import type { CouncilLayout, CouncilSeatInForce, CouncilView as CouncilRecord } from '../../../../shared/council'
import { useOptionalAgents } from '../../agents/AgentContext'
import { useOptionalApp } from '../../state/AppContext'
import { useReducedMotion } from '../../state/reducedMotion'
import { toRgb } from '../../watcher/canvasColor'
import { frameDue, frameSleep, IDLE_CHECK_MS } from '../../watcher/nightScene'
import { surfaceOf } from '../../watcher/WatcherNightScene'
import { watchResolution } from '../../watcher/watchResolution'
import { fitCells } from './chamberGrid'
import { chamberInk } from './chamberInk'
import { figureBox } from './chamberLayout'
import { ChamberPainter, type ChamberFlightNow, type SeatWords } from './chamberPainter'
import { askScene, chamberPace, climbScene, councilScene, flightsBetween, sceneBusy, threadFacts, type ChamberScene, type ChamberSeat } from './chamberScene'

/** A figure's button over the canvas, in the chamber's box. */
interface FigureBox { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** No threads to read: the Ask view's and a finished Council's, shared so an update elsewhere changes nothing here. */
const NO_THREADS: ReadonlyMap<string, AgentThread> = new Map()

/**
 * The wanted threads as `threads` holds them, or `last` when it holds every one of them as the same object: a thread
 * elsewhere that streams or changes then leaves the chamber's scene, and its pace, alone.
 */
export function heldThreads(threads: readonly AgentThread[] | undefined, wanted: readonly string[], last: ReadonlyMap<string, AgentThread>): ReadonlyMap<string, AgentThread> {
  if (wanted.length === 0 || threads === undefined) return NO_THREADS
  const found = new Map<string, AgentThread>()
  for (const thread of threads) if (wanted.includes(thread.id)) found.set(thread.id, thread)
  if (found.size !== last.size) return found
  for (const [id, thread] of found) if (last.get(id) !== thread) return found
  return last
}

/** What the chamber says of each seat: its plate, its bubble, and its button's name. */
function useChamberWords(): {
  readonly seat: (seat: ChamberSeat, live: boolean) => SeatWords
  readonly label: (seat: ChamberSeat) => string
  readonly verdict: string
} {
  const { t, i18n } = useLingui()
  return useMemo(() => {
    const chair = t({ message: 'Chair', comment: 'The Council\'s chair, on its plate in the chamber' })
    const list = (letters: readonly string[]): string => new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(letters)
    const bubble = (seat: ChamberSeat): SeatWords['bubble'] => {
      const title = fitCells(seat.chair ? chair : seat.model)
      const speech = seat.speech
      switch (speech.kind) {
        case 'none': return null
        case 'ask': return { text: t`Needs your answer`, title, say: true }
        case 'words': return { text: fitCells(speech.text), title, say: true }
        case 'activity': return { text: fitCells(speech.text), title, say: false }
        case 'thinking': return { text: t({ message: 'Thinking', comment: 'A Council figure\'s thought bubble while its thread works' }), title, say: false }
        case 'conversation': return { text: t`Reading the conversation`, title, say: false }
        case 'framing': return { text: t`Framing the question`, title, say: false }
        case 'answers': { const letters = list(speech.letters); return { text: speech.letters.length ? t`Reading answers ${letters}` : t`Reading the other answers`, title, say: false } }
        case 'everything': return { text: t`Reading every answer and review`, title, say: false }
        case 'verdict': return { text: t`Reading the verdict`, title, say: false }
      }
    }
    const doing = (seat: ChamberSeat): string => {
      const speech = seat.speech
      switch (seat.act) {
        case 'ask': return t`needs your answer`
        case 'think': {
          if (speech.kind === 'conversation') return t`reading the conversation`
          if (speech.kind === 'framing') return t`framing the question`
          if (speech.kind === 'activity') { const what = speech.text; return t`working: ${what}` }
          return t`thinking`
        }
        case 'write': return seat.chair ? t`writing the verdict` : t`writing its answer`
        case 'read': return seat.chair ? t`reading every answer and review` : seat.stage === 'fairness' ? t`reading the verdict` : t`reading the other answers`
        case 'speak': return seat.stage === 'review' ? t`giving its review` : seat.stage === 'fairness' ? t`answering the fairness check` : seat.stage === 'crux' ? t`reporting the crux check` : t`talking`
        case 'present': return t`holding up the verdict`
        default: return seat.state === 'failed' ? t`failed` : seat.state === 'stopped' ? t`stopped` : seat.state === 'unknown' ? t`state unknown` : seat.state === 'done' ? t`done` : t`listening`
      }
    }
    return {
      seat: (seat, live) => {
        const changed = live && seat.changed
        return {
          name: fitCells(seat.chair ? chair : seat.provider), sub: fitCells(seat.chair ? [seat.provider, seat.model].filter(Boolean).join(' · ') : seat.model), subShort: fitCells(seat.model),
          mark: seat.chair ? '' : changed ? `${seat.key} ↺` : seat.key, markAccent: changed, bubble: bubble(seat),
        }
      },
      label: seat => {
        const who = seat.chair ? chair : seat.key, model = seat.model, now = doing(seat)
        return t({ message: `${who}, ${model}, ${now}. Open its thread`, comment: 'A Council figure\'s button: its letter or Chair, its model, what it is doing, then what a press does' })
      },
      verdict: t({ message: 'Verdict', comment: 'The title on the chair\'s verdict scroll when its words are not kept' }),
    }
  }, [t, i18n])
}

/**
 * The Council's chamber (ADR-0177 decision 6): the panelists as a Roman council in ASCII, drawn as Watcher's night scene
 * is, in the theme's text and accent inks and lit by its lamps and braziers, in the layout Settings → Council chooses.
 * With a live Council each figure follows its own thread: its pose, its bubble and the scrolls passing between seats come
 * from the record and the thread's state. A finished Council keeps its last scene, still: the chair holding up the
 * verdict and the panelists listening. With neither it shows the seats the Ask form would start, sitting idle and
 * glancing about. A press on a figure opens its thread; the canvas is hidden from assistive technology, since the record
 * beside it is the deliberation's accessible form.
 *
 * It draws about 30 frames a second while a figure is busy or something is on its way, checks 8 times a second while
 * the room only flickers and glances, throughout the fairness check, or a finished Council's fire only flickers. With
 * motion reduced it draws nothing until something changes, and nothing while the window is hidden.
 */
export function CouncilChamber({ council, climb, askSeats, layout }: {
  readonly climb?: ClimbRecord | null
  /** The Council shown, live or finished, or null for the Ask view. */
  readonly council: CouncilRecord | null
  /** The seats the Ask form would start, for the Ask view. */
  readonly askSeats: { readonly panelists: readonly (CouncilSeatInForce | undefined)[]; readonly chair: CouncilSeatInForce | undefined }
  readonly layout: CouncilLayout
}): ReactNode {
  const words = useChamberWords()
  const agents = useOptionalAgents()
  const app = useOptionalApp()
  const reduced = useReducedMotion()
  const threads = agents?.state?.host.threads
  const command = agents?.command
  // A live Council's threads, by ID: only theirs are looked up, once per update, and their histories asked for. A finished
  // Council's threads have nothing more to show.
  const working = climb ? !['done', 'stopped', 'settled'].includes(climb.phase) : council?.status === 'working' || council?.status === 'waiting'
  const wanted = useMemo(() => working ? climb ? climb.turns.filter(turn => turn.round === Math.max(0, climb.rounds.length - 1) && turn.stage !== 'builder').map(turn => turn.thread) : council!.seats.map(seat => seat.thread) : [], [council, climb, working])
  const wantedKey = wanted.join('\n')
  useEffect(() => {
    if (command === undefined || wanted.length === 0) return
    void command({ type: 'observe-threads', threadIds: wanted })
    return () => { void command({ type: 'observe-threads', threadIds: [] }) }
    // The IDs, not the array: a new record with the same threads asks for nothing again.
  }, [command, wantedKey])
  const lastHeld = useRef(NO_THREADS)
  const held = useMemo(() => heldThreads(threads, wanted, lastHeld.current), [threads, wanted])
  lastHeld.current = held
  const scene = useMemo<ChamberScene>(() => climb ? climbScene(climb, askSeats, thread => threadFacts(held.get(thread))) : council ? councilScene(council, thread => threadFacts(held.get(thread))) : askScene(askSeats), [council, climb, held, askSeats])
  const live = council !== null || !!climb
  const seatWords = useMemo(() => new Map([...scene.panelists, scene.chair].map(seat => [seat.key, words.seat(seat, live)] as const)), [scene, live, words])
  const verdictText = useMemo(() => fitCells(scene.verdict?.text || words.verdict), [scene.verdict?.text, words.verdict])

  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const probe = useRef<HTMLElement>(null)
  const [boxes, setBoxes] = useState<ReadonlyMap<string, FigureBox> | null>(null)
  /** What the running loop reads, kept current without restarting it. */
  const busy = sceneBusy(scene)
  const latest = useRef({ scene, seatWords, verdictText, reduced, layout, busy })
  latest.current = { scene, seatWords, verdictText, reduced, layout, busy }
  const wakeRef = useRef<() => void>(() => undefined)
  const relayoutRef = useRef<() => void>(() => undefined)
  /** The scrolls in the air and the verdict's moments, on the chamber's clock. */
  const motion = useRef<{ id: string | null; stage: ChamberScene['stage']; flights: ChamberFlightNow[]; verdict: boolean; finished: boolean; verdictSince: number; finishedSince: number }>(
    { id: null, stage: null, flights: [], verdict: false, finished: false, verdictSince: 0, finishedSince: 0 })
  const origin = useRef<number | null>(null)
  const clock = (): number => { origin.current ??= performance.now(); return (performance.now() - origin.current) / 1000 }

  // A change of stage sends scrolls across the table; a new verdict unrolls, and a finished one shimmers once.
  useEffect(() => {
    const kept = motion.current, t = clock()
    if (kept.id !== scene.id) {
      // Another Council, or the Ask view: everything starts where it stands, with nothing in the air.
      motion.current = { id: scene.id, stage: scene.stage, flights: [], verdict: scene.verdict !== null, finished: scene.verdict?.finished === true, verdictSince: t - 10, finishedSince: t - 10 }
    } else {
      if (kept.stage !== scene.stage) {
        kept.flights = [...kept.flights.filter(flight => t - flight.t0 < 2), ...flightsBetween(kept.stage, scene).map(flight => ({ ...flight, t0: t + flight.delay }))]
        kept.stage = scene.stage
      }
      if (scene.verdict !== null && !kept.verdict) kept.verdictSince = t
      if (scene.verdict?.finished === true && !kept.finished) kept.finishedSince = t
      kept.verdict = scene.verdict !== null
      kept.finished = scene.verdict?.finished === true
    }
    wakeRef.current()
  }, [scene])
  useEffect(() => { wakeRef.current() }, [seatWords, verdictText, reduced])
  useEffect(() => { relayoutRef.current() }, [layout, scene.panelists.length])

  useEffect(() => {
    const element = box.current, view = canvas.current, ink = probe.current
    // Without layout (a test's DOM) there is nothing to measure, so nothing is drawn.
    if (element === null || view === null || ink === null || typeof ResizeObserver === 'undefined') return
    const pixelCanvas = document.createElement('canvas')
    pixelCanvas.width = 1; pixelCanvas.height = 1
    const pixel = pixelCanvas.getContext('2d', { willReadFrequently: true })
    if (pixel === null) return
    const painter = new ChamberPainter(view)
    let disposed = false, timer: number | null = null, request: number | null = null
    let last = Number.NEGATIVE_INFINITY, lastDrawn = 0, delay: number | null = 0, inked = '', boxKey = ''

    const halt = (): void => {
      if (timer !== null) { window.clearTimeout(timer); timer = null }
      if (request !== null) { cancelAnimationFrame(request); request = null }
    }
    const schedule = (): void => {
      if (delay === null || disposed) return
      const sleep = frameSleep(performance.now(), last, delay)
      if (sleep > 0) timer = window.setTimeout(() => { timer = null; request = requestAnimationFrame(frame) }, sleep)
      else request = requestAnimationFrame(frame)
    }
    const frame = (now: number): void => {
      request = null
      if (disposed || document.visibilityState === 'hidden' || !painter.ready) return
      if (delay === null || !frameDue(now, last, delay)) { if (delay !== null) request = requestAnimationFrame(frame); return }
      last = now
      const t = clock(), { scene: shown, seatWords: said, verdictText: text, reduced: still, busy } = latest.current
      const kept = motion.current
      kept.flights = kept.flights.filter(flight => still ? false : t - flight.t0 < 1.7)
      const dt = Math.min(0.1, Math.max(0, t - lastDrawn)); lastDrawn = t
      const moving = painter.draw({ t, dt, still, scene: shown, words: said, flights: kept.flights, verdictSince: kept.verdictSince, finishedSince: kept.finishedSince, verdictText: text })
      delay = chamberPace(still, moving, busy, shown.stage)
      schedule()
    }
    const wake = (force = false): void => {
      if (disposed) return
      if (timer !== null) { window.clearTimeout(timer); timer = null }
      // Streaming keeps its deadline; a cleared or newly visible canvas needs its ink on the next frame.
      const slow = !force && latest.current.scene.stage === 'fairness' && !latest.current.reduced
      delay = slow ? IDLE_CHECK_MS : 0
      if (!slow) last = Number.NEGATIVE_INFINITY
      if (request === null) schedule()
    }
    wakeRef.current = wake

    const readInk = (): void => {
      const style = getComputedStyle(ink)
      const text = toRgb(style.color, pixel), accent = toRgb(style.backgroundColor, pixel), surface = surfaceOf(element, pixel, text)
      if (text === null || accent === null || surface === null) return
      const key = JSON.stringify([text, accent, surface, style.fontFamily])
      if (key === inked) return
      inked = key
      painter.setInk(chamberInk(surface, text, accent), style.fontFamily)
      wake(true)
    }
    const relayout = (): void => {
      if (disposed) return
      const { layout: chosen, scene: shown } = latest.current
      const geometry = painter.resize(element.clientWidth, element.clientHeight, window.devicePixelRatio || 1, chosen, shown.panelists.length)
      const offset = painter.offset(element.clientWidth, element.clientHeight)
      view.style.left = `${offset.x}px`; view.style.top = `${offset.y}px`
      const next = new Map<string, FigureBox>()
      if (geometry !== null) for (const figure of [...geometry.panelists, geometry.chair]) {
        // Held inside the chamber, so a figure the frame cuts keeps a button over what shows of it.
        const raw = figureBox(figure)
        const x = Math.max(0, raw.x + offset.x), y = Math.max(0, raw.y + offset.y)
        const w = Math.min(element.clientWidth, raw.x + offset.x + raw.w) - x, h = Math.min(element.clientHeight, raw.y + offset.y + raw.h) - y
        if (w > 4 && h > 4) next.set(figure.key, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) })
      }
      const key = JSON.stringify([...next])
      if (key !== boxKey) { boxKey = key; setBoxes(next) }
      halt()
      wake(true)
    }
    relayoutRef.current = relayout

    const sizes = new ResizeObserver(relayout)
    sizes.observe(element)
    const theme = new MutationObserver(readInk)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-theme-id'] })
    const visibility = (): void => { if (document.visibilityState !== 'hidden') wake(true) }
    document.addEventListener('visibilitychange', visibility)
    const unwatchResolution = watchResolution(relayout)
    void document.fonts?.load(`10.5px ${getComputedStyle(ink).fontFamily}`).then(() => { if (!disposed) { inked = ''; readInk() } }, () => undefined)
    readInk()
    relayout()
    return () => {
      disposed = true
      wakeRef.current = () => undefined
      relayoutRef.current = () => undefined
      halt()
      unwatchResolution()
      sizes.disconnect(); theme.disconnect()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  const open = (thread: string): void => {
    void agents?.command({ type: 'select-thread', threadId: thread })
    app?.actions.navigate('threads')
  }
  // A figure of a Council has a button once it has a place on screen, so there is no tab stop to nothing, in the order
  // the eye meets them, left to right.
  const figures = live && boxes !== null ? [...scene.panelists, scene.chair].filter(seat => seat.thread !== null && boxes.has(seat.key)) : []
  figures.sort((one, other) => boxes!.get(one.key)!.x - boxes!.get(other.key)!.x)
  return <div ref={box} className="council-chamber" data-layout={layout}>
    <canvas ref={canvas} className="council-chamber__scene" aria-hidden="true" />
    {figures.map(seat => {
      const at = boxes!.get(seat.key)!
      const style: CSSProperties = { left: at.x, top: at.y, width: at.w, height: at.h }
      return <button key={seat.key} type="button" className="council-chamber__figure tt-focusable" data-seat={seat.key} data-act={seat.act} aria-label={words.label(seat)}
        style={style} onClick={() => open(seat.thread!)} />
    })}
    <i ref={probe} className="council-chamber__ink" aria-hidden="true" />
  </div>
}
