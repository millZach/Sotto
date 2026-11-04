// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AudioRecorder } from '../../../../../src/renderer/src/audio/audioRecorder'
import { createMicrophoneAccessGate } from '../../../../../src/main/media/microphoneAccess'
import { createHarness as createAudioHarness } from '../../../../fixtures/renderer/audioRecorderHarness'
import { createHarness, deferred, recorderOptions, snapshots } from '../../../../fixtures/renderer/dictationControllerHarness'

// Readiness means capture can be stopped, even before the start promise settles.
describe('dictation startup', () => {
  it('publishes the widget and starts the cue while the recorder start is pending', async () => {
    const starting = deferred<void>()
    const cue = deferred<void>()
    let ready!: () => void
    const cuePlayer = { playStart: vi.fn(() => cue.promise), playStop: vi.fn() }
    const harness = createHarness({ cuePlayer, recorder: {
      start: vi.fn((onReady: () => void) => {
        ready = onReady
        return starting.promise
      }),
    } })
    const start = harness.controller.start()
    expect(harness.controller.getState()).toEqual({ status: 'requesting-permission', sessionId: 'session' })
    expect(snapshots(harness).some(snapshot => snapshot.status === 'requesting-permission' && snapshot.permissionPending)).toBe(false)
    expect(cuePlayer.playStart).toHaveBeenCalledOnce()
    const recorderCall = vi.mocked(harness.recorder.start).mock.invocationCallOrder[0]!
    expect(harness.publishWidgetState.mock.invocationCallOrder[0]!).toBeLessThan(recorderCall)
    expect(recorderCall).toBeLessThan(cuePlayer.playStart.mock.invocationCallOrder[0]!)
    ready()
    expect(harness.controller.getState().status).toBe('listening')
    starting.resolve()
    await start
    expect(cuePlayer.playStart).toHaveBeenCalledOnce()
    cue.resolve()
    await harness.controller.cancel()
  })

  it('cancels immediately before readiness and ignores a late readiness callback', async () => {
    const starting = deferred<void>()
    let ready!: () => void
    const cuePlayer = { playStart: vi.fn(), playStop: vi.fn() }
    const harness = createHarness({ cuePlayer, recorder: {
      start: vi.fn((onReady: () => void) => { ready = onReady; return starting.promise }),
    } })
    const start = harness.controller.start()
    await harness.controller.stop()
    expect(harness.controller.getState().status).toBe('cancelled')
    expect(harness.recorder.cancel).toHaveBeenCalledOnce()
    ready()
    recorderOptions(harness).onPermissionWaiting?.(true)
    recorderOptions(harness).onPermissionWaiting?.(false)
    starting.resolve()
    await start
    expect(harness.controller.getState().status).toBe('cancelled')
    expect(harness.transcriber.transcribe).not.toHaveBeenCalled()
    expect(cuePlayer.playStart).toHaveBeenCalledOnce()
    expect(cuePlayer.playStop).not.toHaveBeenCalled()
  })

  it('waits for post-permission resume and preserves Stop from the Listening publication', async () => {
    const entered = deferred<void>()
    const resumed = deferred<void>()
    const audio = createAudioHarness({}, 16_000)
    audio.getUserMedia.mockImplementation(async () => {
      audio.context.state = 'suspended'
      return audio.stream
    })
    audio.context.resume.mockImplementation(() => { entered.resolve(); return resumed.promise })
    const samples = new Float32Array(960).fill(0.25)
    let stop: Promise<void> | undefined
    let stoppedOnListening = false
    const harness = createHarness({ publishWidgetState: snapshot => {
      if (snapshot.status !== 'listening' || stoppedOnListening) return
      stoppedOnListening = true
      expect(audio.context.state).toBe('running')
      expect(audio.context.source.connect).toHaveBeenCalledOnce()
      audio.worklet.port.onmessage?.({ data: samples })
      stop = harness.controller.stop()
    } })
    harness.createRecorder.mockImplementation(options => new AudioRecorder(options, audio.dependencies))
    const start = harness.controller.start()
    await entered.promise
    expect(harness.controller.getState().status).toBe('requesting-permission')
    expect(snapshots(harness).some(snapshot => snapshot.status === 'listening')).toBe(false)
    expect(audio.context.source.connect).toHaveBeenCalledOnce()

    audio.context.state = 'running'
    resumed.resolve()
    await start
    expect(stop).toBeDefined()
    await stop
    expect(harness.transcriber.transcribe).toHaveBeenCalledOnce()
    expect(harness.transcriber.transcribe.mock.calls[0]![0].audio).toEqual(samples)
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello world' }))
    expect(harness.publishedStates.slice(-2)).toEqual([
      { status: 'success', sessionId: 'session', text: 'hello world', output: 'pasted' },
      { status: 'idle' },
    ])
    expect(audio.track.stop).toHaveBeenCalledOnce()
    expect(audio.worklet.port.onmessage).toBeNull()
  })

  it('cancels a post-permission resume without publishing late Listening', async () => {
    const entered = deferred<void>()
    const resumed = deferred<void>()
    const audio = createAudioHarness()
    audio.getUserMedia.mockImplementation(async () => {
      audio.context.state = 'suspended'
      return audio.stream
    })
    audio.context.resume.mockImplementation(() => { entered.resolve(); return resumed.promise })
    const harness = createHarness()
    harness.createRecorder.mockImplementation(options => new AudioRecorder(options, audio.dependencies))
    const start = harness.controller.start()
    await entered.promise
    await harness.controller.stop()
    resumed.resolve()
    await start
    expect(harness.controller.getState().status).toBe('cancelled')
    expect(snapshots(harness).some(snapshot => snapshot.status === 'listening')).toBe(false)
    expect(harness.transcriber.transcribe).not.toHaveBeenCalled()
    expect(audio.track.stop).toHaveBeenCalledOnce()
    expect(audio.context.source.disconnect).toHaveBeenCalledOnce()
  })

  it('ignores an older start and its permission notifications after a new session starts', async () => {
    const starting = deferred<void>()
    let oldReady!: () => void
    const harness = createHarness({ recorder: {
      start: vi.fn((onReady: () => void) => { oldReady = onReady; return starting.promise }),
    } })
    const first = harness.controller.start()
    const oldOptions = recorderOptions(harness)
    oldOptions.onPermissionWaiting?.(true)
    await harness.controller.stop()
    harness.recorder.start = vi.fn(async (onReady: () => void) => { onReady() })
    await harness.controller.start()
    const current = harness.controller.getState()
    oldReady()
    oldOptions.onPermissionWaiting?.(true)
    oldOptions.onPermissionWaiting?.(false)
    starting.resolve()
    await first
    expect(harness.controller.getState()).toEqual(current)
    expect(current).toMatchObject({ status: 'listening', sessionId: 'later-session' })
    await harness.controller.cancel()
  })

  it.each(['granted', 'not-determined'] as const)('uses the real %s access gate for Waiting', async status => {
    const permission = deferred<boolean>()
    const promptEntered = deferred<void>()
    const gate = createMicrophoneAccessGate({ status: () => status, request: () => {
      promptEntered.resolve()
      return permission.promise
    } })
    const audio = createAudioHarness({ ensureMicrophoneAccess: onWaiting => gate.ensure(onWaiting) })
    const harness = createHarness()
    harness.createRecorder.mockImplementation(options => new AudioRecorder(options, audio.dependencies))
    audio.context.createMediaStreamSource.mockImplementation(() => {
      expect(harness.controller.getState().status).toBe('requesting-permission')
      return audio.context.source
    })
    const start = harness.controller.start()
    if (status === 'not-determined') {
      await promptEntered.promise
      expect(harness.controller.getState()).toMatchObject({ status: 'requesting-permission', permissionPending: true })
      expect(audio.getUserMedia).not.toHaveBeenCalled()
      permission.resolve(true)
    }
    await start
    expect(harness.controller.getState().status).toBe('listening')
    const waiting = snapshots(harness).filter(snapshot => snapshot.status === 'requesting-permission' && snapshot.permissionPending)
    expect(waiting).toHaveLength(status === 'granted' ? 0 : 1)
    await harness.controller.cancel()
    expect(audio.track.stop).toHaveBeenCalledOnce()
  })

  it('stops a pending OS permission request without opening the microphone on its late answer', async () => {
    const permission = deferred<boolean>()
    const promptEntered = deferred<void>()
    const gate = createMicrophoneAccessGate({ status: () => 'not-determined', request: () => {
      promptEntered.resolve()
      return permission.promise
    } })
    const audio = createAudioHarness({ ensureMicrophoneAccess: onWaiting => gate.ensure(onWaiting) })
    const harness = createHarness()
    harness.createRecorder.mockImplementation(options => new AudioRecorder(options, audio.dependencies))
    const start = harness.controller.start()
    await promptEntered.promise
    expect(harness.controller.getState()).toMatchObject({ permissionPending: true })
    await harness.controller.stop()
    permission.resolve(true)
    await start
    expect(harness.controller.getState().status).toBe('cancelled')
    expect(snapshots(harness).some(snapshot => snapshot.status === 'listening')).toBe(false)
    expect(audio.getUserMedia).not.toHaveBeenCalled()
    expect(audio.context.close).toHaveBeenCalledOnce()
    expect(harness.transcriber.transcribe).not.toHaveBeenCalled()
  })
})
