import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Columns3, GripVertical, LayoutGrid, Maximize2, Minimize2, X } from 'lucide-react'
import type { ProviderId } from '../../../shared/agents'
import { ProviderMark } from './ProviderMark'
import {
  DIVIDER_WIDTH, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, PANE_DRAG_TYPE, RESIZE_STEP, THREAD_DRAG_TYPE,
  displayFractions, dividerRange, evenDivider, fitsArea, gridShape, isSplit, movePane, paneShape, placements, resizeDivider, setArrangement, setZoomed, slotOf, snapBoundary,
  type AxisPlacement, type DividerPlacement, type SplitLayout,
} from './splitLayout'
import './splitWorkspace.css'

export type DropTarget = { readonly kind: 'side'; readonly side: 'start' | 'end' } | { readonly kind: 'pane'; readonly index: number } | { readonly kind: 'add' } | { readonly kind: 'open' }

/** What the grid needs to know about a pane's content to name it in tabs, controls and announcements. */
export interface PaneLabel {
  readonly title: string
  readonly providerId: ProviderId | undefined
  readonly provider: string
}

export interface ThreadPanesProps {
  /** The arrangement on screen; panes whose thread is missing are already left out. */
  readonly layout: SplitLayout
  /** Pane content IDs (threads or terminals) in pane order. One ID is the single view. */
  readonly paneIds: readonly string[]
  readonly rows: ReadonlyMap<string, PaneLabel>
  /** The group's name; "Thread panes" unless the panes hold something else. */
  readonly label?: string | undefined
  readonly focusedId: string | null
  /** A sidebar thread is being dragged; drop targets appear for it. */
  readonly dragging: string | null
  readonly renderPane: (threadId: string) => ReactNode
  readonly onFocusPane: (threadId: string) => void
  /** A change that only rearranges the view: sizes, order, arrangement or zoom. */
  readonly onLayoutChange: (layout: SplitLayout) => void
  readonly onDrop: (threadId: string, target: DropTarget) => void
  /** Close one pane's view. */
  readonly onClosePane: (threadId: string) => void
  /** Test-only: a fixed pane-area size where layout measurement is unavailable. */
  readonly measuredWidth?: number | undefined
  readonly measuredHeight?: number | undefined
}

const paneDomId = (threadId: string): string => `thread-pane-${threadId}`
const tabDomId = (threadId: string): string => `thread-pane-tab-${threadId}`
/** Clicking or focusing these acts on the layout, not on the pane's thread, so it does not move the selection. */
const CHROME = '[data-pane-chrome]'

/** Put keyboard focus inside a pane: its composer when it can take text, its terminal, otherwise its transcript. */
export function focusInPane(threadId: string): void {
  const pane = document.getElementById(paneDomId(threadId))
  const target = pane?.querySelector<HTMLElement>('.thread-workspace__compose textarea:not(:disabled)') ?? pane?.querySelector<HTMLElement>('.terminal-view textarea, [role="log"]')
  target?.focus()
}

function useSize(fixedWidth: number | undefined, fixedHeight: number | undefined): readonly [React.RefObject<HTMLDivElement | null>, number, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: fixedWidth ?? 0, height: fixedHeight ?? 0 })
  useEffect(() => {
    if (fixedWidth !== undefined) { setSize({ width: fixedWidth, height: fixedHeight ?? 0 }); return }
    const element = ref.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setSize(current => {
      const next = { width: Math.round(element.clientWidth), height: Math.round(element.clientHeight) }
      return next.width === current.width && next.height === current.height ? current : next
    })
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [fixedWidth, fixedHeight])
  return [ref, size.width, size.height] as const
}

/** One axis of a box inside the pane area, sharing the space left after that axis's dividers. */
const offset = (axis: AxisPlacement): string => `calc((100% - ${axis.total * DIVIDER_WIDTH}px) * ${axis.start} + ${axis.dividers * DIVIDER_WIDTH}px)`
const extent = (axis: AxisPlacement): string => `calc((100% - ${axis.total * DIVIDER_WIDTH}px) * ${axis.size})`

