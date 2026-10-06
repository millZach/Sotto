import { z } from 'zod'

import { phonesStateSchema, type HostPhonesCommand } from '../../shared/phones'
import type { HostPhonesView } from '../../shared/hosts'
import type { PressConnection } from './adminConnection'
import { isTailscaleApprovalUrl } from './tailscaleApproval'

/**
 * Phones on a remote host (ADR-0050). Each connected host runs its own phone access, the desktop's own over its host
 * service, and this reads and changes it for the Hosts page's Phones dialog: through the host's administrative routes
 * on the port an SSH connection forwards, with the host's administrative token, which that connection's launch handed
 * back. The token stays with the connection: each request asks the connection for it, and nothing here keeps it. The
 * connection is the SSH connection the host is on, or its admin connection (ADR-0053). Every SSH command is a full
 * sign-in, so nothing here runs one, and only the dialog's reads and presses may open an admin connection.
 *
 * A host is read once when it connects, so its row can say whether phones reach it, and again every couple of seconds
 * while it is still setting up, or while the dialog is open, so a phone pairing or connecting shows up there. A read
 * nobody asked for goes only over a connection already open, so it never signs in. Nothing else is read for a host
 * nobody is looking at. What a host last said stays when it disconnects; the dialog says it cannot change anything then.
 */

/** A saved host, while it is connected. */
export interface HostPhonesLink {
  readonly id: string
  readonly name: string
  /** The host's own ID, which every answer must carry. */
  readonly hostId: string
  /** Which connect the host is on now: a new one is read afresh. */
  readonly generation: number
  /**
   * Runs one request over what a press goes over: the SSH connection the host is on, or its admin connection, opened for
   * the request when it is not open (ADR-0053). The connection stays open until the request ends.
   */
  press<T>(request: (connection: PressConnection) => Promise<T>): Promise<T>
  /** The same, over a connection already open, opening none: undefined when there is none. */
  pressIfOpen<T>(request: (connection: PressConnection) => Promise<T>): Promise<T | undefined>
}
export interface HostPhonesHosts {
  /** Every saved host connected now. */
  links(): HostPhonesLink[]
  subscribe(listener: () => void): () => void
}
export interface HostPhonesOptions {
  readonly hosts: HostPhonesHosts
  /** Opens Tailscale's page for turning Serve on, on this computer, on the user's press. */
  readonly openExternal: (url: string) => Promise<void>
  readonly fetch?: typeof fetch
  /** How often an open dialog reads its host again. */
  readonly pollMs?: number
  /** Stable event names only. */
  readonly log?: (event: 'host-phones-read-failed' | 'host-phones-command-failed') => void
}

const answerSchema = z.object({
  v: z.literal(1), hostId: z.uuid(), state: phonesStateSchema,
  url: z.string().max(2100).optional(), error: z.string().max(1000).optional(),
})
type Answer = z.infer<typeof answerSchema>

/** A read can wait on nothing slow; a command can wait on Tailscale, whose own calls time out after 20 seconds. */
const READ_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 45_000
const POLL_MS = 2_000
/** An open dialog says so again well inside this, so a window that went away without closing it stops the reads. */
export const HOST_PHONES_WATCH_MS = 60_000

/** The host answered, but not with phone access: it has no such route, or answered with something else. */
class HostRefused extends Error {}

interface Entry {
  view: HostPhonesView
  /** The connect the view came from; a new one is read afresh. */
  generation?: number | undefined
  reading?: Promise<void> | undefined
  /** Until when an open dialog wants this host read again and again. */
  watchUntil: number
  timer?: ReturnType<typeof setInterval> | undefined
  /** Commands go one at a time, so a read never lands between a command and the state it answered with. */
  commands: Promise<unknown>
}

export class HostPhones {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly off: () => void
  private closed = false

  constructor(private readonly options: HostPhonesOptions) {
    this.off = options.hosts.subscribe(() => this.sync())
    this.sync()
  }

