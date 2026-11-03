import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalAppsSettings } from '../../../../../src/renderer/src/features/settings/LocalAppsSettings'
import type { LocalAppsBridge, LocalAppsState } from '../../../../../src/shared/localApps'
import { deferred } from '../../../../fixtures/deferred'

afterEach(cleanup)

it('reports a failed local app read and clears the notice when status arrives', async () => {
  const pending = deferred<LocalAppsState>()
  let publish!: (state: LocalAppsState) => void
  const bridge: LocalAppsBridge = { get: () => pending.promise, onChanged: listener => { publish = listener; return vi.fn() } }
  render(<LocalAppsSettings localApps onUpdateSettings={async () => true} bridge={bridge} />)
  await act(async () => { pending.reject(new Error('ENOENT /private/local-apps.json')) })
  expect(screen.getByRole('alert')).toHaveTextContent('Local app access could not be read. Reopen Settings and try again.')
  expect(document.body).not.toHaveTextContent('/private/')
  act(() => publish({ phase: 'on', localHostRunning: true }))
  expect(screen.queryByRole('alert')).toBeNull()
})
