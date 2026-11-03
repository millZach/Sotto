import { createBridge, openPage, renderApp } from '../../fixtures/renderer/appHarness'
import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

// The application menu's Settings… (Cmd+, on a Mac, Ctrl+, on Windows and Linux) asks the window for Settings (#1825).
describe('the application menu’s Settings…', () => {
  function bridgeAsking(onboardingComplete: boolean): { readonly bridge: ReturnType<typeof createBridge>; readonly ask: () => void } {
    let request: (() => void) | null = null
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete })),
      onSettingsRequested: vi.fn((listener: () => void) => {
        request = listener
        return () => undefined
      }),
    })
    return { bridge, ask: () => request?.() }
  }

  it('opens Settings from another page', async () => {
    const { bridge, ask } = bridgeAsking(true)
    renderApp(bridge)
    await openPage('home')
    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    act(() => ask())
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
  })

  it('leaves first-run setup where it is', async () => {
    const { bridge, ask } = bridgeAsking(false)
    renderApp(bridge)
    await vi.waitFor(() => expect(bridge.onSettingsRequested).toHaveBeenCalled())
    act(() => ask())
    expect(screen.queryByRole('heading', { level: 1, name: 'Settings' })).not.toBeInTheDocument()
  })
})
