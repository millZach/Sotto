// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkOpenRouterKey } from '../../../src/main/llm/openRouterKeyCheck'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

function setup(patch: Partial<AppSettings> = {}) {
  // Ephemeral test credential; no saved credential or literal API key is used.
  const credential = randomUUID()
  const settings = { ...DEFAULT_SETTINGS, llmApiKey: credential, ...patch }
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
  const check = () => checkOpenRouterKey({ getSettings: async () => settings, fetchFn })
  return { check, fetchFn, credential }
}

afterEach(() => vi.restoreAllMocks())

describe('OpenRouter key verification', () => {
  it.each([[200, null], [401, 'unauthorized'], [403, 'unauthorized'], [402, 'http'], [429, 'http'], [500, 'http']] as const)(
    'maps status %i without returning credentials', async (status, reason) => {
      const { check, fetchFn, credential } = setup()
      fetchFn.mockResolvedValue(new Response(credential, { status }))
      const result = await check()
      expect(result).toEqual(reason === null ? { ok: true } : { ok: false, reason })
      expect(fetchFn.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/key')
      expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('GET')
      expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('Authorization') === `Bearer ${credential}`).toBe(true)
      expect(JSON.stringify(result).includes(credential)).toBe(false)
      expect(fetchFn).toHaveBeenCalledOnce()
    },
  )

  it.each(['network', 'timeout'] as const)('maps %s errors', async (reason) => {
    const { check, fetchFn, credential } = setup()
    fetchFn.mockRejectedValue(reason === 'timeout' ? new DOMException(credential, 'TimeoutError') : new Error(credential))
    const result = await check()
    expect(result).toEqual({ ok: false, reason })
    expect(JSON.stringify(result).includes(credential)).toBe(false)
  })

  it('requires a stored key', async () => {
    const { check, fetchFn } = setup({ llmApiKey: '' })
    expect(await check()).toEqual({ ok: false, reason: 'unconfigured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('answers unconfigured when settings cannot be read', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const result = await checkOpenRouterKey({ getSettings: async () => { throw new Error('store locked') }, fetchFn })
    expect(result).toEqual({ ok: false, reason: 'unconfigured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('uses a five-second timeout for key verification', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { check } = setup()
    await check()
    expect(timeout).toHaveBeenCalledWith(5_000)
  })

  it('rejects a success response arriving after the key-check deadline', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const { check, fetchFn } = setup()
    fetchFn.mockImplementation(async () => {
      deadline.abort(new DOMException('timed out', 'TimeoutError'))
      return new Response(null, { status: 200 })
    })
    expect(await check()).toEqual({ ok: false, reason: 'timeout' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})
