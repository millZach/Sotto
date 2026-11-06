import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CouncilGrid } from '../../../../../src/renderer/src/features/council/CouncilGrid'
import { RoundRecord } from '../../../../../src/renderer/src/features/council/CouncilView'
import { cellMark, chosenCouncilCell, councilCells, groupCellTurns, moveCouncilCell } from '../../../../../src/renderer/src/features/council/councilGridModel'
import { councilFixture, row, SEATS } from './chamberFixtures'

beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const counts = { answered: 3, rankings: [], findings: [], supports: [], favourites: [], changed: [], partial: false }

describe('Seat grid turns and choice', () => {
  it('keeps six stages, folding history and amendments into their seats and repairs under their turn', () => {
    const history = row('chair', 'history', 'done'), framing = row('chair', 'framing', 'done')
    const answer = row('A', 'answer', 'done'), repair = row('A', 'answer', 'done', { repair: true })
    const amend = row('chair', 'amend', 'done')
    const round = councilFixture({ rows: [history, framing, answer, repair, amend] }).rounds[0]!
    const cells = councilCells(round, SEATS)
    expect(cells.map(cell => cell.id)).toEqual(['framing:chair', 'answers:A', 'fairness:chair'])
    expect(cells[0]!.rows).toEqual([history, framing])
    expect(groupCellTurns(cells[1]!.rows)).toEqual([{ row: answer, repairs: [repair] }])
    expect(cellMark(cells[1]!)).toBe('again')
    expect(groupCellTurns([history, framing])).toHaveLength(2)
  })

  it('starts on trouble, then a finished verdict or the working turn, and never takes a chosen cell', () => {
    const answer = row('A', 'answer', 'done'), work = row('B', 'review', 'working'), verdict = row('chair', 'verdict', 'done')
    const round = councilFixture({ stage: 'done', rows: [answer, work, verdict] }).rounds[0]!
    let cells = councilCells(round, SEATS)
    expect(chosenCouncilCell(cells, round, null)?.id).toBe('verdict:chair')
    expect(chosenCouncilCell(cells, { ...round, stage: 'reviews' }, null)?.id).toBe('reviews:B')
    const trouble = row('C', 'fairness', 'waiting')
    const updated = { ...round, rows: [...round.rows, trouble] }
    cells = councilCells(updated, SEATS)
    expect(chosenCouncilCell(cells, updated, null)?.id).toBe('fairness:C')
    expect(chosenCouncilCell(cells, updated, 'answers:A')?.id).toBe('answers:A')
    const unavailable = { ...updated, rows: [row('A', 'answer', 'done', { result: 'unavailable' }), ...updated.rows.slice(1)] }
    expect(chosenCouncilCell(councilCells(unavailable, SEATS), unavailable, null)?.id).toBe('fairness:C')
    expect(chosenCouncilCell([], { ...round, rows: [] }, null)).toBeUndefined()
  })

  it('prioritises trouble and work over changed answers and asked-again marks', () => {
    const council = councilFixture({ rows: [row('A', 'review', 'done', { changed: true }), row('A', 'review', 'working', { repair: true })] })
    const cell = councilCells(council.rounds[0]!, SEATS)[0]!
    expect(cellMark(cell)).toBe('working')
    expect(cellMark({ ...cell, rows: [cell.rows[0]!] })).toBe('changed')
    expect(cellMark({ ...cell, rows: [row('A', 'review', 'done', { result: 'unavailable' })] })).toBe('unavailable')
  })

  it('orders needs you, working, no result, changed, asked again and done', () => {
    const base = councilCells(councilFixture({ rows: [row('A', 'answer', 'done')] }).rounds[0]!, SEATS)[0]!
    const failed = row('A', 'answer', 'failed', { result: 'unavailable', late: true })
    const changed = row('A', 'answer', 'done', { changed: true })
    const repair = row('A', 'answer', 'done', { repair: true })
    expect(cellMark({ ...base, rows: [failed, changed, repair] })).toBe('unavailable')
    expect(cellMark({ ...base, rows: [failed, row('A', 'answer', 'working', { repair: true })] })).toBe('working')
    expect(cellMark({ ...base, rows: [row('A', 'answer', 'waiting'), failed] })).toBe('trouble')
    expect(cellMark({ ...base, rows: [{ ...failed, actions: ['retry'] }] })).toBe('trouble')
    expect(cellMark({ ...base, rows: [changed, repair] })).toBe('changed')
    expect(cellMark({ ...base, rows: [repair] })).toBe('again')
    expect(cellMark(base)).toBe('done')
  })

  it('moves in reading order or in the same seat, skipping blank cells and stopping at edges', () => {
    const round = councilFixture({ rows: [row('chair', 'framing', 'done'), row('A', 'answer', 'done'), row('C', 'answer', 'done'), row('A', 'fairness', 'done')] }).rounds[0]!
    const cells = councilCells(round, SEATS)
    expect(moveCouncilCell(cells, 'answers:A', 'ArrowRight')?.id).toBe('answers:C')
    expect(moveCouncilCell(cells, 'answers:A', 'ArrowLeft')?.id).toBe('framing:chair')
    expect(moveCouncilCell(cells, 'answers:A', 'ArrowDown')?.id).toBe('fairness:A')
    expect(moveCouncilCell(cells, 'fairness:A', 'ArrowUp')?.id).toBe('answers:A')
    expect(moveCouncilCell(cells, 'answers:C', 'ArrowDown')?.id).toBe('answers:C')
    expect(moveCouncilCell(cells, 'framing:chair', 'ArrowLeft')?.id).toBe('framing:chair')
  })
})

