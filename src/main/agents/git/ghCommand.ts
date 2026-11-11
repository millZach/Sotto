import { findCli, withCliPath } from '../cliLookup'

/**
 * How long a lookup that found no gh stands before the next gh command looks again, so a gh installed while Sotto runs is
 * found without a restart and a missing one is not searched for on every read.
 */
const MISSING_AGAIN_MS = 5 * 60_000

let found: { readonly at: number; readonly executable: Promise<string | undefined>; missing: boolean } | undefined

/**
 * Where to start GitHub's `gh` from, found the way the CLI lookup finds a provider's client (ADR-0036, #2430): PATH, then
 * the login shell's PATH, `~/.local/bin`, the version managers and the npm prefix. A host started from a non-interactive
 * SSH shell or a systemd unit has only `/usr/local/bin:/usr/bin:/bin` on PATH, which misses a gh in `~/.local/bin`, as
 * forge's is: every pull request read failed there, so its threads linked no pull requests and Watcher heard nothing
 * of them. Found once per process; a gh not found is looked for again after MISSING_AGAIN_MS. Windows keeps `gh` from
 * PATH as it always has. Undefined when gh is nowhere, and the caller starts plain `gh`, which says it is missing.
 */
export function findGh(now: number = Date.now()): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  if (found && !(found.missing && now - found.at >= MISSING_AGAIN_MS)) return found.executable
  const entry = { at: now, missing: false, executable: findCli({ name: 'gh' }).catch(() => undefined) }
  void entry.executable.then(value => { entry.missing = value === undefined })
  found = entry
  return entry.executable
}

/**
 * The command to start gh with, and the PATH to give it when the lookup found it outside the inherited one
 * (`withCliPath`): the one found, or plain `gh`.
 */
export async function ghLaunch(): Promise<{ readonly command: string; readonly path?: string }> {
  const executable = await findGh()
  if (!executable) return { command: 'gh' }
  const inherited = process.env.PATH ?? '', path = withCliPath({ PATH: inherited }, executable).PATH
  return path === undefined || path === inherited ? { command: executable } : { command: executable, path }
}

/** Forgets what the last lookup found, so a test starts clean. */
export function resetGhLookup(): void { found = undefined }
