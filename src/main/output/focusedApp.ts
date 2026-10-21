import { execFile } from 'node:child_process'

import { deliveredAppName } from '../../shared/dictationRecord'
import type { PasteInvocation } from './pasteCommand'
import { buildLinuxPasteInvocation, runLinuxPasteCommand } from './pasteCommand.linux'

/**
 * Readers for the delivered app (ADR-0100): the name of the app that has focus as Sotto delivers a dictation. Each asks
 * the system for the app's display name only, never a window title or anything read from the app, needs no permission
 * Sotto does not already have, and answers null whenever the name cannot be read. Windows asks the warm paste helper
 * (`pasteHelper.ts`).
 */
export type FocusedAppReader = () => Promise<string | null>

/** Runs a program without a shell and answers its standard output. */
export type RunProgram = (executable: string, args: readonly string[], timeoutMs: number) => Promise<string>

/** How long one system query may take before delivery goes on without a name. */
export const FOCUSED_APP_TIMEOUT_MS = 1_000

export const runProgram: RunProgram = (executable, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { shell: false, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
    (error, stdout) => { if (error) reject(error); else resolve(stdout) })
})

// Absolute path so a PATH entry cannot stand in for it. lsappinfo asks Launch Services, which needs no Automation or
// Accessibility grant; System Events would ask for Automation, so it is never used for this.
const LSAPPINFO = '/usr/bin/lsappinfo'

/** The front application's serial number from `lsappinfo front`, such as `ASN:0x0-0x1d01d:`; null for anything else. */
export function parseLsappinfoFront(stdout: string): string | null {
  const serial = stdout.trim()
  return /^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/iu.test(serial) ? serial : null
}

/** The display name from `lsappinfo info -only name <ASN>`, whose answer reads `"LSDisplayName"="Mail"`. */
export function parseLsappinfoName(stdout: string): string | null {
  const match = /^\s*"(?:LSDisplayName|name|CFBundleName)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/mu.exec(stdout)
  if (match === null) return null
  return deliveredAppName(match[1]!.replace(/\\(.)/gu, '$1'))
}

/** macOS: the frontmost application's display name, through `lsappinfo`. NOT VERIFIED on a Mac (see ADR-0100). */
export function createLsappinfoFocusedApp(run: RunProgram = runProgram): FocusedAppReader {
  return async () => {
    const serial = parseLsappinfoFront(await run(LSAPPINFO, ['front'], FOCUSED_APP_TIMEOUT_MS))
    if (serial === null) return null
    return parseLsappinfoName(await run(LSAPPINFO, ['info', '-only', 'name', serial], FOCUSED_APP_TIMEOUT_MS))
  }
}

/**
 * A readable name for a Hyprland window class: the last part of a reverse-DNS id (`org.gnome.Nautilus` reads
 * `Nautilus`), and a lowercase class with its first letter raised and its dashes as spaces (`brave-browser` reads
 * `Brave browser`). Any other class is kept as it is.
 */
export function readableWindowClass(windowClass: string): string | null {
  let name = windowClass.trim()
  if (/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}$/u.test(name)) name = name.slice(name.lastIndexOf('.') + 1)
  if (/^[a-z0-9_-]+$/u.test(name)) name = name.replace(/[_-]+/gu, ' ').trim().replace(/^./u, letter => letter.toUpperCase())
  return deliveredAppName(name)
}

/** The delivered app from `hyprctl activewindow -j`: its class, or its first class, and never its title. */
export function hyprlandAppName(activeWindow: unknown): string | null {
  if (activeWindow === null || typeof activeWindow !== 'object') return null
  const record = activeWindow as { readonly class?: unknown; readonly initialClass?: unknown }
  const windowClass = typeof record.class === 'string' && record.class.trim() !== '' ? record.class : record.initialClass
  return typeof windowClass === 'string' ? readableWindowClass(windowClass) : null
}

/** Linux on Hyprland: the active window's class, read with the same `hyprctl activewindow -j` the paste runs. */
export function createHyprlandFocusedApp(
  run: (invocation: PasteInvocation, timeoutMs?: number) => Promise<string> = runLinuxPasteCommand,
): FocusedAppReader {
  return async () => hyprlandAppName(JSON.parse(await run(buildLinuxPasteInvocation(), FOCUSED_APP_TIMEOUT_MS)) as unknown)
}
