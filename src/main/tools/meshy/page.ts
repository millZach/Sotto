import type { Model3dListed, Model3dRemoval, Model3dRevealRequest } from '../../../shared/models3d'
import { modelFilePath, modelFileSizes } from './files'
import type { ThreeDModel } from './records'
import { modelView, type ModelViewSource } from './view'

/**
 * The 3D models page and Tools › 3D models (ADR-0141; the Meshy plan's ticket 5): every 3D model being made or done,
 * newest first, the record of one whose files are gone removed when the user asks, and a file shown in the folder app.
 * The window names a 3D model by its ID and a file by the name its record holds; no path comes from it or goes to it.
 */

/** What the page reads from: the records, the service that makes 3D models, and the Meshy accounts' names. */
export interface ModelListSource extends ModelViewSource {
  list(): Promise<readonly ThreeDModel[]>
  /** Each Meshy account's name, by its ID. */
  accountNames(): Promise<ReadonlyMap<string, string>>
  /** Removes one record while `may` still holds of it; never a file. */
  remove(id: string, may: (model: ThreeDModel) => boolean): Promise<boolean>
}

/**
 * Every 3D model being made or done, newest first, or one thread's. One that was not made stays as its line in its
 * thread and is not listed (Zach's pick on November 15, 2026).
 */
export async function listModels(source: ModelListSource, threadId?: string): Promise<Model3dListed[]> {
  const models = (await source.list()).filter(model => (model.state === 'making' || model.state === 'done') && (threadId === undefined || model.threadId === threadId))
  if (models.length === 0) return []
  const names = await source.accountNames().catch(() => new Map<string, string>())
  const listed = await Promise.all(models.map(async (model): Promise<Model3dListed> => ({
    ...await modelView(model, source.progressOf(model.id, model.stage), source.hasShape(model.id)),
    threadId: model.threadId, account: names.get(model.accountId) ?? '', askedAt: model.askedAt,
    // The words only while the record holds them, as Keep local history says; a photo by its name alone.
    ...(model.source.kind === 'words' && model.source.words !== undefined ? { words: model.source.words } : {}),
    ...(model.source.kind === 'photo' ? { photo: model.source.fileName } : {}),
  })))
  return listed.sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt))
}

/**
 * Removes the record of a finished 3D model whose files are all gone, looked at again here rather than taken from the
 * window, and says what became of it. A file that is back keeps the record. Never removes a file (ADR-0141).
 */
export async function removeGoneModel(source: ModelListSource, id: string): Promise<Model3dRemoval> {
  const model = await source.model(id)
  if (!model) return 'no-record'
  if (model.state !== 'done') return 'changed'
  if ((await modelFileSizes(model)).size > 0) return 'files-there'
  // The record is removed only as it was looked at: still done, naming the same files.
  const files = model.files.join('\n')
  if (await source.remove(id, held => held.state === 'done' && held.files.join('\n') === files)) return 'removed'
  return await source.model(id) ? 'changed' : 'no-record'
}

/**
 * Shows one of a finished 3D model's files in the folder app: the one named, or its GLB, else the first of its files
 * still there. The path is the record's own, checked to be inside its folder. False when there is none to show.
 */
export async function revealModelFile(source: ModelListSource, request: Model3dRevealRequest, reveal: (path: string) => void): Promise<boolean> {
  const model = await source.model(request.id)
  if (!model || model.state !== 'done') return false
  const glb = model.files.filter(name => name.toLowerCase().endsWith('.glb'))
  const names = request.file !== undefined ? [request.file] : [...glb, ...model.files.filter(name => !glb.includes(name))]
  for (const name of names) {
    const path = await modelFilePath(model, name)
    if (path) { reveal(path); return true }
  }
  return false
}
