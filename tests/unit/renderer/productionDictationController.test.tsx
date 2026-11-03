import { afterEach, expect, it, vi } from 'vitest'

import { createProductionDictationController, type AppController, type AppControllerFactoryBindings } from '../../../src/renderer/src/state/AppContext'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { createHarness, FakeContext, FakeWorkletNode } from '../../fixtures/renderer/audioRecorderHarness'
import { deferred } from '../../fixtures/deferred'

const controllers: AppController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.unstubAllGlobals()
})

it.each(['resolve', 'reject', 'throw'] as const)('prepares production cues only through enabled prewarm, even when preparation will %s', async outcome => {
  const preparation = deferred<void>()
  const cuePlayer = {
    prepare: vi.fn(() => {
      if (outcome === 'throw') throw new Error('cue preparation failed')
      return preparation.promise
    }),
    playStart: vi.fn(), playStop: vi.fn(), dispose: vi.fn(),
  }
  const recorder = {
    start: vi.fn(async (onReady: () => void) => { onReady() }),
    stop: vi.fn(async () => null), cancel: vi.fn(async () => undefined),
  }
  let currentSettings = { ...DEFAULT_SETTINGS, soundCues: true, dictationEnabled: false }
  const controller = createProductionDictationController({
    getSettings: () => currentSettings,
    deliverOutput: vi.fn(async () => 'copied' as const),
    addHistory: vi.fn(async () => []),
    publishWidgetState: vi.fn(async () => ({ ok: true as const })),
  }, {
    createRecorder: () => recorder,
    createTranscriber: () => ({ transcribe: vi.fn(), cancel: vi.fn(), dispose: vi.fn() }),
    createCuePlayer: () => cuePlayer,
  })
  controllers.push(controller)

  expect(cuePlayer.prepare).not.toHaveBeenCalled()
  await controller.prewarm?.(false)
  expect(cuePlayer.prepare).not.toHaveBeenCalled()
  currentSettings = { ...currentSettings, dictationEnabled: true }
  const warming = controller.prewarm?.(true)
  await Promise.resolve()
  expect(cuePlayer.prepare).toHaveBeenCalledOnce()
  expect(cuePlayer.playStart).not.toHaveBeenCalled()
  await controller.start()
  expect(controller.getState().status).toBe('listening')
  expect(cuePlayer.playStart).toHaveBeenCalledOnce()
  if (outcome === 'reject') preparation.reject(new Error('cue preparation failed'))
  else preparation.resolve()
  await warming
  controller.dispose()
  expect(cuePlayer.dispose).toHaveBeenCalledOnce()
})

it('gives each default production controller its own prepared context and disposes only its own resources', async () => {
  const harness = createHarness()
  const contexts: FakeContext[] = []
  vi.stubGlobal('AudioContext', class extends FakeContext {
    constructor() {
      super()
      contexts.push(this)
    }
  })
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.stubGlobal('navigator', { mediaDevices: harness.dependencies.mediaDevices })
  vi.stubGlobal('sotto', undefined)
  const bindings: AppControllerFactoryBindings = {
    getSettings: () => ({ ...DEFAULT_SETTINGS, soundCues: false }),
    deliverOutput: vi.fn(async () => 'copied' as const),
    addHistory: vi.fn(async () => []),
    publishWidgetState: vi.fn(async () => ({ ok: true as const })),
  }
  const first = createProductionDictationController(bindings)
  const second = createProductionDictationController(bindings)
  controllers.push(first, second)

  await Promise.all([first.prewarm?.(), second.prewarm?.()])

  expect(contexts).toHaveLength(2)
  expect(contexts.every(context => context.state === 'suspended')).toBe(true)
  expect(harness.getUserMedia).not.toHaveBeenCalled()
  expect(harness.deviceListeners.size).toBe(2)
  for (let index = 0; index < 2; index++) {
    await first.start()
    expect(first.getState().status).toBe('listening')
    await first.cancel()
  }
  expect(contexts).toHaveLength(2)
  expect(contexts[0]!.audioWorklet.addModule).toHaveBeenCalledOnce()
  expect(harness.track.stop).toHaveBeenCalledTimes(2)

  first.dispose()
  expect(contexts[0]!.close).toHaveBeenCalledOnce()
  expect(contexts[1]!.close).not.toHaveBeenCalled()
  expect(harness.deviceListeners.size).toBe(1)
  second.dispose()
  expect(contexts[1]!.close).toHaveBeenCalledOnce()
  expect(harness.deviceListeners.size).toBe(0)
})
