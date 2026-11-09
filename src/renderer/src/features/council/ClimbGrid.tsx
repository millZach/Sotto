import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { ClimbRecord } from '../../../../shared/councilClimb'
import { useOptionalAgents } from '../../agents/AgentContext'
import { SeatGrid } from './SeatGrid'
import { CLIMB_SEATS, chosenClimbCell, climbCellMark, climbCells, climbRows, climbTurnRow } from './climbGridModel'

export function ClimbGrid({ record }: { readonly record: ClimbRecord }): ReactNode {
  const { t } = useLingui()
  const agents = useOptionalAgents()
  const names: Record<string, string> = { builder: t`Builder`, 'judge-0': t`Judge 1`, 'judge-1': t`Judge 2`, 'judge-2': t`Judge 3`, chair: t`Chair` }
  const rowName = (id: string): string => id === 'setup' ? t`Setup` : id === '0' ? t`Round 0 · Baseline` : t`Round ${id}`
  const cells = climbCells(record).map(cell => ({ ...cell, seat: { ...cell.seat, modelName: agents?.state?.host.models.find(model => model.id === cell.seat.modelName)?.name ?? cell.seat.modelName } }))
  const outcome = { queued: t`Queued`, dispatching: t`Sending`, accepted: t`Working`, unconfirmed: t`Unconfirmed`, working: t`Working`, answered: t`Done`, failed: t`Needs you` }
  return <SeatGrid rows={climbRows(record).map(id => ({ id, label: rowName(id) }))} seats={CLIMB_SEATS.map(seat => ({ seat, modelName: '' }))}
    cells={cells} initial={chosenClimbCell(cells)} mark={climbCellMark} who={seat => names[seat.seat]!}
    tableLabel={t`Turns by round and seat`} rowLabel={t`Round`} troubleText={t`The Climb needs you.`}>{cell => {
      const round = cell.round
      const turns = record.turns.filter(turn => climbTurnRow(turn) === cell.stage)
      const completed = turns.filter(turn => turn.outcome).length
      const planned = Math.max(cell.stage === 'setup' ? 1 : cell.stage === '0' ? 4 : 5, turns.length)
      const judge = round?.judgments.find(judgment => `judge-${judgment.seat}` === cell.seat.seat)
      return <>
        <p className="council-muted">{t`Completed / planned`}: {completed} / {planned}{round?.targetMet ? ` · ${t`Target met`}` : ''}{round?.candidate === record.incumbent && round ? ` · ${t`Incumbent`}` : ''}</p>
        {cell.turns.map(turn => <article className="council-turn" key={turn.id}>
          {turn.outcome !== 'answered' || turn.repair ? <div className="council-turn__head"><span>{cell.finished && turn.outcome !== 'answered' ? t`No result` : outcome[turn.outcome ?? turn.delivery]}</span>{turn.repair ? <span>{t`Asked again`}</span> : null}</div> : null}
          {turn.reply && (turn.stage === 'builder' || turn.stage === 'setup') ? <p className="council-turn__summary">{turn.reply}</p> : null}
        </article>)}
        {judge ? <ul className="council-turn__evidence">{judge.result.scores.map((score, index) => <li key={index}>
          <strong>{record.spec?.criteria.find(criterion => criterion.id === score.criterion)?.name ?? score.criterion} · {score.exhibit} · {score.score ?? t`Unmeasurable`}</strong>
          <p>{score.reason}</p><ul>{score.citations.map((citation, i) => <li key={i}>{citation.path}:{citation.start}–{citation.end} · {citation.quote}</li>)}</ul>
        </li>)}</ul> : null}
        {cell.seat.seat === 'chair' && round?.summary ? <p className="council-turn__summary">{round.summary}</p> : null}
        {round ? <ul className="council-turn__evidence">{round.exhibits.map(exhibit => <li key={exhibit.letter}>{exhibit.letter} · {exhibit.evidence === round.baseline ? t`Baseline` : exhibit.evidence === round.reference ? t`Reference` : exhibit.evidence === round.incumbent ? t`Incumbent` : t`Candidate`}</li>)}</ul> : null}
      </>
    }}</SeatGrid>
}
