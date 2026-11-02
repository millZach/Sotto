import React, { useCallback, useEffect, useReducer, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { AgentActivity } from '../../../shared/agentActivity'
import type { AgentThread } from '../../../shared/agents'
import { OWN_SERVER_ID_PREFIX } from '../../../shared/ownModelServers'
import { lastTurnRecord } from '../../../shared/threadFailures'
import { formatTokenCount } from '../../../shared/threadUsage'
import { useOwlFeature } from '../state/owlFeature'
import { formatDuration } from './threadActivityView'
import './serverMark.css'

/**
 * The server mark (ADR-0124, November 1 amendment; the `own-model-servers` Owl feature): a 2x2 grid of square pixels
 * on a thread that runs on one of the user's own model servers, in its model chip and on the live line of its running
 * turn. One glyph for any server; it does not count the server's machines. What the cells do says what the server is
 * doing: dim and still at rest, one cell walking round while it reads the prompt, a lit cell stepping round once for
 * each piece of text that arrives while it writes, and hollow while it does not answer. Decorative: the words beside it
 * say the same.
 */
export type ServerMarkState = 'idle' | 'reading' | 'writing' | 'not-answering'

/** Whether a thread's model is on one of the user's own servers: OpenCode's and DeepSeek Harness's IDs both start so. */
function isOwnServerModel(modelId: string): boolean {
  return modelId.startsWith(OWN_SERVER_ID_PREFIX) && modelId.indexOf('/') > OWN_SERVER_ID_PREFIX.length
}

/**
 * Whether the server has sent anything for this turn: a reply after its message, or any work of its own. Both are read
 * from the end back to the turn's start, so the thread's earlier turns are never walked.
 */
export function heardFrom(thread: Pick<AgentThread, 'activities' | 'messages'>, turn: AgentActivity): boolean {
  for (let at = thread.messages.length - 1; at >= 0; at--) {
    const message = thread.messages[at]!
    if (message.id === turn.turnId) break
    if (message.role === 'assistant') return true
  }
  const records = thread.activities ?? []
  for (let at = records.length - 1; at >= 0; at--) {
    const record = records[at]!
    if (record.id === turn.id) break
    if (record.turnId === turn.turnId && record.kind !== 'turn') return true
  }
  return false
}

/** Part of a turn's writing: a reply or a step of reasoning, by its ID, so its tokens are counted once as it grows. */
export interface ServerTurnPart { readonly id: string; readonly text: string }

/** What a window reads of a turn to time it: whether it runs, whether the server has been heard, and what it wrote. */
export interface ServerTurnSample {
  readonly turnId: string; readonly startedAt: string | undefined; readonly completedAt: string | undefined
  readonly running: boolean
  /** The server has sent something for the turn, whether or not OpenCode is trying it again now. */
  readonly heard: boolean
  /** The running turn's reasoning and replies so far, which its tokens are estimated from. */
  readonly parts: readonly ServerTurnPart[]
  /** The tokens the server says the thread has written, which OpenCode reports as each step ends; absent on DeepSeek Harness. */
  readonly output: number | undefined
}

/** What a turn's sample is read from: the thread's records, and its usage where the provider counts tokens. */
export type ServerTurnThread = Pick<AgentThread, 'activities' | 'messages'> & { readonly usage?: AgentThread['usage'] }

/** The turn's sample: while it runs, its reasoning, then the replies after its message. */
export function serverTurnSample(thread: ServerTurnThread, turn: AgentActivity, heard: boolean): ServerTurnSample {
  const running = turn.status === 'running'
  const parts: ServerTurnPart[] = []
  if (running && heard) {
    const records = thread.activities ?? []
    for (let at = records.length - 1; at >= 0; at--) {
      const record = records[at]!
      if (record.id === turn.id) break
      if (record.turnId === turn.turnId && record.kind === 'reasoning' && record.text) parts.push({ id: record.id, text: record.text })
    }
    for (let at = thread.messages.length - 1; at >= 0; at--) {
      const message = thread.messages[at]!
      if (message.id === turn.turnId) break
      if (message.role === 'assistant') parts.push({ id: message.id, text: message.text })
    }
  }
  return { turnId: turn.turnId, startedAt: turn.startedAt, completedAt: turn.completedAt, running, heard, parts, output: thread.usage?.total?.output }
}

/** A thread's mark, as its model chip shows it, and its newest turn, which the speed card reads. */
export interface OwnServerMark {
  readonly state: ServerMarkState
  /** The try OpenCode is on, while it tries the server again: each new one blinks the mark once. */
  readonly attempt?: number | undefined
  /** The newest turn's record, absent before the thread's first turn. */
  readonly turn?: AgentActivity | undefined
  readonly heard: boolean
  /** The newest turn ended because the server never answered: it was out of reach, or never started within the time. */
  readonly unanswered: boolean
  readonly sample?: ServerTurnSample | undefined
}

export function ownServerMarkOf(thread: AgentThread, connected: boolean): OwnServerMark {
  const turn = lastTurnRecord(thread)
  if (turn === undefined) return { state: 'idle', heard: false, unanswered: false }
  const heard = heardFrom(thread, turn)
  const failure = turn.ownServer?.failure
  const unanswered = turn.status === 'failed' && !heard && (failure === 'unreachable' || failure === 'timeout')
  const running = connected && turn.status === 'running' && thread.status === 'running'
  const attempt = running ? turn.ownServer?.attempt : undefined
  const state: ServerMarkState = !running ? unanswered ? 'not-answering' : 'idle' : attempt !== undefined ? 'not-answering' : heard ? 'writing' : 'reading'
  return { state, attempt, turn, heard, unanswered, sample: serverTurnSample(thread, turn, heard) }
}

/** Text that comes again within this long of the last is one stream; a longer gap is a tool running, and is not counted. */
const STREAM_GAP_MS = 1_500
/** The live rate is the tokens of the last second and a half. */
const RATE_WINDOW_MS = 1_500
/**
 * Tokens are estimated from the text at about four characters each, since neither provider counts them as they stream.
 * Close for English, rougher for code; the card says "about" until the server's own count replaces it.
 */
const CHARS_PER_TOKEN = 4
/** A step shorter than this streamed too briefly for its count to make a fair rate. */
const EXACT_MIN_MS = 500
/** The speed graph's bars: one a quarter second, the last 78 of them, which is as many as the card has room for. */
const BAR_MS = 250
const BARS_KEPT = 78
/** The mark steps at most this often, however fast text comes, so a burst never blurs all four cells lit. */
const STEP_MS = 90
/** The turns kept, newest last: enough for every pane a window shows. */
const PACES_KEPT = 64

/**
 * What this window saw of a turn on an own server: when its first token came, how fast tokens came while they came, and
 * how many steps the mark has taken for them. Observed, not reported: OpenCode stamps a reply with the time its step
 * began, before the server sent anything, so no record says when the first word came. A window that did not see the
 * wait has no first-word time.
 */
interface Pace {
  readonly startedAt: number
  /** Where the graph's first bar starts: the turn's start when the window saw it waiting, otherwise when it first looked. */
  readonly origin: number
  waitSeen: boolean; heardAt: number | undefined; firstWordAt: number | undefined; endedAt: number | undefined
  /** Estimated tokens, from the text's length. */
  tokens: number; grewAt: number | undefined
  /** Each part's length when last counted, so a part that grows has only its new end counted. */
  readonly counted: Map<string, number>
  streamMs: number; streamTokens: number
  recent: { readonly at: number; readonly tokens: number }[]
  /**
   * The server's own count (OpenCode, as each step ends): where the turn began, where the last step ended and how long
   * the text had streamed then, and the last step's exact rate with when it came. Absent where the provider counts none.
   */
  outputAtStart: number | undefined; outputMark: number | undefined; streamMsAtMark: number
  exactRate: number | undefined; exactAt: number | undefined
  /** Estimated tokens by quarter second, from the origin. */
  readonly bars: Map<number, number>
  steps: number; steppedAt: number
  version: number
}
const paces = new Map<string, Pace>()
const listeners = new Map<string, Set<() => void>>()


/** Takes a sample of a turn. The chip and the live line both give the same one; a repeat changes nothing. */
export function observeServerTurn(sample: ServerTurnSample, now: number): void {
  let pace = paces.get(sample.turnId)
  if (pace === undefined) {
    if (!sample.running) return
    const startedAt = sample.startedAt ? Date.parse(sample.startedAt) : Number.NaN
    pace = { startedAt, origin: !sample.heard && Number.isFinite(startedAt) ? startedAt : now, waitSeen: false, heardAt: undefined, firstWordAt: undefined, endedAt: undefined,
      tokens: 0, grewAt: undefined, counted: new Map(), streamMs: 0, streamTokens: 0, recent: [],
      // Only a count taken before the server was heard is this turn's start; one taken later already holds some of it.
      outputAtStart: sample.heard ? undefined : sample.output, outputMark: sample.output, streamMsAtMark: 0, exactRate: undefined, exactAt: undefined,
      bars: new Map(), steps: 0, steppedAt: Number.NEGATIVE_INFINITY, version: 0 }
    paces.set(sample.turnId, pace)
    if (paces.size > PACES_KEPT) paces.delete(paces.keys().next().value!)
  }
  let changed = false
  // The server's count can come as the turn ends, or just after, so it is read even for an ended turn.
  if (sample.output !== undefined && pace.outputMark !== undefined && sample.output > pace.outputMark) {
    const ms = pace.streamMs - pace.streamMsAtMark
    if (ms >= EXACT_MIN_MS) { pace.exactRate = (sample.output - pace.outputMark) / (ms / 1_000); pace.exactAt = now }
    pace.outputMark = sample.output; pace.streamMsAtMark = pace.streamMs
    changed = true
  } else if (sample.output !== undefined && pace.outputMark === undefined) pace.outputMark = sample.output
  // An ended turn's other figures stay as the window last saw them.
  if (pace.endedAt !== undefined) {
    if (!changed) return
    pace.version++
    for (const listener of listeners.get(sample.turnId) ?? []) listener()
    return
  }
  if (!sample.running) {
    const completedAt = sample.completedAt ? Date.parse(sample.completedAt) : Number.NaN
    pace.endedAt = Number.isFinite(completedAt) ? Math.max(completedAt, pace.origin) : now
    changed = true
  } else if (!sample.heard) {
    if (!pace.waitSeen) { pace.waitSeen = true; changed = true }
  } else {
    // The text a window finds already written when it first looks is where it starts counting, not tokens that came then.
    const looking = pace.heardAt === undefined && !pace.waitSeen
    if (pace.heardAt === undefined) { pace.heardAt = now; if (pace.waitSeen) pace.firstWordAt = now; changed = true }
    let tokens = pace.tokens
    for (const part of sample.parts) {
      const seen = pace.counted.get(part.id)
      if (seen === part.text.length) continue
      // A part that came back shorter was rewritten whole, so it is counted again from its new length.
      tokens += (part.text.length - (seen ?? 0)) / CHARS_PER_TOKEN
      pace.counted.set(part.id, part.text.length)
    }
    const added = Math.max(0, tokens - pace.tokens)
    pace.tokens = tokens
    if (added > 0 && !looking) {
      if (pace.grewAt !== undefined && now - pace.grewAt <= STREAM_GAP_MS) { pace.streamMs += now - pace.grewAt; pace.streamTokens += added }
      pace.grewAt = now
      pace.recent = pace.recent.filter(text => now - text.at < RATE_WINDOW_MS)
      pace.recent.push({ at: now, tokens: added })
      const bar = Math.floor((now - pace.origin) / BAR_MS)
      pace.bars.set(bar, (pace.bars.get(bar) ?? 0) + added)
      for (const kept of pace.bars.keys()) if (kept <= bar - BARS_KEPT) pace.bars.delete(kept)
      if (now - pace.steppedAt >= STEP_MS) { pace.steps++; pace.steppedAt = now }
      changed = true
    }
  }
  if (!changed) return
  pace.version++
  for (const listener of listeners.get(sample.turnId) ?? []) listener()
}

/** Feeds the turn's sample after each draw, where the window reads its thread. */
function useFeedServerTurn(sample: ServerTurnSample | undefined): void {
  useEffect(() => { if (sample !== undefined) observeServerTurn(sample, Date.now()) })
}

/** Reads one thing of a turn's pace, drawing again when it changes. */
function usePaceValue<Value>(turnId: string | undefined, read: (pace: Pace | undefined) => Value): Value {
  const subscribe = useCallback((listener: () => void) => {
    if (turnId === undefined) return () => undefined
    const set = listeners.get(turnId) ?? new Set()
    listeners.set(turnId, set); set.add(listener)
    return () => { set.delete(listener); if (!set.size) listeners.delete(turnId) }
  }, [turnId])
  return useSyncExternalStore(subscribe, () => read(turnId === undefined ? undefined : paces.get(turnId)))
}

/** The thread's server mark and newest turn, or null off Owl or off an own server. Feeds what the window sees of the turn. */
export function useOwnServerMark(thread: AgentThread, connected: boolean): OwnServerMark | null {
  const own = useOwlFeature('own-model-servers') && isOwnServerModel(thread.modelId)
  const mark = own ? ownServerMarkOf(thread, connected) : undefined
  useFeedServerTurn(mark?.sample)
  return mark ?? null
}

/** The live line's mark for a running turn on an own server, fed as the chip's is. */
export function LiveServerMark({ thread, turn, heard, attempt }: {
  readonly thread: ServerTurnThread; readonly turn: AgentActivity; readonly heard: boolean; readonly attempt: number | undefined
}): ReactNode {
  useFeedServerTurn(serverTurnSample(thread, turn, heard))
  return <ServerMark state={attempt !== undefined ? 'not-answering' : heard ? 'writing' : 'reading'} attempt={attempt} turnId={turn.turnId} />
}

/** Clockwise from the top left, over the cells in reading order. */
const CLOCKWISE = [0, 1, 3, 2] as const

export function ServerMark({ state, attempt, turnId, finished = false }: {
  readonly state: ServerMarkState; readonly attempt?: number | undefined
  /** The turn whose text steps the mark while it writes. */
  readonly turnId?: string | undefined
  /** The turn ended with its reply, so the mark lights once as it comes to rest. */
  readonly finished?: boolean | undefined
}): ReactNode {
  const steps = usePaceValue(state === 'writing' ? turnId : undefined, pace => pace?.steps ?? 0)
  const [was, setWas] = useState(state)
  const [done, setDone] = useState(false)
  if (was !== state) { setWas(state); setDone(state === 'idle' && finished && (was === 'reading' || was === 'writing')) }
  // Writing: a lit head, the cell behind it at half and the one behind that faint, like a comet's tail. Not answering:
  // each try fills the next cell round, once.
  const cellOf = (cell: number): string | undefined => {
    if (state === 'not-answering') return attempt !== undefined && cell === CLOCKWISE[(attempt - 1) % 4] ? 'try' : undefined
    if (state !== 'writing') return undefined
    if (cell === CLOCKWISE[steps % 4]) return 'lit'
    if (steps > 0 && cell === CLOCKWISE[(steps + 3) % 4]) return 'half'
    return steps > 1 && cell === CLOCKWISE[(steps + 2) % 4] ? 'tail' : undefined
  }
  return <span className="server-mark" data-state={state} data-done={done || undefined} aria-hidden="true">
    {/* A new try draws the cells again, so its cell fills once for it. */}
    <span className="server-mark__cells" key={state === 'not-answering' ? `try-${attempt ?? 'none'}` : 'cells'}>
      {[0, 1, 2, 3].map(cell => <i key={cell} data-cell={cellOf(cell)} />)}
    </span>
  </span>
}

/** How much of the model's context the thread fills, when its usage is for the thread's model. */
function contextUsedOf(usage: AgentThread['usage'], modelId: string): number | undefined {
  return usage?.contextUsed !== undefined && (usage.modelId === undefined || usage.modelId === modelId) ? usage.contextUsed : undefined
}

/** The speed graph's bars up to `at`, oldest first: estimated tokens a second in each quarter second, null while it waited. */
function barsOf(pace: Pace, at: number): (number | null)[] {
  const last = Math.floor(((pace.endedAt ?? at) - pace.origin) / BAR_MS)
  const firstWord = pace.heardAt === undefined ? Number.POSITIVE_INFINITY : Math.floor((pace.heardAt - pace.origin) / BAR_MS)
  const bars: (number | null)[] = []
  for (let bar = Math.max(0, last - BARS_KEPT + 1); bar <= last; bar++) bars.push(bar < firstWord ? null : (pace.bars.get(bar) ?? 0) * (1_000 / BAR_MS))
  return bars
}

/** The graph's height in pixels; its top stands for at least 40 tokens a second and moves in steps of 20, so it holds still. */
const GRAPH_PX = 28
const GRAPH_FLOOR = 40
const GRAPH_STEP = 20

/**
 * The speed card's figures, under the model chip's name while the pointer rests on the chip or the keyboard focus is on
 * it: the turn's speed graph, how long its first token took, how fast tokens come and how full the context is. It keeps
 * the last turn's figures once that turn has ended, and while it shows a running turn it counts on four times a second.
 */
export function ServerSpeedCard({ turn, heard, unanswered, usage, modelId, shown }: Pick<OwnServerMark, 'heard' | 'unanswered'> & {
  readonly turn: AgentActivity
  readonly usage: AgentThread['usage']; readonly modelId: string
  readonly shown: boolean
}): ReactNode {
  const { t, i18n } = useLingui()
  const running = turn.status === 'running'
  usePaceValue(turn.turnId, pace => pace?.version ?? -1)
  const [, tick] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    if (!shown || !running) return
    const timer = setInterval(tick, BAR_MS)
    return () => clearInterval(timer)
  }, [shown, running])
  const now = Date.now()
  const pace = paces.get(turn.turnId)
  const none = '–'
  const waitingFor = (waited: string): string => t({ message: `Waiting, ${waited}`, comment: 'In the speed card of a thread on the user’s own model server: no token yet, and how long it has waited, such as 42s.' })
  const startedAt = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN
  const firstWord = pace?.firstWordAt !== undefined && Number.isFinite(pace.startedAt) ? formatDuration(Math.max(0, pace.firstWordAt - pace.startedAt))
    : unanswered ? t({ message: 'No answer', comment: 'In the speed card of a thread on the user’s own model server, for how long the first token took: the server never answered.' })
    : running && !heard && Number.isFinite(startedAt) ? waitingFor(formatDuration(Math.max(0, now - startedAt)))
    : none
  // Live, the rate is estimated from the text. Once a step ends with no text since, OpenCode's own count gives its exact
  // rate; after the turn, the server's count over the whole turn does, where the window saw the turn from its start.
  let rate = none, paused = false, average = false, estimated = false
  if (pace !== undefined && running && heard) {
    const recent = pace.recent.reduce((sum, text) => now - text.at < RATE_WINDOW_MS ? sum + text.tokens : sum, 0)
    if (pace.exactRate !== undefined && pace.exactAt !== undefined && (pace.grewAt === undefined || pace.exactAt >= pace.grewAt)) rate = i18n.number(Math.round(pace.exactRate))
    else if (recent === 0) { paused = true; rate = t({ message: 'Paused', comment: 'The large figure in the speed card of a thread on the user’s own model server: no tokens have come for a moment.' }) }
    else if (pace.streamMs > 0) { estimated = true; rate = i18n.number(Math.round(recent / (RATE_WINDOW_MS / 1_000))) }
  } else if (pace !== undefined && !running && pace.streamMs >= 1_000) {
    average = true
    const counted = pace.outputAtStart !== undefined && pace.outputMark !== undefined && pace.outputMark > pace.outputAtStart ? pace.outputMark - pace.outputAtStart : undefined
    estimated = counted === undefined
    rate = i18n.number(Math.round((counted ?? pace.streamTokens) / (pace.streamMs / 1_000)))
  }
  const used = contextUsedOf(usage, modelId)
  const contextOf = (shown: string, size: number | undefined): string => {
    if (size === undefined) return shown
    const whole = formatTokenCount(size)
    return t({ message: `${shown} of ${whole}`, comment: '{shown} and {whole} are token counts such as 183k and 256k: how much of the model’s context the thread uses, of all it takes.' })
  }
  const whole = used === undefined ? undefined : usage?.contextWindow
  const bars = pace === undefined ? [] : barsOf(pace, now)
  const peak = Math.max(GRAPH_FLOOR, Math.ceil(Math.max(0, ...bars.map(bar => bar ?? 0)) / GRAPH_STEP) * GRAPH_STEP)
  // Fixed slots, newest on the right, so the graph scrolls rather than grows.
  const slots: (number | null | undefined)[] = [...Array<undefined>(BARS_KEPT - bars.length).fill(undefined), ...bars]
  const filled = whole === undefined || used === undefined ? 0 : Math.min(16, Math.round(used / whole * 16))
  return <div className="server-speed">
    <p className="server-speed__head">
      <span>{running ? t({ message: 'This turn', comment: 'Heads the speed card of a thread on the user’s own model server while its turn runs.' })
        : unanswered ? t({ message: 'Last turn didn’t start', comment: 'Heads the speed card of a thread on the user’s own model server when its last turn failed because the server never answered.' })
        : t({ message: 'Last turn', comment: 'Heads the speed card of a thread on the user’s own model server once its last turn has ended.' })}</span>
      {turn.ownServer?.host ? <span className="server-speed__host">{turn.ownServer.host}</span> : null}
    </p>
    <p className="server-speed__rate" data-paused={paused || undefined}>
      {estimated ? <span>{t({ message: 'about', comment: 'Before the large figure in the speed card of a thread on the user’s own model server, such as "about 38 tokens a second": the figure is estimated from the text, not counted by the server.' })}</span> : null}
      <span className="server-speed__figure">{rate}</span>
      {paused ? null : <span>{average ? t({ message: 'tokens a second, on average', comment: 'Beside the large figure in the speed card of a thread on the user’s own model server once its turn has ended, such as 38: how fast the model wrote the last reply, on average. Tokens are the pieces a language model writes in.' })
        : t({ message: 'tokens a second', comment: 'Beside the large figure in the speed card of a thread on the user’s own model server, such as 38: how fast the model is writing. Tokens are the pieces a language model writes in.' })}</span>}
    </p>
    <span className="server-speed__graph" aria-hidden="true">
      {slots.map((bar, at) => bar === undefined || bar === 0 ? <i key={at} /> : bar === null ? <i key={at} data-wait />
        : <i key={at} data-bar={running && at === slots.length - 1 ? 'now' : ''} style={{ height: `${Math.max(2, Math.round(bar / peak * GRAPH_PX))}px` }} />)}
    </span>
    <dl className="server-speed__figures">
      <div><dt>{t({ message: 'First token after', comment: 'In the speed card of a thread on the user’s own model server: how long the server took to start answering the last message, such as 41s.' })}</dt><dd>{firstWord}</dd></div>
      {used === undefined ? null : <div><dt>{t({ message: 'Context used', comment: 'In the speed card of a thread on the user’s own model server: how much of the model’s context the thread fills.' })}</dt>
        <dd>{contextOf(formatTokenCount(used), whole)}</dd></div>}
    </dl>
    {whole === undefined ? null : <span className="server-speed__context" aria-hidden="true">
      {Array.from({ length: 16 }, (_, at) => <i key={at} data-on={at < filled || undefined} />)}
    </span>}
  </div>
}
