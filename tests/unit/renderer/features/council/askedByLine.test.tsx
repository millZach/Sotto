import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AskedByLine } from '../../../../../src/renderer/src/features/council/AskedByLine'
import { councilMode, openCouncilFor } from '../../../../../src/renderer/src/features/council/councilDraft'
import { PaneTerminalChromeStore } from '../../../../../src/renderer/src/tools/paneTerminalStore'

// A Council a thread's agent asked for (ADR-0177, November 5, 2026): its record says who asked, quoting the user while
// their words are kept, and the asking thread's pane opens its Council tab in the mode it started.
afterEach(cleanup)

describe('AskedByLine', () => {
  it('names the provider and quotes the user\'s words', () => {
    render(<AskedByLine askedBy={{ provider: 'claude', words: 'Synthetic: have the council review this' }} />)
    expect(screen.getByText('Asked by Claude Code in this thread, because you said “Synthetic: have the council review this”')).toBeTruthy()
  })
  it('says the user asked when their words are not kept, and nothing for a Council the user started', () => {
    const { container, rerender } = render(<AskedByLine askedBy={{ provider: 'codex', words: null }} />)
    expect(screen.getByText('Asked by Codex in this thread, at your request.')).toBeTruthy()
    rerender(<AskedByLine askedBy={undefined} />)
    expect(container.textContent).toBe('')
  })
})

describe('openCouncilFor', () => {
  it('opens the pane\'s drawer on the Council tab in the mode the agent started', () => {
    const store = new PaneTerminalChromeStore(null)
    openCouncilFor('thread-a', 'climb', store)
    expect(store.get('thread-a')).toMatchObject({ open: true, view: 'council' })
    expect(councilMode('thread-a')).toBe('climb')
  })
})
