import { useEffect, useMemo, useState } from 'react'
import type { AgentThreadPrompt } from '../../../shared/threadPrompts'

interface Held {
  readonly threadId: string
  readonly epoch: string | undefined
  /** The window's first message when the store was read: the prompts are the ones before it. */
  readonly before: string
  readonly prompts: readonly AgentThreadPrompt[]
}
const NONE: readonly AgentThreadPrompt[] = []

/**
 * The prompts the thread's store holds above the window a pane has, for the message scrubber (ADR-0109). They are read
 * when the pane opens on a thread with earlier messages, and again only when its window starts somewhere the last read
 * does not reach: a window that widens into what was read needs no read, and the window's own ticks take over the
 * messages it loaded. Until a read answers, the last one stands, so the scrubber neither empties nor jumps while
 * messages load. A rewind or a reset starts the thread's history again, and what was read of it goes.
 */
export function useStoredPrompts(threadId: string, firstMessageId: string | undefined, earlier: boolean, epoch: string | undefined, enabled: boolean): readonly AgentThreadPrompt[] {
  const [held, setHeld] = useState<Held | null>(null)
  const current = held !== null && held.threadId === threadId && held.epoch === epoch ? held : null
  const ids = useMemo(() => new Set(current?.prompts.map(prompt => prompt.id)), [current])
  const covered = current !== null && firstMessageId !== undefined && (current.before === firstMessageId || ids.has(firstMessageId))
  const read = enabled && earlier && firstMessageId !== undefined && !covered
  useEffect(() => {
    const ask = window.sotto?.agents?.threadPrompts
    if (!read || firstMessageId === undefined || !ask) return
    let live = true
    // A host that cannot say leaves the ticks the window has; a failed read is tried again when the window next moves.
    ask({ threadId, beforeMessageId: firstMessageId })
      .then(result => { if (live && result) setHeld({ threadId, epoch, before: firstMessageId, prompts: result.prompts }) }, () => undefined)
    return () => { live = false }
  }, [read, threadId, firstMessageId, epoch])
  return enabled && current !== null ? current.prompts : NONE
}
