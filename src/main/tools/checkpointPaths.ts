import { createHash } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { fileRelativePathSchema } from '../../shared/files'

/** The rules a checkpoint path keeps, shared by capture and restore. */

/** A checkpoint path: relative to its working folder, inside it, and not the folder itself. */
export const checkpointPathSchema = fileRelativePathSchema.refine(value => value.length > 0)
export const LINK_MESSAGE = 'Checkpoint paths cannot follow symbolic links or directory junctions.'
/** Whether `candidate` is `root` or inside it. */
export function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}
/** The name a file's backup is stored under, and the hash a checkpoint records for it. */
export const blobName = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
