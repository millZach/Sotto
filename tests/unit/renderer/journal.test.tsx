import { deferred } from '../../fixtures/deferred'
import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Journal, type JournalProps } from '../../../src/renderer/src/features/dictate/Journal'
import { journalRow, transcriptFacts } from '../../../src/renderer/src/features/dictate/journalFacts'
import type { DictationRecord } from '../../../src/shared/dictationRecord'
import type { HistoryEntry } from '../../../src/shared/history'

afterEach(cleanup)

const NOW = new Date(2026, 9, 21, 16, 20).valueOf()
const at = (daysAgo: number, hour: number, minute = 0): number => {
  const date = new Date(NOW)
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hour, minute, 0, 0)
  return date.valueOf()
}

const entries: HistoryEntry[] = [
  { id: '1', text: 'Alpha note for the team', createdAt: at(0, 9), durationMs: 2_000, language: 'en', modelPreset: 'parakeet', app: 'Microsoft Outlook' },
  { id: '2', text: 'beta NOTE in the terminal', createdAt: at(1, 15), durationMs: 3_000, language: 'en', modelPreset: 'parakeet' },
]
const records: DictationRecord[] = [
  { id: '1', createdAt: at(0, 9), durationMs: 2_000, words: 5, app: 'Microsoft Outlook' },
  // The second transcript is from before transcripts carried an app; its record knows it.
  { id: '2', createdAt: at(1, 15), durationMs: 3_000, words: 5, app: 'Windows Terminal' },
]

const baseProps: JournalProps = {
  entries,
  records,
  historyEnabled: true,
  status: 'ready',
  now: NOW,
  chips: ['Microsoft Outlook', 'Windows Terminal'],
  onCopy: vi.fn(async () => true),
  onDelete: vi.fn(async () => true),
  onClear: vi.fn(async () => true),
  onOpenSettings: vi.fn(),
}

async function openMore(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'More transcript actions' }))
}

