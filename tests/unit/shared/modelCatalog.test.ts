import { describe, expect, it } from 'vitest'

import { MODEL_CATALOG, getModelCatalogEntry } from '../../../src/shared/modelCatalog'

describe('model catalog', () => {
  it('contains exactly the approved local model metadata', () => {
    expect(MODEL_CATALOG).toEqual({
      instant: {
        label: 'Standard',
        repository: 'onnx-community/moonshine-base-ONNX',
        revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
        family: 'moonshine',
        dtype: 'q8',
        multilingual: false,
        license: 'MIT',
        bundled: true,
        encoderBytes: 20_513_063,
        decoderBytes: 42_498_870,
      },
      fast: {
        label: 'Multi-lingual',
        repository: 'Xenova/whisper-tiny',
        revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
        family: 'whisper',
        dtype: 'q8',
        multilingual: true,
        license: 'Apache-2.0',
        bundled: false,
        encoderBytes: 10_124_910,
        decoderBytes: 30_727_765,
      },
    })
    expect(Object.keys(MODEL_CATALOG)).toEqual(['instant', 'fast'])
  })

  it('marks only Standard as English-only', () => {
    const englishOnly = Object.entries(MODEL_CATALOG)
      .filter(([, model]) => !model.multilingual)
      .map(([preset]) => preset)

    expect(englishOnly).toEqual(['instant'])
  })

  it('marks only Standard as bundled', () => {
    const bundledPresets = Object.entries(MODEL_CATALOG)
      .filter(([, model]) => model.bundled)
      .map(([preset]) => preset)

    expect(bundledPresets).toEqual(['instant'])
  })

  it('looks up catalog entries by preset', () => {
    expect(getModelCatalogEntry('fast')).toBe(MODEL_CATALOG.fast)
    expect(getModelCatalogEntry('instant')).toBe(MODEL_CATALOG.instant)
  })

  it('is immutable at runtime at both catalog levels', () => {
    expect(Object.isFrozen(MODEL_CATALOG)).toBe(true)
    expect(Object.values(MODEL_CATALOG).every(Object.isFrozen)).toBe(true)

    expect(Reflect.set(MODEL_CATALOG.fast, 'label', 'Changed')).toBe(false)
    expect(Reflect.set(MODEL_CATALOG, 'cloud', { bundled: true })).toBe(false)
    expect(MODEL_CATALOG.fast.label).toBe('Multi-lingual')
    expect(MODEL_CATALOG).not.toHaveProperty('cloud')
  })
})
