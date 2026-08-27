import { describe, expect, it, vi } from 'vitest'

import {
  FallbackTranscriber,
  REMOTE_ASR_COOLDOWN_MS,
  type ComposableTranscriber,
  type RemoteCapableTranscriber,
} from '../../../src/renderer/src/transcription/fallbackTranscriber'
import { RemoteTranscriptionError } from '../../../src/renderer/src/transcription/remoteClient'
import type {
  TranscribeOptions,
  TranscriptionResult,
} from '../../../src/renderer/src/transcription/client'

function transcribeOptions(overrides: Partial<TranscribeOptions> = {}): TranscribeOptions {
  return {
    sessionId: 'session-1',
    audio: Float32Array.from([0.1, -0.1]),
    preset: 'instant',
    language: 'en',
    inferencePreference: 'wasm',
    ...overrides,
  }
}

function createLocal(result: TranscriptionResult = { text: 'local text', language: 'en' }) {
  return {
    transcribe: vi.fn(async () => result),
    load: vi.fn(async () => ({ ready: true })),
    cancel: vi.fn(),
    dispose: vi.fn(),
  } satisfies ComposableTranscriber & { load: unknown }
}

function createRemote(options: {
  transcribe?: RemoteCapableTranscriber['transcribe']
  check?: RemoteCapableTranscriber['check']
} = {}) {
  return {
    transcribe: vi.fn(
      options.transcribe ?? (async () => ({ text: 'remote text', language: 'en' })),
    ),
    cancel: vi.fn(),
    dispose: vi.fn(),
    check: vi.fn(options.check ?? (async () => true)),
  }
}

