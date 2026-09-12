import { describe, expect, it, vi } from 'vitest'
import { createE2ESettingsBridge } from '../../../src/renderer/src/e2e/deterministicAdapters'
import type { SottoBridge } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

describe('E2E saved-key display fixture', () => {
  function bridge() {
    return {
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
      updateSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
      checkTranscriptionKey: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
    } as unknown as SottoBridge
  }

  it('leaves the production bridge unchanged and unconfigured', async () => {
    const original = bridge()
    const result = createE2ESettingsBridge(original, false)
    expect(result).toBe(original)
    expect((await result.getSettings()).llmApiKey).toBe('')
    await expect(result.checkTranscriptionKey()).resolves.toEqual({ ok: false, reason: 'unconfigured' })
  })

  it('shows key presence only in the fake session and never persists the display value', async () => {
    const original = bridge()
    const result = createE2ESettingsBridge(original, true)
    const displayed = await result.getSettings()
    expect(displayed.llmApiKey).toBe('Saved in your operating system credential store')
    await result.updateSettings({ llmApiKey: displayed.llmApiKey, language: 'es' })
    expect(original.updateSettings).toHaveBeenCalledWith({ language: 'es' })
    await expect(result.checkTranscriptionKey()).resolves.toEqual({ ok: true })
    expect(original.checkTranscriptionKey).not.toHaveBeenCalled()
  })
})
