import { describe, expect, it } from 'vitest'

import { MODEL_CATALOG, getModelCatalogEntry } from '../../../src/shared/modelCatalog'

describe('model catalog', () => {
  it('contains exactly the approved local model metadata', () => {
    expect(MODEL_CATALOG).toEqual({
      fast: {
        label: 'Fast',
        repository: 'Xenova/whisper-tiny',
        revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
        dtype: 'q8',
        multilingual: true,
        license: 'Apache-2.0',
        bundled: false,
        encoderBytes: 10_124_910,
        decoderBytes: 30_727_765,
      },
      balanced: {
        label: 'Balanced',
        repository: 'Xenova/whisper-base',
        revision: '64da57285918e20ea79ea5c88eed7197933abaa8',
        dtype: 'q8',
        multilingual: true,
        license: 'Apache-2.0',
        bundled: true,
        encoderBytes: 23_200_850,
        decoderBytes: 53_707_539,
      },
      accurate: {
        label: 'Accurate',
        repository: 'Xenova/whisper-small',
        revision: '2d67713f236afa48a18992566e7647f6ca848e13',
        dtype: 'q8',
        multilingual: true,
        license: 'Apache-2.0',
        bundled: false,
        encoderBytes: 92_324_809,
        decoderBytes: 156_780_950,
      },
    })
    expect(Object.keys(MODEL_CATALOG)).toEqual(['fast', 'balanced', 'accurate'])
  })

  it('marks only Balanced as bundled', () => {
    const bundledPresets = Object.entries(MODEL_CATALOG)
      .filter(([, model]) => model.bundled)
      .map(([preset]) => preset)

    expect(bundledPresets).toEqual(['balanced'])
  })

  it('looks up catalog entries by preset', () => {
    expect(getModelCatalogEntry('fast')).toBe(MODEL_CATALOG.fast)
    expect(getModelCatalogEntry('balanced')).toBe(MODEL_CATALOG.balanced)
    expect(getModelCatalogEntry('accurate')).toBe(MODEL_CATALOG.accurate)
  })

  it('is immutable at runtime at both catalog levels', () => {
    expect(Object.isFrozen(MODEL_CATALOG)).toBe(true)
    expect(Object.values(MODEL_CATALOG).every(Object.isFrozen)).toBe(true)

    expect(Reflect.set(MODEL_CATALOG.fast, 'label', 'Changed')).toBe(false)
    expect(Reflect.set(MODEL_CATALOG, 'cloud', { bundled: true })).toBe(false)
    expect(MODEL_CATALOG.fast.label).toBe('Fast')
    expect(MODEL_CATALOG).not.toHaveProperty('cloud')
  })
})
