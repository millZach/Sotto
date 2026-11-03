import { afterEach, expect, it, vi } from 'vitest'

import { createProductionDictationController, type AppController, type AppControllerFactoryBindings } from '../../../src/renderer/src/state/AppContext'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { createHarness, FakeContext, FakeWorkletNode } from '../../fixtures/renderer/audioRecorderHarness'

const controllers: AppController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.unstubAllGlobals()
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
