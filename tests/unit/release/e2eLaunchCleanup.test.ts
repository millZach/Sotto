import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { launchSotto } from '../../e2e/support/sottoLaunch'

describe('E2E launch cleanup', () => {
  it('closes a spawned application and removes its owned profile when firstWindow fails', async () => {
    const profile = resolve(process.env.TEMP ?? '', 'sotto-e2e-owned123')
    const close = vi.fn(async () => undefined)
    const removeProfile = vi.fn(async () => undefined)

    await expect(launchSotto('success', undefined, {
      createProfile: async () => profile,
      launch: async () => ({ close }) as never,
      firstWindow: async () => { throw new Error('window failed') },
      removeProfile,
    })).rejects.toThrow('window failed')

    expect(close).toHaveBeenCalledOnce()
    expect(removeProfile).toHaveBeenCalledWith(profile)
  })

  it('removes an owned profile even when the Electron launch itself rejects', async () => {
    const profile = resolve(process.env.TEMP ?? '', 'sotto-e2e-owned456')
    const removeProfile = vi.fn(async () => undefined)

    await expect(launchSotto('success', undefined, {
      createProfile: async () => profile,
      launch: async () => { throw new Error('launch failed') },
      firstWindow: async () => { throw new Error('unreachable') },
      removeProfile,
    })).rejects.toThrow('launch failed')

    expect(removeProfile).toHaveBeenCalledWith(profile)
  })

  it('never removes a caller-owned profile when launch fails', async () => {
    const profile = resolve(process.env.TEMP ?? '', 'caller-owned-profile')
    const removeProfile = vi.fn(async () => undefined)

    await expect(launchSotto('success', profile, {
      createProfile: async () => { throw new Error('unreachable') },
      launch: async () => { throw new Error('launch failed') },
      firstWindow: async () => { throw new Error('unreachable') },
      removeProfile,
    })).rejects.toThrow('launch failed')

    expect(removeProfile).not.toHaveBeenCalled()
  })
})
