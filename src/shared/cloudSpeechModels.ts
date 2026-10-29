import type { CloudSpeechModel } from './contracts'

/**
 * The spelling hints a model takes: the `keyterms` field OpenRouter defines, the Azure phrase list MAI-Transcribe-2 takes
 * through `provider.options.azure`, or none. On October 29, 2026 every transcription model on OpenRouter refused
 * `keyterms`, and only MAI took a phrase list.
 */
export type CloudSpeechHints = 'keyterms' | 'azure-phrase-list' | null

/**
 * What Sotto measured of an OpenRouter speech model (ADR-0160), with `scripts/asr-bench/bench-openrouter-stt.mjs`:
 * `wer` is the share of words wrong on Sotto's English clips, `medianMs` the median time from sending a clip to its text
 * coming back, `usdPerHour` what OpenRouter billed per hour of audio (null where it bills by tokens), `hints` the
 * spelling hints the model took, and `zeroRetentionRoute` false for a model OpenRouter lists with a zero-retention host
 * whose transcription route then refuses that routing.
 */
export interface CloudSpeechScore {
  readonly wer: number
  readonly medianMs: number
  readonly usdPerHour: number | null
  readonly hints: CloudSpeechHints
  readonly zeroRetentionRoute: boolean
}

const measured = (wer: number, medianMs: number, usdPerHour: number | null, hints: CloudSpeechHints, zeroRetentionRoute = true): CloudSpeechScore =>
  ({ wer, medianMs, usdPerHour, hints, zeroRetentionRoute })

/**
 * The October 29, 2026 run: three runs of Sotto's seven English clips, 2 to 17 seconds, from forge, best first.
 * MAI-Transcribe-2 was measured with the clips' names as its phrase list, as Sotto sends it the dictionary.
 * The run, and the other-language results, are in docs/perf/2026-10-29-openrouter-speech-models.md.
 */
export const CLOUD_SPEECH_SCORES: Readonly<Record<string, CloudSpeechScore>> = {
  'qwen/qwen3-asr-1.7b': measured(0.0328, 1019, 0.027, null),
  'x-ai/grok-stt-1.0': measured(0.0328, 1199, 0.1, null),
  'nvidia/nemotron-3.5-transcribe': measured(0.038, 1169, 0.12, null),
  'qwen/qwen3-asr-0.6b': measured(0.0437, 875, 0.012, null),
  'microsoft/mai-transcribe-2': measured(0.0437, 1083, 0.1, 'azure-phrase-list'),
  'fish-audio/transcribe-1': measured(0.0328, 2490, 0.36, null),
  'deepgram/nova-3': measured(0.0492, 949, 0.258, null),
  'mistralai/voxtral-small-transcribe-3-0': measured(0.0546, 1539, 0.24, null),
  'elevenlabs/scribe-v2': measured(0.0598, 1204, 0.22, null),
  'google/chirp-3': measured(0.0543, 1764, 0.96, null),
  'assemblyai/universal-3-6-pro': measured(0.0656, 923, 0.3, null),
  'assemblyai/universal-3-5-pro': measured(0.0656, 942, 0.3, null),
  'elevenlabs/scribe-v2-medical': measured(0.0655, 997, 0.22, null),
  'openai/whisper-large-v3-turbo': measured(0.0652, 1264, 0.012, null),
  'openai/gpt-transcribe': measured(0.0652, 1354, 0.27, null),
  'openai/whisper-large-v3': measured(0.0707, 1072, 0.036, null),
  'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b': measured(0.0656, 1667, 0.012, null),
  'mistralai/voxtral-mini-3b-2507': measured(0.0707, 1188, 0.06, null),
  'openai/gpt-4o-mini-transcribe': measured(0.0692, 1382, null, null),
  'google/gemini-3.5-transcribe': measured(0.0656, 1801, null, null),
  'openai/gpt-4o-transcribe': measured(0.0747, 1511, null, null),
  'mistralai/voxtral-mini-transcribe': measured(0.0765, 1370, 0.18, null, false),
  'nvidia/parakeet-tdt-0.6b-v3': measured(0.082, 994, 0.09, null),
  'openai/whisper-1': measured(0.071, 2244, 0.36, null),
  'microsoft/mai-transcribe-1.5': measured(0.0765, 1816, 0.36, null),
  'mistralai/voxtral-small-24b-2507-stt': measured(0.071, 2394, 0.18, null),
  'mistralai/voxtral-mini-transcribe-3-0': measured(0.082, 1563, 0.21, null),
  'meta/muse-voice-transcribe-1.0': measured(0.0743, 3098, 0.18, null),
  'fish-audio/transcribe-1-pro': measured(0.153, 810, 0.36, null),
}

