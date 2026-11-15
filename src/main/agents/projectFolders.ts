import { mkdir, readdir, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** What a new project's folder says when `git init` in it failed and the folder Sotto made for it is gone again. */
export const PROJECT_GIT_NOT_SET_UP = 'Git could not be set up in the new folder. Nothing was added, and the folder was removed. Try again, or make the project without Git.'
/** The same, when something else was in the folder by then, so it stayed. */
export const PROJECT_GIT_NOT_SET_UP_KEPT = 'Git could not be set up in the new folder. Nothing was added, and the folder was kept because something else is in it. Add it as it is, or choose another folder.'

/** What a new project with Git says when its folder was made by something else meanwhile. */
export const PROJECT_FOLDER_APPEARED = 'That folder already exists. Nothing was added. Choose another folder, or add this one with Add project to use it as it is.'

/** A folder `create-project` made for a new project, which it takes back when the project is definitely refused. */
export interface MadeProjectFolder {
  /**
   * Removes the folders this made, deepest first, each only while nothing else is in it (#704), so "Nothing was added"
   * stays true and trying again does not say the folder already exists. A fresh `.git` that `init` made is all it removes
   * from inside one. A folder that was there before, or holds anything else, stays. Resolves with whether the new
   * project's folder is gone.
   */
  undo(): Promise<boolean>
}

/** A folder as this machine compares folders: Windows' are the same whatever their case. */
export const projectFolderKey = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)

/**
 * Makes a new project's folder, with any parents it needs, and with `init` runs `git init` in it (Watcher's add_project
 * with `gitInit`, ADR-0073, November 12, 2026). A failed `init` takes the folder back and says whether it could.
 */
export async function makeProjectFolder(path: string, init?: (path: string) => Promise<void>): Promise<MadeProjectFolder> {
  // The first folder mkdir made, or undefined when the folder was there after all, in which case nothing is taken back.
  const first = await mkdir(path, { recursive: true })
  const undo = async (): Promise<boolean> => {
    if (first === undefined) return false
    let removed = false
    try {
      if (init) {
        const entries = await readdir(path)
        if (entries.length === 1 && entries[0] === '.git') await rm(join(path, '.git'), { recursive: true, force: true })
      }
      // rmdir refuses a folder that is not empty, so anything put there meanwhile keeps it and the folders above it.
      for (let folder = resolve(path); ; folder = dirname(folder)) {
        await rmdir(folder)
        removed = true
        if (projectFolderKey(folder) === projectFolderKey(first) || dirname(folder) === folder) break
      }
    } catch { /* Something else is in it now, so it stays. */ }
    return removed
  }
  // A folder that appeared after create-project looked is not Sotto's, so Git is never set up in it.
  if (init && first === undefined) throw new Error(PROJECT_FOLDER_APPEARED)
  if (init) {
    try { await init(path) } catch { throw new Error(await undo() ? PROJECT_GIT_NOT_SET_UP : PROJECT_GIT_NOT_SET_UP_KEPT) }
  }
  return { undo }
}
