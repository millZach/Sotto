import { join } from 'node:path'

/**
 * Sotto's own Antigravity folders, as T3 Code keeps a profile of its own (the research note, "Launch"). Every `agy`
 * Sotto starts runs with `--gemini-dir <gemini>` and `GEMINI_HOME=<gemini>`, and `--app-data-dir antigravity-acp`,
 * which `agy` takes only as a name under the Gemini folder. So the user's own `~/.gemini` is never read for a thread or
 * written by one, and the user's own `agy` never lists Sotto's conversations. The sign-in lives in the app data folder.
 *
 * `root` is the runtime's directory: user data on the desktop, the data directory on a headless host.
 */
export const ANTIGRAVITY_APP_DATA = 'antigravity-acp'

export interface AntigravityFolders {
  /** Everything Sotto keeps for Antigravity. */
  readonly root: string
  /** `--gemini-dir` and `GEMINI_HOME`. */
  readonly gemini: string
  /** `agy`'s own app data: its sign-in, settings, conversations (`conversations/<sessionId>.db`) and `brain`. */
  readonly appData: string
  /** The copies of `agy` Sotto downloaded and verified, one folder per version. */
  readonly runtime: string
  /** Scratch folders for short text and sign-in checks, removed after each use. */
  readonly scratch: string
}

export function antigravityFolders(directory: string): AntigravityFolders {
  const root = join(directory, 'antigravity')
  const gemini = join(root, 'gemini')
  return { root, gemini, appData: join(gemini, ANTIGRAVITY_APP_DATA), runtime: join(root, 'runtime'), scratch: join(root, 'scratch') }
}
