import { createHash } from 'node:crypto'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { SOUND_BYTES_MAX, SOUND_HOST_PART_BYTES, SOUND_HOST_PARTS_MAX, type HostSoundViews, type SoundView } from '../../shared/sounds'
import { looksLikeMp3 } from '../tools/elevenlabs/view'
import type { DesktopHostConnection } from './desktopHostRouter'

/**
 * A paired host's sounds on this computer (ADR-0205; the plugins plan's slice 12, part 4b): the window names each by a
 * key that says which host holds it, as it names a host's thread (`hostEntityKey`), and main asks that host by the host's
 * own ID, over the connection the host protocol gives it (`plugin-elevenlabs-sounds`). The window is handed views, names,
 * sizes and bytes, never a path, and nothing it sends reaches the host but a sound's ID and a place in its MP3.
 *
 * Each view heard is kept, at most `KEPT_VIEWS`, so a host thread's line can still say what its sound cost while the
 * host is away. A host's file is on the host, so nothing here shows one in the folder app.
 */

/** The most host views kept for a line while its host is away. */
const KEPT_VIEWS = 2_000

export interface HostSoundsOptions {
  /** The remote hosts connected now, read in place. */
  readonly connections: () => Iterable<DesktopHostConnection>
  /** Hears each host connection as the router takes it, new or in place of one it had. */
  readonly subscribeConnected: (listener: (connection: DesktopHostConnection) => void) => () => void
  /** Hears a host the router lets go, as on Disconnect or Forget. */
  readonly subscribeRemoved: (listener: (hostId: string) => void) => () => void
  /** This computer's own host ID, whose keys name this computer's own sounds. */
  readonly localHostId: () => string | undefined
  /** Tells the window a host's sound changed, by its key. */
  readonly changed: (view: SoundView) => void
}

export class HostSounds {
  private readonly kept = new Map<string, SoundView>()
  private readonly heard = new Map<string, () => void>()
  /** How many times each host was let go, so a read it was asked before then keeps nothing (Sol's review). */
  private readonly lettings = new Map<string, number>()
  /** How many views were kept for each key, so a read that answers after newer news keeps nothing of its own. */
  private readonly versions = new Map<string, number>()
  private readonly stopConnected: () => void
  private readonly stopRemoved: () => void

  constructor(private readonly options: HostSoundsOptions) {
    this.stopConnected = options.subscribeConnected(connection => { this.listen(connection) })
    this.stopRemoved = options.subscribeRemoved(hostId => { this.forget(hostId) })
    for (const connection of options.connections()) this.listen(connection)
  }

  /** The host and its own ID for a sound's key, when it names a paired host and not this computer. */
  onHost(key: string): { readonly hostId: string; readonly id: string } | null {
    const parsed = parseHostEntityKey(key)
    return parsed && parsed.hostId !== this.options.localHostId() ? parsed : null
  }

  /** A host's sound's view by its key, or the last one heard while its host is away; null when there is none. */
  async view(key: string): Promise<SoundView | null> {
    const target = this.target(key)
    if (!target) return this.kept.get(key) ?? null
    const hostId = target.connection.hostId
    const letting = this.lettings.get(hostId) ?? 0
    const version = this.versions.get(key) ?? 0
    const view = await target.views.view(target.id).catch(() => undefined)
    // The host was let go while this was asked: nothing of it is kept again.
    if ((this.lettings.get(hostId) ?? 0) !== letting) return null
    // Newer news came while this was asked: that is kept, and this older answer is not.
    if ((this.versions.get(key) ?? 0) !== version) return this.kept.get(key) ?? null
    if (view === undefined) return this.kept.get(key) ?? null
    if (view === null) { this.kept.delete(key); return null }
    return this.keep(hostId, view)
  }

  /**
   * A host's sound's MP3, part by part, each from the one file the host checked: every part must carry its digest and
   * length, and the whole must match the digest and open as an MP3, as this computer's own must. Null when the host is
   * away, refuses, or anything does not add up.
   */
  async bytes(key: string): Promise<Uint8Array | null> {
    const target = this.target(key)
    if (!target) return null
    try {
      const first = await target.views.bytes({ id: target.id, offset: 0 }, '')
      if (!first || first.total > SOUND_BYTES_MAX) return null
      const whole = new Uint8Array(first.total)
      let answer = first
      let offset = 0
      for (let parts = 0; parts < SOUND_HOST_PARTS_MAX; parts += 1) {
        const piece = Buffer.from(answer.data, 'base64')
        if (answer.digest !== first.digest || answer.total !== first.total || piece.byteLength !== Math.min(SOUND_HOST_PART_BYTES, first.total - offset)) return null
        whole.set(piece, offset)
        offset += piece.byteLength
        if (offset === first.total) break
        const next = await target.views.bytes({ id: target.id, offset, digest: first.digest }, '')
        if (!next) return null
        answer = next
      }
      if (offset !== first.total || createHash('sha256').update(whole).digest('hex') !== first.digest) return null
      return looksLikeMp3(whole) ? whole : null
    } catch { return null }
  }

  close(): void {
    this.stopConnected()
    this.stopRemoved()
    for (const stop of this.heard.values()) stop()
    this.heard.clear()
  }

  /** A host the router let go: its news is no longer heard and the views kept for it go. */
  private forget(hostId: string): void {
    this.heard.get(hostId)?.()
    this.heard.delete(hostId)
    this.lettings.set(hostId, (this.lettings.get(hostId) ?? 0) + 1)
    const prefix = hostEntityKey(hostId, '')
    for (const key of [...this.kept.keys()]) if (key.startsWith(prefix)) this.kept.delete(key)
    for (const key of [...this.versions.keys()]) if (key.startsWith(prefix)) this.versions.delete(key)
  }

  /** A connected host that shows its sounds here, with what it reads them by, for a key that names one of them. */
  private target(key: string): { readonly connection: DesktopHostConnection; readonly views: HostSoundViews; readonly id: string } | null {
    const named = this.onHost(key)
    if (!named) return null
    for (const connection of this.options.connections()) {
      if (connection.hostId !== named.hostId) continue
      const views = this.views(connection)
      return views ? { connection, views, id: named.id } : null
    }
    return null
  }

  private views(connection: DesktopHostConnection): HostSoundViews | undefined {
    if (connection.kind !== 'remote' || connection.available?.() === false || connection.service.supportsPluginElevenLabsSounds !== true) return undefined
    return connection.service.pluginElevenLabsSounds
  }

  /** The view keyed for the window, kept for while its host is away. */
  private keep(hostId: string, view: SoundView): SoundView {
    const key = hostEntityKey(hostId, view.id)
    const keyed: SoundView = { ...view, id: key }
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1)
    this.kept.delete(key)
    this.kept.set(key, keyed)
    while (this.kept.size > KEPT_VIEWS) {
      const oldest = this.kept.keys().next().value!
      this.kept.delete(oldest)
      // Its count of views goes with it, so the counts never outgrow what is kept (Bug Bot on #2659, N2).
      this.versions.delete(oldest)
    }
    return keyed
  }

  /** Hears a host's news of its sounds on each new connection, in place of the one before. */
  private listen(connection: DesktopHostConnection): void {
    this.heard.get(connection.hostId)?.()
    this.heard.delete(connection.hostId)
    if (connection.kind !== 'remote' || connection.service.supportsPluginElevenLabsSounds !== true) return
    const stop = connection.service.pluginElevenLabsSounds?.subscribe(news => { this.options.changed(this.keep(connection.hostId, news.view)) })
    if (stop) this.heard.set(connection.hostId, stop)
  }
}
