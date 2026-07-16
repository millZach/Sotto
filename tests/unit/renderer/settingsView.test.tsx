import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsView, type SettingsViewProps } from '../../../src/renderer/src/features/settings/SettingsView'
import {
  MODEL_DOWNLOAD_PRIVACY_NOTICE,
  type HotkeyChangeResult,
  type ModelDisclosureCatalog,
  type ModelStatus,
} from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.reducedMotion
})

const disclosures: ModelDisclosureCatalog = Object.freeze({
  models: Object.freeze([
    Object.freeze({ preset: 'fast' as const, repository: 'Xenova/whisper-tiny', sourceProvider: 'Hugging Face' as const, sourceHost: 'huggingface.co' as const, revision: '5332fcc35e32a33b86612b9a57a89be7906102b1', totalBytes: 42_000_000, license: 'Apache-2.0' as const, bundled: false }),
    Object.freeze({ preset: 'balanced' as const, repository: 'Xenova/whisper-base', sourceProvider: 'Hugging Face' as const, sourceHost: 'huggingface.co' as const, revision: '64da57285918e20ea79ea5c88eed7197933abaa8', totalBytes: 82_000_000, license: 'Apache-2.0' as const, bundled: true }),
    Object.freeze({ preset: 'accurate' as const, repository: 'Xenova/whisper-small', sourceProvider: 'Hugging Face' as const, sourceHost: 'huggingface.co' as const, revision: '2d67713f236afa48a18992566e7647f6ca848e13', totalBytes: 125_000_000, license: 'Apache-2.0' as const, bundled: false }),
  ]),
  optionalDownloadNotice: MODEL_DOWNLOAD_PRIVACY_NOTICE,
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
    modelStatuses: {
      balanced: { preset: 'balanced', state: 'bundled' },
      fast: { preset: 'fast', state: 'missing' },
      accurate: { preset: 'accurate', state: 'missing' },
    },
    mediaDevices: createMediaDevices([device('default', 'Studio microphone')]),
    onUpdateSettings: vi.fn(async () => true),
    onReplaceHotkey: vi.fn(async () => ({ ok: true } as const)),
    onSetStartup: vi.fn(async (enabled) => ({ enabled })),
    onResetSettings: vi.fn(async () => true),
    onClearHistory: vi.fn(async () => true),
    onGetModelStatus: vi.fn(async (preset) => ({ preset, state: preset === 'balanced' ? 'bundled' : 'missing' } as ModelStatus)),
    onListModelDisclosures: vi.fn(async () => disclosures),
    onInstallModel: vi.fn(async () => ({ ok: true } as const)),
    onRemoveModel: vi.fn(async () => ({ ok: true } as const)),
    ...overrides,
  }
}

