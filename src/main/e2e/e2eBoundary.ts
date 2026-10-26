import { isAbsolute } from 'node:path'

import {
  E2E_CONFLICTING_HOTKEY,
  E2E_PRESERVED_CLIPBOARD,
  e2eScenarioSchema,
  type E2EScenario,
  type E2ESnapshot,
} from '../../shared/e2e'
import { chordTokenSet } from '../hotkeys/dictationShortcutRouter'
import type { GlobalShortcutAdapter } from '../hotkeys/hotkeyManager'
import type { ClipboardAdapter, PasteProcessAdapter } from '../output/outputService'

export interface E2EConfiguration {
  readonly scenario: E2EScenario
  readonly userDataPath: string
}

export interface E2EEnvironment {
  readonly SOTTO_E2E?: string | undefined
  readonly SOTTO_E2E_SCENARIO?: string | undefined
  readonly SOTTO_E2E_USER_DATA?: string | undefined
}

export function resolveE2EConfiguration(
  isPackaged: boolean,
  environment: E2EEnvironment,
): E2EConfiguration | null {
  if (isPackaged || environment.SOTTO_E2E !== '1') return null
  const scenario = e2eScenarioSchema.safeParse(environment.SOTTO_E2E_SCENARIO ?? 'success')
  const userDataPath = environment.SOTTO_E2E_USER_DATA
  if (!scenario.success || userDataPath === undefined || !isAbsolute(userDataPath)) return null
  return Object.freeze({ scenario: scenario.data, userDataPath })
}

/** The exit code an e2e-launched main ends with after an uncaught exception, so the test that launched it fails. */
export const E2E_UNCAUGHT_EXIT_CODE = 70

/**
 * An e2e-launched main never shows Electron's native uncaught-exception box (#1577). With no listener, Electron calls
 * `dialog.showErrorBox`, which lands on the desktop of whoever runs the suite and blocks main until it is dismissed, so
 * the test hangs to its deadline instead of failing. Here the error goes to stderr, where Playwright shows it, and main
 * exits. Only an e2e launch installs this; a packaged build never resolves an e2e configuration.
 */
export function failE2EOnUncaughtException(
  target: { on(event: 'uncaughtException', listener: (error: unknown) => void): unknown },
  write: (text: string) => void,
  exit: (code: number) => void,
): void {
  target.on('uncaughtException', (error) => {
    const detail = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)
    try { write(`[Sotto] e2e-uncaught-exception ${detail}\n`) } finally { exit(E2E_UNCAUGHT_EXIT_CODE) }
  })
}

export interface E2ENativeState {
  clipboardText: string
  pasteAttempts: number
}

export function isTrustedMainE2ESender(
  sender: unknown,
  renderers: readonly Readonly<{ role: string; webContents: unknown }>[],
): boolean {
  return renderers.some((renderer) => renderer.role === 'main' && renderer.webContents === sender)
}

export function createE2ENativeState(): E2ENativeState {
  return { clipboardText: E2E_PRESERVED_CLIPBOARD, pasteAttempts: 0 }
}

export function createE2EClipboard(state: E2ENativeState, scenario?: E2EScenario): ClipboardAdapter {
  let attempts = 0
  if (scenario === 'desktop-clipboard-unavailable') {
    // Electron accepted the text, but Wayland still owns the old desktop selection.
    return { writeText: () => undefined, canPaste: () => false }
  }
  return { writeText: (text) => {
    attempts++
    if (scenario === 'clipboard-recovery' && attempts <= 3) throw new Error('Synthetic clipboard unavailable')
    state.clipboardText = text
  } }
}

export function createE2EPasteProcess(
  state: E2ENativeState,
  scenario: E2EScenario,
  insertText: (text: string) => void,
): PasteProcessAdapter {
  return {
    run(): boolean {
      state.pasteAttempts += 1
      if (scenario === 'paste-failure') return false
      insertText(state.clipboardText)
      return true
    },
  }
}

export interface E2EGlobalShortcutAdapter extends GlobalShortcutAdapter {
  trigger(accelerator: string): boolean
}

export function createE2EGlobalShortcuts(scenario: E2EScenario): E2EGlobalShortcutAdapter {
  const registered = new Map<string, () => void>()
  // Like Electron, the same chord in any order or spelling is one shortcut.
  const canonical = (accelerator: string): string => chordTokenSet(accelerator, 'win32')
  const conflict = canonical(E2E_CONFLICTING_HOTKEY)
  return {
    register(accelerator, callback): boolean {
      const key = canonical(accelerator)
      if (scenario === 'hotkey-conflict' && key === conflict) return false
      if (registered.has(key)) return false
      registered.set(key, callback)
      return true
    },
    unregister(accelerator): void { registered.delete(canonical(accelerator)) },
    isRegistered(accelerator): boolean { return registered.has(canonical(accelerator)) },
    trigger(accelerator): boolean {
      const callback = registered.get(canonical(accelerator))
      if (callback === undefined) return false
      callback()
      return true
    },
  }
}

export function snapshotE2EState(
  state: E2ENativeState,
  mainVisible: boolean,
): E2ESnapshot {
  return Object.freeze({
    clipboardText: state.clipboardText,
    pasteAttempts: state.pasteAttempts,
    mainVisible,
  })
}
