import React from 'react'
import { createBridge, renderApp, shell } from '../../fixtures/renderer/appHarness'
import { act, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

vi.mock('../../../src/renderer/src/agents/ClientUpdateCard', () => ({
  ClientUpdateCard: () => <aside aria-label="Client updates">An update is ready</aside>,
}))

it.each(['win32', 'darwin', 'linux'] as const)('defers the corner client notice until setup finishes on %s', async platform => {
  let complete = false
  let settingsChanged: ((settings: typeof DEFAULT_SETTINGS) => void) | undefined
  renderApp(createBridge({ platform,
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: complete })),
    onSettingsChanged: listener => { settingsChanged = listener; return () => undefined },
  }))
  await screen.findByRole('button', { name: 'Get started' })
  expect(screen.queryByRole('complementary', { name: 'Client updates' })).toBeNull()
  complete = true
  act(() => { settingsChanged!({ ...DEFAULT_SETTINGS, onboardingComplete: complete }); shell.navigate('threads') })
  await waitFor(() => expect(screen.getByRole('complementary', { name: 'Client updates' })).toBeVisible())
})
