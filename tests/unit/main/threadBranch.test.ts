// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ShortTextWriter } from '../../../src/main/llm/shortTextWriter'
import { threadBranchWriter } from '../../../src/main/llm/threadBranch'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

const KEYED: AppSettings = { ...DEFAULT_SETTINGS, llmApiKey: 'sk-or-v1-test', writingModel: 'anthropic/claude-haiku-4.5' }

function fixture(content = 'Fix dark theme contrast', settings = KEYED) {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }))
  const onFailure = vi.fn()
  const writer = new ShortTextWriter({ getSettings: () => settings, fetchFn, onFailure })
  return { fetchFn, onFailure, write: threadBranchWriter(writer, () => settings) }
}

describe('descriptive names for a new worktree branch', () => {
  it('uses the existing writing model and key with only a capped first message', async () => {
    const f = fixture()
    const prompt = 'Fix dark theme contrast. ' + 'x'.repeat(2_000) + 'private tail outside the excerpt'
    await expect(f.write(prompt)).resolves.toBe('sotto/fix-dark-theme-contrast')
    expect(f.fetchFn).toHaveBeenCalledTimes(1)
    const [url, request] = f.fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(request.headers).toMatchObject({ Authorization: 'Bearer sk-or-v1-test' })
    const body = JSON.parse(String(request.body))
    expect(body.model).toBe('anthropic/claude-haiku-4.5')
    expect(body.messages).toHaveLength(2)
    expect(body.messages[1]).toEqual({ role: 'user', content: prompt.slice(0, 2_000) })
    expect(request.body).not.toContain('private tail outside the excerpt')
    expect(request.body).not.toContain('sk-or-v1-test')
  })

  it.each([
    { ...KEYED, threadTitles: false },
    { ...KEYED, historyEnabled: false },
    { ...KEYED, llmApiKey: '' },
  ])('does not contact OpenRouter when an existing privacy gate is off', async settings => {
    const f = fixture('fix-contrast', settings)
    await expect(f.write('Fix dark theme contrast')).resolves.toBeNull()
    expect(f.fetchFn).not.toHaveBeenCalled()
  })

  it('reads the gates for each request and does not send empty input', async () => {
    const write = vi.fn(async () => 'fix-contrast')
    let settings = KEYED
    const generate = threadBranchWriter({ write }, () => settings)
    await expect(generate('  \n ')).resolves.toBeNull()
    expect(write).not.toHaveBeenCalled()
    await expect(generate('Fix contrast')).resolves.toBe('sotto/fix-contrast')
    settings = { ...KEYED, historyEnabled: false }
    await expect(generate('Fix contrast')).resolves.toBeNull()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it.each(['../main', '--force', 'feature/overwrite', 'refs/heads/main', 'bad..branch', 'name@{1}', 'name.lock', 'a'.repeat(49), 'one two three four five six seven'])('rejects an invalid or overly long generated name: %s', async content => {
    const write = vi.fn(async () => content)
    await expect(threadBranchWriter({ write }, () => KEYED)('Fix contrast')).resolves.toBeNull()
  })

  it('accepts a short slug with or without Sotto’s prefix', async () => {
    for (const content of ['fix-contrast', 'sotto/fix-contrast', 'Fix Contrast']) {
      const write = vi.fn(async () => content)
      await expect(threadBranchWriter({ write }, () => KEYED)('Fix contrast')).resolves.toBe('sotto/fix-contrast')
    }
  })

  it('leaves naming optional and logs only stable failure fields', async () => {
    const onFailure = vi.fn()
    const fetchFn = vi.fn(async () => { throw new Error('private prompt and key must never be logged') })
    const writer = new ShortTextWriter({ getSettings: () => KEYED, fetchFn, onFailure, now: () => 42 })
    await expect(threadBranchWriter(writer, () => KEYED)('Private user prompt')).resolves.toBeNull()
    expect(onFailure).toHaveBeenCalledWith({ at: 42, purpose: 'thread-branch', reason: 'network' })
    await expect(threadBranchWriter(writer, () => { throw new Error('settings unavailable') })('Private user prompt')).resolves.toBeNull()
  })
})
