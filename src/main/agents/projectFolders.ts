import { mkdir, readdir, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** What a new project's folder says when `git init` in it failed: the folder Sotto made for it is gone again. */
export const PROJECT_GIT_NOT_SET_UP = 'Git could not be set up in the new folder. Nothing was added, and the folder was removed. Try again, or make the project without Git.'

/** A folder `create-project` made for a new project, which it takes back when the project is definitely refused. */
export interface MadeProjectFolder {
  /**
   * Removes the folders this made, deepest first, each only while nothing else is in it (#704), so "Nothing was added"
   * stays true and trying again does not say the folder already exists. A fresh `.git` that `init` made is all it removes
   * from inside one. A folder that was there before, or holds anything else, stays.
   */
  undo(): Promise<void>
}

const folderKey = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)

/**
 * Makes a new project's folder, with any parents it needs, and with `init` runs `git init` in it (Watcher's add_project
 * with `gitInit`, ADR-0073, November 12, 2026). A failed `init` takes the folder back and says so.
 */
export async function makeProjectFolder(path: string, init?: (path: string) => Promise<void>): Promise<MadeProjectFolder> {
  // The first folder mkdir made, or undefined when the folder was there after all, in which case nothing is taken back.
  const first = await mkdir(path, { recursive: true })
  const undo = async (): Promise<void> => {
    if (first === undefined) return
    try {
      if (init) {
        const entries = await readdir(path)
        if (entries.length === 1 && entries[0] === '.git') await rm(join(path, '.git'), { recursive: true, force: true })
      }
      // rmdir refuses a folder that is not empty, so anything put there meanwhile keeps it and the folders above it.
      for (let folder = resolve(path); ; folder = dirname(folder)) {
        await rmdir(folder)
        if (folderKey(folder) === folderKey(first) || dirname(folder) === folder) break
      }
    } catch { /* Something else is in it now, so it stays. */ }
  }
  if (init) {
    try { await init(path) } catch { await undo(); throw new Error(PROJECT_GIT_NOT_SET_UP) }
  }
  return { undo }
}
