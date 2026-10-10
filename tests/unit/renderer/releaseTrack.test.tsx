import { renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { releaseTrackOf, useReleaseTrack } from '../../../src/renderer/src/state/useReleaseTrack'
import { createBridge } from '../../fixtures/renderer/appHarness'

describe('renderer release track accessor', () => {
  it.each(['stable', 'owl'] as const)('reads %s from existing update information', async releaseTrack => {
    const bridge = createBridge({ getUpdateStatus: async () => ({
      currentVersion: releaseTrack === 'owl' ? '0.1.35-owl.20261009.1' : '0.1.34',
      releaseTrack, phase: { phase: 'unsupported' }, checkedAt: null,
    }) })
    const { result } = renderHook(() => useReleaseTrack(), { wrapper: ({ children }) => createElement(AppProvider, { bridge }, children) })
    await waitFor(() => expect(result.current).toBe(releaseTrack))
  })

  it('reads the version when main sent no track, and is stable before either or outside the app', () => {
    expect(releaseTrackOf({ currentVersion: '0.1.35-owl.20261009.1', phase: { phase: 'unsupported' }, checkedAt: null })).toBe('owl')
    expect(releaseTrackOf({ currentVersion: '0.1.34', phase: { phase: 'unsupported' }, checkedAt: null })).toBe('stable')
    expect(releaseTrackOf(null)).toBe('stable')
    expect(renderHook(() => useReleaseTrack()).result.current).toBe('stable')
  })
})
