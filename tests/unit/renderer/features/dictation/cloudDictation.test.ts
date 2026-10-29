// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { TranscriptionError } from '../../../../../src/renderer/src/transcription/localTranscriber'
import { widgetSnapshotSchema } from '../../../../../src/shared/contracts'
import { OPENROUTER_KEY_MISSING_DETAIL, TRANSCRIPTION_KEPT_DETAIL } from '../../../../../src/shared/dictation'
import { createHarness, recorderOptions, snapshots } from '../../../../fixtures/renderer/dictationControllerHarness'

// Transcribe with OpenRouter (ADR-0160): what the controller does differently while an OpenRouter model transcribes.
describe('dictation transcribed by an OpenRouter speech model', () => {
  it.each([
    ['no-key', 'TRANSCRIPTION_NO_KEY'],
    ['unauthorized', 'TRANSCRIPTION_KEY_REJECTED'],
    ['billing', 'TRANSCRIPTION_NO_CREDIT'],
    ['rate-limited', 'TRANSCRIPTION_RATE_LIMITED'],
    ['network', 'TRANSCRIPTION_OFFLINE'],
    ['model-unavailable', 'TRANSCRIPTION_MODEL_GONE'],
  ] as const)('keeps the recording when OpenRouter says %s, and says why as %s', async (reason, code) => {
    const harness = createHarness({ transcribedWith: () => 'openrouter', transcribe: async () => { throw new TranscriptionError(reason) } })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code, kept: true, message: TRANSCRIPTION_KEPT_DETAIL[code] })
    expect(widgetSnapshotSchema.safeParse(snapshots(harness).at(-1)).success).toBe(true)
  })

  it('records nothing while no key is saved, and says where the key goes', async () => {
    const harness = createHarness({ openRouterKeyMissing: () => true, speechModelReady: () => true })
    await harness.controller.start()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'OPENROUTER_KEY_MISSING', message: OPENROUTER_KEY_MISSING_DETAIL })
    expect(harness.createRecorder).not.toHaveBeenCalled()
  })

  it('marks the processing snapshot as going through OpenRouter, and the history entry as an OpenRouter model', async () => {
    const harness = createHarness({ transcribedWith: () => 'openrouter' })
    await harness.controller.start()
    await harness.controller.stop()
    const processing = snapshots(harness).filter((snapshot) => snapshot.status === 'processing')
    expect(processing.length).toBeGreaterThan(0)
    for (const snapshot of processing) {
      expect(snapshot).toMatchObject({ cloud: true })
      expect(widgetSnapshotSchema.safeParse(snapshot).success).toBe(true)
    }
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({ modelPreset: 'openrouter' }))
  })

  it('says nothing about OpenRouter while dictation is transcribed on this computer', async () => {
    const harness = createHarness({ transcribedWith: () => 'parakeet' })
    await harness.controller.start()
    await harness.controller.stop()
    for (const snapshot of snapshots(harness)) expect(snapshot).not.toHaveProperty('cloud')
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({ modelPreset: 'parakeet' }))
  })

  it('sends only the parts OpenRouter turned away to this computer on Transcribe on this computer', async () => {
    const routes: Array<string | undefined> = []
    let offline = true
    const harness = createHarness({
      transcribedWith: () => 'openrouter',
      transcribe: async (options) => {
        const part = options.audio[0]!
        routes.push(`${part}:${options.route ?? 'cloud'}`)
        if (part === 2 && offline) throw new TranscriptionError('network')
        return { text: `part-${part}`, language: 'en' }
      },
      recorder: { stop: vi.fn(async () => ({ samples: new Float32Array([3]), sourceSampleRate: 16_000, durationMs: 12_000 })) },
    })
    await harness.controller.start()
    recorderOptions(harness).onSegment?.({ samples: new Float32Array([1]), sourceSampleRate: 16_000, durationMs: 6_000 })
    recorderOptions(harness).onSegment?.({ samples: new Float32Array([2]), sourceSampleRate: 16_000, durationMs: 6_000 })
    await harness.controller.stop()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'TRANSCRIPTION_OFFLINE', kept: true })

    offline = false
    await harness.controller.retry('local')
    expect(routes).toEqual(['1:cloud', '2:cloud', '3:cloud', '2:local'])
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'part-1 part-2 part-3' }))
    // The words came back from this computer, so the widget is not told the audio went out, and history says Parakeet.
    const retried = snapshots(harness).slice(snapshots(harness).findIndex((snapshot) => snapshot.status === 'error'))
    for (const snapshot of retried) expect(snapshot).not.toHaveProperty('cloud')
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({ modelPreset: 'parakeet' }))
  })

  it('goes back to OpenRouter, and says so, on a plain Try again after Transcribe on this computer failed', async () => {
    const routes: string[] = []
    let failures = 2
    const harness = createHarness({
      transcribedWith: () => 'openrouter',
      transcribe: async (options) => {
        routes.push(options.route ?? 'cloud')
        if (failures-- > 0) throw new TranscriptionError(options.route === 'local' ? 'model-not-ready' : 'network')
        return { text: 'hello', language: 'en' }
      },
    })
    await harness.controller.start()
    await harness.controller.stop()
    await harness.controller.retry('local')
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'TRANSCRIPTION_MODEL_NOT_READY', kept: true })
    await harness.controller.retry()
    expect(routes).toEqual(['cloud', 'local', 'cloud'])
    expect(snapshots(harness).filter((snapshot) => snapshot.status === 'processing').at(-1)).toMatchObject({ cloud: true })
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({ modelPreset: 'openrouter' }))
  })
})
