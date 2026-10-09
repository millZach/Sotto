// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type SubscriptionAccount } from '../../../src/shared/agents'
import { ConfiguredAgentReasoner } from '../../../src/main/agents/reasoning'

function deferred() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('reasoning runtime shutdown', () => {

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
    const reasoner = new ConfiguredAgentReasoner({ grok: { status } })
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
})
