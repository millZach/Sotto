// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type MediaStreamAdapter } from '../../../../src/renderer/src/audio/audioRecorder'
import { PreparedAudioCapture } from '../../../../src/renderer/src/audio/preparedAudioCapture'
import { dictationTimingNow, setDictationTimingSink, type DictationTimingMark } from '../../../../src/shared/dictationTiming'
import { createHarness, deferred, FakeContext, FakeWorkletNode } from '../../../fixtures/renderer/audioRecorderHarness'

const owners: PreparedAudioCapture[] = []
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose()
  setDictationTimingSink(undefined)
})

function preparedHarness() {
  const harness = createHarness()
  const contexts: FakeContext[] = []
  const worklets: FakeWorkletNode[] = []
  vi.mocked(harness.dependencies.createAudioContext).mockImplementation(() => {
    const context = contexts.length === 0 ? harness.context : new FakeContext()
    contexts.push(context)
    return context
  })
  vi.mocked(harness.dependencies.createAudioWorkletNode).mockImplementation(() => {
    const worklet = new FakeWorkletNode()
    worklets.push(worklet)
    return worklet
  })
  const owner = new PreparedAudioCapture(harness.dependencies)
  owners.push(owner)
  return { ...harness, contexts, worklets, owner }
}

describe('prepared audio capture', () => {
  it('keeps one suspended registered context across fresh recorders, with no microphone or retained session audio while idle', async () => {
    const harness = preparedHarness()
    const next = createHarness()
    harness.getUserMedia.mockResolvedValueOnce(harness.stream).mockResolvedValueOnce(next.stream)

    await harness.owner.prewarm()
    expect(harness.context.state).toBe('suspended')
    expect(harness.context.audioWorklet.addModule).toHaveBeenCalledOnce()
    expect(harness.getUserMedia).not.toHaveBeenCalled()
    expect(harness.worklets).toHaveLength(0)

    const first = harness.owner.createRecorder({})
    await first.start()
    const lateMessage = harness.worklets[0]!.port.onmessage
    harness.worklets[0]!.port.onmessage?.({ data: new Float32Array(480).fill(0.25) })
    expect((await first.stop())?.samples[0]).toBeCloseTo(0.25)
    expect(first).toHaveProperty('session', null)
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.worklets[0]!.port.onmessage).toBeNull()
    expect(harness.worklets[0]!.port.postMessage).toHaveBeenCalledWith('stop')
    expect(harness.worklets[0]!.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.source.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.gain.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.state).toBe('suspended')

    const second = harness.owner.createRecorder({})
    await second.start()
    // A late message from the old graph cannot enter the next recording.
    lateMessage?.({ data: new Float32Array(480).fill(1) })
    harness.worklets[1]!.port.onmessage?.({ data: new Float32Array(480).fill(0.5) })
    const result = await second.stop()
    expect(result?.samples).toHaveLength(160)
    expect(result?.samples[0]).toBeCloseTo(0.5)
    expect(second).toHaveProperty('session', null)
    expect(next.track.stop).toHaveBeenCalledOnce()
    expect(harness.worklets[1]!.port.onmessage).toBeNull()
    expect(harness.worklets[1]!.port.postMessage).toHaveBeenCalledWith('stop')
    expect(harness.context.source.disconnect).toHaveBeenCalledTimes(2)
    expect(harness.context.gain.disconnect).toHaveBeenCalledTimes(2)
    expect(harness.context.state).toBe('suspended')
    expect(harness.context.audioWorklet.addModule).toHaveBeenCalledOnce()
    expect(harness.context.close).not.toHaveBeenCalled()
    expect(harness.contexts).toHaveLength(1)
  })

  it('resumes before opening the microphone and again if its permission dialog suspends the context', async () => {
    const harness = preparedHarness()
    await harness.owner.prewarm()
    harness.getUserMedia.mockImplementationOnce(async () => {
      expect(harness.context.state).toBe('running')
      harness.context.setState('suspended')
      return harness.stream
    })
    const recorder = harness.owner.createRecorder({})

    await recorder.start()

    expect(harness.context.resume).toHaveBeenCalledTimes(2)
    expect(harness.context.state).toBe('running')
    await recorder.cancel()
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.context.state).toBe('suspended')
  })

  it('rebuilds an idle context after devicechange without opening a microphone', async () => {
    const harness = preparedHarness()
    await harness.owner.prewarm()

    harness.changeDevice()
    await harness.owner.prewarm()

    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.context.stateListeners.size).toBe(0)
    expect(harness.contexts).toHaveLength(2)
    expect(harness.contexts[1]!.state).toBe('suspended')
    expect(harness.contexts[1]!.audioWorklet.addModule).toHaveBeenCalledOnce()
    expect(harness.getUserMedia).not.toHaveBeenCalled()
  })

  it('leaves an active session alone on devicechange and rebuilds when it releases the context', async () => {
    const harness = preparedHarness()
    const recorder = harness.owner.createRecorder({})
    await recorder.start()

    harness.changeDevice()
    expect(harness.context.close).not.toHaveBeenCalled()
    expect(harness.track.stop).not.toHaveBeenCalled()
    harness.worklets[0]!.port.onmessage?.({ data: new Float32Array(480).fill(0.25) })
    expect((await recorder.stop())?.samples[0]).toBeCloseTo(0.25)
    await harness.owner.prewarm()

    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.contexts).toHaveLength(2)
    expect(harness.contexts[1]!.state).toBe('suspended')
    expect(harness.getUserMedia).toHaveBeenCalledOnce()
  })

  it('rebuilds when an idle context closes', async () => {
    const harness = preparedHarness()
    await harness.owner.prewarm()
    harness.context.setState('closed')
    await harness.owner.prewarm()

    expect(harness.contexts).toHaveLength(2)
    expect(harness.context.stateListeners.size).toBe(0)
    expect(harness.contexts[1]!.state).toBe('suspended')
    expect(harness.getUserMedia).not.toHaveBeenCalled()
  })

  it.each(['track', 'context'] as const)('releases an active recording on %s loss and leaves a usable prepared context', async loss => {
    const harness = preparedHarness()
    const unavailable = vi.fn()
    const recorder = harness.owner.createRecorder({ onDeviceUnavailable: unavailable })
    await recorder.start()
    if (loss === 'track') harness.endTrack()
    else harness.context.setState('closed')
    await recorder.stop()
    await harness.owner.prewarm()

    expect(unavailable).toHaveBeenCalledOnce()
    expect(recorder.getLastError()?.code).toBe('DEVICE_UNAVAILABLE')
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.worklets[0]!.port.onmessage).toBeNull()
    expect(recorder).toHaveProperty('session', null)
    expect(harness.contexts.at(-1)!.state).toBe('suspended')
  })

  it.each(['cancel', 'stop'] as const)('preserves %s semantics during pending suspension or module preparation', async action => {
    for (const phase of ['suspension', 'module'] as const) {
      const harness = preparedHarness()
      const pending = deferred<void>()
      const entered = deferred<void>()
      if (phase === 'suspension') harness.context.suspend.mockReturnValueOnce(pending.promise)
      else harness.context.audioWorklet.addModule.mockImplementationOnce(() => {
        entered.resolve()
        return pending.promise
      })
      const recorder = harness.owner.createRecorder({})
      const outcome = recorder.start().then(() => 'started', () => 'cancelled')
      if (phase === 'module') await entered.promise

      await recorder[action]()
      pending.resolve()

      expect(await outcome).toBe(action === 'stop' ? 'started' : 'cancelled')
      expect(harness.getUserMedia).not.toHaveBeenCalled()
      expect(harness.context.state).toBe('suspended')
      expect(harness.worklets).toHaveLength(0)
      expect(recorder).toHaveProperty('session', null)
      expect(harness.context.close).not.toHaveBeenCalled()
    }
  })

  it.each(['cancel', 'stop'] as const)('preserves %s semantics while permission is pending and stops every late track', async action => {
    const harness = preparedHarness()
    const pending = deferred<MediaStreamAdapter>()
    const entered = deferred<void>()
    harness.getUserMedia.mockImplementationOnce(() => {
      entered.resolve()
      return pending.promise
    })
    const recorder = harness.owner.createRecorder({})
    const outcome = recorder.start().then(() => 'started', () => 'cancelled')
    await entered.promise

    await recorder[action]()
    await expect(recorder.start()).rejects.toMatchObject({ code: 'ALREADY_RECORDING' })
    expect(harness.context.state).toBe('suspended')
    const extraTrack = { stop: vi.fn() }
    pending.resolve({ getTracks: () => [harness.track, extraTrack] })

    expect(await outcome).toBe(action === 'stop' ? 'started' : 'cancelled')
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(extraTrack.stop).toHaveBeenCalledOnce()
    expect(harness.context.source.connect).not.toHaveBeenCalled()
    expect(harness.worklets[0]!.port.onmessage).toBeNull()
    expect(recorder).toHaveProperty('session', null)
    expect(harness.context.state).toBe('suspended')
  })

  it('waits for the previous cancellation to suspend before a fresh recorder resumes', async () => {
    const harness = preparedHarness()
    const first = harness.owner.createRecorder({})
    await first.start()
    const suspended = deferred<void>()
    harness.context.suspend.mockImplementationOnce(async () => {
      await suspended.promise
      harness.context.setState('suspended')
    })
    const cancelling = first.cancel()
    const second = harness.owner.createRecorder({})
    const starting = second.start()
    expect(harness.getUserMedia).toHaveBeenCalledOnce()

    suspended.resolve()
    await cancelling
    await starting

    expect(harness.context.state).toBe('running')
    expect(harness.getUserMedia).toHaveBeenCalledTimes(2)
    await second.cancel()
    expect(harness.context.state).toBe('suspended')
  })

  it.each(['disable', 'dispose'] as const)('stops a late microphone stream after owner %s', async action => {
    const harness = preparedHarness()
    const pending = deferred<MediaStreamAdapter>()
    const entered = deferred<void>()
    harness.getUserMedia.mockImplementationOnce(() => { entered.resolve(); return pending.promise })
    const recorder = harness.owner.createRecorder({})
    const outcome = recorder.start().then(() => 'started', () => 'cancelled')
    await entered.promise
    if (action === 'disable') harness.owner.setEnabled(false)
    else harness.owner.dispose()
    pending.resolve(harness.stream)

    expect(await outcome).toBe('cancelled')
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.worklets[0]!.port.onmessage).toBeNull()
    expect(harness.deviceListeners.size).toBe(0)
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('removes listeners and prevents a late preparation or device event from warming after disable/dispose', async () => {
    const harness = preparedHarness()
    const module = deferred<void>()
    const entered = deferred<void>()
    harness.context.audioWorklet.addModule.mockImplementationOnce(() => {
      entered.resolve()
      return module.promise
    })
    const warming = harness.owner.prewarm()
    await entered.promise
    harness.owner.setEnabled(false)
    module.resolve()
    await warming
    harness.changeDevice()
    await harness.owner.prewarm()

    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.context.stateListeners.size).toBe(0)
    expect(harness.deviceListeners.size).toBe(0)
    expect(harness.contexts).toHaveLength(1)
    expect(harness.getUserMedia).not.toHaveBeenCalled()

    harness.owner.setEnabled(true)
    await harness.owner.prewarm()
    expect(harness.contexts).toHaveLength(2)
    expect(harness.deviceListeners.size).toBe(1)
    harness.owner.dispose()
    harness.owner.setEnabled(true)
    await harness.owner.prewarm()
    expect(harness.contexts).toHaveLength(2)
    expect(harness.deviceListeners.size).toBe(0)
    expect(harness.contexts[1]!.stateListeners.size).toBe(0)
    expect(harness.contexts[1]!.close).toHaveBeenCalledOnce()
  })

  it('marks each press acquisition at that press without replaying startup preparation marks', async () => {
    const harness = preparedHarness()
    const marks: DictationTimingMark[] = []
    setDictationTimingSink(mark => marks.push(mark))
    await harness.owner.prewarm()
    expect(marks).toEqual([])

    for (let index = 0; index < 2; index++) {
      const recorder = harness.owner.createRecorder({})
      const pressedAt = dictationTimingNow()
      await recorder.start()
      const acquisition = marks.splice(0)
      expect(acquisition.map(mark => mark.event)).toEqual([
        'recorder-started', 'audio-context-started', 'audio-context-ready',
        'worklet-load-started', 'worklet-loaded', 'microphone-request-started',
        'microphone-resolved', 'source-connect-started', 'source-connected',
      ])
      expect(acquisition.every(mark => mark.atMs >= pressedAt)).toBe(true)
      await recorder.cancel()
    }
    expect(harness.context.audioWorklet.addModule).toHaveBeenCalledOnce()
  })
})
