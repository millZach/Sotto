import React, { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { ProviderMark } from './ProviderMark'
import type { ThreadRow } from './threadFacts'
import { DIVIDER_WIDTH, RESIZE_STEP, THREAD_DRAG_TYPE, clampShare, isNarrow } from './splitLayout'
import './splitWorkspace.css'

type DropTarget = { readonly kind: 'side'; readonly side: 'start' | 'end' } | { readonly kind: 'pane'; readonly index: number } | { readonly kind: 'open' }

export interface ThreadPanesProps {
  /** Thread IDs in pane order. One ID is the single view. */
  readonly paneIds: readonly string[]
  readonly rows: ReadonlyMap<string, ThreadRow>
  readonly focusedId: string | null
  /** The first pane's share of the pane area. */
  readonly share: number
  /** A sidebar thread is being dragged; drop targets appear for it. */
  readonly dragging: string | null
  readonly renderPane: (threadId: string) => ReactNode
  readonly onFocusPane: (threadId: string) => void
  readonly onResize: (share: number, width: number) => void
  readonly onEven: () => void
  readonly onDrop: (threadId: string, target: DropTarget) => void
  /** Test-only: a fixed pane-area width where layout measurement is unavailable. */
  readonly measuredWidth?: number | undefined
}
export type { DropTarget }

const paneDomId = (threadId: string): string => `thread-pane-${threadId}`

/** Put keyboard focus inside a pane: its composer when it can take text, otherwise its transcript. */
export function focusInPane(threadId: string): void {
  const pane = document.getElementById(paneDomId(threadId))
  const target = pane?.querySelector<HTMLElement>('.thread-workspace__compose textarea:not(:disabled)') ?? pane?.querySelector<HTMLElement>('[role="log"]')
  target?.focus()
}

function useWidth(fixed: number | undefined): readonly [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fixed ?? 0)
  useEffect(() => {
    if (fixed !== undefined) { setWidth(fixed); return }
    const element = ref.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => setWidth(Math.round(entries[0]?.contentRect.width ?? element.clientWidth)))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [fixed])
  return [ref, width] as const
}

/** The divider between two panes: drag it, or focus it and use the arrow keys. Enter or a double-click evens the split. */
function PaneDivider({ share, width, controls, row, onResize, onEven }: {
  readonly share: number; readonly width: number; readonly controls: string; readonly row: React.RefObject<HTMLDivElement | null>
  readonly onResize: (share: number, width: number) => void; readonly onEven: () => void
}): ReactNode {
  const drag = useRef<{ readonly pointerId: number; readonly startX: number; readonly startShare: number; current: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const usable = Math.max(1, width - DIVIDER_WIDTH)
  const min = clampShare(0, width)
  const max = clampShare(1, width)
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startShare: share, current: share }
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === null || state.pointerId !== event.pointerId) return
    const next = clampShare(state.startShare + (event.clientX - state.startX) / usable, width)
    if (next === state.current) return
    state.current = next
    // Resize the columns directly while dragging; the transcripts and composers re-render once on release.
    if (row.current) row.current.style.gridTemplateColumns = columns(next)
  }
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === null || state.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (state.current !== state.startShare) onResize(state.current, width)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = event.key === 'ArrowLeft' ? share - RESIZE_STEP : event.key === 'ArrowRight' ? share + RESIZE_STEP
      : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : null
    if (event.key === 'Enter') { event.preventDefault(); onEven(); return }
    if (next === null) return
    event.preventDefault()
    onResize(next, width)
  }
  return <div role="separator" aria-orientation="vertical" aria-label="Resize panes" aria-controls={controls} tabIndex={0}
    aria-valuemin={Math.round(min * 100)} aria-valuemax={Math.round(max * 100)} aria-valuenow={Math.round(share * 100)}
    className="thread-panes__divider tt-focusable" data-dragging={dragging || undefined} title="Drag to resize · Double-click to even"
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
    onDoubleClick={onEven} onKeyDown={onKeyDown} />
}

const columns = (share: number): string => `minmax(0, ${share}fr) ${DIVIDER_WIDTH}px minmax(0, ${1 - share}fr)`

function DropZone({ label, target, dragging, onDrop, className }: {
  readonly label: string; readonly target: DropTarget; readonly dragging: string; readonly className: string
  readonly onDrop: (threadId: string, target: DropTarget) => void
}): ReactNode {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent): boolean => event.dataTransfer.types.includes(THREAD_DRAG_TYPE)
  return <div className={className} data-over={over || undefined} aria-hidden="true"
    onDragEnter={event => { if (accepts(event)) { event.preventDefault(); setOver(true) } }}
    onDragOver={event => { if (accepts(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (!over) setOver(true) } }}
    onDragLeave={() => setOver(false)}
    onDrop={event => {
      if (!accepts(event)) return
      event.preventDefault()
      setOver(false)
      onDrop(event.dataTransfer.getData(THREAD_DRAG_TYPE) || dragging, target)
    }}>
    <span className="thread-panes__drop-label">{label}</span>
  </div>
}

