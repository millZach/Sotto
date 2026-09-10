import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentBridge, type AgentConfiguration, type AgentVoiceModelStatus } from '../../../src/shared/agents'
import { createConfiguredSpeech, NaturalSpeechSynthesizer } from '../../../src/renderer/src/agents/naturalSpeech'

type Request = { id: number; text: string; voice: string }
const workers: WorkerFixture[] = []
const players: AudioFixture[] = []
const disposables: { dispose(): void }[] = []
const ready = { ready: true, completedBytes: 10, totalBytes: 10 }

// Only external effects are replaced. The real configured output, cancellation,
// worker protocol, base64 encoding, playback lifetime and provider selection run.
class WorkerFixture {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  readonly requests: Request[] = []
  readonly terminate = vi.fn()
  constructor(readonly url: URL, readonly options: WorkerOptions) { workers.push(this) }
  postMessage(request: Request): void { this.requests.push(request) }
  reply(index = 0): void {
    this.onmessage?.({ data: { id: this.requests[index]!.id, audio: new Uint8Array([82, 73, 70, 70]).buffer } } as MessageEvent)
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

function setup(configuration: AgentConfiguration = defaultAgentConfiguration()) {
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
    expect(await next).toEqual({ audioBase64: 'UklGRg==', mimeType: 'audio/wav' })
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

  it('routes the default to local synthesis and forwards stop while its status check is still pending', async () => {
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
