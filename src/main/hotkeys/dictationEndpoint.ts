import { lstatSync, readlinkSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DictationDirectory } from './dictationRuntime'

// Match the whole basename, including refusing a trailing newline (which '$' permits).
export const privateDictationSocketPattern = /^dictation-\d+-[a-f0-9]{8}\.sock(?![\s\S])/

export interface DictationEndpoint {
  stat: Stats
  target: string | null
  socketStat: Stats | null
}

export function validateDictationFolder(path: string): DictationDirectory {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error('Dictation folder is unavailable.')
  }
  return { path, stat }
}

/** Only recovery may accept a published link whose private socket is already gone. */
export function readDictationEndpoint(path: string, allowMissingTarget = false): DictationEndpoint {
  const stat = lstatSync(path)
  if (stat.uid !== process.getuid?.()) throw new Error('Dictation socket is unavailable.')
  // Recover sockets left by the earlier direct-binding implementation too.
  if (stat.isSocket()) return { stat, target: null, socketStat: stat }
  if (!stat.isSymbolicLink()) throw new Error('Dictation socket is unavailable.')
  const target = readlinkSync(path)
  if (!privateDictationSocketPattern.test(target)) throw new Error('Dictation socket is unavailable.')
  let socketStat: Stats | null = null
  try { socketStat = lstatSync(join(dirname(path), target)) } catch (error) {
    if (!allowMissingTarget || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (socketStat !== null && (!socketStat.isSocket() || socketStat.uid !== process.getuid?.())) {
    throw new Error('Dictation socket is unavailable.')
  }
  return { stat, target, socketStat }
}
