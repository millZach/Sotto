import { describe, expect, it, vi } from 'vitest'

import { createModelIpcService } from '../../../src/main/models/modelIpcService'

describe('model IPC service', () => {
  const disclosures = Object.freeze({
    models: Object.freeze([Object.freeze({
      preset: 'fast' as const,
      repository: 'Xenova/whisper-tiny',
      sourceProvider: 'Hugging Face' as const,
      sourceHost: 'huggingface.co' as const,
      revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
      totalBytes: 42,
      license: 'Apache-2.0' as const,
      bundled: false,
    })]),
    optionalDownloadNotice: 'Downloading an optional model contacts Hugging Face, which receives ordinary network metadata such as your IP address and request time. Audio and transcripts are not sent.',
  })

  it('lists immutable disclosure metadata separately from installation', () => {
    const install = vi.fn(async () => undefined)
    const models = {
      disclosures: vi.fn(() => disclosures),
      status: vi.fn(async () => ({ preset: 'fast' as const, state: 'missing' as const })),
      install,
      remove: vi.fn(async () => undefined),
    }
    const service = createModelIpcService(models, vi.fn())

    expect(service.listDisclosures()).toBe(disclosures)
    expect(models.disclosures).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
  })

  it('publishes a terminal ready status after a successful installation', async () => {
    const publish = vi.fn()
    const models = {
      disclosures: vi.fn(() => disclosures),
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
      disclosures: vi.fn(() => disclosures),
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
      disclosures: vi.fn(() => disclosures),
      status: vi.fn(async () => ({ preset: 'fast' as const, state: 'ready' as const })),
      install: vi.fn(async () => undefined),
      remove: vi.fn(async () => { throw failure }),
    }
    const service = createModelIpcService(models, publish)

    await expect(service.remove('fast')).rejects.toBe(failure)

    expect(publish).toHaveBeenCalledWith({ preset: 'fast', state: 'error' })
  })
})
