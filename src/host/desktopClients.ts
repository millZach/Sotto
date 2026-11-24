import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from '../main/storage/atomicJsonStore'
import { DESKTOP_CLIENTS_FILE, DESKTOP_CLIENTS_MAX, DESKTOP_CLIENT_ID_MAX, DESKTOP_IDENTITIES_FILE } from '../shared/desktopClients'

const listSchema = z.array(z.string().min(1).max(DESKTOP_CLIENT_ID_MAX)).max(DESKTOP_CLIENTS_MAX)
const identitiesSchema = z.object({
  version: z.literal(1),
  desktops: z.record(z.string().min(1).max(DESKTOP_CLIENT_ID_MAX), z.uuid()),
}).strict().refine(value => Object.keys(value.desktops).length <= DESKTOP_CLIENTS_MAX)
type DesktopIdentitiesFile = z.infer<typeof identitiesSchema>

/**
 * The paired clients that are desktops (ADR-0053). Only the launch script, over the owner's SSH session, adds one: at
 * the step that confirms a desktop's paired client ID and writes its default grant. A client never names itself. On the
 * tailnet listener every client not here is a phone, and a file that cannot be read counts nobody as a desktop. The host
 * itself only takes a client out, when it is revoked.
 *
 * The launch script also writes `desktop-identities.json` with each desktop's persistent `desktopHostId` (#2863), so a
 * re-paired desktop can safely migrate its Watcher assignments without weakening cross-desktop isolation. A missing or
 * unreadable identities file fails closed to no bindings (strict `clientId` matching only).
 *
 * The launch script writes both files while the host runs, so they are read again before each session, hello and Watcher
 * call; `has` and `hostIdOf` answer from the last read.
 */
export class DesktopClients {
  private ids: ReadonlySet<string> = new Set()
  private hostIds: ReadonlyMap<string, string> = new Map()
  private readonly store: AtomicJsonStore<string[]>
  private readonly identitiesStore: AtomicJsonStore<DesktopIdentitiesFile>
  private readonly path: string
  private readonly identitiesPath: string

  constructor(directory: string, private readonly log?: (event: 'desktop-clients-unreadable' | 'desktop-clients-write-failed') => void) {
    this.path = join(directory, DESKTOP_CLIENTS_FILE)
    this.identitiesPath = join(directory, DESKTOP_IDENTITIES_FILE)
    this.store = new AtomicJsonStore(this.path, listSchema.parse, () => [])
    this.identitiesStore = new AtomicJsonStore(this.identitiesPath, identitiesSchema.parse, () => ({ version: 1, desktops: {} }))
  }

  has(clientId: string): boolean { return this.ids.has(clientId) }

  /** The SSH-recorded desktop `hostId` bound to `clientId`, or undefined when none is recorded. */
  hostIdOf(clientId: string): string | undefined { return this.hostIds.get(clientId) }

  /** Reads both files again. Missing is nobody; unreadable is nobody too, and says so in the log. */
  async refresh(): Promise<ReadonlySet<string>> {
    const [ids, identities] = await Promise.all([this.read(), this.readIdentities()])
    this.ids = new Set(ids ?? [])
    this.hostIds = new Map(Object.entries(identities?.desktops ?? {}))
    return this.ids
  }

  /**
   * Takes a revoked client out. Answers the desktops left when it was one, and nothing when it was not or the file cannot
   * be read, which is then left as it is.
   */
  async remove(clientId: string): Promise<ReadonlySet<string> | undefined> {
    const [current, identities] = await Promise.all([this.read(), this.readIdentities()])
    if (identities && Object.hasOwn(identities.desktops, clientId)) {
      const nextDesktops = { ...identities.desktops }
      delete nextDesktops[clientId]
      this.hostIds = new Map(Object.entries(nextDesktops))
      try { await this.identitiesStore.write({ version: 1, desktops: nextDesktops }) } catch { this.log?.('desktop-clients-write-failed') }
    } else {
      this.hostIds = new Map(Object.entries(identities?.desktops ?? {}))
    }
    if (current === undefined) { this.ids = new Set(); return undefined }
    const left = current.filter(id => id !== clientId)
    this.ids = new Set(left)
    if (left.length === current.length) return undefined
    try { await this.store.write(left) } catch { this.log?.('desktop-clients-write-failed') }
    return this.ids
  }

  private async read(): Promise<string[] | undefined> {
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      this.log?.('desktop-clients-unreadable'); return undefined
    }
    try { return listSchema.parse(JSON.parse(text)) } catch { this.log?.('desktop-clients-unreadable'); return undefined }
  }

  private async readIdentities(): Promise<DesktopIdentitiesFile | undefined> {
    let text: string
    try { text = await readFile(this.identitiesPath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, desktops: {} }
      this.log?.('desktop-clients-unreadable'); return undefined
    }
    try { return identitiesSchema.parse(JSON.parse(text)) } catch { this.log?.('desktop-clients-unreadable'); return undefined }
  }
}
