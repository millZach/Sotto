import { z } from 'zod'

/**
 * The speech model that transcribes dictation on this computer (ADR-0071): NVIDIA's Parakeet TDT
 * 0.6B v3, 8-bit, in the sherpa-onnx layout. Its four files are release assets on Sotto's own
 * releases, under a pre-release tag the updater never reads, pinned here by size and SHA-256. A new
 * model version is new assets, a new tag and new pins.
 */
export const SPEECH_MODEL = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  name: 'Parakeet v3',
  maker: 'NVIDIA',
  languages: 25,
  releaseTag: 'speech-model-parakeet-tdt-0.6b-v3-int8-1',
  files: [
    { name: 'encoder.int8.onnx', bytes: 652_184_281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
    { name: 'decoder.int8.onnx', bytes: 11_845_275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
    { name: 'joiner.int8.onnx', bytes: 6_355_277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
    { name: 'tokens.txt', bytes: 93_939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
  ],
} as const

/** A model the store can download and check: its folder name and each file's pinned size and SHA-256. */
export interface SpeechModelManifest {
  readonly id: string
  readonly files: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[]
}

export type SpeechModelFile = SpeechModelManifest['files'][number]

export const SPEECH_MODEL_BYTES = SPEECH_MODEL.files.reduce((total, file) => total + file.bytes, 0)

/** The model's size as people read file sizes: "670 MB". */
export const SPEECH_MODEL_SIZE = `${Math.round(SPEECH_MODEL_BYTES / 1_000_000)} MB`

export function speechModelFileUrl(file: SpeechModelFile): string {
  return `https://github.com/millZach/Sotto-releases/releases/download/${SPEECH_MODEL.releaseTag}/${file.name}`
}

/**
 * Why the model is not ready after trying: the download stopped (`network`), a file arrived but
 * was not the pinned one (`checksum`), it could not be written (`disk`), or the files are right but
 * the speech engine would not start (`engine`).
 */
export const speechModelFailureSchema = z.enum(['network', 'checksum', 'disk', 'engine'])
export type SpeechModelFailure = z.infer<typeof speechModelFailureSchema>

const bytesSchema = z.number().int().min(0)
const totalSchema = z.number().int().positive()

/**
 * Where the speech model stands. `missing` before anything was tried; `downloading` with bytes so
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
export function describeSpeechModelProgress(receivedBytes: number, totalBytes: number = SPEECH_MODEL_BYTES): string {
  const mb = (bytes: number): number => Math.round(bytes / 1_000_000)
  return `${mb(receivedBytes)} of ${mb(totalBytes)} MB`
}
