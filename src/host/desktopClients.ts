import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from '../main/storage/atomicJsonStore'
import { DESKTOP_CLIENTS_FILE, DESKTOP_CLIENTS_MAX, DESKTOP_CLIENT_ID_MAX } from '../shared/desktopClients'

const listSchema = z.array(z.string().min(1).max(DESKTOP_CLIENT_ID_MAX)).max(DESKTOP_CLIENTS_MAX)

/**
 * The paired clients that are desktops (ADR-0053). Only the launch script, over the owner's SSH session, adds one: at
 * the step that confirms a desktop's paired client ID and writes its default grant. A client never names itself. On the
 * tailnet listener every client not here is a phone, and a file that cannot be read counts nobody as a desktop. The host
 * itself only takes a client out, when it is revoked.
 *
 * The launch script writes the file while the host runs, so it is read again before each session and hello; `has` answers
 * from the last read.
 */
export class DesktopClients {
  private ids: ReadonlySet<string> = new Set()
  private readonly store: AtomicJsonStore<string[]>
  private readonly path: string

  constructor(directory: string, private readonly log?: (event: 'desktop-clients-unreadable' | 'desktop-clients-write-failed') => void) {
    this.path = join(directory, DESKTOP_CLIENTS_FILE)
    this.store = new AtomicJsonStore(this.path, listSchema.parse, () => [])
  }

  has(clientId: string): boolean { return this.ids.has(clientId) }

  /** Reads the file again. Missing is nobody; unreadable is nobody too, and says so in the log. */
  async refresh(): Promise<ReadonlySet<string>> {
    this.ids = new Set(await this.read() ?? [])
    return this.ids
  }

  /**
   * Takes a revoked client out. Answers the desktops left when it was one, and nothing when it was not or the file cannot
   * be read, which is then left as it is.
   */
  async remove(clientId: string): Promise<ReadonlySet<string> | undefined> {
    const current = await this.read()
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
}
