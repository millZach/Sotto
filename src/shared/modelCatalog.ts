import type { ModelPreset } from './settings'

export type ModelFamily = 'whisper' | 'moonshine'

export interface ModelCatalogEntry {
  readonly label: string
  readonly repository: string
  readonly revision: string
  readonly family: ModelFamily
  readonly dtype: 'q8'
  readonly multilingual: boolean
  readonly license: 'Apache-2.0' | 'MIT'
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
    family: 'whisper',
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
    family: 'whisper',
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
    family: 'whisper',
    dtype: 'q8',
    multilingual: true,
    license: 'Apache-2.0',
    bundled: false,
    encoderBytes: 92_324_809,
    decoderBytes: 156_780_950,
  }),
  // Moonshine's cost scales with utterance length instead of Whisper's fixed
  // 30-second window, making it ~5-10x faster on dictation-length audio
  // (docs/perf/2026-07-20-dictation-latency.md). English-only.
  instant: immutableEntry({
    label: 'Instant',
    repository: 'onnx-community/moonshine-base-ONNX',
    revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
    family: 'moonshine',
    dtype: 'q8',
    multilingual: false,
    license: 'MIT',
    bundled: false,
    encoderBytes: 20_513_063,
    decoderBytes: 42_498_870,
  }),
})

export function getModelCatalogEntry(preset: ModelPreset): Readonly<ModelCatalogEntry> {
  return MODEL_CATALOG[preset]
}