describe('Journal', () => {
  it('groups transcripts under Today and Yesterday with each day’s words and pace, and names the app in each row', () => {
    render(<Journal {...baseProps} />)
    const today = screen.getByRole('region', { name: 'Today' })
    expect(within(today).getByRole('heading', { level: 2, name: 'Today' })).toBeVisible()
    expect(today).toHaveTextContent('5 words · 150 wpm')
    expect(today).toHaveTextContent('Microsoft Outlook · 5 words · 150 wpm')
    const yesterday = screen.getByRole('region', { name: 'Yesterday' })
    // The app comes from the record when the transcript does not carry one.
    expect(yesterday).toHaveTextContent('Windows Terminal · 5 words · 100 wpm')
  })

  it('opens a week first and the seven days before on request, or the newest week with dictation after a quiet one', async () => {
    const user = userEvent.setup()
    const spread: HistoryEntry[] = [
      { ...entries[0]!, id: 'recent', createdAt: at(2, 10) },
      { ...entries[0]!, id: 'older', text: 'An older thought', createdAt: at(9, 10) },
      { ...entries[0]!, id: 'oldest', text: 'The oldest thought', createdAt: at(20, 10) },
    ]
    const { rerender } = render(<Journal {...baseProps} entries={spread} />)
    expect(screen.queryByText('An older thought')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show the 7 days before' }))
    expect(screen.getByText('An older thought')).toBeVisible()
    expect(screen.queryByText('The oldest thought')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show the 7 days before' }))
    expect(screen.getByText('The oldest thought')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Show the 7 days before' })).not.toBeInTheDocument()

    rerender(<Journal {...baseProps} entries={spread.slice(1)} />)
    // Nothing in the last week: the feed opens on the newest day there is, not on an empty list.
    expect(screen.getByText('An older thought')).toBeVisible()
  })

  it('searches with trimmed case-insensitive matching, filters by app chip, and copies through its safe action', async () => {
    const user = userEvent.setup()
    const copy = vi.fn(async () => true)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<Journal {...baseProps} onCopy={copy} />)

    const chips = screen.getByRole('group', { name: 'Show transcripts from' })
    expect(within(chips).getAllByRole('button').map((chip) => chip.textContent)).toEqual(['All', 'Microsoft Outlook', 'Windows Terminal'])
    expect(within(chips).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(chips).getByRole('button', { name: 'Windows Terminal' }))
    expect(screen.queryByText('Alpha note for the team')).not.toBeInTheDocument()
    expect(screen.getByText('beta NOTE in the terminal')).toBeVisible()
    await user.click(within(chips).getByRole('button', { name: 'All' }))

    await user.type(screen.getByRole('searchbox', { name: 'Search transcripts' }), '  ALPHA  ')
    expect(screen.getByText('Alpha note for the team')).toBeVisible()
    expect(screen.queryByText('beta NOTE in the terminal')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy transcript' }))
    expect(copy).toHaveBeenCalledWith('Alpha note for the team')
    expect(writeText).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('Transcript copied.')

    await user.click(screen.getByRole('searchbox', { name: 'Search transcripts' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('searchbox', { name: 'Search transcripts' })).toHaveValue('')
    expect(screen.getByText('beta NOTE in the terminal')).toBeVisible()
  })

  it('opens a row in place on its full facts with Copy and Delete, and Escape closes it back to its toggle', async () => {
    const user = userEvent.setup()
    render(<Journal {...baseProps} />)
    const toggle = screen.getAllByRole('button', { name: /^Transcript from/ })[0]!
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Delete saved transcript' })).not.toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const facts = document.getElementById(toggle.getAttribute('aria-controls')!)
    expect(facts).toHaveTextContent('2 seconds, 5 words at 150 wpm. English, Parakeet model, in Microsoft Outlook. Kept on this computer only.')
    await user.tab()
    expect(screen.getAllByRole('button', { name: 'Copy transcript' })[0]).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Delete saved transcript' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
  })

  it('labels MAI and earlier transcripts, and names no app it does not know', () => {
    const entry = { ...entries[1]!, app: undefined }
    expect(transcriptFacts(journalRow({ ...entry, modelPreset: 'mai' }, undefined)).rest).toBe('English, MAI-Transcribe-2 model. Kept on this computer only.')
    expect(transcriptFacts(journalRow({ ...entry, modelPreset: 'instant' }, undefined)).rest).toContain('an earlier model.')
  })

  it('confirms deletion with safe initial focus, Escape, and focus restoration', async () => {
    const user = userEvent.setup()
    const remove = vi.fn(async () => true)
    render(<Journal {...baseProps} onDelete={remove} />)
    await user.click(screen.getAllByRole('button', { name: /^Transcript from/ })[0]!)
    const trigger = screen.getByRole('button', { name: 'Delete saved transcript' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Delete transcript?' })
    expect(dialog).toHaveTextContent('This removes the transcript and its numbers from this computer.')
    expect(screen.getByRole('button', { name: 'Keep transcript' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(remove).not.toHaveBeenCalled()
  })

  it('keeps Clear history in the More menu, which Escape closes back to its button', async () => {
    const user = userEvent.setup()
    render(<Journal {...baseProps} />)
    expect(screen.queryByRole('button', { name: 'Clear history' })).not.toBeInTheDocument()
    await openMore(user)
    const item = screen.getByRole('menuitem', { name: 'Clear history' })
    expect(item).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More transcript actions' })).toHaveFocus()
    await openMore(user)
    await user.click(screen.getByRole('menuitem', { name: 'Clear history' }))
    expect(screen.getByRole('dialog', { name: 'Clear history?' })).toHaveTextContent('every saved transcript, and the numbers the Dictate room counts')
  })

  it('does not duplicate private transcript text in accessible action names', () => {
    render(<Journal {...baseProps} />)
    for (const row of screen.getAllByRole('listitem')) {
      expect(within(row).getByRole('button', { name: 'Copy transcript' })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: /^Transcript from/ })).toBeVisible()
    }
    expect(screen.queryByRole('button', { name: /alpha note|beta note/i })).not.toBeInTheDocument()
  })

  it.each([
    ['delete', 'Transcript could not be deleted.'],
    ['clear', 'History could not be cleared.'],
  ] as const)('keeps a finite %s failure visible inside the active dialog', async (operation, message) => {
    const user = userEvent.setup()
    render(<Journal {...baseProps} onDelete={vi.fn(async () => false)} onClear={vi.fn(async () => false)} />)
    if (operation === 'delete') {
      await user.click(screen.getAllByRole('button', { name: /^Transcript from/ })[0]!)
      await user.click(screen.getByRole('button', { name: 'Delete saved transcript' }))
      await user.click(screen.getByRole('button', { name: 'Delete transcript' }))
    } else {
      await openMore(user)
      await user.click(screen.getByRole('menuitem', { name: 'Clear history' }))
      await user.click(screen.getByRole('button', { name: 'Clear all transcripts' }))
    }
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole('alert')).toHaveTextContent(message)
  })

  it('moves focus to the Journal heading when a delete or a clear takes away what opened it', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Journal {...baseProps} onDelete={async () => {
      rerender(<Journal {...baseProps} entries={entries.slice(1)} />)
      return true
    }} />)
    await user.click(screen.getAllByRole('button', { name: /^Transcript from/ })[0]!)
    await user.click(screen.getByRole('button', { name: 'Delete saved transcript' }))
    await user.click(screen.getByRole('button', { name: 'Delete transcript' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Transcripts' })).toHaveFocus())
    cleanup()

    const cleared = render(<Journal {...baseProps} onClear={async () => {
      cleared.rerender(<Journal {...baseProps} entries={[]} records={[]} />)
      return true
    }} />)
    await openMore(user)
    await user.click(screen.getByRole('menuitem', { name: 'Clear history' }))
    await user.click(screen.getByRole('button', { name: 'Clear all transcripts' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Transcripts' })).toHaveFocus())
    expect(screen.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible()
  })

  it('blocks duplicate destructive submissions and clears only after confirmation', async () => {
    const user = userEvent.setup()
    let resolve!: (value: boolean) => void
    const clear = vi.fn(() => { const pending = deferred<boolean>(); resolve = pending.resolve; return pending.promise })
    render(<Journal {...baseProps} onClear={clear} />)
    await openMore(user)
    await user.click(screen.getByRole('menuitem', { name: 'Clear history' }))
    const confirm = screen.getByRole('button', { name: 'Clear all transcripts' })
    await user.click(confirm)
    expect(confirm).toBeDisabled()
    await user.click(confirm)
    expect(clear).toHaveBeenCalledOnce()
    resolve(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it.each([
    ['loading', /loading transcripts/i],
    ['degraded', /transcripts could not be loaded/i],
  ] as const)('renders the %s state without unsafe controls', (status, message) => {
    render(<Journal {...baseProps} status={status} entries={[]} />)
    expect(screen.getByRole('heading', { name: message })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'More transcript actions' })).not.toBeInTheDocument()
  })

  it('distinguishes an empty Journal from a search with no matches, and keeps the search for Ctrl+K either way', async () => {
    const user = userEvent.setup()
    const rendered = render(<Journal {...baseProps} entries={[]} records={[]} />)
    expect(screen.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible()
    expect(screen.getByRole('searchbox', { name: 'Search transcripts' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'More transcript actions' })).not.toBeInTheDocument()
    rendered.rerender(<Journal {...baseProps} />)
    await user.type(screen.getByRole('searchbox'), 'missing')
    expect(screen.getByRole('heading', { name: /Nothing matches .missing./ })).toBeVisible()
  })

  it('keeps the full timestamp in the row action name', () => {
    const createdAt = new Date(2026, 9, 21, 14, 1, 42).valueOf()
    render(<Journal {...baseProps} entries={[{ ...entries[0]!, createdAt }]} />)
    expect(document.querySelector('.journal-entry__time time')?.getAttribute('datetime')).toBe(new Date(createdAt).toISOString())
    expect(screen.getByRole('button', { name: `Transcript from ${new Date(createdAt).toLocaleString()}, 5 words` })).toBeVisible()
  })

  it('says History is off above older transcripts, which stay listed, deletable and clearable', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    const { rerender } = render(<Journal {...baseProps} historyEnabled={false} onOpenSettings={onOpenSettings} />)
    expect(screen.getByText('History is off. New dictations keep their numbers only; older transcripts stay here until you delete them.')).toBeVisible()
    expect(screen.getByText('Alpha note for the team')).toBeVisible()
    await user.click(screen.getAllByRole('button', { name: /^Transcript from/ })[0]!)
    expect(screen.getByRole('button', { name: 'Delete saved transcript' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'More transcript actions' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()

    // With no transcripts left, the numbers alone can still be cleared.
    rerender(<Journal {...baseProps} historyEnabled={false} entries={[]} />)
    expect(screen.getByText('History is off. New dictations keep their numbers only.')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Nothing here yet.' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More transcript actions' })).toBeEnabled()
  })
})
