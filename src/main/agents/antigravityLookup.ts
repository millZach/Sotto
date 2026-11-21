import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { executableFile, findCli, type CliLookupOptions } from './cliLookup'

/**
 * Where Antigravity's `agy` comes from, in T3 Code's order (the research note, "Launch"): the binary path the user set,
 * then the copy Sotto downloaded and verified, then `agy` or `antigravity` by Sotto's CLI lookup (ADR-0036), with
 * Google's installer folder `~/.local/bin` first. A program is accepted only by those names, as T3 accepts it, so a
 * binary path that names something else is refused rather than started.
 */
export interface AntigravityLookup extends Omit<CliLookupOptions, 'environment'> {
  /** The binary path from Settings, when the user set one. A path that is not `agy` or `antigravity` finds nothing. */
  readonly binaryPath?: string
  /** The newest verified copy Sotto downloaded, when there is one. */
  readonly managed?: () => Promise<string | undefined>
}

const NAMES = /^(?:agy|antigravity)(?:\.exe|\.cmd|\.bat)?$/iu

/** Whether a path names Antigravity's program, by its own name or the name its link points at. */
export async function isAntigravityProgram(candidate: string): Promise<boolean> {
  if (NAMES.test(basename(candidate))) return true
  const real = await realpath(candidate).catch(() => undefined)
  return real !== undefined && NAMES.test(basename(real))
}

const expandHome = (value: string, home: string): string => value === '~' ? home : value.replace(/^~(?=[\\/])/u, home)

export async function findAntigravityExecutable(environment: NodeJS.ProcessEnv = process.env, lookup: AntigravityLookup = {}): Promise<string | undefined> {
  const home = lookup.home ?? homedir()
  const platform = lookup.platform ?? process.platform
  if (lookup.binaryPath?.trim()) {
    const path = expandHome(lookup.binaryPath.trim(), home)
    if (!await isAntigravityProgram(path)) return undefined
    return executableFile(path, platform)
  }
  const managed = await lookup.managed?.()
  if (managed) return managed
  const first = [join(home, '.local', 'bin')]
  for (const name of ['agy', 'antigravity']) {
    const found = await findCli({ name, first }, { ...lookup, environment })
    if (found) return found
  }
  return undefined
}
