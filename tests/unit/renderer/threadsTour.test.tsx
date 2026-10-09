import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThreadsTour } from '../../../src/renderer/src/features/onboarding/ThreadsTour'

afterEach(cleanup)

describe('ThreadsTour', () => {
  it('steps forward and back in order, and Done ends it once', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<ThreadsTour shortcut="Control+Shift+Space" platform="darwin" onDone={onDone} />)

    expect(screen.getByRole('heading', { name: 'Projects and threads' })).toBeVisible()
    expect(screen.getByText('1 of 4')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible()
    expect(screen.getByText('2 of 4')).toBeVisible()

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

  it('Skip tour ends it from any stop before the last', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<ThreadsTour shortcut="Ctrl+Shift+Space" platform="win32" onDone={onDone} />)
    await user.click(screen.getByRole('button', { name: 'Skip tour' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('Escape ends the tour and calls onDone only once', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<ThreadsTour shortcut="Ctrl+Shift+Space" platform="win32" onDone={onDone} />)
    await user.keyboard('{Escape}')
    expect(onDone).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('keeps Tab inside the note, wrapping at both ends', async () => {
    const user = userEvent.setup()
    render(<ThreadsTour shortcut="Ctrl+Shift+Space" platform="win32" onDone={vi.fn()} />)
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

  it('leaves the note centred with no hole when a stop\'s target is not on the page', () => {
    render(<ThreadsTour shortcut="Ctrl+Shift+Space" platform="win32" onDone={vi.fn()} />)
    const scrim = document.querySelector('.threads-tour__scrim')
    expect(scrim).not.toBeNull()
    expect(scrim).toHaveAttribute('data-hole', 'false')
    expect(scrim).not.toHaveAttribute('style')
  })
})
