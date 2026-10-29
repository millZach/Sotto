import type { CloudSpeechModel } from './contracts'

/**
 * What Sotto knows about an OpenRouter speech model's quality (ADR-0160). `wer` is the share of words wrong on English,
 * `medianMs` the median time from sending a dictation-sized clip to its text coming back, `keyterms` whether the model
 * takes spelling hints. `scoredBy: 'sotto'` rows come from `scripts/asr-bench/bench-openrouter-stt.mjs`; the others carry
 * only Artificial Analysis's published AA-WER (v2, English), until Sotto measures them.
 */
export interface CloudSpeechScore {
  readonly wer: number
  readonly medianMs: number | null
  readonly usdPerHour: number | null
  readonly keyterms: boolean | null
  readonly scoredBy: 'sotto' | 'artificial-analysis'
}

const published = (wer: number): CloudSpeechScore => ({ wer, medianMs: null, usdPerHour: null, keyterms: null, scoredBy: 'artificial-analysis' })

/** Artificial Analysis's speech-to-text leaderboard, read October 29, 2026, mapped to OpenRouter's slugs. */
export const CLOUD_SPEECH_SCORES: Readonly<Record<string, CloudSpeechScore>> = {
  'microsoft/mai-transcribe-2': published(0.020),
  'mistralai/voxtral-small-transcribe-3-0': published(0.021),
  'elevenlabs/scribe-v2': published(0.022),
  'mistralai/voxtral-mini-transcribe-3-0': published(0.022),
  'microsoft/mai-transcribe-1.5': published(0.024),
  'google/gemini-3.5-transcribe': published(0.026),
  'mistralai/voxtral-small-24b-2507-stt': published(0.028),
  'assemblyai/universal-3-5-pro': published(0.030),
  'openai/gpt-transcribe': published(0.033),
  'nvidia/nemotron-3.5-transcribe': published(0.034),
  'mistralai/voxtral-mini-transcribe': published(0.036),
  'mistralai/voxtral-mini-3b-2507': published(0.038),
  'openai/gpt-4o-transcribe': published(0.040),
  'openai/whisper-large-v3': published(0.041),
  'openai/whisper-1': published(0.041),
  'google/chirp-3': published(0.043),
  'nvidia/parakeet-tdt-0.6b-v3': published(0.045),
  'openai/gpt-4o-mini-transcribe': published(0.045),
  'openai/whisper-large-v3-turbo': published(0.046),
  'deepgram/nova-3': published(0.052),
}

/**
 * How much waiting counts against accuracy in the ranking: one second of median time-to-text weighs as much as this
 * share of words wrong. Zach chooses it from the measured table (ADR-0160).
 */
export const SECONDS_WEIGH_AS_WER = 0.01

/** A model as OpenRouter lists it: its slug, its name ("Maker: Model"), its prompt price and whether it has a host that keeps no audio. */
export interface ListedSpeechModel {
  readonly id: string
  readonly name: string
  readonly promptPrice: number | null
  readonly zdr: boolean
}

/** The blend Sotto ranks by: lower is better, null when the model has not been measured for speed. */
export function cloudSpeechRank(score: Pick<CloudSpeechScore, 'wer' | 'medianMs'>): number | null {
  return score.medianMs === null ? null : score.wer + SECONDS_WEIGH_AS_WER * (score.medianMs / 1_000)
}

/**
 * OpenRouter's speech models, best first: those Sotto measured by the blend, then those with only a published error
 * rate by that rate, then the rest by name. A price shows only where it is known: Sotto's measurement, or OpenRouter's
 * prompt price when it is plainly per second of audio (some models are priced per hour under the same field).
 */
export function rankCloudSpeechModels(listed: readonly ListedSpeechModel[]): CloudSpeechModel[] {
  const rows = listed.map((model): CloudSpeechModel & { readonly rank: number | null } => {
    const score = CLOUD_SPEECH_SCORES[model.id]
    const colon = model.name.indexOf(': ')
    const perSecond = model.promptPrice !== null && model.promptPrice > 0 && model.promptPrice < 0.01 ? model.promptPrice * 3_600 : null
    return {
      id: model.id,
      name: colon > 0 ? model.name.slice(colon + 2) : model.name,
      maker: colon > 0 ? model.name.slice(0, colon) : model.id.split('/')[0] ?? '',
      zdr: model.zdr,
      wer: score?.wer ?? null,
      medianMs: score?.medianMs ?? null,
      usdPerHour: score?.usdPerHour ?? (perSecond === null ? null : Math.round(perSecond * 1_000) / 1_000),
      scoredBy: score?.scoredBy ?? null,
      rank: score === undefined ? null : cloudSpeechRank(score),
    }
  })
  const tier = (row: (typeof rows)[number]): number => row.rank !== null ? 0 : row.wer !== null ? 1 : 2
  return rows
    .sort((a, b) => tier(a) - tier(b)
      || (a.rank ?? a.wer ?? 0) - (b.rank ?? b.wer ?? 0)
      || a.name.localeCompare(b.name))
    .map((row): CloudSpeechModel => ({
      id: row.id, name: row.name, maker: row.maker, zdr: row.zdr, wer: row.wer, medianMs: row.medianMs, usdPerHour: row.usdPerHour, scoredBy: row.scoredBy,
    }))
}

/** Whether Sotto knows the model refuses spelling hints, so the request leaves them out from the start. */
export function refusesKeyterms(id: string): boolean {
  return CLOUD_SPEECH_SCORES[id]?.keyterms === false
}
