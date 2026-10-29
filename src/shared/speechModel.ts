import { z } from 'zod'

/** A model the store can download and check: its folder name and each file's pinned size and SHA-256. */
export interface SpeechModelManifest {
  readonly id: string
  readonly files: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[]
}

export type SpeechModelFile = SpeechModelManifest['files'][number]

/**
 * A speech model Sotto downloads (ADR-0071, ADR-0094): Parakeet in the sherpa-onnx layout, 8-bit. Its
 * four files are release assets on Sotto's own releases, under a pre-release tag the updater never
 * reads, pinned here by size and SHA-256. A new model version is new assets, a new tag and new pins.
 */
export interface SottoSpeechModel extends SpeechModelManifest {
  readonly name: string
  readonly maker: string
  /** What it understands, as the picker says it: "25 European languages", "English only". */
  readonly languages: string
  readonly releaseTag: string
}

/** NVIDIA's Parakeet TDT 0.6B v3, k2-fsa's int8 export: the model Sotto has downloaded since ADR-0071. */
export const PARAKEET_V3: SottoSpeechModel = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  name: 'Parakeet v3',
  maker: 'NVIDIA',
  languages: '25 European languages',
  releaseTag: 'speech-model-parakeet-tdt-0.6b-v3-int8-1',
  files: [
    { name: 'encoder.int8.onnx', bytes: 652_184_281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
    { name: 'decoder.int8.onnx', bytes: 11_845_275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
    { name: 'joiner.int8.onnx', bytes: 6_355_277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
    { name: 'tokens.txt', bytes: 93_939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
  ],
}

/**
 * Moondream's Parakeet Ultra, a post-training of Parakeet v3 with the same languages and tokens.
 * Moondream publishes only its weights, so Sotto converted them itself: mapped onto v3's NeMo model
 * and exported with k2-fsa's v3 script (docs/verification/2026-10-20-sotto-speech-models.md).
 */
export const PARAKEET_ULTRA: SottoSpeechModel = {
  id: 'parakeet-ultra-int8',
  name: 'Parakeet Ultra',
  maker: 'Moondream',
  languages: '25 European languages',
  releaseTag: 'speech-model-parakeet-ultra-int8-1',
  files: [
    { name: 'encoder.int8.onnx', bytes: 652_282_328, sha256: 'c958c1344fd795beba8f5d29c44dc0f27f5f92c3f75ad83599765ae06ce4f1d3' },
    { name: 'decoder.int8.onnx', bytes: 11_845_274, sha256: '1fab98fe6c12aded87d2da66272cc9e148d0a0044ce3850a12fe56302ec4a922' },
    { name: 'joiner.int8.onnx', bytes: 6_355_277, sha256: '8a71aaccfdba3d451775507a889afd2257d2e754463fd81095a8c8f290f924c2' },
    { name: 'tokens.txt', bytes: 93_939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
  ],
}

/** NVIDIA's English-only Parakeet TDT 0.6B v2, k2-fsa's int8 export. */
export const PARAKEET_V2: SottoSpeechModel = {
  id: 'parakeet-tdt-0.6b-v2-int8',
  name: 'Parakeet v2',
  maker: 'NVIDIA',
  languages: 'English only',
  releaseTag: 'speech-model-parakeet-tdt-0.6b-v2-int8-1',
  files: [
    { name: 'encoder.int8.onnx', bytes: 652_184_296, sha256: 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab' },
    { name: 'decoder.int8.onnx', bytes: 7_257_753, sha256: 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e' },
    { name: 'joiner.int8.onnx', bytes: 1_739_080, sha256: '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2' },
    { name: 'tokens.txt', bytes: 9_384, sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d' },
  ],
}

/**
 * Every model Sotto downloads, in the order the picker offers them. Parakeet Ultra comes first, so
 * setup suggests it to someone choosing (ADR-0094); it is v3 trained further, with the same
 * languages, and more accurate. An install that already has v3 keeps it: the order only changes
 * what is suggested, never what is chosen.
 */
export const SOTTO_SPEECH_MODELS: readonly SottoSpeechModel[] = [PARAKEET_ULTRA, PARAKEET_V3, PARAKEET_V2]

/** The Sotto model with this id, or undefined for a model already on this computer or one not offered. */
export function sottoSpeechModel(id: string | null): SottoSpeechModel | undefined {
  return SOTTO_SPEECH_MODELS.find((model) => model.id === id)
}

/** The bytes a model's download comes to. */
export function speechModelBytes(model: SpeechModelManifest): number {
  return model.files.reduce((total, file) => total + file.bytes, 0)
}

export function speechModelFileUrl(model: SottoSpeechModel, file: SpeechModelFile): string {
  return `https://github.com/millZach/Sotto-releases/releases/download/${model.releaseTag}/${file.name}`
}

/**
 * Why the model is not ready after trying: the download stopped (`network`), a file arrived but
 * was not the pinned one (`checksum`), it could not be written (`disk`), or the files are right but
 * the speech engine would not start (`engine`), or the chosen model's files are no longer on this
 * computer (`gone`).
 */
export const speechModelFailureSchema = z.enum(['network', 'checksum', 'disk', 'engine', 'gone'])
export type SpeechModelFailure = z.infer<typeof speechModelFailureSchema>

/**
 * Where a model on the picker comes from: one of Sotto's downloads, or a Core ML model FluidAudio
 * keeps on an Apple silicon Mac, which Sotto runs through its helper.
 */
export const speechModelSourceSchema = z.enum(['sotto', 'fluidaudio'])
export type SpeechModelSource = z.infer<typeof speechModelSourceSchema>

/**
 * One model the user can choose for dictation. `installed` is whether its files are on this
 * computer; `bytes` is their size there, or the download's size when they are not.
 */
export const speechModelOptionSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
  maker: z.string().min(1).max(80),
  languages: z.string().min(1).max(120),
  source: speechModelSourceSchema,
  installed: z.boolean(),
  bytes: z.number().int().min(0),
}).strict()
export type SpeechModelOption = z.infer<typeof speechModelOptionSchema>
export const speechModelListSchema = z.array(speechModelOptionSchema).max(32)

/** How the picker offers one of Sotto's models: here when `installed`, otherwise a download of its size. */
export function sottoSpeechModelOption(model: SottoSpeechModel, installed: boolean): SpeechModelOption {
  return {
    id: model.id,
    name: model.name,
    maker: model.maker,
    languages: model.languages,
    source: 'sotto',
    installed,
    bytes: speechModelBytes(model),
  }
}
export const speechModelIdSchema = z.string().min(1).max(128)

/**
 * Whether the speech model dictation would load is already on this computer: the chosen one, or with none chosen any
 * that is here. Transcribe on this computer is offered, and run, only then, so a press never starts a download (ADR-0160).
 */
export function speechModelHere(options: readonly SpeechModelOption[], chosen: string | null): boolean {
  return options.some((option) => option.installed && (chosen === null || option.id === chosen))
}

const bytesSchema = z.number().int().min(0)
const totalSchema = z.number().int().positive()

/**
 * Where the speech model stands. `missing` while no model is chosen; `downloading` with bytes so
 * far; `loading` once the files are verified and the engine is starting; `ready` while it can
 * transcribe; `failed` with why and how far the download got, which a retry continues from.
 */
export const speechModelStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('missing') }).strict(),
  z.object({ state: z.literal('downloading'), receivedBytes: bytesSchema, totalBytes: totalSchema }).strict(),
  z.object({ state: z.literal('loading') }).strict(),
  z.object({ state: z.literal('ready') }).strict(),
  z.object({ state: z.literal('failed'), reason: speechModelFailureSchema, receivedBytes: bytesSchema, totalBytes: totalSchema }).strict(),
])
export type SpeechModelStatus = z.infer<typeof speechModelStatusSchema>

/** "280 of 670 MB": what a person reads while the model downloads. */
export function describeSpeechModelProgress(receivedBytes: number, totalBytes: number): string {
  const mb = (bytes: number): number => Math.round(bytes / 1_000_000)
  return `${mb(receivedBytes)} of ${mb(totalBytes)} MB`
}