/** Every pane's and divider's box as custom properties on the pane area, so a divider drag can move them without a render. */
function boxVariables(shape: readonly number[], rows: readonly number[], columns: readonly (readonly number[])[]): Record<string, string> {
  const placed = placements(shape, rows, columns)
  const variables: Record<string, string> = {}
  for (const pane of placed.panes) {
    variables[`--pane-${pane.index}-x`] = offset(pane.x)
    variables[`--pane-${pane.index}-y`] = offset(pane.y)
    variables[`--pane-${pane.index}-w`] = extent(pane.x)
    variables[`--pane-${pane.index}-h`] = extent(pane.y)
  }
  placed.dividers.forEach((divider, at) => {
    const columnsAxis = divider.target.axis === 'columns'
    variables[`--divider-${at}-x`] = columnsAxis ? offset(divider.x) : '0px'
    variables[`--divider-${at}-y`] = offset(divider.y)
    variables[`--divider-${at}-w`] = columnsAxis ? `${DIVIDER_WIDTH}px` : '100%'
    variables[`--divider-${at}-h`] = columnsAxis ? extent(divider.y) : `${DIVIDER_WIDTH}px`
  })
  return variables
}

const boxStyle = (name: string): CSSProperties => ({ left: `var(--${name}-x)`, top: `var(--${name}-y)`, width: `var(--${name}-w)`, height: `var(--${name}-h)` })

/** The sizes as shown in this area: each set raised to the minimum pane size where the area allows it. */
function shownLayout(layout: SplitLayout, width: number, height: number): SplitLayout {
  if (layout.arrangement === 'row') return { ...layout, sizes: displayFractions(layout.sizes, width, MIN_PANE_WIDTH) }
  return { ...layout, grid: { rows: displayFractions(layout.grid.rows, height, MIN_PANE_HEIGHT), columns: layout.grid.columns.map(row => displayFractions(row, width, MIN_PANE_WIDTH)) } }
}
const gridSizes = (layout: SplitLayout): readonly [readonly number[], readonly (readonly number[])[]] =>
  layout.arrangement === 'row' ? [[1], [layout.sizes]] : [layout.grid.rows, layout.grid.columns]

/**
 * A divider between two panes, or between two rows: drag it, or focus it and use the arrow keys. It settles on an even
 * position when dragged close to one. Enter or a double-click evens its panes.
 */
function PaneDivider({ divider, position, layout, size, label, controls, area, onLayoutChange }: {
  readonly divider: DividerPlacement; readonly position: number; readonly layout: SplitLayout; readonly size: number; readonly label: string; readonly controls: string
  readonly area: React.RefObject<HTMLDivElement | null>; readonly onLayoutChange: (layout: SplitLayout) => void
}): ReactNode {
  const { target } = divider
  const vertical = target.axis === 'columns'
  const drag = useRef<{ readonly pointerId: number; readonly start: number; readonly boundary: number; next: SplitLayout } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [min, max] = dividerRange(layout, target, size)
  const boundary = (vertical ? divider.x.start : divider.y.start)
  const usable = Math.max(1, size - (vertical ? divider.x.total : divider.y.total) * DIVIDER_WIDTH)
  const apply = (next: SplitLayout): void => {
    const element = area.current
    if (element === null) return
    const [rows, columns] = gridSizes(next)
    for (const [name, value] of Object.entries(boxVariables(paneShape(next), rows, columns))) element.style.setProperty(name, value)
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, start: vertical ? event.clientX : event.clientY, boundary, next: layout }
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === null || state.pointerId !== event.pointerId) return
    const wanted = state.boundary + ((vertical ? event.clientX : event.clientY) - state.start) / usable
    const next = resizeDivider(layout, target, snapBoundary(layout, target, Math.min(max, Math.max(min, wanted)), size), size)
    if (next === state.next) return
    state.next = next
    // Move the boxes directly while dragging; the transcripts and composers re-render once on release.
    apply(next)
  }
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === null || state.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (state.next !== layout) onLayoutChange(state.next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter') { event.preventDefault(); onLayoutChange(evenDivider(layout, target)); return }
    const [less, more] = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    const next = event.key === less ? boundary - RESIZE_STEP : event.key === more ? boundary + RESIZE_STEP : event.key === 'Home' ? min : event.key === 'End' ? max : null
    if (next === null) return
    event.preventDefault()
    onLayoutChange(resizeDivider(layout, target, next, size))
  }
  return <div role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'} aria-label={label} aria-controls={controls} tabIndex={0}
    aria-valuemin={Math.round(min * 100)} aria-valuemax={Math.round(max * 100)} aria-valuenow={Math.round(boundary * 100)}
    className="thread-panes__divider tt-focusable" data-axis={target.axis} data-dragging={dragging || undefined} title="Drag to resize · Double-click to even"
    style={boxStyle(`divider-${position}`)}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
    // Capture can be taken away mid-drag (another window activating); the panes stay where the drag had moved them.
    onLostPointerCapture={onPointerEnd}
    onDoubleClick={() => onLayoutChange(evenDivider(layout, target))} onKeyDown={onKeyDown} />
}