  state(): HostPhonesView[] { return [...this.entries.values()].map(entry => entry.view) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  /**
   * The dialog is open (true, said again every half minute while it stays open) or closed (false) for this host. While
   * it is open the host is read every couple of seconds; a watch not renewed in a minute ends by itself.
   */
  watch(id: string, watching: boolean): void {
    const entry = this.entry(id)
    entry.watchUntil = watching ? Date.now() + HOST_PHONES_WATCH_MS : 0
    if (!watching) { this.stopWatching(entry); return }
    if (entry.generation !== undefined) void this.read(id, true)
    if (entry.timer) return
    entry.timer = setInterval(() => {
      if (Date.now() > entry.watchUntil) this.stopWatching(entry)
      else if (entry.generation !== undefined) void this.read(id, true)
    }, this.options.pollMs ?? POLL_MS)
    entry.timer.unref?.()
  }

  private stopWatching(entry: Entry): void { if (entry.timer) clearInterval(entry.timer); entry.timer = undefined }

  /** One press in the dialog. A refusal throws its sentence; the state the host answered with is shown either way. */
  async command(id: string, command: HostPhonesCommand): Promise<void> {
    const entry = this.entries.get(id), link = this.link(id)
    if (!entry || !link) throw new Error('This host is not connected, so its phone access cannot be changed. Nothing was changed. Connect it, then try again.')
    const run = entry.commands.then(async () => {
      this.set(id, { busy: true })
      let answer: Answer
      try { answer = await link.press(connection => this.post(connection, link, 'phones-command', { command }, COMMAND_TIMEOUT_MS)) }
      catch (error) {
        this.options.log?.('host-phones-command-failed')
        this.set(id, { busy: false })
        throw new Error(this.failure(link.name, error), { cause: error })
      }
      this.set(id, { busy: false, state: answer.state, error: undefined, readAt: new Date().toISOString() })
      if (answer.error) throw new Error(answer.error)
      if (command.type === 'open-serve-setup') {
        if (!answer.url || !isTailscaleApprovalUrl(answer.url)) throw new Error('Tailscale did not give a page to open. Open the Tailscale admin console to turn on Serve.')
        await this.options.openExternal(answer.url)
      }
    })
    entry.commands = run.catch(() => undefined)
    await run
  }

  close(): void {
    this.closed = true
    this.off()
    for (const entry of this.entries.values()) if (entry.timer) clearInterval(entry.timer)
  }

  /** Follows the connected hosts: a new connection is read once, and a dropped one keeps what it last said. */
  private sync(): void {
    if (this.closed) return
    const links = this.options.hosts.links()
    for (const link of links) {
      const entry = this.entry(link.id)
      if (entry.generation === link.generation) continue
      entry.generation = link.generation
      void this.read(link.id, false)
    }
    for (const [id, entry] of this.entries) {
      if (links.some(link => link.id === id)) continue
      // Disconnected: keep what it last said, and the open dialog's watch, for when it connects again.
      entry.generation = undefined
    }
  }

  /** Reads a host's phone access. Only a read the dialog asked for (`open`) may open an admin connection for it. */
  private async read(id: string, open: boolean): Promise<void> {
    const entry = this.entries.get(id), link = this.link(id)
    if (!entry || !link || entry.reading) return entry?.reading
    entry.reading = (async () => {
      await entry.commands
      try {
        const request = (connection: PressConnection): Promise<Answer> => this.post(connection, link, 'phones', {}, READ_TIMEOUT_MS)
        const answer = open ? await link.press(request) : await link.pressIfOpen(request)
        if (!answer || entry.generation !== link.generation) return
        this.set(id, { state: answer.state, error: undefined, readAt: new Date().toISOString() })
        // A host that has just started is still checking Tailscale: read it again until it says how that went, so the
        // row does not keep saying it is starting.
        if (answer.state.phase === 'starting' && !entry.timer) setTimeout(() => { if (!this.closed && entry.generation === link.generation) void this.read(id, false) }, this.options.pollMs ?? POLL_MS).unref?.()
      } catch (error) {
        this.options.log?.('host-phones-read-failed')
        if (entry.generation === link.generation) this.set(id, { error: this.failure(link.name, error) })
      }
    })().finally(() => { entry.reading = undefined })
    return entry.reading
  }

  /** One administrative request over a connection, asking it for its token again once if the host does not take it. */
  private async post(connection: PressConnection, link: HostPhonesLink, route: 'phones' | 'phones-command', body: unknown, timeoutMs: number, again = true): Promise<Answer> {
    const token = await connection.hostAdminToken()
    const response = await (this.options.fetch ?? fetch)(`${connection.url}/v1/admin/${route}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401) {
      if (again) return this.post(connection, link, route, body, timeoutMs, false)
      throw new Error('The host refused the administrative token.')
    }
    if (!response.ok) throw new HostRefused('The host refused the request.')
    const parsed = answerSchema.safeParse(await response.json())
    if (!parsed.success) throw new HostRefused('The host answered with something else.')
    const answer = parsed.data
    if (answer.hostId !== link.hostId) throw new Error('The host identity changed.')
    return answer
  }

  private failure(name: string, error: unknown): string {
    if (error instanceof Error && error.name === 'TimeoutError') return `${name} did not answer about phone access in time. Nothing was changed. Try again.`
    if (error instanceof HostRefused) {
      return `The host on ${name} can’t share phone access with this computer. Nothing was changed. Update the host on ${name} from the Threads page, then try again.`
    }
    return `Phone access on ${name} could not be reached. Nothing was changed. Check that ${name} is connected, then try again.`
  }

  private link(id: string): HostPhonesLink | undefined { return this.options.hosts.links().find(link => link.id === id) }

  private entry(id: string): Entry {
    let entry = this.entries.get(id)
    if (!entry) { entry = { view: { id }, watchUntil: 0, commands: Promise.resolve() }; this.entries.set(id, entry) }
    return entry
  }

  private set(id: string, patch: Partial<Omit<HostPhonesView, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const view: HostPhonesView = { ...entry.view, ...patch }
    for (const key of Object.keys(view) as (keyof HostPhonesView)[]) if (view[key] === undefined) delete view[key]
    entry.view = view
    for (const listener of this.listeners) listener()
  }
}
