import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentThreadPrompt } from '../../../shared/threadPrompts'
import type { ScrubberMark } from './messageScrubberMarks'

interface Held {
  readonly threadId: string
  readonly epoch: string | undefined
  /** The window's first message when the store was read: the prompts are the ones before it. */
  readonly before: string
  /** How many messages the thread had then, when it said. A history that has since lost some was reset, and is read again. */
  readonly count: number | undefined
  readonly prompts: readonly AgentThreadPrompt[]
}
const NONE: readonly AgentThreadPrompt[] = []
/** How long a read that failed waits before it is tried again, and how many times it is. */
const RETRY_MS = 4_000
const RETRIES = 3

/**
 * The prompts the thread's store holds above the window a pane has, for the message scrubber (ADR-0109). They are read
 * when the pane opens on a thread with earlier messages, and again only when its window starts somewhere the last read
 * does not reach: a window that widens into what was read needs no read, and the window's own ticks take over the
 * messages it loaded; one that slides down to newer turns, or narrows, starts on a message it held since the read, and
 * `useSlidMarks` keeps the ticks of the turns it let go. A store answers its newest prompts a page at a time, so pages
 * are read back to the first. Until a
 * read answers, the last one stands, and `reading` says one is on its way, so the scrubber neither empties nor jumps
 * while messages load. A rewind, a reset, or a history that has lost messages starts it again; a read that fails is tried
 * again a few times.
 */
export function useStoredPrompts(threadId: string, firstMessageId: string | undefined, windowIds: readonly string[], earlier: boolean, epoch: string | undefined, count: number | undefined, enabled: boolean): { readonly prompts: readonly AgentThreadPrompt[]; readonly reading: boolean } {
  const [held, setHeld] = useState<Held | null>(null)
  const [failures, setFailures] = useState({ key: '', count: 0 })
  const current = held !== null && held.threadId === threadId && held.epoch === epoch && !(held.count !== undefined && count !== undefined && count < held.count) ? held : null
  const ids = useMemo(() => new Set(current?.prompts.map(prompt => prompt.id)), [current])
  // The messages sent that an earlier window held since the read: a window starting on one of them is still reached by
  // it. The window drawn now is added after it is asked about, so a window that starts somewhere new is read for.
  const sinceRead = useRef<{ readonly read: Held | null; readonly ids: Set<string> }>({ read: null, ids: new Set() })
  if (sinceRead.current.read !== current) sinceRead.current = { read: current, ids: new Set() }
  const covered = current !== null && firstMessageId !== undefined && (current.before === firstMessageId || ids.has(firstMessageId) || sinceRead.current.ids.has(firstMessageId))
  if (covered) for (const id of windowIds) sinceRead.current.ids.add(id)
  const read = enabled && earlier && firstMessageId !== undefined && !covered
  const key = `${threadId}\n${epoch ?? ''}\n${firstMessageId ?? ''}`
  const tries = failures.key === key ? failures.count : 0
  useEffect(() => {
    const ask = window.sotto?.agents?.threadPrompts
    if (!read || firstMessageId === undefined || !ask || tries > RETRIES) return
    let live = true
    let timer = 0
    const failed = (): void => { if (live) timer = window.setTimeout(() => setFailures({ key, count: tries + 1 }), RETRY_MS) }
    void (async () => {
      let prompts: readonly AgentThreadPrompt[] = []
      let before: string | undefined = firstMessageId
      while (before !== undefined) {
        const page = await ask({ threadId, beforeMessageId: before })
        if (!live) return
        // A host that cannot say leaves the ticks the window has, until a later try.
        if (!page) { failed(); return }
        prompts = [...page.prompts, ...prompts]
        before = page.next
      }
      setHeld({ threadId, epoch, before: firstMessageId, count, prompts })
    })().catch(failed)
    return () => { live = false; window.clearTimeout(timer) }
  }, [read, threadId, firstMessageId, epoch, tries, key])
  return { prompts: enabled && current !== null ? current.prompts : NONE, reading: read && tries <= RETRIES }
}

/**
 * The ticks of messages sent that the window held and has let go, as it does when a new turn slides it down to the newest
 * turns, or when it narrows as the pane comes back to the thread. They stand above the window until the store is read
 * again past them, so no tick goes while the window moves. A rewind or a reset, a window that keeps none of the last, or
 * another thread starts them again.
 */
export function useSlidMarks(key: string, window: readonly ScrubberMark[]): readonly ScrubberMark[] {
  const state = useRef<{ key: string; last: readonly ScrubberMark[]; slid: readonly ScrubberMark[] }>({ key, last: [], slid: [] })
  return useMemo(() => {
    if (state.current.key !== key) state.current = { key, last: [], slid: [] }
    const { last, slid } = state.current
    // A window emptied while its messages load again lets nothing go: the one before it is compared with the next.
    if (window.length === 0) return slid
    const now = new Set(window.map(mark => mark.messageId))
    // Only what leaves from the top while the rest stays slid out; a window that keeps none of the last is another history.
    const kept = last.findIndex(mark => now.has(mark.messageId))
    if (kept < 0 && last.length > 0) { state.current = { key, last: window, slid: [] }; return state.current.slid }
    const gone = last.slice(0, Math.max(0, kept))
    let next = slid
    if (gone.length) {
      const goneIds = new Set(gone.map(mark => mark.messageId))
      next = [...slid.filter(mark => !goneIds.has(mark.messageId)), ...gone.map(mark => ({ ...mark, index: -1, newest: false }))]
        .sort((first, second) => first.message.createdAt < second.message.createdAt ? -1 : first.message.createdAt > second.message.createdAt ? 1 : 0)
    }
    state.current = { key, last: window, slid: next }
    return next
  }, [key, window])
}
