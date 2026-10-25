import { join } from 'node:path'
import type { OwnServer } from '../../shared/ownModelServers'
import {
  OWN_CLEANUP_MEASURED_MAX, OWN_CLEANUP_THINKING, ownCleanupChoiceSchema, ownCleanupMeasuredListSchema,
  type OwnCleanupChoice, type OwnCleanupMeasured, type OwnCleanupMeasureResult, type OwnCleanupThinking, type OwnCleanupTuning,
} from '../../shared/ownServerCleanup'
import { countWords } from '../../shared/textRepair'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { assessOutput, readCleanupChoice } from './cleanupOutput'
import { buildPolishSystemPrompt, buildPolishUserPrompt } from './prompt'

/**
 * AI cleanup on the user's own model server (ADR-0136). Main sends the transcript to the server's OpenAI-compatible chat
 * completions endpoint with no key, at temperature 0, with an answer limit just above what the cleanup needs, and with
 * the thinking setting Measure found fastest. Measure sends only the built-in sample below, never what the user said.
 */

/** Where Sotto keeps what each measure found, under its user data. */
export const OWN_CLEANUP_FILE = 'own-server-cleanup.json'

/**
 * The fixed transcript every measure cleans up: long enough that the shrink guard applies (it skips under 20 words), with
 * fillers, a repetition and a self-correction, so a candidate does the work a real cleanup does.
 */
export const MEASURE_SAMPLE = 'um so i wanted to give you a quick update on the garden project we finished the the raised beds on saturday '
  + 'and the soil gets delivered on tuesday no wait wednesday morning uh after that we still need to buy the tomato seedlings '
  + 'pick up two bags of mulch and fix the gate latch by the shed and honestly i think we should be done by the end of the month '
  + 'if the weather holds'
export const MEASURE_SAMPLE_WORDS = countWords(MEASURE_SAMPLE)
/**
 * Words from the start, middle and end of the sample that every passing cleanup keeps. A reply missing one dropped part
 * of the transcript, which the shrink guard alone would let through when the loss is under half.
 */
const SAMPLE_MARKERS = ['garden', 'raised beds', 'wednesday', 'tomato', 'mulch', 'latch', 'month', 'weather']

/** Each candidate is tried this many times; it passes only if every try does, and its fastest try is its time. */
const MEASURE_TRIES = 2
/** How long one test cleanup may take before it counts as failed. */
const MEASURE_REQUEST_MS = 15_000

/**
 * The longest a measured server is given before Mercury 2 takes over: three times its measured time, scaled to the
 * transcript's length, and never under 1.5 s. A server running three times slower than when it was measured is having a
 * bad moment, and Mercury 2 still fits in what is left.
 */
const TUNED_FACTOR = 3
const TUNED_FLOOR_MS = 1_500

/** The answer limit: about three tokens a word, which a cleanup never needs, plus room for list marks and line breaks. */
export function ownCleanupMaxTokens(words: number): number {
  return Math.ceil(words * 3) + 128
}

/** The milliseconds a measured server is given for a transcript of this many words; undefined when it has not been measured. */
export function ownServerBudgetMs(tuning: OwnCleanupTuning | undefined, words: number): number | undefined {
  if (tuning?.status !== 'fastest') return undefined
  return Math.max(TUNED_FLOOR_MS, Math.round(TUNED_FACTOR * tuning.ms * Math.max(1, words / MEASURE_SAMPLE_WORDS)))
}

/** What a request says about thinking, for each setting. */
function thinkingFields(thinking: OwnCleanupThinking): Record<string, unknown> {
  switch (thinking) {
    case 'plain': return {}
    case 'off': return { chat_template_kwargs: { enable_thinking: false, thinking: false } }
    case 'least': return { reasoning_effort: 'low' }
  }
}

/** The reply's text with a leading `<think>` block taken off, as servers without a reasoning parser send it; null when it never closes. */
export function withoutThinking(content: string): string | null {
  if (!content.startsWith('<think>')) return content
  const end = content.indexOf('</think>')
  return end === -1 ? null : content.slice(end + '</think>'.length).trim()
}

export interface OwnCleanupTarget {
  /** The server's saved address, which ends where the OpenAI API answers (`/v1` by default). */
  readonly address: string
  readonly model: string
}