describe('SettingsView', () => {
  it.each(['light', 'dark'] as const)('renders the complete field matrix in a %s container', async (theme) => {
    render(<div data-theme={theme}><SettingsView {...baseProps()} /></div>)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    for (const name of [
      'Theme', 'Reduced motion', 'Microphone', 'Global shortcut', 'Maximum recording time',
      'Sound cues', 'Language', 'Inference', 'Whitespace formatting', 'Automatic clipboard copy',
      'Automatic paste', 'Paste delay', 'Success message duration', 'Launch when Windows starts',
      'Start minimized', 'Keep local history', 'History retention',
    ]) expect(screen.getByRole(name === 'Sound cues' || name === 'Whitespace formatting' || name === 'Automatic clipboard copy' || name === 'Automatic paste' || name === 'Launch when Windows starts' || name === 'Start minimized' || name === 'Keep local history' ? 'switch' : name === 'Global shortcut' || name === 'Paste delay' || name === 'Success message duration' ? 'textbox' : 'combobox', { name })).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Automatic clipboard copy' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Automatic clipboard copy' })).toBeDisabled()
  })

  it('applies theme immediately and resynchronizes numeric drafts from authoritative settings', async () => {
    const user = userEvent.setup()
    let resolveTheme!: (saved: boolean) => void
    const update = vi.fn(() => new Promise<boolean>((done) => { resolveTheme = done }))
    const props = baseProps({ onUpdateSettings: update })
    const rendered = render(<SettingsView {...props} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'dark')
    expect(update).toHaveBeenCalledWith({ theme: 'dark' })
    expect(document.documentElement.dataset.theme).toBe('dark')
    resolveTheme(true)
    await act(async () => undefined)

    const delay = screen.getByRole('textbox', { name: 'Paste delay' })
    await user.clear(delay)
    await user.type(delay, '999')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 275 }} />)
    expect(delay).toHaveValue('275')
  })

  it('keeps the newest immediate theme when an older save fails later', async () => {
    const user = userEvent.setup()
    const saves: Array<{ patch: unknown; resolve: (saved: boolean) => void }> = []
    const update = vi.fn((patch: unknown) => new Promise<boolean>((resolve) => saves.push({ patch, resolve })))
    render(<SettingsView {...baseProps({ onUpdateSettings: update as SettingsViewProps['onUpdateSettings'] })} />)
    const theme = screen.getByRole('combobox', { name: 'Theme' })
    await user.selectOptions(theme, 'dark')
    await user.selectOptions(theme, 'light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(saves.map(({ patch }) => patch)).toEqual([{ theme: 'dark' }, { theme: 'light' }])
    saves[0]?.resolve(false)
    await act(async () => undefined)
    expect(document.documentElement.dataset.theme).toBe('light')
    saves[1]?.resolve(true)
    await act(async () => undefined)
  })

  it('enumerates microphones, preserves an unknown persisted choice, and refreshes on devicechange', async () => {
    const mediaDevices = createMediaDevices([device('new', 'Desk microphone')])
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneId: 'missing' }, mediaDevices })} />)
    expect(screen.getByRole('option', { name: /previous microphone \(unavailable\)/i })).toHaveValue('missing')
    expect(await screen.findByRole('option', { name: 'Desk microphone' })).toBeVisible()
    const listener = vi.mocked(mediaDevices.addEventListener).mock.calls.find(([name]) => name === 'devicechange')?.[1]
    expect(listener).toBeTypeOf('function')
    await act(async () => { (listener as EventListener)(new Event('devicechange')) })
    expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2)
  })

  it('removes the devicechange listener on unmount', async () => {
    const mediaDevices = createMediaDevices()
    const mounted = render(<SettingsView {...baseProps({ mediaDevices })} />)
    await waitFor(() => expect(mediaDevices.addEventListener).toHaveBeenCalled())
    const listener = vi.mocked(mediaDevices.addEventListener).mock.calls[0]?.[1]
    mounted.unmount()
    expect(mediaDevices.removeEventListener).toHaveBeenCalledWith('devicechange', listener)
  })

  it('rolls back a conflicting hotkey with a specialized finite message', async () => {
    const user = userEvent.setup()
    const replace = vi.fn(async () => ({ ok: false as const, reason: 'conflict' as const }))
    render(<SettingsView {...baseProps({ onReplaceHotkey: replace })} />)
    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    await user.clear(input)
    await user.type(input, 'Ctrl+Alt+Space')
    await user.click(screen.getByRole('button', { name: /apply shortcut/i }))
    expect(replace).toHaveBeenCalledWith('Ctrl+Alt+Space')
    expect(input).toHaveValue(DEFAULT_SETTINGS.hotkey)
    expect(screen.getByRole('alert')).toHaveTextContent(/another application is already using/i)
  })

  it('rolls a delayed hotkey conflict back to the newest authoritative shortcut', async () => {
    const user = userEvent.setup()
    let resolve!: (result: HotkeyChangeResult) => void
    const replace = vi.fn(() => new Promise<HotkeyChangeResult>((done) => { resolve = done }))
    const props = baseProps({ onReplaceHotkey: replace })
    const rendered = render(<SettingsView {...props} />)
    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    await user.clear(input)
    await user.type(input, 'Ctrl+Alt+Space')
    await user.click(screen.getByRole('button', { name: /apply shortcut/i }))
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, hotkey: 'Ctrl+Shift+M' }} />)
    resolve({ ok: false, reason: 'conflict' })
    await waitFor(() => expect(input).toHaveValue('Ctrl+Shift+M'))
  })

  it('rejects invalid numeric drafts before IPC and enforces documented bounds', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    const delay = screen.getByRole('textbox', { name: 'Paste delay' })
    await user.clear(delay)
    await user.type(delay, '49')
    await user.click(screen.getByRole('button', { name: /save paste delay/i }))
    expect(update).not.toHaveBeenCalledWith({ pasteDelayMs: 49 })
    expect(screen.getByText(/between 50 and 1000/i)).toBeVisible()
    const duration = screen.getByRole('textbox', { name: 'Success message duration' })
    await user.clear(duration)
    await user.type(duration, 'not a number')
    await user.click(screen.getByRole('button', { name: /save success duration/i }))
    expect(update).not.toHaveBeenCalled()
  })

  it('preserves an unknown persisted language and labels auto honestly', () => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, language: 'cy' } })} />)
    expect(screen.getByRole('option', { name: 'Saved language (cy)' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Automatic (English default)' })).toBeVisible()
    expect(screen.queryByText(/auto-detect/i)).not.toBeInTheDocument()
  })

  it('requires returned disclosure and fresh explicit consent before every optional install', async () => {
    const user = userEvent.setup()
    const install = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onInstallModel: install })} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /install fast/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /install fast/i }))
    expect(screen.getByText(/ip address and request time/i)).toBeVisible()
    const confirm = screen.getByRole('button', { name: /download fast model/i })
    expect(confirm).toBeDisabled()
    expect(install).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: /allow this fast model download/i }))
    await user.click(confirm)
    await waitFor(() => expect(install).toHaveBeenCalledWith({ preset: 'fast', consent: true }))
    await user.click(screen.getByRole('button', { name: /install fast/i }))
    expect(screen.getByRole('checkbox', { name: /allow this fast model download/i })).not.toBeChecked()
  })

  it('does not claim Balanced is ready when disclosure lookup and Balanced status both fail', async () => {
    render(<SettingsView {...baseProps({
      modelStatuses: { balanced: { preset: 'balanced', state: 'error' } },
      onListModelDisclosures: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
    })} />)
    expect(await screen.findByText(/no model download can start/i)).toBeVisible()
    expect(screen.queryByText(/balanced remains ready/i)).not.toBeInTheDocument()
  })

  it('shows finite model progress and errors and permits selection only when ready', async () => {
    const user = userEvent.setup()
    const statuses = {
      balanced: { preset: 'balanced', state: 'bundled' as const },
      fast: { preset: 'fast', state: 'downloading' as const, progress: 0.42 },
      accurate: { preset: 'accurate', state: 'error' as const },
    }
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, modelPreset: 'accurate' }, modelStatuses: statuses, onUpdateSettings: update })} />)
    expect(screen.getByText(/42%/i)).toBeVisible()
    expect(screen.getByText(/accurate model could not be prepared/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /use fast/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /use balanced/i }))
    expect(update).toHaveBeenCalledWith({ modelPreset: 'balanced' })
  })

  it('selects Balanced successfully before removing the selected optional model and never removes Balanced', async () => {
    const user = userEvent.setup()
    const order: string[] = []
    const update = vi.fn(async (patch: Partial<AppSettings>) => { order.push(`select:${String(patch.modelPreset)}`); return true })
    const remove = vi.fn(async (preset) => { order.push(`remove:${String(preset)}`); return { ok: true as const } })
    const props = baseProps({
      settings: { ...DEFAULT_SETTINGS, modelPreset: 'fast' },
      modelStatuses: { balanced: { preset: 'balanced', state: 'bundled' }, fast: { preset: 'fast', state: 'ready' }, accurate: { preset: 'accurate', state: 'missing' } },
      onUpdateSettings: update as SettingsViewProps['onUpdateSettings'],
      onRemoveModel: remove,
    })
    render(<SettingsView {...props} />)
    expect(screen.queryByRole('button', { name: /remove balanced/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /remove fast/i }))
    await user.click(screen.getByRole('button', { name: /remove downloaded model/i }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('fast'))
    expect(order).toEqual(['select:balanced', 'remove:fast'])
  })

  it('does not remove the current optional model when selecting Balanced fails', async () => {
    const user = userEvent.setup()
    const remove = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, modelPreset: 'fast' },
      modelStatuses: { balanced: { preset: 'balanced', state: 'bundled' }, fast: { preset: 'fast', state: 'ready' } },
      onUpdateSettings: vi.fn(async () => false),
      onRemoveModel: remove,
    })} />)
    await user.click(screen.getByRole('button', { name: /remove fast/i }))
    await user.click(screen.getByRole('button', { name: /remove downloaded model/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not switch to balanced/i))
    expect(remove).not.toHaveBeenCalled()
  })

  it('wires startup, auto-paste, retention, reset, and clear-history controls', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const startup = vi.fn(async (enabled) => ({ enabled }))
    const reset = vi.fn(async () => true)
    const clear = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, onSetStartup: startup, onResetSettings: reset, onClearHistory: clear })} />)
    await user.click(screen.getByRole('switch', { name: 'Automatic paste' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'History retention' }), '500')
    await user.click(screen.getByRole('switch', { name: 'Launch when Windows starts' }))
    expect(update).toHaveBeenCalledWith({ autoPaste: false })
    expect(update).toHaveBeenCalledWith({ historyRetention: 500 })
    expect(startup).toHaveBeenCalledWith(true)

    await user.click(screen.getByRole('button', { name: /reset settings/i }))
    await user.click(screen.getByRole('button', { name: /reset all settings/i }))
    expect(reset).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: /clear history/i }))
    await user.click(screen.getByRole('button', { name: /clear all transcripts/i }))
    expect(clear).toHaveBeenCalledOnce()
  })

  it('wires the remaining capture, transcription, motion, minimized, and privacy fields', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reduced motion' }), 'on')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Maximum recording time' }), '120')
    await user.click(screen.getByRole('switch', { name: 'Sound cues' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Inference' }), 'wasm')
    await user.click(screen.getByRole('switch', { name: 'Whitespace formatting' }))
    await user.click(screen.getByRole('switch', { name: 'Start minimized' }))
    await user.click(screen.getByRole('switch', { name: 'Keep local history' }))
    expect(update).toHaveBeenCalledWith({ reducedMotion: 'on' })
    expect(update).toHaveBeenCalledWith({ maxRecordingSeconds: 120 })
    expect(update).toHaveBeenCalledWith({ soundCues: false })
    expect(update).toHaveBeenCalledWith({ inferencePreference: 'wasm' })
    expect(update).toHaveBeenCalledWith({ formatWhitespace: false })
    expect(update).toHaveBeenCalledWith({ startMinimized: true })
    expect(update).toHaveBeenCalledWith({ historyEnabled: false })
  })
})
