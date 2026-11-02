import React, { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowUpRight, Circle, PenLine, Redo2, Square, Type, Undo2, X } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { chordClaimed, chordMatches } from './branchToolbar.logic'
import { useOptionalApp } from '../state/AppContext'
import type { SottoPlatform } from '../../../shared/platform'
import { rootStyleUnchanged } from '../state/appearance'
import { arrowGeometry, inkColours, madeMark, sameInks, markedCopy, markRedraws, MARKUP_INKS, MARKUP_TOOLS, noteBox, noteFont, NOTE_MAX_LENGTH, noteTextWidth, penWidth, strokeWidth,
  type InkColours, type MarkupShape, type MarkInk, type MarkTool, type MarkupSize } from './markup'
import type { ReplyAttach } from './replyAttach'
import './markup.css'

const TOOL_WORDS: Readonly<Record<MarkTool, MessageDescriptor>> = { arrow: msg`Arrow`, ellipse: msg`Circle`, box: msg`Box`, pen: msg`Pen`, note: msg`Note` }
const TOOL_ICONS: Readonly<Record<MarkTool, ReactNode>> = {
  arrow: <ArrowUpRight size={16} aria-hidden="true" />, ellipse: <Circle size={16} aria-hidden="true" />, box: <Square size={16} aria-hidden="true" />,
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
  const box = noteBox(mark, size, noteTextWidth(mark.text, size))
  return <g data-markup-shape=""><rect x={box.x} y={box.y} width={box.width} height={box.height} rx={box.radius} fill={ink} />
    <text x={box.textX} y={box.textY} fill={colours.noteText[mark.ink]} style={{ font: noteFont(size) }}>{mark.text}</text></g>
}