export interface OwnCleanupOutcome {
  readonly text: string | null
  /** 'ok', 'timeout', 'network', 'http-<status>', 'unfinished', 'empty', 'rejected', 'rejected-shrink'. */
  readonly reason: string
}

/** One cleanup on the server. Never throws: every failure is an outcome, so dictation can hand over to Mercury 2. */
export async function requestOwnCleanup(options: {
  readonly fetchFn: typeof fetch
  readonly target: OwnCleanupTarget
  readonly thinking: OwnCleanupThinking
  readonly text: string
  readonly dictionary: string
  readonly signal: AbortSignal
}): Promise<OwnCleanupOutcome> {
  const { fetchFn, target, thinking, text, dictionary, signal } = options
  try {
    const response = await fetchFn(`${target.address}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: target.model,
        messages: [
          { role: 'system', content: buildPolishSystemPrompt(dictionary) },
          { role: 'user', content: buildPolishUserPrompt(text) },
        ],
        temperature: 0,
        max_tokens: ownCleanupMaxTokens(countWords(text)),
        stream: false,
        ...thinkingFields(thinking),
      }),
      // A redirect is not followed: it could send the text somewhere the user did not give (ADR-0124).
      redirect: 'manual',
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { text: null, reason: `http-${response.status}` }
    }
    const choice = readCleanupChoice(await response.json())
    if (choice?.finished === false) return { text: null, reason: 'unfinished' }
    const raw = choice?.content ?? null
    if (raw === null) return { text: null, reason: 'empty' }
    const content = withoutThinking(raw)
    // Thinking that never closed ran out of room before the answer began.
    if (content === null) return { text: null, reason: 'unfinished' }
    if (content.length === 0) return { text: null, reason: 'empty' }
    const verdict = assessOutput(text, content)
    return verdict === 'ok' ? { text: content, reason: 'ok' } : { text: null, reason: verdict }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return { text: null, reason: timedOut ? 'timeout' : 'network' }
  }
}

/** Whether a test cleanup of the sample kept every part of it. */
export function keptSample(output: string): boolean {
  const text = output.toLowerCase()
  return SAMPLE_MARKERS.every(marker => text.includes(marker))
}

/** One candidate's tries: each one's time, or null for a try that failed. */
export interface CandidateTrial {
  readonly thinking: OwnCleanupThinking
  readonly ms: readonly (number | null)[]
}

/**
 * The fastest candidate that passed every try, by its fastest try; candidates tie in the order they are listed, so the
 * one asking least of the server wins a tie. None passing is a result too: cleanup then goes straight to Mercury 2.
 */
export function pickFastest(trials: readonly CandidateTrial[]): OwnCleanupTuning {
  let best: { thinking: OwnCleanupThinking; ms: number } | undefined
  for (const trial of trials) {
    if (trial.ms.length === 0 || trial.ms.some(ms => ms === null)) continue
    const ms = Math.min(...trial.ms as number[])
    if (best === undefined || ms < best.ms) best = { thinking: trial.thinking, ms }
  }
  return best === undefined ? { status: 'none-passed' } : { status: 'fastest', thinking: best.thinking, ms: Math.round(best.ms) }
}

/**
 * Measure: every candidate cleans up the sample in turn, one request at a time so the server is never asked twice at
 * once, and the fastest that passed is the answer. A candidate stops at its first failed try. When nothing ever answered,
 * the server is unreachable and nothing is decided.
 */
export async function measureOwnCleanup(options: {
  readonly fetchFn: typeof fetch
  readonly target: OwnCleanupTarget
  readonly now?: () => number
}): Promise<OwnCleanupMeasureResult> {
  const now = options.now ?? (() => performance.now())
  const trials: CandidateTrial[] = []
  let answered = false
  for (const thinking of OWN_CLEANUP_THINKING) {
    const ms: (number | null)[] = []
    for (let attempt = 0; attempt < MEASURE_TRIES; attempt += 1) {
      const started = now()
      const outcome = await requestOwnCleanup({
        fetchFn: options.fetchFn, target: options.target, thinking, text: MEASURE_SAMPLE, dictionary: '',
        signal: AbortSignal.timeout(MEASURE_REQUEST_MS),
      })
      if (outcome.reason !== 'network' && outcome.reason !== 'timeout') answered = true
      const passed = outcome.text !== null && keptSample(outcome.text)
      ms.push(passed ? Math.max(0, now() - started) : null)
      if (!passed) break
    }
    trials.push({ thinking, ms })
  }
  return answered ? { status: 'measured', tuning: pickFastest(trials) } : { status: 'unreachable' }
}

/** What a cleanup on the user's server needs, or why it cannot run and Mercury 2 cleans up instead. */
export type OwnCleanupResolution =
  | { readonly status: 'ready'; readonly target: OwnCleanupTarget; readonly tuning: OwnCleanupTuning | undefined }
  | { readonly status: 'gone' | 'keyed' }

/** The saved server and model a choice names, and what was last measured for them. */
export function resolveOwnCleanup(choice: OwnCleanupChoice, servers: readonly OwnServer[], measured: readonly OwnCleanupMeasured[]): OwnCleanupResolution {
  const server = servers.find(item => item.id === choice.server)
  if (!server || !server.models.some(model => model.id === choice.model)) return { status: 'gone' }
  if (server.keyed) return { status: 'keyed' }
  const tuning = measured.find(item => item.server === choice.server && item.model === choice.model)?.tuning
  return { status: 'ready', target: { address: server.address, model: choice.model }, tuning }
}

/** Stable event names Measure is logged by. No address, model, sample reply or time ever is. */
export type OwnCleanupEvent = 'own-server-cleanup-measured' | 'own-server-cleanup-measure-refused'

/**
 * The measures main keeps in `own-server-cleanup.json`, one per server and model, newest last. They are read once and
 * held, so a cleanup reads them from memory.
 */
export class OwnCleanupMeasures {
  private readonly store: AtomicJsonStore<OwnCleanupMeasured[]>
  private loaded: Promise<OwnCleanupMeasured[]> | undefined
  private turn: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: {
    readonly directory: string
    readonly servers: () => Promise<readonly OwnServer[]>
    readonly fetchFn?: typeof fetch
    readonly now?: () => number
    readonly log?: (event: OwnCleanupEvent) => void
  }) {
    this.store = new AtomicJsonStore(join(options.directory, OWN_CLEANUP_FILE), ownCleanupMeasuredListSchema.parse, () => [])
  }

  measured(): Promise<OwnCleanupMeasured[]> {
    if (!this.loaded) {
      const reading = this.store.read()
      this.loaded = reading
      reading.catch(() => { if (this.loaded === reading) this.loaded = undefined })
    }
    return this.loaded
  }

  /** The server and model a cleanup would run on, from the saved servers and measures. */
  async resolve(choice: OwnCleanupChoice): Promise<OwnCleanupResolution> {
    return resolveOwnCleanup(choice, await this.options.servers(), await this.measured().catch(() => []))
  }

  /** Measures a saved server's model and keeps what was found. Measures take turns, so the server only ever has one. */
  measure(request: unknown): Promise<OwnCleanupMeasureResult> {
    const choice = ownCleanupChoiceSchema.parse(request)
    const run = this.turn.then(() => this.measuring(choice), () => this.measuring(choice))
    this.turn = run.catch(() => undefined)
    return run
  }

  private async measuring(choice: OwnCleanupChoice): Promise<OwnCleanupMeasureResult> {
    const resolved = await this.resolve(choice)
    if (resolved.status !== 'ready') {
      this.options.log?.('own-server-cleanup-measure-refused')
      return { status: resolved.status === 'gone' ? 'not-found' : 'keyed' }
    }
    const result = await measureOwnCleanup({
      fetchFn: this.options.fetchFn ?? globalThis.fetch.bind(globalThis),
      target: resolved.target,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    })
    if (result.status !== 'measured') {
      this.options.log?.('own-server-cleanup-measure-refused')
      return result
    }
    const kept = (await this.measured().catch(() => [])).filter(item => item.server !== choice.server || item.model !== choice.model)
    const next = [...kept, { ...choice, tuning: result.tuning }].slice(-OWN_CLEANUP_MEASURED_MAX)
    await this.store.write(next)
    this.loaded = Promise.resolve(next)
    this.options.log?.('own-server-cleanup-measured')
    return result
  }
}
