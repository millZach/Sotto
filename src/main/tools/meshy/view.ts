import { isAbsolute, relative, sep } from 'node:path'
import { bytesHaveRasterSignature } from '../../../shared/agents'
import type { Model3dBytesRequest, Model3dView } from '../../../shared/models3d'
import { modelFileSizes, readModelFile } from './files'
import { glbProblem } from './glb'
import type { ThreeDModel } from './records'
import type { ModelProgress } from './service'

/**
 * A 3D model as the window draws it in its thread (ADR-0141; the Meshy plan's ticket 4), and the bytes it draws from.
 * The window names a 3D model by its ID alone and is handed names, sizes and bytes, never a path.
 */

/** What the view and the bytes are read from: the records and the service that makes 3D models. */
export interface ModelViewSource {
  model(id: string): Promise<ThreeDModel | undefined>
  progressOf(id: string, stage: ThreeDModel['stage']): ModelProgress | undefined
  hasShape(id: string): boolean
  shapeBytes(id: string): Promise<Uint8Array | null>
}

const STILL_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

/**
 * A 3D model's view. `progress` is Meshy's on its step while it works, and file sizes are read only once it holds
 * files, so a view sent on each of Meshy's reads costs no disk.
 */
export async function modelView(model: ThreeDModel, progress: ModelProgress | undefined, shape: boolean): Promise<Model3dView> {
  const sizes = model.files.length > 0 && model.state !== 'making' ? await modelFileSizes(model) : new Map<string, number>()
  const folder = relative(model.root, model.folder)
  const making = model.state === 'making'
  return {
    id: model.id, name: model.name, source: model.source.kind, state: model.state, credits: model.credits,
    // A folder outside the thread's is never named: the record says it is inside, and this does not take its word.
    folder: folder === '..' || folder.startsWith(`..${sep}`) || isAbsolute(folder) ? '' : folder.split(sep).join('/'),
    files: model.files.map(name => ({ name, ...(sizes.has(name) ? { bytes: sizes.get(name)! } : {}) })),
    ...(model.still ? { still: model.still } : {}),
    ...(making && model.stage ? { stage: model.stage } : {}),
    ...(making && progress ? { percent: progress.percent, ...(progress.secondsLeft !== undefined ? { secondsLeft: progress.secondsLeft } : {}) } : {}),
    ...(making && model.stage === 'texture' && shape ? { shape: true } : {}),
    ...(model.failure ? { failure: model.failure } : {}),
  }
}

/** A 3D model's view by its ID, as it stands now, or null when Sotto holds no such 3D model. */
export async function modelViewOf(source: ModelViewSource, id: string): Promise<Model3dView | null> {
  const model = await source.model(id)
  return model ? modelView(model, source.progressOf(id, model.stage), source.hasShape(id)) : null
}

/**
 * The bytes the window draws: a finished 3D model's GLB or still picture from its folder, or the shape Meshy made while
 * it paints the texture. Null when the 3D model or the file is gone, the folder is no longer inside the thread's, the
 * file is past the cap, the picture is not one, or the GLB points outside itself.
 */
export async function modelBytes(source: ModelViewSource, request: Model3dBytesRequest): Promise<Uint8Array | null> {
  if (request.part === 'shape') {
    // Only a 3D model still in its texture step has a shape to show, and only while its record is there: one whose
    // thread was forgotten, before the bytes came or while they did, hands over nothing.
    const texturing = async (): Promise<boolean> => { const model = await source.model(request.id); return model?.state === 'making' && model.stage === 'texture' }
    if (!await texturing()) return null
    const shape = await source.shapeBytes(request.id)
    return shape && glbProblem(shape) === null && await texturing() ? shape : null
  }
  const model = await source.model(request.id)
  if (!model || model.state !== 'done') return null
  if (request.part === 'still') {
    const still = model.still
    const type = still ? STILL_TYPES[still.slice(still.lastIndexOf('.') + 1).toLowerCase()] : undefined
    if (!still || !type) return null
    const bytes = await readModelFile(model, still)
    return bytes && bytesHaveRasterSignature(type, bytes) ? bytes : null
  }
  const glb = model.files.find(name => name.toLowerCase().endsWith('.glb'))
  if (!glb) return null
  const bytes = await readModelFile(model, glb)
  return bytes && glbProblem(bytes) === null ? bytes : null
}
