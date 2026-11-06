import React, { useId, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { COUNCIL_CHAIR, type CouncilRoundView, type CouncilSeatView } from '../../../../shared/council'
import { cellMark, chosenCouncilCell, councilCells, GRID_STAGES, moveCouncilCell, turnNeedsYou, type CouncilCell } from './councilGridModel'

const MARKS = { done: '✓', working: '…', again: '↻', changed: '↗', trouble: '!', unavailable: '×' }

/** A real table with one roving Tab stop; arrows keep the selected cell in view. */
export function CouncilGrid({ round, seats, children }: { readonly round: CouncilRoundView; readonly seats: readonly CouncilSeatView[]
  readonly children: (cell: CouncilCell) => ReactNode }): ReactNode {
  const { t } = useLingui()
  const [choice, setChoice] = useState<string | null>(null)
  const table = useRef<HTMLTableElement>(null), reader = useRef<HTMLDivElement>(null)
  const readerId = useId()
  const stages = { framing: t`Framing`, answers: t`Answers`, reviews: t`Reviews`, crux: t`Crux check`, verdict: t`Verdict`, fairness: t`Fairness check` }
  const states = { done: t`Done`, working: t`Working`, again: t`Asked again`, changed: t`Changed its answer`, trouble: t`Needs you`, unavailable: t`No result` }
  const cells = councilCells(round, seats)
  const selected = chosenCouncilCell(cells, round, choice)
  const who = (seat: CouncilSeatView): string => seat.seat === COUNCIL_CHAIR ? t`Chair` : seat.seat
  const label = (cell: CouncilCell): string => {
    const stage = stages[cell.stage], seat = who(cell.seat), model = cell.seat.modelName, state = states[cellMark(cell)]
    return t`Read ${stage} from ${seat}, ${model}, ${state}`
  }
  const choose = (cell: CouncilCell, focus = false, read = true): void => {
    setChoice(cell.id)
    if (focus) {
      const button = table.current?.querySelector<HTMLButtonElement>(`[data-cell="${cell.id}"]`)
      button?.focus({ preventScroll: true })
      if (!read) button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    if (read) requestAnimationFrame(() => {
      const words = reader.current, scroll = words?.closest<HTMLElement>('.council-scroll')
      if (!words || !scroll) return
      const bounds = scroll.getBoundingClientRect(), content = words.getBoundingClientRect()
      // About three lines are enough to find the reader without moving a readable selection.
      const visible = Math.max(0, Math.min(bounds.bottom, content.bottom) - Math.max(bounds.top, content.top))
      if (visible < 60) scroll.scrollTop += content.top - bounds.top
    })
  }
  const trouble = cells.filter(cell => cell.rows.some(turnNeedsYou))
  const marks = (Object.keys(MARKS) as (keyof typeof MARKS)[]).filter(mark => cells.some(cell => cellMark(cell) === mark))
  return <div className="council-grid">
    {trouble.length ? <aside className="council-grid__trouble" aria-label={t`Needs you`}>
      <p>{t`The Council needs you.`}</p>
      <div>{trouble.map(cell => <button key={cell.id} type="button" className="council-link tt-focusable" aria-label={label(cell)}
        onClick={() => choose(cell, true)}>{stages[cell.stage]} · {who(cell.seat)}</button>)}</div>
    </aside> : null}
    <table ref={table} className="council-seat-matrix" aria-label={t`Turns by stage and seat`}>
      <thead><tr><th scope="col"><span className="tt-visually-hidden">{t`Stage`}</span></th>
        {seats.map(seat => <th key={seat.seat} scope="col" title={seat.modelName}>{who(seat)}</th>)}
      </tr></thead>
      <tbody>{GRID_STAGES.map(stage => <tr key={stage}><th scope="row">{stages[stage]}</th>{seats.map(seat => {
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
