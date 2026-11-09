import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { COUNCIL_CHAIR, type CouncilRoundView, type CouncilSeatView } from '../../../../shared/council'
import { SeatGrid } from './SeatGrid'
import { cellMark, chosenCouncilCell, councilCells, GRID_STAGES, turnNeedsYou, type CouncilCell } from './councilGridModel'

export function CouncilGrid({ round, seats, children }: { readonly round: CouncilRoundView; readonly seats: readonly CouncilSeatView[]
  readonly children: (cell: CouncilCell) => ReactNode }): ReactNode {
  const { t } = useLingui()
  const stages = { framing: t`Framing`, answers: t`Answers`, reviews: t`Reviews`, crux: t`Crux check`, verdict: t`Verdict`, fairness: t`Fairness check` }
  const cells = councilCells(round, seats)
  return <SeatGrid rows={GRID_STAGES.map(id => ({ id, label: stages[id] }))} seats={seats} cells={cells}
    initial={chosenCouncilCell(cells, round, null)} mark={cellMark} who={seat => seat.seat === COUNCIL_CHAIR ? t`Chair` : seat.seat}
    needsYou={cell => cell.rows.some(turnNeedsYou)} tableLabel={t`Turns by stage and seat`} rowLabel={t`Stage`} troubleText={t`The Council needs you.`}>{children}</SeatGrid>
}
