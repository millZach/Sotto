// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { listOpenRouterModels } from '../../../src/main/llm/openRouterModels'
import { deferred } from '../../fixtures/deferred'

const page = (data: unknown[], next: string | null = null): Response =>
  new Response(JSON.stringify({ data, links: { next } }), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('listOpenRouterModels', () => {
  it('reads every page by name, drops bad slugs and duplicates, and sends no key', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(page([
        { id: 'z-ai/glm-5', name: 'Z.ai: GLM 5' },
        { id: 'bad slug', name: 'Bad' },
        { id: 'anthropic/claude-haiku-5.5', name: '' },
      ], '/api/v1/models?offset=2'))
      .mockResolvedValueOnce(page([{ id: 'z-ai/glm-5', name: 'Again' }, { id: 'x/free:free', name: 'Free' }]))
    await expect(listOpenRouterModels({ fetchFn })).resolves.toEqual({
      ok: true,
      complete: true,
      models: [
        { id: 'anthropic/claude-haiku-5.5', name: 'anthropic/claude-haiku-5.5' },
        { id: 'x/free:free', name: 'Free' },
        { id: 'z-ai/glm-5', name: 'Z.ai: GLM 5' },
      ],
    })
    expect(fetchFn.mock.calls.map(call => call[0])).toEqual(['https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/models?offset=2'])
    expect(fetchFn.mock.calls[0]![1]).not.toHaveProperty('headers')
  })

  it('follows an absolute next link on OpenRouter but never one off it', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a/b', name: 'A' }], 'https://openrouter.ai/api/v1/models?offset=1'))
      .mockResolvedValueOnce(page([{ id: 'c/d', name: 'C' }], 'https://example.com/api/v1/models'))
    await expect(listOpenRouterModels({ fetchFn })).resolves.toMatchObject({ ok: true, complete: true })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('says the list is incomplete when it stops at the page limit', async () => {
    const fetchFn = vi.fn(async () => page([{ id: 'a/b', name: 'A' }], '/api/v1/models?offset=1'))
    await expect(listOpenRouterModels({ fetchFn })).resolves.toMatchObject({ ok: true, complete: false })
  })

  it('says why the list did not come', async () => {
    await expect(listOpenRouterModels({ fetchFn: vi.fn().mockResolvedValue(new Response('', { status: 500 })) })).resolves.toEqual({ ok: false, reason: 'http' })
    await expect(listOpenRouterModels({ fetchFn: vi.fn().mockRejectedValue(new TypeError('offline')) })).resolves.toEqual({ ok: false, reason: 'network' })
  })

  it('lists active account presets first and sends the key only to the preset endpoint without following redirects', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) return page([{ id: 'a/model', name: 'A model' }])
      return new Response(JSON.stringify({ data: [
        { slug: 'qwen-cerebras', name: 'Qwen Cerebras', status: 'active' },
        { slug: 'disabled', name: 'Disabled', status: 'disabled' },
        { slug: 'bad/slug', status: 'active' },
      ], total_count: 3 }))
    })
    await expect(listOpenRouterModels({ fetchFn, getApiKey: async () => 'test-key' })).resolves.toEqual({
      ok: true, complete: true, models: [
        { id: '@preset/qwen-cerebras', name: 'Qwen Cerebras' },
        { id: 'a/model', name: 'A model' },
      ],
    })
    expect(fetchFn.mock.calls[0]).toEqual(['https://openrouter.ai/api/v1/models', expect.not.objectContaining({ headers: expect.anything() })])
    expect(fetchFn.mock.calls[1]).toEqual(['https://openrouter.ai/api/v1/presets?limit=100&offset=0', expect.objectContaining({
      headers: { Authorization: 'Bearer test-key' }, redirect: 'error',
    })])
  })

  it('keeps the public catalog when the key cannot list presets', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/models')
      ? page([{ id: 'a/model', name: 'A model' }])
      : new Response('', { status: 403 }))
    await expect(listOpenRouterModels({ fetchFn, getApiKey: async () => 'restricted-key' })).resolves.toEqual({
      ok: true, complete: true, models: [{ id: 'a/model', name: 'A model' }],
    })
  })

  it('keeps the public catalog when the saved key cannot be read', async () => {
    const log = vi.fn()
    const getApiKey = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('key unreadable'))
    const fetchFn = vi.fn().mockResolvedValue(page([{ id: 'a/model', name: 'A model' }]))
    await expect(listOpenRouterModels({ fetchFn, getApiKey, log })).resolves.toEqual({
      ok: true, complete: true, models: [{ id: 'a/model', name: 'A model' }],
    })
    expect(getApiKey).toHaveBeenCalledOnce()
    expect(log.mock.calls).toEqual([['openrouter-presets-key-unreadable']])
    expect(fetchFn.mock.calls).toEqual([
      ['https://openrouter.ai/api/v1/models', expect.not.objectContaining({ headers: expect.anything() })],
    ])
  })

  it.each([
    ['http', () => Promise.resolve(new Response('private account details', { status: 403 }))],
    ['invalid-response', () => Promise.resolve(new Response('private invalid JSON'))],
    ['invalid-response', () => Promise.resolve(Response.json({ data: 'private malformed list' }))],
    ['network', () => Promise.reject(new TypeError('private key in network error'))],
    ['timeout', () => Promise.reject(new DOMException('private timeout details', 'TimeoutError'))],
  ] as const)('logs only the %s preset failure cause and keeps anonymous models', async (reason, fail) => {
    const log = vi.fn()
    const fetchFn = vi.fn<typeof fetch>(async url => String(url).endsWith('/models')
      ? page([{ id: 'a/model', name: 'A model' }]) : fail())
    await expect(listOpenRouterModels({ fetchFn, getApiKey: async () => 'private-key', log })).resolves.toEqual({
      ok: true, complete: true, models: [{ id: 'a/model', name: 'A model' }],
    })
    expect(log.mock.calls).toEqual([[`openrouter-presets-${reason}`]])
  })

  it.each([
    ['http', 'http', () => Promise.resolve(new Response('private details', { status: 503 }))],
    ['invalid-response', 'http', () => Promise.resolve(Response.json({ data: 'private malformed list' }))],
    ['invalid-response', 'network', () => Promise.resolve(new Response('private invalid JSON'))],
    ['network', 'network', () => Promise.reject(new TypeError('private network details'))],
    ['timeout', 'timeout', () => Promise.reject(new DOMException('private timeout details', 'TimeoutError'))],
  ] as const)('logs the %s public catalog cause while preserving the %s result', async (cause, reason, fail) => {
    const log = vi.fn()
    await expect(listOpenRouterModels({ fetchFn: vi.fn(fail), log })).resolves.toEqual({ ok: false, reason })
    expect(log.mock.calls).toEqual([[`openrouter-models-${cause}`]])
  })

  it('starts the anonymous catalog while the key is still being read', async () => {
    const key = deferred<string>()
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(page([{ id: 'a/model', name: 'A model' }]))
    const reading = listOpenRouterModels({ fetchFn, getApiKey: () => key.promise })
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(fetchFn.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models')
    key.resolve('')
    await expect(reading).resolves.toMatchObject({ ok: true, models: [{ id: 'a/model', name: 'A model' }] })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('keeps earlier preset pages when a later page is refused', async () => {
    const log = vi.fn()
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(Response.json({ data: [{ slug: 'kept', name: 'Kept', status: 'active' }], total_count: 2 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(listOpenRouterModels({ fetchFn, getApiKey: async () => 'key', log })).resolves.toEqual({
      ok: true, complete: true, models: [{ id: '@preset/kept', name: 'Kept' }],
    })
    expect(log.mock.calls).toEqual([['openrouter-presets-http']])
  })
})
