import { describe, expect, it, vi } from 'vitest'

import {
  REMOTE_ASR_MODEL,
  RemoteAsrService,
  resolveRemoteAsrBase,
} from '../../../src/main/asr/remoteAsrService'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { encodeWavPcm16 } from '../../../src/shared/wav'

const ENABLED: AppSettings = {
  ...DEFAULT_SETTINGS,
  remoteAsr: true,
  remoteAsrUrl: 'http://forge.local:5092',
}

const wav = encodeWavPcm16(Float32Array.from([0.1, -0.1, 0.2]), 16_000)

function request(overrides: Partial<{ requestId: string; timeoutMs: number }> = {}) {
  return {
    requestId: 'request-1',
    wav: wav.buffer as ArrayBuffer,
    timeoutMs: 4_000,
    ...overrides,
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createService(options: {
  settings?: AppSettings | (() => AppSettings | Promise<AppSettings>)
  fetchFn?: typeof fetch
} = {}) {
  const fetchFn = vi.fn(options.fetchFn ?? (async () => jsonResponse({ text: 'hello there' })))
  const settings = options.settings ?? ENABLED
  const service = new RemoteAsrService({
    getSettings: typeof settings === 'function' ? settings : () => settings,
    fetchFn,
  })
  return { fetchFn, service }
}

describe('resolveRemoteAsrBase', () => {
  it('accepts a plain host and port by assuming http', () => {
    expect(resolveRemoteAsrBase('forge.local:5092')?.href).toBe('http://forge.local:5092/')
  })

  it('keeps an explicit scheme and a mount path', () => {
    expect(resolveRemoteAsrBase('https://asr.example.com/speech')?.href).toBe(
      'https://asr.example.com/speech',
    )
  })

  it('collapses a pasted endpoint or version path back to the base', () => {
    expect(resolveRemoteAsrBase('http://forge.local:5092/v1/audio/transcriptions')?.href).toBe(
      'http://forge.local:5092/',
    )
    expect(resolveRemoteAsrBase('http://forge.local:5092/v1/')?.href).toBe(
      'http://forge.local:5092/',
    )
  })

  it('rejects anything that is not a credential-free http address', () => {
    expect(resolveRemoteAsrBase('')).toBeNull()
    expect(resolveRemoteAsrBase('   ')).toBeNull()
    expect(resolveRemoteAsrBase('file:///etc/passwd')).toBeNull()
    expect(resolveRemoteAsrBase('ftp://forge.local')).toBeNull()
    expect(resolveRemoteAsrBase('http://user:secret@forge.local')).toBeNull()
    expect(resolveRemoteAsrBase('http://')).toBeNull()
  })
})

describe('RemoteAsrService.transcribe', () => {
  it('posts the wav as multipart form data and returns the transcript', async () => {
    const { fetchFn, service } = createService()

    await expect(service.transcribe(request())).resolves.toEqual({
      ok: true,
      text: 'hello there',
    })

    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://forge.local:5092/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form.get('model')).toBe(REMOTE_ASR_MODEL)
    const file = form.get('file') as File
    expect(file.type).toBe('audio/wav')
    expect(await file.arrayBuffer()).toEqual(wav.buffer)
  })

  it('makes no request while the toggle is off', async () => {
    const { fetchFn, service } = createService({ settings: { ...ENABLED, remoteAsr: false } })
    await expect(service.transcribe(request())).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('makes no request when the address is unusable', async () => {
    const { fetchFn, service } = createService({
      settings: { ...ENABLED, remoteAsrUrl: 'not a url at all' },
    })
    await expect(service.transcribe(request())).resolves.toEqual({
      ok: false,
      reason: 'unconfigured',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('reports an unreadable settings store as disabled rather than throwing', async () => {
    const { fetchFn, service } = createService({
      settings: () => {
        throw new Error('SETTINGS_UNAVAILABLE')
      },
    })
    await expect(service.transcribe(request())).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('classifies an error status, a malformed body, and a network failure', async () => {
    const failures = [
      { fetchFn: async () => jsonResponse({}, 503), reason: 'http' },
      { fetchFn: async () => jsonResponse({ text: 42 }), reason: 'malformed' },
      { fetchFn: async () => new Response('not json', { status: 200 }), reason: 'malformed' },
      { fetchFn: async () => { throw new TypeError('fetch failed') }, reason: 'network' },
    ] as const

    for (const failure of failures) {
      const { service } = createService({ fetchFn: failure.fetchFn as unknown as typeof fetch })
      await expect(service.transcribe(request())).resolves.toEqual({
        ok: false,
        reason: failure.reason,
      })
    }
  })

  it('reports the deadline as a timeout', async () => {
    const { service } = createService({
      fetchFn: (async (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })) as unknown as typeof fetch,
    })

    await expect(service.transcribe(request({ timeoutMs: 250 }))).resolves.toEqual({
      ok: false,
      reason: 'timeout',
    })
  })

  it('aborts an in-flight upload on cancel and reports it as cancelled', async () => {
    let observed: AbortSignal | undefined
    const { service } = createService({
      fetchFn: (async (_url: string, init: RequestInit) => {
        observed = init.signal ?? undefined
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      }) as unknown as typeof fetch,
    })

    const pending = service.transcribe(request())
    await vi.waitFor(() => expect(observed).toBeDefined())
    service.cancel('request-1')

    expect(observed?.aborted).toBe(true)
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('ignores a cancel for a request it never saw', () => {
    const { service } = createService()
    expect(() => service.cancel('unknown-request')).not.toThrow()
  })

  it('abandons every in-flight upload on dispose', async () => {
    const { service } = createService({
      fetchFn: (async (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })) as unknown as typeof fetch,
    })

    const first = service.transcribe(request({ requestId: 'a' }))
    const second = service.transcribe(request({ requestId: 'b' }))
    await vi.waitFor(() => expect(service.transcribe).toBeDefined())
    service.dispose()

    await expect(first).resolves.toEqual({ ok: false, reason: 'cancelled' })
    await expect(second).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })
})

describe('RemoteAsrService.check', () => {
  it('probes the health endpoint even while the toggle is off', async () => {
    const { fetchFn, service } = createService({
      settings: { ...ENABLED, remoteAsr: false },
      fetchFn: async () => jsonResponse({ status: 'ok' }),
    })

    await expect(service.check()).resolves.toEqual({ ok: true })
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://forge.local:5092/health')
    expect((fetchFn.mock.calls[0]?.[1] as RequestInit).method).toBe('GET')
  })

  it('reports an unusable address without a request', async () => {
    const { fetchFn, service } = createService({ settings: { ...ENABLED, remoteAsrUrl: '' } })
    await expect(service.check()).resolves.toEqual({ ok: false, reason: 'unconfigured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('reports an error status and an unreachable host', async () => {
    const failing = createService({ fetchFn: async () => jsonResponse({}, 500) })
    await expect(failing.service.check()).resolves.toEqual({ ok: false, reason: 'http' })

    const offline = createService({
      fetchFn: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })
    await expect(offline.service.check()).resolves.toEqual({ ok: false, reason: 'network' })
  })
})
