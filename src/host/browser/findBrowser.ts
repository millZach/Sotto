import { posix, win32 } from 'node:path'
import { homedir } from 'node:os'
import { executableFile } from '../../main/agents/cliLookup'

/**
 * Where a host finds the browser its threads browse in (ADR-0198): Chrome, Chromium or Edge, already installed by
 * the user, in the places each installs itself, then on PATH. Sotto never downloads one. Nothing here logs: a path
 * can name the user.
 */
export interface FindBrowserOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly home?: string
  /** Whether a candidate may be started, and the path to start it by. A test answers for the file system. */
  readonly accept?: (candidate: string) => Promise<string | undefined>
}

/** The names the three browsers go by on PATH, in the order a host prefers them. */
const PATH_NAMES: Readonly<Record<'posix' | 'win32', readonly string[]>> = {
  posix: ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge'],
  win32: ['chrome.exe', 'msedge.exe'],
}

/** Every place a host looks, in order. */
export function browserCandidates(options: FindBrowserOptions = {}): string[] {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const join = platform === 'win32' ? win32.join : posix.join
  const found: string[] = []
  if (platform === 'darwin') {
    for (const root of ['/Applications', join(home, 'Applications')]) {
      found.push(
        join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
      )
    }
  } else if (platform === 'win32') {
    const roots = [environment.PROGRAMFILES, environment['PROGRAMFILES(X86)'], environment.LOCALAPPDATA].filter((root): root is string => Boolean(root))
    for (const root of roots) {
      found.push(
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(root, 'Chromium', 'Application', 'chrome.exe'),
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      )
    }
  } else {
    found.push('/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/microsoft/msedge/msedge', '/snap/bin/chromium')
  }
  const separator = platform === 'win32' ? ';' : ':'
  const folders = (environment.PATH ?? environment.Path ?? '').split(separator).filter(Boolean)
  for (const folder of folders) for (const name of PATH_NAMES[platform === 'win32' ? 'win32' : 'posix']) found.push(join(folder, name))
  return [...new Set(found)]
}

/** The first browser that may be started, or undefined when the host has none. */
export async function findBrowser(options: FindBrowserOptions = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  const accept = options.accept ?? ((candidate: string) => executableFile(candidate, platform))
  for (const candidate of browserCandidates(options)) {
    const executable = await accept(candidate)
    if (executable) return executable
  }
  return undefined
}
