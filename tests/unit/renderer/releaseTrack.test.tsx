import { renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { useReleaseTrack } from '../../../src/renderer/src/state/useReleaseTrack'
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
})
