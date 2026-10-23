import { createBridge, renderApp, shell } from '../../fixtures/renderer/appHarness'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

afterEach(cleanup)

const settingsTab = (name: string): HTMLElement => within(screen.getByRole('tablist', { name: 'Settings sections' })).getByRole('tab', { name })

it('opens Settings where an Open Settings press asked, for that visit only (ADR-0114)', async () => {
  renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })) }))
  await waitFor(() => expect(shell.navigation).toBe('threads'))
  act(() => shell.navigate('settings', 'settings-history'))
  await waitFor(() => expect(settingsTab('Application')).toHaveAttribute('aria-selected', 'true'))
  act(() => shell.navigate('threads'))
  // Back through the ordinary Settings link: the first page, not the place asked for last time.
  act(() => shell.navigate('settings'))
  await waitFor(() => expect(settingsTab('Dictation')).toHaveAttribute('aria-selected', 'true'))
})
