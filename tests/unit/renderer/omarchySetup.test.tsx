import React from 'react'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmarchySetupPanel, useOmarchySetup } from '../../../src/renderer/src/features/omarchy/OmarchySetup'
import { Onboarding, type OnboardingProps } from '../../../src/renderer/src/features/onboarding/Onboarding'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { setupBridgeFixture, setupState } from '../../fixtures/renderer/omarchySetup'
import { SettingsView } from '../../../src/renderer/src/features/settings/SettingsView'
import { baseProps } from '../../fixtures/renderer/settingsViewHarness'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('Omarchy setup rows', () => {
  it('recovers from progress followed by a rejected command through Try again', async () => {
    const f = setupBridgeFixture(), get = vi.spyOn(f.bridge, 'get')
    const hook = renderHook(() => useOmarchySetup(true, f.bridge))
    await waitFor(() => expect(hook.result.current.state).not.toBeNull())
    vi.spyOn(f.bridge, 'command').mockImplementationOnce(async () => {
      const progress = setupState(); progress.busy = true; progress.operation = 'setup'
      f.change(progress)
      throw new Error('The command reply failed')
    })
    await act(async () => hook.result.current.command({ type: 'setup', pieces: ['keys'], keys: 'give' }))
    expect(hook.result.current.error).toBe(true)
    get.mockResolvedValueOnce(setupState())
    await act(async () => hook.result.current.retryRead())
    expect(get).toHaveBeenCalledTimes(2)
    expect(hook.result.current.busy).toBe(false)
    await act(async () => hook.result.current.command({ type: 'setup', pieces: ['keys'], keys: 'give' }))
    expect(hook.result.current.state?.pieces.keys.status).toBe('done')
  })
  it('retries an inspection failure by reading without reinstalling a removed piece', async () => {
    const initial = setupState('done')
    initial.pieces.theme = { status: 'failed', owned: false, message: 'The files could not be checked', retry: 'inspect' }
    const f = setupBridgeFixture(initial), get = vi.spyOn(f.bridge, 'get')
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await screen.findByRole('button', { name: 'Try the theme again' })
    const next = setupState('done'); next.pieces.theme = setupState().pieces.theme
    get.mockResolvedValueOnce(next)
    await userEvent.click(screen.getByRole('button', { name: 'Try the theme again' }))
    const nextAction = await screen.findByRole('button', { name: 'Set up the theme' })
    await waitFor(() => expect(nextAction).toHaveFocus())
    expect(get).toHaveBeenCalledTimes(2)
    expect(f.calls).toEqual([])
  })
  it('coalesces native and DOM focus and ignores native focus while hidden or operating', async () => {
    const f = setupBridgeFixture(), get = vi.spyOn(f.bridge, 'get')
    const hook = renderHook(({ enabled }) => useOmarchySetup(enabled, f.bridge), { initialProps: { enabled: true } })
    await waitFor(() => expect(hook.result.current.state).not.toBeNull())
    const reading = Promise.withResolvers<ReturnType<typeof setupState>>()
    get.mockReturnValueOnce(reading.promise)
    act(() => f.focus())
    expect(get).toHaveBeenCalledTimes(2)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(get).toHaveBeenCalledTimes(2)
    await act(async () => reading.resolve(setupState('manual')))
    expect(hook.result.current.state?.pieces.keys.status).toBe('manual')
    const progress = setupState(); progress.busy = true
    act(() => f.change(progress)); act(() => f.focus())
    expect(get).toHaveBeenCalledTimes(2)
    hook.rerender({ enabled: false }); act(() => f.focus())
    expect(get).toHaveBeenCalledTimes(2)
  })
  it('re-detects outside changes when the actual Settings tabs return to Dictation', async () => {
    const f = setupBridgeFixture(setupState('manual')), user = userEvent.setup()
    const get = vi.spyOn(f.bridge, 'get')
    vi.stubGlobal('sotto', { omarchySetup: f.bridge })
    render(<SettingsView {...baseProps({ platform: 'linux' })} />)
    await user.click(screen.getByRole('tab', { name: 'Dictation' }))
    await screen.findAllByText('Set up by hand')
    const reads = get.mock.calls.length
    await user.click(screen.getByRole('tab', { name: 'Application' }))
    get.mockResolvedValue(setupState())
    await user.click(screen.getByRole('tab', { name: 'Dictation' }))
    await screen.findByRole('button', { name: 'Set up all three' })
    expect(get.mock.calls.length).toBeGreaterThan(reads)
  })
  it('refreshes external changes on focus without clearing the visible rows, and ignores a read overtaken by progress', async () => {
    const f = setupBridgeFixture(setupState('manual'))
    const get = vi.spyOn(f.bridge, 'get')
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await screen.findAllByText('Set up by hand')
    const read = Promise.withResolvers<ReturnType<typeof setupState>>()
    get.mockReturnValueOnce(read.promise)
    act(() => window.dispatchEvent(new Event('focus')))
    act(() => window.dispatchEvent(new Event('focus')))
    expect(get).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText('Set up by hand')).toHaveLength(3)
    expect(screen.queryByText('Checking')).toBeNull()
    const working = setupState('done'); working.busy = true; working.operation = 'remove'
    working.pieces.owl = { status: 'working', owned: true, message: 'Removing' }
    act(() => f.change(working))
    await act(async () => read.resolve(setupState()))
    expect(screen.getAllByText('Removing').length).toBeGreaterThan(0)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(get).toHaveBeenCalledTimes(2)
    act(() => f.change(setupState()))
    act(() => window.dispatchEvent(new Event('focus')))
    await screen.findByRole('button', { name: 'Set up all three' })
    expect(get).toHaveBeenCalledTimes(3)
  })
  it('reads again when the block is shown and keeps its last state while hidden', async () => {
    const f = setupBridgeFixture(setupState('manual'))
    const get = vi.spyOn(f.bridge, 'get')
    const hook = renderHook(({ enabled }) => useOmarchySetup(enabled, f.bridge), { initialProps: { enabled: true } })
    await waitFor(() => expect(hook.result.current.state?.pieces.keys.status).toBe('manual'))
    hook.rerender({ enabled: false })
    act(() => window.dispatchEvent(new Event('focus')))
    expect(get).toHaveBeenCalledTimes(1)
    f.change(setupState())
    expect(hook.result.current.state?.pieces.keys.status).toBe('manual')
    hook.rerender({ enabled: true })
    await waitFor(() => expect(hook.result.current.state?.pieces.keys.status).toBe('missing'))
    expect(get).toHaveBeenCalledTimes(2)
  })
  it('recovers progress completed while the block was hidden and drops a focus read overtaken by a command', async () => {
    const f = setupBridgeFixture(setupState('done'))
    const get = vi.spyOn(f.bridge, 'get')
    const hook = renderHook(({ enabled }) => useOmarchySetup(enabled, f.bridge), { initialProps: { enabled: true } })
    await waitFor(() => expect(hook.result.current.state?.pieces.keys.status).toBe('done'))
    const working = setupState('done'); working.busy = true
    act(() => f.change(working))
    hook.rerender({ enabled: false }); f.change(setupState('done')); hook.rerender({ enabled: true })
    await waitFor(() => expect(hook.result.current.busy).toBe(false))
    const reading = Promise.withResolvers<ReturnType<typeof setupState>>()
    get.mockReturnValueOnce(reading.promise)
    act(() => window.dispatchEvent(new Event('focus')))
    await act(async () => hook.result.current.command({ type: 'remove', pieces: ['keys'] }))
    await act(async () => reading.resolve(setupState('done')))
    expect(hook.result.current.state?.pieces.keys.status).toBe('missing')
  })
  it('labels the action Removing throughout removal, including before progress arrives', async () => {
    const f = setupBridgeFixture(setupState('done'))
    const removed = Promise.withResolvers<ReturnType<typeof setupState>>()
    vi.spyOn(f.bridge, 'command').mockReturnValueOnce(removed.promise)
    const get = vi.spyOn(f.bridge, 'get')
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove all' }))
    expect(screen.getByRole('button', { name: 'Removing' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Setting up' })).toBeNull()
    act(() => window.dispatchEvent(new Event('focus')))
    expect(get).toHaveBeenCalledTimes(1)
    await act(async () => removed.resolve(setupState()))
    await screen.findByRole('button', { name: 'Set up all three' })
  })
  it('uses the operation for both removal labels even when the progress message changes', async () => {
    const f = setupBridgeFixture()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await screen.findByRole('button', { name: 'Set up all three' })
    const working = { ...setupState('done'), busy: true, operation: 'remove' as const }
    working.pieces.keys = { status: 'working', owned: true, message: 'Taking the keys out' }
    act(() => f.change(working))
    expect(screen.getByRole('button', { name: 'Removing' })).toBeDisabled()
    expect(screen.getAllByText('Removing')).toHaveLength(2)
    expect(screen.queryByText('Setting up')).toBeNull()
  })
  it('shows exactly what is left and removes only owned pieces', async () => {
    const initial = setupState('done')
    initial.pieces.keys = { status: 'manual', owned: false, message: 'Set up by hand.' }
    initial.pieces.owl = { status: 'missing', owned: false, message: '' }
    const f = setupBridgeFixture(initial), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    expect(await screen.findByRole('button', { name: 'Set up the owl' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Remove the keys' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Remove all' }))
    expect(f.calls).toEqual([{ type: 'remove', pieces: ['theme'] }])
  })
  it('keeps the default conflict answer selected and supports arrow keys to keep the keys', async () => {
    const initial = setupState()
    initial.pieces.keys.status = 'conflict'
    initial.keyConflicts = ['F9 runs “Toggle screen recording”.']
    const f = setupBridgeFixture(initial), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    const give = await screen.findByRole('radio', { name: 'Give F9 to Sotto' })
    expect(give).toBeChecked()
    give.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Leave my keys alone' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Set up all three' }))
    expect(f.calls).toEqual([{ type: 'setup', pieces: ['keys', 'owl', 'theme'], keys: 'keep' }])
  })
  it('asks before updating an owl and Escape cancels without a command', async () => {
    const initial = setupState('done'); initial.pieces.owl.status = 'stale'
    initial.pieces.owl.message = 'Updating restarts the bar for a moment.'
    const f = setupBridgeFixture(initial), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await user.click(await screen.findByRole('button', { name: 'Update the owl' }))
    expect(screen.getByRole('dialog', { name: 'Update the owl?' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.calls).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Update the owl' }))
    await user.click(screen.getByRole('dialog').querySelector('button:last-child')!)
    expect(f.calls).toEqual([{ type: 'update-owl' }])
  })
  it('offers a key choice when an owned update meets a new conflict', async () => {
    const initial = setupState('done'); initial.pieces.keys.status = 'stale'
    initial.keyConflicts = ['F9 runs “Record the screen”.']
    const f = setupBridgeFixture(initial), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    expect(await screen.findByRole('radio', { name: 'Give F9 to Sotto' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Set up the keys' }))
    expect(f.calls).toEqual([{ type: 'setup', pieces: ['keys'], keys: 'give' }])
  })
  it('collapses its file disclosure with Escape and returns focus', async () => {
    const f = setupBridgeFixture(), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await user.click(screen.getByRole('button', { name: 'Show the files it changes' }))
    expect(screen.getByRole('button', { name: 'Hide the files it changes' })).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Show the files it changes' })).toHaveFocus()
  })
  it('keeps removal available for owned keys left alone after a new conflict', async () => {
    const initial = setupState(); initial.pieces.keys = { status: 'skipped', owned: true, message: 'Left alone.' }
    initial.keyConflicts = ['F9 runs “Record the screen”.']
    const f = setupBridgeFixture(initial), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await user.click(await screen.findByRole('button', { name: 'Remove the keys' }))
    expect(f.calls).toEqual([{ type: 'remove', pieces: ['keys'] }])
  })
  it('retries an interrupted removal as removal, with any current key conflict visible', async () => {
    const initial = setupState('done')
    initial.pieces.keys = { status: 'failed', owned: true, message: 'Removal stopped before it finished.', retry: 'remove' }
    initial.keyConflicts = ['F9 runs “Record the screen”.']
    const f = setupBridgeFixture(initial), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    expect(await screen.findByText('F9 runs “Record the screen”.')).toBeVisible()
    expect(screen.queryByRole('radio', { name: 'Give F9 to Sotto' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try the keys again' }))
    expect(f.calls).toEqual([{ type: 'remove', pieces: ['keys'] }])
  })
  it('reports working and failed rows, offers a retry and gives focus somewhere to continue', async () => {
    const f = setupBridgeFixture(), user = userEvent.setup()
    render(<OmarchySetupPanel bridge={f.bridge} />)
    await screen.findByRole('button', { name: 'Set up all three' })
    const working = setupState(); working.busy = true; working.pieces.owl.status = 'working'
    act(() => f.change(working))
    expect(screen.getByRole('button', { name: 'Setting up' })).toBeDisabled()
    const partial = setupState('done'); partial.pieces.owl = { status: 'failed', owned: false, message: 'Shell down. Nothing was copied.' }
    act(() => f.change(partial))
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was copied')
    await user.click(screen.getByRole('button', { name: 'Try the owl again' }))
    expect(f.calls).toEqual([{ type: 'setup', pieces: ['owl'], keys: 'unconfirmed' }])
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
  })
})

const props: OnboardingProps = { settings: DEFAULT_SETTINGS, speechModels: [], speechModelChoice: null, speechModel: null, onChooseSpeechModel: vi.fn(), onRetrySpeechModel: vi.fn(),
  microphoneState: 'ready', shortcut: 'Ctrl+Shift+Space', platform: 'linux', onUpdateSettings: vi.fn(async () => true),
  onRequestMicrophone: vi.fn(), onComplete: vi.fn() }
describe('Linux first-run step', () => {
  it('re-detects a hand setup removed outside Sotto when Back and Get started reopen the step', async () => {
    const f = setupBridgeFixture(setupState('manual')), user = userEvent.setup()
    const get = vi.spyOn(f.bridge, 'get')
    vi.stubGlobal('sotto', { omarchySetup: f.bridge })
    render(<Onboarding {...props} />)
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await screen.findAllByText('Set up by hand')
    const reads = get.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Back' }))
    get.mockResolvedValue(setupState())
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await screen.findByRole('button', { name: 'Set up all three' })
    expect(get.mock.calls.length).toBeGreaterThan(reads)
  })
  it('sits after Welcome, can be skipped, and changes Shortcut once the keys are ready', async () => {
    const f = setupBridgeFixture(), user = userEvent.setup()
    vi.stubGlobal('sotto', { omarchySetup: f.bridge })
    render(<Onboarding {...props} />)
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    expect(screen.getByRole('heading', { name: 'Set up Sotto in Omarchy' })).toHaveFocus()
    expect(screen.getByLabelText('Setup progress: step 2 of 10')).toBeVisible()
    await user.click(await screen.findByRole('button', { name: 'Set up all three' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { name: 'Choose how Sotto looks' })).toBeVisible()
    for (let n = 0; n < 3; n++) await user.click(screen.getByRole('button', { name: /^(Continue|Skip for now)$/ }))
    expect(screen.getByRole('heading', { name: 'Hold F9 to try it' })).toBeVisible()
  })
  it.each(['win32', 'darwin'] as const)('keeps the nine-step %s journey with Look after Welcome', async platform => {
    const get = vi.fn()
    vi.stubGlobal('sotto', { omarchySetup: { get } })
    const user = userEvent.setup()
    render(<Onboarding {...props} platform={platform} />)
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    expect(screen.getByRole('heading', { name: 'Choose how Sotto looks' })).toBeVisible()
    expect(screen.getByLabelText('Setup progress: step 2 of 9')).toBeVisible()
    expect(get).not.toHaveBeenCalled()
  })
})
