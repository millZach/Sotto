import React, { useId, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { moveCouncilCell, type CellMark } from './councilGridModel'

export interface SeatGridCell { readonly id: string; readonly stage: string; readonly seat: { readonly seat: string; readonly modelName: string } }

const MARKS = { done: '✓', working: '…', again: '↻', changed: '↗', trouble: '!', unavailable: '×' }

/** Shared table, roving focus and reader for Ask stages and Climb rounds. */
export function SeatGrid<T extends SeatGridCell>({ rows, seats, cells, initial, mark: cellMark, who, tableLabel, rowLabel, troubleText, needsYou, children }: {
  readonly rows: readonly { id: string; label: string }[]
  readonly seats: readonly SeatGridCell['seat'][]
  readonly cells: readonly T[]
  readonly initial: T | undefined
  readonly mark: (cell: T) => CellMark
  readonly who: (seat: SeatGridCell['seat']) => string
  readonly tableLabel: string
  readonly rowLabel: string
  readonly troubleText: string
  readonly needsYou?: (cell: T) => boolean
  readonly children: (cell: T) => ReactNode
}): ReactNode {
  const { t } = useLingui()
  const [choice, setChoice] = useState<string | null>(null)
  const table = useRef<HTMLTableElement>(null), reader = useRef<HTMLDivElement>(null)
  const readerId = useId()
  const stages = Object.fromEntries(rows.map(row => [row.id, row.label]))
  const states = { done: t`Done`, working: t`Working`, again: t`Asked again`, changed: t`Changed its answer`, trouble: t`Needs you`, unavailable: t`No result` }
  const selected = cells.find(cell => cell.id === choice) ?? initial
  const label = (cell: T): string => {
    const stage = stages[cell.stage], seat = who(cell.seat), model = cell.seat.modelName, state = states[cellMark(cell)]
    return t`Read ${stage} from ${seat}, ${model}, ${state}`
  }
  const choose = (cell: T, focus = false, read = true): void => {
    setChoice(cell.id)
    if (focus) {
      const button = table.current?.querySelector<HTMLButtonElement>(`[data-cell="${cell.id}"]`)
      button?.focus({ preventScroll: true })
      if (!read) button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    if (read) requestAnimationFrame(() => {
      const words = reader.current, column = words?.closest<HTMLElement>('.council-scroll')
      const scroll = column && getComputedStyle(column).overflowY === 'visible' ? column.closest<HTMLElement>('.council-view') : column
      if (!words || !scroll) return
      const bounds = scroll.getBoundingClientRect(), content = words.getBoundingClientRect()
      // About three lines are enough to find the reader without moving a readable selection.
      const visible = Math.max(0, Math.min(bounds.bottom, content.bottom) - Math.max(bounds.top, content.top))
      if (visible < 60) scroll.scrollTop += content.top - bounds.top
    })
  }
  const trouble = cells.filter(cell => needsYou ? needsYou(cell) : cellMark(cell) === 'trouble')
  const marks = (Object.keys(MARKS) as (keyof typeof MARKS)[]).filter(mark => cells.some(cell => cellMark(cell) === mark))
  return <div className="council-grid">
    {trouble.length ? <aside className="council-grid__trouble" aria-label={t`Needs you`}>
      <p>{troubleText}</p>
      <div>{trouble.map(cell => <button key={cell.id} type="button" className="council-link tt-focusable" aria-label={label(cell)}
        onClick={() => choose(cell, true)}>{stages[cell.stage]} · {who(cell.seat)}</button>)}</div>
    </aside> : null}
    <table ref={table} className="council-seat-matrix" aria-label={tableLabel}>
      <thead><tr><th scope="col"><span className="tt-visually-hidden">{rowLabel}</span></th>
        {seats.map(seat => <th key={seat.seat} scope="col" title={seat.modelName}>{who(seat)}</th>)}
      </tr></thead>
      <tbody>{rows.map(({ id: stage }) => <tr key={stage}><th scope="row">{stages[stage]}</th>{seats.map(seat => {
        const cell = cells.find(item => item.stage === stage && item.seat.seat === seat.seat)
        if (!cell) return <td key={seat.seat} />
        const mark = cellMark(cell)
        return <td key={seat.seat}><button type="button" className="council-cell tt-focusable" data-cell={cell.id} data-mark={mark}
          tabIndex={selected?.id === cell.id ? 0 : -1} aria-pressed={selected?.id === cell.id} aria-label={label(cell)} aria-controls={readerId}
          onClick={() => choose(cell)} onKeyDown={event => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            const next = moveCouncilCell(cells, cell.id, event.key)
            if (next) { event.preventDefault(); event.stopPropagation(); choose(next, true, false) }
          }}><span aria-hidden="true">{MARKS[mark]}</span></button></td>
      })}</tr>)}</tbody>
    </table>
    {marks.some(mark => mark !== 'done') ? <div className="council-grid__key" aria-hidden="true">{marks.map(mark => <span key={mark}>{MARKS[mark]} {states[mark]}</span>)}</div> : null}
    {selected ? <>
      <p className="tt-visually-hidden" role="status" aria-live="polite" aria-atomic="true">{stages[selected.stage]} · {who(selected.seat)} · {selected.seat.modelName} · {states[cellMark(selected)]}</p>
      <div ref={reader} id={readerId} className="council-grid-reader tt-focusable" tabIndex={-1} role="region" aria-label={t`Selected turn`}>
        <header><h4>{stages[selected.stage]} · {who(selected.seat)}</h4><span>{selected.seat.modelName}</span></header>
        {children(selected)}
      </div>
    </> : null}
  </div>
}
