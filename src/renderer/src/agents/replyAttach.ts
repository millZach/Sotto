import { createContext, useContext, useEffect, useRef, useState } from 'react'

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

/** Fills the pane's slot with this reply box while it is drawn. `attach` updates within `scope`, while a prior `scope`'s entry stays bound to its own target. */
export function useRegisterReplyAttach(attach: { readonly current: ReplyAttach }, registers = true, scope?: unknown): void {
  const slot = useContext(ReplyAttachContext)
  const scoped = useRef<{ scope: unknown; reply: ReplyAttach }>({ scope, reply: attach.current })
  if (scoped.current.scope === scope) scoped.current.reply = attach.current
  else scoped.current = { scope, reply: attach.current }
  useEffect(() => {
    if (!slot || !registers) return
    const record = scoped.current
    const entry: ReplyAttach = {
      refusal: () => record.reply.refusal(),
      add: files => record.reply.add(files),
      focus: () => record.reply.focus(),
    }
    slot.current = entry
    return () => { if (slot.current === entry) slot.current = null }
  }, [slot, registers, scope])
}
