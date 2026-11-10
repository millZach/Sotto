import type { ClimbRecord, ClimbRound, ClimbTurn } from '../../../../shared/councilClimb'
import type { CellMark } from './councilGridModel'

export const CLIMB_SEATS = ['builder', 'judge-0', 'judge-1', 'judge-2', 'chair'] as const
export interface ClimbCell {
  readonly id: string
  readonly stage: string
  readonly seat: { readonly seat: string; readonly modelName: string }
  readonly turns: readonly ClimbTurn[]
  readonly round: ClimbRound | undefined
  readonly held: boolean
  readonly finished: boolean
}

export function climbTurnRow(turn: ClimbTurn): string {
  return turn.stage === 'setup' ? 'setup' : String(turn.round + (turn.stage === 'builder' ? 1 : 0))
}

export function climbRows(record: ClimbRecord): string[] {
  return ['setup', ...[...new Set([...record.rounds.map(round => String(round.index)), ...record.turns.filter(turn => turn.stage !== 'setup').map(climbTurnRow)])].sort((a, b) => Number(a) - Number(b))]
}

export function climbCells(record: ClimbRecord): ClimbCell[] {
  return climbRows(record).flatMap(stage => CLIMB_SEATS.flatMap(seat => {
    const turns = record.turns.filter(turn => climbTurnRow(turn) === stage && (turn.stage === 'judge' ? `judge-${turn.seat ?? 0}` : turn.stage === 'setup' ? 'chair' : turn.stage) === seat)
    if (!turns.length) return []
    const modelName = turns.at(-1)?.modelId ?? (seat === 'chair' ? record.spec?.chair.modelId : seat.startsWith('judge-') ? record.spec?.judges[Number(seat.at(-1))]?.modelId : undefined) ?? ''
    return [{ id: `${stage}:${seat}`, stage, seat: { seat, modelName }, turns, round: record.rounds.find(round => String(round.index) === stage), held: record.phase === 'paused', finished: ['done', 'stopped', 'settled'].includes(record.phase) }]
  }))
}

export function climbCellMark(cell: ClimbCell): CellMark {
  const last = cell.turns.at(-1)!
  if (cell.finished && last.outcome !== 'answered') return 'unavailable'
  if (last.outcome === 'failed' || last.delivery === 'unconfirmed' || (cell.held && last.outcome !== 'answered')) return 'trouble'
  if (last.outcome !== 'answered') return 'working'
  return cell.turns.some(turn => turn.repair) ? 'again' : 'done'
}

export function chosenClimbCell(cells: readonly ClimbCell[]): ClimbCell | undefined {
  if (cells.some(cell => cell.finished)) return cells.findLast(cell => cell.seat.seat === 'chair') ?? cells.at(-1)
  return cells.find(cell => climbCellMark(cell) === 'trouble') ?? cells.find(cell => climbCellMark(cell) === 'working') ?? cells.findLast(cell => cell.seat.seat === 'chair') ?? cells[0]
}
