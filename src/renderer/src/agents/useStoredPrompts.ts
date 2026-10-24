import { useEffect, useMemo, useState } from 'react'
import { THREAD_PROMPTS_MOST, type AgentThreadPrompt } from '../../../shared/threadPrompts'

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
 * messages it loaded. A store answers its newest prompts a page at a time, so pages are read back to the first. Until a
 * read answers, the last one stands, and `reading` says one is on its way, so the scrubber neither empties nor jumps
 * while messages load. A rewind, a reset, or a history that has lost messages starts it again; a read that fails is tried
 * again a few times.
 */
export function useStoredPrompts(threadId: string, firstMessageId: string | undefined, earlier: boolean, epoch: string | undefined, count: number | undefined, enabled: boolean): { readonly prompts: readonly AgentThreadPrompt[]; readonly reading: boolean } {
  const [held, setHeld] = useState<Held | null>(null)
  const [failures, setFailures] = useState({ key: '', count: 0 })
  const current = held !== null && held.threadId === threadId && held.epoch === epoch && !(held.count !== undefined && count !== undefined && count < held.count) ? held : null
  const ids = useMemo(() => new Set(current?.prompts.map(prompt => prompt.id)), [current])
  const covered = current !== null && firstMessageId !== undefined && (current.before === firstMessageId || ids.has(firstMessageId))
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
      let before = firstMessageId
      for (;;) {
        const page = await ask({ threadId, beforeMessageId: before })
        if (!live) return
        // A host that cannot say leaves the ticks the window has, until a later try.
        if (!page) { failed(); return }
        prompts = [...page.prompts, ...prompts]
        if (page.prompts.length < THREAD_PROMPTS_MOST) break
        before = page.prompts[0]!.id
      }
      setHeld({ threadId, epoch, before: firstMessageId, count, prompts })
    })().catch(failed)
    return () => { live = false; window.clearTimeout(timer) }
  }, [read, threadId, firstMessageId, epoch, tries, key])
  return { prompts: enabled && current !== null ? current.prompts : NONE, reading: read && tries <= RETRIES }
}