function createTranscriber(options: {
  local?: ReturnType<typeof createLocal>
  remote?: ReturnType<typeof createRemote>
  enabled?: boolean | (() => boolean)
  now?: () => number
} = {}) {
  const local = options.local ?? createLocal()
  const remote = options.remote ?? createRemote()
  const enabled = options.enabled ?? true
  const transcriber = new FallbackTranscriber({
    local,
    remote,
    isRemoteEnabled: typeof enabled === 'function' ? enabled : () => enabled,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { local, remote, transcriber }
}

describe('FallbackTranscriber', () => {
  it('returns the remote transcript when the server answers', async () => {
    const { local, remote, transcriber } = createTranscriber()

    await expect(transcriber.transcribe(transcribeOptions())).resolves.toEqual({
      text: 'remote text',
      language: 'en',
    })
    expect(remote.transcribe).toHaveBeenCalledOnce()
    expect(local.transcribe).not.toHaveBeenCalled()
  })

  it('falls back to the local transcript when the server fails', async () => {
    const { local, transcriber } = createTranscriber({
      remote: createRemote({
        transcribe: async () => {
          throw new RemoteTranscriptionError('REMOTE_FAILED')
        },
      }),
    })

    await expect(transcriber.transcribe(transcribeOptions())).resolves.toEqual({
      text: 'local text',
      language: 'en',
    })
    expect(local.transcribe).toHaveBeenCalledWith(transcribeOptions())
  })

  it('falls back when the server times out', async () => {
    const { local, transcriber } = createTranscriber({
      remote: createRemote({
        transcribe: async () => {
          throw new RemoteTranscriptionError('REMOTE_TIMEOUT')
        },
      }),
    })

    await expect(transcriber.transcribe(transcribeOptions())).resolves.toMatchObject({
      text: 'local text',
    })
    expect(local.transcribe).toHaveBeenCalledOnce()
  })

  it('skips the server entirely while the setting is off', async () => {
    const { local, remote, transcriber } = createTranscriber({ enabled: false })

    await expect(transcriber.transcribe(transcribeOptions())).resolves.toMatchObject({
      text: 'local text',
    })
    expect(remote.transcribe).not.toHaveBeenCalled()
    expect(local.transcribe).toHaveBeenCalledOnce()
  })

  it('honours a setting toggled off between segments', async () => {
    let enabled = true
    const { remote, transcriber } = createTranscriber({ enabled: () => enabled })

    await transcriber.transcribe(transcribeOptions())
    enabled = false
    await transcriber.transcribe(transcribeOptions())

    expect(remote.transcribe).toHaveBeenCalledOnce()
  })

  it('stops retrying the server for a cooldown window after a failure', async () => {
    let clock = 1_000
    const remote = createRemote({
      transcribe: async () => {
        throw new RemoteTranscriptionError('REMOTE_TIMEOUT')
      },
    })
    const { transcriber } = createTranscriber({ remote, now: () => clock })

    await transcriber.transcribe(transcribeOptions())
    await transcriber.transcribe(transcribeOptions())
    expect(remote.transcribe).toHaveBeenCalledOnce()

    clock += REMOTE_ASR_COOLDOWN_MS - 1
    await transcriber.transcribe(transcribeOptions())
    expect(remote.transcribe).toHaveBeenCalledOnce()

    clock += 1
    await transcriber.transcribe(transcribeOptions())
    expect(remote.transcribe).toHaveBeenCalledTimes(2)
  })

  it('clears the cooldown as soon as the server answers again', async () => {
    let clock = 1_000
    let failing = true
    const remote = createRemote({
      transcribe: async () => {
        if (failing) throw new RemoteTranscriptionError('REMOTE_TIMEOUT')
        return { text: 'remote text', language: 'en' }
      },
    })
    const { transcriber } = createTranscriber({ remote, now: () => clock })

    await transcriber.transcribe(transcribeOptions())
    clock += REMOTE_ASR_COOLDOWN_MS
    failing = false
    await expect(transcriber.transcribe(transcribeOptions())).resolves.toMatchObject({
      text: 'remote text',
    })

    await expect(transcriber.transcribe(transcribeOptions())).resolves.toMatchObject({
      text: 'remote text',
    })
    expect(remote.transcribe).toHaveBeenCalledTimes(3)
  })

  it('does not restart a cancelled segment on the local model', async () => {
    const remote = createRemote({
      transcribe: async () => {
        throw new RemoteTranscriptionError('CANCELLED')
      },
    })
    const { local, transcriber } = createTranscriber({ remote })

    await expect(transcriber.transcribe(transcribeOptions())).rejects.toMatchObject({
      code: 'CANCELLED',
    })
    expect(local.transcribe).not.toHaveBeenCalled()
  })

  it('does not fall back for a session cancelled while the upload was in flight', async () => {
    let fail!: (error: unknown) => void
    const remote = createRemote({
      transcribe: () =>
        new Promise<TranscriptionResult>((_resolve, reject) => {
          fail = reject
        }),
    })
    const { local, transcriber } = createTranscriber({ remote })

    const pending = transcriber.transcribe(transcribeOptions())
    transcriber.cancel('session-1')
    fail(new Error('aborted by the transport'))

    await expect(pending).rejects.toThrow()
    expect(local.transcribe).not.toHaveBeenCalled()
  })

  it('cancels and disposes both transcribers', () => {
    const { local, remote, transcriber } = createTranscriber()

    transcriber.cancel('session-1')
    expect(remote.cancel).toHaveBeenCalledWith('session-1')
    expect(local.cancel).toHaveBeenCalledWith('session-1')

    transcriber.dispose()
    expect(remote.dispose).toHaveBeenCalledOnce()
    expect(local.dispose).toHaveBeenCalledOnce()
  })

  it('still cancels and disposes the local model when the remote one throws', () => {
    const remote = createRemote()
    remote.cancel.mockImplementation(() => {
      throw new Error('remote cancel failed')
    })
    remote.dispose.mockImplementation(() => {
      throw new Error('remote dispose failed')
    })
    const { local, transcriber } = createTranscriber({ remote })

    transcriber.cancel('session-1')
    transcriber.dispose()

    expect(local.cancel).toHaveBeenCalledWith('session-1')
    expect(local.dispose).toHaveBeenCalledOnce()
  })

  it('warms the local model and probes the server on load', async () => {
    const { local, remote, transcriber } = createTranscriber()

    await transcriber.load({ preset: 'instant', inferencePreference: 'wasm' })

    expect(local.load).toHaveBeenCalledWith({ preset: 'instant', inferencePreference: 'wasm' })
    expect(remote.check).toHaveBeenCalledOnce()
  })

  it('skips the probe while the setting is off', async () => {
    const { local, remote, transcriber } = createTranscriber({ enabled: false })

    await transcriber.load({ preset: 'instant', inferencePreference: 'wasm' })

    expect(local.load).toHaveBeenCalledOnce()
    expect(remote.check).not.toHaveBeenCalled()
  })

  it('opens the cooldown when the probe fails, so the first segment goes straight to local', async () => {
    const remote = createRemote({ check: async () => false })
    const { local, transcriber } = createTranscriber({ remote })

    await transcriber.load({ preset: 'instant', inferencePreference: 'wasm' })
    await expect(transcriber.transcribe(transcribeOptions())).resolves.toMatchObject({
      text: 'local text',
    })

    expect(remote.transcribe).not.toHaveBeenCalled()
    expect(local.transcribe).toHaveBeenCalledOnce()
  })

  it('still warms the local model when the probe throws', async () => {
    const remote = createRemote({
      check: async () => {
        throw new Error('IPC_FAILED')
      },
    })
    const { local, transcriber } = createTranscriber({ remote })

    await expect(
      transcriber.load({ preset: 'instant', inferencePreference: 'wasm' }),
    ).resolves.toEqual({ ready: true })
    expect(local.load).toHaveBeenCalledOnce()
  })

  it('reopens the server after a probe recovers a cooled-down transcriber', async () => {
    const clock = 1_000
    const remote = createRemote({ check: async () => true })
    const { transcriber } = createTranscriber({ remote, now: () => clock })

    remote.transcribe.mockRejectedValueOnce(new RemoteTranscriptionError('REMOTE_TIMEOUT'))
    await transcriber.transcribe(transcribeOptions())
    await transcriber.load({ preset: 'instant', inferencePreference: 'wasm' })

    await expect(transcriber.transcribe(transcribeOptions())).resolves.toMatchObject({
      text: 'remote text',
    })
    expect(clock).toBe(1_000)
  })
})
