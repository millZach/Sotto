import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../../../src/shared/contracts'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { owlFeatureEnabledOf, useOwlFeature } from '../../../src/renderer/src/state/owlFeature'
import { useWatcherEnabled } from '../../../src/renderer/src/state/watcherFeature'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'
import { deferred } from '../../fixtures/deferred'

afterEach(cleanup)

describe('renderer Owl feature answers', () => {
  it('stays off before main answers or outside the app', () => {
    expect(renderHook(() => useOwlFeature('watcher')).result.current).toBe(false)
    expect(owlFeatureEnabledOf(null, 'watcher')).toBe(false)
    const update: UpdateStatus = { currentVersion: '0.1.37-owl.20261011.1', releaseTrack: 'owl', phase: { phase: 'unsupported' }, checkedAt: null }
    expect(owlFeatureEnabledOf(update, 'watcher')).toBe(false)
    expect(owlFeatureEnabledOf({ ...update, owlFeatures: {}, watcherEnabled: true }, 'watcher')).toBe(false)
  })

  it.each([true, false])('uses the startup map through both hooks even if branding or the old alias disagrees (%s)', async enabled => {
    const answer = deferred<UpdateStatus>()
    const { result } = renderHook(() => [useOwlFeature('watcher'), useWatcherEnabled()], {
      wrapper: ({ children }) => <AppProvider bridge={createBridge({ getUpdateStatus: () => answer.promise })} createController={createController}>{children}</AppProvider>,
    })
    expect(result.current).toEqual([false, false])
    await act(async () => answer.resolve({ currentVersion: '0.1.37-owl.20261011.1', releaseTrack: 'owl',
      owlFeatures: { watcher: enabled }, watcherEnabled: !enabled, phase: { phase: 'unsupported' }, checkedAt: null }))
    await waitFor(() => expect(result.current).toEqual([enabled, enabled]))
  })
})
