import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import { defaultSettings } from '../../../src/shared/settings'
import { AgentProvider } from '../../../src/renderer/src/agents/AgentContext'
import type { AgentVoiceDependencies } from '../../../src/renderer/src/agents/voiceSession'
import type { VoiceCaptureOptions } from '../../../src/renderer/src/agents/voiceCapture'

const external = vi.hoisted(() => ({ dependencies: null as AgentVoiceDependencies | null }))
vi.mock('../../../src/renderer/src/e2e/agentVoiceEffects', () => ({
  createE2EAgentVoiceEffects: () => external.dependencies,
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('wake acknowledgement in the real application voice session', () => {
  it.each(['next utterance', 'same utterance'] as const)('accepts the first command in the %s without waiting for cold speech synthesis', async (placement) => {
    const oscillator = { frequency: { value: 0 }, connect: vi.fn(), onended: null as (() => void) | null, start: vi.fn(), stop: vi.fn() }
    const close = vi.fn(async () => undefined)
    vi.stubGlobal('AudioContext', class {
      state = 'suspended'; currentTime = 0; destination = {}
      createOscillator() { return oscillator }
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} } }
      resume() { return new Promise<void>(() => { /* Browser playback may still be suspended. */ }) }
      close = close
    })
    let captureOptions: VoiceCaptureOptions | undefined
    let suppressed = false
    const capture = {
      start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
      setSuppressed(value: boolean) { suppressed = value },
    }
    const transcribe = vi.fn(async () => ({ text: placement === 'same utterance' ? 'Open Workshop' : '', language: 'en' }))
    const speak = vi.fn(() => new Promise<void>(() => { /* Simulate a speech model still loading. */ }))
    external.dependencies = {
      createCapture: (options) => { captureOptions = options; return capture },
      createWakeDetector: () => ({ load: async () => undefined, detect: async () => ({ detected: true, endSeconds: 0 }), dispose() {} }),
      createLocalTranscriber: () => ({ load: async () => undefined, transcribe, cancel() {}, dispose() {} }),
      speech: { speak, stop() {} }, createId: () => 'utterance',
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    const state: AgentState = {
      configuration: { ...defaultAgentConfiguration(), enabled: true, speak: true },
      connection: 'disconnected', host: null, assignments: [], queue: [],
      activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null,
      composing: false, pendingRequest: '', busy: false, notice: '', error: null,
      speech: { id: 0, text: '' }, voice: { status: 'wake', error: null, action: 'none', revision: 0 },
      credentials: { t3: false, reasoning: false, secure: true }, reasoningAccounts: [],
      membership: { status: 'beta', label: 'Development beta', expiresAt: null },
    }
    const command = vi.fn(async () => state)
    vi.stubGlobal('sotto', { agents: { get: async () => state, onState: () => () => undefined, command } })
    vi.stubGlobal('sottoE2E', {})
    render(<AgentProvider settings={{ ...defaultSettings('Control+Shift+Space'), onboardingComplete: true }} dictation={{ status: 'idle' }}><div /></AgentProvider>)
    await waitFor(() => expect(capture.start).toHaveBeenCalledOnce())
    async function emit() {
      await act(async () => {
        if (!suppressed) captureOptions!.onUtterance(new Float32Array(16_000).fill(0.2))
        for (let tick = 0; tick < 20; tick++) await Promise.resolve()
      })
    }
    await emit()
    if (placement === 'next utterance') {
      transcribe.mockResolvedValue({ text: 'Open Workshop', language: 'en' })
      await emit()
    }
    expect(command).toHaveBeenCalledWith({ type: 'utterance', text: 'Open Workshop' })
    expect(speak).not.toHaveBeenCalled()
    expect(suppressed).toBe(false)
    expect(oscillator.stop).toHaveBeenCalledWith(0.075)
    oscillator.onended?.()
    expect(close).toHaveBeenCalledOnce()
  })
})
