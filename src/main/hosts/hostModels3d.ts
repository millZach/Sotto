import { createHash } from 'node:crypto'
import { bytesHaveRasterSignature } from '../../shared/agents'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { MODEL_3D_HOST_BYTES_MAX, MODEL_3D_HOST_PART_BYTES, MODEL_3D_HOST_PARTS_MAX, type HostModelViews, type Model3dBytesRequest, type Model3dListed, type Model3dRemoval, type Model3dView } from '../../shared/models3d'
import { glbProblem } from '../tools/meshy/glb'
import type { DesktopHostConnection } from './desktopHostRouter'

/**
 * A paired host's 3D models on this computer (ADR-0141; the Meshy plan's ticket 6, part 2): the window names each by a
 * key that says which host holds it, as it names a host's thread (`hostEntityKey`), and main asks that host by the host's
 * own ID, over the connection the host protocol gives it (`plugin-meshy-models`). The window is handed views, names,
 * sizes and bytes, never a path, and nothing it sends reaches the host but a 3D model's ID, a thread's and a part.
 *
 * A host's 3D models are listed only while it is connected. Each view heard is kept, at most `KEPT_VIEWS`, so a host
 * thread's line can still say what its 3D model cost while the host is away.
 */

/** The most host views kept for a line while its host is away: as many as one list holds. */
const KEPT_VIEWS = 2_000
const STILL_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export interface HostModels3dOptions {
  /** The remote hosts connected now, read in place. */
  readonly connections: () => Iterable<DesktopHostConnection>
  /** Hears each host connection as the router takes it, new or in place of one it had. */
  readonly subscribeConnected: (listener: (connection: DesktopHostConnection) => void) => () => void
  /** This computer's own host ID, whose keys name this computer's own 3D models. */
  readonly localHostId: () => string | undefined
  /** Tells the window a host's 3D model changed, by its key. */
  readonly changed: (view: Model3dView) => void
  /** Tells the window host records went, by their keys. */
  readonly removed: (keys: string[]) => void
}

export class HostModels3d {
  private readonly kept = new Map<string, Model3dView>()
  private readonly heard = new Map<string, () => void>()
  private readonly stopConnected: () => void

  constructor(private readonly options: HostModels3dOptions) {
    this.stopConnected = options.subscribeConnected(connection => { this.listen(connection) })
    for (const connection of options.connections()) this.listen(connection)
  }

  /** The host and its own ID for a 3D model's or a thread's key, when it names a paired host and not this computer. */
  onHost(key: string): { readonly hostId: string; readonly id: string } | null {
    const parsed = parseHostEntityKey(key)
    return parsed && parsed.hostId !== this.options.localHostId() ? parsed : null
  }

  /** Every connected host's 3D models being made or done, newest first; or, with a host thread's key, that thread's. */
  async list(threadKey?: string): Promise<Model3dListed[]> {
    const thread = threadKey === undefined ? undefined : this.onHost(threadKey)
    if (threadKey !== undefined && !thread) return []
    const lists = await Promise.all([...this.options.connections()].map(async connection => {
      if (thread && connection.hostId !== thread.hostId) return []
      const views = this.views(connection)
      if (!views) return []
      const found = await views.list(thread?.id).catch(() => [])
      return found.map(model => this.listed(connection, model))
    }))
    return lists.flat()
  }

  /** A host's 3D model's view by its key, or the last one heard while its host is away; null when there is none. */
  async view(key: string): Promise<Model3dView | null> {
    const target = this.target(key)
    if (!target) return this.kept.get(key) ?? null
    const view = await target.views.view(target.id).catch(() => undefined)
    if (view === undefined) return this.kept.get(key) ?? null
    if (view === null) { this.kept.delete(key); return null }
    return this.keep(target.connection.hostId, view)
  }

