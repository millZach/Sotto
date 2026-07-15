import { describe, expect, it, vi } from 'vitest'

import { createModelIpcService } from '../../../src/main/models/modelIpcService'

describe('model IPC service', () => {
  it('publishes a terminal ready status after a successful installation', async () => {
    const publish = vi.fn()
    const models = {
      status: vi.fn(async () => ({ preset: 'fast' as const, state: 'ready' as const })),
      install: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const service = createModelIpcService(models, publish)

    await service.install({ preset: 'fast', consent: true })

    expect(publish).toHaveBeenCalledWith({ preset: 'fast', state: 'ready' })
  })

  it('publishes a finite error status and preserves the original installation failure', async () => {
    const failure = new Error('private downloader detail')
    const publish = vi.fn()
    const models = {
      status: vi.fn(async () => ({ preset: 'fast' as const, state: 'missing' as const })),
      install: vi.fn(async () => { throw failure }),
      remove: vi.fn(async () => undefined),
    }
    const service = createModelIpcService(models, publish)

    await expect(service.install({ preset: 'fast', consent: true })).rejects.toBe(failure)

    expect(publish).toHaveBeenCalledWith({ preset: 'fast', state: 'error' })
    expect(JSON.stringify(publish.mock.calls)).not.toContain('private')
  })

  it('publishes a finite error after removal failure even when delivery itself fails', async () => {
    const failure = new Error('removal failed')
    const publish = vi.fn(async () => { throw new Error('renderer gone') })
    const models = {
      status: vi.fn(async () => ({ preset: 'accurate' as const, state: 'ready' as const })),
      install: vi.fn(async () => undefined),
      remove: vi.fn(async () => { throw failure }),
    }
    const service = createModelIpcService(models, publish)

    await expect(service.remove('accurate')).rejects.toBe(failure)

    expect(publish).toHaveBeenCalledWith({ preset: 'accurate', state: 'error' })
  })
})