function DropZone({ label, name, target, fallback, type, onDrop, style }: {
  readonly label: string; readonly target: DropTarget; readonly fallback: string; readonly type: string; readonly style?: CSSProperties | undefined
  /** The thread that will sit here after the drop, when the arrangement changes under the pointer. */
  readonly name?: string | undefined
  readonly onDrop: (threadId: string, target: DropTarget) => void
}): ReactNode {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent): boolean => event.dataTransfer.types.includes(type)
  return <div className="thread-panes__drop" data-over={over || undefined} data-add={target.kind === 'add' || undefined} aria-hidden="true" style={style}
    onDragEnter={event => { if (accepts(event)) { event.preventDefault(); setOver(true) } }}
    onDragOver={event => { if (accepts(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (!over) setOver(true) } }}
    onDragLeave={() => setOver(false)}
    onDrop={event => {
      if (!accepts(event)) return
      event.preventDefault()
      setOver(false)
      onDrop(event.dataTransfer.getData(type) || fallback, target)
    }}>
    {name ? <span className="thread-panes__drop-name">{name}</span> : null}
    <span className="thread-panes__drop-label">{label}</span>
  </div>
}

/** Boxes for an arrangement at even sizes: where panes would land after a drop. */
const evenBoxes = (shape: readonly number[]): CSSProperties[] => placements(shape, [], []).panes.map(pane => ({ left: offset(pane.x), top: offset(pane.y), width: extent(pane.x), height: extent(pane.y) }))

/** The next pane in reading order from `index` in the direction of an arrow key, following rows in the grid. */
function neighbour(shape: readonly number[], index: number, key: string): number | null {
  const count = shape.reduce((total, row) => total + row, 0)
  if (key === 'ArrowLeft' || (key === 'ArrowUp' && shape.length === 1)) return index > 0 ? index - 1 : null
  if (key === 'ArrowRight' || (key === 'ArrowDown' && shape.length === 1)) return index < count - 1 ? index + 1 : null
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return null
  const { row, column } = slotOf(shape, index)
  const nextRow = row + (key === 'ArrowUp' ? -1 : 1)
  if (nextRow < 0 || nextRow >= shape.length) return null
  const start = shape.slice(0, nextRow).reduce((total, value) => total + value, 0)
  return start + Math.min(column, shape[nextRow]! - 1)
}

/**
 * The pane area. One thread fills it; more snap into a grid (two side by side, a third across the row below,
 * four in a 2-by-2 grid, and on) or a single row, with dividers between them. When the area cannot hold every
 * pane at a usable size, or the user zooms one, only the focused pane shows and tabs switch between them.
 * Every pane stays mounted in a stable order, so moving, hiding or resizing never loses its scroll position,
 * keyboard focus or draft, and the retained arrangement returns when there is room.
 */
