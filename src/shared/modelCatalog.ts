import type { ModelPreset } from './settings'

export interface ModelCatalogEntry {
  readonly label: string
  readonly repository: string
  readonly revision: string
  readonly dtype: 'q8'
  readonly multilingual: true
  readonly license: 'Apache-2.0'
  readonly bundled: boolean
  readonly encoderBytes: number
  readonly decoderBytes: number
}

export type ModelCatalog = Readonly<Record<ModelPreset, Readonly<ModelCatalogEntry>>>

function immutableEntry(entry: ModelCatalogEntry): Readonly<ModelCatalogEntry> {
  return Object.freeze(entry)
}

export const MODEL_CATALOG: ModelCatalog = Object.freeze({
  fast: immutableEntry({
    label: 'Fast',
    repository: 'Xenova/whisper-tiny',
    revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
    dtype: 'q8',
    multilingual: true,
    license: 'Apache-2.0',
    bundled: false,
    encoderBytes: 10_124_910,
    decoderBytes: 30_727_765,
  }),
  balanced: immutableEntry({
    label: 'Balanced',
    repository: 'Xenova/whisper-base',
    revision: '64da57285918e20ea79ea5c88eed7197933abaa8',
    dtype: 'q8',
    multilingual: true,
    license: 'Apache-2.0',
    bundled: true,
    encoderBytes: 23_200_850,
    decoderBytes: 53_707_539,
  }),
  accurate: immutableEntry({
    label: 'Accurate',
    repository: 'Xenova/whisper-small',
    revision: '2d67713f236afa48a18992566e7647f6ca848e13',
    dtype: 'q8',
    multilingual: true,
    license: 'Apache-2.0',
    bundled: false,
    encoderBytes: 92_324_809,
    decoderBytes: 156_780_950,
  }),
})

export function getModelCatalogEntry(preset: ModelPreset): Readonly<ModelCatalogEntry> {
  return MODEL_CATALOG[preset]
}