/** The mark being drawn, kept outside React's state so a move redraws only the layer that shows it. */
interface LiveMark { readonly get: () => MarkupShape | null; readonly set: (mark: MarkupShape | null) => void; readonly subscribe: (listener: () => void) => () => void }
function useLiveMark(): LiveMark {
  const [store] = useState<LiveMark>(() => {
    let value: MarkupShape | null = null
    const listeners = new Set<() => void>()
    return { get: () => value, set: next => { value = next; for (const listener of listeners) listener() }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  })
  return store
}
function LiveLayer({ live, size, colours }: { readonly live: LiveMark; readonly size: MarkupSize; readonly colours: InkColours }): ReactNode {
  const mark = useSyncExternalStore(live.subscribe, live.get)
  return mark ? <LiveShape mark={mark} size={size} colours={colours} /> : null
}

/** What a mark is called in the list of marks. */
function useMarkWords(): (mark: MarkupShape) => string {
  const { t } = useLingui()
  return mark => mark.tool === 'note' ? t({ message: `Note: ${mark.text}`, comment: 'A note the user wrote on a picture, with its words.' })
    : mark.tool === 'pen' ? t`Pen line` : t(TOOL_WORDS[mark.tool])
}

interface History { readonly past: readonly (readonly MarkupShape[])[]; readonly marks: readonly MarkupShape[]; readonly future: readonly (readonly MarkupShape[])[] }

/**
 * Marks a picture up (ADR-0170, part 5): arrow, circle, box, pen and note, in red, amber or the theme's own text colour,
 * with Undo and Redo, and the marks listed beside the picture where each can be taken off. Add to reply puts a copy with
 * the marks drawn on it into the pane's reply box, the way a pasted screenshot goes in; the picture in the thread stays
 * as it was. A pen draws a line as wide as it presses. From the keyboard, the picture takes focus and Enter starts a
 * mark at the cross, the arrow keys move it, and Enter ends it.
 */
export function MarkupEditor({ name, source, size, reply, onCancel, onAdded }: {
  readonly name: string
  /** The picture the viewer already holds; the editor reads nothing more. */
  readonly source: string
  readonly size: MarkupSize
  readonly reply: ReplyAttach
  readonly onCancel: () => void
  readonly onAdded: () => void
}): ReactNode {
  const { t } = useLingui()
  const markWords = useMarkWords()
  const root = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const firstTool = useRef<HTMLButtonElement>(null)
  const titleId = useId(), hintId = useId()
  const [tool, setTool] = useState<MarkTool>('arrow')
  const [ink, setInk] = useState<MarkInk>('red')
  const [history, setHistory] = useState<History>({ past: [], marks: [], future: [] })
  const live = useLiveMark()
  const [cross, setCross] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const [note, setNote] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [fit, setFit] = useState<{ readonly width: number; readonly height: number } | null>(null)
  const [colours, setColours] = useState<InkColours | null>(null)
  const nextId = useRef(1)
  const drawing = useRef<{ readonly pointerId: number } | null>(null)
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
  const remove = (id: number): void => {
    setRefocus(Math.max(0, history.marks.findIndex(mark => mark.id === id)))
    setHistory(current => ({ past: [...current.past, current.marks], marks: current.marks.filter(mark => mark.id !== id), future: [] }))
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
    return tool === 'pen' ? { id, ink, tool, points: [[x, y, pressure ?? 0.5]], pressure: pressure !== null }
      : { id, ink, tool: tool as 'arrow' | 'ellipse' | 'box', x0: x, y0: y, x1: x, y1: y }
  }
  const extend = (mark: MarkupShape, x: number, y: number, pressure: number | null): MarkupShape =>
    mark.tool === 'pen' ? { ...mark, points: [...mark.points, [x, y, pressure ?? 0.5]] } : mark.tool === 'note' ? mark : { ...mark, x1: x, y1: y }
  const clamp = (x: number, y: number): { readonly x: number; readonly y: number } => ({ x: Math.min(sized.width, Math.max(0, x)), y: Math.min(sized.height, Math.max(0, y)) })
  const place = (event: React.PointerEvent): { readonly x: number; readonly y: number } => {
    const box = surface.current!.getBoundingClientRect()
    return clamp((event.clientX - box.left) / (box.width || 1) * sized.width, (event.clientY - box.top) / (box.height || 1) * sized.height)
  }

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0 || note) return
    event.preventDefault()
    surface.current?.setPointerCapture?.(event.pointerId)
    const { x, y } = place(event)
    drawing.current = { pointerId: event.pointerId }
    if (tool === 'note') return
    live.set(begin(x, y, event.pointerType === 'pen' ? event.pressure : null))
  }
  const onPointerMove = (event: React.PointerEvent): void => {
    if (drawing.current?.pointerId !== event.pointerId || tool === 'note') return
    const { x, y } = place(event)
    const current = live.get()
    if (current) live.set(extend(current, x, y, event.pointerType === 'pen' ? event.pressure : null))
  }
  const onPointerUp = (event: React.PointerEvent): void => {
    if (drawing.current?.pointerId !== event.pointerId) return
    drawing.current = null
    const { x, y } = place(event)
    if (tool === 'note') { setNote({ x, y }); return }
    const current = live.get()
    live.set(null)
    if (current) commit(extend(current, x, y, event.pointerType === 'pen' ? event.pressure : null))
  }

  const onSurfaceKeyDown = (event: React.KeyboardEvent): void => {
    const step = (event.shiftKey ? 8 : 1) * longer / 100
    const moves: Record<string, readonly [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const move = moves[event.key]
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
      if (tool === 'note') { setNote(at); return }
      live.set(begin(at.x, at.y, null))
      return
    }
    if (event.key === 'Escape' && live.get()) { event.preventDefault(); event.stopPropagation(); live.set(null) }
  }

  const add = async (): Promise<void> => {
    if (adding) return
    if (history.marks.length === 0) { setStatus(t`Draw on the picture first. Nothing was added.`); return }
    const refusal = reply.refusal()
    if (refusal) { setStatus(refusal); return }
    setAdding(true); setStatus(t`Adding the marked copy…`)
    // The copy takes the inks as the theme has them now.
    const copy = await markedCopy(source, name, history.marks, inkColours(root.current!)).catch(() => null)
    const refused = copy ? await reply.add([copy]) : t`Could not make the marked copy. Nothing was added, and your marks are still here. Try again.`
    setAdding(false)
    if (refused) { setStatus(refused); return }
    onAdded()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.target as Element).closest?.('.markup-editor__note-input')) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return }
    if (chords.redo && chordMatches(event, chords.redo, platform)) { event.preventDefault(); event.stopPropagation(); redo(); return }
    if (chords.undo && chordMatches(event, chords.undo, platform)) { event.preventDefault(); event.stopPropagation(); undo(); return }
    if (chords.add && chordMatches(event, chords.add, platform)) { event.preventDefault(); event.stopPropagation(); void add(); return }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const picked = MARKUP_TOOLS.find(item => item.key === event.key.toLowerCase())
    if (picked) { event.preventDefault(); event.stopPropagation(); setTool(picked.tool) }
  }

  const marks = history.marks
  const modKey = platform === 'darwin' ? 'Command' : 'Ctrl'
  return <div ref={root} className="markup-editor" role="group" aria-labelledby={titleId} aria-describedby={hintId} onKeyDown={onKeyDown}>
    <header className="markup-editor__bar" role="toolbar" aria-label={t`Mark-up tools`}>
      <h2 id={titleId} className="markup-editor__title">{t({ message: `Mark up ${name}`, comment: '{name} is the file name of a picture.' })}</h2>
      <div className="markup-editor__tools">
        {MARKUP_TOOLS.map((item, index) => {
          const label = t(TOOL_WORDS[item.tool])
          return <button key={item.tool} ref={index === 0 ? firstTool : undefined} type="button" className="markup-editor__tool tt-focusable" aria-pressed={tool === item.tool}
            title={`${label} (${item.key.toUpperCase()})`} onClick={() => setTool(item.tool)}>{TOOL_ICONS[item.tool]}<span>{label}</span></button>
        })}
      </div>
      <span className="markup-editor__divider" aria-hidden="true" />
      <div className="markup-editor__inks" role="radiogroup" aria-label={t`Ink`}>
        {MARKUP_INKS.map(item => <button key={item} type="button" role="radio" className={`markup-editor__ink markup-editor__ink--${item} tt-focusable`} aria-checked={ink === item}
          aria-label={t(INK_WORDS[item])} title={t(INK_WORDS[item])} onClick={() => setInk(item)} />)}
      </div>
      <span className="markup-editor__divider" aria-hidden="true" />
      <button type="button" className="markup-editor__tool tt-focusable" aria-disabled={history.past.length === 0} title={t`Undo (${modKey}+Z)`} onClick={undo}><Undo2 size={16} aria-hidden="true" /><span>{t`Undo`}</span></button>
      <button type="button" className="markup-editor__tool markup-editor__tool--icon tt-focusable" aria-disabled={history.future.length === 0} aria-label={t`Redo`} title={t`Redo (${modKey}+Shift+Z)`} onClick={redo}><Redo2 size={16} aria-hidden="true" /></button>
      <span className="markup-editor__space" />
      <button type="button" className="markup-editor__action tt-focusable" onClick={onCancel} title={t`Cancel (Esc)`}>{t`Cancel`}</button>
      <button type="button" className="markup-editor__action markup-editor__action--primary tt-focusable" aria-disabled={adding || marks.length === 0} title={t`Add to reply (${modKey}+Enter)`} onClick={() => void add()}>{t`Add to reply`}</button>
    </header>
    <div className="markup-editor__body">
      <div ref={wrap} className="markup-editor__room">
        <div ref={surface} className="markup-editor__surface tt-focusable" role="application" tabIndex={0}
          aria-label={t({ message: `Picture to mark up: ${name}`, comment: '{name} is the file name of a picture.' })} aria-describedby={hintId}
          style={fit ? { width: fit.width, height: fit.height } : { aspectRatio: `${sized.width} / ${sized.height}` }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drawing.current = null; live.set(null) }}
          onFocus={() => { if (!cross) setCross({ x: sized.width / 2, y: sized.height / 2 }) }} onBlur={() => { if (!live.get()) setCross(null) }} onKeyDown={onSurfaceKeyDown}>
          <img src={source} alt="" draggable={false} decoding="async" />
          {colours ? <svg viewBox={`0 0 ${sized.width} ${sized.height}`} preserveAspectRatio="none" aria-hidden="true">
            {marks.map(mark => <MarkShape key={mark.id} mark={mark} size={sized} colours={colours} />)}
            <LiveLayer live={live} size={sized} colours={colours} />
            {cross ? <g className="markup-editor__cross"><line x1={cross.x - longer / 60} y1={cross.y} x2={cross.x + longer / 60} y2={cross.y} strokeWidth={longer / 600} />
              <line x1={cross.x} y1={cross.y - longer / 60} x2={cross.x} y2={cross.y + longer / 60} strokeWidth={longer / 600} /></g> : null}
          </svg> : null}
          {note ? <NoteInput at={note} size={sized} onDone={text => {
            setNote(null)
            if (text) commit({ id: nextId.current++, ink, tool: 'note', x0: note.x, y0: note.y, text })
            surface.current?.focus()
          }} /> : null}
        </div>
      </div>
      <aside className="markup-editor__side" aria-label={t`Your marks`}>
        <h3 className="markup-editor__heading">{t`Your marks`}</h3>
        {marks.length === 0
          ? <p className="markup-editor__empty tt-paragraph">{t`None yet. Draw on the picture.`}</p>
          : <ul ref={marksList} className="markup-editor__marks">{marks.map(mark => {
            const words = markWords(mark)
            return <li key={mark.id}><span className={`markup-editor__swatch markup-editor__ink--${mark.ink}`} aria-hidden="true" /><span className="markup-editor__mark-name">{words}</span>
              <button type="button" className="markup-editor__remove tt-focusable" aria-label={t({ message: `Remove ${words}`, comment: '{words} names a mark, such as "Arrow" or "Note: the button".' })}
                title={t`Remove`} onClick={() => remove(mark.id)}><X size={13} aria-hidden="true" /></button></li>
          })}</ul>}
        <p className="markup-editor__copy-note tt-paragraph">{t`The marked copy goes into your reply. The picture in the thread stays as it was.`}</p>
      </aside>
    </div>
    <p className="markup-editor__status" role="status" aria-live="polite">{status}</p>
    <p id={hintId} className="markup-editor__hint tt-paragraph">{t`Drag to draw. Press where a note goes, then type. A, O, B, P and T pick a tool. On the picture, Enter starts a mark at the cross, the arrow keys move it, and Enter ends it. Escape cancels.`}</p>
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
      event.stopPropagation()
      if (event.key === 'Enter') { event.preventDefault(); finish(event.currentTarget.value) }
      if (event.key === 'Escape') { event.preventDefault(); finish('') }
    }}
    onBlur={event => finish(event.currentTarget.value)} />
}
