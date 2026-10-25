import React, { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { slimMoving } from '../agents/slimComposer'
import { useReducedMotion } from '../state/reducedMotion'
import {
  addRipple, frameDelay, frameDue, frameSleep, glassOpacity, heldRoom, inMargin, liveRipples, nextPlace, owlAt, planFlight, sceneInk, stayAt,
  type Box, type Look, type OwlStage, type Rgb, type Ripple, type SceneLayout, type SceneMeasure, type WatcherOwlState, type Word,
} from './nightScene'
import { toRgb } from './canvasColor'
import { NightScenePainter, type SceneFrame } from './nightScenePainter'
import { OwlFamily, pileLabel, type FamilyMotion, type OwlMood, type ThreadOwlPose, type WatchedOwl } from './owlFamily'
import { watchResolution } from './watchResolution'
import type { OpenThread } from './WatcherOverview'
import './nightScene.css'

/** How long the scene takes to fade when it steps away, as for Visualize (nightScene.css). */
export const SCENE_FADE_MS = 700

/** Where a press is a control's, or the composer's or the header's, and sends out no ripple. */
const NOT_BACKGROUND = [
  'button', 'a', 'input', 'textarea', 'select', 'label', 'summary', 'dialog', '[contenteditable]',
  ...['button', 'tab', 'link', 'menuitem', 'option', 'combobox', 'textbox', 'dialog', 'menu', 'listbox', 'checkbox', 'radio', 'switch', 'slider'].map(role => `[role="${role}"]`),
  '.thread-workspace__compose', '.watcher-head', '.watcher-glance', '.watcher-handover',
].join(', ')

function relative(box: DOMRect, base: DOMRect, scrollTop: number): Box {
  return { x: box.left - base.left, y: box.top - base.top + scrollTop, w: box.width, h: box.height }
}

/** What the scene needs to know of Watcher's pane, or null while it has no composer to set the column by. */
export function measureRoom(pane: HTMLElement): SceneMeasure | null {
  const form = pane.querySelector<HTMLElement>('.thread-workspace__compose .thread-prompt')
  const compose = form?.closest<HTMLElement>('.thread-workspace__compose')
  if (form == null || compose == null) return null
  const base = pane.getBoundingClientRect(), top = pane.scrollTop
  const at = (element: Element): Box => relative(element.getBoundingClientRect(), base, top)
  const card = at(form)
  if (card.w < 1 || card.h < 1) return null
  // While the composer is slim (ADR-0125) the scene keeps the full card's place, which the pane remembers as the card's
  // height and how far its foot stood above the composer's, so it holds still as the card and the row under it change.
  const slim = compose.hasAttribute('data-slim'), style = getComputedStyle(compose)
  const full = slim ? parseFloat(style.getPropertyValue('--thread-prompt-full')) : Number.NaN
  const foot = slim ? parseFloat(style.getPropertyValue('--thread-prompt-foot')) : Number.NaN
  const room = at(compose)
  const composer = !Number.isFinite(full) ? card
    : Number.isFinite(foot) ? { ...card, y: room.y + room.h - foot - full, h: full }
    : full > card.h ? { ...card, y: card.y + card.h - full, h: full } : card
  const words: Box[] = []
  const shown = (box: Box): boolean => box.w > 1 && box.h > 1
  const word = (element: Element): void => { const box = at(element); if (shown(box) && element.textContent?.trim()) words.push(box) }
  // The header and the needs-you line, what stands on the composer, and the line under it.
  let header = 0
  for (const band of pane.querySelectorAll(':scope > :is(.watcher-head, .watcher-glance, .thread-workspace__error)')) {
    const box = at(band)
    header = Math.max(header, box.y + box.h)
    word(band)
  }
  for (const child of compose.children) {
    if (child.contains(form)) break
    word(child)
  }
  for (const line of compose.querySelectorAll(':scope > .thread-pane__meta')) word(line)
  // A long conversation's message scrubber holds a lane beside the column, which the scene keeps clear (ADR-0109).
  const scrubber = pane.querySelector('.message-scrubber')
  const lane = scrubber === null ? undefined : at(scrubber)
  return { width: pane.clientWidth, height: pane.clientHeight, header, composer, words, ...lane !== undefined && shown(lane) ? { lane } : {} }
}

/** A colour words are written in, with its opacity, so a translucent one is counted as it shows. */
export function toWord(value: string, pixel: CanvasRenderingContext2D): Word | null {
  const rgb = toRgb(value, pixel)
  if (rgb === null) return null
  const a = pixel.getImageData(0, 0, 1, 1).data[3]! / 255
  return a >= 1 ? rgb : { ...rgb, a }
}

/** The surface the scene is drawn on: the first painted background at or above the pane. */
export function surfaceOf(pane: HTMLElement, pixel: CanvasRenderingContext2D): Rgb | null {
  for (let node: Element | null = pane; node !== null; node = node.parentElement) {
    const found = toRgb(getComputedStyle(node).backgroundColor, pixel)
    if (found !== null) return found
  }
  return null
}

/** Half the tip's widest (nightScene.css), and a little air. */
const TIP_HALF = 126
/** The tip's height with its two lines (nightScene.css). */
const TIP_HEIGHT = 44

/** What a thread owl's tooltip says of its thread. */
const MOOD_WORDS = {
  awake: msg({ message: 'Working', comment: 'A thread’s status' }),
  waiting: msg`Waiting on you. Press to answer.`,
  asleep: msg`Not working now`,
} as const satisfies Record<OwlMood, unknown>

/** A perched thread owl's button, or the "+N" pile's. */
interface Target {
  readonly key: string
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly title: string
  readonly words: string
  readonly open: { readonly threadId: string; readonly atRequest: boolean } | null
  /** Too near the header for the tip to fit above it, so the tip opens below. */
  readonly below: boolean
}

/**
 * Watcher's night scene, in the room's side margins (Zach's picks on October 21 and 22, 2026, `prototype/watcher-owl-scene`
 * and `prototype/watcher-owl-family`): an ASCII night beside the column with Watcher's owl in its tree and a thread owl
 * for each thread Watcher watches. The sky and the hills run on under the column and the glass composer at 85% (the
 * user's pick on October 23, 2026, variant D of `docs/prototypes/watcher-floating-composer-prototype.html`), and never
 * move for the words passing over them; no glyph there is stronger than the words over it allow (ADR-0126), and each
 * word carries a soft glow of the canvas (watcher.css). Trees, owls and ripples stay in the margins.
 * Watcher's owl flies now and then, at random, to the other tree or onto a branch off the composer, and back. A new
 * watched thread's owl comes out of a whirlpool in the moon, which sends out a ripple; a settled or unwatched thread's
 * owl flies back into it. A press in the open margin sends out a ripple too, and Watcher's owl looks toward it. Below a
 * margin of 160 pixels the trees give way to a rail of owl eyes, and without even that room nothing is drawn.
 *
 * The canvases are decoration, hidden from assistive technology and never pressed. The thread owls' buttons answer the
 * pointer only: they show the thread's name and open it, as the Watched view does from the keyboard. The scene draws
 * about 30 frames a second while something flies or fades, checks 8 times a second while it only blinks and twinkles and
 * paints only when that changed the picture, and draws nothing when nothing moves, the window is hidden or the scene
 * has gone. With motion reduced, or `held` for a capture, nothing flies: owls appear and fade, and the scene holds still.
 */
export function WatcherNightScene({ shown, held, owls, onOpen, onShowWatched }: {
  /** Whether the scene shows: the room is open on Conversation or Watched. When it turns false the scene fades and stops. */
  readonly shown: boolean
  /** A capture's fixed clock: the scene draws its settled picture and holds it. */
  readonly held: boolean
  /** The threads Watcher watches, one owl each. */
  readonly owls: readonly WatchedOwl[]
  readonly onOpen: OpenThread
  /** The "+N" pile's press: the Watched view, where every watched thread is. */
  readonly onShowWatched: () => void
}): ReactNode {
  // Named `say` here, since `t` is the scene's clock.
  const { t: say } = useLingui()
  const reduced = useReducedMotion()
  const still = reduced || held
  const [phase, setPhase] = useState<'shown' | 'leaving' | 'gone'>(shown ? 'shown' : 'gone')
  const [targets, setTargets] = useState<readonly Target[]>([])
  const [tip, setTip] = useState<Target | null>(null)
  const origin = useRef<number | null>(null)
  // The owls and where Watcher's owl sits outlive the scene stepping away, as for Visualize: it comes back with every
  // owl where it was.
  const kept = useRef<{ family: OwlFamily | null; watcher: WatcherOwlState }>({ family: null, watcher: { at: 'home', side: 'left', flight: null, next: 0 } })
  const stillRef = useRef(still)
  const owlsRef = useRef(owls)
  const leaving = useRef(phase === 'leaving')
  const wakeRef = useRef<() => void>(() => undefined)
  const takeOwlsRef = useRef<() => void>(() => undefined)
  const settleRef = useRef<() => void>(() => undefined)
  const back = useRef<HTMLCanvasElement>(null)
  const front = useRef<HTMLCanvasElement>(null)
  const probe = useRef<HTMLElement>(null)

  useEffect(() => {
    if (shown) { setPhase('shown'); return }
    setPhase(current => current === 'gone' ? 'gone' : 'leaving')
    const timer = window.setTimeout(() => setPhase('gone'), SCENE_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [shown])
  useEffect(() => { leaving.current = phase === 'leaving' }, [phase])
  useEffect(() => { stillRef.current = still; settleRef.current(); wakeRef.current() }, [still])
  useEffect(() => { owlsRef.current = owls; takeOwlsRef.current() }, [owls])
  // A tip goes with its owl when the owl leaves, and takes the owl's new words and place while it stays.
  useEffect(() => { setTip(current => current === null ? null : targets.find(target => target.key === current.key) ?? null) }, [targets])
  // A tip that is showing answers Escape, as everything that opens does.
  useEffect(() => {
    if (tip === null) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setTip(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [tip])

  const mounted = phase !== 'gone'
  useEffect(() => {
    const land = back.current, owl = front.current, ink = probe.current
    const pane = land?.parentElement
    // Without layout (a test's DOM) there is nothing to measure, so nothing is drawn.
    if (!mounted || land == null || owl == null || ink == null || pane == null || typeof ResizeObserver === 'undefined') return
    const pixelCanvas = document.createElement('canvas')
    pixelCanvas.width = 1; pixelCanvas.height = 1
    const pixel = pixelCanvas.getContext('2d', { willReadFrequently: true })
    if (pixel === null) return
    const painter = new NightScenePainter(land, owl)
    let disposed = false
    let timer: number | null = null
    let request: number | null = null
    let layoutRequest: number | null = null
    let measured = ''
    // The room as last measured with the composer full, which the scene keeps while the composer is slim.
    let fullRoom: SceneMeasure | null = null
    let inked = ''
    let layout: SceneLayout | null = null
    let family: OwlFamily | null = kept.current.family
    let watcher: WatcherOwlState = kept.current.watcher
    let ripples: Ripple[] = []
    let look: Look | null = null
    let stage: OwlStage | null = null
    let targetKey = ''
    /** When the last frame started, and how long after it the next is due; null while nothing moves. */
    let last = Number.NEGATIVE_INFINITY
    let delay: number | null = 0
    // An end-to-end run counts the frames painted on the pane, so a test can tell drawing from holding still, and the
    // layouts, so a test can tell the scene holding still from laying itself out again.
    let frames = 0
    let layouts = 0
    const counted = window.sottoE2E !== undefined
    origin.current ??= performance.now()
    const clock = (): number => (performance.now() - origin.current!) / 1000
    const motion = (): FamilyMotion => stillRef.current && held ? 'still' : stillRef.current || layout?.mode !== 'trees' ? 'fade' : 'fly'

    /** Stops every frame and layout already asked for. */
    const halt = (): void => {
      if (timer !== null) { window.clearTimeout(timer); timer = null }
      if (request !== null) { cancelAnimationFrame(request); request = null }
    }
    /** The next frame, paced from when the last one started. */
    const schedule = (): void => {
      if (delay === null || disposed) return
      const sleep = frameSleep(performance.now(), last, delay)
      if (sleep > 0) timer = window.setTimeout(() => { timer = null; request = requestAnimationFrame(frame) }, sleep)
      else request = requestAnimationFrame(frame)
    }
    /** Watcher's owl between frames: a finished flight lands, and a due one sets off. */
    const stepWatcher = (t: number): void => {
      if (layout?.mode !== 'trees' || stillRef.current) return
      const flight = watcher.flight
      if (flight !== null && t >= flight.t0 + flight.dur) watcher = { at: flight.to, side: flight.side, flight: null, next: t + stayAt(flight.to, Math.random()) }
      if (watcher.flight === null && t >= watcher.next) {
        const next = planFlight(layout, watcher, nextPlace(watcher.at, Math.random(), layout.lane === null), t)
        watcher = { ...watcher, flight: next }
      }
    }
    const tipBelow = (top: number): boolean => top - TIP_HEIGHT - 6 < (layout?.header ?? 0)
    /** The perched thread owls' buttons, and the pile's, changed only when they move or their words do. */
    const syncTargets = (t: number, poses: readonly ThreadOwlPose[], pile: SceneFrame['pile']): void => {
      if (family === null) return
      const byKey = new Map(family.owls.map(item => [item.key, item] as const))
      const next: Target[] = []
      for (const box of painter.targets(poses, t, stillRef.current)) {
        const item = byKey.get(box.key)
        if (item === undefined || item.threadId === null) continue
        next.push({ key: item.key, box, title: item.title, words: i18n._(MOOD_WORDS[item.mood]), open: { threadId: item.threadId, atRequest: item.mood === 'waiting' }, below: tipBelow(box.y) })
      }
      if (pile !== null) {
        const w = pileLabel(pile.count, layout?.mode === 'rail').length * 7 + 10
        const x = Math.max(0, Math.min((layout?.width ?? w) - w, pile.spot.x - w / 2))
        const more = pile.count
        next.push({ key: 'pile', box: { x, y: pile.spot.y - 16, w, h: 18 }, title: i18n._(msg`${more} more`), words: i18n._(msg`Press to see every watched thread on Watched.`), open: null, below: tipBelow(pile.spot.y - 16) })
      }
      const key = next.map(item => `${item.key}:${item.box.x}:${item.box.y}:${item.title}:${item.words}`).join('|')
      if (key !== targetKey) { targetKey = key; setTargets(next) }
    }
    const frame = (now: number): void => {
      request = null
      if (disposed || document.visibilityState === 'hidden' || !painter.ready || layout === null || family === null) return
      // Display frames come at the display's own rate; the scene draws only on the ones that are due.
      if (delay === null || !frameDue(now, last, delay)) { if (delay !== null) request = requestAnimationFrame(frame); return }
      last = now
      const t = clock(), isStill = stillRef.current
      family.step(t)
      stepWatcher(t)
      ripples = liveRipples(ripples, t, isStill)
      const trees = layout.mode === 'trees'
      const owlNow = trees ? owlAt(t, layout, watcher, { still: isStill, look, watch: family.newcomer(t) }) : null
      const marker = family.marker, count = family.pileCount, poses = family.poses(t)
      const pile = marker !== null && count > 0 ? { spot: marker, count } : null
      const painted = painter.draw({ t, still: isStill, ripples, watcher: owlNow, owls: poses, whirl: family.whirl(t), pile })
      if (painted && counted) pane.dataset.nightSceneFrames = String(++frames)
      // And what it drew behind the words over the column, so a test can see a ripple or an owl crossing under them.
      if (painted && counted) pane.dataset.nightSceneBehind = `${painter.behind.ripple},${painter.behind.owl}`
      const nextStage = owlNow?.stage ?? 'perched'
      if (nextStage !== stage) { stage = nextStage; owl.dataset.owl = stage }
      syncTargets(t, poses, pile)
      const looking = look !== null && t - look.t < 1.8
      // At rest only the trees' stars and owls, or the rail's waking and glowing eyes, change; with neither, nothing waits.
      const restless = layout.mode === 'trees' || (layout.mode === 'rail' && family.owls.some(item => item.mood !== 'asleep'))
      delay = frameDelay(family.moving(t) || owlNow?.stage === 'flying' || looking, ripples.length, isStill || !restless)
      schedule()
    }
    /** Draws the next frame now, rather than when the current pace would. */
    const wake = (): void => {
      if (disposed) return
      if (timer !== null) { window.clearTimeout(timer); timer = null }
      delay = 0
      last = Number.NEGATIVE_INFINITY
      if (request === null) request = requestAnimationFrame(frame)
    }
    wakeRef.current = wake
    /** The room's watched threads as they are now: newcomers come out of the moon, and the moon ripples as they do. */
    const takeOwls = (): void => {
      if (disposed || family === null || layout === null) return
      const t = clock()
      for (const at of family.update(owlsRef.current, t, motion())) ripples = addRipple(ripples, { x: layout.moon.x, y: layout.moon.y, t: at })
      wake()
    }
    takeOwlsRef.current = takeOwls
    /** Motion reduced or restored: every flight ends where it was going, and owls come and go the new way from now. */
    const settle = (): void => {
      if (disposed || family === null || layout === null) return
      const t = clock()
      family.relayout(layout, t)
      if (watcher.flight !== null) watcher = { at: watcher.flight.to, side: watcher.flight.side, flight: null, next: t + stayAt(watcher.flight.to, Math.random()) }
      ripples = []
      takeOwls()
    }
    settleRef.current = settle

    const readInk = (): void => {
      const style = getComputedStyle(ink)
      // Every colour the conversation's words can take, each with its opacity: the text, its secondary tier (the names and
      // times take it there), and links at rest and pointed at (the probe's borders, nightScene.css).
      const text = toRgb(style.color, pixel), accent = toRgb(style.backgroundColor, pixel), surface = surfaceOf(pane, pixel)
      if (text === null || accent === null || surface === null) return
      const present = (word: Word | null): word is Word => word !== null
      const words = [toWord(style.color, pixel), toWord(style.borderTopColor, pixel), toWord(style.borderRightColor, pixel), toWord(style.borderBottomColor, pixel)].filter(present)
      // The glass composer's own words, its text, secondary and muted tiers, and its card (the probe's outline).
      const card = toRgb(style.outlineColor, pixel)
      const cardWords = [toWord(style.color, pixel), toWord(style.borderTopColor, pixel), toWord(style.borderLeftColor, pixel)].filter(present)
      const key = JSON.stringify([text, accent, words, card, cardWords, surface, style.fontFamily])
      if (key === inked) return
      inked = key
      const scene = sceneInk(surface, text, accent, words)
      painter.setInk(scene, style.fontFamily)
      // The glass is as thick as its words need over pure white or pure black, so nothing passing under it, a picture in
      // the conversation included, takes a word on it under 4.5:1. It stays set when the scene steps away.
      if (card !== null) pane.style.setProperty('--watcher-glass', `${Math.round(glassOpacity(card, cardWords) * 100)}%`)
      // An end-to-end run reads the column's ceiling off the pane, to report it beside the contrast it measures.
      if (counted) pane.dataset.nightSceneCap = JSON.stringify(scene.column)
      wake()
    }
    const relayout = (): void => {
      layoutRequest = null
      if (disposed) return
      // While the composer's card moves between slim and full its box is neither: the scene keeps its layout and looks
      // again next frame, until the card has settled.
      const card = pane.querySelector<HTMLElement>(':scope > .thread-workspace__compose > .thread-prompt')
      if (card !== null && slimMoving(card)) { scheduleLayout(); return }
      const room = measureRoom(pane)
      if (card?.parentElement?.hasAttribute('data-slim') !== true) fullRoom = room
      const measure = heldRoom(room, fullRoom)
      const dpr = window.devicePixelRatio || 1
      const key = measure === null ? '' : JSON.stringify([measure, dpr])
      if (key === measured) return
      measured = key
      observeParts()
      const next = measure === null ? null : painter.resize(measure, dpr)
      if (next === null) {
        // No composer to set the column by, such as a first entry whose composer went with the last model, or the room
        // between one Watcher and the next: the scene keeps its last frame, and no frame is asked for, until the room can
        // be measured again.
        painter.invalidate()
        halt()
        layout = null
        delete owl.dataset.owl
        stage = null
        targetKey = ''
        setTargets([])
        return
      }
      const t = clock()
      layout = next
      if (counted) pane.dataset.nightSceneLayouts = String(++layouts)
      // A new layout ends every flight where it was going.
      if (watcher.flight !== null) watcher = { at: watcher.flight.to, side: watcher.flight.side, flight: null, next: watcher.next }
      if (next.mode !== 'trees') watcher = { at: 'home', side: 'left', flight: null, next: watcher.next }
      if (watcher.next === 0) watcher = { ...watcher, next: t + stayAt('home', Math.random()) }
      ripples = []
      if (family === null) { family = new OwlFamily(next); family.update(owlsRef.current, t, motion()) }
      else {
        // Back from stepping away, or a new size: every owl keeps its spot, and threads watched or let go meanwhile
        // come and go now.
        family.relayout(next, t)
        takeOwls()
      }
      readInk()
      // Laying out cleared the canvases: the scene is drawn again in this same frame, so it never shows blank.
      halt()
      delay = 0
      last = Number.NEGATIVE_INFINITY
      frame(performance.now())
    }
    const scheduleLayout = (): void => { if (layoutRequest === null && !disposed) layoutRequest = requestAnimationFrame(relayout) }

    const sizes = new ResizeObserver(scheduleLayout)
    // The message scrubber sets its lane's place in its own style after a resize, which may come after the scene's
    // measure, so the lane is watched for that too (ADR-0109).
    const laneMoves = new MutationObserver(scheduleLayout)
    const observeParts = (): void => {
      sizes.disconnect()
      laneMoves.disconnect()
      sizes.observe(pane)
      for (const part of pane.querySelectorAll('.thread-workspace__compose, .thread-workspace__compose .thread-prompt, :scope > .watcher-glance, :scope > .watcher-head')) sizes.observe(part)
      const lane = pane.querySelector('.message-scrubber')
      if (lane !== null) { sizes.observe(lane); laneMoves.observe(lane, { attributes: true, attributeFilter: ['style'] }) }
    }
    // The composer and what stands on it come and go; typing in the composer is left to the size watch, and the
    // conversation's words, which the scene never follows, are left alone.
    const parts = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element && record.target.closest('.thread-prompt, .thread-workspace__transcript')))) scheduleLayout()
    })
    parts.observe(pane, { childList: true, subtree: true })
    // A theme or mode change repaints the scene in the new inks.
    const theme = new MutationObserver(readInk)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-theme-id'] })
    const visibility = (): void => { if (document.visibilityState !== 'hidden') wake() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('resize', scheduleLayout)
    // Moving to a display with other scaling changes the pixel ratio but not always the window's size.
    const unwatchResolution = watchResolution(scheduleLayout)

    // A press in the open margin sends out a ripple, and Watcher's owl looks toward it.
    const press = (event: PointerEvent): void => {
      if (leaving.current || event.button !== 0 || !painter.ready || layout === null || layout.mode !== 'trees') return
      if (!(event.target instanceof Element) || event.target.closest(NOT_BACKGROUND) !== null) return
      const base = pane.getBoundingClientRect()
      const x = event.clientX - base.left, y = event.clientY - base.top + pane.scrollTop, t = clock()
      if (!inMargin(layout, x) || y < layout.header) return
      ripples = addRipple(liveRipples(ripples, t, stillRef.current), { x, y, t })
      look = { x, y, t }
      wake()
    }
    pane.addEventListener('pointerdown', press)

    // The glyph face may still be loading; the scene is drawn again once it has.
    const font = `10.5px ${getComputedStyle(ink).fontFamily}`
    void document.fonts?.load(font).then(() => { if (!disposed) { inked = ''; readInk() } }, () => undefined)
    relayout()

    return () => {
      disposed = true
      kept.current = { family, watcher }
      wakeRef.current = () => undefined
      takeOwlsRef.current = () => undefined
      settleRef.current = () => undefined
      halt()
      if (layoutRequest !== null) cancelAnimationFrame(layoutRequest)
      unwatchResolution()
      sizes.disconnect(); laneMoves.disconnect(); parts.disconnect(); theme.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('resize', scheduleLayout)
      pane.removeEventListener('pointerdown', press)
      setTargets([])
      setTip(null)
    }
    // `held` is a capture's, fixed for the room's life.
  }, [mounted, held])

  if (!mounted) return null
  const fading = phase === 'leaving' || undefined
  // The tip is centred over its owl, held clear of the pane's edges by half its widest.
  const paneWidth = back.current?.parentElement?.clientWidth ?? Number.POSITIVE_INFINITY
  const tipStyle = tip === null ? undefined
    : { left: `${Math.max(TIP_HALF, Math.min(paneWidth - TIP_HALF, tip.box.x + tip.box.w / 2))}px`, top: `${tip.below ? tip.box.y + tip.box.h : tip.box.y}px` } as CSSProperties
  return <>
    <canvas ref={back} className="watcher-scene watcher-scene--land" data-leaving={fading} aria-hidden="true" />
    <canvas ref={front} className="watcher-scene watcher-scene--owl" data-leaving={fading} aria-hidden="true" />
    {/* The owls' buttons answer the pointer only; Watched is the keyboard's way to the same threads. */}
    <div className="watcher-scene watcher-scene--owls" data-leaving={fading} aria-hidden="true">
      {targets.map(target => { const title = target.title; return <button key={target.key} type="button" tabIndex={-1} className="watcher-scene__owl" data-pile={target.open === null || undefined}
        aria-label={target.open === null ? say`Show every watched thread` : say`Open ${title} beside Watcher`}
        style={{ left: target.box.x, top: target.box.y, width: target.box.w, height: target.box.h }}
        onPointerEnter={() => setTip(target)} onPointerLeave={() => setTip(current => current?.key === target.key ? null : current)}
        onClick={event => {
          setTip(null)
          if (target.open === null) { onShowWatched(); return }
          onOpen(target.open.threadId, { atRequest: target.open.atRequest, inThreads: event.shiftKey, from: event.currentTarget })
        }} /> })}
    </div>
    {tip !== null ? <div className="watcher-scene__tip" data-below={tip.below || undefined} style={tipStyle} aria-hidden="true"><b>{tip.title}</b><span>{tip.words}</span></div> : null}
    <i ref={probe} className="watcher-scene__ink" aria-hidden="true" />
  </>
}
