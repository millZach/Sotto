import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentVoiceSession,
  type AgentVoiceDependencies,
  type AgentVoiceState,
} from '../../../src/renderer/src/agents/voiceSession'
import type { VoiceCaptureOptions } from '../../../src/renderer/src/agents/voiceCapture'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness() {
  let captureOptions!: VoiceCaptureOptions
  const states: AgentVoiceState[] = []
  const utterances: string[] = []
  const capture = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setSuppressed: vi.fn(),
    setWakeMode: vi.fn(),
  }
  const local = {
    load: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => ({ text: '', language: 'en' })),
    cancel: vi.fn(),
    dispose: vi.fn(),
  }
  const speech = {
    speak: vi.fn<() => Promise<void>>(async () => undefined),
    stop: vi.fn(),
  }
  let nextId = 1
  let heardText = ''
  const wake = {
    load: vi.fn(async () => undefined),
    async detect() { return { detected: /^[\s\p{P}]*hey[\s\p{P}]+sot{1,2}o(?=$|[\s\p{P}])/iu.test(heardText), endSeconds: 0 } },
    dispose: vi.fn(),
  }
  const dependencies: AgentVoiceDependencies = {
    createWakeDetector: () => wake,
    createCapture: (options) => { captureOptions = options; return capture },
    createLocalTranscriber: () => local,
    speech,
    createId: () => `voice-${nextId++}`,
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const onWake = vi.fn()
  const session = new AgentVoiceSession({
    getSettings: () => ({ microphoneId: null, modelPreset: 'instant', language: 'en' }),
    onState: (state) => states.push(state),
    onWake,
    onUtterance: async (text) => { utterances.push(text) },
  }, dependencies)
  async function hear(text: string) {
    heardText = text
    local.transcribe.mockResolvedValue({ text, language: 'en' })
    captureOptions.onUtterance(new Float32Array(16_000).fill(0.2))
    // Drain async transcript delivery, including a caller's awaited command.
    for (let tick = 0; tick < 12; tick++) await Promise.resolve()
  }
  return { session, states, utterances, onWake, capture, local, wake, speech, hear,
    emit: () => captureOptions.onUtterance(new Float32Array(16_000).fill(0.2)) }
}

afterEach(() => { vi.useRealTimers() })

describe('desktop agent voice interaction', () => {
  it('requires working local wake setup before opening the microphone', async () => {
    const h = harness()
    h.wake.load.mockRejectedValueOnce(new Error("Error invoking remote method 'sotto:agents:wake': Error: Wake setup required."))
    await h.session.start()
    expect(h.capture.start).not.toHaveBeenCalled()
    expect(h.local.load).not.toHaveBeenCalled()
    expect(h.states.at(-1)).toMatchObject({ status: 'error', error: 'Wake setup required.' })
    h.session.dispose()
  })

  it('keeps room speech local, accepts exact wake words, and preserves following commands', async () => {
    const h = harness()
    await h.session.start()
    await h.hear('Tell Hey Sotto to open this later.')
    await h.hear('Hey SottoBot, open a project.')
    expect(h.utterances).toEqual([])
    expect(h.onWake).not.toHaveBeenCalled()
    expect(h.local.transcribe).not.toHaveBeenCalled()

    await h.hear('“Hey, Soto!” Open Workshop.')
    expect(h.onWake).toHaveBeenCalledOnce()
    expect(h.utterances).toEqual(['Open Workshop.'])
    expect(h.states.at(-1)?.status).toBe('listening')
    h.session.dispose()
  })

  it('does not submit after pauses and forwards send it only when spoken', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.session.start()
    await h.hear('Hey Sotto')
    await h.hear('Here is my prompt. Build a workshop application.')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.utterances).toEqual(['Here is my prompt. Build a workshop application.'])
    await h.hear('Include an inventory page.')
    await h.hear('Send it.')
    expect(h.utterances.at(-1)).toBe('Send it.')
    h.session.dispose()
  })

  it('drops recognition that finishes after mute and releases the microphone', async () => {
    const h = harness()
    await h.session.start()
    await h.hear('Hey Sotto')
    const delayed = deferred<{ text: string; language: string }>()
    h.local.transcribe.mockImplementationOnce(() => delayed.promise)
    h.emit()
    await Promise.resolve()
    await h.session.setMuted(true)
    delayed.resolve({ text: 'Send it', language: 'en' })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.utterances).toEqual([])
    expect(h.capture.stop).toHaveBeenCalled()
    expect(h.states.at(-1)?.status).toBe('muted')
    h.session.dispose()
  })

  it('ignores generated speech and clears captured echo before listening resumes', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.session.start()
    const spoken = deferred<void>()
    h.speech.speak.mockImplementationOnce(() => spoken.promise)
    const speaking = h.session.speak('Hey Sotto is listening.')
    h.emit()
    expect(h.local.transcribe).not.toHaveBeenCalled()
    expect(h.states.at(-1)?.status).toBe('speaking')
    spoken.resolve()
    await speaking
    expect(h.capture.setSuppressed).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(h.capture.setSuppressed).toHaveBeenLastCalledWith(false)
    expect(h.onWake).not.toHaveBeenCalled()
    h.session.dispose()
  })

  it('can preview a reply while listening is muted without reopening the microphone', async () => {
    const h = harness()
    await h.session.start()
    await h.session.setMuted(true)
    h.capture.start.mockClear()
    await h.session.speak('Preview the selected voice.')
    expect(h.speech.speak).toHaveBeenCalledWith('Preview the selected voice.')
    expect(h.capture.start).not.toHaveBeenCalled()
    expect(h.session.getState().status).toBe('muted')
    h.session.dispose()
  })

  it('uses sensitive capture only while waiting for the wake phrase', async () => {
    const h = harness()
    await h.session.start()
    expect(h.capture.setWakeMode).toHaveBeenLastCalledWith(true)
    await h.hear('Hey Sotto')
    expect(h.capture.setWakeMode).toHaveBeenLastCalledWith(false)
    await h.hear('Stop listening.')
    expect(h.capture.setWakeMode).toHaveBeenLastCalledWith(true)
    h.session.dispose()
  })

  it('suspends voice commands during ordinary dictation and requires a new wake afterwards', async () => {
    const h = harness()
    await h.session.start()
    await h.hear('Hey Sotto')
    await h.session.setDictationActive(true)
    expect(h.states.at(-1)?.status).toBe('dictation')
    h.emit()
    expect(h.utterances).toEqual([])
    await h.session.setDictationActive(false)
    await h.hear('Send it')
    expect(h.utterances).toEqual([])
    expect(h.states.at(-1)?.status).toBe('wake')
    h.session.dispose()
  })

  it('returns to wake monitoring without forwarding stop-listening as a project prompt', async () => {
    const h = harness()
    await h.session.start()
    await h.hear('Hey Sotto')
    await h.hear('Stop listening.')
    await h.hear('Send it')
    expect(h.states.at(-1)?.status).toBe('wake')
    expect(h.utterances).toEqual([])
    h.session.dispose()
  })

  it('surfaces unavailable microphone and unavailable speech without claiming either worked', async () => {
    const h = harness()
    h.capture.start.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    await h.session.start()
    expect(h.states.at(-1)).toMatchObject({ status: 'error', error: 'Microphone access was denied. Allow Sotto to use the microphone, then retry.' })
    await h.session.start()
    h.speech.speak.mockRejectedValueOnce(new Error('No local voice is available.'))
    await h.session.speak('Opened Workshop.')
    expect(h.states.at(-1)?.error).toContain('No local voice is available')
    h.session.dispose()
  })
})
