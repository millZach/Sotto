// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type SubscriptionAccount } from '../../../src/shared/agents'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { ConfiguredAgentReasoner } from '../../../src/main/agents/reasoning'

function deferred() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release }
}
function credentials() {
  return new AgentCredentials('unused-reasoning-test-directory', {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  })
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('reasoning runtime shutdown', () => {
  it('aborts the running native call, skips queued decisions and waits for native cleanup', async () => {
    const started = deferred(), cancelled = deferred(), cleanup = deferred()
    const complete = vi.fn(async (_system: string, _input: unknown, _model: string, _effort?: string, signal?: AbortSignal) => {
      started.release()
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => { cancelled.release(); resolve() }, { once: true }))
      await cleanup.promise
      throw new Error('Native reasoning cancelled.')
    })
    const reasoner = new ConfiguredAgentReasoner(() => ({ ...defaultAgentConfiguration(), reasoning: 'claude' }), credentials(), {
      claude: { complete, status: vi.fn() },
    })
    const first = reasoner.transformText('Return JSON.', {})
    const second = reasoner.transformText('Return JSON.', {})
    const results = Promise.allSettled([first, second])
    await started.promise
    let closed = false
    const closing = reasoner.close().then(() => { closed = true })
    await cancelled.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    expect(complete).toHaveBeenCalledTimes(1)
    cleanup.release()
    await closing
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected'])
    await expect(reasoner.transformText('Return JSON.', {})).rejects.toThrow('Sotto reasoning stopped.')
    expect(complete).toHaveBeenCalledTimes(1)
    await reasoner.close()
  })

  it('cancels account discovery and drains it before reporting closure', async () => {
    const started = deferred(), cancelled = deferred(), cleanup = deferred()
    const status = vi.fn(async (signal?: AbortSignal): Promise<SubscriptionAccount> => {
      started.release()
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => { cancelled.release(); resolve() }, { once: true }))
      await cleanup.promise
      // Native status adapters may report unavailable after a canceled probe. The reasoner
      // still rejects the stale observation instead of publishing it after shutdown.
      return { provider: 'grok', label: 'Grok', installed: true, ready: false, detail: 'Stopped', models: [] }
    })
    const reasoner = new ConfiguredAgentReasoner(defaultAgentConfiguration, credentials(), { grok: { status, complete: vi.fn() } })
    const result = reasoner.account('grok')
    const rejected = expect(result).rejects.toThrow('Sotto reasoning stopped.')
    await started.promise
    let closed = false
    const closing = reasoner.close().then(() => { closed = true })
    await cancelled.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    cleanup.release()
    await closing
    await rejected
    await expect(reasoner.account('grok')).rejects.toThrow('Sotto reasoning stopped.')
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('aborts hosted HTTP work and refuses later requests without fetching again', async () => {
    const started = deferred()
    vi.spyOn(AgentCredentials.prototype, 'get').mockReturnValue('fixture-key')
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      started.release()
    }))
    vi.stubGlobal('fetch', fetch)
    const reasoner = new ConfiguredAgentReasoner(() => ({ ...defaultAgentConfiguration(), reasoning: 'openrouter', reasoningModel: 'fixture-model' }), credentials())
    const result = reasoner.transformText('Return JSON.', {})
    const rejected = expect(result).rejects.toThrow('Sotto reasoning stopped.')
    await started.promise
    await reasoner.close()
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true)
    await expect(reasoner.transformText('Return JSON.', {})).rejects.toThrow('Sotto reasoning stopped.')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
