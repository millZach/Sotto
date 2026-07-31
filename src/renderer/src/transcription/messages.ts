import { z } from 'zod'

export const TRANSCRIPTION_SAMPLE_RATE = 16_000 as const
export const MAX_TRANSCRIPTION_SECONDS = 300 as const
export const MAX_TRANSCRIPTION_SAMPLES =
  TRANSCRIPTION_SAMPLE_RATE * MAX_TRANSCRIPTION_SECONDS

const boundedIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const presetSchema = z.enum(['fast', 'instant'])
// The app always requests WASM; the worker protocol retains the WebGPU device
// value for its internal probe/reporting paths.
const inferencePreferenceSchema = z.enum(['webgpu', 'wasm'])
const inferenceDeviceSchema = z.enum(['webgpu', 'wasm'])
const languageSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    if (value !== value.trim()) return false
    for (const character of value) {
      const codePoint = character.codePointAt(0)
      if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return false
    }
    return true
  })

const audioSchema = z.custom<Float32Array>(
  (value) => value instanceof Float32Array,
  'Audio must be a Float32Array',
).superRefine((audio, context) => {
  if (audio.length < 1 || audio.length > MAX_TRANSCRIPTION_SAMPLES) {
    context.addIssue({ code: 'custom', message: 'Audio length is outside the supported range' })
    return
  }

  for (const sample of audio) {
    if (!Number.isFinite(sample)) {
      context.addIssue({ code: 'custom', message: 'Audio samples must be finite' })
      return
    }
  }
})

const loadRequestSchema = z
  .object({
    type: z.literal('load'),
    requestId: boundedIdSchema,
    preset: presetSchema,
    inferencePreference: inferencePreferenceSchema,
  })
  .strict()

const transcribeRequestSchema = z
  .object({
    type: z.literal('transcribe'),
    requestId: boundedIdSchema,
    sessionId: boundedIdSchema,
    audio: audioSchema,
    sampleRate: z.literal(TRANSCRIPTION_SAMPLE_RATE),
    preset: presetSchema,
    language: languageSchema,
    inferencePreference: inferencePreferenceSchema,
  })
  .strict()

const cancelRequestSchema = z
  .object({
    type: z.literal('cancel'),
    requestId: boundedIdSchema,
    targetRequestId: boundedIdSchema,
    sessionId: boundedIdSchema,
  })
  .strict()

export const workerRequestSchema = z.discriminatedUnion('type', [
  loadRequestSchema,
  transcribeRequestSchema,
  cancelRequestSchema,
])

const progressResponseSchema = z
  .object({
    type: z.literal('progress'),
    requestId: boundedIdSchema,
    sessionId: boundedIdSchema.optional(),
    stage: z.enum(['loading-model', 'transcribing']),
    progress: z.number().finite().min(0).max(1),
  })
  .strict()

const readyResponseSchema = z
  .object({
    type: z.literal('ready'),
    requestId: boundedIdSchema,
    preset: presetSchema,
    device: inferenceDeviceSchema,
  })
  .strict()

const resultResponseSchema = z
  .object({
    type: z.literal('result'),
    requestId: boundedIdSchema,
    sessionId: boundedIdSchema,
    text: z.string().max(200_000),
    language: languageSchema,
  })
  .strict()

export const workerErrorCodeSchema = z.enum([
  'MODEL_MISSING',
  'WEBGPU_FAILED',
  'OUT_OF_MEMORY',
  'CANCELLED',
  'TRANSCRIPTION_FAILED',
])

const errorResponseSchema = z
  .object({
    type: z.literal('error'),
    requestId: boundedIdSchema,
    sessionId: boundedIdSchema.optional(),
    code: workerErrorCodeSchema,
    message: z.string().min(1).max(256),
  })
  .strict()

export const workerResponseSchema = z.discriminatedUnion('type', [
  progressResponseSchema,
  readyResponseSchema,
  resultResponseSchema,
  errorResponseSchema,
])

export type WorkerRequest = z.infer<typeof workerRequestSchema>
export type LoadRequest = z.infer<typeof loadRequestSchema>
export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>
export type CancelRequest = z.infer<typeof cancelRequestSchema>
export type WorkerResponse = z.infer<typeof workerResponseSchema>
export type ProgressResponse = z.infer<typeof progressResponseSchema>
export type ReadyResponse = z.infer<typeof readyResponseSchema>
export type ResultResponse = z.infer<typeof resultResponseSchema>
export type ErrorResponse = z.infer<typeof errorResponseSchema>
export type WorkerErrorCode = z.infer<typeof workerErrorCodeSchema>

export function parseWorkerRequest(input: unknown): WorkerRequest {
  return workerRequestSchema.parse(input)
}

export function parseWorkerResponse(input: unknown): WorkerResponse {
  return workerResponseSchema.parse(input)
}
