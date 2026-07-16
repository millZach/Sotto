import { isAbsolute } from 'node:path'

import {
  E2E_CONFLICTING_HOTKEY,
  E2E_PRESERVED_CLIPBOARD,
  e2eScenarioSchema,
  type E2EScenario,
  type E2ESnapshot,
} from '../../shared/e2e'
import {
  MODEL_DOWNLOAD_PRIVACY_NOTICE,
  type ModelDisclosureCatalog,
  type ModelStatus,
} from '../../shared/contracts'
import type { ModelPreset } from '../../shared/settings'
import type { GlobalShortcutAdapter } from '../hotkeys/hotkeyManager'
import type { ClipboardAdapter, PasteProcessAdapter } from '../output/outputService'

export interface E2EConfiguration {
  readonly scenario: E2EScenario
  readonly userDataPath: string
}

export interface E2EEnvironment {
  readonly TALKTYPE_E2E?: string | undefined
  readonly TALKTYPE_E2E_SCENARIO?: string | undefined
  readonly TALKTYPE_E2E_USER_DATA?: string | undefined
}

export function resolveE2EConfiguration(
  isPackaged: boolean,
  environment: E2EEnvironment,
): E2EConfiguration | null {
  if (isPackaged || environment.TALKTYPE_E2E !== '1') return null
  const scenario = e2eScenarioSchema.safeParse(environment.TALKTYPE_E2E_SCENARIO ?? 'success')
  const userDataPath = environment.TALKTYPE_E2E_USER_DATA
  if (!scenario.success || userDataPath === undefined || !isAbsolute(userDataPath)) return null
  return Object.freeze({ scenario: scenario.data, userDataPath })
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

export function createE2EClipboard(state: E2ENativeState): ClipboardAdapter {
  return { writeText: (text) => { state.clipboardText = text } }
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
  return {
    register(accelerator, callback): boolean {
      if (scenario === 'hotkey-conflict' && accelerator === E2E_CONFLICTING_HOTKEY) return false
      if (registered.has(accelerator)) return false
      registered.set(accelerator, callback)
      return true
    },
    unregister(accelerator): void { registered.delete(accelerator) },
    isRegistered(accelerator): boolean { return registered.has(accelerator) },
    trigger(accelerator): boolean {
      const callback = registered.get(accelerator)
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

export function createE2EModelOperations(): {
  disclosures(): ModelDisclosureCatalog
  status(preset: ModelPreset): Promise<ModelStatus>
  install(preset: ModelPreset): Promise<void>
  remove(preset: ModelPreset): Promise<void>
} {
  const states = new Map<ModelPreset, ModelStatus['state']>([
    ['fast', 'missing'],
    ['balanced', 'bundled'],
    ['accurate', 'missing'],
  ])
  const disclosures = Object.freeze({
    models: Object.freeze([
      Object.freeze({ preset: 'fast' as const, repository: 'Xenova/whisper-tiny', sourceProvider: 'Hugging Face' as const, sourceHost: 'huggingface.co' as const, revision: '5332fcc35e32a33b86612b9a57a89be7906102b1', totalBytes: 40_000_000, license: 'Apache-2.0' as const, bundled: false }),
      Object.freeze({ preset: 'balanced' as const, repository: 'Xenova/whisper-base', sourceProvider: 'Hugging Face' as const, sourceHost: 'huggingface.co' as const, revision: '64da57285918e20ea79ea5c88eed7197933abaa8', totalBytes: 77_000_000, license: 'Apache-2.0' as const, bundled: true }),
      Object.freeze({ preset: 'accurate' as const, repository: 'Xenova/whisper-small', sourceProvider: 'Hugging Face' as const, sourceHost: 'huggingface.co' as const, revision: '2d67713f236afa48a18992566e7647f6ca848e13', totalBytes: 250_000_000, license: 'Apache-2.0' as const, bundled: false }),
    ]),
    optionalDownloadNotice: MODEL_DOWNLOAD_PRIVACY_NOTICE,
  })
  return {
    disclosures: () => disclosures,
    async status(preset) { return { preset, state: states.get(preset) ?? 'missing' } },
    async install(preset) { if (preset !== 'balanced') states.set(preset, 'ready') },
    async remove(preset) { if (preset !== 'balanced') states.set(preset, 'missing') },
  }
}
