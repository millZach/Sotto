// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { listOpenRouterModels } from '../../../src/main/llm/openRouterModels'

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
    await expect(listOpenRouterModels({ fetchFn, apiKey: 'test-key' })).resolves.toEqual({
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
    await expect(listOpenRouterModels({ fetchFn, apiKey: 'restricted-key' })).resolves.toEqual({
      ok: true, complete: true, models: [{ id: 'a/model', name: 'A model' }],
    })
  })
})