export function ThreadPanes({ layout, paneIds, rows, label = 'Thread panes', focusedId, dragging, renderPane, onFocusPane, onLayoutChange, onDrop, onClosePane, measuredWidth, measuredHeight }: ThreadPanesProps): ReactNode {
  const [container, width, height] = useSize(measuredWidth, measuredHeight)
  const area = useRef<HTMLDivElement>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const moveStart = useRef<number | undefined>(undefined)
  const [announcement, setAnnouncement] = useState('')
  /** Scroll offsets and keyboard focus from before a move; React moves pane nodes to keep reading order, and a moved node loses both. */
  const preserved = useRef<{ readonly offsets: readonly (readonly [Element, number, number])[]; readonly active: Element | null } | null>(null)
  const split = isSplit(layout) && paneIds.length >= 2
  const fits = fitsArea(layout, width, height)
  const narrow = split && !fits
  const single = split && (narrow || layout.zoomed)
  const shownId = focusedId !== null && paneIds.includes(focusedId) ? focusedId : paneIds[0] ?? null
  const shape = paneShape(layout)
  const shown = shownLayout(layout, width, height)
  const [shownRows, shownColumns] = gridSizes(shown)
  const placed = split && !single ? placements(shape, shownRows, shownColumns) : null
  const title = (id: string): string => rows.get(id)?.title ?? 'Pane'

  useLayoutEffect(() => {
    const kept = preserved.current
    if (kept === null) return
    preserved.current = null
    for (const [element, top, left] of kept.offsets) { element.scrollTop = top; element.scrollLeft = left }
    if (kept.active instanceof HTMLElement && kept.active.isConnected && document.activeElement !== kept.active) kept.active.focus({ preventScroll: true })
  })

  const change = (next: SplitLayout, message?: string): void => {
    if (next === layout) return
    if (next.panes !== layout.panes) {
      const offsets = [...(container.current?.querySelectorAll('.thread-pane *') ?? [])].filter(element => element.scrollTop > 0 || element.scrollLeft > 0)
      preserved.current = { offsets: offsets.map(element => [element, element.scrollTop, element.scrollLeft] as const), active: document.activeElement }
    }
    onLayoutChange(next)
    if (message) setAnnouncement(message)
  }
  const toggleArrangement = (): void => {
    const next = setArrangement(layout, layout.arrangement === 'row' ? 'grid' : 'row')
    const name = next.arrangement === 'row' ? 'a single row' : 'a grid'
    change(next, fitsArea(next, width, height) ? `Panes arranged in ${name}` : `Panes will be arranged in ${name} when there is room`)
  }
  const toggleZoom = (threadId: string): void => {
    if (!layout.zoomed) onFocusPane(threadId)
    change(setZoomed(layout, !layout.zoomed), layout.zoomed ? 'Showing all panes' : `${title(threadId)} zoomed`)
  }

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? paneIds.length - 1 : null
    if (next === null) return
    event.preventDefault()
    const id = paneIds[(next + paneIds.length) % paneIds.length]!
    onFocusPane(id)
    window.setTimeout(() => document.getElementById(tabDomId(id))?.focus(), 0)
  }
  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>, threadId: string): void => {
    const index = layout.panes.indexOf(threadId)
    const next = neighbour(shape, index, event.key)
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    if (next === null) return
    change(movePane(layout, index, next), `${title(threadId)} moved to pane ${next + 1} of ${layout.panes.length}`)
  }
  const onAreaKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Ctrl+Shift+M zooms the focused pane or returns to the arrangement.
    if (!split || event.key.toLowerCase() !== 'm' || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return
    if (narrow && !layout.zoomed) return
    event.preventDefault()
    if (shownId !== null) toggleZoom(shownId)
  }

  const sidebarDrop = (label: string, target: DropTarget, style?: CSSProperties, key?: string, name?: string): ReactNode =>
    <DropZone key={key} label={label} name={name} target={target} fallback={dragging ?? ''} type={THREAD_DRAG_TYPE} onDrop={onDrop} style={style} />
  const alreadyOpen = dragging !== null && paneIds.includes(dragging)
  const nextShape = layout.arrangement === 'row' ? [paneIds.length + 1] : gridShape(paneIds.length + 1)
  const dropTargets = moving !== null && placed !== null
    ? <div className="thread-panes__drops" data-layout="boxes">
      {placed.panes.map(pane => <DropZone key={pane.index} label="Move here" target={{ kind: 'pane', index: pane.index }} fallback={moving} type={PANE_DRAG_TYPE}
        style={{ left: offset(pane.x), top: offset(pane.y), width: extent(pane.x), height: extent(pane.y) }}
        onDrop={(threadId, target) => {
          setMoving(null)
          if (target.kind === 'pane') change(movePane(layout, layout.panes.indexOf(threadId), target.index), `${title(threadId)} moved to pane ${target.index + 1} of ${layout.panes.length}`)
        }} />)}
    </div>
    : dragging === null ? null
      : paneIds.length === 0 ? <div className="thread-panes__drops">{sidebarDrop('Open here', { kind: 'open' })}</div>
        : !split ? paneIds[0] === dragging ? null : <div className="thread-panes__drops" data-layout="boxes">
          {evenBoxes([2]).map((style, index) => sidebarDrop(index === 0 ? 'Open on the left' : 'Open on the right', { kind: 'side', side: index === 0 ? 'start' : 'end' }, style, String(index)))}
        </div>
          : single || alreadyOpen ? <div className="thread-panes__drops" data-layout="boxes">
            {single
              ? evenBoxes([alreadyOpen ? 1 : 2]).map((style, index) => index === 0
                ? sidebarDrop('Show here', { kind: 'pane', index: Math.max(0, paneIds.indexOf(shownId ?? '')) }, style, 'shown')
                : sidebarDrop('Add as a pane', { kind: 'add' }, style, 'add'))
              : placed!.panes.map(pane => sidebarDrop('Show here', { kind: 'pane', index: pane.index }, { left: offset(pane.x), top: offset(pane.y), width: extent(pane.x), height: extent(pane.y) }, String(pane.index)))}
          </div>
            // The targets preview the arrangement after the drop: every open pane where it will sit, and the slot a new pane snaps into.
            : <div className="thread-panes__drops" data-layout="boxes" data-preview>
              {evenBoxes(nextShape).map((style, index) => index < paneIds.length
                ? sidebarDrop('Show here', { kind: 'pane', index }, style, String(index), title(paneIds[index]!))
                : sidebarDrop('Add here', { kind: 'add' }, style, 'add'))}
            </div>

  if (!paneIds.length) return dropTargets

  const areaStyle = placed ? boxVariables(shape, shownRows, shownColumns) as CSSProperties : undefined
  const multiRow = placed !== null && shape.length > 1
  /**
   * Which pane the window controls sit over, so only it keeps their corner clear: the last pane of the
   * first row in a grid, the shown pane when one pane fills the area, and the only pane otherwise.
   */
  const underControls = placed !== null
    ? placed.panes.find(pane => pane.row === 0 && pane.column === shape[0]! - 1)?.index ?? 0
    : single ? Math.max(0, paneIds.indexOf(shownId ?? '')) : paneIds.length - 1
  // Each divider follows the pane before it in the page, so the tab order runs pane, divider, pane, row by row.
  const dividersAfter = new Map<number, ReactNode[]>()
  placed?.dividers.forEach((divider, position) => {
    const [before, after] = [divider.before.map(index => paneIds[index]!), divider.after.map(index => paneIds[index]!)]
    const label = placed.dividers.length === 1 ? 'Resize panes' : divider.target.axis === 'rows' ? `Resize rows ${divider.target.index + 1} and ${divider.target.index + 2}` : `Resize ${title(before[0]!)} and ${title(after[0]!)}`
    const last = Math.max(...divider.before)
    dividersAfter.set(last, [...dividersAfter.get(last) ?? [], <PaneDivider key={`${divider.target.axis}-${divider.target.axis === 'columns' ? divider.target.row : 0}-${divider.target.index}`} divider={divider} position={position}
      layout={shown} size={divider.target.axis === 'columns' ? width : height} label={label} controls={before.map(paneDomId).join(' ')} area={area}
      onLayoutChange={next => change(next)} />])
  })
  return <div className="thread-panes" ref={container} role="group" aria-label={label} data-split={split || undefined} data-narrow={single || undefined}
    data-zoomed={split && layout.zoomed || undefined} data-rows={multiRow || undefined} data-dragging={dragging !== null || moving !== null || undefined} onKeyDown={onAreaKey}>
    {single ? <div className="thread-panes__tabs" role="tablist" aria-label="Open panes">
      {paneIds.map((id, index) => {
        const paneRow = rows.get(id)
        const selected = id === shownId
        return <button key={id} id={tabDomId(id)} type="button" role="tab" aria-selected={selected} aria-controls={paneDomId(id)} tabIndex={selected ? 0 : -1}
          className="thread-panes__tab tt-focusable" onClick={() => onFocusPane(id)} onKeyDown={event => onTabKey(event, index)}>
          {paneRow ? <ProviderMark provider={paneRow.providerId} name={paneRow.provider} size={14} /> : null}
          <span>{title(id)}</span>
        </button>
      })}
    </div> : null}
    <div className="thread-panes__area" ref={area} style={areaStyle}>
      {paneIds.map((id, index) => {
        const focused = id === focusedId
        const hidden = single && id !== shownId
        // The arrangement switch sits on the focused pane, and stays on the shown pane when the window alone makes the view
        // compact: the arrangement chosen there may be the one that does not fit, and the other may.
        const arranges = paneIds.length > 2 && (placed !== null ? focused : narrow && id === shownId)
        const zooms = !narrow || layout.zoomed
        return <React.Fragment key={id}><section id={paneDomId(id)} className="thread-pane" data-thread-id={id} data-focused={focused || undefined} data-hidden={hidden || undefined}
          data-placed={placed !== null || undefined} data-under-controls={index === underControls || undefined}
          aria-label={title(id)} role={single ? 'tabpanel' : 'region'} style={placed ? boxStyle(`pane-${index}`) : undefined}
          // A hidden pane stays mounted for its scroll position and draft, but out of reach.
          inert={hidden}
          onPointerDownCapture={event => { if (!(event.target as HTMLElement).closest(CHROME)) onFocusPane(id) }}
          onFocusCapture={event => { if (!(event.target as HTMLElement).closest(CHROME)) onFocusPane(id) }}>
          {/* The layout controls come first, like the header they sit in, so tabbing leaves a pane from its composer. */}
          {split ? <div className="thread-pane__controls" data-count={(arranges ? 1 : 0) + (placed ? 1 : 0) + (zooms ? 1 : 0) + 1}>
            {arranges
              ? <button type="button" className="thread-pane__control tt-focusable" data-pane-chrome aria-pressed={layout.arrangement === 'row'}
                aria-label="Single row" title={layout.arrangement === 'row' ? 'Arrange in a grid' : 'Arrange in a single row'}
                onClick={toggleArrangement}>
                {layout.arrangement === 'row' ? <LayoutGrid size={16} aria-hidden="true" /> : <Columns3 size={16} aria-hidden="true" />}
              </button>
              : null}
            {placed ? <button type="button" className="thread-pane__control thread-pane__grip tt-focusable" data-pane-chrome draggable
              aria-label={`Move ${title(id)} pane`} aria-roledescription="movable pane" aria-description="Drag to another pane, or use the arrow keys" title="Drag or use arrow keys to move"
              onKeyDown={event => onGripKey(event, id)}
              onDragStart={event => {
                event.dataTransfer.setData(PANE_DRAG_TYPE, id); event.dataTransfer.effectAllowed = 'move'
                // The targets cover the grip, and Chromium cancels a drag whose source is covered while it starts.
                moveStart.current = window.setTimeout(() => setMoving(id), 0)
              }}
              onDragEnd={() => { window.clearTimeout(moveStart.current); setMoving(null) }}>
              <GripVertical size={16} aria-hidden="true" />
            </button> : null}
            {zooms ? <button type="button" className="thread-pane__control tt-focusable" aria-keyshortcuts="Control+Shift+M"
              aria-label={layout.zoomed ? 'Show all panes' : `Zoom ${title(id)} pane`} title={layout.zoomed ? 'Show all panes (Ctrl+Shift+M)' : 'Zoom pane (Ctrl+Shift+M)'}
              onClick={() => toggleZoom(id)}>
              {layout.zoomed ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
            </button> : null}
            <button type="button" className="thread-pane__control thread-pane__close tt-focusable" data-pane-chrome data-pane-close aria-label={`Close ${title(id)} pane`} title="Close pane"
              onClick={() => onClosePane(id)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div> : null}
          {renderPane(id)}
        </section>
        {dividersAfter.get(index)}</React.Fragment>
      })}
    </div>
    {dropTargets}
    {split ? <div className="tt-visually-hidden" role="status" aria-live="polite">{announcement}</div> : null}
  </div>
}