  /**
   * A host's 3D model's bytes, part by part, each from the one file the host checked: every part must carry its digest
   * and length, and the whole must match the digest. The GLB is looked at again here, as this computer's own are, and a
   * still picture must be one. Null when the host is away, refuses, or anything does not add up.
   */
  async bytes(request: Model3dBytesRequest): Promise<Uint8Array | null> {
    const target = this.target(request.id)
    if (!target) return null
    try {
      const first = await target.views.bytes({ id: target.id, part: request.part, offset: 0 }, '')
      if (!first || first.total > MODEL_3D_HOST_BYTES_MAX) return null
      const whole = new Uint8Array(first.total)
      let answer = first
      let offset = 0
      for (let parts = 0; parts < MODEL_3D_HOST_PARTS_MAX; parts += 1) {
        const piece = Buffer.from(answer.data, 'base64')
        if (answer.digest !== first.digest || answer.total !== first.total || piece.byteLength !== Math.min(MODEL_3D_HOST_PART_BYTES, first.total - offset)) return null
        whole.set(piece, offset)
        offset += piece.byteLength
        if (offset === first.total) break
        const next = await target.views.bytes({ id: target.id, part: request.part, offset, digest: first.digest }, '')
        if (!next) return null
        answer = next
      }
      if (offset !== first.total || createHash('sha256').update(whole).digest('hex') !== first.digest) return null
      if (request.part === 'still') return STILL_TYPES.some(type => bytesHaveRasterSignature(type, whole)) ? whole : null
      return glbProblem(whole) === null ? whole : null
    } catch { return null }
  }

  /** Remove from 3D models for a host's 3D model whose files are gone: the host looks again, and removes its record only. */
  async remove(key: string): Promise<Model3dRemoval | 'away'> {
    const target = this.target(key)
    if (!target) return 'away'
    const removal = await target.views.remove(target.id)
    if (removal === 'removed' || removal === 'no-record') this.kept.delete(key)
    return removal
  }

  close(): void {
    this.stopConnected()
    for (const stop of this.heard.values()) stop()
    this.heard.clear()
  }

  /** A connected host that shows its 3D models here, with what it reads them by, for a key that names one of them. */
  private target(key: string): { readonly connection: DesktopHostConnection; readonly views: HostModelViews; readonly id: string } | null {
    const named = this.onHost(key)
    if (!named) return null
    for (const connection of this.options.connections()) {
      if (connection.hostId !== named.hostId) continue
      const views = this.views(connection)
      return views ? { connection, views, id: named.id } : null
    }
    return null
  }

  private views(connection: DesktopHostConnection): HostModelViews | undefined {
    if (connection.kind !== 'remote' || connection.available?.() === false || connection.service.supportsPluginMeshyModels !== true) return undefined
    return connection.service.pluginMeshyModels
  }

  /** A host's listed 3D model as the window lists it: by its key, its thread's key and the host's name. */
  private listed(connection: DesktopHostConnection, model: Model3dListed): Model3dListed {
    const { computer: _named, ...own } = model
    void _named
    const view = this.keep(connection.hostId, own)
    return { ...own, ...view, threadId: hostEntityKey(connection.hostId, model.threadId), computer: connection.name }
  }

  /** The view keyed for the window, kept for while its host is away. */
  private keep(hostId: string, view: Model3dView | Model3dListed): Model3dView {
    const key = hostEntityKey(hostId, view.id)
    const keyed: Model3dView = {
      id: key, name: view.name, source: view.source, state: view.state, credits: view.credits, folder: view.folder, files: view.files,
      ...(view.stage !== undefined ? { stage: view.stage } : {}), ...(view.percent !== undefined ? { percent: view.percent } : {}),
      ...(view.secondsLeft !== undefined ? { secondsLeft: view.secondsLeft } : {}), ...(view.still !== undefined ? { still: view.still } : {}),
      ...(view.shape !== undefined ? { shape: view.shape } : {}), ...(view.failure !== undefined ? { failure: view.failure } : {}),
    }
    this.kept.delete(key)
    this.kept.set(key, keyed)
    while (this.kept.size > KEPT_VIEWS) this.kept.delete(this.kept.keys().next().value!)
    return keyed
  }

  /** Hears a host's news of its 3D models on each new connection, in place of the one before. */
  private listen(connection: DesktopHostConnection): void {
    this.heard.get(connection.hostId)?.()
    this.heard.delete(connection.hostId)
    if (connection.kind !== 'remote' || connection.service.supportsPluginMeshyModels !== true) return
    const stop = connection.service.pluginMeshyModels?.subscribe(news => {
      if (news.changed) this.options.changed(this.keep(connection.hostId, news.changed.view))
      if (news.removed) {
        const keys = news.removed.map(id => hostEntityKey(connection.hostId, id))
        for (const key of keys) this.kept.delete(key)
        this.options.removed(keys)
      }
    })
    if (stop) this.heard.set(connection.hostId, stop)
  }
}