describe('Seat grid reading', () => {
  it('has real headers, empty non-controls and one grid Tab stop; arrows select and announce without stealing focus', () => {
    const council = councilFixture({ rows: [row('A', 'answer', 'done'), row('C', 'answer', 'working')] })
    const view = render(<CouncilGrid round={council.rounds[0]!} seats={SEATS}>{cell => <p>{cell.id}</p>}</CouncilGrid>)
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('rowheader')).toHaveLength(6)
    expect(within(table).getAllByRole('columnheader')).toHaveLength(5)
    expect(table.querySelectorAll('td:empty')).toHaveLength(22)
    expect(table.querySelectorAll('button[tabindex="0"]')).toHaveLength(1)
    const work = within(table).getByRole('button', { name: 'Read Answers from C, Grok 4.7, Working' })
    fireEvent.focus(work)
    view.rerender(<CouncilGrid round={{ ...council.rounds[0]!, rows: [...council.rounds[0]!.rows, row('B', 'review', 'waiting')] }} seats={SEATS}>{cell => <p>{cell.id}</p>}</CouncilGrid>)
    expect(work).toHaveAttribute('aria-pressed', 'false')
    fireEvent.keyDown(work, { key: 'ArrowLeft' })
    const answer = within(table).getByRole('button', { name: 'Read Answers from A, Opus 5.5, Done' })
    expect(answer).toHaveFocus()
    expect(answer).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Answers · A')
    fireEvent.keyDown(answer, { key: 'ArrowRight', ctrlKey: true })
    expect(answer).toHaveFocus()
    const updated = { ...council.rounds[0]!, rows: [...council.rounds[0]!.rows, row('B', 'review', 'waiting')] }
    view.rerender(<CouncilGrid round={updated} seats={SEATS}>{cell => <p>{cell.id}</p>}</CouncilGrid>)
    expect(answer).toHaveAttribute('aria-pressed', 'true')
  })

  it.each([
    ['stopped Council', 'stopped', 'stopped'],
    ['skipped seat', 'done', 'failed'],
    ['unavailable result', 'done', 'done'],
    ['unknown turn', 'settled', 'unknown'],
  ] as const)('shows no call for help for a %s and opens a finished round on Verdict', (_name, status, state) => {
    const council = councilFixture({ stage: 'done', leftOut: state === 'failed' ? ['A'] : [], rows: [
      row('A', 'answer', state, { result: 'unavailable', late: true }), row('chair', 'verdict', 'done'),
    ] }, { status })
    render(<CouncilGrid round={council.rounds[0]!} seats={SEATS}>{cell => <p>{cell.id}</p>}</CouncilGrid>)
    expect(screen.queryByText('The Council needs you.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Read Answers.*No result/ })).toHaveTextContent('×')
    expect(screen.getByRole('button', { name: /Read Verdict/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('omits raw framing summaries and repeated labels for completed turns', () => {
    const council = councilFixture({ stage: 'done', rows: [row('chair', 'framing', 'done', { summary: 'decision, fact' }),
      row('A', 'answer', 'done', { summary: 'An answer.' }), row('chair', 'verdict', 'done')],
    verdict: { text: 'The verdict.', counts, fairnessDone: true, objections: [] } })
    render(<RoundRecord council={council} round={council.rounds[0]!} run={vi.fn()} />)
    const reader = screen.getByRole('region', { name: 'Selected turn' })
    expect(within(reader).getAllByRole('heading')).toHaveLength(1)
    expect(reader).not.toHaveTextContent('Done')
    expect(screen.queryByText('✓ Done')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Read Answers/ }))
    expect(reader.querySelector('.council-turn__head')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Read Framing/ }))
    expect(reader).not.toHaveTextContent('decision, fact')
  })

  it('scrolls an activated reader only when less than three lines are visible; arrows keep the cell visible', async () => {
    const council = councilFixture({ rows: [row('A', 'answer', 'done'), row('C', 'answer', 'working')] })
    const { container } = render(<div className="council-scroll"><CouncilGrid round={council.rounds[0]!} seats={SEATS}>{cell => <p>{cell.id}</p>}</CouncilGrid></div>)
    const scroll = container.firstElementChild as HTMLElement
    const reader = screen.getByRole('region', { name: 'Selected turn' })
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 450))
    const bounds = vi.spyOn(reader, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 410, 600, 900))
    const work = screen.getByRole('button', { name: /Read Answers from C/ })
    fireEvent.keyDown(work, { key: 'ArrowLeft' })
    const answer = screen.getByRole('button', { name: /Read Answers from A/ })
    expect(answer).toHaveFocus()
    expect(answer.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(scroll.scrollTop).toBe(0)
    fireEvent.click(answer)
    await waitFor(() => expect(scroll.scrollTop).toBe(410))
    scroll.scrollTop = 0
    bounds.mockReturnValue(new DOMRect(0, 350, 600, 900))
    fireEvent.click(work)
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(scroll.scrollTop).toBe(0)
  })

  it('keeps repair threads, long words, citations, changed answers and recovery actions in the reader', () => {
    const summary = 'Long summary. '.repeat(142).slice(0, 2000)
    const council = councilFixture({ rows: [row('A', 'review', 'done', { summary, changed: true,
      citations: [{ finding: 'A', path: 'src/long/path.ts', lines: '1-8', check: 'matches' }], sources: [{ finding: 'A', url: 'https://example.com/source' }] }),
    row('A', 'review', 'failed', { repair: true, result: 'unavailable', late: true, actions: ['retry', 'replace', 'skip'] })] })
    const run = vi.fn(async () => undefined)
    render(<RoundRecord council={council} round={council.rounds[0]!} run={run} />)
    const reader = screen.getByRole('region', { name: 'Selected turn' })
    expect(reader).toHaveTextContent(summary)
    expect(reader).toHaveTextContent('Changed its answer')
    expect(reader).toHaveTextContent('Asked again')
    expect(reader).toHaveTextContent('past the stage deadline')
    expect(reader).toHaveTextContent('no result')
    expect(within(reader).getAllByRole('listitem')).toHaveLength(2)
    expect(within(reader).getAllByRole('button', { name: 'Open thread' })).toHaveLength(2)
    expect(within(reader).getByRole('button', { name: 'Use another model' })).toBeInTheDocument()
    fireEvent.click(within(reader).getByRole('button', { name: 'Retry' }))
    expect(run).toHaveBeenLastCalledWith({ type: 'retry', council: council.id, turn: council.rounds[0]!.rows[1]!.turn })
    fireEvent.click(within(reader).getByRole('button', { name: 'Go on without it' }))
    expect(run).toHaveBeenLastCalledWith({ type: 'skip', council: council.id, turn: council.rounds[0]!.rows[1]!.turn })
  })

  it('keeps framing controls, crux, counts, objections, left-out seats and follow-up reachable', () => {
    const council = councilFixture({ stage: 'done', rows: [row('chair', 'framing', 'done'), row('A', 'crux', 'done'), row('chair', 'verdict', 'done')], leftOut: ['B'],
      framing: { headings: [], words: 300, angles: [], kinds: ['decision'], criteria: [{ id: 'C1', text: 'Simple', source: 'question' }], research: { needed: false, reason: '', byUser: false }, fallback: false },
      crux: { test: 'Check the file', lookup: true, sides: [['A'], ['B']], meanings: [], result: 'Confirmed' },
      verdict: { text: 'Keep the change.', counts: { ...counts, changed: ['A'] }, fairnessDone: true, objections: [{ seat: 'A', claim: 'Keep it', passage: 'Change it', answer: 'amended' }] } })
    render(<RoundRecord council={council} round={council.rounds[0]!} run={vi.fn()} />)
    expect(screen.getByText('Keep the change.')).toBeInTheDocument()
    expect(screen.getByText('Changed their answers: A.')).toBeInTheDocument()
    expect(screen.getByText('The chair amended it.')).toBeInTheDocument()
    expect(screen.getByText('The Council went on without B.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up' })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: /Read Crux check/ }))
    expect(screen.getByText('Crux check, a lookup: Check the file Result: Confirmed')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: /Read Framing/ }))
    expect(screen.getByText('Framed as a decision.')).toBeInTheDocument()
  })


  it('keeps editable framing and closes its criteria from any control with Escape', async () => {
    const run = vi.fn()
    const council = councilFixture({ reframable: true, rows: [row('chair', 'framing', 'done'), row('A', 'answer', 'working')],
      framing: { headings: [], words: 300, angles: [], kinds: ['decision'], criteria: [{ id: 'C1', text: 'Simple', source: 'question' }], research: { needed: false, reason: '', byUser: false }, fallback: false } })
    render(<RoundRecord council={council} round={council.rounds[0]!} run={run} />)
    const framing = screen.getByText('Framed as a decision.')
    expect(framing.closest('details')).not.toHaveAttribute('open')
    fireEvent.click(framing)
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'review' } })
    expect(run).toHaveBeenLastCalledWith({ type: 'reframe', council: council.id, kinds: ['review'] })
    fireEvent.click(screen.getByRole('button', { name: 'Change the criteria' }))
    expect(screen.getByRole('textbox', { name: 'Criteria, one to five, one on each line' })).toHaveValue('Simple')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change the criteria' })).toHaveFocus())
    fireEvent.keyDown(screen.getByRole('button', { name: 'Change the criteria' }), { key: 'Escape' })
    expect(framing.closest('details')).not.toHaveAttribute('open')
    expect(framing).toHaveFocus()
  })

  it('keeps framing, crux and verdict readable when their turns have been left out', () => {
    const council = councilFixture({ stage: 'done', rows: [],
      framing: { headings: [], words: 0, angles: [], kinds: ['decision'], criteria: [], research: { needed: false, reason: '', byUser: false }, fallback: true },
      crux: { test: 'Read the file', lookup: false, sides: [['A'], ['B']], meanings: [] },
      verdict: { text: null, counts, fairnessDone: true, objections: [] } })
    render(<RoundRecord council={council} round={council.rounds[0]!} run={vi.fn()} />)
    expect(screen.getByText(/chair’s framing could not be read/)).toBeInTheDocument()
    expect(screen.getByText('Crux check: Read the file')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Verdict' })).toBeInTheDocument()
    expect(screen.getByRole('table').querySelectorAll('button')).toHaveLength(0)
  })

  it('folds earlier rounds and restores their chosen cell when reopened', () => {
    const council = councilFixture({ rows: [row('A', 'answer', 'done'), row('B', 'review', 'done')] })
    const first = council.rounds[0]!
    council.rounds.push({ ...first, index: 1, question: 'Next question' })
    const { container } = render(<RoundRecord council={council} round={first} run={vi.fn()} />)
    const fold = container.querySelector('.council-round')!
    const toggle = screen.getByRole('button', { name: /Move history/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: /Read Reviews/ }))
    fireEvent.keyDown(fold, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(within(screen.getByRole('table')).getByRole('button', { name: /Read Reviews/ })).toHaveAttribute('aria-pressed', 'true')
  })
})
