import { describe, expect, it } from 'vitest'

import {
  MODEL_DOWNLOAD_PRIVACY_NOTICE,
  modelDisclosureCatalogSchema,
} from '../../../src/shared/contracts'

describe('model disclosure contract', () => {
  const entry = {
    preset: 'fast' as const,
    repository: 'Xenova/whisper-tiny',
    sourceProvider: 'Hugging Face' as const,
    sourceHost: 'huggingface.co' as const,
    revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
    totalBytes: 42_000_000,
    license: 'Apache-2.0' as const,
    bundled: false,
  }
  const validModels = () => [
    entry,
    { ...entry, preset: 'balanced' as const, repository: 'Xenova/whisper-base', revision: '64da57285918e20ea79ea5c88eed7197933abaa8', bundled: true },
    { ...entry, preset: 'accurate' as const, repository: 'Xenova/whisper-small', revision: '2d67713f236afa48a18992566e7647f6ca848e13' },
    { ...entry, preset: 'instant' as const, repository: 'onnx-community/moonshine-base-ONNX', revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad', license: 'MIT' as const },
  ]

  it('accepts exact finite metadata and returns a deeply immutable catalog', () => {
    const parsed = modelDisclosureCatalogSchema.parse({
      models: validModels(),
      optionalDownloadNotice: MODEL_DOWNLOAD_PRIVACY_NOTICE,
    })

    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.models)).toBe(true)
    expect(parsed.models.every(Object.isFrozen)).toBe(true)
    expect(parsed.optionalDownloadNotice).toContain('IP address')
    expect(parsed.optionalDownloadNotice).toContain('request time')
  })

  it.each([
    { ...entry, injected: true },
    { ...entry, sourceHost: 'evil.invalid' },
    { ...entry, revision: 'main' },
    { ...entry, totalBytes: Number.POSITIVE_INFINITY },
    // Each preset's license is pinned: whisper-tiny is Apache-2.0, not MIT.
    { ...entry, license: 'MIT' },
    { ...entry, license: 'GPL-3.0' },
  ])('rejects malformed or extra disclosure metadata', (hostile) => {
    const models = validModels()
    models[0] = hostile as typeof entry
    expect(() => modelDisclosureCatalogSchema.parse({
      models,
      optionalDownloadNotice: MODEL_DOWNLOAD_PRIVACY_NOTICE,
    })).toThrow()
  })
})
