import React, { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AArrowDown, AArrowUp, ArrowUpRight, Circle, Move, PenLine, Redo2, Square, Type, Undo2, X } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { chordClaimed, chordMatches } from './branchToolbar.logic'
import { useOptionalApp } from '../state/AppContext'
import type { SottoPlatform } from '../../../shared/platform'
import { rootStyleUnchanged } from '../state/appearance'
import { arrowGeometry, inkColours, madeMark, markAt, markBounds, markHandles, moveMarks, movingWith, nextNoteScale, resizeMark, sameInks, settleNote, markedCopy, markRedraws, MARKUP_INKS, MARKUP_TOOLS, noteBaseline, noteEdgeWidth, noteFont, NOTE_MAX_LENGTH, NOTE_SCALES, penWidth, strokeWidth,
  type EditorTool, type InkColours, type MarkHandle, type MarkupShape, type MarkInk, type MarkupSize, type NoteShape } from './markup'
import type { ReplyAttach } from './replyAttach'
import type { AgentMediaCallout } from '../../../shared/agentActivity'
import { CalloutLayer, CalloutNotes, calloutColours, drawCallouts } from './callouts'
import './markup.css'

const TOOL_WORDS: Readonly<Record<EditorTool, MessageDescriptor>> = { move: msg`Move`, arrow: msg`Arrow`, ellipse: msg`Circle`, box: msg`Box`, pen: msg`Pen`, note: msg`Note` }
const TOOL_ICONS: Readonly<Record<EditorTool, ReactNode>> = {
  move: <Move size={16} aria-hidden="true" />, arrow: <ArrowUpRight size={16} aria-hidden="true" />, ellipse: <Circle size={16} aria-hidden="true" />, box: <Square size={16} aria-hidden="true" />,
  pen: <PenLine size={16} aria-hidden="true" />, note: <Type size={16} aria-hidden="true" />,
}
const INK_WORDS: Readonly<Record<MarkInk, MessageDescriptor>> = { red: msg`Red ink`, amber: msg`Amber ink`, plain: msg`Plain ink` }

/** One mark already made. Memoized, so drawing the next one never redraws it. */
const MarkShape = memo(function MarkShape({ mark, size, colours }: { readonly mark: MarkupShape; readonly size: MarkupSize; readonly colours: InkColours }): ReactNode {
  markRedraws.count += 1
  return <LiveShape mark={mark} size={size} colours={colours} />
})

