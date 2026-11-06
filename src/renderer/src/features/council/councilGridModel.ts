import { COUNCIL_STAGES, type CouncilRoundView, type CouncilRow, type CouncilSeatView, type CouncilStage } from '../../../../shared/council'

export const GRID_STAGES = COUNCIL_STAGES.filter(stage => stage !== 'done')
export type GridStage = Exclude<CouncilStage, 'done'>
export type CellMark = 'done' | 'working' | 'again' | 'changed' | 'trouble' | 'unavailable'
export interface CouncilCell {
  readonly id: string
  readonly stage: GridStage
  readonly seat: CouncilSeatView
  readonly rows: readonly CouncilRow[]
}

export function gridStage(stage: CouncilRow['stage']): GridStage {
  return stage === 'history' ? 'framing' : stage === 'amend' ? 'fairness' : stage === 'answer' ? 'answers' : stage === 'review' ? 'reviews' : stage
}

/** Row order is prompt order. A repair belongs to the preceding prompt for this seat and turn stage. */
export function groupCellTurns(rows: readonly CouncilRow[]): { row: CouncilRow; repairs: CouncilRow[] }[] {
  const turns: { row: CouncilRow; repairs: CouncilRow[] }[] = []
  for (const row of rows) {
    const parent = row.repair ? turns.findLast(turn => turn.row.stage === row.stage) : undefined
    if (parent) parent.repairs.push(row)
    else turns.push({ row, repairs: [] })
  }
  return turns
}

export function councilCells(round: CouncilRoundView, seats: readonly CouncilSeatView[]): CouncilCell[] {
  return GRID_STAGES.flatMap(stage => seats.flatMap(seat => {
    const rows = round.rows.filter(row => row.seat === seat.seat && gridStage(row.stage) === stage)
    return rows.length ? [{ id: `${stage}:${seat.seat}`, stage, seat, rows }] : []
  }))
}

export function turnNeedsYou(row: CouncilRow): boolean {
  return row.state === 'waiting' || row.actions.length > 0
}

/** Keep unfinished work ahead of annotations, including a repair still working after an unreadable answer. */
export function cellMark(cell: CouncilCell): CellMark {
  if (cell.rows.some(turnNeedsYou)) return 'trouble'
  if (cell.rows.some(row => row.state === 'working')) return 'working'
  if (cell.rows.some(row => row.result === 'unavailable' || row.state === 'failed' || row.state === 'stopped' || row.state === 'unknown')) return 'unavailable'
  if (cell.rows.some(row => row.changed)) return 'changed'
  if (cell.rows.some(row => row.repair)) return 'again'
  return 'done'
}

/** A user's choice survives live updates. Before that choice, follow trouble, then work, then the verdict. */
export function chosenCouncilCell(cells: readonly CouncilCell[], round: CouncilRoundView, choice: string | null): CouncilCell | undefined {
  const chosen = cells.find(cell => cell.id === choice)
  if (chosen) return chosen
  const trouble = round.rows.find(turnNeedsYou)
  if (trouble) return cells.find(cell => cell.rows.includes(trouble))
  if (round.stage === 'done') return cells.find(cell => cell.stage === 'verdict') ?? cells[0]
  const working = round.rows.find(row => row.state === 'working')
  return (working && cells.find(cell => cell.rows.includes(working))) || cells.find(cell => cell.stage === 'verdict') || cells[0]
}

/** Left/right follow reading order; up/down stay in the seat, skipping stages without a turn. No wrapping. */
export function moveCouncilCell(cells: readonly CouncilCell[], id: string, key: string): CouncilCell | undefined {
  const index = cells.findIndex(cell => cell.id === id)
  const current = cells[index]
  if (!current) return undefined
  if (key === 'ArrowLeft') return cells[Math.max(0, index - 1)]
  if (key === 'ArrowRight') return cells[Math.min(cells.length - 1, index + 1)]
  const sameSeat = cells.filter(cell => cell.seat.seat === current.seat.seat)
  const at = sameSeat.indexOf(current)
  if (key === 'ArrowUp') return sameSeat[Math.max(0, at - 1)]
  if (key === 'ArrowDown') return sameSeat[Math.min(sameSeat.length - 1, at + 1)]
  return undefined
}
