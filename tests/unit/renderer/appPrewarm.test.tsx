import { createBridge } from '../../fixtures/renderer/appHarness'
import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../../src/renderer/src/App'
import { AppProvider, type AppControllerFactory } from '../../../src/renderer/src/state/AppContext'
import { type SottoBridge } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

describe('transcription pipeline prewarm', () => {
  function createPrewarmHarness(bridge: SottoBridge) {
    const prewarm = vi.fn(async () => undefined)
    const factory: AppControllerFactory = () => ({
      getState: () => ({ status: 'idle' }),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      toggle: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      dispose: vi.fn(),
      prewarm,
    })
    render(
      <AppProvider bridge={bridge} createController={factory}>
        <App
          createMicrophoneTest={() => ({
            start: vi.fn(async () => 'ready' as const),
            stop: vi.fn(async () => undefined),
          })}
        />
      </AppProvider>,
    )
    return prewarm
  }

  it('has each new controller announce it holds no session, so a reload clears the widget', async () => {
    const announceIdle = vi.fn()
    const factory: AppControllerFactory = () => ({
      getState: () => ({ status: 'idle' }),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      toggle: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      dispose: vi.fn(),
      announceIdle,
    })
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    })
    render(<AppProvider bridge={bridge} createController={factory}><App /></AppProvider>)
    await waitFor(() => expect(announceIdle).toHaveBeenCalledTimes(1))
  })

  it('prewarms the pipeline once the controller becomes ready', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    })

    const prewarm = createPrewarmHarness(bridge)

    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1))
  })

  it('does not prewarm again when settings change', async () => {
    let emitSettings: ((next: AppSettings) => void) | undefined
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      onSettingsChanged: vi.fn((listener: (next: AppSettings) => void) => {
        emitSettings = listener
        return () => undefined
      }),
    })

    const prewarm = createPrewarmHarness(bridge)
    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1))

    act(() => {
      emitSettings?.({ ...DEFAULT_SETTINGS, onboardingComplete: true, theme: 'dark' })
    })
    expect(prewarm).toHaveBeenCalledTimes(1)

    act(() => {
      emitSettings?.({
        ...DEFAULT_SETTINGS,
        onboardingComplete: true,
        theme: 'dark',
        language: 'es',
      })
    })
    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1))
  })
})
