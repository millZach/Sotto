import { createContext, useContext, useEffect, useState } from 'react'

/**
 * A thread pane's reply box, as a picture marked up in that pane reaches it (ADR-0170, part 5): the marked copy goes in
 * the way a pasted screenshot does, through the box's own checks and staging.
 */
export interface ReplyAttach {
  /** Why the box can't take a picture now, or null when it can. */
  readonly refusal: () => string | null
  /** Adds the files as a paste would. Resolves to why nothing was added, or null once they are in the draft. */
  readonly add: (files: readonly File[]) => Promise<string | null>
  /** Puts the focus in the box, for once the marked copy is in. */
  readonly focus: () => void
}

/** The pane's slot, which its reply box fills while it is drawn. */
export interface ReplyAttachSlot { current: ReplyAttach | null }

export const ReplyAttachContext = createContext<ReplyAttachSlot | null>(null)

/** A pane's own slot, made once. */
export function useReplyAttachSlot(): ReplyAttachSlot {
  const [slot] = useState<ReplyAttachSlot>(() => ({ current: null }))
  return slot
}

/** The slot of the pane this sits in, or null outside a thread pane, where a marked copy has no reply to go to. */
export function useReplyAttach(): ReplyAttachSlot | null { return useContext(ReplyAttachContext) }

/** Fills the pane's slot with this reply box while it is drawn. `attach` is read when used, so it may change each render. */
export function useRegisterReplyAttach(attach: { readonly current: ReplyAttach }): void {
  const slot = useContext(ReplyAttachContext)
  useEffect(() => {
    if (!slot) return
    const entry: ReplyAttach = { refusal: () => attach.current.refusal(), add: files => attach.current.add(files), focus: () => attach.current.focus() }
    slot.current = entry
    return () => { if (slot.current === entry) slot.current = null }
  }, [slot, attach])
}
