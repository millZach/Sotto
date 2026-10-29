import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, vi } from 'vitest'

import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { type SettingsViewProps } from '../../../src/renderer/src/features/settings/SettingsView'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { PARAKEET_V3, speechModelBytes, type SpeechModelOption } from '../../../src/shared/speechModel'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: vi.fn(),
}))

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.reducedMotion
  appearancePreview.reset()
  vi.mocked(useOptionalAgents).mockReset()
})

function createMediaDevices(devices: MediaDeviceInfo[] = []): Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'> {
  return {
    enumerateDevices: vi.fn(async () => devices),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

function device(deviceId: string, label: string): MediaDeviceInfo {
  return { deviceId, groupId: 'group', kind: 'audioinput', label, toJSON: () => ({}) }
}

const SOTTO_MODEL: SpeechModelOption = { id: PARAKEET_V3.id, name: 'Parakeet v3', maker: 'NVIDIA', languages: '25 European languages', source: 'sotto', installed: true, bytes: speechModelBytes(PARAKEET_V3) }
const ULTRA_MODEL: SpeechModelOption = { id: 'fluidaudio:parakeet-ultra', name: 'Parakeet Ultra', maker: 'Moondream', languages: '25 European languages', source: 'fluidaudio', installed: true, bytes: 2_400_000_000 }

function baseProps(overrides: Partial<SettingsViewProps> = {}): SettingsViewProps {
  return {
    settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, speechModel: PARAKEET_V3.id },
    platform: 'win32',
    mediaDevices: createMediaDevices([device('default', 'Studio microphone')]),
    onUpdateSettings: vi.fn(async () => true),
    onReplaceHotkey: vi.fn(async () => ({ ok: true } as const)),
    onReplaceDictationShortcuts: vi.fn(async () => ({ ok: true } as const)),
    onSetStartup: vi.fn(async (enabled) => ({ enabled })),
    onResetSettings: vi.fn(async () => true),
    onClearHistory: vi.fn(async () => true),
    onCheckOpenRouterKey: vi.fn(async () => ({ ok: true } as const)),
    onListOpenRouterModels: vi.fn(async () => ({ ok: true as const, complete: true, models: [] })),
    onListCloudSpeechModels: vi.fn(async () => ({ ok: true as const, models: [] })),
    speechModel: { state: 'ready' },
    onDownloadSpeechModel: vi.fn(),
    speechModels: [SOTTO_MODEL],
    onChooseSpeechModel: vi.fn(),
    updateStatus: { currentVersion: '3.4.0', phase: { phase: 'up-to-date' }, checkedAt: null },
    onCheckForUpdates: vi.fn(async () => null),
    onDownloadUpdate: vi.fn(async () => true),
    onInstallUpdate: vi.fn(async () => true),
    ...overrides,
  }
}

const copy = platformCopy('win32')

/** Opens a Settings page by its name in the rail; the rail's foot has a Threads tab of its own, so only the pages count. */
async function selectCategory(name: string): Promise<void> {
  await userEvent.click(settingsTab(name))
}

function settingsTab(name: string): HTMLElement {
  return within(screen.getByRole('tablist', { name: 'Settings sections' })).getByRole('tab', { name })
}

export { createMediaDevices, device, baseProps, copy, selectCategory, settingsTab, SOTTO_MODEL, ULTRA_MODEL }

export { deferred } from '../deferred'
