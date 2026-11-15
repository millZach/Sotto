import { createHash } from 'node:crypto'
import { MODEL_3D_HOST_BYTES_MAX, MODEL_3D_HOST_PART_BYTES, type HostModelViews, type Model3dHostBytes, type Model3dHostBytesRequest, type Model3dHostNews } from '../../../shared/models3d'
import { listModels, removeGoneModel, type ModelListSource } from './page'
import type { ThreeDModel } from './records'
import type { ModelProgress } from './service'
import { modelBytes, modelView, modelViewOf } from './view'

/**
 * A headless host's 3D models as a recorded desktop reads them (`plugin-meshy-models`; the Meshy plan's ticket 6, part 2):
 * the views the desktop's own page and line are built from, read over this host's records by the same code, and the
 * bytes they are drawn from, a part at a time.
 *
 * A file is read whole and checked as the desktop checks its own (inside its record's folder, under the cap, a picture
 * that is one, a GLB that stands alone), and its parts are then cut from what was checked, never read again part by part:
 * a file that changed between parts would otherwise be handed over half one and half the other. What was checked is
 * held for the client that asked, one file each, until its last part goes or a short while passes.
 */

/** How long a checked file is held for the rest of its parts. */
export const HELD_BYTES_MS = 60_000
/** The most IDs one push of removals names, as `model3dRemovedSchema` takes them. */
const MODEL_3D_REMOVED_MAX = 2_000

interface Held { readonly id: string; readonly part: Model3dHostBytesRequest['part']; readonly digest: string; readonly bytes: Uint8Array; readonly timer: ReturnType<typeof setTimeout> }

export interface HostModelViewsWithNews extends HostModelViews {
  /** A 3D model changed: its view goes to every listener, in order, while its record is there. */
  changed(model: ThreeDModel, progress: ModelProgress | undefined): void
  /** Records went, with their forgotten threads. */
  removed(ids: readonly string[]): void
  close(): void
}

export function hostModelViews(source: ModelListSource): HostModelViewsWithNews {
  const listeners = new Set<(news: Model3dHostNews) => void>()
  const tell = (news: Model3dHostNews): void => { for (const listener of [...listeners]) { try { listener(news) } catch { /* A listener's failure is its own. */ } } }
  const held = new Map<string, Held>()
  const letGo = (clientId: string): void => { const kept = held.get(clientId); if (kept) { clearTimeout(kept.timer); held.delete(clientId) } }
  // Views are sent in order, so a slower one never lands after a newer one, as the desktop's own are.
  let sent: Promise<void> = Promise.resolve()

  /** The whole file checked for `clientId`, held for its other parts, or the one already held when it is the same. */
  const checked = async (request: Model3dHostBytesRequest, clientId: string): Promise<Held | null> => {
    const kept = held.get(clientId)
    if (kept && kept.id === request.id && kept.part === request.part && request.offset > 0 && kept.digest === request.digest) return kept
    letGo(clientId)
    const bytes = await modelBytes(source, { id: request.id, part: request.part }, MODEL_3D_HOST_BYTES_MAX)
    if (!bytes) return null
    const digest = createHash('sha256').update(bytes).digest('hex')
    // A later part is cut only from the file its first part was: one that changed since is refused, not mixed.
    if (request.offset > 0 && request.digest !== digest) return null
    const timer = setTimeout(() => { if (held.get(clientId)?.timer === timer) held.delete(clientId) }, HELD_BYTES_MS)
    timer.unref?.()
    const fresh: Held = { id: request.id, part: request.part, digest, bytes, timer }
    held.set(clientId, fresh)
    return fresh
  }

  return {
    list: async threadId => listModels(source, threadId),
    view: async id => modelViewOf(source, id),
    bytes: async (request, clientId): Promise<Model3dHostBytes> => {
      const file = await checked(request, clientId)
      if (!file || request.offset >= file.bytes.byteLength) return null
      const end = Math.min(file.bytes.byteLength, request.offset + MODEL_3D_HOST_PART_BYTES)
      if (end === file.bytes.byteLength) letGo(clientId)
      return { data: Buffer.from(file.bytes.buffer, file.bytes.byteOffset + request.offset, end - request.offset).toString('base64'), total: file.bytes.byteLength, digest: file.digest }
    },
    remove: async id => {
      const removal = await removeGoneModel(source, id)
      if (removal === 'removed') tell({ removed: [id] })
      return removal
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    changed: (model, progress) => {
      if (listeners.size === 0) return
      const shape = source.hasShape(model.id)
      sent = sent.then(async () => await source.model(model.id) ? await modelView(model, progress, shape) : null)
        .then(view => { if (view) tell({ changed: { threadId: model.threadId, view } }) }, () => undefined)
    },
    removed: ids => { for (let at = 0; at < ids.length; at += MODEL_3D_REMOVED_MAX) tell({ removed: ids.slice(at, at + MODEL_3D_REMOVED_MAX) }) },
    close: () => { listeners.clear(); for (const clientId of [...held.keys()]) letGo(clientId) },
  }
}
