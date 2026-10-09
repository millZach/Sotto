import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, vi } from 'vitest'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { type SettingsViewProps } from '../../../src/renderer/src/features/settings/SettingsView'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'
import { useVoiceCoordinatorEnabled } from '../../../src/renderer/src/state/voiceCoordinator'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: vi.fn(),
}))

// Settings is rendered without the app provider the real hook reads, so the
// beta's voice gate is stated here rather than inferred from a context.
vi.mock('../../../src/renderer/src/state/voiceCoordinator', () => ({
  useVoiceCoordinatorEnabled: vi.fn(() => false),
}))

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.reducedMotion
  appearancePreview.reset()
  vi.mocked(useOptionalAgents).mockReset()
  vi.mocked(useVoiceCoordinatorEnabled).mockReturnValue(false)
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



function baseProps(overrides: Partial<SettingsViewProps> = {}): SettingsViewProps {
  return {
    settings: { ...DEFAULT_SETTINGS, onboardingComplete: true },
    platform: 'win32',
    mediaDevices: createMediaDevices([device('default', 'Studio microphone')]),
    onUpdateSettings: vi.fn(async () => true),
    onReplaceHotkey: vi.fn(async () => ({ ok: true } as const)),
    onSetStartup: vi.fn(async (enabled) => ({ enabled })),
    onResetSettings: vi.fn(async () => true),
    onClearHistory: vi.fn(async () => true),
    onCheckTranscriptionKey: vi.fn(async () => ({ ok: true } as const)),
    updateStatus: { currentVersion: '3.4.0', phase: { phase: 'up-to-date' }, checkedAt: null },
    onCheckForUpdates: vi.fn(async () => null),
    onDownloadUpdate: vi.fn(async () => true),
    onInstallUpdate: vi.fn(async () => true),
    ...overrides,
  }
}

const copy = platformCopy('win32')

async function selectCategory(name: string): Promise<void> {
  await userEvent.click(screen.getByRole('tab', { name }))
}

export { createMediaDevices, device, baseProps, copy, selectCategory }

export { deferred } from '../deferred'
