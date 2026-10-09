import { lstatSync, type Stats } from 'node:fs'
import { isAbsolute } from 'node:path'

export interface DictationDirectory {
  path: string
  stat: Stats
}

/** Check every traversed component, including ones before a '..', without following links. */
export function validateDictationRuntime(runtimeDirectory: string | undefined): DictationDirectory[] {
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) throw new Error('Dictation needs a private desktop runtime folder.')
  let path = '/'
  const directories: DictationDirectory[] = [{ path, stat: lstatSync(path) }]
  for (const part of runtimeDirectory.split('/').filter(part => part.length > 0)) {
    path += `${path.endsWith('/') ? '' : '/'}${part}`
    const entry = { path, stat: lstatSync(path) }
    if (!entry.stat.isDirectory()) throw new Error('Dictation needs a real desktop runtime folder.')
    directories.push(entry)
  }
  const runtime = directories.at(-1)!
  if (runtime.stat.uid !== process.getuid?.() || (runtime.stat.mode & 0o7777) !== 0o700) {
    throw new Error('Dictation needs a desktop runtime folder that only you can access.')
  }
  for (const ancestor of directories.slice(0, -1)) {
    const { stat } = ancestor
    // StrictModes-style ancestry: a sticky shared folder cannot rename our entry.
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new Error('Dictation needs runtime folders that only you or the system can change.')
    }
  }
  return directories
}

/** An asynchronous probe must not authorize changes in a directory that replaced the checked one. */
export function assertDictationDirectories(directories: readonly DictationDirectory[]): void {
  for (const entry of directories) {
    const current = lstatSync(entry.path)
    if (!current.isDirectory() || current.dev !== entry.stat.dev || current.ino !== entry.stat.ino ||
      current.uid !== entry.stat.uid || current.mode !== entry.stat.mode) {
      throw new Error('The dictation runtime folder changed. Open Sotto again in this desktop session.')
    }
  }
}
