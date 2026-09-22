import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentBridge, type AgentConfiguration, type AgentVoiceModelStatus } from '../../../src/shared/agents'
import { createConfiguredSpeech, NaturalSpeechSynthesizer } from '../../../src/renderer/src/agents/naturalSpeech'
import { decodeBase64Audio } from '../../../src/renderer/src/agents/voiceSpeech'

type Request = { id: number; text: string; voice: string }
const workers: WorkerFixture[] = []
const players: AudioFixture[] = []
const disposables: { dispose(): void }[] = []
const ready = { ready: true, completedBytes: 10, totalBytes: 10 }

// Only external effects are replaced. The real configured output, cancellation,
// worker protocol, base64 decoding, playback lifetime and provider selection run.
class WorkerFixture {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  readonly requests: Request[] = []
  readonly terminate = vi.fn()
  constructor(readonly url: URL, readonly options: WorkerOptions) { workers.push(this) }
  postMessage(request: Request): void { this.requests.push(request) }
  reply(index = 0, audio: ArrayBuffer = new Uint8Array([82, 73, 70, 70]).buffer): void {
    this.onmessage?.({ data: { id: this.requests[index]!.id, audio } } as MessageEvent)
  }
}
class AudioFixture {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly play = vi.fn(async () => undefined)
  readonly pause = vi.fn()
  constructor(public src: string) { players.push(this) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

function setup(configuration: AgentConfiguration = { ...defaultAgentConfiguration(), speechProvider: 'natural' }) {
  const model = vi.fn<NonNullable<AgentBridge['voiceModel']>>(async () => ready)
  const system = vi.fn<NonNullable<AgentBridge['synthesizeSpeech']>>(async () => ({ audioBase64: 'UklGRg==', mimeType: 'audio/wav' }))
  const bridge = { voiceModel: model, synthesizeSpeech: system }
  const configured = createConfiguredSpeech(bridge, () => configuration)
  disposables.push(configured)
  return { ...configured, model, system, configuration }
}

beforeEach(() => {
  workers.length = 0; players.length = 0
  vi.stubGlobal('Worker', WorkerFixture)
  vi.stubGlobal('Audio', AudioFixture)
  const BrowserURL = URL
  vi.stubGlobal('URL', class extends BrowserURL {
    static createObjectURL = vi.fn(() => 'blob:fixture-speech')
    static revokeObjectURL = vi.fn()
  })
})
afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('natural speech output', () => {
  it('cancels during model status without starting stale worker inference, then accepts a fresh request', async () => {
    const status = deferred<AgentVoiceModelStatus>()
    const model = vi.fn<NonNullable<AgentBridge['voiceModel']>>(async () => status.promise)
    const local = new NaturalSpeechSynthesizer(model)
    disposables.push(local)
    const first = local.synthesize('Old reply', 'F1')
    const rejected = expect(first).rejects.toThrow('stopped')
    local.cancel()
    status.resolve(ready)
    await rejected
    expect(workers).toHaveLength(0)
    const next = local.synthesize('New reply', 'M2')
    await flush()
    expect(workers[0]?.requests).toMatchObject([{ text: 'New reply', voice: 'M2' }])
    workers[0]!.reply()
    const result = await next
    expect(result).toEqual({ audio: expect.any(ArrayBuffer), mimeType: 'audio/wav' })
    expect('audio' in result && [...new Uint8Array(result.audio)]).toEqual([82, 73, 70, 70])
    expect(model.mock.calls.every(call => call[0] === 'status')).toBe(true)
  })

  it('terminates cancelled work and ignores a stale worker result while the next voice is generating', async () => {
    const local = new NaturalSpeechSynthesizer(async () => ready)
    disposables.push(local)
    const first = local.synthesize('Old reply', 'F1')
    const rejected = expect(first).rejects.toThrow('stopped')
    await flush()
    const old = workers[0]!
    local.cancel()
    await rejected
    expect(old.terminate).toHaveBeenCalledTimes(1)
    const next = local.synthesize('Fresh reply', 'F2')
    let settled = false
    void next.then(() => { settled = true })
    await flush()
    expect(workers).toHaveLength(2)
    old.reply()
    await flush()
    expect(settled).toBe(false)
    workers[1]!.reply()
    await next
    expect(settled).toBe(true)
  })

  it('preserves a warm idle worker when playback stops and reuses it for another voice', async () => {
    const f = setup()
    const first = f.output.speak('First preview')
    await flush(); workers[0]!.reply(); await flush()
    players[0]!.onended?.()
    await first
    f.output.stop()
    expect(workers[0]!.terminate).not.toHaveBeenCalled()
    f.configuration.speechVoice = 'M3'
    const second = f.output.speak('Second preview')
    await flush()
    expect(workers).toHaveLength(1)
    expect(workers[0]!.requests[1]).toMatchObject({ text: 'Second preview', voice: 'M3' })
    workers[0]!.reply(1); await flush(); players[1]!.onended?.()
    await second
  })

  it('routes a saved natural selection to local synthesis and forwards stop while its status check is still pending', async () => {
    const f = setup()
    const status = deferred<AgentVoiceModelStatus>()
    f.model.mockReturnValueOnce(status.promise)
    const first = f.output.speak('Cancelled preview')
    f.output.stop()
    await first
    status.resolve(ready)
    await flush()
    expect(workers).toHaveLength(0)
    expect(players).toHaveLength(0)
    expect(f.system).not.toHaveBeenCalled()
    const second = f.output.speak('Local default preview')
    await flush()
    expect(workers[0]!.requests).toMatchObject([{ text: 'Local default preview', voice: 'F1' }])
    workers[0]!.reply(); await flush(); players[0]!.onended?.()
    await second
  })

  it('requires the explicit download for a missing natural model without switching to the system voice', async () => {
    const f = setup()
    f.model.mockResolvedValue({ ready: false, completedBytes: 0, totalBytes: 10 })
    await expect(f.output.speak('Preview')).rejects.toThrow('Download the natural voice')
    expect(f.model).toHaveBeenCalledExactlyOnceWith('status')
    expect(f.system).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0)
  })

  it('uses the selected system voice route and preserves its actionable failure', async () => {
    const f = setup({ ...defaultAgentConfiguration(), speechProvider: 'system' })
    const spoken = f.output.speak('System preview')
    await flush()
    expect(f.system).toHaveBeenCalledExactlyOnceWith('System preview')
    expect(f.model).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0)
    players[0]!.onended?.()
    await spoken
    f.system.mockRejectedValueOnce(new Error('Install a system voice and retry.'))
    await expect(f.output.speak('Another preview')).rejects.toThrow('Install a system voice')
  })

  it.each(['grok', 'kokoro'] as const)('routes %s speech through native IPC and cancels pending audio without loading local models', async speechProvider => {
    const pending = deferred<{ audioBase64: string; mimeType: 'audio/wav' }>()
    const bridge = { synthesizeSpeech: vi.fn(async () => pending.promise), cancelSpeech: vi.fn(async () => undefined), voiceModel: vi.fn(async () => ready) }
    const f = createConfiguredSpeech(bridge, () => ({ ...defaultAgentConfiguration(), speechProvider }))
    disposables.push(f)
    const spoken = f.output.speak('Grok preview')
    expect(bridge.synthesizeSpeech).toHaveBeenCalledWith('Grok preview')
    f.output.stop()
    await spoken
    expect(bridge.cancelSpeech).toHaveBeenCalled()
    pending.resolve({ audioBase64: 'UklGRg==', mimeType: 'audio/wav' })
    await flush()
    expect(players).toHaveLength(0)
    expect(workers).toHaveLength(0)
    expect(bridge.voiceModel).not.toHaveBeenCalled()
  })

  it("plays the local voice worker's own buffer, with no base64 round trip", async () => {
    const blobs: BlobPart[][] = []
    const BrowserBlob = Blob
    vi.stubGlobal('Blob', class extends BrowserBlob { constructor(parts: BlobPart[], options?: BlobPropertyBag) { super(parts, options); blobs.push(parts) } })
    const encode = vi.spyOn(globalThis, 'btoa')
    const decode = vi.spyOn(globalThis, 'atob')
    const f = setup()
    const spoken = f.output.speak('Natural reply')
    await flush()
    const audio = new Uint8Array(1024 * 1024).map((_, index) => index % 256).buffer
    workers[0]!.reply(0, audio); await flush()
    expect(blobs).toEqual([[audio]])
    expect(blobs[0]![0]).toBe(audio)
    expect(encode).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
    players[0]!.onended?.()
    await spoken
  })

  it("decodes a native reply's base64 to exactly the bytes main encoded, once", async () => {
    const every = Uint8Array.from({ length: 256 * 4 }, (_, index) => index % 256)
    const base64 = Buffer.from(every).toString('base64')
    expect([...decodeBase64Audio(base64)]).toEqual([...every])
    expect(decodeBase64Audio('')).toHaveLength(0)
    expect(() => decodeBase64Audio('not base64!')).toThrow()

    const blobs: BlobPart[][] = []
    const BrowserBlob = Blob
    vi.stubGlobal('Blob', class extends BrowserBlob { constructor(parts: BlobPart[], options?: BlobPropertyBag) { super(parts, options); blobs.push(parts) } })
    const decode = vi.spyOn(globalThis, 'atob')
    const f = setup({ ...defaultAgentConfiguration(), speechProvider: 'system' })
    f.system.mockResolvedValueOnce({ audioBase64: base64, mimeType: 'audio/wav' })
    const spoken = f.output.speak('System reply')
    await flush()
    expect(decode).toHaveBeenCalledOnce()
    expect([...(blobs[0]![0] as Uint8Array)]).toEqual([...every])
    players[0]!.onended?.()
    await spoken
  })

  it('bounds stalled worker generation and permits a fresh worker after timeout', async () => {
    vi.useFakeTimers()
    const local = new NaturalSpeechSynthesizer(async () => ready)
    disposables.push(local)
    const first = local.synthesize('Stalled reply', 'F1')
    const rejected = expect(first).rejects.toThrow('took too long')
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
    const next = local.synthesize('Retry', 'F1')
    await flush(); workers[1]!.reply()
    await next
    expect(vi.getTimerCount()).toBe(0)
  })
})
