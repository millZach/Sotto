import { cpSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The app shipped as "TalkType" (packaged) / "talktype" (dev) before the Sotto
// rename. Electron derives the userData directory from the app name, so first
// launch after the rename starts from an empty profile unless we carry the old
// data across.
const LEGACY_APP_NAMES = ['TalkType', 'talktype'] as const
const DATA_FILES = ['settings.json', 'history.json', 'widget-placement.json'] as const
const MODELS_DIR = 'models'

export interface LegacyMigrationFs {
  exists(path: string): boolean
  rename(from: string, to: string): void
  copyFile(from: string, to: string): void
  copyDir(from: string, to: string): void
  mkdir(path: string): void
}

const nodeFs: LegacyMigrationFs = {
  exists: existsSync,
  rename: renameSync,
  copyFile: copyFileSync,
  copyDir: (from, to) => cpSync(from, to, { recursive: true, errorOnExist: false, force: false }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
}

export type LegacyMigrationResult = 'renamed' | 'copied' | 'skipped'

export function migrateLegacyUserData(
  userDataPath: string,
  fs: LegacyMigrationFs = nodeFs,
): LegacyMigrationResult {
  if (DATA_FILES.some((file) => fs.exists(join(userDataPath, file)))) {
    return 'skipped'
  }

  const parent = dirname(userDataPath)
  const legacyPath = LEGACY_APP_NAMES.map((name) => join(parent, name)).find(
    (candidate) =>
      candidate !== userDataPath &&
      DATA_FILES.some((file) => fs.exists(join(candidate, file))),
  )
  if (legacyPath === undefined) {
    return 'skipped'
  }

  if (!fs.exists(userDataPath)) {
    try {
      fs.rename(legacyPath, userDataPath)
      return 'renamed'
    } catch {
      // Fall through to copying file by file.
    }
  }

  try {
    fs.mkdir(userDataPath)
    for (const file of DATA_FILES) {
      const source = join(legacyPath, file)
      if (fs.exists(source)) {
        fs.copyFile(source, join(userDataPath, file))
      }
    }
    const legacyModels = join(legacyPath, MODELS_DIR)
    if (fs.exists(legacyModels)) {
      fs.copyDir(legacyModels, join(userDataPath, MODELS_DIR))
    }
    return 'copied'
  } catch {
    // Migration is best effort: a failure must never block startup, the app
    // simply starts with a fresh profile.
    return 'skipped'
  }
}
