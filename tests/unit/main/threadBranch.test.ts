// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ShortTextPrompt } from '../../../src/main/agents/host'
import { ShortTextWriter } from '../../../src/main/llm/shortTextWriter'
import { threadBranchWriter } from '../../../src/main/llm/threadBranch'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

const SETTINGS: AppSettings = { ...DEFAULT_SETTINGS }

function fixture(content: string | null = 'Fix dark theme contrast', settings = SETTINGS) {
  const side = vi.fn<(threadId: string, prompt: ShortTextPrompt) => Promise<string | null>>(async () => content)
  const onFailure = vi.fn()
  const writer = new ShortTextWriter({ write: side, onFailure })
  return { side, onFailure, write: threadBranchWriter(writer, () => settings) }
}

describe('descriptive names for a new worktree branch', () => {
  it('asks the thread\'s own provider with only a capped first message', async () => {
    const f = fixture()
    const prompt = 'Fix dark theme contrast. ' + 'x'.repeat(2_000) + 'private tail outside the excerpt'
    await expect(f.write('thread-a', prompt)).resolves.toBe('sotto/fix-dark-theme-contrast')
    expect(f.side).toHaveBeenCalledTimes(1)
    const [threadId, request] = f.side.mock.calls[0]!
    expect(threadId).toBe('thread-a')
    expect(request.material).toBe(prompt.slice(0, 2_000))
    expect(request.instruction).toMatch(/^Name a Git branch/u)
    expect(JSON.stringify(request)).not.toContain('private tail outside the excerpt')
  })

  it.each([
    { ...SETTINGS, threadTitles: false },
    { ...SETTINGS, historyEnabled: false },
  ])('asks no provider anything when an existing privacy gate is off', async settings => {
    const f = fixture('fix-contrast', settings)
    await expect(f.write('thread-a', 'Fix dark theme contrast')).resolves.toBeNull()
    expect(f.side).not.toHaveBeenCalled()
  })

  it('reads the gates for each request and does not send empty input', async () => {
    const write = vi.fn(async () => 'fix-contrast')
    let settings = SETTINGS
    const generate = threadBranchWriter({ write }, () => settings)
    await expect(generate('thread-a', '  \n ')).resolves.toBeNull()
    expect(write).not.toHaveBeenCalled()
    await expect(generate('thread-a', 'Fix contrast')).resolves.toBe('sotto/fix-contrast')
    settings = { ...SETTINGS, historyEnabled: false }
    await expect(generate('thread-a', 'Fix contrast')).resolves.toBeNull()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it.each(['../main', '--force', 'feature/overwrite', 'refs/heads/main', 'bad..branch', 'name@{1}', 'name.lock', 'a'.repeat(49), 'one two three four five six seven'])('rejects an invalid or overly long generated name: %s', async content => {
    const write = vi.fn(async () => content)
    await expect(threadBranchWriter({ write }, () => SETTINGS)('thread-a', 'Fix contrast')).resolves.toBeNull()
  })

  it('accepts a short slug with or without Sotto’s prefix', async () => {
    for (const content of ['fix-contrast', 'sotto/fix-contrast', 'Fix Contrast']) {
      const write = vi.fn(async () => content)
      await expect(threadBranchWriter({ write }, () => SETTINGS)('thread-a', 'Fix contrast')).resolves.toBe('sotto/fix-contrast')
    }
  })

  it('leaves naming optional and logs only stable failure fields', async () => {
    const onFailure = vi.fn()
    const side = vi.fn(async () => { throw new Error('private prompt must never be logged') })
    const writer = new ShortTextWriter({ write: side, onFailure, now: () => 42 })
    await expect(threadBranchWriter(writer, () => SETTINGS)('thread-a', 'Private user prompt')).resolves.toBeNull()
    expect(onFailure).toHaveBeenCalledWith({ at: 42, purpose: 'thread-branch', reason: 'failed' })
    const devin = fixture(null)
    await expect(devin.write('devin-thread', 'Private user prompt')).resolves.toBeNull()
    expect(devin.onFailure).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'thread-branch', reason: 'unavailable' }))
    await expect(threadBranchWriter(writer, () => { throw new Error('settings unavailable') })('thread-a', 'Private user prompt')).resolves.toBeNull()
  })
})
