// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { createHarness, settings } from '../../../../fixtures/renderer/dictationControllerHarness'
import { DictationController, type DictationControllerDependencies } from '../../../../../src/renderer/src/features/dictation/dictationController'

function withAudioCapture(audioCapture: NonNullable<DictationControllerDependencies['audioCapture']>) {
  const harness = createHarness()
  const controller = new DictationController({
    createRecorder: harness.createRecorder,
    transcriber: harness.transcriber,
    getSettings: () => harness.currentSettings,
    deliverOutput: harness.deliverOutput,
    addHistory: harness.addHistory,
    publishWidgetState: harness.publishWidgetState,
    audioCapture,
  })
  return { ...harness, controller }
}

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

  it('prepares audio independently of transcription, including transcribers without load', async () => {
    const audioCapture = { setEnabled: vi.fn(), prewarm: vi.fn(async () => undefined), dispose: vi.fn() }
    const harness = withAudioCapture(audioCapture)
    delete (harness.transcriber as { load?: unknown }).load

    await harness.controller.prewarm()

    expect(audioCapture.setEnabled).toHaveBeenCalledWith(true)
    expect(audioCapture.prewarm).toHaveBeenCalledOnce()
    expect(harness.createRecorder).not.toHaveBeenCalled()
  })

  it('still loads transcription when audio preparation throws', async () => {
    const audioCapture = { setEnabled: vi.fn(), prewarm: vi.fn(() => { throw new Error('audio unavailable') }), dispose: vi.fn() }
    const harness = withAudioCapture(audioCapture)

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.transcriber.load).toHaveBeenCalledOnce()
  })

  it('disables audio without warming while dictation is off, and warms again when enabled', async () => {
    const audioCapture = { setEnabled: vi.fn(), prewarm: vi.fn(async () => undefined), dispose: vi.fn() }
    const harness = withAudioCapture(audioCapture)

    await harness.controller.prewarm(false)

    expect(audioCapture.setEnabled).toHaveBeenLastCalledWith(false)
    expect(audioCapture.prewarm).not.toHaveBeenCalled()
    expect(harness.transcriber.load).not.toHaveBeenCalled()
    await harness.controller.prewarm(true)
    expect(audioCapture.setEnabled).toHaveBeenLastCalledWith(true)
    expect(audioCapture.prewarm).toHaveBeenCalledOnce()
  })

  it('releases audio on dispose, including a queued warm-up and a failing transcriber cleanup', async () => {
    const audioCapture = { setEnabled: vi.fn(), prewarm: vi.fn(async () => undefined), dispose: vi.fn() }
    const harness = withAudioCapture(audioCapture)
    harness.transcriber.dispose.mockImplementationOnce(() => { throw new Error('already unavailable') })
    const warming = harness.controller.prewarm()

    harness.controller.dispose()
    harness.controller.dispose()
    await warming
    await harness.controller.prewarm()

    expect(audioCapture.dispose).toHaveBeenCalledOnce()
    expect(audioCapture.prewarm).not.toHaveBeenCalled()
    expect(harness.transcriber.load).not.toHaveBeenCalled()
  })
})
