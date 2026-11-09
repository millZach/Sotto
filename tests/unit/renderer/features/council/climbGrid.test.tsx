import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClimbRecord, ClimbTurn } from '../../../../../src/shared/councilClimb'
import { ClimbGrid } from '../../../../../src/renderer/src/features/council/ClimbGrid'
import { climbCells, climbCellMark, chosenClimbCell, climbRows } from '../../../../../src/renderer/src/features/council/climbGridModel'

beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const turn = (stage: ClimbTurn['stage'], patch: Partial<ClimbTurn> = {}): ClimbTurn => ({ id: stage, draftId: 'draft', messageId: 'message', thread: stage, stage, round: 0, delivery: 'accepted', outcome: 'answered', repair: false, ...patch })
const fixture = (): ClimbRecord => ({ mode: 'climb', id: 'climb', createdAt: '', originThread: 'origin', originTitle: 'Origin', projectId: 'project', phase: 'done', evidence: [], baseline: 'base', incumbent: 'candidate', noImprovement: 0, completedTurns: 4, originLastUser: null, retained: true,
  turns: [turn('setup'), turn('judge', { seat: 0 }), turn('chair'), turn('builder')],
  rounds: [{ index: 0, baseline: 'base', candidate: 'base', incumbent: 'base', exhibits: [{ letter: 'A', evidence: 'base' }], judgments: [{ seat: 0, thread: 'judge', modelId: 'model', result: { scores: [{ criterion: 'quality', exhibit: 'A', score: 8, reason: 'Clear steps.', citations: [{ path: 'guide.txt', start: 1, end: 3, quote: 'Three steps.' }] }] } }], summary: 'Keep the clear steps.', targetMet: true }],
})

describe('Climb Seat grid', () => {
  it('maps setup to Chair, and Builder to the next round, leaving missing turns blank', () => {
    const record = fixture()
    expect(climbRows(record)).toEqual(['setup', '0', '1'])
    expect(climbCells(record).map(cell => cell.id)).toEqual(['setup:chair', '0:judge-0', '0:chair', '1:builder'])
  })
  it('follows trouble, then working, then the last chair; a successful repair resolves a failed turn', () => {
    const record = fixture(); record.phase = 'assessment'
    record.turns.push(turn('judge', { id: 'failed', seat: 1, outcome: 'failed' }))
    expect(chosenClimbCell(climbCells(record))?.id).toBe('0:judge-1')
    record.turns.push(turn('judge', { id: 'repair', seat: 1, repair: true }))
    expect(climbCellMark(climbCells(record).find(cell => cell.id === '0:judge-1')!)).toBe('again')
    record.turns.push(turn('judge', { id: 'working', seat: 2, outcome: 'working' }))
    expect(chosenClimbCell(climbCells(record))?.id).toBe('0:judge-2')
    record.phase = 'paused'
    expect(climbCellMark(climbCells(record).find(cell => cell.id === '0:judge-2')!)).toBe('trouble')
    record.turns.pop()
    expect(chosenClimbCell(climbCells(record))?.id).toBe('0:chair')
  })
  it('keeps scores, citations, summary and round facts in a keyboard reachable reader', () => {
    render(<ClimbGrid record={fixture()} />)
    const table = screen.getByRole('table', { name: 'Turns by round and seat' })
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Round', 'Builder', 'Judge 1', 'Judge 2', 'Judge 3', 'Chair'])
    expect(table.querySelectorAll('button[tabindex="0"]')).toHaveLength(1)
    expect(screen.queryByText('Changed its answer')).toBeNull()
    const chair = within(table).getByRole('button', { name: /Read Round 0 · Baseline from Chair/ })
    fireEvent.keyDown(chair, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(within(table).getByRole('button', { name: /from Judge 1/ }))
    let reader = screen.getByRole('region', { name: 'Selected turn' })
    expect(reader.textContent).toContain('Clear steps.')
    expect(reader.textContent).toContain('guide.txt:1–3 · Three steps.')
    expect(reader.textContent).toContain('Target met')
    expect(reader.textContent).toContain('A · Baseline')
    fireEvent.click(chair)
    reader = screen.getByRole('region', { name: 'Selected turn' })
    expect(reader.textContent).toContain('Keep the clear steps.')
    expect(chair).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'Read selected turn' })).toBeNull()
  })
  it('links held turns from the trouble line and keeps a chosen cell through updates', () => {
    const record = fixture(); record.phase = 'paused'; record.turns[1] = turn('judge', { seat: 0, outcome: 'working' })
    const { rerender } = render(<ClimbGrid record={record} />)
    const trouble = screen.getByRole('complementary', { name: 'Needs you' })
    fireEvent.click(within(trouble).getByRole('button'))
    expect(document.activeElement?.getAttribute('data-cell')).toBe('0:judge-0')
    fireEvent.click(screen.getByRole('table').querySelector('[data-cell="setup:chair"]')!)
    rerender(<ClimbGrid record={{ ...record, turns: [...record.turns, turn('judge', { seat: 2, outcome: 'failed' })] }} />)
    expect(screen.getByRole('region', { name: 'Selected turn' }).textContent).toContain('Setup · Chair')
  })
  it.each(['done', 'stopped', 'settled'] as const)('uses Ask’s No result mark for unfinished turns after %s', phase => {
    const record = fixture(); record.phase = phase
    record.turns = [turn('setup'), turn('chair'), turn('judge', { seat: 0, outcome: 'failed' }), turn('judge', { seat: 1, outcome: undefined })]
    render(<ClimbGrid record={record} />)
    expect(screen.queryByText('The Climb needs you.')).toBeNull()
    expect(document.querySelector('[data-mark="working"]')).toBeNull()
    expect(document.querySelector('[data-mark="trouble"]')).toBeNull()
    expect(screen.getByRole('button', { name: /Read Round 0 · Baseline from Chair,.*Done/ })).toHaveAttribute('aria-pressed', 'true')
    for (const button of screen.getAllByRole('button', { name: /No result/ })) {
      expect(button).toHaveTextContent('×')
      fireEvent.click(button)
      const reader = screen.getByRole('region', { name: 'Selected turn' })
      expect(reader).toHaveTextContent('No result')
      expect(reader).not.toHaveTextContent(/Held|Working/)
    }
    expect(document.querySelector('.council-grid__key')).toHaveTextContent('× No result')
  })
  it('keeps a paused failed judge actionable and falls back to the last cell without a chair', () => {
    const record = fixture(); record.phase = 'paused'; record.turns = [turn('judge', { seat: 0, outcome: 'failed' })]
    const view = render(<ClimbGrid record={record} />)
    expect(screen.getByText('The Climb needs you.')).toBeInTheDocument()
    expect(document.querySelector('[data-mark="trouble"]')).toBeInTheDocument()
    record.phase = 'stopped'; record.turns.push(turn('builder', { outcome: undefined }))
    view.rerender(<ClimbGrid record={record} />)
    expect(chosenClimbCell(climbCells(record))?.id).toBe('1:builder')
    expect(screen.queryByText('The Climb needs you.')).toBeNull()
    view.rerender(<ClimbGrid record={{ ...record, turns: record.turns.map(turn => ({ ...turn, outcome: 'answered' })) }} />)
    expect(document.querySelector('.council-grid__key')).toBeNull()
  })

})
