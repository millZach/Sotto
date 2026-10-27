import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageView } from '../../../src/renderer/src/features/usage/UsageView'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { USAGE_NOW, USAGE_ZONE, dashboard, fixtureBridge } from '../../fixtures/renderer/usageReads'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

/**
 * The Usage page with restarting stopped threads on (ADR-0144; Owl only): babysitting's wake-ups are gone, so the page
 * names no wake-ups. Watcher's news counts as Watcher's in the store; a restart note is a prompt Sotto sent.
 */
afterEach(() => { cleanup(); vi.clearAllMocks() })
const laptop = { hostId: 'laptop', name: 'zach-laptop', kind: 'local' as const, connected: true }

async function open(restart: boolean) {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'restart-stopped-threads': restart } } } as unknown as AppContextValue)
  render(<UsageView now={() => USAGE_NOW} timeZone={USAGE_ZONE} computers={[laptop]} bridge={fixtureBridge(dashboard())} />)
  await screen.findByRole('tablist', { name: 'Usage measures' })
  return userEvent.setup()
}
const measure = (name: RegExp) => within(screen.getByRole('tablist', { name: 'Usage measures' })).getByRole('tab', { name })

describe('Usage with restarting stopped threads on', () => {
  it('says who sent the prompts without wake-ups, and Where you work counts no wake-ups', async () => {
    const user = await open(true)
    const prompts = screen.getByRole('tabpanel', { name: /Prompts/u })
    expect(prompts).toHaveTextContent('You sent 190 and Watcher 0.')
    expect(prompts).not.toHaveTextContent('wake-up')
    await user.click(measure(/^Where /u))
    const rows = within(screen.getByRole('tabpanel', { name: /Where/u })).getAllByRole('listitem')
    expect(rows[1]).toHaveTextContent('130 prompts')
    expect(rows[1]).not.toHaveTextContent('wake-ups')
  })

  it('says what a prompt is in About these numbers', async () => {
    await open(true)
    expect(screen.getByText(/^Prompts are what you and Watcher sent, and Sotto’s notes when it restarts a thread\./u)).toBeInTheDocument()
  })

  it('keeps the wake-up wording on stable', async () => {
    await open(false)
    expect(screen.getByRole('tabpanel', { name: /Prompts/u })).toHaveTextContent('You sent 190, Watcher 0 and wake-ups 10.')
    expect(screen.getByText(/^Prompts are what you, Watcher and wake-ups sent\./u)).toBeInTheDocument()
  })
})