/**
 * The pane area. Two panes sit side by side with a divider; when the area is too narrow for both,
 * only the focused pane shows and tabs switch between them. Hidden panes stay mounted and inert,
 * so each keeps its scroll position and draft, and widening the window restores the same split.
 */
export function ThreadPanes({ paneIds, rows, focusedId, share, dragging, renderPane, onFocusPane, onResize, onEven, onDrop, measuredWidth }: ThreadPanesProps): ReactNode {
  const [area, width] = useWidth(measuredWidth)
  const row = useRef<HTMLDivElement>(null)
  const split = paneIds.length >= 2
  const narrow = isNarrow(width, paneIds.length)
  const visibleShare = width > 0 ? clampShare(share, width) : share
  const focusedIndex = Math.max(0, paneIds.findIndex(id => id === focusedId))

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? paneIds.length - 1 : null
    if (next === null) return
    event.preventDefault()
    const id = paneIds[(next + paneIds.length) % paneIds.length]!
    onFocusPane(id)
    window.setTimeout(() => document.getElementById(`thread-pane-tab-${id}`)?.focus(), 0)
  }

  const dropTargets = dragging === null ? null
    : !split && paneIds.length === 1 && paneIds[0] !== dragging
      ? <div className="thread-panes__drops" data-layout="sides">
        <DropZone className="thread-panes__drop" label="Open on the left" target={{ kind: 'side', side: 'start' }} dragging={dragging} onDrop={onDrop} />
        <DropZone className="thread-panes__drop" label="Open on the right" target={{ kind: 'side', side: 'end' }} dragging={dragging} onDrop={onDrop} />
      </div>
      : paneIds.length === 0
        ? <div className="thread-panes__drops"><DropZone className="thread-panes__drop" label="Open here" target={{ kind: 'open' }} dragging={dragging} onDrop={onDrop} /></div>
        : split && narrow
          ? <div className="thread-panes__drops"><DropZone className="thread-panes__drop" label="Show here" target={{ kind: 'pane', index: focusedIndex }} dragging={dragging} onDrop={onDrop} /></div>
          : split
            ? <div className="thread-panes__drops" style={{ gridTemplateColumns: columns(visibleShare) }} data-layout="panes">
              {paneIds.flatMap((id, index) => [
                index > 0 ? <span key={`gap-${index}`} /> : null,
                <DropZone key={id} className="thread-panes__drop" label="Show here" target={{ kind: 'pane', index }} dragging={dragging} onDrop={onDrop} />,
              ])}
            </div>
            : null

  if (!paneIds.length) return dropTargets
  return <div className="thread-panes" ref={area} role="group" aria-label="Thread panes" data-split={split || undefined} data-narrow={narrow || undefined}>
    {split && narrow ? <div className="thread-panes__tabs" role="tablist" aria-label="Open panes">
      {paneIds.map((id, index) => {
        const paneRow = rows.get(id)
        const selected = id === focusedId
        return <button key={id} id={`thread-pane-tab-${id}`} type="button" role="tab" aria-selected={selected} aria-controls={paneDomId(id)} tabIndex={selected || (focusedId === null && index === 0) ? 0 : -1}
          className="thread-panes__tab tt-focusable" onClick={() => onFocusPane(id)} onKeyDown={event => onTabKey(event, index)}>
          {paneRow ? <ProviderMark provider={paneRow.providerId} name={paneRow.provider} size={14} /> : null}
          <span>{paneRow?.thread.title ?? 'Thread'}</span>
        </button>
      })}
    </div> : null}
    <div className="thread-panes__row" ref={row} style={split && !narrow ? { gridTemplateColumns: columns(visibleShare) } : undefined}>
      {paneIds.flatMap((id, index) => {
        const focused = id === focusedId
        const hidden = split && narrow && !(focused || (focusedId === null && index === 0))
        return [
          index > 0 && split && !narrow ? <PaneDivider key={`divider-${index}`} share={visibleShare} width={width} controls={paneDomId(paneIds[0]!)} row={row} onResize={onResize} onEven={onEven} /> : null,
          <section key={id} id={paneDomId(id)} className="thread-pane" data-thread-id={id} data-focused={focused || undefined} data-hidden={hidden || undefined}
            aria-label={rows.get(id)?.thread.title ?? 'Thread'} role={split && narrow ? 'tabpanel' : 'region'}
            // A hidden pane stays mounted for its scroll position and draft, but out of reach.
            inert={hidden}
            onPointerDownCapture={event => { if (!(event.target as HTMLElement).closest('[data-pane-close]')) onFocusPane(id) }}
            onFocusCapture={event => { if (!(event.target as HTMLElement).closest('[data-pane-close]')) onFocusPane(id) }}>
            {renderPane(id)}
          </section>,
        ]
      })}
    </div>
    {dropTargets}
  </div>
}
