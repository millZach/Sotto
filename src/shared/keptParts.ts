/**
 * Putting a shell's **kept parts** back (CONTEXT.md, ADR-0028's October 30 and November 10 amendments). A shell sent by
 * change leaves out each part, at its top and in its `host`, that holds what the shell its thread records are measured
 * from held, and names it in `kept` and `host.kept`. Main's broadcasts to the window are made so (`withKeptParts` in
 * `agentStateBroadcast.ts`), and so are a host's shell pushes to a socket client that accepted `kept-parts`. The window's
 * page and the desktop's client of a paired host put the parts back here; the iPhone ports it (`KeptPartsCache`).
 */

/** A shell's parts, by reference: its top-level fields and its `host`'s, as that shell had them. */
export interface KeptPartsBase {
  readonly top: Readonly<Record<string, unknown>>
  readonly host: Readonly<Record<string, unknown>>
}
/**
 * The parts of the last shell one side sent or applied, under the revision of that shell's thread records: what the next
 * shell's kept parts are measured from by the sender and put back from by the receiver.
 */
export interface HeldParts extends KeptPartsBase { readonly revision: number }


/** `Whole` as sent with its kept parts left out: any part may be absent, and those left out are named at its top and in `host`. */
export type KeptPartsShell<Whole extends { readonly host: object }> = Partial<Omit<Whole, 'host'>> & { kept?: string[]; host: Partial<Whole['host']> & { kept?: string[] } }

/**
 * `wire` with each part it names as kept put back from `held`, so every reader meets a whole shell and a part that did not
 * change is the very object held. `base` is the revision `wire`'s thread records are measured from. A shell that kept
 * nothing is `wire` itself. Undefined, changing nothing, when it kept parts measured from another shell than the one
 * held, or names a part that shell did not have: the receiver then reads the shell whole.
 */
export function withKeptPartsPutBack<Whole>(wire: { readonly kept?: unknown; readonly host: object }, base: unknown, held: HeldParts | null): Whole | undefined {
  const named = (value: unknown): unknown[] => Array.isArray(value) ? value as unknown[] : []
  const kept = named(wire.kept), hostKept = named((wire.host as { kept?: unknown }).kept)
  // The sender sends every part not named as kept; a checked base supplies the rest.
  if (!kept.length && !hostKept.length) return wire as Whole
  if (held === null || base !== held.revision) return undefined
  const names = (list: unknown[], from: Readonly<Record<string, unknown>>): list is string[] => list.every(key => typeof key === 'string' && Object.hasOwn(from, key))
  if (!names(kept, held.top) || !names(hostKept, held.host)) return undefined
  const { kept: _kept, ...top } = wire as Record<string, unknown>
  const { kept: _hostKept, ...host } = wire.host as Record<string, unknown>
  void _kept; void _hostKept
  // What the shell carries is never replaced: only a part it left out is put back.
  for (const key of kept) if (!Object.hasOwn(top, key)) top[key] = held.top[key]
  for (const key of hostKept) if (!Object.hasOwn(host, key)) host[key] = held.host[key]
  return { ...top, host } as Whole
}

/** A Watcher conversation message on the phone wire (`WatcherPhoneState['conversation']['messages'][number]`). */
export interface WatcherConversationMessage {
  readonly id: string
  readonly role: string
  readonly text: string
  readonly createdAt: string
  readonly attachments?: readonly unknown[] | undefined
}
/**
 * What changed in Watcher's conversation since the last shell push (`watcher-phone-parts`, ADR-0025): drop `dropHead`
 * oldest messages (e.g. when the 200-message window slides), keep the next `keep` messages, optionally append
 * `appendLastText` onto the last kept message, and append `tail`.
 */
export interface WatcherConversationDelta {
  readonly dropHead: number
  readonly keep: number
  readonly appendLastText?: string | undefined
  readonly tail: readonly WatcherConversationMessage[]
  readonly earlierAvailable: boolean
  readonly revision: number
}
/** A Watcher phone page with unchanged sub-parts left out (`kept`) and/or `conversation` replaced by `conversationDelta`. */
export type WatcherPhoneWireParts<Page extends { readonly conversation: { readonly messages: readonly WatcherConversationMessage[]; readonly earlierAvailable: boolean; readonly revision: number } } = { readonly conversation: { readonly messages: readonly WatcherConversationMessage[]; readonly earlierAvailable: boolean; readonly revision: number } }> =
  Partial<Page> & { readonly kept?: string[] | undefined; readonly conversationDelta?: WatcherConversationDelta | undefined }

/**
 * Reconstructs a complete Watcher phone page from a compact `watcher-phone-parts` wire object and the previous pushed
 * page `held`. Returns `undefined` if any kept field is missing from `held` or if `conversationDelta` is out of bounds or
 * conflicts with `conversation` / `kept`.
 */
export function withWatcherPhonePartsPutBack<
  Page extends { readonly conversation: { readonly messages: readonly WatcherConversationMessage[]; readonly earlierAvailable: boolean; readonly revision: number } },
>(wire: WatcherPhoneWireParts<Page>, held: Page | null): Page | undefined {
  const kept = Array.isArray(wire.kept) ? wire.kept : []
  const delta = wire.conversationDelta
  if (!kept.length && delta === undefined) return wire as Page
  if (held === null) return undefined
  const heldRecord = held as unknown as Readonly<Record<string, unknown>>
  const wireRecord = wire as unknown as Readonly<Record<string, unknown>>
  if (!kept.every(key => typeof key === 'string' && key !== 'kept' && key !== 'conversationDelta' && Object.hasOwn(heldRecord, key))) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(wireRecord)) {
    if (key === 'kept' || key === 'conversationDelta') continue
    out[key] = value
  }
  for (const key of kept) if (!Object.hasOwn(out, key)) out[key] = heldRecord[key]
  if (delta !== undefined) {
    if (Object.hasOwn(wireRecord, 'conversation') || kept.includes('conversation')) return undefined
    const prev = held.conversation.messages
    if (!Number.isSafeInteger(delta.dropHead) || !Number.isSafeInteger(delta.keep) || delta.dropHead < 0 || delta.keep < 0 || delta.dropHead > prev.length || delta.keep > prev.length - delta.dropHead) return undefined
    if (delta.appendLastText !== undefined && delta.keep === 0) return undefined
    const messages = prev.slice(delta.dropHead, delta.dropHead + delta.keep)
    if (delta.appendLastText !== undefined) {
      const last = messages[messages.length - 1]!
      messages[messages.length - 1] = { ...last, text: last.text + delta.appendLastText }
    }
    messages.push(...delta.tail)
    out.conversation = { messages, earlierAvailable: delta.earlierAvailable, revision: delta.revision }
  }
  return out as unknown as Page
}
