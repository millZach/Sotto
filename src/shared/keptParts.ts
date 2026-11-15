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
