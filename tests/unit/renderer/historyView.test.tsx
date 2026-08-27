import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HistoryView } from '../../../src/renderer/src/features/history/HistoryView'
import type { HistoryEntry } from '../../../src/shared/history'

afterEach(cleanup)

const entries: HistoryEntry[] = [
  { id: '1', text: 'Alpha note', createdAt: 2, durationMs: 10, language: 'en', modelPreset: 'balanced' },
  { id: '2', text: 'beta NOTE', createdAt: 1, durationMs: 10, language: 'en', modelPreset: 'balanced' },
]

const baseProps = {
  entries,
  enabled: true,
  status: 'ready' as const,
  onCopy: vi.fn(async () => true),
  onDelete: vi.fn(async () => true),
  onClear: vi.fn(async () => true),
}

describe('HistoryView', () => {
  it('searches locally with trimmed case-insensitive matching and copies through its safe action', async () => {
    const user = userEvent.setup()
    const copy = vi.fn(async () => true)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<HistoryView {...baseProps} onCopy={copy} />)

    await user.type(screen.getByRole('searchbox', { name: /search transcripts/i }), '  ALPHA  ')
    expect(screen.getByText('Alpha note')).toBeVisible()
    expect(screen.queryByText('beta NOTE')).not.toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Copy transcript' })[0]!)
    expect(copy).toHaveBeenCalledWith('Alpha note')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('confirms deletion with safe initial focus, Escape, and focus restoration', async () => {
    const user = userEvent.setup()
    const remove = vi.fn(async () => true)
    render(<HistoryView {...baseProps} onDelete={remove} />)

    const trigger = screen.getAllByRole('button', { name: 'Delete saved transcript' })[0]!
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: /delete transcript/i })).toBeVisible()
    expect(screen.getByRole('button', { name: /keep transcript/i })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(remove).not.toHaveBeenCalled()
  })

  it('does not duplicate private transcript text in accessible action names', () => {
    render(<HistoryView {...baseProps} />)
    const rows = screen.getAllByRole('listitem')
    for (const row of rows) {
      expect(within(row).getByRole('button', { name: 'Copy transcript' })).toBeVisible()
      expect(within(row).getByRole('button', { name: 'Delete saved transcript' })).toBeVisible()
    }
    expect(screen.queryByRole('button', { name: /alpha note|beta note/i })).not.toBeInTheDocument()
  })

  it.each([
    ['delete', 'Transcript could not be deleted.'],
    ['clear', 'History could not be cleared.'],
  ] as const)('keeps a finite %s failure visible inside the active dialog', async (operation, message) => {
    const user = userEvent.setup()
    render(<HistoryView {...baseProps} onDelete={vi.fn(async () => false)} onClear={vi.fn(async () => false)} />)
    if (operation === 'delete') {
      await user.click(screen.getAllByRole('button', { name: 'Delete saved transcript' })[0]!)
      await user.click(screen.getByRole('button', { name: 'Delete transcript' }))
    } else {
      await user.click(screen.getByRole('button', { name: 'Clear history' }))
      await user.click(screen.getByRole('button', { name: 'Clear all transcripts' }))
    }
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole('alert')).toHaveTextContent(message)
  })

  it('focuses the History heading when successful deletion removes its trigger', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<HistoryView {...baseProps} onDelete={async () => {
      rerender(<HistoryView {...baseProps} entries={entries.slice(1)} />)
      return true
    }} />)
    await user.click(screen.getAllByRole('button', { name: 'Delete saved transcript' })[0]!)
    await user.click(screen.getByRole('button', { name: 'Delete transcript' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'History' })).toHaveFocus())
  })

  it('focuses the History heading when clearing history removes its trigger', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<HistoryView {...baseProps} onClear={async () => {
      rerender(<HistoryView {...baseProps} entries={[]} />)
      return true
    }} />)
    await user.click(screen.getByRole('button', { name: 'Clear history' }))
    await user.click(screen.getByRole('button', { name: 'Clear all transcripts' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'History' })).toHaveFocus())
  })

  it('blocks duplicate destructive submissions and clears only after confirmation', async () => {
    const user = userEvent.setup()
    let resolve!: (value: boolean) => void
    const clear = vi.fn(() => new Promise<boolean>((done) => { resolve = done }))
    render(<HistoryView {...baseProps} onClear={clear} />)
    await user.click(screen.getByRole('button', { name: /clear history/i }))
    const confirm = screen.getByRole('button', { name: /clear all transcripts/i })
    await user.click(confirm)
    expect(confirm).toBeDisabled()
    await user.click(confirm)
    expect(clear).toHaveBeenCalledOnce()
    resolve(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it.each([
    ['loading', true, /loading transcript history/i],
    ['degraded', true, /history could not be loaded/i],
    ['ready', false, /history is turned off/i],
  ] as const)('renders the %s state without unsafe controls', (status, enabled, message) => {
    render(<HistoryView {...baseProps} status={status} enabled={enabled} entries={[]} />)
    expect(screen.getByText(message)).toBeVisible()
    expect(screen.queryByRole('button', { name: /clear history/i })).not.toBeInTheDocument()
  })

  it('distinguishes empty history from a search with no matches', async () => {
    const user = userEvent.setup()
    const rendered = render(<HistoryView {...baseProps} entries={[]} />)
    expect(screen.getByText(/no saved transcripts yet/i)).toBeVisible()
    rendered.rerender(<HistoryView {...baseProps} />)
    await user.type(screen.getByRole('searchbox'), 'missing')
    expect(screen.getByText(/no transcripts match/i)).toBeVisible()
  })

  it('stacks the log stamp into date and clock lines without dropping the full date from the accessible name', () => {
    const createdAt = new Date(2026, 7, 27, 14, 1, 42).valueOf()
    render(<HistoryView {...baseProps} entries={[{ ...entries[0]!, createdAt }]} />)

    const stamp = document.querySelector('.history-entry__meta time')
    expect(stamp).not.toBeNull()
    const lines = [...stamp!.querySelectorAll('span')].map((span) => span.textContent)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('14:01')
    expect(stamp!.getAttribute('datetime')).toBe(new Date(createdAt).toISOString())
    // The short stamp is decoration; assistive tech still hears the whole date.
    expect(stamp!.getAttribute('aria-label')).toBe(new Date(createdAt).toLocaleString())
  })

  it('keeps existing local entries visible and clearable after new history is disabled', () => {
    render(<HistoryView {...baseProps} enabled={false} />)
    expect(screen.getByText(/existing local transcripts remain available/i)).toBeVisible()
    expect(screen.getByText('Alpha note')).toBeVisible()
    expect(screen.getByRole('button', { name: /clear history/i })).toBeEnabled()
  })
})
