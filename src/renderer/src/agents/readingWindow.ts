import type { AgentActivity } from '../../../shared/agentActivity'
import type { AgentThread } from '../../../shared/agents'

/**
 * The thread a transcript draws, which is the thread main hands it, with what main let go of ahead of it while the reader
 * reads above the end.
 *
 * Main keeps a thread on screen as a history window of its newest turns and reads that window again at every publish, so
 * each message that begins a turn moves the window on and takes its oldest turn off the top, with that turn's work. In a
 * thread the user writes to, that happens when they send. In Watcher's conversation every piece of news begins a turn, so
 * it happens by itself every few minutes: the rows above a reader went one turn at a time, and then the row they were
 * reading (November 13, 2026). The transcript is the only part that knows its reader is not at the end, so it holds what
 * the window let go until they are back there. Main's window, and what it costs main, stay as they were.
 */
export interface ReadingWindow {
  /** The thread as main last handed it. */
  readonly source: AgentThread
  /** The thread to draw: `source` itself when nothing is held. */
  readonly thread: AgentThread
  /** How many messages are held ahead of main's window. */
  readonly held: number
  /** The work held with them: the records of the turns the window let go, so those turns stay folded as they were. */
  readonly work: readonly AgentActivity[]
}

/**
 * The most messages held ahead of the window: three of the transcript's pages. A reader who has not moved while more than
 * this left the window is not reading, and all of it goes then, so what a transcript draws does not grow with how long its
 * room stays open.
 */
export const HELD_MESSAGES_MAX = 240

const NO_WORK: readonly AgentActivity[] = []

/**
 * The window to draw for `source`, given the one drawn `last`. While `reading` (the reader is above the end), the messages
 * drawn last time that come before the first message of main's window stay ahead of it, with the work of their turns.
 * They are let go once the reader is back at the end, when the thread or its history epoch changes, when more than
 * `HELD_MESSAGES_MAX` are held, and when the window no longer meets what was drawn: widened past it by Show earlier
 * messages, or moved on past all of it, where holding would leave a gap that reads as one conversation.
 */
export function readingWindow(last: ReadingWindow | null, source: AgentThread, reading: boolean): ReadingWindow {
  if (last !== null && last.source === source && (reading || last.held === 0)) return last
  const unheld: ReadingWindow = { source, thread: source, held: 0, work: NO_WORK }
  if (!reading || last === null || last.source.id !== source.id || last.source.historyEpoch !== source.historyEpoch) return unheld
  const drawn = last.thread.messages
  const first = source.messages[0]
  if (first === undefined) return unheld
  // Where main's window now begins among the messages drawn: where it began, unless it moved.
  const at = drawn[last.held]?.id === first.id ? last.held : drawn.findIndex(message => message.id === first.id)
  if (at <= 0 || at > HELD_MESSAGES_MAX) return unheld
  const work = heldWork(last, source)
  // A chunk of the newest reply changes neither list of work, so the turns above keep the records they were drawn from.
  const activities = work === last.work && source.activities === last.source.activities ? last.thread.activities
    : work.length > 0 ? [...work, ...source.activities ?? []] : source.activities
  const { earlierAvailable, activities: own, ...rest } = source
  void earlierAvailable; void own
  return { source, held: at, work, thread: { ...rest, messages: [...drawn.slice(0, at), ...source.messages], ...(activities === undefined ? {} : { activities }),
    // What stood above the oldest message held still stands above it.
    ...(last.thread.earlierAvailable === true ? { earlierAvailable: true } : {}) } }
}

/**
 * The work held ahead of main's window once `source` arrives: what was held, less the turns the window holds again, and
 * the records main gave last time for turns it no longer names. Only a turn that has ended and came before everything
 * main still gives is one the window let go; a running turn's records that went are not kept, so no working line outlives
 * its turn.
 */
function heldWork(last: ReadingWindow, source: AgentThread): readonly AgentActivity[] {
  if (source.activities === last.source.activities) return last.work
  const given = source.activities ?? []
  const before = last.source.activities ?? []
  if (last.work.length === 0 && before.length === 0) return NO_WORK
  const turns = new Set<string>()
  let oldest = Number.POSITIVE_INFINITY
  for (const record of given) { turns.add(record.turnId); if (record.sequence < oldest) oldest = record.sequence }
  const running = new Set<string>()
  for (const record of before) if (record.status === 'running') running.add(record.turnId)
  const gone = before.filter(record => !turns.has(record.turnId) && !running.has(record.turnId) && record.sequence < oldest)
  const kept = last.work.some(record => turns.has(record.turnId)) ? last.work.filter(record => !turns.has(record.turnId)) : last.work
  return gone.length === 0 ? kept : [...kept, ...gone]
}
