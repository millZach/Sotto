import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThreadsTour } from '../../../src/renderer/src/features/onboarding/ThreadsTour'

/** The four parts of the Threads page the tour points at, laid out with a size so the tour counts them as on the page. */
type Part = 'sidebar' | 'new-thread' | 'workspace' | 'settings'
const ALL_PARTS: readonly Part[] = ['sidebar', 'new-thread', 'workspace', 'settings']

function ThreadsPage({ parts }: { readonly parts: readonly Part[] }): React.ReactNode {
  return (
    <>
      {parts.includes('sidebar') || parts.includes('new-thread') || parts.includes('settings') ? (
        <aside className="thread-nav" data-testid="sidebar" data-part={parts.includes('sidebar') ? 'shown' : 'hidden'}>
          {parts.includes('new-thread') ? <button type="button" aria-label="New thread" data-part="shown">+</button> : null}
          {parts.includes('settings') ? <a className="thread-nav__page" href="#settings" data-part="shown">Settings</a> : null}
        </aside>
      ) : null}
      {parts.includes('workspace') ? <section className="thread-workspace" data-part="shown" /> : null}
    </>
  )
}

function renderTour(onDone = vi.fn(), parts: readonly Part[] = ALL_PARTS) {
  render(<><ThreadsPage parts={parts} /><ThreadsTour shortcut="Ctrl+Shift+Space" platform="win32" onDone={onDone} /></>)
  return onDone
}

beforeEach(() => {
  // jsdom lays nothing out, so a part marked shown reports a box and anything else reports none.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const shown = this.getAttribute('data-part') === 'shown'
    return { top: 20, left: 20, width: shown ? 200 : 0, height: shown ? 40 : 0, right: shown ? 220 : 20, bottom: shown ? 60 : 20, x: 20, y: 20, toJSON: () => ({}) } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('ThreadsTour', () => {
  it('steps forward and back in order, and Done ends it once', async () => {
    const user = userEvent.setup()
    const onDone = renderTour()

    expect(screen.getByRole('heading', { name: 'Projects and threads' })).toBeVisible()
    await waitFor(() => expect(screen.getByText('1 of 4')).toBeVisible())
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible()
    expect(screen.getByText('2 of 4')).toBeVisible()
    expect(screen.getByText(/press Ctrl\+Shift\+Space and speak it/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('heading', { name: 'Projects and threads' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(screen.getByText('4 of 4')).toBeVisible()
    // The last stop drops Skip tour and offers Done instead of Next.
    expect(screen.queryByRole('button', { name: 'Skip tour' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('lights the part each stop names', async () => {
    renderTour()
    await waitFor(() => expect(document.querySelector('.threads-tour__scrim')).toHaveAttribute('data-hole', 'true'))
  })

  it('Skip tour ends it from any stop before the last', async () => {
    const user = userEvent.setup()
    const onDone = renderTour()
    await user.click(screen.getByRole('button', { name: 'Skip tour' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('Escape ends the tour and calls onDone only once', async () => {
    const user = userEvent.setup()
    const onDone = renderTour()
    await user.keyboard('{Escape}')
    expect(onDone).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('keeps Tab inside the note, wrapping at both ends', async () => {
    const user = userEvent.setup()
    renderTour()
    const skipTour = screen.getByRole('button', { name: 'Skip tour' })
    const next = screen.getByRole('button', { name: 'Next' })

    await user.tab()
    expect(skipTour).toHaveFocus()
    await user.tab()
    expect(next).toHaveFocus()
    await user.tab()
    expect(skipTour).toHaveFocus()
    await user.tab({ shift: true })
    expect(next).toHaveFocus()
  })

  it('passes over a part that is not on the page and counts only the parts it can show', async () => {
    const user = userEvent.setup()
    renderTour(vi.fn(), ['sidebar', 'workspace', 'settings'])
    await waitFor(() => expect(screen.getByText('1 of 3')).toBeVisible())
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'Threads' })).toBeVisible()
    expect(screen.getByText('2 of 3')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('heading', { name: 'Projects and threads' })).toBeVisible()
  })

  it('moves on from a first stop whose part never appears', async () => {
    renderTour(vi.fn(), ['new-thread', 'workspace', 'settings'])
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
  })

  it('ends when none of the parts is on the page', async () => {
    const onDone = renderTour(vi.fn(), [])
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('tells Linux to hold F9 with the Hyprland bindings rather than press the shortcut', async () => {
    const user = userEvent.setup()
    render(<><ThreadsPage parts={ALL_PARTS} /><ThreadsTour shortcut="CommandOrControl+Shift+Space" platform="linux" onDone={vi.fn()} /></>)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/Type your message, or hold F9 to speak it with Sotto’s Hyprland bindings\./)).toBeVisible()
    expect(screen.queryByText(/Shift\+Space/)).toBeNull()
  })

  it('shows the Threads sidebar rather than Terminal mode for the tour', () => {
    localStorage.setItem('sotto.threadWorkspace.mode', 'terminals')
    renderTour()
    expect(localStorage.getItem('sotto.threadWorkspace.mode')).toBe('threads')
  })
})
