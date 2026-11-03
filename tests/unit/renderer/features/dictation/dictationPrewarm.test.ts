// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { createHarness, settings } from '../../../../fixtures/renderer/dictationControllerHarness'
import { DictationController, type DictationControllerDependencies } from '../../../../../src/renderer/src/features/dictation/dictationController'

function withAudioCapture(
  audioCapture: NonNullable<DictationControllerDependencies['audioCapture']>,
  cuePlayer?: DictationControllerDependencies['cuePlayer'],
) {
  const harness = createHarness()
  const controller = new DictationController({
    createRecorder: harness.createRecorder,
    transcriber: harness.transcriber,
    getSettings: () => harness.currentSettings,
    deliverOutput: harness.deliverOutput,
    addHistory: harness.addHistory,
    publishWidgetState: harness.publishWidgetState,
    audioCapture,
    ...(cuePlayer === undefined ? {} : { cuePlayer }),
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
    const cuePlayer = { prepare: vi.fn(), playStart: vi.fn(), playStop: vi.fn() }
    const harness = createHarness({ cuePlayer })
    await harness.controller.start()

    await harness.controller.prewarm()

    expect(harness.transcriber.load).not.toHaveBeenCalled()
    expect(cuePlayer.prepare).not.toHaveBeenCalled()
  })

  it('does not warm after the controller is disposed', async () => {
    const cuePlayer = { prepare: vi.fn(), playStart: vi.fn(), playStop: vi.fn() }
    const harness = createHarness({ cuePlayer })
    harness.controller.dispose()

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.transcriber.load).not.toHaveBeenCalled()
    expect(cuePlayer.prepare).not.toHaveBeenCalled()
  })

  it('prepares without requiring settings', async () => {
    const cuePlayer = { prepare: vi.fn(), playStart: vi.fn(), playStop: vi.fn() }
    const harness = createHarness({
      cuePlayer,
      getSettings: () => {
        throw new Error('SETTINGS_UNAVAILABLE')
      },
    })

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.transcriber.load).toHaveBeenCalledOnce()
    expect(cuePlayer.prepare).not.toHaveBeenCalled()
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

  it.each(['audio', 'cue', 'transcriber'] as const)('prepares the other resources when %s preparation fails', async failed => {
    const audioCapture = { setEnabled: vi.fn(), prewarm: vi.fn(async () => undefined), dispose: vi.fn() }
    const cuePlayer = { prepare: vi.fn(async () => undefined), playStart: vi.fn(), playStop: vi.fn() }
    const harness = withAudioCapture(audioCapture, cuePlayer)
    if (failed === 'audio') audioCapture.prewarm.mockImplementationOnce(() => { throw new Error('audio unavailable') })
    if (failed === 'cue') cuePlayer.prepare.mockImplementationOnce(() => { throw new Error('cue unavailable') })
    if (failed === 'transcriber') harness.transcriber.load.mockRejectedValueOnce(new Error('transcriber unavailable'))

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(audioCapture.prewarm).toHaveBeenCalledOnce()
    expect(cuePlayer.prepare).toHaveBeenCalledOnce()
    expect(harness.transcriber.load).toHaveBeenCalledOnce()
  })

  it('skips cue preparation when sounds are off without blocking transcription preparation', async () => {
    const cuePlayer = { prepare: vi.fn(), playStart: vi.fn(), playStop: vi.fn() }
    const harness = createHarness({ cuePlayer, currentSettings: settings({ soundCues: false }) })

    await harness.controller.prewarm(true)

    expect(cuePlayer.prepare).not.toHaveBeenCalled()
    expect(harness.transcriber.load).toHaveBeenCalledOnce()
  })

  it('disables audio without warming while dictation is off, and warms again when enabled', async () => {
    const audioCapture = { setEnabled: vi.fn(), prewarm: vi.fn(async () => undefined), dispose: vi.fn() }
    const cuePlayer = { prepare: vi.fn(), playStart: vi.fn(), playStop: vi.fn() }
    const harness = withAudioCapture(audioCapture, cuePlayer)

    await harness.controller.prewarm(false)

    expect(audioCapture.setEnabled).toHaveBeenLastCalledWith(false)
    expect(audioCapture.prewarm).not.toHaveBeenCalled()
    expect(harness.transcriber.load).not.toHaveBeenCalled()
    expect(cuePlayer.prepare).not.toHaveBeenCalled()
    await harness.controller.prewarm(true)
    expect(audioCapture.setEnabled).toHaveBeenLastCalledWith(true)
    expect(audioCapture.prewarm).toHaveBeenCalledOnce()
    expect(cuePlayer.prepare).toHaveBeenCalledOnce()
  })

  it('releases audio on dispose, including a queued warm-up and a failing transcriber cleanup', async () => {
    const audioCapture = { setEnabled: vi.fn(), prewarm: vi.fn(async () => undefined), dispose: vi.fn() }
    const cuePlayer = { prepare: vi.fn(), playStart: vi.fn(), playStop: vi.fn() }
    const harness = withAudioCapture(audioCapture, cuePlayer)
    harness.transcriber.dispose.mockImplementationOnce(() => { throw new Error('already unavailable') })
    const warming = harness.controller.prewarm()

    harness.controller.dispose()
    harness.controller.dispose()
    await warming
    await harness.controller.prewarm()

    expect(audioCapture.dispose).toHaveBeenCalledOnce()
    expect(audioCapture.prewarm).not.toHaveBeenCalled()
    expect(harness.transcriber.load).not.toHaveBeenCalled()
    expect(cuePlayer.prepare).not.toHaveBeenCalled()
  })
})
