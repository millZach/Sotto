import { deferred } from '../../../../fixtures/deferred'
import { createMediaDevices, device, baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { platformCopy } from '../../../../../src/renderer/src/platformCopy'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'

describe('SettingsView', () => {
  it.each(['denied', 'missing', 'error'] as const)('keeps a %s test result after category changes and hiding', async outcome => {
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({ start: vi.fn(async () => outcome), stop: vi.fn(async () => undefined) }) })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await waitFor(() => expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', outcome))
    await selectCategory('Output')
    await selectCategory('Dictation')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    try { expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', outcome) } finally { vi.restoreAllMocks() }
  })

  it('replaces listening with missing when the running input ends', async () => {
    let ended!: () => void
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({
      start: vi.fn(async (_level, _id, onEnded) => { ended = () => onEnded?.('missing'); return 'ready' as const }),
      stop: vi.fn(async () => undefined),
    }) })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByRole('button', { name: 'Stop test' })
    act(() => ended())
    expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', 'missing')
    expect(screen.queryByText('Listening. Say something.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop test' })).not.toBeInTheDocument()
    await selectCategory('Output')
    await selectCategory('Dictation')
    expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', 'missing')
  })

  it.each([0, 0.01, 0.02, 0.021, 0.7])('judges the peak input level on Stop and resets it for the next test (%s)', async peak => {
    let publishLevel!: (level: number) => void
    const stop = vi.fn(async () => undefined)
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({
      start: vi.fn(async onLevel => { publishLevel = onLevel; return 'ready' as const }), stop,
    }) })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByRole('button', { name: 'Stop test' })
    act(() => { publishLevel(peak); publishLevel(0) })
    await userEvent.click(screen.getByRole('button', { name: 'Stop test' }))
    expect(screen.getByText(peak > 0.02 ? 'Sotto heard you. The microphone is closed.' : 'Sotto did not hear anything. Check that the microphone is not muted.')).toBeVisible()
    expect(stop).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Test again' }))
    await screen.findByRole('button', { name: 'Stop test' })
    await userEvent.click(screen.getByRole('button', { name: 'Stop test' }))
    expect(screen.getByText('Sotto did not hear anything. Check that the microphone is not muted.')).toBeVisible()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('closes a listening microphone with the keyboard Stop test control', async () => {
    const user = userEvent.setup()
    const stop = vi.fn(async () => undefined)
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({
      start: vi.fn(async onLevel => { onLevel(0.3); return 'ready' as const }), stop,
    }) })} />)
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    const button = await screen.findByRole('button', { name: 'Stop test' })
    expect(screen.getByText('Listening. Say something.')).toBeVisible()
    button.focus()
    await user.keyboard('{Enter}')
    expect(stop).toHaveBeenCalledOnce()
    expect(await screen.findByText('Sotto heard you. The microphone is closed.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Test again' })).toBeEnabled()
  })

  it.each(['ready', 'requesting'] as const)('stops a %s microphone when the window becomes hidden', async state => {
    const outcome = deferred<'ready'>()
    const stop = vi.fn(async () => undefined)
    const props = baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneSkipped: true },
      createMicrophoneTest: () => ({ start: vi.fn(() => state === 'ready' ? Promise.resolve('ready' as const) : outcome.promise), stop }) })
    render(<SettingsView {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    if (state === 'ready') await screen.findByRole('button', { name: 'Stop test' })
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    expect(stop).toHaveBeenCalledOnce()
    await act(async () => { outcome.resolve('ready') })
    expect(screen.queryByRole('button', { name: 'Stop test' })).not.toBeInTheDocument()
    if (state === 'requesting') expect(props.onUpdateSettings).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('stops the microphone when its Settings category is left', async () => {
    const stop = vi.fn(async () => undefined)
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({ start: vi.fn(async () => 'ready' as const), stop }) })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await selectCategory('Output')
    expect(stop).toHaveBeenCalledOnce()
    await selectCategory('Dictation')
    expect(screen.getByRole('button', { name: 'Test again' })).toBeEnabled()
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

  it('runs the Settings microphone test on the selected input', async () => {
    const user = userEvent.setup()
    const start = vi.fn(async () => 'ready' as const)
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneId: 'mic-c922' },
      createMicrophoneTest: () => ({ start, stop: vi.fn(async () => undefined) }),
    })} />)

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.any(Function), 'mic-c922', expect.any(Function)))
  })

  it('tests the microphone just chosen before that choice is saved', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const start = vi.fn(async () => 'ready' as const)
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneId: 'mic-builtin' },
      mediaDevices: createMediaDevices([device('mic-builtin', 'MacBook Pro Microphone'), device('mic-c922', 'C922 Pro Stream Webcam')]),
      onUpdateSettings: () => pending.promise,
      createMicrophoneTest: () => ({ start, stop: vi.fn(async () => undefined) }),
    })} />)

    expect(await screen.findByRole('option', { name: 'C922 Pro Stream Webcam' })).toBeVisible()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Microphone' }), 'mic-c922')
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.any(Function), 'mic-c922', expect.any(Function)))
    pending.resolve(true)
  })

  it('goes back to the saved microphone when a new choice cannot be saved', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneId: 'mic-builtin' },
      mediaDevices: createMediaDevices([device('mic-builtin', 'MacBook Pro Microphone'), device('mic-c922', 'C922 Pro Stream Webcam')]),
      onUpdateSettings: vi.fn(async () => false),
    })} />)

    expect(await screen.findByRole('option', { name: 'C922 Pro Stream Webcam' })).toBeVisible()
    const picker = screen.getByRole('combobox', { name: 'Microphone' })
    await user.selectOptions(picker, 'mic-c922')

    expect(await screen.findByText('That setting could not be saved. Your previous setting is still active.')).toBeVisible()
    expect(picker).toHaveValue('mic-builtin')
  })

  it('keeps the test wave still while access is still being asked for', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      createMicrophoneTest: () => ({ start: () => deferred<never>().promise, stop: vi.fn(async () => undefined) }),
    })} />)

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    await waitFor(() => expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', 'requesting'))
    expect(screen.getByTestId('listening-bars')).not.toHaveAttribute('data-speaking')
  })

  it('tells a Mac user where to turn the microphone back on when the test is blocked', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      platform: 'darwin',
      createMicrophoneTest: () => ({ start: vi.fn(async () => 'denied' as const), stop: vi.fn(async () => undefined) }),
    })} />)

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    expect(await screen.findByText(platformCopy('darwin').settingsMicrophoneDenied)).toBeVisible()
  })

  it.each(['darwin', 'win32'] as const)('offers System Settings for a blocked microphone only on macOS (%s)', async platform => {
    const user = userEvent.setup()
    const openSystemSettings = vi.fn(async () => ({ ok: true as const }))
    window.sotto = { openSystemSettings } as never
    try {
      render(<SettingsView {...baseProps({
        platform,
        createMicrophoneTest: () => ({ start: vi.fn(async () => 'denied' as const), stop: vi.fn(async () => undefined) }),
      })} />)
      await user.click(screen.getByRole('button', { name: 'Test microphone' }))
      await screen.findByText(platformCopy(platform).settingsMicrophoneDenied)

      const open = screen.queryByRole('button', { name: 'Open System Settings at Privacy & Security, Microphone' })
      if (platform === 'win32') {
        expect(open).toBeNull()
        return
      }
      await user.click(open!)
      expect(openSystemSettings).toHaveBeenCalledExactlyOnceWith('microphone')
    } finally {
      delete window.sotto
    }
  })

  it('clears a skipped microphone once the Settings test reports ready', async () => {
    const user = userEvent.setup()
    const onUpdateSettings = vi.fn(async () => true)
    const start = vi.fn(async (onLevel: (level: number) => void) => { onLevel(0.5); return 'ready' as const })
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneSkipped: true },
      onUpdateSettings,
      createMicrophoneTest: () => ({ start, stop: vi.fn(async () => undefined) }),
    })} />)

    expect(screen.getByText(/no microphone is set up/i)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    expect(start).toHaveBeenCalledOnce()
    await waitFor(() => expect(onUpdateSettings).toHaveBeenCalledWith({ microphoneSkipped: false }))
    expect(await screen.findByText(/Listening\. Say something\./i)).toBeVisible()
  })

  it('tests the selected input and discards its late result after the selection changes', async () => {
    const outcome = deferred<'ready'>()
    const stop = vi.fn(async () => undefined)
    let publishLevel!: (level: number) => void
    const start = vi.fn((onLevel: (level: number) => void) => { publishLevel = onLevel; return outcome.promise })
    const props = baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneId: 'headset', microphoneSkipped: true },
      createMicrophoneTest: () => ({ start, stop }) })
    const rendered = render(<SettingsView {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(start).toHaveBeenCalledWith(expect.any(Function), 'headset', expect.any(Function))
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, microphoneId: 'desk' }} />)
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
    await act(async () => { publishLevel(0.8); outcome.resolve('ready') })
    expect(screen.queryByText(/Listening\. Say something\./i)).not.toBeInTheDocument()
    expect(props.onUpdateSettings).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Test microphone' })).toBeEnabled()
  })

  it('clears a ready meter when the selected input changes and tests the new input', async () => {
    const stop = vi.fn(async () => undefined)
    const start = vi.fn(async (onLevel: (level: number) => void) => { onLevel(0.7); return 'ready' as const })
    const props = baseProps({ createMicrophoneTest: () => ({ start, stop }) })
    const rendered = render(<SettingsView {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(await screen.findByText(/Listening\. Say something\./i)).toBeVisible()
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, microphoneId: 'desk' }} />)
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
    expect(screen.queryByText(/Listening\. Say something\./i)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(start).toHaveBeenLastCalledWith(expect.any(Function), 'desk', expect.any(Function))
    rendered.unmount()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])('explains a missing selected input with other inputs available: %s', async others => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneId: 'unplugged' },
      mediaDevices: createMediaDevices(others ? [device('desk', 'Desk microphone')] : []),
      createMicrophoneTest: () => ({ start: vi.fn(async () => 'missing' as const), stop: vi.fn(async () => undefined) }),
    })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(await screen.findByText(others ? 'The chosen microphone is not connected. Plug it in or choose another.' : 'No microphone was found.')).toBeVisible()
  })

  it('does not call the chosen microphone disconnected while it is still listed', async () => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneId: 'desk' },
      mediaDevices: createMediaDevices([device('desk', 'Desk microphone')]),
      createMicrophoneTest: () => ({ start: vi.fn(async () => 'missing' as const), stop: vi.fn(async () => undefined) }),
    })} />)
    await screen.findByRole('option', { name: 'Desk microphone' })
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(await screen.findByText('No microphone was found.')).toBeVisible()
    expect(screen.queryByText('The chosen microphone is not connected. Plug it in or choose another.')).not.toBeInTheDocument()
  })

  it('keeps the skip when the Settings test cannot reach a microphone', async () => {
    const user = userEvent.setup()
    const onUpdateSettings = vi.fn(async () => true)
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneSkipped: true },
      onUpdateSettings,
      createMicrophoneTest: () => ({ start: vi.fn(async () => 'missing' as const), stop: vi.fn(async () => undefined) }),
    })} />)

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    expect(await screen.findByText(/no microphone was found/i)).toBeVisible()
    expect(onUpdateSettings).not.toHaveBeenCalled()
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
})
