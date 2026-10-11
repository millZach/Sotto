import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../../../src/shared/contracts'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { useWatcherEnabled, watcherEnabledOf } from '../../../src/renderer/src/state/watcherFeature'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'
import { deferred } from '../../fixtures/deferred'

afterEach(cleanup)

describe('renderer Watcher startup gate', () => {
  it('fails closed outside the app and before main answers, without guessing from Owl branding', () => {
    expect(renderHook(() => useWatcherEnabled()).result.current).toBe(false)
    expect(watcherEnabledOf(null)).toBe(false)
    expect(watcherEnabledOf({ currentVersion: '0.1.37-owl.20261011.1', releaseTrack: 'owl', phase: { phase: 'unsupported' }, checkedAt: null })).toBe(false)
  })

  it.each([['owl', true], ['stable', false], ['owl', false], ['stable', true]] as const)(
    "uses main's %s gate (%s), including an unpackaged override", async (releaseTrack, watcherEnabled) => {
      const answer = deferred<UpdateStatus>()
      const bridge = createBridge({ getUpdateStatus: () => answer.promise })
      const { result } = renderHook(() => useWatcherEnabled(), {
        wrapper: ({ children }) => <AppProvider bridge={bridge} createController={createController}>{children}</AppProvider>,
      })
      expect(result.current).toBe(false)
      await act(async () => answer.resolve({ currentVersion: releaseTrack === 'owl' ? '0.1.37-owl.20261011.1' : '0.1.36',
        releaseTrack, watcherEnabled, phase: { phase: 'unsupported' }, checkedAt: null }))
      await waitFor(() => expect(result.current).toBe(watcherEnabled))
    },
  )
})
