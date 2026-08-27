import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsView, type SettingsViewProps } from '../../../src/renderer/src/features/settings/SettingsView'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import {
  MODEL_DOWNLOAD_PRIVACY_NOTICE,
  REMOTE_ASR_PRIVACY_NOTICE,
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
    Object.freeze({ preset: 'instant' as const, repository: 'onnx-community/moonshine-base-ONNX', sourceProvider: 'Hugging Face' as const, sourceHost: 'huggingface.co' as const, revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad', totalBytes: 67_000_000, license: 'MIT' as const, bundled: true }),
    Object.freeze({ preset: 'fast' as const, repository: 'Xenova/whisper-tiny', sourceProvider: 'Hugging Face' as const, sourceHost: 'huggingface.co' as const, revision: '5332fcc35e32a33b86612b9a57a89be7906102b1', totalBytes: 42_000_000, license: 'Apache-2.0' as const, bundled: false }),
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

function baseProps(overrides: Partial<SettingsViewProps> = {}): SettingsViewProps {
  return {
    settings: { ...DEFAULT_SETTINGS, onboardingComplete: true },
    platform: 'win32',
    modelStatuses: {
      instant: { preset: 'instant', state: 'bundled' },
      fast: { preset: 'fast', state: 'missing' },
    },
    mediaDevices: createMediaDevices([device('default', 'Studio microphone')]),
    onUpdateSettings: vi.fn(async () => true),
    onReplaceHotkey: vi.fn(async () => ({ ok: true } as const)),
    onSetStartup: vi.fn(async (enabled) => ({ enabled })),
    onResetSettings: vi.fn(async () => true),
    onClearHistory: vi.fn(async () => true),
    onGetModelStatus: vi.fn(async (preset) => ({ preset, state: preset === 'instant' ? 'bundled' : 'missing' } as ModelStatus)),
    onListModelDisclosures: vi.fn(async () => disclosures),
    onInstallModel: vi.fn(async () => ({ ok: true } as const)),
    onRemoveModel: vi.fn(async () => ({ ok: true } as const)),
    onCheckRemoteAsr: vi.fn(async () => ({ ok: true } as const)),
    ...overrides,
  }
}

const copy = platformCopy('win32')

describe('SettingsView', () => {
  it.each(['light', 'dark'] as const)('renders the complete field matrix in a %s container', async (theme) => {
    render(<div data-theme={theme}><SettingsView {...baseProps()} /></div>)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    for (const name of [
      'Theme', 'Reduced motion', 'Show floating widget when idle', 'Microphone', 'Global shortcut',
      'Maximum recording time', 'Sound cues', 'Language', 'Whitespace formatting',
      'Automatic clipboard copy', 'Automatic paste', 'Paste delay', 'Success message duration',
      copy.settingsLaunchAtStartupLabel, 'Start minimized', 'Keep local history', 'History retention',
    ]) expect(screen.getByRole(name === 'Show floating widget when idle' || name === 'Sound cues' || name === 'Whitespace formatting' || name === 'Automatic clipboard copy' || name === 'Automatic paste' || name === copy.settingsLaunchAtStartupLabel || name === 'Start minimized' || name === 'Keep local history' ? 'switch' : name === 'Global shortcut' || name === 'Paste delay' || name === 'Success message duration' ? 'textbox' : 'combobox', { name })).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Show floating widget when idle' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Automatic clipboard copy' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Automatic clipboard copy' })).toBeDisabled()
  })

  it('saves the widget idle-visibility preference through the ordinary patch flow', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)

    await user.click(screen.getByRole('switch', { name: 'Show floating widget when idle' }))

    expect(update).toHaveBeenCalledWith({ showWidgetWhenIdle: false })
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

  it('keeps the newest microphone enumeration when overlapping refreshes settle out of order', async () => {
    const first = deferred<MediaDeviceInfo[]>()
    const second = deferred<MediaDeviceInfo[]>()
    const mediaDevices = createMediaDevices()
    vi.mocked(mediaDevices.enumerateDevices)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    render(<SettingsView {...baseProps({ mediaDevices })} />)
    await waitFor(() => expect(mediaDevices.addEventListener).toHaveBeenCalled())
    const listener = vi.mocked(mediaDevices.addEventListener).mock.calls[0]?.[1] as EventListener
    act(() => listener(new Event('devicechange')))
    second.resolve([device('newest', 'Newest microphone')])
    expect(await screen.findByRole('option', { name: 'Newest microphone' })).toBeVisible()
    first.resolve([device('stale', 'Stale microphone')])
    await act(async () => undefined)
    expect(screen.getByRole('option', { name: 'Newest microphone' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Stale microphone' })).not.toBeInTheDocument()
  })

  it('ignores a microphone enumeration that settles after unmount', async () => {
    const pending = deferred<MediaDeviceInfo[]>()
    const mediaDevices = createMediaDevices()
    vi.mocked(mediaDevices.enumerateDevices).mockImplementationOnce(() => pending.promise)
    const rendered = render(<SettingsView {...baseProps({ mediaDevices })} />)
    rendered.unmount()
    pending.resolve([device('late', 'Late microphone')])
    await act(async () => undefined)
    expect(mediaDevices.removeEventListener).toHaveBeenCalled()
  })

  it('rolls back a conflicting hotkey with a specialized finite message', async () => {
    const user = userEvent.setup()
    const replace = vi.fn(async () => ({ ok: false as const, reason: 'conflict' as const }))
    render(<SettingsView {...baseProps({ onReplaceHotkey: replace })} />)
    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    await user.clear(input)
    await user.type(input, 'Ctrl+Alt+Space')
    await user.click(screen.getByRole('button', { name: /apply shortcut/i }))
    expect(replace).toHaveBeenCalledWith('CommandOrControl+Alt+Space')
    expect(input).toHaveValue('Ctrl+Shift+Space')
    expect(screen.getByRole('alert')).toHaveTextContent(/another application is already using/i)
  })

  it('shows Windows-friendly shortcut text and translates edits to Electron canonical form', async () => {
    const user = userEvent.setup()
    const replace = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onReplaceHotkey: replace })} />)
    const input = screen.getByRole('textbox', { name: 'Global shortcut' })

    expect(input).toHaveValue('Ctrl+Shift+Space')
    expect(input).not.toHaveValue(expect.stringContaining('CommandOrControl'))
    await user.clear(input)
    await user.type(input, 'Ctrl+Alt+M')
    await user.click(screen.getByRole('button', { name: /apply shortcut/i }))

    expect(replace).toHaveBeenCalledWith('CommandOrControl+Alt+M')
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

  it('does not let an older hotkey result clobber a newer draft, but accepts newer external authority', async () => {
    const user = userEvent.setup()
    const pending = deferred<HotkeyChangeResult>()
    const props = baseProps({ onReplaceHotkey: vi.fn(() => pending.promise) })
    const rendered = render(<SettingsView {...props} />)
    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    await user.clear(input)
    await user.type(input, 'Ctrl+Alt+Space')
    await user.click(screen.getByRole('button', { name: /apply shortcut/i }))
    await user.clear(input)
    await user.type(input, 'Ctrl+Shift+N')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, hotkey: 'Ctrl+Alt+Space' }} />)
    pending.resolve({ ok: false, reason: 'conflict' })
    await act(async () => undefined)
    expect(input).toHaveValue('Ctrl+Shift+N')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, hotkey: 'Alt+M' }} />)
    expect(input).toHaveValue('Alt+M')
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

  it('does not let an older numeric save clobber a newer draft, but accepts newer external authority', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const props = baseProps({ onUpdateSettings: update })
    const rendered = render(<SettingsView {...props} />)
    const delay = screen.getByRole('textbox', { name: 'Paste delay' })
    await user.clear(delay)
    await user.type(delay, '300')
    await user.click(screen.getByRole('button', { name: /save paste delay/i }))
    await user.clear(delay)
    await user.type(delay, '450')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 300 }} />)
    pending.resolve(false)
    await act(async () => undefined)
    expect(delay).toHaveValue('450')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 625 }} />)
    expect(delay).toHaveValue('625')
  })

  it('applies the same response ordering to the success-duration draft', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const props = baseProps({ onUpdateSettings: update })
    const rendered = render(<SettingsView {...props} />)
    const duration = screen.getByRole('textbox', { name: 'Success message duration' })
    await user.clear(duration)
    await user.type(duration, '1500')
    await user.click(screen.getByRole('button', { name: /save success duration/i }))
    await user.clear(duration)
    await user.type(duration, '2200')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, successDisplayMs: 1500 }} />)
    pending.resolve(false)
    await act(async () => undefined)
    expect(duration).toHaveValue('2200')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, successDisplayMs: 3100 }} />)
    expect(duration).toHaveValue('3100')
  })

  it('preserves an unknown persisted language and labels auto honestly', () => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, language: 'cy' } })} />)
    expect(screen.getByRole('option', { name: 'Saved language (cy)' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Automatic (English default)' })).toBeVisible()
    expect(screen.queryByText(/auto-detect/i)).not.toBeInTheDocument()
  })

  it('requests a status for every preset so each model card leaves the checking state', async () => {
    const getStatus = vi.fn(async (preset: ModelStatus['preset']) =>
      ({ preset, state: preset === 'instant' ? 'bundled' : 'missing' } as ModelStatus))
    render(<SettingsView {...baseProps({ onGetModelStatus: getStatus })} />)

    for (const preset of ['instant', 'fast']) {
      expect(getStatus).toHaveBeenCalledWith(preset)
    }
  })

  it('requires returned disclosure and fresh explicit consent before every optional install', async () => {
    const user = userEvent.setup()
    const install = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onInstallModel: install })} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /install multi-lingual/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /install multi-lingual/i }))
    expect(screen.getByText(/ip address and request time/i)).toBeVisible()
    const confirm = screen.getByRole('button', { name: /download multi-lingual model/i })
    expect(confirm).toBeDisabled()
    expect(install).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: /allow this multi-lingual model download/i }))
    await user.click(confirm)
    await waitFor(() => expect(install).toHaveBeenCalledWith({ preset: 'fast', consent: true }))
    await user.click(screen.getByRole('button', { name: /install multi-lingual/i }))
    expect(screen.getByRole('checkbox', { name: /allow this multi-lingual model download/i })).not.toBeChecked()
  })

  it('keeps install progress and errors live inside the busy consent dialog and reports ready only after completion', async () => {
    const user = userEvent.setup()
    const first = deferred<{ ok: false; reason: 'unavailable' }>()
    const second = deferred<{ ok: true }>()
    const install = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const props = baseProps({ onInstallModel: install })
    const rendered = render(<SettingsView {...props} />)
    await user.click(await screen.findByRole('button', { name: /install multi-lingual/i }))
    expect(install).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: /allow this multi-lingual model download/i }))
    await user.click(screen.getByRole('button', { name: /download multi-lingual model/i }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-busy', 'true')
    rendered.rerender(<SettingsView {...props} modelStatuses={{ ...props.modelStatuses, fast: { preset: 'fast', state: 'downloading', progress: 0.42 } }} />)
    expect(within(dialog).getByText(/42%/i)).toBeVisible()
    first.resolve({ ok: false, reason: 'unavailable' })
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(/multi-lingual could not be downloaded/i))

    expect(screen.getByRole('button', { name: /download multi-lingual model/i })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /allow this multi-lingual model download/i }))
    await user.click(screen.getByRole('button', { name: /download multi-lingual model/i }))
    second.resolve({ ok: true })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/multi-lingual is installed and ready/i))
    expect(screen.queryByText(/download started/i)).not.toBeInTheDocument()
  })

  it('does not claim Standard is ready when disclosure lookup and Standard status both fail', async () => {
    render(<SettingsView {...baseProps({
      modelStatuses: { instant: { preset: 'instant', state: 'error' } },
      onListModelDisclosures: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
    })} />)
    expect(await screen.findByText(/no model download can start/i)).toBeVisible()
    expect(screen.queryByText(/standard remains ready/i)).not.toBeInTheDocument()
  })

  it('shows finite model progress and errors and permits selection only when ready', async () => {
    const user = userEvent.setup()
    const statuses = {
      instant: { preset: 'instant', state: 'bundled' as const },
      fast: { preset: 'fast', state: 'downloading' as const, progress: 0.42 },
    }
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, modelPreset: 'fast' }, modelStatuses: statuses, onUpdateSettings: update })} />)
    expect(screen.getByText(/42%/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /use multi-lingual/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /use standard/i }))
    expect(update).toHaveBeenCalledWith({ modelPreset: 'instant' })
  })

  it('selects Standard successfully before removing the selected optional model and never removes Standard', async () => {
    const user = userEvent.setup()
    const order: string[] = []
    const update = vi.fn(async (patch: Partial<AppSettings>) => { order.push(`select:${String(patch.modelPreset)}`); return true })
    const remove = vi.fn(async (preset) => { order.push(`remove:${String(preset)}`); return { ok: true as const } })
    const props = baseProps({
      settings: { ...DEFAULT_SETTINGS, modelPreset: 'fast' },
      modelStatuses: { instant: { preset: 'instant', state: 'bundled' }, fast: { preset: 'fast', state: 'ready' } },
      onUpdateSettings: update as SettingsViewProps['onUpdateSettings'],
      onRemoveModel: remove,
    })
    render(<SettingsView {...props} />)
    expect(screen.queryByRole('button', { name: /remove standard/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /remove multi-lingual/i }))
    await user.click(screen.getByRole('button', { name: /remove downloaded model/i }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('fast'))
    expect(order).toEqual(['select:instant', 'remove:fast'])
  })

  it('does not remove the current optional model when selecting Standard fails', async () => {
    const user = userEvent.setup()
    const remove = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, modelPreset: 'fast' },
      modelStatuses: { instant: { preset: 'instant', state: 'bundled' }, fast: { preset: 'fast', state: 'ready' } },
      onUpdateSettings: vi.fn(async () => false),
      onRemoveModel: remove,
    })} />)
    await user.click(screen.getByRole('button', { name: /remove multi-lingual/i }))
    await user.click(screen.getByRole('button', { name: /remove downloaded model/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not switch to standard/i))
    expect(remove).not.toHaveBeenCalled()
  })

  it.each([
    ['remove', 'The downloaded model could not be removed.'],
    ['clear', 'History could not be cleared.'],
    ['reset', 'Settings could not be reset.'],
  ] as const)('shows a finite %s failure inside the active dialog', async (operation, message) => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      modelStatuses: { instant: { preset: 'instant', state: 'bundled' }, fast: { preset: 'fast', state: 'ready' } },
      onRemoveModel: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
      onClearHistory: vi.fn(async () => false),
      onResetSettings: vi.fn(async () => false),
    })} />)
    if (operation === 'remove') {
      await user.click(screen.getByRole('button', { name: /remove multi-lingual/i }))
      await user.click(screen.getByRole('button', { name: /remove downloaded model/i }))
    } else if (operation === 'clear') {
      await user.click(screen.getByRole('button', { name: /clear history/i }))
      await user.click(screen.getByRole('button', { name: /clear all transcripts/i }))
    } else {
      await user.click(screen.getByRole('button', { name: /reset settings/i }))
      await user.click(screen.getByRole('button', { name: /reset all settings/i }))
    }
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(message)
  })

  it.each(['install', 'remove'] as const)('focuses the Settings heading when successful %s replaces its trigger', async (operation) => {
    const user = userEvent.setup()
    const pending = deferred<{ ok: true }>()
    const props = baseProps({
      modelStatuses: { instant: { preset: 'instant', state: 'bundled' }, fast: { preset: 'fast', state: operation === 'install' ? 'missing' : 'ready' } },
      onInstallModel: vi.fn(() => pending.promise),
      onRemoveModel: vi.fn(() => pending.promise),
    })
    const rendered = render(<SettingsView {...props} />)
    if (operation === 'install') {
      await user.click(await screen.findByRole('button', { name: /install multi-lingual/i }))
      await user.click(screen.getByRole('checkbox', { name: /allow this multi-lingual model download/i }))
      await user.click(screen.getByRole('button', { name: /download multi-lingual model/i }))
      rendered.rerender(<SettingsView {...props} modelStatuses={{ ...props.modelStatuses, fast: { preset: 'fast', state: 'ready' } }} />)
    } else {
      await user.click(screen.getByRole('button', { name: /remove multi-lingual/i }))
      await user.click(screen.getByRole('button', { name: /remove downloaded model/i }))
      rendered.rerender(<SettingsView {...props} modelStatuses={{ ...props.modelStatuses, fast: { preset: 'fast', state: 'missing' } }} />)
    }
    pending.resolve({ ok: true })
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus())
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
    await user.click(screen.getByRole('switch', { name: copy.settingsLaunchAtStartupLabel }))
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
    await user.click(screen.getByRole('switch', { name: 'Whitespace formatting' }))
    await user.click(screen.getByRole('switch', { name: 'Start minimized' }))
    await user.click(screen.getByRole('switch', { name: 'Keep local history' }))
    expect(update).toHaveBeenCalledWith({ reducedMotion: 'on' })
    expect(update).toHaveBeenCalledWith({ maxRecordingSeconds: 120 })
    expect(update).toHaveBeenCalledWith({ soundCues: false })
    expect(update).toHaveBeenCalledWith({ formatWhitespace: false })
    expect(update).toHaveBeenCalledWith({ startMinimized: true })
    expect(update).toHaveBeenCalledWith({ historyEnabled: false })
  })

  it('saves the transcription server address and reports a reachable server', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const check = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onUpdateSettings: update, onCheckRemoteAsr: check })} />)

    await user.type(screen.getByRole('textbox', { name: 'Transcription server' }), 'forge.local:5092')
    await user.click(screen.getByRole('button', { name: /save and test/i }))

    expect(update).toHaveBeenCalledWith({ remoteAsrUrl: 'forge.local:5092' })
    expect(check).toHaveBeenCalledOnce()
    expect(await screen.findByText('Connected. Sotto can reach this server.')).toBeVisible()
  })

  it('explains why an unreachable server failed without saving nothing', async () => {
    const user = userEvent.setup()
    const check = vi.fn(async () => ({ ok: false as const, reason: 'timeout' as const }))
    render(<SettingsView {...baseProps({ onCheckRemoteAsr: check })} />)

    await user.type(screen.getByRole('textbox', { name: 'Transcription server' }), 'forge.local:5092')
    await user.click(screen.getByRole('button', { name: /save and test/i }))

    expect(await screen.findByText(/did not answer/i)).toBeVisible()
  })

  it('asks for an address before probing an empty field', async () => {
    const user = userEvent.setup()
    const check = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onCheckRemoteAsr: check })} />)

    await user.click(screen.getByRole('button', { name: /save and test/i }))

    expect(check).not.toHaveBeenCalled()
    expect(await screen.findByText('Enter a server address first.')).toBeVisible()
  })

  it('locks the remote toggle until an address is saved and discloses the audio upload', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const { rerender } = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)

    const toggle = screen.getByRole('switch', { name: 'Use the transcription server' })
    expect(toggle).toBeDisabled()
    expect(screen.getByText(REMOTE_ASR_PRIVACY_NOTICE)).toBeVisible()

    rerender(<SettingsView {...baseProps({
      onUpdateSettings: update,
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, remoteAsrUrl: 'http://forge.local:5092' },
    })} />)

    await user.click(screen.getByRole('switch', { name: 'Use the transcription server' }))
    expect(update).toHaveBeenCalledWith({ remoteAsr: true })
  })

  it('renders the macOS copy row and canonicalizes shortcuts through the darwin aliases', async () => {
    const user = userEvent.setup()
    const macCopy = platformCopy('darwin')
    const replace = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ platform: 'darwin', onReplaceHotkey: replace })} />)

    expect(screen.getByRole('switch', { name: macCopy.settingsLaunchAtStartupLabel })).toBeVisible()
    expect(screen.getByRole('option', { name: macCopy.settingsMicrophoneDefaultOption })).toBeVisible()
    expect(screen.getByText(macCopy.settingsGlobalShortcutDescription)).toBeVisible()
    expect(screen.getByText(macCopy.settingsAutoPasteDescription)).toBeVisible()
    expect(screen.getByText(macCopy.settingsThemeDescription)).toBeVisible()
    expect(screen.queryByRole('switch', { name: copy.settingsLaunchAtStartupLabel })).not.toBeInTheDocument()

    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    expect(input).toHaveValue('Command+Shift+Space')
    await user.clear(input)
    await user.type(input, 'Control+Shift+Space')
    await user.click(screen.getByRole('button', { name: /apply shortcut/i }))

    expect(replace).toHaveBeenCalledWith('Control+Shift+Space')
  })
})