/** A mark as SVG in the picture's own pixels: the one being drawn, or, through MarkShape, one already made. */
function LiveShape({ mark, size, colours }: { readonly mark: MarkupShape; readonly size: MarkupSize; readonly colours: InkColours }): ReactNode {
  const ink = colours.stroke[mark.ink], line = strokeWidth(size)
  const common = { stroke: ink, strokeWidth: line, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (mark.tool === 'box') {
    return <rect data-markup-shape="" x={Math.min(mark.x0, mark.x1)} y={Math.min(mark.y0, mark.y1)} width={Math.abs(mark.x1 - mark.x0)} height={Math.abs(mark.y1 - mark.y0)} rx={line * 2} {...common} />
  }
  if (mark.tool === 'ellipse') {
    return <ellipse data-markup-shape="" cx={(mark.x0 + mark.x1) / 2} cy={(mark.y0 + mark.y1) / 2} rx={Math.abs(mark.x1 - mark.x0) / 2} ry={Math.abs(mark.y1 - mark.y0) / 2} {...common} />
  }
  if (mark.tool === 'arrow') {
    const { shaft, head } = arrowGeometry(mark, size)
    return <g data-markup-shape=""><line x1={mark.x0} y1={mark.y0} x2={shaft[0]} y2={shaft[1]} {...common} /><polygon points={head.map(point => point.join(',')).join(' ')} fill={ink} /></g>
  }
  if (mark.tool === 'pen') {
    // A pen's line widens where it pressed harder, so it is drawn a piece at a time; a mouse's is one path.
    if (!mark.pressure) return <polyline data-markup-shape="" points={mark.points.map(([x, y]) => `${x},${y}`).join(' ')} {...common} />
    return <g data-markup-shape="">{mark.points.slice(1).map(([x, y], index) => {
      const [fromX, fromY, pressure] = mark.points[index]!
      return <line key={index} x1={fromX} y1={fromY} x2={x} y2={y} {...common} strokeWidth={penWidth(mark, pressure, size)} />
    })}</g>
  }
  if (mark.tool !== 'note') return null
  return <text data-markup-shape="" x={mark.x0} y={noteBaseline(mark, size)} fill={ink} stroke={colours.noteEdge[mark.ink]} strokeWidth={noteEdgeWidth(mark, size)} strokeLinejoin="round" paintOrder="stroke"
    style={{ font: noteFont(size, mark.scale) }}>{mark.text}</text>
}

/** What a drag is changing right now, kept outside React's state so a move redraws only the layer that shows it. */
interface LiveValue<T> { readonly get: () => T | null; readonly set: (value: T | null) => void; readonly subscribe: (listener: () => void) => () => void }
function useLiveValue<T>(): LiveValue<T> {
  const [store] = useState<LiveValue<T>>(() => {
    let value: T | null = null
    const listeners = new Set<() => void>()
    return { get: () => value, set: next => { value = next; for (const listener of listeners) listener() }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  })
  return store
}
function LiveLayer({ live, size, colours }: { readonly live: LiveValue<MarkupShape>; readonly size: MarkupSize; readonly colours: InkColours }): ReactNode {
  const mark = useSyncExternalStore(live.subscribe, live.get)
  return mark ? <LiveShape mark={mark} size={size} colours={colours} /> : null
}

/**
 * The marks already made, as a drag has them right now, with the selected one's outline. Marks a drag leaves alone stay
 * the same objects, so nothing redraws them. The outline and its handles are the editor's, and no copy carries them.
 */
function MarksLayer({ marks, moved, selected, unit, size, colours }: {
  readonly marks: readonly MarkupShape[]
  readonly moved: LiveValue<readonly MarkupShape[]>
  readonly selected: number | null
  /** The picture's pixels to one on screen, so the outline and its handles keep their size. */
  readonly unit: number
  readonly size: MarkupSize
  readonly colours: InkColours
}): ReactNode {
  const shown = useSyncExternalStore(moved.subscribe, moved.get) ?? marks
  const mark = selected === null ? null : shown.find(item => item.id === selected) ?? null
  const holder = mark?.tool === 'note' && mark.on !== null ? shown.find(item => item.id === mark.on) ?? null : null
  const around = (item: MarkupShape, className: string): ReactNode => {
    const box = markBounds(item, size), pad = 6 * unit
    return <rect className={className} x={box.x - pad} y={box.y - pad} width={box.width + pad * 2} height={box.height + pad * 2} fill="none" />
  }
  return <>
    {shown.map(item => <MarkShape key={item.id} mark={item} size={size} colours={colours} />)}
    {mark ? around(mark, 'markup-editor__selected') : null}
    {holder ? around(holder, 'markup-editor__holder') : null}
    {mark ? markHandles(mark, size).map(({ handle, x, y }) => <circle key={handle} className="markup-editor__handle" cx={x} cy={y} r={5 * unit} />) : null}
  </>
}

/** What a mark is called in the list of marks: a note says the mark it sits on. */
function useMarkWords(): (mark: MarkupShape, marks: readonly MarkupShape[]) => string {
  const { t } = useLingui()
  return (mark, marks) => {
    if (mark.tool === 'pen') return t`Pen line`
    if (mark.tool !== 'note') return t(TOOL_WORDS[mark.tool])
    const holder = mark.on === null ? null : marks.find(item => item.id === mark.on)?.tool
    if (holder === 'box') return t({ message: `Note on the box: ${mark.text}`, comment: 'A note the user wrote on a box drawn on a picture, with its words.' })
    if (holder === 'ellipse') return t({ message: `Note on the circle: ${mark.text}`, comment: 'A note the user wrote on a circle drawn on a picture, with its words.' })
    if (holder === 'arrow') return t({ message: `Note on the arrow: ${mark.text}`, comment: 'A note the user wrote on an arrow drawn on a picture, with its words.' })
    if (holder === 'pen') return t({ message: `Note on the pen line: ${mark.text}`, comment: 'A note the user wrote on a pen line drawn on a picture, with its words.' })
    return t({ message: `Note: ${mark.text}`, comment: 'A note the user wrote on a picture, with its words.' })
  }
}

/** A drag under way: a mark being drawn, marks being moved, or a selected mark being resized by a handle. */
type Gesture =
  | { readonly kind: 'draw'; readonly pointerId: number }
  | { readonly kind: 'move'; readonly pointerId: number; readonly fromX: number; readonly fromY: number; readonly base: readonly MarkupShape[]; readonly moving: ReadonlySet<number>; readonly lead: number; readonly reach: number; readonly travelled: boolean }
  | { readonly kind: 'resize'; readonly pointerId: number; readonly base: readonly MarkupShape[]; readonly id: number; readonly handle: MarkHandle }

interface History { readonly past: readonly (readonly MarkupShape[])[]; readonly marks: readonly MarkupShape[]; readonly future: readonly (readonly MarkupShape[])[] }

/**
 * Marks a picture up (ADR-0170, part 5): arrow, circle, box, pen and note, in red, amber or the theme's own text colour,
 * with Undo and Redo, and the marks listed beside the picture where each can be taken off. Add to reply puts a copy with
 * the marks drawn on it into the pane's reply box, the way a pasted screenshot goes in; the picture in the thread stays
 * as it was. A pen draws a line as wide as it presses. From the keyboard, the picture takes focus and Enter starts a
 * mark at the cross, the arrow keys move it, and Enter ends it. The agent's callouts on the picture (part 6) are drawn
 * under the marks and listed beside them; Show hides them while marking, and Keep them in the copy decides whether the
 * copy carries them. The Move tool selects a mark, which can then be dragged, resized by its handles, sized if it is
 * text, or deleted; the drawing tools only ever draw, so a stroke across a mark stays a stroke. Text on a mark belongs to
 * it and follows it, and text off every mark is free (part 5, November 3).
 */
export function MarkupEditor({ name, source, size, reply, onCancel, onAdded, callouts, calloutsHeading }: {
  readonly name: string
  /** The picture the viewer already holds; the editor reads nothing more. */
  readonly source: string
  readonly size: MarkupSize
  readonly reply: ReplyAttach
  readonly onCancel: () => void
  readonly onAdded: () => void
  /** The callouts the agent placed on the picture, and the heading that says whose they are. */
  readonly callouts?: readonly AgentMediaCallout[] | undefined
  readonly calloutsHeading?: string | undefined
}): ReactNode {
  const { t } = useLingui()
  const markWords = useMarkWords()
  const root = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const firstTool = useRef<HTMLButtonElement>(null)
  const titleId = useId(), hintId = useId()
  const [tool, setTool] = useState<EditorTool>('arrow')
  const [ink, setInk] = useState<MarkInk>('red')
  const [history, setHistory] = useState<History>({ past: [], marks: [], future: [] })
  const live = useLiveValue<MarkupShape>()
  const moved = useLiveValue<readonly MarkupShape[]>()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selected = selectedId === null ? null : history.marks.find(mark => mark.id === selectedId) ?? null
  /** The size the next note is set in, and the last the user chose. */
  const [noteScale, setNoteScale] = useState(1)
  const [cross, setCross] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const [note, setNote] = useState<{ readonly x: number; readonly y: number; readonly reach: number } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [fit, setFit] = useState<{ readonly width: number; readonly height: number } | null>(null)
  const [colours, setColours] = useState<InkColours | null>(null)
  const [showCallouts, setShowCallouts] = useState(true)
  const [keepCallouts, setKeepCallouts] = useState(true)
  /** The callouts the copy carries: shown and kept, as the user sees them. */
  const kept = callouts?.length && showCallouts && keepCallouts ? callouts : null
  const nextId = useRef(1)
  const gesture = useRef<Gesture | null>(null)
  /** The mark the arrow keys are changing, how, and the marks they last made, so a run of presses of one kind with nothing between is one step of Undo. */
  const nudged = useRef<{ readonly id: number; readonly kind: 'move' | 'resize'; readonly marks: readonly MarkupShape[] } | null>(null)
  const app = useOptionalApp()
  const platform: SottoPlatform = app?.platform ?? ((window.sotto as { platform?: SottoPlatform } | undefined)?.platform ?? 'win32')
  const hotkey = app?.settings?.hotkey
  const chords = useMemo(() => ({
    undo: chordClaimed('mod+z', hotkey, platform) ? 'mod+z' : null,
    redo: chordClaimed('mod+shift+z', hotkey, platform) ? 'mod+shift+z' : null,
    add: chordClaimed('mod+enter', hotkey, platform) ? 'mod+enter' : null,
  }), [hotkey, platform])
  const sized = useMemo(() => ({ width: size.width, height: size.height }), [size.width, size.height])
  const longer = Math.max(sized.width, sized.height)

  useLayoutEffect(() => { firstTool.current?.focus() }, [])
  // The inks are the theme's: read when the editor opens, and again whenever the theme or the appearance changes.
  useLayoutEffect(() => {
    const page = document.documentElement
    const read = (): void => { if (root.current) { const next = inkColours(root.current); setColours(current => sameInks(current, next) ? current : next) } }
    read()
    if (typeof MutationObserver === 'undefined') return
    // The theme inspector swaps roles for sentinels and back within a task; that batch changed nothing (ADR-0011).
    const observer = new MutationObserver(records => { if (!rootStyleUnchanged(records, page)) read() })
    observer.observe(page, { attributes: true, attributeOldValue: true, attributeFilter: ['data-theme', 'data-theme-id', 'style'] })
    return () => observer.disconnect()
  }, [])
  // The picture fills the room it has at its own shape, and follows the window.
  useLayoutEffect(() => {
    const room = wrap.current
    if (!room) return
    const measure = (): void => {
      const width = room.clientWidth, height = room.clientHeight
      if (!width || !height) { setFit(null); return }
      const scale = Math.min(width / sized.width, height / sized.height)
      setFit({ width: sized.width * scale, height: sized.height * scale })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(room)
    return () => observer.disconnect()
  }, [sized])

  const commit = (mark: MarkupShape): void => {
    if (!madeMark(mark, sized)) return
    setHistory(current => ({ past: [...current.past, current.marks], marks: [...current.marks, mark], future: [] }))
    setStatus(null)
  }
  const undo = (): void => setHistory(current => current.past.length ? { past: current.past.slice(0, -1), marks: current.past.at(-1)!, future: [current.marks, ...current.future] } : current)
  const redo = (): void => setHistory(current => current.future.length ? { past: [...current.past, current.marks], marks: current.future[0]!, future: current.future.slice(1) } : current)
  const marksList = useRef<HTMLUListElement>(null)
  /** Where the focus goes once a mark's Remove button goes with it: the next mark's, the last one's, or the picture. */
  const [refocus, setRefocus] = useState<number | null>(null)
  /** Takes a mark off, and the notes on it with it; Undo brings them all back. */
  const remove = (id: number, moveFocus = true): void => {
    if (moveFocus) setRefocus(Math.max(0, history.marks.findIndex(mark => mark.id === id)))
    setHistory(current => ({ past: [...current.past, current.marks], marks: current.marks.filter(mark => mark.id !== id && !(mark.tool === 'note' && mark.on === id)), future: [] }))
    if (selectedId === id) setSelectedId(null)
  }
  /** Puts in place what a drag or a key made of the marks, as one step of Undo. */
  const record = (next: readonly MarkupShape[]): void => { setHistory(current => ({ past: [...current.past, current.marks], marks: next, future: [] })) }
  /** The same for the arrow keys, where a run of presses moving or resizing one mark is one step. */
  const recordNudge = (id: number, kind: 'move' | 'resize', next: readonly MarkupShape[]): void => {
    const again = nudged.current?.id === id && nudged.current.kind === kind && nudged.current.marks === history.marks
    nudged.current = { id, kind, marks: next }
    setHistory(again ? { ...history, marks: next, future: [] } : { past: [...history.past, history.marks], marks: next, future: [] })
  }
  const pickTool = (next: EditorTool): void => {
    setTool(next)
    if (next !== 'move') setSelectedId(null)
    const picture = surface.current
    if (!picture) return
    delete picture.dataset.cursor
    if (next !== 'move' && !cross && document.activeElement === picture) setCross({ x: sized.width / 2, y: sized.height / 2 })
  }
  useLayoutEffect(() => {
    if (refocus === null) return
    setRefocus(null)
    const buttons = marksList.current?.querySelectorAll<HTMLElement>('.markup-editor__remove')
    const next = buttons?.[Math.min(refocus, buttons.length - 1)]
    if (next) next.focus(); else surface.current?.focus()
  }, [refocus])
  const begin = (x: number, y: number, pressure: number | null): MarkupShape => {
    const id = nextId.current++
    return tool === 'pen' ? { id, ink, tool: 'pen', points: [[x, y, pressure ?? 0.5]], pressure: pressure !== null }
      : { id, ink, tool: tool as 'arrow' | 'ellipse' | 'box', x0: x, y0: y, x1: x, y1: y }
  }
  const extend = (mark: MarkupShape, x: number, y: number, pressure: number | null): MarkupShape =>
    mark.tool === 'pen' ? { ...mark, points: [...mark.points, [x, y, pressure ?? 0.5]] } : mark.tool === 'note' ? mark : { ...mark, x1: x, y1: y }
  const clamp = (x: number, y: number): { readonly x: number; readonly y: number } => ({ x: Math.min(sized.width, Math.max(0, x)), y: Math.min(sized.height, Math.max(0, y)) })
  const place = (event: React.PointerEvent): { readonly x: number; readonly y: number } => {
    const box = surface.current!.getBoundingClientRect()
    return clamp((event.clientX - box.left) / (box.width || 1) * sized.width, (event.clientY - box.top) / (box.height || 1) * sized.height)
  }

  /** The picture's pixels to one on screen. */
  const unit = sized.width / (fit?.width || sized.width)
  /** The picture's pixels to one on screen, as the surface is laid out now. */
  const onScreen = (): number => sized.width / (surface.current!.getBoundingClientRect().width || sized.width)
  /** How near a press must be to count as on a line, in the picture's pixels: farther for a finger. */
  const reachOf = (event: React.PointerEvent): number => (event.pointerType === 'touch' ? 18 : 9) * onScreen()
  /** The selected mark's handle at a place, if any. */
  const handleAt = (x: number, y: number, event: React.PointerEvent): MarkHandle | null => {
    if (!selected) return null
    const grip = (event.pointerType === 'touch' ? 22 : 12) * onScreen()
    return markHandles(selected, sized).find(item => Math.hypot(item.x - x, item.y - y) <= grip)?.handle ?? null
  }
  const dropGesture = (): void => {
    gesture.current = null; live.set(null); moved.set(null)
    if (surface.current) delete surface.current.dataset.cursor
  }
  // A drag keeps what it makes of the marks it began on. If they change under it, by Undo or Delete say, the change
  // wins and the drag stops, or letting go would bring back what was just taken away.
  useLayoutEffect(() => {
    const current = gesture.current
    if (current && current.kind !== 'draw' && current.base !== history.marks) dropGesture()
  }, [history.marks])

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0 || note) return
    event.preventDefault()
    surface.current?.setPointerCapture?.(event.pointerId)
    const { x, y } = place(event)
    if (tool === 'move') {
      const handle = handleAt(x, y, event)
      if (handle && selected) { gesture.current = { kind: 'resize', pointerId: event.pointerId, base: history.marks, id: selected.id, handle }; return }
      const reach = reachOf(event)
      const mark = markAt(history.marks, x, y, reach, sized)
      setSelectedId(mark?.id ?? null)
      setStatus(null)
      if (mark) gesture.current = { kind: 'move', pointerId: event.pointerId, fromX: x, fromY: y, base: history.marks, moving: movingWith(history.marks, mark.id), lead: mark.id, reach, travelled: false }
      return
    }
    gesture.current = { kind: 'draw', pointerId: event.pointerId }
    if (tool === 'note') return
    live.set(begin(x, y, event.pointerType === 'pen' ? event.pressure : null))
  }
  const onPointerMove = (event: React.PointerEvent): void => {
    const current = gesture.current
    if (!current) {
      // The pointer says what a press would do: pick the mark up, or take its handle.
      if (tool !== 'move' || event.pointerType === 'touch' || !surface.current) return
      const { x, y } = place(event)
      surface.current.dataset.cursor = handleAt(x, y, event) ? 'handle' : markAt(history.marks, x, y, reachOf(event), sized) ? 'grab' : ''
      return
    }
    if (current.pointerId !== event.pointerId) return
    const { x, y } = place(event)
    if (current.kind === 'move') {
      const travelled = current.travelled || Math.hypot(x - current.fromX, y - current.fromY) > current.reach / 4
      if (!travelled) return
      if (!current.travelled) gesture.current = { ...current, travelled }
      if (surface.current) surface.current.dataset.cursor = 'grabbing'
      moved.set(moveMarks(current.base, current.moving, x - current.fromX, y - current.fromY, sized))
      return
    }
    if (current.kind === 'resize') {
      const next = resizeMark(current.base, current.id, current.handle, x, y, sized)
      if (next) moved.set(next)
      return
    }
    if (tool === 'note') return
    const mark = live.get()
    if (mark) live.set(extend(mark, x, y, event.pointerType === 'pen' ? event.pressure : null))
  }
  /** Keeps what a move or a resize came to. A note let go takes up with whatever is under it now. */
  const finishMove = (current: Extract<Gesture, { kind: 'move' | 'resize' }>): void => {
    const shown = moved.get()
    if (surface.current) delete surface.current.dataset.cursor
    if (!shown) return
    if (current.kind === 'resize') { record(shown); moved.set(null); return }
    record(settleMoved(shown, current.base, current.lead, current.reach))
    moved.set(null)
  }
  /** `marks` with a note that moved on whatever is under it now, and says so if that changed. */
  const settleMoved = (marks: readonly MarkupShape[], before: readonly MarkupShape[], id: number, reach: number): readonly MarkupShape[] => {
    const settled = settleNote(marks, id, reach, sized)
    const now = settled.find(mark => mark.id === id), then = before.find(mark => mark.id === id)
    if (now?.tool === 'note' && then?.tool === 'note' && now.on !== then.on) setStatus(noteMoved(now, settled))
    return settled
  }
  /** Says where a note let go has ended up, since nothing else shows it took up with a mark or left one. */
  const noteMoved = (mark: NoteShape, marks: readonly MarkupShape[]): string => {
    const holder = mark.on === null ? null : marks.find(item => item.id === mark.on)?.tool
    if (holder === 'box') return t`The note now moves with the box.`
    if (holder === 'ellipse') return t`The note now moves with the circle.`
    if (holder === 'arrow') return t`The note now moves with the arrow.`
    if (holder === 'pen') return t`The note now moves with the pen line.`
    return t`The note is free now. It stays where you put it.`
  }
  const onPointerUp = (event: React.PointerEvent): void => {
    const current = gesture.current
    if (current?.pointerId !== event.pointerId) return
    gesture.current = null
    if (current.kind !== 'draw') { finishMove(current); return }
    const { x, y } = place(event)
    if (tool === 'note') { setNote({ x, y, reach: reachOf(event) }); return }
    const mark = live.get()
    live.set(null)
    if (mark) commit(extend(mark, x, y, event.pointerType === 'pen' ? event.pressure : null))
  }

  /** The Move tool's keys on the picture: Enter steps through the marks, the arrow keys move the selected one, and Alt with them resizes it. */
  const onMoveKeyDown = (event: React.KeyboardEvent, by: readonly [number, number] | undefined): boolean => {
    if (by) {
      event.preventDefault(); event.stopPropagation()
      if (!selected) return true
      if (!event.altKey) {
        const next = moveMarks(history.marks, movingWith(history.marks, selected.id), by[0], by[1], sized)
        recordNudge(selected.id, 'move', settleMoved(next, history.marks, selected.id, 9 * unit))
        return true
      }
      // The dictation hotkey keeps its chord: Alt with that arrow resizes nothing.
      if (!chordClaimed(`${event.shiftKey ? 'shift+' : ''}alt+${event.key.toLowerCase().replace('arrow', '')}`, hotkey, platform)) return true
      const corner = markHandles(selected, sized).find(item => item.handle === 'end' || item.handle === 'bottom-right')
      const resized = corner && resizeMark(history.marks, selected.id, corner.handle, Math.min(sized.width, Math.max(0, corner.x + by[0])), Math.min(sized.height, Math.max(0, corner.y + by[1])), sized)
      if (resized) recordNudge(selected.id, 'resize', resized)
      return true
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation()
      const marks = history.marks
      if (marks.length === 0) { setStatus(t`Nothing to select yet. Draw on the picture first.`); return true }
      const next = marks[(marks.findIndex(mark => mark.id === selectedId) + 1) % marks.length]!
      setSelectedId(next.id)
      const words = markWords(next, marks)
      setStatus(t({ message: `Selected ${words}.`, comment: '{words} names a mark on a picture, such as "Arrow" or "Note: the button".' }))
      return true
    }
    return false
  }
  const onSurfaceKeyDown = (event: React.KeyboardEvent): void => {
    const step = (event.shiftKey ? 8 : 1) * longer / 100
    const moves: Record<string, readonly [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const move = moves[event.key]
    if (tool === 'move') { onMoveKeyDown(event, move); return }
    const at = cross ?? { x: sized.width / 2, y: sized.height / 2 }
    if (move) {
      event.preventDefault(); event.stopPropagation()
      const next = clamp(at.x + move[0], at.y + move[1])
      setCross(next)
      const current = live.get()
      if (current) live.set(extend(current, next.x, next.y, null))
      return
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation()
      const current = live.get()
      if (current) { live.set(null); commit(current); return }
      if (tool === 'note') { setNote({ ...at, reach: 9 * unit }); return }
      live.set(begin(at.x, at.y, null))
      return
    }
    if (event.key === 'Escape' && live.get()) { event.preventDefault(); event.stopPropagation(); live.set(null) }
  }

  /** Whether A− and A+ have text to size: the selected note, or the next one while Note is picked. */
  const sizedNote = selected?.tool === 'note' ? selected : null
  const sizing = tool === 'note' || sizedNote !== null
  const currentScale = sizedNote?.scale ?? noteScale
  const stepNoteSize = (by: -1 | 1): void => {
    if (!sizing) return
    const scale = nextNoteScale(currentScale, by)
    setNoteScale(scale)
    if (sizedNote && scale !== sizedNote.scale) {
      record(moveMarks(history.marks.map(mark => mark === sizedNote ? { ...sizedNote, scale } : mark), new Set([sizedNote.id]), 0, 0, sized))
    }
  }

  const add = async (): Promise<void> => {
    if (adding) return
    if (history.marks.length === 0 && !kept) { setStatus(t`Draw on the picture first. Nothing was added.`); return }
    const refusal = reply.refusal()
    if (refusal) { setStatus(refusal); return }
    setAdding(true); setStatus(t`Adding the marked copy…`)
    // The copy takes the inks as the theme has them now.
    const host = root.current!
    const made = kept ? markedCopy(source, name, history.marks, inkColours(host), (context, drawnSize) => drawCallouts(context, kept, drawnSize, calloutColours(host)))
      : markedCopy(source, name, history.marks, inkColours(host))
    const copy = await made.catch(() => null)
    const refused = copy ? await reply.add([copy]) : t`Could not make the marked copy. Nothing was added, and your marks are still here. Try again.`
    setAdding(false)
    if (refused) { setStatus(refused); return }
    onAdded()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.target as Element).closest?.('.markup-editor__note-input')) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      // A drag stops first, then the selection lets go, and only then does the editor cancel.
      if (gesture.current) { dropGesture(); return }
      if (selected) { setSelectedId(null); setStatus(null); return }
      onCancel()
      return
    }
    if (chords.redo && chordMatches(event, chords.redo, platform)) { event.preventDefault(); event.stopPropagation(); redo(); return }
    if (chords.undo && chordMatches(event, chords.undo, platform)) { event.preventDefault(); event.stopPropagation(); undo(); return }
    if (chords.add && chordMatches(event, chords.add, platform)) { event.preventDefault(); event.stopPropagation(); void add(); return }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected) { event.preventDefault(); event.stopPropagation(); remove(selected.id, false); return }
    if (event.key === '-' || event.key === '=' || event.key === '+') { event.preventDefault(); event.stopPropagation(); stepNoteSize(event.key === '-' ? -1 : 1); return }
    const picked = MARKUP_TOOLS.find(item => item.key === event.key.toLowerCase())
    if (picked) { event.preventDefault(); event.stopPropagation(); pickTool(picked.tool) }
  }

  const marks = history.marks
  const smallestSize = currentScale <= NOTE_SCALES[0]!, largestSize = currentScale >= NOTE_SCALES.at(-1)!
  const modKey = platform === 'darwin' ? 'Command' : 'Ctrl'
  return <div ref={root} className="markup-editor" role="group" aria-labelledby={titleId} aria-describedby={hintId} onKeyDown={onKeyDown}>
    <header className="markup-editor__bar" role="toolbar" aria-label={t`Mark-up tools`}>
      <h2 id={titleId} className="markup-editor__title">{t({ message: `Mark up ${name}`, comment: '{name} is the file name of a picture.' })}</h2>
      <div className="markup-editor__tools">
        {MARKUP_TOOLS.map(item => {
          const label = t(TOOL_WORDS[item.tool])
          return <button key={item.tool} ref={item.tool === 'arrow' ? firstTool : undefined} type="button" className="markup-editor__tool tt-focusable" aria-pressed={tool === item.tool}
            title={`${label} (${item.key.toUpperCase()})`} onClick={() => pickTool(item.tool)}>{TOOL_ICONS[item.tool]}<span>{label}</span></button>
        })}
      </div>
      <span className="markup-editor__divider" aria-hidden="true" />
      <div className="markup-editor__inks" role="radiogroup" aria-label={t`Ink`}>
        {MARKUP_INKS.map(item => <button key={item} type="button" role="radio" className={`markup-editor__ink markup-editor__ink--${item} tt-focusable`} aria-checked={ink === item}
          aria-label={t(INK_WORDS[item])} title={t(INK_WORDS[item])} onClick={() => setInk(item)} />)}
      </div>
      <span className="markup-editor__divider" aria-hidden="true" />
      <div className="markup-editor__size" role="group" aria-label={t`Text size`}>
        <button type="button" className="markup-editor__tool markup-editor__tool--icon tt-focusable" aria-disabled={!sizing || smallestSize} aria-label={t`Make the text smaller`} title={t`Make the text smaller (-)`} onClick={() => stepNoteSize(-1)}><AArrowDown size={16} aria-hidden="true" /></button>
        <button type="button" className="markup-editor__tool markup-editor__tool--icon tt-focusable" aria-disabled={!sizing || largestSize} aria-label={t`Make the text larger`} title={t`Make the text larger (=)`} onClick={() => stepNoteSize(1)}><AArrowUp size={16} aria-hidden="true" /></button>
      </div>
      <span className="markup-editor__divider" aria-hidden="true" />
      <button type="button" className="markup-editor__tool markup-editor__tool--undo tt-focusable" aria-disabled={history.past.length === 0} title={t`Undo (${modKey}+Z)`} onClick={undo}><Undo2 size={16} aria-hidden="true" /><span>{t`Undo`}</span></button>
      <button type="button" className="markup-editor__tool markup-editor__tool--icon tt-focusable" aria-disabled={history.future.length === 0} aria-label={t`Redo`} title={t`Redo (${modKey}+Shift+Z)`} onClick={redo}><Redo2 size={16} aria-hidden="true" /></button>
      <span className="markup-editor__space" />
      <button type="button" className="markup-editor__action tt-focusable" onClick={onCancel} title={t`Cancel (Esc)`}>{t`Cancel`}</button>
      <button type="button" className="markup-editor__action markup-editor__action--primary tt-focusable" aria-disabled={adding || (marks.length === 0 && !kept)} title={t`Add to reply (${modKey}+Enter)`} onClick={() => void add()}>{t`Add to reply`}</button>
    </header>
    <div className="markup-editor__body">
      <div ref={wrap} className="markup-editor__room">
        <div ref={surface} className={`markup-editor__surface tt-focusable${tool === 'move' ? ' markup-editor__surface--move' : ''}`} role="application" tabIndex={0}
          aria-label={t({ message: `Picture to mark up: ${name}`, comment: '{name} is the file name of a picture.' })} aria-describedby={hintId}
          style={fit ? { width: fit.width, height: fit.height } : { aspectRatio: `${sized.width} / ${sized.height}` }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={dropGesture}
          onFocus={() => { if (!cross && tool !== 'move') setCross({ x: sized.width / 2, y: sized.height / 2 }) }} onBlur={() => { if (!live.get()) setCross(null) }} onKeyDown={onSurfaceKeyDown}>
          <img src={source} alt="" draggable={false} decoding="async" />
          {colours ? <svg viewBox={`0 0 ${sized.width} ${sized.height}`} preserveAspectRatio="none" aria-hidden="true">
            {callouts?.length && showCallouts ? <CalloutLayer callouts={callouts} size={sized} /> : null}
            <MarksLayer marks={marks} moved={moved} selected={selected?.id ?? null} unit={unit} size={sized} colours={colours} />
            <LiveLayer live={live} size={sized} colours={colours} />
            {cross && tool !== 'move' ? <g className="markup-editor__cross"><line x1={cross.x - longer / 60} y1={cross.y} x2={cross.x + longer / 60} y2={cross.y} strokeWidth={longer / 600} />
              <line x1={cross.x} y1={cross.y - longer / 60} x2={cross.x} y2={cross.y + longer / 60} strokeWidth={longer / 600} /></g> : null}
          </svg> : null}
          {note ? <NoteInput at={note} size={sized} onDone={text => {
            setNote(null)
            if (text) {
              const id = nextId.current++
              // The words stay on the picture, however near its edge they were pressed.
              const placed = moveMarks([{ id, ink, tool: 'note', x0: note.x, y0: note.y, text, scale: noteScale, on: null }], new Set([id]), 0, 0, sized)[0]!
              commit(settleNote([...marks, placed], id, note.reach, sized).at(-1)!)
            }
            surface.current?.focus()
          }} /> : null}
        </div>
      </div>
      <aside className="markup-editor__side" aria-label={callouts?.length ? t`Callouts and your marks` : t`Your marks`}>
        {callouts?.length ? <section className="markup-editor__callouts">
          <div className="markup-editor__callouts-head">
            <h3 className="markup-editor__heading">{calloutsHeading ?? t`Callouts`}</h3>
            <label className="markup-editor__option"><input type="checkbox" checked={showCallouts} onChange={event => setShowCallouts(event.currentTarget.checked)} />{t`Show`}</label>
          </div>
          <CalloutNotes callouts={callouts} />
        </section> : null}
        <h3 className="markup-editor__heading">{t`Your marks`}</h3>
        {marks.length === 0
          ? <p className="markup-editor__empty tt-paragraph">{t`None yet. Draw on the picture.`}</p>
          : <ul ref={marksList} className="markup-editor__marks">{marks.map(mark => {
            const words = markWords(mark, marks)
            return <li key={mark.id} className={selected?.id === mark.id ? 'markup-editor__mark--selected' : undefined}>
              <button type="button" className="markup-editor__select tt-focusable" aria-pressed={selected?.id === mark.id} aria-label={t({ message: `Select ${words}`, comment: '{words} names a mark, such as "Arrow" or "Note: the button".' })}
                onClick={() => { pickTool('move'); setSelectedId(selected?.id === mark.id ? null : mark.id); surface.current?.focus() }}>
                <span className={`markup-editor__swatch markup-editor__ink--${mark.ink}`} aria-hidden="true" /><span className="markup-editor__mark-name">{words}</span></button>
              <button type="button" className="markup-editor__remove tt-focusable" aria-label={t({ message: `Remove ${words}`, comment: '{words} names a mark, such as "Arrow" or "Note: the button".' })}
                title={t`Remove`} onClick={() => remove(mark.id)}><X size={13} aria-hidden="true" /></button></li>
          })}</ul>}
        {callouts?.length ? <label className="markup-editor__option markup-editor__keep">
          <input type="checkbox" checked={keepCallouts && showCallouts} disabled={!showCallouts} onChange={event => setKeepCallouts(event.currentTarget.checked)} />
          {t`Keep the callouts in the copy`}</label> : null}
        <p className="markup-editor__copy-note tt-paragraph">{t`The marked copy goes into your reply. The picture in the thread stays as it was.`}</p>
      </aside>
    </div>
    <p className="markup-editor__status" role="status" aria-live="polite">{status}</p>
    <p id={hintId} className="markup-editor__hint tt-paragraph">{tool === 'move'
      ? t`Drag a mark to move it, or a handle to resize it. On the picture, Enter steps through the marks, the arrow keys move the selected one, and Alt with them resizes it. Delete takes it off, minus and equals size text, and Escape lets go.`
      : t`Drag to draw. Press where a note goes, then type. V, A, O, B, P and T pick a tool. On the picture, Enter starts a mark at the cross, the arrow keys move it, and Enter ends it. Minus and equals size a note. Escape cancels.`}</p>
  </div>
}

/** Where a note's words are typed: at the press, Enter keeps them, Escape drops them. */
function NoteInput({ at, size, onDone }: { readonly at: { readonly x: number; readonly y: number }; readonly size: MarkupSize; readonly onDone: (text: string) => void }): ReactNode {
  const { t } = useLingui()
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { input.current?.focus() }, [])
  const finish = (text: string): void => { if (done.current) return; done.current = true; onDone(text.trim()) }
  return <input ref={input} className="markup-editor__note-input" maxLength={NOTE_MAX_LENGTH} aria-label={t`Note`} placeholder={t`Type a note`}
    style={{ left: `${at.x / size.width * 100}%`, top: `${at.y / size.height * 100}%` }}
    onKeyDown={event => {
      // The editor's own keys stop here; Tab goes on to the viewer, which keeps the focus inside it.
      if (event.key !== 'Tab') event.stopPropagation()
      if (event.key === 'Enter') { event.preventDefault(); finish(event.currentTarget.value) }
      if (event.key === 'Escape') { event.preventDefault(); finish('') }
    }}
    onBlur={event => finish(event.currentTarget.value)} />
}
