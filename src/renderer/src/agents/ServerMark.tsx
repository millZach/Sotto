import React, { useCallback, useEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
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
 * turn. One glyph for any server; it does not count the server's machines. What the cells do says
 * what the server is doing: dim at rest, filling one at a time while it reads the prompt, flickering as fast as words
 * arrive while it writes, and grey, blinking once a try, while OpenCode tries it again. Decorative: the words beside it
 * say the same.
 */
export type ServerMarkState = 'idle' | 'reading' | 'writing' | 'retrying'

/** Whether a thread's model is on one of the user's own servers: OpenCode's and DeepSeek Harness's IDs both start so. */
function isOwnServerModel(modelId: string): boolean {
  return modelId.startsWith(OWN_SERVER_ID_PREFIX) && modelId.indexOf('/') > OWN_SERVER_ID_PREFIX.length
}

/**
 * Whether the server has sent anything for this turn: a reply after its message, or any work of its own. The replies are
 * read first, back to the turn's message, so a streaming reply never walks the thread's whole record of work.
 */
export function heardFrom(thread: Pick<AgentThread, 'activities' | 'messages'>, turnId: string): boolean {
  for (let at = thread.messages.length - 1; at >= 0; at--) {
    const message = thread.messages[at]!
    if (message.id === turnId) break
    if (message.role === 'assistant') return true
  }
  const records = thread.activities ?? []
  for (let at = records.length - 1; at >= 0; at--) if (records[at]!.turnId === turnId && records[at]!.kind !== 'turn') return true
  return false
}

/** Part of a turn's writing: a reply or a step of reasoning, by its ID, so its words are counted once as it grows. */
export interface ServerTurnPart { readonly id: string; readonly text: string }

/** What a window reads of a running turn to time it: whether the server has been heard, and the text it has written. */
export interface ServerTurnSample {
  readonly turnId: string; readonly startedAt: string | undefined
  /** The server has sent something for the turn, whether or not OpenCode is trying it again now. */
  readonly heard: boolean
  /** The turn's reasoning and replies so far, which the words per second are counted from. */
  readonly parts: readonly ServerTurnPart[]
}

/** The turn's sample: its reasoning, then the replies after its message. */
export function serverTurnSample(thread: Pick<AgentThread, 'activities' | 'messages'>, turn: AgentActivity, heard: boolean): ServerTurnSample {
  const parts: ServerTurnPart[] = []
  const records = thread.activities ?? []
  for (let at = records.length - 1; at >= 0; at--) {
    const record = records[at]!
    if (record === turn) break
    if (record.turnId === turn.turnId && record.kind === 'reasoning' && record.text) parts.push({ id: record.id, text: record.text })
  }
  for (let at = thread.messages.length - 1; at >= 0; at--) {
    const message = thread.messages[at]!
    if (message.id === turn.turnId) break
    if (message.role === 'assistant') parts.push({ id: message.id, text: message.text })
  }
  return { turnId: turn.turnId, startedAt: turn.startedAt, heard, parts }
}

/** A thread's mark, as its model chip shows it, and the running turn's sample to time. */
export interface OwnServerMark {
  readonly state: ServerMarkState
  /** The try OpenCode is on, while it tries the server again: each new one blinks the mark once. */
  readonly attempt?: number | undefined
  /** The newest turn's ID, whose pace the mark and the speed card read. */
  readonly turnId?: string | undefined
}

export function ownServerMarkOf(thread: AgentThread, connected: boolean): { readonly mark: OwnServerMark; readonly sample?: ServerTurnSample | undefined } {
  const turn = lastTurnRecord(thread)
  if (turn === undefined) return { mark: { state: 'idle' } }
  if (!connected || turn.status !== 'running' || thread.status !== 'running') return { mark: { state: 'idle', turnId: turn.turnId } }
  const attempt = turn.ownServer?.attempt
  const heard = heardFrom(thread, turn.turnId)
  const state: ServerMarkState = attempt !== undefined ? 'retrying' : heard ? 'writing' : 'reading'
  return { mark: { state, attempt, turnId: turn.turnId }, sample: serverTurnSample(thread, turn, heard) }
}

/**
 * What this window saw of a turn on an own server: how long its first word took, and how fast words came while they
 * came. Observed, not reported: OpenCode stamps a reply with the time its step began, before the server sent anything,
 * so the record cannot say when the first word came; DeepSeek Harness sends replies whole, so it has no rate to see.
 * A window that did not see the wait has no first-word time, and one that saw no streaming has no rate.
 */
export interface ServerPace {
  readonly firstWordMs?: number | undefined
  readonly wordsPerSecond?: number | undefined
}

/** Text that comes again within this long of the last is one stream; a longer gap is a tool running, and is not counted. */
const STREAM_GAP_MS = 1_500
/** The turns kept, newest last: enough for every pane a window shows. */
const PACES_KEPT = 64

interface Pace {
  readonly startedAt: number
  waitSeen: boolean; words: number; grewAt: number | undefined
  /** Each part's length and words when last counted, so a part that grows has only its new end counted. */
  readonly counted: Map<string, { readonly length: number; readonly words: number }>
  streamMs: number; streamWords: number
  view: ServerPace
}
const paces = new Map<string, Pace>()
const listeners = new Map<string, Set<() => void>>()
const noPace: ServerPace = {}

/** The words in a part's text after `from`, less the one the last count ended inside, which it counted then. */
function wordsAfter(text: string, from: number): number {
  const tail = text.slice(from)
  const count = tail.match(/\S+/gu)?.length ?? 0
  return from > 0 && /\S/u.test(text.charAt(from - 1)) && /^\S/u.test(tail) ? count - 1 : count
}

/** Takes a sample of a running turn. The chip and the live line both give the same one; a repeat changes nothing. */
export function observeServerTurn(sample: ServerTurnSample, now: number): void {
  let pace = paces.get(sample.turnId)
  if (pace === undefined) {
    pace = { startedAt: sample.startedAt ? Date.parse(sample.startedAt) : Number.NaN, waitSeen: false, words: 0, grewAt: undefined, counted: new Map(), streamMs: 0, streamWords: 0, view: noPace }
    paces.set(sample.turnId, pace)
    if (paces.size > PACES_KEPT) paces.delete(paces.keys().next().value!)
  }
  let firstWordMs = pace.view.firstWordMs
  if (!sample.heard) pace.waitSeen = true
  else if (firstWordMs === undefined && pace.waitSeen && Number.isFinite(pace.startedAt)) firstWordMs = Math.max(0, now - pace.startedAt)
  if (sample.heard) {
    let words = pace.words, grew = false
    for (const part of sample.parts) {
      const seen = pace.counted.get(part.id)
      if (seen?.length === part.text.length) continue
      // A part that grew has its new end counted; one that came back shorter, rewritten whole, is counted again.
      const counted = seen !== undefined && part.text.length > seen.length ? seen.words + wordsAfter(part.text, seen.length) : wordsAfter(part.text, 0)
      words += counted - (seen?.words ?? 0)
      grew ||= part.text.length > (seen?.length ?? 0)
      pace.counted.set(part.id, { length: part.text.length, words: counted })
    }
    if (grew) {
      if (pace.grewAt !== undefined && now - pace.grewAt <= STREAM_GAP_MS) { pace.streamMs += now - pace.grewAt; pace.streamWords += Math.max(0, words - pace.words) }
      pace.grewAt = now
    }
    pace.words = words
  }
  const wordsPerSecond = pace.streamMs >= 1_000 ? Math.round(pace.streamWords / (pace.streamMs / 1_000)) : undefined
  if (firstWordMs === pace.view.firstWordMs && wordsPerSecond === pace.view.wordsPerSecond) return
  pace.view = { firstWordMs, wordsPerSecond }
  for (const listener of listeners.get(sample.turnId) ?? []) listener()
}

/** Feeds the turn's sample after each draw and reads what this window has seen of the turn. */
export function useServerPace(turnId: string | undefined, sample: ServerTurnSample | undefined): ServerPace {
  useEffect(() => { if (sample !== undefined) observeServerTurn(sample, Date.now()) })
  const subscribe = useCallback((listener: () => void) => {
    if (turnId === undefined) return () => undefined
    const set = listeners.get(turnId) ?? new Set()
    listeners.set(turnId, set); set.add(listener)
    return () => { set.delete(listener); if (!set.size) listeners.delete(turnId) }
  }, [turnId])
  return useSyncExternalStore(subscribe, () => turnId === undefined ? noPace : paces.get(turnId)?.view ?? noPace)
}

/** The thread's server mark and what the window has seen of its newest turn, or null off Owl or off an own server. */
export function useOwnServerMark(thread: AgentThread, connected: boolean): (OwnServerMark & { readonly pace: ServerPace }) | null {
  const own = useOwlFeature('own-model-servers') && isOwnServerModel(thread.modelId)
  const found = own ? ownServerMarkOf(thread, connected) : undefined
  const pace = useServerPace(found?.mark.turnId, found?.sample)
  return found === undefined ? null : { ...found.mark, pace }
}

/** How long one flicker step lasts: about a step for every six words, held between a fast flicker and a slow one. */
function flickerMs(wordsPerSecond: number | undefined): number {
  if (!wordsPerSecond) return 600
  return Math.round(Math.min(600, Math.max(90, 6_000 / wordsPerSecond)) / 30) * 30
}

export function ServerMark({ state, attempt, wordsPerSecond }: {
  readonly state: ServerMarkState; readonly attempt?: number | undefined; readonly wordsPerSecond?: number | undefined
}): ReactNode {
  return <span className="server-mark" data-state={state} aria-hidden="true"
    style={state === 'writing' ? { '--server-mark-step': `${flickerMs(wordsPerSecond)}ms` } as CSSProperties : undefined}>
    {/* A new try draws the cells again, so the blink plays once for it. */}
    <span className="server-mark__cells" key={state === 'retrying' ? `try-${attempt ?? 0}` : 'cells'}><i /><i /><i /><i /></span>
  </span>
}

/** How much of the model's context the thread fills, when its usage is for the thread's model. */
function contextUsedOf(usage: AgentThread['usage'], modelId: string): number | undefined {
  return usage?.contextUsed !== undefined && (usage.modelId === undefined || usage.modelId === modelId) ? usage.contextUsed : undefined
}

/** Whether the speed card has anything to say. */
export function knowsSpeed(pace: ServerPace, usage: AgentThread['usage'], modelId: string): boolean {
  return pace.firstWordMs !== undefined || pace.wordsPerSecond !== undefined || contextUsedOf(usage, modelId) !== undefined
}

/**
 * The speed card's figures, under the model chip's name while the pointer or the keyboard focus is on the chip: how long
 * the first word took, how fast words came and how full the context is, each only when Sotto knows it. Shown only when
 * `knowsSpeed` says it has something.
 */
export function ServerSpeedCard({ pace, usage, modelId }: {
  readonly pace: ServerPace
  readonly usage: AgentThread['usage']; readonly modelId: string
}): ReactNode {
  const { t, i18n } = useLingui()
  const rows: [string, string][] = []
  if (pace.firstWordMs !== undefined) rows.push([t({ message: 'First word after', comment: 'In the speed card of a thread on the user’s own model server: how long the server took to start answering the last message, such as 41s.' }), formatDuration(pace.firstWordMs)])
  if (pace.wordsPerSecond !== undefined) rows.push([t({ message: 'Words per second', comment: 'In the speed card of a thread on the user’s own model server: how fast its reply came.' }), i18n.number(pace.wordsPerSecond)])
  const used = contextUsedOf(usage, modelId)
  if (used !== undefined) {
    const shown = formatTokenCount(used)
    const whole = usage?.contextWindow === undefined ? undefined : formatTokenCount(usage.contextWindow)
    rows.push([t({ message: 'Context used', comment: 'In the speed card of a thread on the user’s own model server: how much of the model’s context the thread fills.' }),
      whole === undefined ? shown : t({ message: `${shown} of ${whole}`, comment: '{shown} and {whole} are token counts such as 183k and 256k: how much of the model’s context the thread uses, of all it takes.' })])
  }
  return <dl className="server-speed">{rows.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>
}
