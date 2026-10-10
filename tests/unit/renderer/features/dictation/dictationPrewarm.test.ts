// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { createHarness, settings } from '../../../../fixtures/renderer/dictationControllerHarness'

describe('pipeline prewarm', () => {
  it('prepares hosted transcription without starting a dictation session', async () => {
    const harness = createHarness({
      currentSettings: settings(),
    })

    await harness.controller.prewarm()

    expect(harness.transcriber.load).toHaveBeenCalledWith({
    })
    expect(harness.controller.getState().status).toBe('idle')
    expect(harness.createRecorder).not.toHaveBeenCalled()
  })

  it('resolves quietly when warm-up loading fails', async () => {
    const harness = createHarness()
    harness.transcriber.load.mockRejectedValueOnce(new Error('TRANSCRIPTION_FAILED'))

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.controller.getState().status).toBe('idle')
  })

  it('does not warm while a dictation session is active', async () => {
    const harness = createHarness()
    await harness.controller.start()

    await harness.controller.prewarm()

    expect(harness.transcriber.load).not.toHaveBeenCalled()
  })

  it('does not warm after the controller is disposed', async () => {
    const harness = createHarness()
    harness.controller.dispose()

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.transcriber.load).not.toHaveBeenCalled()
  })

  it('prepares without requiring settings', async () => {
    const harness = createHarness({
      getSettings: () => {
        throw new Error('SETTINGS_UNAVAILABLE')
      },
    })

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.transcriber.load).toHaveBeenCalledOnce()
  })

  it('supports transcribers without warm-up loading', async () => {
    const harness = createHarness()
    delete (harness.transcriber as { load?: unknown }).load

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.controller.getState().status).toBe('idle')
  })
})