/**
 * How much waiting counts against accuracy in the ranking: one second of median time to the text weighs as much as one
 * percent of words wrong (Zach's choice from the measured table, ADR-0160).
 */
export const SECONDS_WEIGH_AS_WER = 0.01

/** A model as OpenRouter lists it: its slug, its name ("Maker: Model"), its prompt price and whether it has a host that keeps no audio. */
export interface ListedSpeechModel {
  readonly id: string
  readonly name: string
  readonly promptPrice: number | null
  readonly zdr: boolean
}

/** The blend Sotto ranks by: lower is better. */
export function cloudSpeechRank(score: Pick<CloudSpeechScore, 'wer' | 'medianMs'>): number {
  return score.wer + SECONDS_WEIGH_AS_WER * (score.medianMs / 1_000)
}

/**
 * OpenRouter's speech models, best first: those Sotto measured by the blend, then the rest, which Sotto has not tested
 * yet, by name. A price shows only where it is known: Sotto's measurement, or for an untested model OpenRouter's prompt
 * price when it is plainly per second of audio (some models are priced per hour under the same field). A model whose
 * zero-retention route Sotto found refused is listed as having none, so it is marked and sent without that routing.
 */
export function rankCloudSpeechModels(listed: readonly ListedSpeechModel[]): CloudSpeechModel[] {
  const rows = listed.map((model) => {
    const score = CLOUD_SPEECH_SCORES[model.id]
    const colon = model.name.indexOf(': ')
    const perSecond = model.promptPrice !== null && model.promptPrice > 0 && model.promptPrice < 0.01 ? model.promptPrice * 3_600 : null
    const row: CloudSpeechModel = {
      id: model.id,
      name: colon > 0 ? model.name.slice(colon + 2) : model.name,
      maker: colon > 0 ? model.name.slice(0, colon) : model.id.split('/')[0] ?? '',
      zdr: model.zdr && score?.zeroRetentionRoute !== false,
      wer: score?.wer ?? null,
      medianMs: score?.medianMs ?? null,
      usdPerHour: score === undefined ? (perSecond === null ? null : Math.round(perSecond * 1_000) / 1_000) : score.usdPerHour,
      scoredBy: score === undefined ? null : 'sotto',
    }
    return { row, rank: score === undefined ? null : cloudSpeechRank(score) }
  })
  return rows
    .sort((a, b) => (a.rank === null ? 1 : 0) - (b.rank === null ? 1 : 0)
      || (a.rank ?? 0) - (b.rank ?? 0)
      || a.row.name.localeCompare(b.row.name))
    .map(({ row }) => row)
}

/**
 * The model dictation uses until the user picks one: MAI-Transcribe-2, the only model that takes the dictionary and one
 * whose host stayed up while the top of the ranking went down (Zach's choice, October 29, 2026, ADR-0160); the top of
 * the ranking when OpenRouter no longer lists it.
 */
export const DEFAULT_CLOUD_SPEECH_MODEL = 'microsoft/mai-transcribe-2'

export function defaultCloudSpeechModel(ranked: readonly Pick<CloudSpeechModel, 'id'>[]): string | null {
  return ranked.some((model) => model.id === DEFAULT_CLOUD_SPEECH_MODEL) ? DEFAULT_CLOUD_SPEECH_MODEL : ranked[0]?.id ?? null
}

/** The spelling hints to send a model: what Sotto measured, or `keyterms` to try on one it has not, which falls back without. */
export function cloudSpeechHints(id: string): CloudSpeechHints {
  const score = CLOUD_SPEECH_SCORES[id]
  return score === undefined ? 'keyterms' : score.hints
}
