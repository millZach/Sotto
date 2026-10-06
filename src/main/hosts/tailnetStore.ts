import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { isTailnetAddress, type HostConnectionPreference } from './hostConnectionPlan'

/**
 * What this computer keeps about reaching each saved host over its tailnet (ADR-0053, "What a saved host stores"), in
 * `remote-host-tailnet.json` beside `remote-hosts.json`, keyed by the saved host's ID. `remote-hosts.json` stays as it is,
 * since it is strict and an older Sotto would empty it on meeting a new key; an older Sotto ignores this file and keeps
 * connecting over SSH. A host with no entry prefers SSH. Fields a later Sotto adds, such as the start at boot state
 * (ADR-0054), are kept as they are.
 */
const entrySchema = z.looseObject({
  id: z.uuid(),
  prefer: z.enum(['tailnet', 'ssh']),
  /** The last tailnet address the host reported. One this build cannot accept reads as none. */
  address: z.string().max(300).refine(value => isTailnetAddress(value)).optional().catch(undefined),
  /** When this computer last reached the host at that address, in milliseconds since the epoch. */
  addressSeen: z.number().int().nonnegative().optional().catch(undefined),
})
export type TailnetEntry = z.infer<typeof entrySchema>
/** Saved hosts are at most 20; the file allows room for entries a later Sotto keeps for hosts it forgot. */
const fileSchema = z.array(entrySchema).max(100)

export const TAILNET_STORE_FILE = 'remote-host-tailnet.json'

export class TailnetStore {
  private readonly store: AtomicJsonStore<TailnetEntry[]>
  private entries: TailnetEntry[] = []
  private writing: Promise<void> = Promise.resolve()

  constructor(directory: string) {
    this.store = new AtomicJsonStore(join(directory, TAILNET_STORE_FILE), fileSchema.parse, () => [])
  }

  async load(): Promise<void> { this.entries = await this.store.read() }

  /** A saved host's entry. No entry means SSH, as for a host saved before tailnet connections. */
  get(id: string): { readonly prefer: HostConnectionPreference; readonly address?: string | undefined; readonly addressSeen?: number | undefined } {
    return this.entries.find(entry => entry.id === id) ?? { prefer: 'ssh' }
  }

  /** Changes a host's entry, making one when it has none, and writes the file. */
  set(id: string, patch: Partial<Omit<TailnetEntry, 'id'>>): Promise<void> {
    const current = this.entries.find(entry => entry.id === id)
    const next: TailnetEntry = { ...(current ?? { id, prefer: 'ssh' as const }), ...patch, id }
    for (const key of ['address', 'addressSeen'] as const) if (next[key] === undefined) delete next[key]
    this.entries = [...this.entries.filter(entry => entry.id !== id), next]
    return this.write()
  }

  /** Forget: the entry goes with the saved host. */
  delete(id: string): Promise<void> {
    if (!this.entries.some(entry => entry.id === id)) return Promise.resolve()
    this.entries = this.entries.filter(entry => entry.id !== id)
    return this.write()
  }

  /** Waits for every write so far. */
  flush(): Promise<void> { return this.writing }

  private write(): Promise<void> {
    const value = structuredClone(this.entries)
    const pending = this.writing.then(() => this.store.write(value))
    this.writing = pending.catch(() => undefined)
    return pending
  }
}
